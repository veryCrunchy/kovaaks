namespace kmod_replay {

struct ReplayInGameBinding {
    RC::Unreal::UObject* actor{nullptr};
    std::string actor_id{};
    uint64_t last_resolve_ms{0};
};

struct ReplayInGameState {
    bool active{false};
    std::string session_id{};
    std::unordered_map<std::string, ReplayEntity> entities{};
    std::unordered_map<std::string, ReplayInGameBinding> bindings{};
    std::vector<ReplayEntityActorRef> runtime_refs{};
    uint64_t next_runtime_refresh_ms{0};
};

static auto replay_ingame_state() -> ReplayInGameState& {
    static ReplayInGameState state{};
    return state;
}

static auto replay_ingame_resolve_actor_fn(const wchar_t* path) -> RC::Unreal::UFunction* {
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

static auto replay_ingame_set_vec3_property(
    RC::Unreal::FProperty* property,
    void* container,
    const ReplayVec3& value
) -> bool {
    if (!property || !container) {
        return false;
    }
    void* value_ptr = safe_property_value_ptr(property, container);
    if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(float) * 3)) {
        return false;
    }
    auto* vec = reinterpret_cast<float*>(value_ptr);
    vec[0] = value.x;
    vec[1] = value.y;
    vec[2] = value.z;
    return true;
}

static auto replay_ingame_set_rotator_property(
    RC::Unreal::FProperty* property,
    void* container,
    const ReplayRotator& value
) -> bool {
    if (!property || !container) {
        return false;
    }
    void* value_ptr = safe_property_value_ptr(property, container);
    if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(float) * 3)) {
        return false;
    }
    auto* rot = reinterpret_cast<float*>(value_ptr);
    rot[0] = value.pitch;
    rot[1] = value.yaw;
    rot[2] = value.roll;
    return true;
}

static auto replay_ingame_invoke_set_actor_location(
    RC::Unreal::UObject* actor,
    const ReplayVec3& location
) -> bool {
    if (!actor || !is_likely_valid_object_ptr(actor)) {
        return false;
    }

    static RC::Unreal::UFunction* fn_set_location = nullptr;
    if (!fn_set_location || !is_likely_valid_object_ptr(fn_set_location)) {
        fn_set_location = replay_ingame_resolve_actor_fn(STR("/Script/Engine.Actor:K2_SetActorLocation"));
    }
    if (!fn_set_location) {
        return false;
    }

    const int32_t param_size = static_cast<int32_t>(fn_set_location->GetParmsSize());
    if (param_size <= 0 || param_size > 4096) {
        return false;
    }

    std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
    bool wrote_location = false;

    for (auto* property : replay_enumerate_properties_in_chain(fn_set_location)) {
        if (!property || !is_likely_valid_object_ptr(property)) {
            continue;
        }
        const auto name = replay_normalize_ascii(property->GetName());

        if (name == "newlocation") {
            wrote_location = replay_ingame_set_vec3_property(property, params.data(), location) || wrote_location;
            continue;
        }

        if (name == "bsweep") {
            auto* bool_property = RC::Unreal::CastField<RC::Unreal::FBoolProperty>(property);
            if (!bool_property || !is_likely_valid_object_ptr(bool_property)) {
                continue;
            }
            void* value_ptr = safe_property_value_ptr(bool_property, params.data());
            if (!value_ptr) {
                continue;
            }
            bool_property->SetPropertyValue(value_ptr, false);
            continue;
        }

        if (name == "bteleport") {
            auto* bool_property = RC::Unreal::CastField<RC::Unreal::FBoolProperty>(property);
            if (!bool_property || !is_likely_valid_object_ptr(bool_property)) {
                continue;
            }
            void* value_ptr = safe_property_value_ptr(bool_property, params.data());
            if (!value_ptr) {
                continue;
            }
            bool_property->SetPropertyValue(value_ptr, true);
            continue;
        }
    }

    if (!wrote_location) {
        return false;
    }

    actor->ProcessEvent(fn_set_location, params.data());
    return true;
}

static auto replay_ingame_invoke_set_actor_rotation(
    RC::Unreal::UObject* actor,
    const ReplayRotator& rotation
) -> bool {
    if (!actor || !is_likely_valid_object_ptr(actor)) {
        return false;
    }

    static RC::Unreal::UFunction* fn_set_rotation = nullptr;
    if (!fn_set_rotation || !is_likely_valid_object_ptr(fn_set_rotation)) {
        fn_set_rotation = replay_ingame_resolve_actor_fn(STR("/Script/Engine.Actor:K2_SetActorRotation"));
    }
    if (!fn_set_rotation) {
        return false;
    }

    const int32_t param_size = static_cast<int32_t>(fn_set_rotation->GetParmsSize());
    if (param_size <= 0 || param_size > 4096) {
        return false;
    }

    std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
    bool wrote_rotation = false;

    for (auto* property : replay_enumerate_properties_in_chain(fn_set_rotation)) {
        if (!property || !is_likely_valid_object_ptr(property)) {
            continue;
        }
        const auto name = replay_normalize_ascii(property->GetName());

        if (name == "newrotation") {
            wrote_rotation = replay_ingame_set_rotator_property(property, params.data(), rotation) || wrote_rotation;
            continue;
        }

        if (name == "bteleportphysics") {
            auto* bool_property = RC::Unreal::CastField<RC::Unreal::FBoolProperty>(property);
            if (!bool_property || !is_likely_valid_object_ptr(bool_property)) {
                continue;
            }
            void* value_ptr = safe_property_value_ptr(bool_property, params.data());
            if (!value_ptr) {
                continue;
            }
            bool_property->SetPropertyValue(value_ptr, true);
            continue;
        }
    }

    if (!wrote_rotation) {
        return false;
    }

    actor->ProcessEvent(fn_set_rotation, params.data());
    return true;
}

