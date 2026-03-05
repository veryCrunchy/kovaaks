namespace kmod_replay {

struct ReplayRawVec3 {
    float x{0.0f};
    float y{0.0f};
    float z{0.0f};
};

struct ReplayRawRotator {
    float pitch{0.0f};
    float yaw{0.0f};
    float roll{0.0f};
};

static auto replay_normalize_ascii(const RC::StringType& input) -> std::string {
    std::string out;
    out.reserve(input.size());
    for (auto c : input) {
        const auto ch = static_cast<unsigned int>(c);
        if (ch > 0x7F) {
            continue;
        }
        out.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
    }
    return out;
}

static auto replay_object_path_from_full_name(const RC::StringType& full_name) -> RC::StringType {
    const auto split = full_name.find(STR(" "));
    if (split == RC::StringType::npos) {
        return full_name;
    }
    if (split + 1 >= full_name.size()) {
        return RC::StringType{};
    }
    return full_name.substr(split + 1);
}

static auto replay_is_rejected_runtime_object_name(const RC::StringType& full_name) -> bool {
    if (full_name.empty()) {
        return true;
    }
    return full_name.find(STR("Default__")) != RC::StringType::npos
        || full_name.find(STR("/Script/")) != RC::StringType::npos
        || full_name.find(STR("Class ")) != RC::StringType::npos
        || full_name.find(STR("Function ")) != RC::StringType::npos;
}

static auto replay_enumerate_properties(RC::Unreal::UStruct* owner) -> std::vector<RC::Unreal::FProperty*> {
    std::vector<RC::Unreal::FProperty*> out{};
    if (!owner || !is_likely_valid_object_ptr(owner)) {
        return out;
    }
    std::unordered_set<RC::Unreal::FProperty*> seen{};
    auto* property = owner->GetPropertyLink();
    while (property && is_likely_valid_object_ptr(property)) {
        if (!seen.insert(property).second) {
            break;
        }
        out.emplace_back(property);
        auto* next = property->GetPropertyLinkNext();
        if (next == property) {
            break;
        }
        property = next;
    }
    return out;
}

static auto replay_enumerate_properties_in_chain(RC::Unreal::UStruct* owner) -> std::vector<RC::Unreal::FProperty*> {
    std::vector<RC::Unreal::FProperty*> out{};
    if (!owner || !is_likely_valid_object_ptr(owner)) {
        return out;
    }

    std::unordered_set<RC::Unreal::UStruct*> seen_structs{};
    std::unordered_set<RC::Unreal::FProperty*> seen_props{};
    for (auto* current = owner; current && is_likely_valid_object_ptr(current); current = current->GetSuperStruct()) {
        if (!seen_structs.insert(current).second) {
            break;
        }
        for (auto* property : replay_enumerate_properties(current)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (seen_props.insert(property).second) {
                out.emplace_back(property);
            }
        }
    }
    return out;
}

static auto replay_read_fstring(void* value_ptr, std::string& out_utf8) -> bool {
    out_utf8.clear();
    if (!value_ptr) {
        return false;
    }

    struct RawFStringData {
        const RC::Unreal::TCHAR* data;
        int32_t count;
        int32_t capacity;
    };

    const auto* raw = reinterpret_cast<const RawFStringData*>(value_ptr);
    if (!raw || !is_likely_readable_region(raw, sizeof(RawFStringData))) {
        return false;
    }
    if (!raw->data || raw->count <= 1 || raw->count > 4096) {
        return false;
    }
    if (!is_likely_readable_region(raw->data, static_cast<size_t>(raw->count) * sizeof(RC::Unreal::TCHAR))) {
        return false;
    }

    RC::StringType wide(raw->data, raw->data + static_cast<size_t>(raw->count - 1));
    if (wide.empty()) {
        return false;
    }
    out_utf8 = utf8_from_wide(wide);
    return !out_utf8.empty();
}

static auto replay_read_string_property(
    RC::Unreal::UObject* owner,
    const char* wanted_name,
    std::string& out_value
) -> bool {
    out_value.clear();
    if (!owner || !wanted_name || !*wanted_name) {
        return false;
    }
    auto* owner_class = owner->GetClassPrivate();
    if (!owner_class || !is_likely_valid_object_ptr(owner_class)) {
        return false;
    }

    for (auto* property : replay_enumerate_properties_in_chain(owner_class)) {
        if (!property || !is_likely_valid_object_ptr(property)) {
            continue;
        }
        if (replay_normalize_ascii(property->GetName()) != wanted_name) {
            continue;
        }

        auto* str_property = RC::Unreal::CastField<RC::Unreal::FStrProperty>(property);
        if (!str_property || !is_likely_valid_object_ptr(str_property)) {
            continue;
        }

        void* value_ptr = safe_property_value_ptr(str_property, owner);
        if (!value_ptr) {
            continue;
        }

        if (replay_read_fstring(value_ptr, out_value)) {
            return true;
        }
    }
    return false;
}

static auto replay_read_object_presence_property(
    RC::Unreal::UObject* owner,
    const char* wanted_name,
    bool& out_present
) -> bool {
    out_present = false;
    if (!owner || !wanted_name || !*wanted_name) {
        return false;
    }
    auto* owner_class = owner->GetClassPrivate();
    if (!owner_class || !is_likely_valid_object_ptr(owner_class)) {
        return false;
    }

    for (auto* property : replay_enumerate_properties_in_chain(owner_class)) {
        if (!property || !is_likely_valid_object_ptr(property)) {
            continue;
        }
        if (replay_normalize_ascii(property->GetName()) != wanted_name) {
            continue;
        }

        auto* object_property = RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property);
        if (!object_property || !is_likely_valid_object_ptr(object_property)) {
            continue;
        }

        void* value_ptr = safe_property_value_ptr(object_property, owner);
        if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(void*))) {
            continue;
        }

        auto* referenced = object_property->GetObjectPropertyValue(value_ptr);
        out_present = (referenced != nullptr && is_likely_valid_object_ptr(referenced));
        return true;
    }

    return false;
}

