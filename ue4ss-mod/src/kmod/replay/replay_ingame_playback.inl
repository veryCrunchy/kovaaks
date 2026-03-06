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

    bool bootstrap_ready{false};
    bool ready_event_emitted{false};
    bool hide_ui{true};
    bool force_freeplay{true};
    bool input_lock_applied{false};
    bool freeplay_bootstrap_sent{false};
    bool freeplay_play_sent{false};
    bool world_reset_sent{false};
    bool map_load_sent{false};
    bool map_load_retry_sent{false};
    bool spawn_sent{false};
    std::string target_map_name{};
    std::string target_map_name_lower{};
    float target_map_scale{1.0f};
    uint64_t bootstrap_started_ms{0};
    uint64_t bootstrap_timeout_ms{12000};
    uint64_t freeplay_play_earliest_ms{0};
    uint64_t world_reset_sent_ms{0};
    uint64_t map_load_sent_ms{0};
    uint64_t next_ui_refresh_ms{0};

    bool debug_in_scenario{false};
    bool debug_in_challenge{false};
    bool debug_map_ready{false};
    bool debug_map_loading{false};
    bool debug_map_fully_loaded{false};
    bool debug_have_entities{false};
    bool debug_ready{false};
    bool debug_timed_out{false};
    uint64_t debug_last_update_ms{0};
    std::string debug_phase{"idle"};
    std::string debug_ready_reason{};
    std::string debug_last_command{};
    uint64_t debug_last_command_ms{0};
};

static auto replay_ingame_state() -> ReplayInGameState& {
    static ReplayInGameState state{};
    return state;
}

static auto replay_ingame_wide_from_utf8(const char* input) -> RC::StringType {
    if (!input || !*input) {
        return RC::StringType{};
    }

    int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, nullptr, 0);
    UINT code_page = CP_UTF8;
    DWORD flags = MB_ERR_INVALID_CHARS;
    if (required <= 0) {
        code_page = CP_ACP;
        flags = 0;
        required = MultiByteToWideChar(code_page, flags, input, -1, nullptr, 0);
        if (required <= 0) {
            return RC::StringType{};
        }
    }

    std::wstring wide(static_cast<size_t>(required), L'\0');
    const int written = MultiByteToWideChar(code_page, flags, input, -1, wide.data(), required);
    if (written <= 0) {
        return RC::StringType{};
    }
    if (!wide.empty() && wide.back() == L'\0') {
        wide.pop_back();
    }
    return RC::StringType(wide);
}

static auto replay_ingame_log(const char* message) -> void {
    runtime_log_line(message ? message : "[replay_playback] unknown");
}

static auto replay_ingame_debug_overlay_flag_enabled() -> bool {
    return env_flag_enabled("KOVAAKS_REPLAY_DEBUG_OVERLAY")
        || std::filesystem::exists(std::filesystem::path(game_bin_dir() + L"kovaaks_replay_debug_overlay.flag"));
}

static auto replay_ingame_aggressive_bootstrap_enabled() -> bool {
    return env_flag_enabled("KOVAAKS_REPLAY_AGGRESSIVE_BOOTSTRAP")
        || std::filesystem::exists(std::filesystem::path(game_bin_dir() + L"kovaaks_replay_aggressive_bootstrap.flag"));
}

static auto replay_ingame_update_debug_phase(ReplayInGameState& state, const char* phase, uint64_t now_ms) -> void {
    state.debug_phase = phase ? phase : "unknown";
    state.debug_last_update_ms = now_ms;
}

static auto replay_ingame_reset_debug(ReplayInGameState& state, uint64_t now_ms, const char* phase) -> void {
    state.debug_in_scenario = false;
    state.debug_in_challenge = false;
    state.debug_map_ready = false;
    state.debug_map_loading = false;
    state.debug_map_fully_loaded = false;
    state.debug_have_entities = false;
    state.debug_ready = false;
    state.debug_timed_out = false;
    state.debug_ready_reason.clear();
    replay_ingame_update_debug_phase(state, phase, now_ms);
}

static auto replay_ingame_short_label(const std::string& value, size_t max_len) -> std::string {
    if (value.size() <= max_len) {
        return value;
    }
    if (max_len <= 3) {
        return value.substr(0, max_len);
    }
    return value.substr(0, max_len - 3) + "...";
}

static auto replay_ingame_debug_overlay_enabled() -> bool {
    const auto& state = replay_ingame_state();
    return state.active || replay_ingame_debug_overlay_flag_enabled();
}

