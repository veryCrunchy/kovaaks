namespace kmod_replay {

static auto bridge_command_sanitize_token(std::string value) -> std::string {
    std::string out;
    out.reserve(value.size());
    for (char ch : value) {
        const unsigned char uch = static_cast<unsigned char>(ch);
        if (std::isalnum(uch) || ch == '_' || ch == '-' || ch == ':' || ch == '.') {
            out.push_back(ch);
        }
    }
    if (out.empty()) {
        return "unknown";
    }
    return out;
}

static auto sanitize_state_request_reason(std::string value) -> std::string {
    return bridge_command_sanitize_token(value);
}

static auto bridge_command_find_value_span(
    const std::string& json,
    const char* key,
    size_t& out_begin,
    size_t& out_end
) -> bool {
    out_begin = 0;
    out_end = 0;
    if (!key || !*key) {
        return false;
    }

    std::string needle{"\""};
    needle += key;
    needle += "\"";

    size_t p = json.find(needle);
    if (p == std::string::npos) {
        return false;
    }
    p = json.find(':', p + needle.size());
    if (p == std::string::npos) {
        return false;
    }

    size_t begin = p + 1;
    while (begin < json.size() && std::isspace(static_cast<unsigned char>(json[begin]))) {
        ++begin;
    }
    if (begin >= json.size()) {
        return false;
    }

    if (json[begin] == '"') {
        size_t end = begin + 1;
        bool escaped = false;
        for (; end < json.size(); ++end) {
            const char ch = json[end];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch == '\\') {
                escaped = true;
                continue;
            }
            if (ch == '"') {
                out_begin = begin;
                out_end = end + 1;
                return true;
            }
        }
        return false;
    }

    size_t end = begin;
    for (; end < json.size(); ++end) {
        const char ch = json[end];
        if (ch == ',' || ch == '}' || ch == ']') {
            break;
        }
    }

    while (end > begin && std::isspace(static_cast<unsigned char>(json[end - 1]))) {
        --end;
    }
    if (end <= begin) {
        return false;
    }

    out_begin = begin;
    out_end = end;
    return true;
}

static auto bridge_command_extract_json_string(
    const std::string& json,
    const char* key,
    std::string& out
) -> bool {
    out.clear();
    if (!key || !*key) {
        return false;
    }

    size_t begin = 0;
    size_t end = 0;
    if (!bridge_command_find_value_span(json, key, begin, end)) {
        return false;
    }
    if (begin >= end || json[begin] != '"' || json[end - 1] != '"') {
        return false;
    }

    std::string value{};
    bool escaped = false;
    for (size_t p = begin + 1; p + 1 < end; ++p) {
        const char ch = json[p];
        if (escaped) {
            value.push_back(ch);
            escaped = false;
            continue;
        }
        if (ch == '\\') {
            escaped = true;
            continue;
        }
        value.push_back(ch);
    }

    out = value;
    return true;
}

static auto bridge_command_extract_json_number(
    const std::string& json,
    const char* key,
    double& out
) -> bool {
    out = 0.0;
    size_t begin = 0;
    size_t end = 0;
    if (!bridge_command_find_value_span(json, key, begin, end)) {
        return false;
    }
    if (begin >= end) {
        return false;
    }

    std::string token = json.substr(begin, end - begin);
    if (!token.empty() && token.front() == '"' && token.back() == '"') {
        token = token.substr(1, token.size() - 2);
    }
    if (token.empty()) {
        return false;
    }

    char* parse_end = nullptr;
    const double value = std::strtod(token.c_str(), &parse_end);
    if (!parse_end || *parse_end != '\0') {
        return false;
    }
    if (!std::isfinite(value)) {
        return false;
    }
    out = value;
    return true;
}

static auto bridge_command_extract_json_i32(
    const std::string& json,
    const char* key,
    int32_t& out
) -> bool {
    out = 0;
    double value = 0.0;
    if (!bridge_command_extract_json_number(json, key, value)) {
        return false;
    }
    out = static_cast<int32_t>(std::llround(value));
    return true;
}