static auto replay_resolve_actor_fn(const wchar_t* path) -> RC::Unreal::UFunction* {
    auto* fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
        nullptr,
        nullptr,
        path
    );
    if (!fn || !is_likely_valid_object_ptr(fn)) {
        return nullptr;
    }
    return fn;
}

static auto replay_read_actor_transforms(
    RC::Unreal::UObject* actor,
    ReplayEntity& out_entity
) -> bool {
    if (!actor || !is_likely_valid_object_ptr(actor)) {
        return false;
    }

    static RC::Unreal::UFunction* fn_get_location = nullptr;
    static RC::Unreal::UFunction* fn_get_rotation = nullptr;
    static RC::Unreal::UFunction* fn_get_velocity = nullptr;

    if (!fn_get_location) {
        fn_get_location = replay_resolve_actor_fn(STR("/Script/Engine.Actor:K2_GetActorLocation"));
    }
    if (!fn_get_rotation) {
        fn_get_rotation = replay_resolve_actor_fn(STR("/Script/Engine.Actor:K2_GetActorRotation"));
    }
    if (!fn_get_velocity) {
        fn_get_velocity = replay_resolve_actor_fn(STR("/Script/Engine.Actor:GetVelocity"));
    }

    bool has_any = false;

    if (fn_get_location) {
        struct Params {
            ReplayRawVec3 ReturnValue{};
        } params{};
        actor->ProcessEvent(fn_get_location, &params);
        if (std::isfinite(params.ReturnValue.x)
            && std::isfinite(params.ReturnValue.y)
            && std::isfinite(params.ReturnValue.z)) {
            out_entity.location.x = params.ReturnValue.x;
            out_entity.location.y = params.ReturnValue.y;
            out_entity.location.z = params.ReturnValue.z;
            has_any = true;
        }
    }

    if (fn_get_rotation) {
        struct Params {
            ReplayRawRotator ReturnValue{};
        } params{};
        actor->ProcessEvent(fn_get_rotation, &params);
        if (std::isfinite(params.ReturnValue.pitch)
            && std::isfinite(params.ReturnValue.yaw)
            && std::isfinite(params.ReturnValue.roll)) {
            out_entity.rotation.pitch = params.ReturnValue.pitch;
            out_entity.rotation.yaw = params.ReturnValue.yaw;
            out_entity.rotation.roll = params.ReturnValue.roll;
            has_any = true;
        }
    }

    if (fn_get_velocity) {
        struct Params {
            ReplayRawVec3 ReturnValue{};
        } params{};
        actor->ProcessEvent(fn_get_velocity, &params);
        if (std::isfinite(params.ReturnValue.x)
            && std::isfinite(params.ReturnValue.y)
            && std::isfinite(params.ReturnValue.z)) {
            out_entity.velocity.x = params.ReturnValue.x;
            out_entity.velocity.y = params.ReturnValue.y;
            out_entity.velocity.z = params.ReturnValue.z;
            has_any = true;
        }
    }

    return has_any;
}