static auto replay_ingame_append_debug_overlay_text(RC::StringType& overlay_text) -> bool {
    const auto& state = replay_ingame_state();
    if (!state.active && !replay_ingame_debug_overlay_flag_enabled()) {
        return false;
    }

    size_t bound_count = 0;
    for (const auto& [entity_id, binding] : state.bindings) {
        (void)entity_id;
        if (binding.actor && is_likely_valid_object_ptr(binding.actor)) {
            ++bound_count;
        }
    }

    overlay_text += STR("\nReplay | ");
    overlay_text += state.active ? STR("ACTIVE") : STR("IDLE");
    overlay_text += STR(" | ");
    overlay_text += replay_ingame_aggressive_bootstrap_enabled() ? STR("AGGR") : STR("SAFE");
    if (!state.session_id.empty()) {
        overlay_text += STR(" | SID ");
        overlay_text += replay_ingame_wide_from_utf8(replay_ingame_short_label(state.session_id, 14).c_str());
    }
    if (!state.debug_phase.empty()) {
        overlay_text += STR(" | ");
        overlay_text += replay_ingame_wide_from_utf8(state.debug_phase.c_str());
    }

    overlay_text += STR("\nBootstrap | in_scn ");
    overlay_text += state.debug_in_scenario ? STR("1") : STR("0");
    overlay_text += STR(" | in_ch ");
    overlay_text += state.debug_in_challenge ? STR("1") : STR("0");
    overlay_text += STR(" | map ");
    overlay_text += state.debug_map_ready ? STR("1") : STR("0");
    overlay_text += STR(" | loading ");
    overlay_text += state.debug_map_loading ? STR("1") : STR("0");
    overlay_text += STR(" | full ");
    overlay_text += state.debug_map_fully_loaded ? STR("1") : STR("0");
    overlay_text += STR(" | refs ");
    overlay_text += std::to_wstring(static_cast<unsigned long long>(state.runtime_refs.size()));
    overlay_text += STR(" | ents ");
    overlay_text += std::to_wstring(static_cast<unsigned long long>(state.entities.size()));
    overlay_text += STR(" | bound ");
    overlay_text += std::to_wstring(static_cast<unsigned long long>(bound_count));

    overlay_text += STR("\nReady | ok ");
    overlay_text += state.debug_ready ? STR("1") : STR("0");
    overlay_text += STR(" | timeout ");
    overlay_text += state.debug_timed_out ? STR("1") : STR("0");
    if (!state.debug_ready_reason.empty()) {
        overlay_text += STR(" | ");
        overlay_text += replay_ingame_wide_from_utf8(state.debug_ready_reason.c_str());
    }

    if (!state.debug_last_command.empty()) {
        overlay_text += STR(" | cmd ");
        overlay_text += replay_ingame_wide_from_utf8(state.debug_last_command.c_str());
    }

    return true;
}

static auto replay_ingame_emit_ready_event(
    const ReplayInGameState& state,
    uint64_t now_ms,
    bool ok,
    const char* reason
) -> void {
    std::string msg{};
    msg.reserve(256);
    msg += "{\"ev\":\"replay_playback_ready\",\"ts_ms\":";
    replay_append_u64(msg, now_ms);
    msg += ",\"ok\":";
    msg += ok ? "1" : "0";
    msg += ",\"session_id\":\"";
    msg += replay_escape_json(state.session_id);
    msg += "\",\"reason\":\"";
    msg += replay_escape_json(reason ? reason : "unknown");
    msg += "\"}";
    kovaaks::RustBridge::emit_json(msg.c_str());
}

static auto replay_ingame_emit_interrupt_event(
    const ReplayInGameState& state,
    uint64_t now_ms,
    const char* reason
) -> void {
    std::string msg{};
    msg.reserve(256);
    msg += "{\"ev\":\"replay_playback_interrupted\",\"ts_ms\":";
    replay_append_u64(msg, now_ms);
    msg += ",\"session_id\":\"";
    msg += replay_escape_json(state.session_id);
    msg += "\",\"reason\":\"";
    msg += replay_escape_json(reason ? reason : "unknown");
    msg += "\"}";
    kovaaks::RustBridge::emit_json(msg.c_str());
}

static auto replay_ingame_resolve_fn(const wchar_t* path) -> RC::Unreal::UFunction* {
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

static auto replay_ingame_find_best_runtime_object(
    const wchar_t* primary_name,
    const wchar_t* secondary_name
) -> RC::Unreal::UObject* {
    std::vector<RC::Unreal::UObject*> candidates{};
    if (primary_name && *primary_name) {
        RC::Unreal::UObjectGlobals::FindAllOf(primary_name, candidates);
    }
    if (secondary_name && *secondary_name) {
        std::vector<RC::Unreal::UObject*> alt{};
        RC::Unreal::UObjectGlobals::FindAllOf(secondary_name, alt);
        for (auto* obj : alt) {
            if (obj) {
                candidates.emplace_back(obj);
            }
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
        if (full_name.find(STR("/Engine/Transient.")) != RC::StringType::npos) score += 100;
        if (full_name.find(STR("Default__")) != RC::StringType::npos) score -= 1200;
        if (full_name.find(STR("/Script/")) != RC::StringType::npos) score -= 250;
        if (!best || score > best_score) {
            best = obj;
            best_score = score;
        }
    }
    return best;
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

static auto replay_ingame_set_bool_property(
    RC::Unreal::FProperty* property,
    void* container,
    bool value
) -> bool {
    auto* bool_property = RC::Unreal::CastField<RC::Unreal::FBoolProperty>(property);
    if (!bool_property || !is_likely_valid_object_ptr(bool_property)) {
        return false;
    }
    void* value_ptr = safe_property_value_ptr(bool_property, container);
    if (!value_ptr) {
        return false;
    }
    bool_property->SetPropertyValue(value_ptr, value);
    return true;
}

static auto replay_ingame_read_bool_property(
    RC::Unreal::UObject* owner,
    const char* wanted_name,
    bool& out_value
) -> bool {
    out_value = false;
    if (!owner || !is_likely_valid_object_ptr(owner) || !wanted_name || !*wanted_name) {
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
        auto* bool_property = RC::Unreal::CastField<RC::Unreal::FBoolProperty>(property);
        if (!bool_property || !is_likely_valid_object_ptr(bool_property)) {
            continue;
        }
        void* value_ptr = safe_property_value_ptr(bool_property, owner);
        if (!value_ptr) {
            continue;
        }
        out_value = bool_property->GetPropertyValue(value_ptr);
        return true;
    }

    return false;
}

static auto replay_ingame_set_enum_like_property(
    RC::Unreal::FProperty* property,
    void* container,
    int32_t value
) -> bool {
    if (!property || !container) {
        return false;
    }
    void* value_ptr = safe_property_value_ptr(property, container);
    if (!value_ptr) {
        return false;
    }

    const int32_t size = property->GetElementSize();
    if (size == 1 && is_likely_readable_region(value_ptr, sizeof(uint8_t))) {
        *reinterpret_cast<uint8_t*>(value_ptr) = static_cast<uint8_t>(value);
        return true;
    }
    if (size == 2 && is_likely_readable_region(value_ptr, sizeof(uint16_t))) {
        *reinterpret_cast<uint16_t*>(value_ptr) = static_cast<uint16_t>(value);
        return true;
    }
    if (size == 4 && is_likely_readable_region(value_ptr, sizeof(uint32_t))) {
        *reinterpret_cast<uint32_t*>(value_ptr) = static_cast<uint32_t>(value);
        return true;
    }

    if (auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property);
        numeric && is_likely_valid_object_ptr(numeric)) {
        if (numeric->IsInteger()) {
            numeric->SetIntPropertyValue(value_ptr, static_cast<uint64_t>(static_cast<uint32_t>(value)));
            return true;
        }
    }

    return false;
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
        fn_set_location = replay_ingame_resolve_fn(STR("/Script/Engine.Actor:K2_SetActorLocation"));
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
            (void)replay_ingame_set_bool_property(property, params.data(), false);
            continue;
        }

        if (name == "bteleport") {
            (void)replay_ingame_set_bool_property(property, params.data(), true);
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
        fn_set_rotation = replay_ingame_resolve_fn(STR("/Script/Engine.Actor:K2_SetActorRotation"));
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
            (void)replay_ingame_set_bool_property(property, params.data(), true);
            continue;
        }
    }

    if (!wrote_rotation) {
        return false;
    }

    actor->ProcessEvent(fn_set_rotation, params.data());
    return true;
}

