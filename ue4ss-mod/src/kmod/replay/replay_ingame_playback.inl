namespace kmod_replay {

enum class ReplayInGamePhase : uint8_t {
    Idle = 0,
    Preflight = 1,
    CancelChallenge = 2,
    ClearScenario = 3,
    ForceFreeplay = 4,
    LoadMap = 5,
    WaitMapReady = 6,
    SpawnOrBindEntities = 7,
    Ready = 8,
    Playing = 9,
    Interrupted = 10,
    Failed = 11,
};

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
    ReplayInGamePhase phase{ReplayInGamePhase::Idle};
    std::vector<ReplayPlaybackFrame> loaded_frames{};
    std::string loaded_session_id{};
    bool loaded_ready{false};
    bool load_in_progress{false};
    int32_t load_expected_chunks{0};
    int32_t load_received_chunks{0};
    int32_t load_expected_frames{0};
    int32_t next_load_chunk_index{0};
    float playback_speed{1.0f};
    uint64_t playback_started_ms{0};
    uint64_t playback_first_frame_ts_ms{0};
    size_t playback_frame_cursor{0};

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
    uint64_t debug_status_seq{0};

    std::unordered_set<std::string> orphan_entity_ids{};
    std::string ready_policy{"best_effort"};
    int32_t status_interval_ms{250};
    int32_t expected_bot_count{-1};
    std::unordered_set<std::string> expected_bot_profiles{};
    bool started_event_emitted{false};
    bool failed_event_emitted{false};
    uint64_t next_status_emit_ms{0};
    uint64_t phase_entered_ms{0};
    uint64_t next_phase_action_ms{0};
    uint64_t map_unstable_since_ms{0};
    bool ui_unlock_pending{false};
    uint64_t ui_unlock_deadline_ms{0};
    uint32_t map_load_attempts{0};
    uint32_t freeplay_play_attempts{0};
    uint32_t spawn_attempts{0};
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
    return state.active || state.load_in_progress || state.ui_unlock_pending;
}

static auto replay_ingame_normalize_map_token(std::string value) -> std::string {
    if (value.empty()) {
        return {};
    }
    for (auto& ch : value) {
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }

    size_t start = 0;
    while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start])) != 0) {
        ++start;
    }
    size_t end = value.size();
    while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1])) != 0) {
        --end;
    }
    value = value.substr(start, end - start);
    if (value.empty()) {
        return {};
    }

    const auto slash = value.find_last_of("/\\");
    if (slash != std::string::npos && slash + 1 < value.size()) {
        value = value.substr(slash + 1);
    }

    const auto dot = value.find_last_of('.');
    if (dot != std::string::npos && dot > 0) {
        value = value.substr(0, dot);
    }
    return value;
}