static auto replay_collect_map_context(ReplayContext& context) -> void {
    std::vector<RC::Unreal::UObject*> candidates{};
    RC::Unreal::UObjectGlobals::FindAllOf(STR("MetaGameState"), candidates);
    std::vector<RC::Unreal::UObject*> alt{};
    RC::Unreal::UObjectGlobals::FindAllOf(STR("KovGameState_C"), alt);
    for (auto* obj : alt) {
        if (obj) {
            candidates.emplace_back(obj);
        }
    }

    RC::Unreal::UObject* best = nullptr;
    int best_score = std::numeric_limits<int>::min();

    for (auto* obj : candidates) {
        if (!obj || !is_likely_valid_object_ptr(obj)) {
            continue;
        }
        const auto full_name = obj->GetFullName();
        if (replay_is_rejected_runtime_object_name(full_name)) {
            continue;
        }

        int score = 0;
        if (full_name.find(STR("/Engine/Transient.")) != RC::StringType::npos) score += 80;
        if (full_name.find(STR("KovGameState_C_")) != RC::StringType::npos) score += 120;
        if (full_name.find(STR("Default__")) != RC::StringType::npos) score -= 1000;
        if (full_name.find(STR("/Script/")) != RC::StringType::npos) score -= 200;

        if (!best || score > best_score) {
            best = obj;
            best_score = score;
        }
    }

    if (!best) {
        return;
    }

    std::string map_name{};
    if (replay_read_string_property(best, "currentmapname", map_name)) {
        context.map_name = map_name;
    }

    auto* owner_class = best->GetClassPrivate();
    if (!owner_class || !is_likely_valid_object_ptr(owner_class)) {
        return;
    }
    for (auto* property : replay_enumerate_properties_in_chain(owner_class)) {
        if (!property || !is_likely_valid_object_ptr(property)) {
            continue;
        }
        if (replay_normalize_ascii(property->GetName()) != "texturescale") {
            continue;
        }
        auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property);
        if (!numeric || !is_likely_valid_object_ptr(numeric)) {
            continue;
        }
        void* value_ptr = safe_property_value_ptr(numeric, best);
        if (!value_ptr) {
            continue;
        }
        float value = 0.0f;
        if (numeric->IsFloatingPoint()) {
            value = static_cast<float>(numeric->GetFloatingPointPropertyValue(value_ptr));
        } else if (numeric->IsInteger()) {
            value = static_cast<float>(numeric->GetSignedIntPropertyValue(value_ptr));
        } else {
            continue;
        }
        if (std::isfinite(value) && value >= 0.0f) {
            context.map_scale = value;
        }
        break;
    }
}

static auto replay_collect_entity_actor_refs(std::vector<ReplayEntityActorRef>& out_refs) -> void {
    out_refs.clear();

    std::vector<RC::Unreal::UObject*> candidates{};
    RC::Unreal::UObjectGlobals::FindAllOf(STR("MetaCharacter"), candidates);
    std::vector<RC::Unreal::UObject*> alt{};
    RC::Unreal::UObjectGlobals::FindAllOf(STR("FPSCharacter_C"), alt);
    for (auto* obj : alt) {
        if (obj) {
            candidates.emplace_back(obj);
        }
    }

    std::unordered_set<std::string> seen_ids{};

    for (auto* obj : candidates) {
        if (!obj || !is_likely_valid_object_ptr(obj)) {
            continue;
        }

        const auto full_name = obj->GetFullName();
        if (replay_is_rejected_runtime_object_name(full_name)) {
            continue;
        }

        const auto object_path = replay_object_path_from_full_name(full_name);
        const auto id = utf8_from_wide(object_path);
        if (id.empty()) {
            continue;
        }
        if (!seen_ids.insert(id).second) {
            continue;
        }

        ReplayEntity entity{};
        entity.id = id;

        std::string profile{};
        if (replay_read_string_property(obj, "characterprofilename", profile)) {
            entity.profile = profile;
        }

        bool has_player = false;
        bool has_ai = false;
        if (replay_read_object_presence_property(obj, "myplayercontroller", has_player) && has_player) {
            entity.is_player = true;
        }
        if (replay_read_object_presence_property(obj, "myaicontroller", has_ai) && has_ai) {
            entity.is_bot = true;
        }

        (void)replay_read_actor_transforms(obj, entity);

        ReplayEntityActorRef ref{};
        ref.entity = std::move(entity);
        ref.actor = obj;
        out_refs.emplace_back(std::move(ref));
    }
}

static auto replay_collect_entities(std::vector<ReplayEntity>& out_entities) -> void {
    out_entities.clear();

    std::vector<ReplayEntityActorRef> refs{};
    replay_collect_entity_actor_refs(refs);
    out_entities.reserve(refs.size());
    for (auto& ref : refs) {
        out_entities.emplace_back(std::move(ref.entity));
    }
}

} // namespace kmod_replay