static auto replay_ingame_invoke_noarg(
    RC::Unreal::UObject* owner,
    const wchar_t* fn_path
) -> bool {
    if (!owner || !is_likely_valid_object_ptr(owner)) {
        return false;
    }
    auto* fn = replay_ingame_resolve_fn(fn_path);
    if (!fn) {
        return false;
    }
    owner->ProcessEvent(fn, nullptr);
    return true;
}

static auto replay_ingame_invoke_single_bool(
    RC::Unreal::UObject* owner,
    const wchar_t* fn_path,
    bool value
) -> bool {
    if (!owner || !is_likely_valid_object_ptr(owner)) {
        return false;
    }
    auto* fn = replay_ingame_resolve_fn(fn_path);
    if (!fn) {
        return false;
    }

    const int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
    if (param_size <= 0 || param_size > 1024) {
        return false;
    }
    std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
    for (auto* property : replay_enumerate_properties_in_chain(fn)) {
        if (!property || !is_likely_valid_object_ptr(property)) {
            continue;
        }
        if (replay_ingame_set_bool_property(property, params.data(), value)) {
            owner->ProcessEvent(fn, params.data());
            return true;
        }
    }
    return false;
}

static auto replay_ingame_invoke_set_cinematic_mode(
    RC::Unreal::UObject* controller,
    bool enabled
) -> bool {
    if (!controller || !is_likely_valid_object_ptr(controller)) {
        return false;
    }
    static RC::Unreal::UFunction* fn = nullptr;
    if (!fn || !is_likely_valid_object_ptr(fn)) {
        fn = replay_ingame_resolve_fn(STR("/Script/Engine.PlayerController:SetCinematicMode"));
    }
    if (!fn) {
        return false;
    }

    const int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
    if (param_size <= 0 || param_size > 4096) {
        return false;
    }

    std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
    for (auto* property : replay_enumerate_properties_in_chain(fn)) {
        if (!property || !is_likely_valid_object_ptr(property)) {
            continue;
        }

        const auto name = replay_normalize_ascii(property->GetName());
        if (name == "bincinematicmode" || name == "bcinematicmode") {
            (void)replay_ingame_set_bool_property(property, params.data(), enabled);
        } else if (name == "bhideplayer") {
            (void)replay_ingame_set_bool_property(property, params.data(), false);
        } else if (name == "baffectshud") {
            (void)replay_ingame_set_bool_property(property, params.data(), true);
        } else if (name == "baffectsmovement") {
            (void)replay_ingame_set_bool_property(property, params.data(), true);
        } else if (name == "baffectsturning") {
            (void)replay_ingame_set_bool_property(property, params.data(), true);
        }
    }

    controller->ProcessEvent(fn, params.data());
    return true;
}

static auto replay_ingame_invoke_controller_ignore_input(
    RC::Unreal::UObject* controller,
    bool ignore
) -> void {
    if (!controller || !is_likely_valid_object_ptr(controller)) {
        return;
    }
    (void)replay_ingame_invoke_single_bool(controller, STR("/Script/Engine.Controller:SetIgnoreMoveInput"), ignore);
    (void)replay_ingame_invoke_single_bool(controller, STR("/Script/Engine.Controller:SetIgnoreLookInput"), ignore);
}