static auto bridge_command_extract_json_boolish(
    const std::string& json,
    const char* key,
    bool& out
) -> bool {
    out = false;

    int32_t value_i32 = 0;
    if (bridge_command_extract_json_i32(json, key, value_i32)) {
        out = value_i32 != 0;
        return true;
    }

    std::string value_str{};
    if (!bridge_command_extract_json_string(json, key, value_str)) {
        return false;
    }
    for (auto& ch : value_str) {
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
    if (value_str == "1" || value_str == "true") {
        out = true;
        return true;
    }
    if (value_str == "0" || value_str == "false") {
        out = false;
        return true;
    }
    return false;
}

static auto bridge_command_extract_json_string_array(
    const std::string& json,
    const char* key,
    std::vector<std::string>& out
) -> bool {
    out.clear();
    size_t begin = 0;
    size_t end = 0;
    if (!bridge_command_find_value_span(json, key, begin, end) || begin >= end) {
        return false;
    }

    const std::string token = json.substr(begin, end - begin);
    if (token.size() < 2 || token.front() != '[' || token.back() != ']') {
        return false;
    }

    bool in_string = false;
    bool escaped = false;
    std::string current{};
    for (size_t i = 1; i + 1 < token.size(); ++i) {
        const char ch = token[i];
        if (!in_string) {
            if (ch == '"') {
                in_string = true;
                current.clear();
            }
            continue;
        }

        if (escaped) {
            current.push_back(ch);
            escaped = false;
            continue;
        }
        if (ch == '\\') {
            escaped = true;
            continue;
        }
        if (ch == '"') {
            if (!current.empty()) {
                out.emplace_back(current);
            } else {
                out.emplace_back(std::string{});
            }
            in_string = false;
            if (out.size() >= 64) {
                break;
            }
            continue;
        }
        current.push_back(ch);
    }

    return !out.empty();
}

static auto poll_bridge_command(BridgeCommand& out_command) -> bool {
    out_command = BridgeCommand{};

    std::string json_line{};
    if (!kovaaks::RustBridge::poll_command(json_line)) {
        return false;
    }
    if (json_line.empty()) {
        return false;
    }

    out_command.raw = json_line;

    std::string cmd{};
    if (!bridge_command_extract_json_string(json_line, "cmd", cmd)) {
        out_command.kind = BridgeCommandKind::Unknown;
        return true;
    }

    if (cmd == "state_snapshot_request") {
        out_command.kind = BridgeCommandKind::StateSnapshotRequest;
        std::string reason{};
        if (bridge_command_extract_json_string(json_line, "reason", reason)) {
            out_command.reason = bridge_command_sanitize_token(reason);
        } else {
            out_command.reason = "unknown";
        }
        return true;
    }

    if (cmd == "replay_play_start") {
        out_command.kind = BridgeCommandKind::ReplayPlayStart;
        std::string session_id{};
        if (bridge_command_extract_json_string(json_line, "session_id", session_id)) {
            out_command.session_id = bridge_command_sanitize_token(session_id);
        }

        (void)bridge_command_extract_json_string(json_line, "map_name", out_command.map_name);
        double map_scale = 0.0;
        if (bridge_command_extract_json_number(json_line, "map_scale", map_scale) && std::isfinite(map_scale)) {
            out_command.map_scale = static_cast<float>(map_scale);
        }
        double playback_speed = 0.0;
        if (bridge_command_extract_json_number(json_line, "speed", playback_speed) && std::isfinite(playback_speed)) {
            out_command.playback_speed = static_cast<float>(playback_speed);
        }

        bool boolish = false;
        if (bridge_command_extract_json_boolish(json_line, "force_freeplay", boolish)) {
            out_command.force_freeplay = boolish ? 1 : 0;
        }
        if (bridge_command_extract_json_boolish(json_line, "hide_ui", boolish)) {
            out_command.hide_ui = boolish ? 1 : 0;
        }
        int32_t timeout_ms = 0;
        if (bridge_command_extract_json_i32(json_line, "bootstrap_timeout_ms", timeout_ms) && timeout_ms > 0) {
            out_command.bootstrap_timeout_ms = timeout_ms;
        }
        std::string ready_policy{};
        if (bridge_command_extract_json_string(json_line, "ready_policy", ready_policy)) {
            for (auto& ch : ready_policy) {
                ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
            }
            if (ready_policy == "strict" || ready_policy == "best_effort") {
                out_command.ready_policy = ready_policy;
            }
        }
        int32_t status_interval_ms = 0;
        if (bridge_command_extract_json_i32(json_line, "status_interval_ms", status_interval_ms)) {
            if (status_interval_ms < 50) {
                status_interval_ms = 50;
            } else if (status_interval_ms > 5000) {
                status_interval_ms = 5000;
            }
            out_command.status_interval_ms = status_interval_ms;
        }
        int32_t expected_bot_count = -1;
        if (bridge_command_extract_json_i32(json_line, "expected_bot_count", expected_bot_count) && expected_bot_count >= 0) {
            out_command.expected_bot_count = expected_bot_count;
        }
        std::vector<std::string> expected_profiles{};
        if (bridge_command_extract_json_string_array(json_line, "expected_bot_profiles", expected_profiles)) {
            for (auto& profile : expected_profiles) {
                if (profile.size() > 128) {
                    profile.resize(128);
                }
                out_command.expected_bot_profiles.emplace_back(std::move(profile));
            }
        }
        return true;
    }

    if (cmd == "replay_play_stop") {
        out_command.kind = BridgeCommandKind::ReplayPlayStop;
        return true;
    }

    if (cmd == "replay_load_begin") {
        out_command.kind = BridgeCommandKind::ReplayLoadBegin;
        std::string session_id{};
        if (bridge_command_extract_json_string(json_line, "session_id", session_id)) {
            out_command.session_id = bridge_command_sanitize_token(session_id);
        }
        (void)bridge_command_extract_json_i32(json_line, "total_chunks", out_command.total_chunks);
        (void)bridge_command_extract_json_i32(json_line, "total_frames", out_command.total_frames);
        return true;
    }

    if (cmd == "replay_load_chunk") {
        out_command.kind = BridgeCommandKind::ReplayLoadChunk;
        std::string session_id{};
        if (bridge_command_extract_json_string(json_line, "session_id", session_id)) {
            out_command.session_id = bridge_command_sanitize_token(session_id);
        }
        (void)bridge_command_extract_json_i32(json_line, "chunk_index", out_command.chunk_index);
        (void)bridge_command_extract_json_i32(json_line, "total_chunks", out_command.total_chunks);
        (void)bridge_command_extract_json_string(json_line, "payload", out_command.payload);
        return true;
    }

    if (cmd == "replay_load_end") {
        out_command.kind = BridgeCommandKind::ReplayLoadEnd;
        std::string session_id{};
        if (bridge_command_extract_json_string(json_line, "session_id", session_id)) {
            out_command.session_id = bridge_command_sanitize_token(session_id);
        }
        (void)bridge_command_extract_json_i32(json_line, "total_chunks", out_command.total_chunks);
        (void)bridge_command_extract_json_i32(json_line, "total_frames", out_command.total_frames);
        return true;
    }

    if (cmd == "replay_entity_meta") {
        out_command.kind = BridgeCommandKind::ReplayEntityMeta;
        std::string id{};
        if (!bridge_command_extract_json_string(json_line, "id", id)) {
            out_command.kind = BridgeCommandKind::Unknown;
            return true;
        }
        out_command.entity.id = id;
        out_command.entity_id = id;
        (void)bridge_command_extract_json_string(json_line, "profile", out_command.entity.profile);

        int32_t is_player = 0;
        if (bridge_command_extract_json_i32(json_line, "is_player", is_player)) {
            out_command.entity.is_player = is_player != 0;
        }
        int32_t is_bot = 0;
        if (bridge_command_extract_json_i32(json_line, "is_bot", is_bot)) {
            out_command.entity.is_bot = is_bot != 0;
        }
        return true;
    }

    if (cmd == "replay_entity_pose") {
        out_command.kind = BridgeCommandKind::ReplayEntityPose;
        std::string id{};
        if (!bridge_command_extract_json_string(json_line, "id", id)) {
            out_command.kind = BridgeCommandKind::Unknown;
            return true;
        }
        out_command.entity.id = id;
        out_command.entity_id = id;

        double value = 0.0;
        if (bridge_command_extract_json_number(json_line, "x", value)) out_command.entity.location.x = static_cast<float>(value);
        if (bridge_command_extract_json_number(json_line, "y", value)) out_command.entity.location.y = static_cast<float>(value);
        if (bridge_command_extract_json_number(json_line, "z", value)) out_command.entity.location.z = static_cast<float>(value);
        if (bridge_command_extract_json_number(json_line, "pitch", value)) out_command.entity.rotation.pitch = static_cast<float>(value);
        if (bridge_command_extract_json_number(json_line, "yaw", value)) out_command.entity.rotation.yaw = static_cast<float>(value);
        if (bridge_command_extract_json_number(json_line, "roll", value)) out_command.entity.rotation.roll = static_cast<float>(value);
        if (bridge_command_extract_json_number(json_line, "vx", value)) out_command.entity.velocity.x = static_cast<float>(value);
        if (bridge_command_extract_json_number(json_line, "vy", value)) out_command.entity.velocity.y = static_cast<float>(value);
        if (bridge_command_extract_json_number(json_line, "vz", value)) out_command.entity.velocity.z = static_cast<float>(value);
        return true;
    }

    if (cmd == "replay_remove_entity") {
        out_command.kind = BridgeCommandKind::ReplayRemoveEntity;
        std::string id{};
        if (bridge_command_extract_json_string(json_line, "id", id)) {
            out_command.entity_id = id;
        } else {
            out_command.kind = BridgeCommandKind::Unknown;
        }
        return true;
    }

    out_command.kind = BridgeCommandKind::Unknown;
    return true;
}

} // namespace kmod_replay