static auto replay_ingame_refresh_runtime_refs(ReplayInGameState& state, uint64_t now_ms) -> void {
    replay_collect_entity_actor_refs(state.runtime_refs);
    state.next_runtime_refresh_ms = now_ms + 250;
}

static auto replay_ingame_find_binding_actor(
    ReplayInGameState& state,
    const ReplayEntity& entity,
    uint64_t now_ms
) -> RC::Unreal::UObject* {
    if (entity.id.empty()) {
        return nullptr;
    }

    auto& binding = state.bindings[entity.id];
    if (binding.actor && is_likely_valid_object_ptr(binding.actor)) {
        return binding.actor;
    }

    auto select_ref = [&](auto&& predicate) -> ReplayEntityActorRef* {
        for (auto& ref : state.runtime_refs) {
            if (!ref.actor || !is_likely_valid_object_ptr(ref.actor)) {
                continue;
            }
            if (predicate(ref)) {
                return &ref;
            }
        }
        return nullptr;
    };

    ReplayEntityActorRef* selected = nullptr;

    selected = select_ref([&](const ReplayEntityActorRef& ref) {
        return ref.entity.id == entity.id;
    });
    if (!selected && entity.is_player) {
        selected = select_ref([&](const ReplayEntityActorRef& ref) {
            return ref.entity.is_player;
        });
    }
    if (!selected && !entity.profile.empty()) {
        selected = select_ref([&](const ReplayEntityActorRef& ref) {
            return ref.entity.profile == entity.profile && ref.entity.is_bot == entity.is_bot;
        });
    }
    if (!selected && entity.is_bot) {
        selected = select_ref([&](const ReplayEntityActorRef& ref) {
            return ref.entity.is_bot;
        });
    }
    if (!selected) {
        selected = select_ref([&](const ReplayEntityActorRef&) {
            return true;
        });
    }

    if (!selected) {
        binding.actor = nullptr;
        binding.actor_id.clear();
        binding.last_resolve_ms = now_ms;
        return nullptr;
    }

    binding.actor = selected->actor;
    binding.actor_id = selected->entity.id;
    binding.last_resolve_ms = now_ms;
    return binding.actor;
}

static auto replay_ingame_playback_is_active() -> bool {
    return replay_ingame_state().active;
}

static auto replay_ingame_playback_handle_command(const BridgeCommand& command, uint64_t now_ms) -> void {
    auto& state = replay_ingame_state();

    switch (command.kind) {
    case BridgeCommandKind::ReplayPlayStart:
        state.active = true;
        state.session_id = command.session_id;
        state.entities.clear();
        state.bindings.clear();
        state.runtime_refs.clear();
        state.next_runtime_refresh_ms = 0;
        break;
    case BridgeCommandKind::ReplayPlayStop:
        state.active = false;
        state.session_id.clear();
        state.entities.clear();
        state.bindings.clear();
        state.runtime_refs.clear();
        state.next_runtime_refresh_ms = 0;
        break;
    case BridgeCommandKind::ReplayEntityMeta: {
        if (command.entity.id.empty()) {
            break;
        }
        auto& entity = state.entities[command.entity.id];
        entity.id = command.entity.id;
        entity.profile = command.entity.profile;
        entity.is_player = command.entity.is_player;
        entity.is_bot = command.entity.is_bot;
        break;
    }
    case BridgeCommandKind::ReplayEntityPose: {
        if (command.entity.id.empty()) {
            break;
        }
        auto& entity = state.entities[command.entity.id];
        if (entity.id.empty()) {
            entity.id = command.entity.id;
        }
        entity.location = command.entity.location;
        entity.rotation = command.entity.rotation;
        entity.velocity = command.entity.velocity;
        break;
    }
    case BridgeCommandKind::ReplayRemoveEntity:
        if (!command.entity_id.empty()) {
            state.entities.erase(command.entity_id);
            state.bindings.erase(command.entity_id);
        }
        break;
    case BridgeCommandKind::Unknown:
    case BridgeCommandKind::StateSnapshotRequest:
    default:
        break;
    }

    if (state.active && (state.next_runtime_refresh_ms == 0 || now_ms >= state.next_runtime_refresh_ms)) {
        replay_ingame_refresh_runtime_refs(state, now_ms);
    }
}

static auto replay_ingame_playback_tick(uint64_t now_ms) -> void {
    auto& state = replay_ingame_state();
    if (!state.active) {
        return;
    }

    if (state.next_runtime_refresh_ms == 0 || now_ms >= state.next_runtime_refresh_ms) {
        replay_ingame_refresh_runtime_refs(state, now_ms);
    }

    for (const auto& [entity_id, entity] : state.entities) {
        (void)entity_id;
        auto* actor = replay_ingame_find_binding_actor(state, entity, now_ms);
        if (!actor) {
            continue;
        }
        (void)replay_ingame_invoke_set_actor_location(actor, entity.location);
        (void)replay_ingame_invoke_set_actor_rotation(actor, entity.rotation);
    }
}

} // namespace kmod_replay