static auto replay_ingame_invoke_hide_sandbox_ui(bool hide) -> bool {
    auto* manager = replay_ingame_find_best_runtime_object(STR("ExperimentsManager"), STR("ExperimentsManager_C"));
    if (!manager) {
        return false;
    }

    static RC::Unreal::UFunction* fn = nullptr;
    if (!fn || !is_likely_valid_object_ptr(fn)) {
        fn = replay_ingame_resolve_fn(STR("/Script/GameSkillsTrainer.ExperimentsManager:HideAllSandboxUI"));
    }
    if (!fn) {
        return false;
    }

    const int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
    if (param_size <= 0 || param_size > 512) {
        return false;
    }
    std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
    for (auto* property : replay_enumerate_properties_in_chain(fn)) {
        if (!property || !is_likely_valid_object_ptr(property)) {
            continue;
        }
        if (replay_ingame_set_bool_property(property, params.data(), hide ? false : true)) {
            break;
        }
    }
    manager->ProcessEvent(fn, params.data());
    return true;
}

static auto replay_ingame_invoke_hud_ui_control(bool hide) -> bool {
    auto* hud = replay_ingame_find_best_runtime_object(STR("MetaHud"), STR("MetaHud_C"));
    if (!hud) {
        return false;
    }
    if (hide) {
        return replay_ingame_invoke_noarg(hud, STR("/Script/GameSkillsTrainer.MetaHud:TakeCoherentUiControl"));
    }
    return replay_ingame_invoke_noarg(hud, STR("/Script/GameSkillsTrainer.MetaHud:GiveCoherentUiControl"));
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

static auto replay_ingame_resolve_scenario_manager() -> RC::Unreal::UObject* {
    return replay_ingame_find_best_runtime_object(STR("ScenarioManager"), STR("ScenarioManager_C"));
}

static auto replay_ingame_resolve_meta_game_state() -> RC::Unreal::UObject* {
    return replay_ingame_find_best_runtime_object(STR("MetaGameState"), STR("KovGameState_C"));
}

static auto replay_ingame_invoke_scenario_set_play_type(RC::Unreal::UObject* scenario_manager, int32_t play_type) -> bool {
    if (!scenario_manager || !is_likely_valid_object_ptr(scenario_manager)) {
        return false;
    }
    static RC::Unreal::UFunction* fn = nullptr;
    if (!fn || !is_likely_valid_object_ptr(fn)) {
        fn = replay_ingame_resolve_fn(STR("/Script/GameSkillsTrainer.ScenarioManager:SetCurrentScenarioPlayType"));
    }
    if (!fn) {
        return false;
    }
    const int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
    if (param_size <= 0 || param_size > 1024) {
        return false;
    }
    std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
    for (auto* property : replay_enumerate_properties_in_chain(fn)) {
        if (!property || !is_likely_valid_object_ptr(property)) {
            continue;
        }
        if (replay_ingame_set_enum_like_property(property, params.data(), play_type)) {
            scenario_manager->ProcessEvent(fn, params.data());
            return true;
        }
    }
    return false;
}

static auto replay_ingame_invoke_play_current_scenario(
    RC::Unreal::UObject* scenario_manager,
    int32_t play_type,
    int32_t start_type
) -> bool {
    if (!scenario_manager || !is_likely_valid_object_ptr(scenario_manager)) {
        return false;
    }
    static RC::Unreal::UFunction* fn = nullptr;
    if (!fn || !is_likely_valid_object_ptr(fn)) {
        fn = replay_ingame_resolve_fn(STR("/Script/GameSkillsTrainer.ScenarioManager:PlayCurrentScenario"));
    }
    if (!fn) {
        return false;
    }
    const int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
    if (param_size <= 0 || param_size > 1024) {
        return false;
    }
    std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
    for (auto* property : replay_enumerate_properties_in_chain(fn)) {
        if (!property || !is_likely_valid_object_ptr(property)) {
            continue;
        }
        const auto name = replay_normalize_ascii(property->GetName());
        if (name.find("playtype") != std::string::npos) {
            (void)replay_ingame_set_enum_like_property(property, params.data(), play_type);
        } else if (name.find("starttype") != std::string::npos) {
            (void)replay_ingame_set_enum_like_property(property, params.data(), start_type);
        }
    }
    scenario_manager->ProcessEvent(fn, params.data());
    return true;
}

static auto replay_ingame_invoke_is_in_scenario(
    RC::Unreal::UObject* scenario_manager,
    bool& out_in_scenario
) -> bool {
    out_in_scenario = false;
    if (!scenario_manager || !is_likely_valid_object_ptr(scenario_manager)) {
        return false;
    }
    static RC::Unreal::UFunction* fn = nullptr;
    if (!fn || !is_likely_valid_object_ptr(fn)) {
        fn = replay_ingame_resolve_fn(STR("/Script/GameSkillsTrainer.ScenarioManager:IsInScenario"));
    }
    if (!fn) {
        return false;
    }
    const int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
    if (param_size <= 0 || param_size > 2048) {
        return false;
    }
    std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
    scenario_manager->ProcessEvent(fn, params.data());

    for (auto* property : replay_enumerate_properties_in_chain(fn)) {
        if (!property || !is_likely_valid_object_ptr(property)) {
            continue;
        }
        auto* bool_property = RC::Unreal::CastField<RC::Unreal::FBoolProperty>(property);
        if (!bool_property || !is_likely_valid_object_ptr(bool_property)) {
            continue;
        }
        const auto name = replay_normalize_ascii(property->GetName());
        if (!name.empty() && name != "returnvalue") {
            continue;
        }
        void* value_ptr = safe_property_value_ptr(bool_property, params.data());
        if (!value_ptr) {
            continue;
        }
        out_in_scenario = bool_property->GetPropertyValue(value_ptr);
        return true;
    }
    return false;
}

static auto replay_ingame_invoke_is_in_challenge(
    RC::Unreal::UObject* scenario_manager,
    bool& out_in_challenge
) -> bool {
    out_in_challenge = false;
    if (!scenario_manager || !is_likely_valid_object_ptr(scenario_manager)) {
        return false;
    }
    static RC::Unreal::UFunction* fn = nullptr;
    if (!fn || !is_likely_valid_object_ptr(fn)) {
        fn = replay_ingame_resolve_fn(STR("/Script/GameSkillsTrainer.ScenarioManager:IsInChallenge"));
    }
    if (!fn) {
        return false;
    }
    const int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
    if (param_size <= 0 || param_size > 1024) {
        return false;
    }
    std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
    scenario_manager->ProcessEvent(fn, params.data());

    for (auto* property : replay_enumerate_properties_in_chain(fn)) {
        if (!property || !is_likely_valid_object_ptr(property)) {
            continue;
        }
        auto* bool_property = RC::Unreal::CastField<RC::Unreal::FBoolProperty>(property);
        if (!bool_property || !is_likely_valid_object_ptr(bool_property)) {
            continue;
        }
        const auto name = replay_normalize_ascii(property->GetName());
        if (!name.empty() && name != "returnvalue") {
            continue;
        }
        void* value_ptr = safe_property_value_ptr(bool_property, params.data());
        if (!value_ptr) {
            continue;
        }
        out_in_challenge = bool_property->GetPropertyValue(value_ptr);
        return true;
    }
    return false;
}

static auto replay_ingame_invoke_get_current_scenario(
    RC::Unreal::UObject* scenario_manager,
    RC::Unreal::UObject*& out_scenario
) -> bool {
    out_scenario = nullptr;
    if (!scenario_manager || !is_likely_valid_object_ptr(scenario_manager)) {
        return false;
    }
    static RC::Unreal::UFunction* fn = nullptr;
    if (!fn || !is_likely_valid_object_ptr(fn)) {
        fn = replay_ingame_resolve_fn(STR("/Script/GameSkillsTrainer.ScenarioManager:GetCurrentScenario"));
    }
    if (!fn) {
        return false;
    }
    const int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
    if (param_size <= 0 || param_size > 1024) {
        return false;
    }
    std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
    scenario_manager->ProcessEvent(fn, params.data());

    for (auto* property : replay_enumerate_properties_in_chain(fn)) {
        if (!property || !is_likely_valid_object_ptr(property)) {
            continue;
        }
        auto* object_property = RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property);
        if (!object_property || !is_likely_valid_object_ptr(object_property)) {
            continue;
        }
        const auto name = replay_normalize_ascii(property->GetName());
        if (!name.empty() && name != "returnvalue") {
            continue;
        }
        void* value_ptr = safe_property_value_ptr(object_property, params.data());
        if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(void*))) {
            continue;
        }
        out_scenario = object_property->GetObjectPropertyValue(value_ptr);
        return out_scenario != nullptr;
    }
    return false;
}