static auto replay_ingame_normalize_ascii_string(std::string value) -> std::string {
    for (auto& ch : value) {
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
    return value;
}

static auto replay_ingame_base64_decode(const std::string& input, std::vector<uint8_t>& out) -> bool {
    out.clear();
    if (input.empty()) {
        return false;
    }

    auto decode_char = [](char ch) -> int32_t {
        if (ch >= 'A' && ch <= 'Z') return ch - 'A';
        if (ch >= 'a' && ch <= 'z') return ch - 'a' + 26;
        if (ch >= '0' && ch <= '9') return ch - '0' + 52;
        if (ch == '+') return 62;
        if (ch == '/') return 63;
        if (ch == '=') return -2;
        return -1;
    };

    int32_t quartet[4] = {-1, -1, -1, -1};
    size_t quartet_len = 0;
    for (char ch : input) {
        if (std::isspace(static_cast<unsigned char>(ch)) != 0) {
            continue;
        }
        const int32_t decoded = decode_char(ch);
        if (decoded == -1) {
            return false;
        }
        quartet[quartet_len++] = decoded;
        if (quartet_len != 4) {
            continue;
        }

        if (quartet[0] < 0 || quartet[1] < 0) {
            return false;
        }
        out.emplace_back(static_cast<uint8_t>((quartet[0] << 2) | (quartet[1] >> 4)));
        if (quartet[2] != -2) {
            if (quartet[2] < 0) {
                return false;
            }
            out.emplace_back(static_cast<uint8_t>(((quartet[1] & 0x0F) << 4) | (quartet[2] >> 2)));
        }
        if (quartet[3] != -2) {
            if (quartet[2] < 0 || quartet[3] < 0) {
                return false;
            }
            out.emplace_back(static_cast<uint8_t>(((quartet[2] & 0x03) << 6) | quartet[3]));
        }
        quartet_len = 0;
    }
    return quartet_len == 0 && !out.empty();
}

static auto replay_ingame_clear_loaded_replay(ReplayInGameState& state) -> void {
    state.loaded_frames.clear();
    state.loaded_session_id.clear();
    state.loaded_ready = false;
    state.load_in_progress = false;
    state.load_expected_chunks = 0;
    state.load_received_chunks = 0;
    state.load_expected_frames = 0;
    state.next_load_chunk_index = 0;
    state.playback_started_ms = 0;
    state.playback_first_frame_ts_ms = 0;
    state.playback_frame_cursor = 0;
}

static auto replay_ingame_read_u16_le(
    const std::vector<uint8_t>& data,
    size_t& offset,
    uint16_t& out_value
) -> bool {
    if (offset + 2 > data.size()) {
        return false;
    }
    out_value = static_cast<uint16_t>(data[offset])
        | (static_cast<uint16_t>(data[offset + 1]) << 8);
    offset += 2;
    return true;
}

static auto replay_ingame_read_u32_le(
    const std::vector<uint8_t>& data,
    size_t& offset,
    uint32_t& out_value
) -> bool {
    if (offset + 4 > data.size()) {
        return false;
    }
    out_value = static_cast<uint32_t>(data[offset])
        | (static_cast<uint32_t>(data[offset + 1]) << 8)
        | (static_cast<uint32_t>(data[offset + 2]) << 16)
        | (static_cast<uint32_t>(data[offset + 3]) << 24);
    offset += 4;
    return true;
}

static auto replay_ingame_read_u64_le(
    const std::vector<uint8_t>& data,
    size_t& offset,
    uint64_t& out_value
) -> bool {
    if (offset + 8 > data.size()) {
        return false;
    }
    out_value = 0;
    for (uint32_t i = 0; i < 8; ++i) {
        out_value |= (static_cast<uint64_t>(data[offset + i]) << (i * 8));
    }
    offset += 8;
    return true;
}

static auto replay_ingame_read_f32_le(
    const std::vector<uint8_t>& data,
    size_t& offset,
    float& out_value
) -> bool {
    uint32_t raw = 0;
    if (!replay_ingame_read_u32_le(data, offset, raw)) {
        return false;
    }
    std::memcpy(&out_value, &raw, sizeof(float));
    return std::isfinite(out_value);
}

static auto replay_ingame_read_string_le(
    const std::vector<uint8_t>& data,
    size_t& offset,
    std::string& out_value
) -> bool {
    out_value.clear();
    uint16_t len = 0;
    if (!replay_ingame_read_u16_le(data, offset, len)) {
        return false;
    }
    if (offset + static_cast<size_t>(len) > data.size()) {
        return false;
    }
    out_value.assign(reinterpret_cast<const char*>(data.data() + offset), static_cast<size_t>(len));
    offset += static_cast<size_t>(len);
    return true;
}

static auto replay_ingame_decode_chunk_payload(
    const std::string& payload_b64,
    std::vector<ReplayPlaybackFrame>& out_frames
) -> bool {
    out_frames.clear();
    std::vector<uint8_t> decoded{};
    if (!replay_ingame_base64_decode(payload_b64, decoded)) {
        return false;
    }

    size_t offset = 0;
    while (offset < decoded.size()) {
        ReplayPlaybackFrame frame{};
        uint32_t upsert_count = 0;
        uint32_t remove_count = 0;
        if (!replay_ingame_read_u64_le(decoded, offset, frame.ts_ms)
            || !replay_ingame_read_u64_le(decoded, offset, frame.seq)
            || !replay_ingame_read_u32_le(decoded, offset, upsert_count)
            || !replay_ingame_read_u32_le(decoded, offset, remove_count)) {
            return false;
        }

        frame.upserts.reserve(static_cast<size_t>(upsert_count));
        frame.removes.reserve(static_cast<size_t>(remove_count));
        for (uint32_t i = 0; i < upsert_count; ++i) {
            ReplayEntity entity{};
            uint8_t flags = 0;
            if (!replay_ingame_read_string_le(decoded, offset, entity.id)
                || !replay_ingame_read_string_le(decoded, offset, entity.profile)) {
                return false;
            }
            if (offset + 1 > decoded.size()) {
                return false;
            }
            flags = decoded[offset++];
            entity.is_player = (flags & 0x01u) != 0;
            entity.is_bot = (flags & 0x02u) != 0;
            if (!replay_ingame_read_f32_le(decoded, offset, entity.location.x)
                || !replay_ingame_read_f32_le(decoded, offset, entity.location.y)
                || !replay_ingame_read_f32_le(decoded, offset, entity.location.z)
                || !replay_ingame_read_f32_le(decoded, offset, entity.rotation.pitch)
                || !replay_ingame_read_f32_le(decoded, offset, entity.rotation.yaw)
                || !replay_ingame_read_f32_le(decoded, offset, entity.rotation.roll)
                || !replay_ingame_read_f32_le(decoded, offset, entity.velocity.x)
                || !replay_ingame_read_f32_le(decoded, offset, entity.velocity.y)
                || !replay_ingame_read_f32_le(decoded, offset, entity.velocity.z)) {
                return false;
            }
            frame.upserts.emplace_back(std::move(entity));
        }

        for (uint32_t i = 0; i < remove_count; ++i) {
            std::string entity_id{};
            if (!replay_ingame_read_string_le(decoded, offset, entity_id)) {
                return false;
            }
            frame.removes.emplace_back(std::move(entity_id));
        }

        out_frames.emplace_back(std::move(frame));
    }

    return !out_frames.empty();
}

static auto replay_ingame_append_debug_overlay_text(RC::StringType& overlay_text) -> bool {
    const auto& state = replay_ingame_state();

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

    overlay_text += STR("\nUI | hide ");
    overlay_text += state.hide_ui ? STR("1") : STR("0");
    overlay_text += STR(" | lock ");
    overlay_text += state.input_lock_applied ? STR("1") : STR("0");
    overlay_text += STR(" | unlock_pending ");
    overlay_text += state.ui_unlock_pending ? STR("1") : STR("0");
    if (state.ui_unlock_deadline_ms > 0) {
        overlay_text += STR(" | unlock_deadline_ms ");
        overlay_text += std::to_wstring(static_cast<unsigned long long>(state.ui_unlock_deadline_ms));
    }

    overlay_text += STR("\nLoad | ready ");
    overlay_text += state.loaded_ready ? STR("1") : STR("0");
    overlay_text += STR(" | chunks ");
    overlay_text += std::to_wstring(static_cast<long long>(state.load_received_chunks));
    overlay_text += STR("/");
    overlay_text += std::to_wstring(static_cast<long long>(state.load_expected_chunks));
    overlay_text += STR(" | frames ");
    overlay_text += std::to_wstring(static_cast<unsigned long long>(state.loaded_frames.size()));

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

static auto replay_ingame_emit_complete_event(
    const ReplayInGameState& state,
    uint64_t now_ms
) -> void {
    std::string msg{};
    msg.reserve(256);
    msg += "{\"ev\":\"replay_playback_complete\",\"ts_ms\":";
    replay_append_u64(msg, now_ms);
    msg += ",\"session_id\":\"";
    msg += replay_escape_json(state.session_id);
    msg += "\"}";
    kovaaks::RustBridge::emit_json(msg.c_str());
}

static auto replay_ingame_phase_to_cstr(ReplayInGamePhase phase) -> const char* {
    switch (phase) {
    case ReplayInGamePhase::Idle: return "idle";
    case ReplayInGamePhase::Preflight: return "preflight";
    case ReplayInGamePhase::CancelChallenge: return "cancel_challenge";
    case ReplayInGamePhase::ClearScenario: return "clear_scenario";
    case ReplayInGamePhase::ForceFreeplay: return "force_freeplay";
    case ReplayInGamePhase::LoadMap: return "load_map";
    case ReplayInGamePhase::WaitMapReady: return "wait_map_ready";
    case ReplayInGamePhase::SpawnOrBindEntities: return "spawn_or_bind_entities";
    case ReplayInGamePhase::Ready: return "ready";
    case ReplayInGamePhase::Playing: return "playing";
    case ReplayInGamePhase::Interrupted: return "interrupted";
    case ReplayInGamePhase::Failed: return "failed";
    default: return "unknown";
    }
}

static auto replay_ingame_set_phase(
    ReplayInGameState& state,
    ReplayInGamePhase phase,
    uint64_t now_ms
) -> void {
    if (state.phase == phase) {
        return;
    }
    state.phase = phase;
    state.phase_entered_ms = now_ms;
    replay_ingame_update_debug_phase(state, replay_ingame_phase_to_cstr(phase), now_ms);
}

static auto replay_ingame_ready_policy_is_best_effort(const ReplayInGameState& state) -> bool {
    return state.ready_policy != "strict";
}

static auto replay_ingame_emit_started_event(
    const ReplayInGameState& state,
    uint64_t now_ms
) -> void {
    std::string msg{};
    msg.reserve(512);
    msg += "{\"ev\":\"replay_playback_started\",\"ts_ms\":";
    replay_append_u64(msg, now_ms);
    msg += ",\"session_id\":\"";
    msg += replay_escape_json(state.session_id);
    msg += "\",\"phase\":\"";
    msg += replay_escape_json(replay_ingame_phase_to_cstr(state.phase));
    msg += "\",\"ready_policy\":\"";
    msg += replay_escape_json(state.ready_policy);
    msg += "\",\"status_interval_ms\":";
    replay_append_i32(msg, state.status_interval_ms);
    msg += ",\"expected_bot_count\":";
    replay_append_i32(msg, state.expected_bot_count);
    msg += "}";
    kovaaks::RustBridge::emit_json(msg.c_str());
}

static auto replay_ingame_emit_failed_event(
    ReplayInGameState& state,
    uint64_t now_ms,
    const char* reason
) -> void {
    if (state.failed_event_emitted) {
        return;
    }
    state.failed_event_emitted = true;
    std::string msg{};
    msg.reserve(320);
    msg += "{\"ev\":\"replay_playback_failed\",\"ts_ms\":";
    replay_append_u64(msg, now_ms);
    msg += ",\"session_id\":\"";
    msg += replay_escape_json(state.session_id);
    msg += "\",\"phase\":\"";
    msg += replay_escape_json(replay_ingame_phase_to_cstr(state.phase));
    msg += "\",\"reason\":\"";
    msg += replay_escape_json(reason ? reason : "unknown");
    msg += "\"}";
    kovaaks::RustBridge::emit_json(msg.c_str());
}

static auto replay_ingame_emit_status_event(
    ReplayInGameState& state,
    uint64_t now_ms
) -> void {
    size_t bound_count = 0;
    for (const auto& kv : state.bindings) {
        if (kv.second.actor && is_likely_valid_object_ptr(kv.second.actor)) {
            ++bound_count;
        }
    }

    std::string msg{};
    msg.reserve(768);
    msg += "{\"ev\":\"replay_playback_status\",\"ts_ms\":";
    replay_append_u64(msg, now_ms);
    msg += ",\"session_id\":\"";
    msg += replay_escape_json(state.session_id);
    msg += "\",\"seq\":";
    replay_append_u64(msg, state.debug_status_seq);
    msg += ",\"phase\":\"";
    msg += replay_escape_json(replay_ingame_phase_to_cstr(state.phase));
    msg += "\",\"in_scenario\":";
    msg += state.debug_in_scenario ? "1" : "0";
    msg += ",\"in_challenge\":";
    msg += state.debug_in_challenge ? "1" : "0";
    msg += ",\"map_ready\":";
    msg += state.debug_map_ready ? "1" : "0";
    msg += ",\"map_loading\":";
    msg += state.debug_map_loading ? "1" : "0";
    msg += ",\"map_fully_loaded\":";
    msg += state.debug_map_fully_loaded ? "1" : "0";
    msg += ",\"have_entities\":";
    msg += state.debug_have_entities ? "1" : "0";
    msg += ",\"ready\":";
    msg += state.debug_ready ? "1" : "0";
    msg += ",\"timed_out\":";
    msg += state.debug_timed_out ? "1" : "0";
    msg += ",\"runtime_refs\":";
    replay_append_u64(msg, static_cast<uint64_t>(state.runtime_refs.size()));
    msg += ",\"entities\":";
    replay_append_u64(msg, static_cast<uint64_t>(state.entities.size()));
    msg += ",\"bound\":";
    replay_append_u64(msg, static_cast<uint64_t>(bound_count));
    msg += ",\"ready_reason\":\"";
    msg += replay_escape_json(state.debug_ready_reason);
    msg += "\"}";
    kovaaks::RustBridge::emit_json(msg.c_str());
    state.debug_status_seq += 1;
}

static auto replay_ingame_emit_status_if_due(
    ReplayInGameState& state,
    uint64_t now_ms,
    bool force
) -> void {
    const uint64_t interval_ms = static_cast<uint64_t>(
        state.status_interval_ms > 25 ? state.status_interval_ms : 250
    );
    if (!force && state.next_status_emit_ms != 0 && now_ms < state.next_status_emit_ms) {
        return;
    }
    replay_ingame_emit_status_event(state, now_ms);
    state.next_status_emit_ms = now_ms + interval_ms;
}

static auto replay_ingame_reset_runtime_state(
    ReplayInGameState& state,
    uint64_t now_ms,
    const char* phase_label
) -> void {
    state.active = false;
    state.session_id.clear();
    state.entities.clear();
    state.bindings.clear();
    state.runtime_refs.clear();
    state.orphan_entity_ids.clear();
    state.expected_bot_profiles.clear();
    state.next_runtime_refresh_ms = 0;
    state.bootstrap_ready = false;
    state.ready_event_emitted = false;
    state.started_event_emitted = false;
    state.failed_event_emitted = false;
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
    state.next_status_emit_ms = 0;
    state.phase_entered_ms = 0;
    state.next_phase_action_ms = 0;
    state.map_unstable_since_ms = 0;
    state.map_load_attempts = 0;
    state.freeplay_play_attempts = 0;
    state.spawn_attempts = 0;
    state.playback_started_ms = 0;
    state.playback_first_frame_ts_ms = 0;
    state.playback_frame_cursor = 0;
    state.playback_speed = 1.0f;
    state.ready_policy = "best_effort";
    state.status_interval_ms = 250;
    state.expected_bot_count = -1;
    state.phase = ReplayInGamePhase::Idle;
    state.debug_status_seq = 0;
    replay_ingame_reset_debug(state, now_ms, phase_label ? phase_label : "idle");
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

static auto replay_ingame_collect_runtime_objects(
    const wchar_t* primary_name,
    const wchar_t* secondary_name,
    std::vector<RC::Unreal::UObject*>& out
) -> void {
    if (primary_name && *primary_name) {
        RC::Unreal::UObjectGlobals::FindAllOf(primary_name, out);
    }
    if (secondary_name && *secondary_name) {
        std::vector<RC::Unreal::UObject*> alt{};
        RC::Unreal::UObjectGlobals::FindAllOf(secondary_name, alt);
        for (auto* obj : alt) {
            if (obj) {
                out.emplace_back(obj);
            }
        }
    }

    std::unordered_set<RC::Unreal::UObject*> seen{};
    std::vector<RC::Unreal::UObject*> filtered{};
    filtered.reserve(out.size());
    for (auto* obj : out) {
        if (!obj || !is_likely_valid_object_ptr(obj)) {
            continue;
        }
        if (!seen.insert(obj).second) {
            continue;
        }
        const auto full_name = obj->GetFullName();
        if (replay_is_rejected_runtime_object_name(full_name)) {
            continue;
        }
        filtered.emplace_back(obj);
    }
    out.swap(filtered);
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
    std::vector<RC::Unreal::UObject*> managers{};
    replay_ingame_collect_runtime_objects(STR("ExperimentsManager"), STR("ExperimentsManager_C"), managers);
    if (managers.empty()) {
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
    if (param_size > 512) {
        return false;
    }
    bool invoked = false;
    for (auto* manager : managers) {
        if (!manager || !is_likely_valid_object_ptr(manager)) {
            continue;
        }
        if (param_size <= 0) {
            manager->ProcessEvent(fn, nullptr);
            invoked = true;
            continue;
        }
        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
        for (auto* property : replay_enumerate_properties_in_chain(fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            const auto name = replay_normalize_ascii(property->GetName());
            bool value = hide;
            if (name.find("show") != std::string::npos) {
                value = !hide;
            } else if (name.find("hide") != std::string::npos) {
                value = hide;
            }
            if (replay_ingame_set_bool_property(property, params.data(), value)) {
                break;
            }
        }
        manager->ProcessEvent(fn, params.data());
        invoked = true;
    }
    return invoked;
}

static auto replay_ingame_invoke_hud_ui_control(bool hide) -> bool {
    std::vector<RC::Unreal::UObject*> huds{};
    replay_ingame_collect_runtime_objects(STR("MetaHud"), STR("MetaHud_C"), huds);
    if (huds.empty()) {
        return false;
    }
    bool invoked = false;
    for (auto* hud : huds) {
        if (!hud || !is_likely_valid_object_ptr(hud)) {
            continue;
        }
        const bool ok = hide
            ? replay_ingame_invoke_noarg(hud, STR("/Script/GameSkillsTrainer.MetaHud:TakeCoherentUiControl"))
            : replay_ingame_invoke_noarg(hud, STR("/Script/GameSkillsTrainer.MetaHud:GiveCoherentUiControl"));
        invoked = invoked || ok;
    }
    return invoked;
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

    const bool entity_player_like =
        entity.is_player || replay_ingame_normalize_ascii_string(entity.profile) == "player";
    ReplayEntityActorRef* selected = nullptr;

    selected = select_ref([&](const ReplayEntityActorRef& ref) {
        return ref.entity.id == entity.id;
    });
    if (!selected && entity_player_like) {
        selected = select_ref([&](const ReplayEntityActorRef& ref) {
            return ref.entity.is_player;
        });
    }
    if (!selected && entity_player_like) {
        selected = select_ref([&](const ReplayEntityActorRef& ref) {
            return !ref.entity.is_bot;
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

    std::vector<RC::Unreal::UObject*> controllers{};
    replay_ingame_collect_runtime_objects(STR("MetaPlayerController"), STR("PlayerController"), controllers);
    replay_ingame_collect_runtime_objects(STR("NewCharacterPlayerController"), STR("NewCharacterPlayerController_C"), controllers);

    bool controller_seen = false;
    for (auto* controller : controllers) {
        if (!controller || !is_likely_valid_object_ptr(controller)) {
            continue;
        }
        controller_seen = true;
        (void)replay_ingame_invoke_set_cinematic_mode(controller, hide);
        replay_ingame_invoke_controller_ignore_input(controller, hide);
    }
    if (controller_seen) {
        state.input_lock_applied = hide;
    } else if (!hide && state.input_lock_applied) {
        // Controller can be transient during travel/reset; keep retrying unlock until found.
        state.input_lock_applied = true;
    }
    const bool hud_invoked = replay_ingame_invoke_hud_ui_control(hide);
    const bool sandbox_invoked = replay_ingame_invoke_hide_sandbox_ui(hide);

    // While entering replay mode we want input lock quickly, so retry faster until we bind a controller.
    if ((hide && (!controller_seen || !hud_invoked || !sandbox_invoked))
        || (!hide && (state.input_lock_applied || !controller_seen))) {
        state.next_ui_refresh_ms = now_ms + 100;
    } else {
        state.next_ui_refresh_ms = now_ms + (hide ? 600 : 250);
    }
}

static auto replay_ingame_request_ui_release(ReplayInGameState& state, uint64_t now_ms) -> void {
    if (!state.hide_ui && !state.input_lock_applied && !state.ui_unlock_pending) {
        return;
    }
    state.ui_unlock_pending = true;
    state.ui_unlock_deadline_ms = std::max<uint64_t>(state.ui_unlock_deadline_ms, now_ms + 5000);
    state.next_ui_refresh_ms = 0;
    replay_ingame_apply_ui_mode(state, false, now_ms);
}

static auto replay_ingame_apply_loaded_frame(
    ReplayInGameState& state,
    const ReplayPlaybackFrame& frame
) -> void {
    for (const auto& entity_id : frame.removes) {
        state.entities.erase(entity_id);
        state.bindings.erase(entity_id);
        state.orphan_entity_ids.insert(entity_id);
    }
    for (const auto& entity : frame.upserts) {
        state.orphan_entity_ids.erase(entity.id);
        state.entities[entity.id] = entity;
    }
}

static auto replay_ingame_bootstrap_tick(ReplayInGameState& state, uint64_t now_ms) -> void {
    if (state.bootstrap_ready) {
        return;
    }

    if (state.phase == ReplayInGamePhase::Idle) {
        replay_ingame_set_phase(state, ReplayInGamePhase::Preflight, now_ms);
    }

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
    if (meta_game_state) {
        bool bool_value = false;
        if (replay_ingame_read_bool_property(meta_game_state, "bmaploading", bool_value)) {
            map_loading = bool_value;
        }
        if (replay_ingame_read_bool_property(meta_game_state, "bfullyloaded", bool_value)) {
            map_fully_loaded = bool_value;
        }

        std::string current_map{};
        if (replay_read_string_property(meta_game_state, "currentmapname", current_map)) {
            const std::string current_map_token = replay_ingame_normalize_map_token(current_map);
            map_ready = !current_map_token.empty()
                && !state.target_map_name_lower.empty()
                && (current_map_token == state.target_map_name_lower
                    || current_map_token.find(state.target_map_name_lower) != std::string::npos
                    || state.target_map_name_lower.find(current_map_token) != std::string::npos);
        }
    }

    if (map_loading || !map_fully_loaded) {
        state.map_unstable_since_ms = now_ms;
    } else if (state.map_unstable_since_ms == 0) {
        state.map_unstable_since_ms = now_ms;
    }
    bool world_stable = !map_loading && map_fully_loaded;
    if (world_stable) {
        const uint64_t stable_for_ms =
            now_ms > state.map_unstable_since_ms ? (now_ms - state.map_unstable_since_ms) : 0;
        world_stable = stable_for_ms >= 350;
    }

    if (in_challenge
        && state.phase > ReplayInGamePhase::CancelChallenge
        && state.world_reset_sent
        && state.world_reset_sent_ms > 0
        && now_ms > state.world_reset_sent_ms + 1500) {
        replay_ingame_set_phase(state, ReplayInGamePhase::Interrupted, now_ms);
        state.debug_ready_reason = "interrupted_challenge_started";
        replay_ingame_emit_interrupt_event(state, now_ms, "challenge_started_during_replay_bootstrap");
        replay_ingame_log("[replay_playback] interrupted: challenge started during bootstrap");
        replay_ingame_request_ui_release(state, now_ms);
        replay_ingame_reset_runtime_state(state, now_ms, "interrupted");
        return;
    }

    if (in_challenge && scenario_manager && now_ms >= state.next_phase_action_ms) {
        replay_ingame_set_phase(state, ReplayInGamePhase::CancelChallenge, now_ms);
        (void)replay_ingame_invoke_cancel_challenge(scenario_manager);
        state.next_phase_action_ms = now_ms + 300;
    }

    if (in_challenge) {
        state.debug_ready_reason = "waiting_challenge_cancel";
        replay_ingame_emit_status_if_due(state, now_ms, false);
        return;
    }

    if (!state.world_reset_sent && now_ms >= state.next_phase_action_ms) {
        replay_ingame_set_phase(state, ReplayInGamePhase::ClearScenario, now_ms);
        bool issued_reset_call = false;
        if (scenario_manager && in_scenario) {
            issued_reset_call = true;
            (void)replay_ingame_invoke_cancel_challenge(scenario_manager);
        }
        if (meta_game_state) {
            issued_reset_call = true;
            (void)replay_ingame_invoke_clear_scenario(meta_game_state);
        }
        state.world_reset_sent = true;
        state.world_reset_sent_ms = now_ms;
        state.freeplay_play_earliest_ms = std::max<uint64_t>(state.freeplay_play_earliest_ms, now_ms + 1200);
        state.next_phase_action_ms = now_ms + 450;
        replay_ingame_log(
            issued_reset_call ? "[replay_playback] world reset requested"
                              : "[replay_playback] world reset skipped (already clean)"
        );
    }

    if (!map_ready
        && meta_game_state
        && state.world_reset_sent
        && !in_scenario
        && !in_challenge
        && world_stable
        && now_ms > state.world_reset_sent_ms + 500
        && !state.target_map_name.empty()
        && (!state.map_load_sent || (now_ms > state.map_load_sent_ms + 2500))
        && state.map_load_attempts < 3
        && now_ms >= state.next_phase_action_ms) {
        replay_ingame_set_phase(state, ReplayInGamePhase::LoadMap, now_ms);
        if (replay_ingame_invoke_load_map_by_name(
                meta_game_state,
                state.target_map_name,
                state.target_map_scale > 0.0f ? state.target_map_scale : 1.0f
            )) {
            state.map_load_sent = true;
            state.map_load_sent_ms = now_ms;
            state.map_load_attempts += 1;
            state.next_phase_action_ms = now_ms + 2200;
            replay_ingame_log("[replay_playback] map load requested");
        }
    }

    if (!map_ready || !world_stable) {
        replay_ingame_set_phase(state, ReplayInGamePhase::WaitMapReady, now_ms);
        state.debug_ready_reason = !map_ready ? "waiting_map_ready" : "waiting_world_stable";
        replay_ingame_emit_status_if_due(state, now_ms, false);
        return;
    }

    if (state.force_freeplay && scenario_manager) {
        replay_ingame_set_phase(state, ReplayInGamePhase::ForceFreeplay, now_ms);
        if (!state.freeplay_bootstrap_sent) {
            state.freeplay_bootstrap_sent = true;
            replay_ingame_log("[replay_playback] safe bootstrap primed (scenario play skipped)");
        }

        if (!in_scenario && !in_challenge && map_ready && world_stable) {
            state.freeplay_play_sent = true;
        }

        if (!state.freeplay_play_sent
            && state.world_reset_sent
            && now_ms >= state.freeplay_play_earliest_ms
            && !in_scenario
            && !in_challenge
            && now_ms >= state.next_phase_action_ms) {
            state.freeplay_play_attempts += 1;
            state.freeplay_play_sent = true;
            state.next_phase_action_ms = now_ms + 650;
            state.debug_ready_reason = "safe_world_ready";
        }
    }

    if (world_stable
        && (state.next_runtime_refresh_ms == 0 || now_ms >= state.next_runtime_refresh_ms)) {
        replay_ingame_refresh_runtime_refs(state, now_ms);
    }

    bool have_live_bot_refs = false;
    size_t live_bot_ref_count = 0;
    for (const auto& ref : state.runtime_refs) {
        if (!ref.entity.is_bot) {
            continue;
        }
        have_live_bot_refs = true;
        if (state.expected_bot_profiles.empty()
            || state.expected_bot_profiles.find(ref.entity.profile) != state.expected_bot_profiles.end()) {
            live_bot_ref_count += 1;
        }
    }

    if (!state.spawn_sent && in_scenario && !map_loading && map_fully_loaded && !have_live_bot_refs
        && now_ms >= state.next_phase_action_ms && state.spawn_attempts < 3) {
        replay_ingame_set_phase(state, ReplayInGamePhase::SpawnOrBindEntities, now_ms);
        // Do not force SpawnBots here; wait for scenario-managed spawn so we avoid
        // unstable package load paths in stripped production.
        state.spawn_sent = true;
        state.spawn_attempts += 1;
        state.next_phase_action_ms = now_ms + 1500;
        replay_ingame_log("[replay_playback] waiting for scenario-managed bot spawn");
    }

    const bool have_entities = !state.runtime_refs.empty();
    const bool map_condition_ok = map_ready;
    const bool strict_policy = !replay_ingame_ready_policy_is_best_effort(state);
    const bool expected_bot_count_satisfied =
        state.expected_bot_count <= 0
        || static_cast<int32_t>(live_bot_ref_count) >= state.expected_bot_count
        || (!strict_policy && live_bot_ref_count > 0);
    const bool runtime_ready_best_effort = !strict_policy && have_entities && map_condition_ok && !map_loading && map_fully_loaded;
    const bool ready = (in_scenario || runtime_ready_best_effort)
        && map_condition_ok
        && !map_loading
        && map_fully_loaded
        && have_entities
        && expected_bot_count_satisfied;
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
    } else if (state.debug_ready_reason.empty()) {
        state.debug_ready_reason = "waiting";
    }
    state.debug_last_update_ms = now_ms;

    if (ready || timed_out) {
        if (ready) {
            state.bootstrap_ready = true;
            replay_ingame_set_phase(state, ReplayInGamePhase::Ready, now_ms);
            if (!state.ready_event_emitted) {
                replay_ingame_emit_ready_event(state, now_ms, true, "ready");
                state.ready_event_emitted = true;
            }
            replay_ingame_set_phase(state, ReplayInGamePhase::Playing, now_ms);
            state.playback_started_ms = now_ms;
            state.playback_frame_cursor = 0;
            state.playback_first_frame_ts_ms = state.loaded_frames.empty() ? 0 : state.loaded_frames.front().ts_ms;
            replay_ingame_log("[replay_playback] bootstrap ready");
        } else if (replay_ingame_ready_policy_is_best_effort(state)) {
            state.bootstrap_ready = true;
            replay_ingame_set_phase(state, ReplayInGamePhase::Ready, now_ms);
            if (!state.ready_event_emitted) {
                replay_ingame_emit_ready_event(state, now_ms, false, "timeout");
                state.ready_event_emitted = true;
            }
            replay_ingame_set_phase(state, ReplayInGamePhase::Playing, now_ms);
            state.playback_started_ms = now_ms;
            state.playback_frame_cursor = 0;
            state.playback_first_frame_ts_ms = state.loaded_frames.empty() ? 0 : state.loaded_frames.front().ts_ms;
            replay_ingame_log("[replay_playback] bootstrap timeout; continuing with best effort");
        } else {
            replay_ingame_set_phase(state, ReplayInGamePhase::Failed, now_ms);
            replay_ingame_emit_failed_event(state, now_ms, "timeout_strict");
            replay_ingame_log("[replay_playback] bootstrap timeout; strict policy failed");
            replay_ingame_request_ui_release(state, now_ms);
            replay_ingame_reset_runtime_state(state, now_ms, "failed");
            replay_ingame_emit_status_if_due(state, now_ms, true);
            return;
        }
    }

    replay_ingame_emit_status_if_due(state, now_ms, false);
}

static auto replay_ingame_playback_is_active() -> bool {
    const auto& state = replay_ingame_state();
    return state.active || state.load_in_progress;
}

static auto replay_ingame_playback_handle_command(const BridgeCommand& command, uint64_t now_ms) -> void {
    auto& state = replay_ingame_state();

    switch (command.kind) {
    case BridgeCommandKind::ReplayLoadBegin:
        replay_ingame_request_ui_release(state, now_ms);
        replay_ingame_reset_runtime_state(state, now_ms, "loading");
        replay_ingame_clear_loaded_replay(state);
        state.loaded_session_id = command.session_id;
        state.load_in_progress = true;
        state.load_expected_chunks = command.total_chunks > 0 ? command.total_chunks : 0;
        state.load_expected_frames = command.total_frames > 0 ? command.total_frames : 0;
        state.debug_last_command = "load_begin";
        state.debug_last_command_ms = now_ms;
        replay_ingame_log("[replay_playback] load begin received");
        break;
    case BridgeCommandKind::ReplayLoadChunk: {
        state.debug_last_command = "load_chunk";
        state.debug_last_command_ms = now_ms;
        if (!state.load_in_progress
            || state.loaded_session_id.empty()
            || command.session_id.empty()
            || state.loaded_session_id != command.session_id
            || command.chunk_index != state.next_load_chunk_index
            || command.payload.empty()) {
            break;
        }
        std::vector<ReplayPlaybackFrame> decoded_frames{};
        if (!replay_ingame_decode_chunk_payload(command.payload, decoded_frames)) {
            replay_ingame_log("[replay_playback] load chunk decode failed");
            break;
        }
        for (auto& frame : decoded_frames) {
            state.loaded_frames.emplace_back(std::move(frame));
        }
        state.load_received_chunks += 1;
        state.next_load_chunk_index += 1;
        break;
    }
    case BridgeCommandKind::ReplayLoadEnd:
        state.debug_last_command = "load_end";
        state.debug_last_command_ms = now_ms;
        if (state.load_in_progress
            && !state.loaded_session_id.empty()
            && state.loaded_session_id == command.session_id
            && !state.loaded_frames.empty()
            && (state.load_expected_chunks <= 0 || state.load_received_chunks == state.load_expected_chunks)) {
            std::sort(
                state.loaded_frames.begin(),
                state.loaded_frames.end(),
                [](const ReplayPlaybackFrame& lhs, const ReplayPlaybackFrame& rhs) {
                    if (lhs.ts_ms != rhs.ts_ms) {
                        return lhs.ts_ms < rhs.ts_ms;
                    }
                    return lhs.seq < rhs.seq;
                }
            );
            state.loaded_ready = true;
            state.load_in_progress = false;
            state.playback_first_frame_ts_ms = state.loaded_frames.front().ts_ms;
            replay_ingame_log("[replay_playback] replay frames loaded");
        }
        break;
    case BridgeCommandKind::ReplayPlayStart:
        if (state.active && !state.session_id.empty() && state.session_id == command.session_id) {
            state.debug_last_command = "play_start_duplicate_ignored";
            state.debug_last_command_ms = now_ms;
            replay_ingame_emit_status_if_due(state, now_ms, true);
            replay_ingame_log("[replay_playback] duplicate start ignored (same session)");
            break;
        }
        if (state.active || state.load_in_progress || state.ui_unlock_pending) {
            state.debug_last_command = "play_start_busy_rejected";
            state.debug_last_command_ms = now_ms;
            replay_ingame_set_phase(state, ReplayInGamePhase::Failed, now_ms);
            replay_ingame_emit_failed_event(state, now_ms, "replay_busy");
            replay_ingame_emit_status_if_due(state, now_ms, true);
            replay_ingame_log("[replay_playback] play start rejected: replay busy");
            break;
        }
        if (!state.loaded_ready || state.loaded_session_id.empty() || state.loaded_session_id != command.session_id) {
            state.debug_last_command = "play_start_missing_load";
            state.debug_last_command_ms = now_ms;
            replay_ingame_set_phase(state, ReplayInGamePhase::Failed, now_ms);
            replay_ingame_emit_failed_event(state, now_ms, "missing_loaded_replay");
            replay_ingame_log("[replay_playback] play start rejected: missing loaded replay");
            break;
        }
        replay_ingame_request_ui_release(state, now_ms);
        replay_ingame_reset_runtime_state(state, now_ms, "starting");
        state.ui_unlock_pending = false;
        state.ui_unlock_deadline_ms = 0;
        state.input_lock_applied = false;
        state.active = true;
        state.session_id = command.session_id;
        state.hide_ui = command.hide_ui != 0;
        state.force_freeplay = command.force_freeplay != 0;
        state.target_map_name = command.map_name;
        state.target_map_name_lower = replay_ingame_normalize_map_token(command.map_name);
        state.target_map_scale = (std::isfinite(command.map_scale) && command.map_scale > 0.0f) ? command.map_scale : 1.0f;
        state.bootstrap_started_ms = now_ms;
        state.bootstrap_timeout_ms = command.bootstrap_timeout_ms > 0
            ? static_cast<uint64_t>(command.bootstrap_timeout_ms)
            : static_cast<uint64_t>(12000);
        state.playback_speed =
            std::isfinite(command.playback_speed) && command.playback_speed > 0.05f
            ? std::min<float>(command.playback_speed, 4.0f)
            : 1.0f;
        state.freeplay_play_earliest_ms = now_ms + 900;
        state.ready_policy = command.ready_policy == "strict" ? "strict" : "best_effort";
        state.status_interval_ms = command.status_interval_ms > 25 ? command.status_interval_ms : 250;
        state.expected_bot_count = command.expected_bot_count;
        for (const auto& profile : command.expected_bot_profiles) {
            if (!profile.empty()) {
                state.expected_bot_profiles.insert(profile);
            }
        }
        state.phase = ReplayInGamePhase::Preflight;
        state.phase_entered_ms = now_ms;
        state.next_phase_action_ms = now_ms;
        state.map_unstable_since_ms = now_ms;
        state.next_status_emit_ms = 0;
        state.next_ui_refresh_ms = 0;
        state.debug_last_command = "play_start";
        state.debug_last_command_ms = now_ms;
        replay_ingame_update_debug_phase(state, replay_ingame_phase_to_cstr(state.phase), now_ms);
        if (!state.started_event_emitted) {
            replay_ingame_emit_started_event(state, now_ms);
            state.started_event_emitted = true;
        }
        replay_ingame_emit_status_if_due(state, now_ms, true);
        replay_ingame_log("[replay_playback] start command received");
        replay_ingame_log("[replay_playback] bootstrap mode=deterministic");
        break;
    case BridgeCommandKind::ReplayPlayStop:
        replay_ingame_request_ui_release(state, now_ms);
        replay_ingame_reset_runtime_state(state, now_ms, "idle");
        state.debug_last_command = "play_stop";
        state.debug_last_command_ms = now_ms;
        replay_ingame_log("[replay_playback] stop command received");
        break;
    case BridgeCommandKind::ReplayEntityMeta: {
        if (command.entity.id.empty()) {
            break;
        }
        state.debug_last_command = "entity_meta";
        state.debug_last_command_ms = now_ms;
        state.orphan_entity_ids.erase(command.entity.id);
        auto& entity = state.entities[command.entity.id];
        entity.id = command.entity.id;
        entity.profile = command.entity.profile;
        entity.is_player = command.entity.is_player;
        entity.is_bot = command.entity.is_bot;
        if (!entity.is_player && !entity.is_bot && replay_ingame_normalize_ascii_string(entity.profile) == "player") {
            entity.is_player = true;
        }
        break;
    }
    case BridgeCommandKind::ReplayEntityPose: {
        if (command.entity.id.empty()) {
            break;
        }
        if (state.orphan_entity_ids.find(command.entity.id) != state.orphan_entity_ids.end()
            && state.entities.find(command.entity.id) == state.entities.end()) {
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
            state.orphan_entity_ids.insert(command.entity_id);
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
        if (state.ui_unlock_pending) {
            replay_ingame_apply_ui_mode(state, false, now_ms);
            if (!state.input_lock_applied || (state.ui_unlock_deadline_ms > 0 && now_ms >= state.ui_unlock_deadline_ms)) {
                state.ui_unlock_pending = false;
                state.ui_unlock_deadline_ms = 0;
            }
        }
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
        replay_ingame_set_phase(state, ReplayInGamePhase::Interrupted, now_ms);
        replay_ingame_emit_interrupt_event(state, now_ms, "challenge_started_during_replay");
        replay_ingame_log("[replay_playback] interrupted: challenge started during replay");
        replay_ingame_request_ui_release(state, now_ms);
        replay_ingame_reset_runtime_state(state, now_ms, "interrupted");
        return;
    }
    state.debug_in_challenge = false;

    if (state.hide_ui) {
        replay_ingame_apply_ui_mode(state, true, now_ms);
    }

    if (state.next_runtime_refresh_ms == 0 || now_ms >= state.next_runtime_refresh_ms) {
        replay_ingame_refresh_runtime_refs(state, now_ms);
    }

    replay_ingame_set_phase(state, ReplayInGamePhase::Playing, now_ms);

    if (state.playback_started_ms == 0) {
        state.playback_started_ms = now_ms;
    }
    const uint64_t elapsed_ms = now_ms > state.playback_started_ms ? (now_ms - state.playback_started_ms) : 0;
    const double scaled_elapsed_ms = static_cast<double>(elapsed_ms) * static_cast<double>(state.playback_speed);
    const uint64_t playback_target_ts =
        state.playback_first_frame_ts_ms
        + static_cast<uint64_t>(std::llround(std::max(0.0, scaled_elapsed_ms)));

    while (state.playback_frame_cursor < state.loaded_frames.size()
        && state.loaded_frames[state.playback_frame_cursor].ts_ms <= playback_target_ts) {
        replay_ingame_apply_loaded_frame(state, state.loaded_frames[state.playback_frame_cursor]);
        state.playback_frame_cursor += 1;
    }

    if (state.playback_frame_cursor >= state.loaded_frames.size() && !state.loaded_frames.empty()) {
        replay_ingame_emit_complete_event(state, now_ms);
        replay_ingame_log("[replay_playback] completed");
        replay_ingame_request_ui_release(state, now_ms);
        replay_ingame_reset_runtime_state(state, now_ms, "idle");
        return;
    }

    for (const auto& kv : state.entities) {
        const auto& entity = kv.second;
        const bool is_player_like =
            entity.is_player || replay_ingame_normalize_ascii_string(entity.profile) == "player";
        if (!is_player_like) {
            continue;
        }
        auto* actor = replay_ingame_find_binding_actor(state, entity, now_ms);
        if (!actor) {
            continue;
        }
        (void)replay_ingame_invoke_set_actor_location(actor, entity.location);
        (void)replay_ingame_invoke_set_actor_rotation(actor, entity.rotation);
    }

    bool have_runtime_bots = false;
    for (const auto& ref : state.runtime_refs) {
        if (ref.entity.is_bot) {
            have_runtime_bots = true;
            break;
        }
    }
    for (const auto& kv : state.entities) {
        const auto& entity = kv.second;
        const bool is_player_like =
            entity.is_player || replay_ingame_normalize_ascii_string(entity.profile) == "player";
        if (is_player_like) {
            continue;
        }
        if (state.orphan_entity_ids.find(entity.id) != state.orphan_entity_ids.end()) {
            continue;
        }
        if (entity.is_bot && !have_runtime_bots) {
            continue;
        }
        auto* actor = replay_ingame_find_binding_actor(state, entity, now_ms);
        if (!actor) {
            continue;
        }
        (void)replay_ingame_invoke_set_actor_location(actor, entity.location);
        (void)replay_ingame_invoke_set_actor_rotation(actor, entity.rotation);
    }

    replay_ingame_emit_status_if_due(state, now_ms, false);
}

} // namespace kmod_replay