static auto replay_ingame_invoke_spawn_bots(RC::Unreal::UObject* scenario) -> bool {
    return replay_ingame_invoke_noarg(scenario, STR("/Script/GameSkillsTrainer.Scenario:SpawnBots"));
}

static auto replay_ingame_invoke_load_map_by_name(
    RC::Unreal::UObject* meta_game_state,
    const std::string& map_name_utf8,
    float map_scale
) -> bool {
    if (!meta_game_state || !is_likely_valid_object_ptr(meta_game_state) || map_name_utf8.empty()) {
        return false;
    }
    static RC::Unreal::UFunction* fn = nullptr;
    if (!fn || !is_likely_valid_object_ptr(fn)) {
        fn = replay_ingame_resolve_fn(STR("/Script/GameSkillsTrainer.MetaGameState:LoadMapByName"));
    }
    if (!fn) {
        return false;
    }

    const int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
    if (param_size <= 0 || param_size > 2048) {
        return false;
    }

    std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
    const RC::StringType map_wide = replay_ingame_wide_from_utf8(map_name_utf8.c_str());

    bool wrote_map_name = false;
    bool wrote_scale = false;
    for (auto* property : replay_enumerate_properties_in_chain(fn)) {
        if (!property || !is_likely_valid_object_ptr(property)) {
            continue;
        }
        const auto name = replay_normalize_ascii(property->GetName());
        void* value_ptr = safe_property_value_ptr(property, params.data());
        if (!value_ptr) {
            continue;
        }

        if (name.find("mapname") != std::string::npos || name == "mapname") {
            if (auto* str_property = RC::Unreal::CastField<RC::Unreal::FStrProperty>(property);
                str_property && is_likely_valid_object_ptr(str_property)) {
                RC::Unreal::FString value(map_wide.c_str());
                str_property->SetPropertyValue(value_ptr, value);
                wrote_map_name = true;
            }
            continue;
        }

        if (name == "scale" || name.find("scale") != std::string::npos) {
            if (auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property);
                numeric && is_likely_valid_object_ptr(numeric) && numeric->IsFloatingPoint()) {
                numeric->SetFloatingPointPropertyValue(value_ptr, static_cast<double>(map_scale));
                wrote_scale = true;
            }
            continue;
        }
    }

    if (!wrote_map_name) {
        return false;
    }
    if (!wrote_scale) {
        replay_ingame_log("[replay_playback] load_map called without explicit scale assignment");
    }

    meta_game_state->ProcessEvent(fn, params.data());
    return true;
}

static auto replay_ingame_invoke_clear_scenario(
    RC::Unreal::UObject* meta_game_state
) -> bool {
    return replay_ingame_invoke_noarg(meta_game_state, STR("/Script/GameSkillsTrainer.MetaGameState:ClearScenario"));
}

static auto replay_ingame_invoke_respawn_player_and_destroy_projectiles(
    RC::Unreal::UObject* meta_game_state
) -> bool {
    return replay_ingame_invoke_noarg(
        meta_game_state,
        STR("/Script/GameSkillsTrainer.MetaGameState:RespawnPlayerAndDestroyProjectiles")
    );
}

static auto replay_ingame_invoke_cancel_challenge(
    RC::Unreal::UObject* scenario_manager
) -> bool {
    return replay_ingame_invoke_noarg(scenario_manager, STR("/Script/GameSkillsTrainer.ScenarioManager:CancelChallenge"));
}

static auto replay_ingame_invoke_clear_current_scenario(
    RC::Unreal::UObject* scenario_manager
) -> bool {
    return replay_ingame_invoke_noarg(
        scenario_manager,
        STR("/Script/GameSkillsTrainer.ScenarioManager:ClearCurrentScenario")
    );
}

static auto replay_ingame_apply_ui_mode(ReplayInGameState& state, bool hide, uint64_t now_ms) -> void {
    if (state.next_ui_refresh_ms != 0 && now_ms < state.next_ui_refresh_ms) {
        return;
    }

    bool controller_lock_applied = false;
    auto* controller = replay_ingame_find_best_runtime_object(STR("MetaPlayerController"), STR("PlayerController"));
    if (controller) {
        (void)replay_ingame_invoke_set_cinematic_mode(controller, hide);
        replay_ingame_invoke_controller_ignore_input(controller, hide);
        state.input_lock_applied = hide;
        controller_lock_applied = true;
    }
    (void)replay_ingame_invoke_hud_ui_control(hide);
    (void)replay_ingame_invoke_hide_sandbox_ui(hide);

    // While entering replay mode we want input lock quickly, so retry faster until we bind a controller.
    if (hide && !controller_lock_applied) {
        state.next_ui_refresh_ms = now_ms + 100;
    } else {
        state.next_ui_refresh_ms = now_ms + 1200;
    }
}

static auto replay_ingame_bootstrap_tick(ReplayInGameState& state, uint64_t now_ms) -> void {
    if (state.bootstrap_ready) {
        return;
    }

    replay_ingame_update_debug_phase(state, "bootstrap", now_ms);
    const bool aggressive_bootstrap = replay_ingame_aggressive_bootstrap_enabled();

    if (state.hide_ui) {
        replay_ingame_apply_ui_mode(state, true, now_ms);
    }

    auto* scenario_manager = replay_ingame_resolve_scenario_manager();
    bool in_scenario = false;
    bool in_challenge = false;
    if (scenario_manager) {
        (void)replay_ingame_invoke_is_in_scenario(scenario_manager, in_scenario);
        (void)replay_ingame_invoke_is_in_challenge(scenario_manager, in_challenge);
    }
    state.debug_in_scenario = in_scenario;
    state.debug_in_challenge = in_challenge;

    bool map_ready = state.target_map_name_lower.empty();
    bool map_loading = false;
    bool map_fully_loaded = true;
    auto* meta_game_state = replay_ingame_resolve_meta_game_state();
    if (aggressive_bootstrap && !state.world_reset_sent) {
        bool issued_reset_call = false;
        if (scenario_manager) {
            issued_reset_call = true;
            (void)replay_ingame_invoke_cancel_challenge(scenario_manager);
            (void)replay_ingame_invoke_clear_current_scenario(scenario_manager);
            (void)replay_ingame_invoke_noarg(scenario_manager, STR("/Script/GameSkillsTrainer.ScenarioManager:Reset_FreeplaySession"));
        }
        if (meta_game_state) {
            issued_reset_call = true;
            (void)replay_ingame_invoke_clear_scenario(meta_game_state);
            (void)replay_ingame_invoke_respawn_player_and_destroy_projectiles(meta_game_state);
        }
        if (issued_reset_call) {
            state.world_reset_sent = true;
            state.world_reset_sent_ms = now_ms;
            state.freeplay_play_earliest_ms = std::max<uint64_t>(state.freeplay_play_earliest_ms, now_ms + 1200);
            replay_ingame_log("[replay_playback] world reset requested");
        }
    }

    if (!map_ready && meta_game_state) {
        bool bool_value = false;
        if (replay_ingame_read_bool_property(meta_game_state, "bmaploading", bool_value)) {
            map_loading = bool_value;
        }
        if (replay_ingame_read_bool_property(meta_game_state, "bfullyloaded", bool_value)) {
            map_fully_loaded = bool_value;
        }

        std::string current_map{};
        if (replay_read_string_property(meta_game_state, "currentmapname", current_map)) {
            std::string current_map_lower = current_map;
            for (auto& ch : current_map_lower) {
                ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
            }
            map_ready = !current_map_lower.empty()
                && current_map_lower.find(state.target_map_name_lower) != std::string::npos;
        }

        if (aggressive_bootstrap && !map_ready && !in_scenario && !map_loading && !state.map_load_sent) {
            (void)replay_ingame_invoke_load_map_by_name(
                meta_game_state,
                state.target_map_name,
                state.target_map_scale > 0.0f ? state.target_map_scale : 1.0f
            );
            state.map_load_sent = true;
            state.map_load_sent_ms = now_ms;
            replay_ingame_log("[replay_playback] map load requested");
        } else if (aggressive_bootstrap
            && !map_ready
            && !in_scenario
            && !map_loading
            && state.map_load_sent
            && !state.map_load_retry_sent
            && state.map_load_sent_ms > 0
            && now_ms > state.map_load_sent_ms + 5000) {
            (void)replay_ingame_invoke_load_map_by_name(
                meta_game_state,
                state.target_map_name,
                state.target_map_scale > 0.0f ? state.target_map_scale : 1.0f
            );
            state.map_load_retry_sent = true;
            replay_ingame_log("[replay_playback] map load retry requested");
        }
    }

    if (in_challenge) {
        state.debug_ready_reason = "interrupted_challenge_started";
        replay_ingame_emit_interrupt_event(state, now_ms, "challenge_started_during_replay_bootstrap");
        replay_ingame_log("[replay_playback] interrupted: challenge started during bootstrap");
        if (state.hide_ui || state.input_lock_applied) {
            replay_ingame_apply_ui_mode(state, false, now_ms);
        }
        state.active = false;
        state.session_id.clear();
        state.entities.clear();
        state.bindings.clear();
        state.runtime_refs.clear();
        state.next_runtime_refresh_ms = 0;
        state.bootstrap_ready = false;
        state.ready_event_emitted = false;
        state.input_lock_applied = false;
        state.freeplay_bootstrap_sent = false;
        state.freeplay_play_sent = false;
        state.world_reset_sent = false;
        state.map_load_sent = false;
        state.map_load_retry_sent = false;
        state.spawn_sent = false;
        state.target_map_name.clear();
        state.target_map_name_lower.clear();
        state.map_load_sent_ms = 0;
        state.world_reset_sent_ms = 0;
        replay_ingame_reset_debug(state, now_ms, "interrupted");
        return;
    }

    if (aggressive_bootstrap && state.force_freeplay && scenario_manager) {
        if (!state.freeplay_bootstrap_sent) {
            (void)replay_ingame_invoke_scenario_set_play_type(scenario_manager, 1); // EScenarioPlayType::FreePlay
            (void)replay_ingame_invoke_noarg(scenario_manager, STR("/Script/GameSkillsTrainer.ScenarioManager:Reset_FreeplaySession"));
            state.freeplay_bootstrap_sent = true;
            replay_ingame_log("[replay_playback] freeplay bootstrap primed");
        }

        if (!state.freeplay_play_sent
            && now_ms >= state.freeplay_play_earliest_ms
            && !in_scenario
            && !in_challenge
            && !map_loading) {
            RC::Unreal::UObject* current_scenario = nullptr;
            const bool have_current_scenario = replay_ingame_invoke_get_current_scenario(scenario_manager, current_scenario)
                && current_scenario
                && is_likely_valid_object_ptr(current_scenario);
            if (have_current_scenario) {
                if (replay_ingame_invoke_play_current_scenario(
                        scenario_manager,
                        1, // EScenarioPlayType::FreePlay
                        0  // EScenarioStartType::Start
                    )) {
                    state.freeplay_play_sent = true;
                    replay_ingame_log("[replay_playback] freeplay play requested");
                }
            } else {
                state.debug_ready_reason = "waiting_current_scenario";
            }
        }
    }

    bool have_live_bot_refs = false;
    for (const auto& ref : state.runtime_refs) {
        if (ref.entity.is_bot) {
            have_live_bot_refs = true;
            break;
        }
    }

    if (aggressive_bootstrap && !state.spawn_sent && in_scenario && !map_loading && map_fully_loaded && !have_live_bot_refs) {
        RC::Unreal::UObject* scenario = nullptr;
        if (scenario_manager && replay_ingame_invoke_get_current_scenario(scenario_manager, scenario) && scenario) {
            (void)replay_ingame_invoke_spawn_bots(scenario);
            state.spawn_sent = true;
            replay_ingame_log("[replay_playback] spawn bots requested");
        }
    }

    if (in_scenario && !map_loading && map_fully_loaded
        && (state.next_runtime_refresh_ms == 0 || now_ms >= state.next_runtime_refresh_ms)) {
        replay_ingame_refresh_runtime_refs(state, now_ms);
    }

    const bool have_entities = !state.runtime_refs.empty();
    const bool map_condition_ok = map_ready;
    const bool ready = in_scenario && map_condition_ok && !map_loading && map_fully_loaded && have_entities;
    const bool timed_out = state.bootstrap_started_ms > 0
        && now_ms >= state.bootstrap_started_ms + state.bootstrap_timeout_ms;

    state.debug_map_ready = map_condition_ok;
    state.debug_map_loading = map_loading;
    state.debug_map_fully_loaded = map_fully_loaded;
    state.debug_have_entities = have_entities;
    state.debug_ready = ready;
    state.debug_timed_out = timed_out;
    if (ready) {
        state.debug_ready_reason = "ready";
    } else if (timed_out) {
        state.debug_ready_reason = "timeout";
    } else {
        state.debug_ready_reason = "waiting";
    }
    state.debug_last_update_ms = now_ms;

    if (ready || timed_out) {
        state.bootstrap_ready = true;
        if (!state.ready_event_emitted) {
            replay_ingame_emit_ready_event(state, now_ms, ready, ready ? "ready" : "timeout");
            state.ready_event_emitted = true;
        }
        if (ready) {
            replay_ingame_log("[replay_playback] bootstrap ready");
        } else {
            replay_ingame_log("[replay_playback] bootstrap timeout; continuing with best effort");
        }
    }
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
        state.bootstrap_ready = false;
        state.ready_event_emitted = false;
        state.hide_ui = command.hide_ui != 0;
        state.force_freeplay = command.force_freeplay != 0;
        state.freeplay_bootstrap_sent = false;
        state.freeplay_play_sent = false;
        state.world_reset_sent = false;
        state.map_load_sent = false;
        state.map_load_retry_sent = false;
        state.spawn_sent = false;
        state.target_map_name = command.map_name;
        state.target_map_name_lower = command.map_name;
        for (auto& ch : state.target_map_name_lower) {
            ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
        }
        state.target_map_scale = (std::isfinite(command.map_scale) && command.map_scale > 0.0f) ? command.map_scale : 1.0f;
        state.bootstrap_started_ms = now_ms;
        state.bootstrap_timeout_ms = command.bootstrap_timeout_ms > 0
            ? static_cast<uint64_t>(command.bootstrap_timeout_ms)
            : static_cast<uint64_t>(12000);
        state.freeplay_play_earliest_ms = now_ms + 900;
        state.world_reset_sent_ms = 0;
        state.map_load_sent_ms = 0;
        state.next_ui_refresh_ms = 0;
        state.debug_last_command = "play_start";
        state.debug_last_command_ms = now_ms;
        replay_ingame_reset_debug(state, now_ms, "starting");
        replay_ingame_log("[replay_playback] start command received");
        replay_ingame_log(
            replay_ingame_aggressive_bootstrap_enabled()
                ? "[replay_playback] bootstrap mode=aggressive"
                : "[replay_playback] bootstrap mode=safe"
        );
        break;
    case BridgeCommandKind::ReplayPlayStop:
        if (state.hide_ui || state.input_lock_applied) {
            replay_ingame_apply_ui_mode(state, false, now_ms);
        }
        state.active = false;
        state.session_id.clear();
        state.entities.clear();
        state.bindings.clear();
        state.runtime_refs.clear();
        state.next_runtime_refresh_ms = 0;
        state.bootstrap_ready = false;
        state.ready_event_emitted = false;
        state.input_lock_applied = false;
        state.freeplay_bootstrap_sent = false;
        state.freeplay_play_sent = false;
        state.world_reset_sent = false;
        state.map_load_sent = false;
        state.map_load_retry_sent = false;
        state.spawn_sent = false;
        state.target_map_name.clear();
        state.target_map_name_lower.clear();
        state.freeplay_play_earliest_ms = 0;
        state.world_reset_sent_ms = 0;
        state.map_load_sent_ms = 0;
        state.debug_last_command = "play_stop";
        state.debug_last_command_ms = now_ms;
        replay_ingame_reset_debug(state, now_ms, "idle");
        replay_ingame_log("[replay_playback] stop command received");
        break;
    case BridgeCommandKind::ReplayEntityMeta: {
        if (command.entity.id.empty()) {
            break;
        }
        state.debug_last_command = "entity_meta";
        state.debug_last_command_ms = now_ms;
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
        state.debug_last_command = "entity_pose";
        state.debug_last_command_ms = now_ms;
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
            state.debug_last_command = "remove_entity";
            state.debug_last_command_ms = now_ms;
            state.entities.erase(command.entity_id);
            state.bindings.erase(command.entity_id);
        }
        break;
    case BridgeCommandKind::Unknown:
    case BridgeCommandKind::StateSnapshotRequest:
    default:
        break;
    }

    if (state.active
        && state.bootstrap_ready
        && (state.next_runtime_refresh_ms == 0 || now_ms >= state.next_runtime_refresh_ms)) {
        replay_ingame_refresh_runtime_refs(state, now_ms);
    }
}

static auto replay_ingame_playback_tick(uint64_t now_ms) -> void {
    auto& state = replay_ingame_state();
    if (!state.active) {
        return;
    }

    replay_ingame_bootstrap_tick(state, now_ms);
    if (!state.bootstrap_ready) {
        return;
    }

    auto* scenario_manager = replay_ingame_resolve_scenario_manager();
    bool in_challenge = false;
    state.debug_in_challenge = false;
    if (scenario_manager && replay_ingame_invoke_is_in_challenge(scenario_manager, in_challenge) && in_challenge) {
        state.debug_in_challenge = true;
        state.debug_last_update_ms = now_ms;
        state.debug_ready_reason = "interrupted_challenge_started";
        replay_ingame_emit_interrupt_event(state, now_ms, "challenge_started_during_replay");
        replay_ingame_log("[replay_playback] interrupted: challenge started during replay");
        if (state.hide_ui || state.input_lock_applied) {
            replay_ingame_apply_ui_mode(state, false, now_ms);
        }
        state.active = false;
        state.session_id.clear();
        state.entities.clear();
        state.bindings.clear();
        state.runtime_refs.clear();
        state.next_runtime_refresh_ms = 0;
        state.bootstrap_ready = false;
        state.ready_event_emitted = false;
        state.input_lock_applied = false;
        state.freeplay_bootstrap_sent = false;
        state.freeplay_play_sent = false;
        state.world_reset_sent = false;
        state.map_load_sent = false;
        state.map_load_retry_sent = false;
        state.spawn_sent = false;
        state.target_map_name.clear();
        state.target_map_name_lower.clear();
        state.freeplay_play_earliest_ms = 0;
        state.world_reset_sent_ms = 0;
        state.map_load_sent_ms = 0;
        replay_ingame_reset_debug(state, now_ms, "interrupted");
        return;
    }
    state.debug_in_challenge = false;

    if (state.next_runtime_refresh_ms == 0 || now_ms >= state.next_runtime_refresh_ms) {
        replay_ingame_refresh_runtime_refs(state, now_ms);
    }

    replay_ingame_update_debug_phase(state, "playing", now_ms);

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
