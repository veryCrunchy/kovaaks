    struct BridgeLinkedIdentity {
        std::string provider{};
        std::string provider_account_id{};
        std::string username{};
        std::string display_name{};
        std::string avatar_url{};
    };

    struct BridgeCurrentUserProfile {
        std::string kovaaks_user_id{};
        std::string external_id{};
        std::string username{};
        std::string display_name{};
        std::string avatar_url{};
        std::string steam_id{};
        std::string steam_name{};
        std::vector<BridgeLinkedIdentity> linked_accounts{};
    };

    struct BridgeSocialFriendProfile {
        std::string platform{};
        std::string username{};
        std::string display_name{};
        std::string avatar_url{};
        std::string steam_id{};
        std::string kovaaks_user_id{};
    };

    struct BridgeFriendScoreEntry {
        std::string steam_id{};
        std::string display_name{};
        int32_t score{0};
        int32_t rank{0};
        bool kovaaks_plus_active{false};
    };

    struct PendingFriendScoresRequest {
        std::string scenario_name{};
        uint64_t leaderboard_id{0};
        uint64_t requested_at_ms{0};
    };

    struct PersistedFriendScoresCacheEntry {
        uint64_t leaderboard_id{0};
        int32_t response_code{200};
        uint64_t saved_at_ms{0};
        std::string body_json{};
    };

    static bool bridge_linked_identity_equals(
        const BridgeLinkedIdentity& lhs,
        const BridgeLinkedIdentity& rhs
    ) {
        return lhs.provider == rhs.provider
            && lhs.provider_account_id == rhs.provider_account_id
            && lhs.username == rhs.username
            && lhs.display_name == rhs.display_name
            && lhs.avatar_url == rhs.avatar_url;
    }

    static bool bridge_current_user_profile_equals(
        const BridgeCurrentUserProfile& lhs,
        const BridgeCurrentUserProfile& rhs
    ) {
        if (lhs.kovaaks_user_id != rhs.kovaaks_user_id
            || lhs.external_id != rhs.external_id
            || lhs.username != rhs.username
            || lhs.display_name != rhs.display_name
            || lhs.avatar_url != rhs.avatar_url
            || lhs.steam_id != rhs.steam_id
            || lhs.steam_name != rhs.steam_name
            || lhs.linked_accounts.size() != rhs.linked_accounts.size()) {
            return false;
        }

        for (size_t index = 0; index < lhs.linked_accounts.size(); ++index) {
            if (!bridge_linked_identity_equals(lhs.linked_accounts[index], rhs.linked_accounts[index])) {
                return false;
            }
        }
        return true;
    }

    static bool bridge_friend_score_entry_equals(
        const BridgeFriendScoreEntry& lhs,
        const BridgeFriendScoreEntry& rhs
    ) {
        return lhs.steam_id == rhs.steam_id
            && lhs.display_name == rhs.display_name
            && lhs.score == rhs.score
            && lhs.rank == rhs.rank
            && lhs.kovaaks_plus_active == rhs.kovaaks_plus_active;
    }

    static bool bridge_friend_score_entries_equal(
        const std::vector<BridgeFriendScoreEntry>& lhs,
        const std::vector<BridgeFriendScoreEntry>& rhs
    ) {
        if (lhs.size() != rhs.size()) {
            return false;
        }
        for (size_t index = 0; index < lhs.size(); ++index) {
            if (!bridge_friend_score_entry_equals(lhs[index], rhs[index])) {
                return false;
            }
        }
        return true;
    }

    RC::Unreal::UClass* uworks_core_user_class_{nullptr};
    RC::Unreal::UClass* uworks_core_friends_class_{nullptr};
    RC::Unreal::UClass* leaderboards_manager_class_{nullptr};
    RC::Unreal::UClass* leaderboards_widget_class_{nullptr};
    RC::Unreal::UClass* pause_menu_widget_class_{nullptr};
    RC::Unreal::UClass* steam_network_model_class_{nullptr};
    RC::Unreal::UObject* uworks_core_user_{nullptr};
    RC::Unreal::UObject* uworks_core_friends_{nullptr};
    RC::Unreal::UObject* leaderboards_manager_{nullptr};
    RC::Unreal::UObject* steam_network_model_{nullptr};
    RC::Unreal::UObject* active_leaderboards_widget_{nullptr};
    RC::Unreal::UFunction* uworks_b_logged_on_fn_{nullptr};
    RC::Unreal::UFunction* uworks_get_steam_id_fn_{nullptr};
    RC::Unreal::UFunction* uworks_get_persona_name_fn_{nullptr};
    RC::Unreal::UFunction* uworks_get_friend_count_fn_{nullptr};
    RC::Unreal::UFunction* uworks_get_friend_by_index_fn_{nullptr};
    RC::Unreal::UFunction* uworks_get_friend_persona_name_fn_{nullptr};
    RC::Unreal::UFunction* leaderboards_get_leaderboard_id_fn_{nullptr};
    RC::Unreal::UFunction* kvk_network_request_download_top_adjacent_fn_{nullptr};
    RC::Unreal::UFunction* steam_network_model_get_auth_token_value_or_fn_{nullptr};
    RC::Unreal::UFunction* send_steam_auth_token_request_fn_{nullptr};
    RC::Unreal::UFunction* get_game_instance_subsystem_fn_{nullptr};
    uint64_t next_user_bridge_refresh_ms_{0};
    uint64_t next_friend_scores_refresh_ms_{0};
    uint64_t next_auth_token_request_ms_{0};
    uint64_t next_active_leaderboards_widget_resolve_ms_{0};
    uint64_t next_pending_friend_request_prune_ms_{0};
    uint64_t next_user_management_debug_log_ms_{0};
    uint64_t last_friend_scores_response_ms_{0};
    std::string last_user_management_debug_message_{};
    std::string last_emitted_user_snapshot_{};
    std::string last_emitted_user_source_{};
    std::string last_emitted_friends_snapshot_{};
    std::string last_sa_http_auth_token_{};
    std::string last_friend_scores_scenario_{};
    std::string last_friend_scores_source_{};
    std::string last_emitted_friend_scores_snapshot_{};
    uint64_t last_friend_scores_leaderboard_id_{0};
    BridgeCurrentUserProfile last_emitted_user_profile_{};
    std::vector<BridgeFriendScoreEntry> last_friend_scores_entries_{};
    std::unordered_map<RC::Unreal::UObject*, PendingFriendScoresRequest> pending_friend_scores_requests_{};
    std::unordered_map<std::string, PersistedFriendScoresCacheEntry> persisted_friend_scores_cache_{};
    std::unordered_map<RC::Unreal::UStruct*, std::unordered_map<std::string, RC::Unreal::FProperty*>> property_lookup_cache_{};
    bool has_last_emitted_user_profile_{false};

    bool should_log_user_management(uint64_t now) {
        if (now < next_user_management_debug_log_ms_) {
            return false;
        }
        next_user_management_debug_log_ms_ = now + 10000;
        return true;
    }

    void log_user_management(uint64_t now, const char* message) {
        if (!message || !*message) {
            return;
        }
        const std::string message_text(message);
        const bool same_message = message_text == last_user_management_debug_message_;
        if (same_message && !should_log_user_management(now)) {
            return;
        }
        if (!same_message) {
            last_user_management_debug_message_ = message_text;
            next_user_management_debug_log_ms_ = now + 10000;
        }
        char buffer[256]{};
        std::snprintf(buffer, sizeof(buffer), "[user_mgmt] %s", message);
        runtime_log_line(buffer);
    }

    void prune_pending_friend_scores_requests(uint64_t now) {
        if (now < next_pending_friend_request_prune_ms_) {
            return;
        }
        next_pending_friend_request_prune_ms_ = now + 30000;

        constexpr uint64_t kPendingRequestTimeoutMs = 120000;
        for (auto it = pending_friend_scores_requests_.begin(); it != pending_friend_scores_requests_.end();) {
            const bool invalid_request_object = !it->first || !is_likely_valid_object_ptr(it->first);
            const bool expired_request = it->second.requested_at_ms > 0
                && now > it->second.requested_at_ms
                && (now - it->second.requested_at_ms) >= kPendingRequestTimeoutMs;
            if (invalid_request_object || expired_request) {
                it = pending_friend_scores_requests_.erase(it);
            } else {
                ++it;
            }
        }
    }

    static uint64_t stable_string_hash64(std::string_view input) {
        uint64_t hash = 1469598103934665603ull;
        for (unsigned char ch : input) {
            hash ^= static_cast<uint64_t>(ch);
            hash *= 1099511628211ull;
        }
        return hash;
    }

    static auto friend_scores_cache_file_path(const std::string& scenario_name) -> std::filesystem::path {
        const uint64_t hash = stable_string_hash64(scenario_name);
        std::array<char, 64> file_name{};
        std::snprintf(
            file_name.data(),
            file_name.size(),
            "friend_scores_%016llx.cache",
            static_cast<unsigned long long>(hash)
        );
        return std::filesystem::path(game_bin_dir())
            / L"aimmod_cache"
            / L"friend_scores"
            / std::filesystem::path(file_name.data());
    }

    static auto build_friend_scores_event_payload(
        const char* source,
        const std::string& scenario_name,
        uint64_t leaderboard_id,
        int32_t response_code,
        const std::string& body_json
    ) -> std::string {
        if (scenario_name.empty() || body_json.empty()) {
            return {};
        }

        std::string payload = "{\"ev\":\"kovaaks_friend_scores_snapshot\",\"source\":\"";
        payload += escape_json_ascii(source ? source : "unknown");
        payload += "\",\"scenario_name\":\"";
        payload += escape_json_ascii(scenario_name);
        payload += "\",\"leaderboard_id\":";
        payload += std::to_string(leaderboard_id);
        payload += ",\"response_code\":";
        payload += std::to_string(response_code);
        payload += ",\"body\":\"";
        payload += escape_json_ascii(body_json);
        payload += "\"}";
        return payload;
    }

    static void append_friend_score_entry_json(std::string& body_json, const BridgeFriendScoreEntry& entry) {
        body_json += "{\"steam_id\":\"";
        body_json += escape_json_ascii(entry.steam_id);
        body_json += "\",\"steam_account_name\":\"";
        body_json += escape_json_ascii(entry.display_name);
        body_json += "\",\"score\":";
        body_json += std::to_string(entry.score);
        body_json += ",\"rank\":";
        body_json += std::to_string(entry.rank);
        body_json += ",\"kovaaks_plus_active\":";
        body_json += entry.kovaaks_plus_active ? "true" : "false";
        body_json += "}";
    }

    void persist_friend_scores_cache(
        const std::string& scenario_name,
        uint64_t leaderboard_id,
        int32_t response_code,
        const std::string& body_json,
        uint64_t now
    ) {
        if (scenario_name.empty() || body_json.empty()) {
            return;
        }

        persisted_friend_scores_cache_[scenario_name] = PersistedFriendScoresCacheEntry{
            leaderboard_id,
            response_code,
            now,
            body_json,
        };

        const auto cache_path = friend_scores_cache_file_path(scenario_name);
        std::error_code create_error{};
        std::filesystem::create_directories(cache_path.parent_path(), create_error);

        std::ofstream out{cache_path, std::ios::binary | std::ios::trunc};
        if (!out.is_open()) {
            if (should_log_user_management(now)) {
                log_user_management(now, "failed to persist friend scores cache");
            }
            return;
        }

        out << leaderboard_id << '\n'
            << response_code << '\n'
            << static_cast<unsigned long long>(now) << '\n'
            << body_json;
    }

    bool load_persisted_friend_scores_cache(
        const std::string& scenario_name,
        PersistedFriendScoresCacheEntry& out_entry
    ) {
        out_entry = {};
        if (scenario_name.empty()) {
            return false;
        }

        const auto cached = persisted_friend_scores_cache_.find(scenario_name);
        if (cached != persisted_friend_scores_cache_.end() && !cached->second.body_json.empty()) {
            out_entry = cached->second;
            return true;
        }

        std::ifstream in{friend_scores_cache_file_path(scenario_name), std::ios::binary};
        if (!in.is_open()) {
            return false;
        }

        std::string leaderboard_id_line{};
        std::string response_code_line{};
        std::string saved_at_line{};
        if (!std::getline(in, leaderboard_id_line)
            || !std::getline(in, response_code_line)
            || !std::getline(in, saved_at_line)) {
            return false;
        }

        PersistedFriendScoresCacheEntry loaded{};
        loaded.leaderboard_id = static_cast<uint64_t>(std::strtoull(leaderboard_id_line.c_str(), nullptr, 10));
        loaded.response_code = static_cast<int32_t>(std::strtol(response_code_line.c_str(), nullptr, 10));
        loaded.saved_at_ms = static_cast<uint64_t>(std::strtoull(saved_at_line.c_str(), nullptr, 10));
        loaded.body_json.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
        if (loaded.body_json.empty()) {
            return false;
        }

        persisted_friend_scores_cache_[scenario_name] = loaded;
        out_entry = std::move(loaded);
        return true;
    }

    static bool extract_json_array_field(std::string_view json, std::string_view key, std::string& out) {
        out.clear();
        if (json.empty() || key.empty()) {
            return false;
        }

        std::string needle;
        needle.reserve(key.size() + 2);
        needle.push_back('"');
        needle.append(key.begin(), key.end());
        needle.push_back('"');

        size_t pos = json.find(needle);
        if (pos == std::string_view::npos) {
            return false;
        }
        pos = json.find(':', pos + needle.size());
        if (pos == std::string_view::npos) {
            return false;
        }
        ++pos;
        while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
            ++pos;
        }
        if (pos >= json.size() || json[pos] != '[') {
            return false;
        }

        const size_t array_start = pos;
        int depth = 0;
        bool in_string = false;
        bool escaped = false;
        for (; pos < json.size(); ++pos) {
            const char ch = json[pos];
            if (in_string) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (ch == '\\') {
                    escaped = true;
                    continue;
                }
                if (ch == '"') {
                    in_string = false;
                }
                continue;
            }

            if (ch == '"') {
                in_string = true;
                continue;
            }
            if (ch == '[') {
                ++depth;
                continue;
            }
            if (ch == ']') {
                --depth;
                if (depth == 0) {
                    out.assign(json.substr(array_start, (pos - array_start) + 1));
                    return true;
                }
            }
        }
        return false;
    }

    bool try_build_cached_self_score_json(const std::string& scenario_name, std::string& out_adjacent_scores_json) {
        out_adjacent_scores_json.clear();
        PersistedFriendScoresCacheEntry cached{};
        if (!load_persisted_friend_scores_cache(scenario_name, cached) || cached.body_json.empty()) {
            return false;
        }
        return extract_json_array_field(cached.body_json, "adjacent_scores", out_adjacent_scores_json)
            && !out_adjacent_scores_json.empty();
    }

    std::string serialize_friend_scores_body_json(
        const std::string& scenario_name,
        const std::vector<BridgeFriendScoreEntry>& entries
    ) {
        if (entries.empty()) {
            return {};
        }

        std::string adjacent_scores_json{};
        if (!try_build_cached_self_score_json(scenario_name, adjacent_scores_json) || adjacent_scores_json == "[]") {
            if (has_last_emitted_user_profile_ && !last_emitted_user_profile_.steam_id.empty()) {
                for (const auto& entry : entries) {
                    if (entry.steam_id != last_emitted_user_profile_.steam_id) {
                        continue;
                    }
                    adjacent_scores_json = "[";
                    append_friend_score_entry_json(adjacent_scores_json, entry);
                    adjacent_scores_json += "]";
                    break;
                }
            }
        }
        if (adjacent_scores_json.empty()) {
            adjacent_scores_json = "[]";
        }

        std::string body_json = "{\"top_scores\":[";
        for (size_t index = 0; index < entries.size(); ++index) {
            if (index > 0) {
                body_json += ",";
            }
            append_friend_score_entry_json(body_json, entries[index]);
        }
        body_json += "],\"adjacent_scores\":";
        body_json += adjacent_scores_json;
        body_json += "}";
        return body_json;
    }

    bool maybe_emit_persisted_friend_scores_snapshot(
        const std::string& scenario_name,
        uint64_t requested_leaderboard_id,
        uint64_t now
    ) {
        PersistedFriendScoresCacheEntry cached{};
        if (!load_persisted_friend_scores_cache(scenario_name, cached)) {
            return false;
        }
        if (cached.body_json.empty()) {
            return false;
        }
        if (requested_leaderboard_id != 0
            && cached.leaderboard_id != 0
            && cached.leaderboard_id != requested_leaderboard_id) {
            return false;
        }

        const uint64_t leaderboard_id = requested_leaderboard_id != 0 ? requested_leaderboard_id : cached.leaderboard_id;
        const auto payload = build_friend_scores_event_payload(
            "persisted_friend_scores_cache",
            scenario_name,
            leaderboard_id,
            cached.response_code > 0 ? cached.response_code : 200,
            cached.body_json
        );
        if (payload.empty()) {
            return false;
        }
        if (payload == last_emitted_friend_scores_snapshot_) {
            return true;
        }

        last_friend_scores_response_ms_ = now;
        last_friend_scores_source_ = "persisted_friend_scores_cache";
        last_friend_scores_scenario_ = scenario_name;
        last_friend_scores_leaderboard_id_ = leaderboard_id;
        last_friend_scores_entries_.clear();
        last_emitted_friend_scores_snapshot_ = payload;
        kovaaks::RustBridge::emit_json(payload.c_str());

        char buffer[320]{};
        std::snprintf(
            buffer,
            sizeof(buffer),
            "emitted persisted friends leaderboard cache scenario='%s' leaderboard_id=%llu age_ms=%llu",
            scenario_name.c_str(),
            static_cast<unsigned long long>(leaderboard_id),
            cached.saved_at_ms > 0 && now > cached.saved_at_ms
                ? static_cast<unsigned long long>(now - cached.saved_at_ms)
                : 0ull
        );
        log_user_management(now, buffer);
        return true;
    }

    static auto canonicalize_property_name(std::string_view input) -> std::string {
        std::string out;
        out.reserve(input.size());
        for (unsigned char ch : input) {
            if (std::isalnum(ch)) {
                out.push_back(static_cast<char>(std::tolower(ch)));
            }
        }
        return out;
    }

    static bool property_name_matches_cached_key(RC::Unreal::FProperty* property, const std::string& wanted_key) {
        return property
            && is_likely_valid_object_ptr(property)
            && canonicalize_property_name(normalize_ascii(property->GetName())) == wanted_key;
    }

    RC::Unreal::FProperty* find_property_in_chain_cached(
        RC::Unreal::UStruct* owner,
        const char* wanted_name
    ) {
        if (!owner || !is_likely_valid_object_ptr(owner) || !wanted_name || !*wanted_name) {
            return nullptr;
        }

        const auto wanted_key = canonicalize_property_name(wanted_name);
        auto& owner_cache = property_lookup_cache_[owner];
        const auto cached = owner_cache.find(wanted_key);
        if (cached != owner_cache.end()) {
            auto* property = cached->second;
            if (property_name_matches_cached_key(property, wanted_key)) {
                return property;
            }
            owner_cache.erase(cached);
        }

        for (RC::Unreal::FProperty* property : enumerate_properties_in_chain(owner)) {
            if (!property_name_matches_cached_key(property, wanted_key)) {
                continue;
            }
            owner_cache[wanted_key] = property;
            return property;
        }

        return nullptr;
    }

    static bool looks_like_decimal_id(std::string_view value) {
        if (value.empty()) {
            return false;
        }
        return std::all_of(
            value.begin(),
            value.end(),
            [](unsigned char ch) { return std::isdigit(ch) != 0; }
        );
    }

    static bool decode_base64_url(std::string_view input, std::string& out) {
        out.clear();
        if (input.empty()) {
            return false;
        }

        std::string normalized{};
        normalized.reserve(input.size() + 4);
        for (char ch : input) {
            if (ch == '-') {
                normalized.push_back('+');
            } else if (ch == '_') {
                normalized.push_back('/');
            } else if (std::isalnum(static_cast<unsigned char>(ch)) || ch == '+' || ch == '/' || ch == '=') {
                normalized.push_back(ch);
            }
        }
        while ((normalized.size() % 4) != 0) {
            normalized.push_back('=');
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

        out.reserve((normalized.size() / 4) * 3);
        int32_t quartet[4]{};
        size_t quartet_len = 0;
        for (char ch : normalized) {
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
            out.push_back(static_cast<char>((quartet[0] << 2) | (quartet[1] >> 4)));
            if (quartet[2] != -2) {
                out.push_back(static_cast<char>(((quartet[1] & 0x0F) << 4) | (quartet[2] >> 2)));
                if (quartet[3] != -2) {
                    out.push_back(static_cast<char>(((quartet[2] & 0x03) << 6) | quartet[3]));
                }
            }
            quartet_len = 0;
        }
        return !out.empty();
    }

    static bool extract_json_string_field(std::string_view json, std::string_view key, std::string& out) {
        out.clear();
        if (json.empty() || key.empty()) {
            return false;
        }

        std::string needle;
        needle.reserve(key.size() + 2);
        needle.push_back('"');
        needle.append(key.begin(), key.end());
        needle.push_back('"');

        size_t pos = json.find(needle);
        if (pos == std::string_view::npos) {
            return false;
        }
        pos = json.find(':', pos + needle.size());
        if (pos == std::string_view::npos) {
            return false;
        }
        ++pos;
        while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
            ++pos;
        }
        if (pos >= json.size()) {
            return false;
        }

        if (json[pos] == '"') {
            ++pos;
            std::string value{};
            bool escaped = false;
            for (; pos < json.size(); ++pos) {
                const char ch = json[pos];
                if (escaped) {
                    value.push_back(ch);
                    escaped = false;
                    continue;
                }
                if (ch == '\\') {
                    escaped = true;
                    continue;
                }
                if (ch == '"') {
                    out = trim_nonempty_ascii(std::move(value));
                    return !out.empty();
                }
                value.push_back(ch);
            }
            return false;
        }

        size_t end = pos;
        while (end < json.size() && json[end] != ',' && json[end] != '}' && !std::isspace(static_cast<unsigned char>(json[end]))) {
            ++end;
        }
        out = trim_nonempty_ascii(std::string(json.substr(pos, end - pos)));
        return !out.empty();
    }

    static bool extract_jwt_payload(std::string_view token, std::string& out_payload_json) {
        out_payload_json.clear();
        const auto first_dot = token.find('.');
        if (first_dot == std::string_view::npos) {
            return false;
        }
        const auto second_dot = token.find('.', first_dot + 1);
        if (second_dot == std::string_view::npos || second_dot <= first_dot + 1) {
            return false;
        }
        return decode_base64_url(token.substr(first_dot + 1, second_dot - first_dot - 1), out_payload_json);
    }

    bool enrich_user_from_auth_token_claims(BridgeCurrentUserProfile& user, uint64_t now) {
        if (last_sa_http_auth_token_.empty()) {
            return false;
        }

        std::string payload_json{};
        if (!extract_jwt_payload(last_sa_http_auth_token_, payload_json)) {
            return false;
        }

        std::string user_id{};
        for (const auto* key : {"user_id", "userid", "uid", "sub"}) {
            if (extract_json_string_field(payload_json, key, user_id) && !looks_like_decimal_id(user_id)) {
                break;
            }
            if (extract_json_string_field(payload_json, key, user_id)) {
                break;
            }
            user_id.clear();
        }

        std::string username{};
        for (const auto* key : {"preferred_username", "username", "nickname", "name"}) {
            if (extract_json_string_field(payload_json, key, username)) {
                break;
            }
        }

        std::string display_name{};
        for (const auto* key : {"display_name", "displayName", "nickname", "name"}) {
            if (extract_json_string_field(payload_json, key, display_name)) {
                break;
            }
        }

        std::string steam_id{};
        for (const auto* key : {"steam_id", "steamId", "external_steam_id"}) {
            if (extract_json_string_field(payload_json, key, steam_id)) {
                break;
            }
        }

        bool changed = false;
        if (user.kovaaks_user_id.empty() && !user_id.empty()) {
            user.kovaaks_user_id = user_id;
            changed = true;
        }
        if (user.username.empty() && !username.empty() && username != user.steam_id) {
            user.username = username;
            changed = true;
        }
        if (user.display_name.empty() && !display_name.empty()) {
            user.display_name = display_name;
            changed = true;
        }
        if (user.steam_id.empty() && looks_like_decimal_id(steam_id)) {
            user.steam_id = steam_id;
            changed = true;
        }
        if (!user.kovaaks_user_id.empty()) {
            user.external_id = std::string("kovaaks:") + user.kovaaks_user_id;
        }
        if ((!user.kovaaks_user_id.empty() || !user.username.empty())
            && std::none_of(
                user.linked_accounts.begin(),
                user.linked_accounts.end(),
                [](const BridgeLinkedIdentity& account) { return account.provider == "kovaaks"; }
            )) {
            BridgeLinkedIdentity account{};
            account.provider = "kovaaks";
            account.provider_account_id = !user.kovaaks_user_id.empty() ? user.kovaaks_user_id : user.username;
            account.username = user.username;
            account.display_name = !user.display_name.empty() ? user.display_name : user.username;
            user.linked_accounts.emplace_back(std::move(account));
            changed = true;
        }

        if (changed) {
            char buffer[256]{};
            std::snprintf(
                buffer,
                sizeof(buffer),
                "enriched current user from auth token username='%s' kovaaks_user_id='%s' steam_id='%s'",
                user.username.c_str(),
                user.kovaaks_user_id.c_str(),
                user.steam_id.c_str()
            );
            log_user_management(now, buffer);
        }
        return changed;
    }

    template <typename Callback>
    bool visit_return_property(
        RC::Unreal::UObject* receiver,
        RC::Unreal::UFunction* fn,
        Callback&& callback
    ) {
        auto* caller = resolve_receive_caller(receiver, fn);
        if (!caller || !fn || !is_likely_valid_object_ptr(fn)) {
            return false;
        }

        int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x400;
        }

        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
        RC::Unreal::FProperty* return_property = nullptr;
        for (RC::Unreal::FProperty* property : enumerate_properties(fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_Parm)) {
                continue;
            }
            if (property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                return_property = property;
                break;
            }
        }
        if (!return_property || !is_likely_valid_object_ptr(return_property)) {
            return false;
        }
        if (!safe_process_event_call(caller, fn, params.data())) {
            return false;
        }
        void* value_ptr = safe_property_value_ptr(return_property, params.data());
        if (!value_ptr) {
            return false;
        }
        return callback(return_property, value_ptr);
    }

    template <typename ParamSetter, typename Callback>
    bool visit_return_property_with_params(
        RC::Unreal::UObject* receiver,
        RC::Unreal::UFunction* fn,
        ParamSetter&& set_params,
        Callback&& callback
    ) {
        auto* caller = resolve_receive_caller(receiver, fn);
        if (!caller || !fn || !is_likely_valid_object_ptr(fn)) {
            return false;
        }

        int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x400;
        }

        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
        RC::Unreal::FProperty* return_property = nullptr;
        for (RC::Unreal::FProperty* property : enumerate_properties(fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_Parm)) {
                continue;
            }

            void* value_ptr = safe_property_value_ptr(property, params.data());
            if (!value_ptr) {
                continue;
            }
            if (property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                return_property = property;
                continue;
            }
            set_params(property, value_ptr);
        }

        if (!return_property || !is_likely_valid_object_ptr(return_property)) {
            return false;
        }
        if (!safe_process_event_call(caller, fn, params.data())) {
            return false;
        }

        void* value_ptr = safe_property_value_ptr(return_property, params.data());
        if (!value_ptr) {
            return false;
        }
        return callback(return_property, value_ptr);
    }

    template <typename ParamSetter>
    bool invoke_string_return(
        RC::Unreal::UObject* receiver,
        RC::Unreal::UFunction* fn,
        ParamSetter&& set_params,
        std::string& out
    ) {
        out.clear();
        return visit_return_property_with_params(
            receiver,
            fn,
            std::forward<ParamSetter>(set_params),
            [&](RC::Unreal::FProperty* return_property, void* value_ptr) {
                struct RawFStringData {
                    const RC::Unreal::TCHAR* data;
                    int32_t count;
                    int32_t capacity;
                };

                auto* str_property = RC::Unreal::CastField<RC::Unreal::FStrProperty>(return_property);
                if (!str_property || !is_likely_valid_object_ptr(str_property)) {
                    return false;
                }
                const RC::Unreal::FString value = str_property->GetPropertyValue(value_ptr);
                const auto* raw = reinterpret_cast<const RawFStringData*>(&value);
                if (!raw || !is_likely_readable_region(raw, sizeof(RawFStringData))) {
                    return false;
                }
                if (!raw->data || raw->count <= 1 || raw->count > 4096) {
                    return false;
                }
                if (!is_likely_readable_region(
                        raw->data,
                        static_cast<size_t>(raw->count) * sizeof(RC::Unreal::TCHAR)
                    )) {
                    return false;
                }

                out = escape_json_ascii(
                    utf8_from_wide(
                        std::wstring(raw->data, raw->data + static_cast<size_t>(raw->count - 1))
                    )
                );
                out.erase(
                    std::remove_if(
                        out.begin(),
                        out.end(),
                        [](unsigned char ch) { return ch < 0x20; }
                    ),
                    out.end()
                );
                while (!out.empty() && std::isspace(static_cast<unsigned char>(out.front()))) {
                    out.erase(out.begin());
                }
                while (!out.empty() && std::isspace(static_cast<unsigned char>(out.back()))) {
                    out.pop_back();
                }
                return !out.empty();
            }
        );
    }

    template <typename ParamSetter>
    bool invoke_bool_return(
        RC::Unreal::UObject* receiver,
        RC::Unreal::UFunction* fn,
        ParamSetter&& set_params,
        bool& out
    ) {
        out = false;
        return visit_return_property_with_params(
            receiver,
            fn,
            std::forward<ParamSetter>(set_params),
            [&](RC::Unreal::FProperty* return_property, void* value_ptr) {
                if (auto* bool_property = RC::Unreal::CastField<RC::Unreal::FBoolProperty>(return_property)) {
                    out = bool_property->GetPropertyValue(value_ptr);
                    return true;
                }
                if (auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(return_property)) {
                    out = numeric->GetSignedIntPropertyValue(value_ptr) != 0;
                    return true;
                }
                return false;
            }
        );
    }

    template <typename ParamSetter>
    bool invoke_i32_return(
        RC::Unreal::UObject* receiver,
        RC::Unreal::UFunction* fn,
        ParamSetter&& set_params,
        int32_t& out
    ) {
        out = 0;
        return visit_return_property_with_params(
            receiver,
            fn,
            std::forward<ParamSetter>(set_params),
            [&](RC::Unreal::FProperty* return_property, void* value_ptr) {
                auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(return_property);
                if (!numeric || !is_likely_valid_object_ptr(numeric) || !numeric->IsInteger()) {
                    return false;
                }
                out = static_cast<int32_t>(numeric->GetSignedIntPropertyValue(value_ptr));
                return true;
            }
        );
    }

    template <typename StructValue, typename ParamSetter>
    bool invoke_struct_return(
        RC::Unreal::UObject* receiver,
        RC::Unreal::UFunction* fn,
        ParamSetter&& set_params,
        StructValue& out
    ) {
        std::memset(&out, 0, sizeof(StructValue));
        return visit_return_property_with_params(
            receiver,
            fn,
            std::forward<ParamSetter>(set_params),
            [&](RC::Unreal::FProperty* return_property, void* value_ptr) {
                auto* struct_property = RC::Unreal::CastField<RC::Unreal::FStructProperty>(return_property);
                if (!struct_property || !is_likely_valid_object_ptr(struct_property)) {
                    return false;
                }
                if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(StructValue))) {
                    return false;
                }
                std::memcpy(&out, value_ptr, sizeof(StructValue));
                return true;
            }
        );
    }

    template <typename ParamSetter, typename ParamReader>
    bool invoke_with_param_inspection(
        RC::Unreal::UObject* receiver,
        RC::Unreal::UFunction* fn,
        ParamSetter&& set_params,
        ParamReader&& read_params
    ) {
        auto* caller = resolve_receive_caller(receiver, fn);
        if (!caller || !fn || !is_likely_valid_object_ptr(fn)) {
            return false;
        }

        int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x400;
        }

        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
        for (RC::Unreal::FProperty* property : enumerate_properties(fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_Parm)) {
                continue;
            }
            void* value_ptr = safe_property_value_ptr(property, params.data());
            if (!value_ptr) {
                continue;
            }
            set_params(property, value_ptr);
        }

        if (!safe_process_event_call(caller, fn, params.data())) {
            return false;
        }

        for (RC::Unreal::FProperty* property : enumerate_properties(fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_Parm)) {
                continue;
            }
            void* value_ptr = safe_property_value_ptr(property, params.data());
            if (!value_ptr) {
                continue;
            }
            read_params(property, value_ptr);
        }
        return true;
    }

    struct OpaqueSteamId {
        uint64_t value{0};
    };

    struct RawScriptArrayData {
        void* data{nullptr};
        int32_t count{0};
        int32_t capacity{0};
    };

    static auto opaque_steam_id_to_string(const OpaqueSteamId& steam_id) -> std::string {
        if (steam_id.value == 0) {
            return {};
        }
        return std::to_string(steam_id.value);
    }

    static bool assign_script_array_bytes(void* value_ptr, void* data, int32_t count) {
        if (!value_ptr || count < 0) {
            return false;
        }
        auto* raw = reinterpret_cast<RawScriptArrayData*>(value_ptr);
        raw->data = data;
        raw->count = count;
        raw->capacity = count;
        return true;
    }

    static auto utf8_from_fstring(const RC::Unreal::FString& value) -> std::string {
        struct RawFStringData {
            const RC::Unreal::TCHAR* data;
            int32_t count;
            int32_t capacity;
        };

        const auto* raw = reinterpret_cast<const RawFStringData*>(&value);
        if (!raw || !is_likely_readable_region(raw, sizeof(RawFStringData))) {
            return {};
        }
        if (!raw->data || raw->count <= 1 || raw->count > 4096) {
            return {};
        }
        if (!is_likely_readable_region(
                raw->data,
                static_cast<size_t>(raw->count) * sizeof(RC::Unreal::TCHAR)
            )) {
            return {};
        }
        return utf8_from_wide(
            std::wstring(raw->data, raw->data + static_cast<size_t>(raw->count - 1))
        );
    }

    static auto trim_nonempty_ascii(std::string value) -> std::string {
        if (value.empty()) {
            return {};
        }
        value = escape_json_ascii(value);
        value.erase(
            std::remove_if(
                value.begin(),
                value.end(),
                [](unsigned char ch) { return ch < 0x20; }
            ),
            value.end()
        );
        while (!value.empty() && std::isspace(static_cast<unsigned char>(value.front()))) {
            value.erase(value.begin());
        }
        while (!value.empty() && std::isspace(static_cast<unsigned char>(value.back()))) {
            value.pop_back();
        }
        return value;
    }

    bool write_string_property_value(RC::Unreal::FProperty* property, void* value_ptr, const std::string& value) {
        auto* str_property = RC::Unreal::CastField<RC::Unreal::FStrProperty>(property);
        if (!str_property || !is_likely_valid_object_ptr(str_property) || !value_ptr) {
            return false;
        }
        const auto wide_value = string_type_from_utf8(value.c_str());
        str_property->SetPropertyValue(value_ptr, RC::Unreal::FString(wide_value.c_str()));
        return true;
    }

    bool write_string_property_named(
        RC::Unreal::UStruct* owner,
        void* container,
        const char* wanted_name,
        const std::string& value
    ) {
        if (!owner || !container || !wanted_name || !*wanted_name) {
            return false;
        }
        if (auto* property = find_property_in_chain_cached(owner, wanted_name)) {
            void* value_ptr = safe_property_value_ptr(property, container);
            if (value_ptr) {
                return write_string_property_value(property, value_ptr, value);
            }
        }
        return false;
    }

    bool read_u64_property_named(
        RC::Unreal::UStruct* owner,
        void* container,
        const char* wanted_name,
        uint64_t& out
    ) {
        out = 0;
        if (!owner || !container || !wanted_name || !*wanted_name) {
            return false;
        }
        if (auto* property = find_property_in_chain_cached(owner, wanted_name)) {
            auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property);
            if (numeric && is_likely_valid_object_ptr(numeric) && numeric->IsInteger()) {
                void* value_ptr = safe_property_value_ptr(property, container);
                if (!value_ptr) {
                    return false;
                }
                out = static_cast<uint64_t>(numeric->GetUnsignedIntPropertyValue(value_ptr));
                return true;
            }
        }
        return false;
    }

    bool read_bool_property_value(RC::Unreal::FProperty* property, void* value_ptr, bool& out) {
        if (auto* bool_property = RC::Unreal::CastField<RC::Unreal::FBoolProperty>(property)) {
            if (!is_likely_valid_object_ptr(bool_property) || !value_ptr) {
                return false;
            }
            out = bool_property->GetPropertyValue(value_ptr);
            return true;
        }
        if (auto* numeric_property = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property)) {
            if (!is_likely_valid_object_ptr(numeric_property) || !numeric_property->IsInteger() || !value_ptr) {
                return false;
            }
            out = numeric_property->GetSignedIntPropertyValue(value_ptr) != 0;
            return true;
        }
        return false;
    }

    bool read_string_property_named(
        RC::Unreal::UStruct* owner,
        void* container,
        const char* wanted_name,
        std::string& out
    ) {
        out.clear();
        if (!owner || !container || !wanted_name || !*wanted_name) {
            return false;
        }
        if (auto* property = find_property_in_chain_cached(owner, wanted_name)) {
            auto* str_property = RC::Unreal::CastField<RC::Unreal::FStrProperty>(property);
            if (str_property && is_likely_valid_object_ptr(str_property)) {
                void* value_ptr = safe_property_value_ptr(property, container);
                if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(RC::Unreal::FString))) {
                    return false;
                }
                out = trim_nonempty_ascii(
                    utf8_from_fstring(str_property->GetPropertyValue(value_ptr))
                );
                return !out.empty();
            }
        }
        return false;
    }

    bool read_i32_property_named(
        RC::Unreal::UStruct* owner,
        void* container,
        const char* wanted_name,
        int32_t& out
    ) {
        if (!owner || !container || !wanted_name || !*wanted_name) {
            return false;
        }
        if (auto* property = find_property_in_chain_cached(owner, wanted_name)) {
            auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property);
            if (numeric && is_likely_valid_object_ptr(numeric) && numeric->IsInteger()) {
                void* value_ptr = safe_property_value_ptr(property, container);
                if (!value_ptr) {
                    return false;
                }
                out = static_cast<int32_t>(numeric->GetSignedIntPropertyValue(value_ptr));
                return true;
            }
        }
        return false;
    }

    bool read_f64_property_named(
        RC::Unreal::UStruct* owner,
        void* container,
        const char* wanted_name,
        double& out
    ) {
        out = 0.0;
        if (!owner || !container || !wanted_name || !*wanted_name) {
            return false;
        }
        if (auto* property = find_property_in_chain_cached(owner, wanted_name)) {
            auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property);
            if (!numeric || !is_likely_valid_object_ptr(numeric)) {
                return false;
            }
            void* value_ptr = safe_property_value_ptr(property, container);
            if (!value_ptr) {
                return false;
            }
            if (numeric->IsFloatingPoint()) {
                out = numeric->GetFloatingPointPropertyValue(value_ptr);
                return std::isfinite(out);
            }
            if (numeric->IsInteger()) {
                out = static_cast<double>(numeric->GetSignedIntPropertyValue(value_ptr));
                return true;
            }
        }
        return false;
    }

    bool read_object_property_named(
        RC::Unreal::UStruct* owner,
        void* container,
        const char* wanted_name,
        RC::Unreal::UObject*& out
    ) {
        out = nullptr;
        if (!owner || !container || !wanted_name || !*wanted_name) {
            return false;
        }
        if (auto* property = find_property_in_chain_cached(owner, wanted_name)) {
            auto* object_property = RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property);
            if (!object_property || !is_likely_valid_object_ptr(object_property)) {
                return false;
            }
            void* value_ptr = safe_property_value_ptr(property, container);
            if (!value_ptr) {
                return false;
            }
            out = object_property->GetObjectPropertyValue(value_ptr);
            return out && is_likely_valid_object_ptr(out);
        }
        return false;
    }

    RC::Unreal::UObject* resolve_game_instance_subsystem_via_blueprint(
        uint64_t now,
        RC::Unreal::UObject* context_object,
        RC::Unreal::UClass* subsystem_class
    ) {
        if (!context_object || !is_likely_valid_object_ptr(context_object)
            || !subsystem_class || !is_likely_valid_object_ptr(subsystem_class)) {
            return nullptr;
        }

        if (!get_game_instance_subsystem_fn_ || !is_likely_valid_object_ptr(get_game_instance_subsystem_fn_)) {
            get_game_instance_subsystem_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr,
                nullptr,
                STR("/Script/Engine.SubsystemBlueprintLibrary:GetGameInstanceSubsystem")
            );
        }
        if (!get_game_instance_subsystem_fn_ || !is_likely_valid_object_ptr(get_game_instance_subsystem_fn_)) {
            log_user_management(now, "GetGameInstanceSubsystem function not found");
            return nullptr;
        }

        auto* caller = resolve_receive_caller(context_object, get_game_instance_subsystem_fn_);
        if (!caller || !is_likely_valid_object_ptr(caller)) {
            log_user_management(now, "GetGameInstanceSubsystem caller resolution failed");
            return nullptr;
        }

        int32_t param_size = static_cast<int32_t>(get_game_instance_subsystem_fn_->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = get_game_instance_subsystem_fn_->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x200;
        }

        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
        RC::Unreal::FProperty* return_property = nullptr;
        for (RC::Unreal::FProperty* property : enumerate_properties(get_game_instance_subsystem_fn_)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_Parm)) {
                continue;
            }

            const auto property_name = canonicalize_property_name(normalize_ascii(property->GetName()));
            void* value_ptr = safe_property_value_ptr(property, params.data());
            if (!value_ptr) {
                continue;
            }

            if (property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                return_property = property;
                continue;
            }
            if (property_name == "contextobject") {
                *reinterpret_cast<RC::Unreal::UObject**>(value_ptr) = context_object;
                continue;
            }
            if (property_name == "class") {
                *reinterpret_cast<RC::Unreal::UClass**>(value_ptr) = subsystem_class;
                continue;
            }
        }

        if (!return_property || !is_likely_valid_object_ptr(return_property)) {
            log_user_management(now, "GetGameInstanceSubsystem return property missing");
            return nullptr;
        }
        if (!safe_process_event_call(caller, get_game_instance_subsystem_fn_, params.data())) {
            log_user_management(now, "GetGameInstanceSubsystem invoke failed");
            return nullptr;
        }

        void* value_ptr = safe_property_value_ptr(return_property, params.data());
        if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(void*))) {
            log_user_management(now, "GetGameInstanceSubsystem return value unreadable");
            return nullptr;
        }

        auto* subsystem = *reinterpret_cast<RC::Unreal::UObject**>(value_ptr);
        if (!subsystem || !is_likely_valid_object_ptr(subsystem)) {
            return nullptr;
        }
        return subsystem;
    }

    RC::Unreal::UObject* resolve_uworks_core_user(uint64_t now) {
        if (uworks_core_user_ && is_likely_valid_object_ptr(uworks_core_user_)) {
            return uworks_core_user_;
        }

        for (const auto* path : {
                 STR("/Script/UWorksCore.Default__UWorksInterfaceCoreUser"),
                 STR("/Script/UWorksCore.Default__UUWorksInterfaceCoreUser")
             }) {
            auto* object = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UObject*>(
                nullptr,
                nullptr,
                path
            );
            if (object && is_likely_valid_object_ptr(object)) {
                uworks_core_user_ = object;
                return uworks_core_user_;
            }
        }

        uworks_core_user_class_ = resolve_class_cached(
            uworks_core_user_class_,
            {
                STR("/Script/UWorksCore.UWorksInterfaceCoreUser"),
                STR("/Script/UWorksCore.UUWorksInterfaceCoreUser")
            }
        );
        if (!uworks_core_user_class_ || !is_likely_valid_object_ptr(uworks_core_user_class_)) {
            log_user_management(now, "failed to resolve UWorksInterfaceCoreUser class");
            return nullptr;
        }

        std::vector<RC::Unreal::UObject*> found{};
        collect_objects_by_class(uworks_core_user_class_, found);
        for (auto* object : found) {
            if (!object || !is_likely_valid_object_ptr(object)) {
                continue;
            }
            const auto full_name = object->GetFullName();
            if (full_name.find(STR("Default__")) == RC::StringType::npos
                && !is_rejected_runtime_object_name(full_name)) {
                uworks_core_user_ = object;
                return uworks_core_user_;
            }
            if (!uworks_core_user_) {
                uworks_core_user_ = object;
            }
        }

        if (!uworks_core_user_) {
            log_user_management(now, "UWorksInterfaceCoreUser instance not found");
        }
        return uworks_core_user_;
    }

    RC::Unreal::UObject* resolve_uworks_core_friends(uint64_t now) {
        if (uworks_core_friends_ && is_likely_valid_object_ptr(uworks_core_friends_)) {
            return uworks_core_friends_;
        }

        for (const auto* path : {
                 STR("/Script/UWorksCore.Default__UWorksInterfaceCoreFriends"),
                 STR("/Script/UWorksCore.Default__UUWorksInterfaceCoreFriends")
             }) {
            auto* object = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UObject*>(
                nullptr,
                nullptr,
                path
            );
            if (object && is_likely_valid_object_ptr(object)) {
                uworks_core_friends_ = object;
                return uworks_core_friends_;
            }
        }

        uworks_core_friends_class_ = resolve_class_cached(
            uworks_core_friends_class_,
            {
                STR("/Script/UWorksCore.UWorksInterfaceCoreFriends"),
                STR("/Script/UWorksCore.UUWorksInterfaceCoreFriends")
            }
        );
        if (!uworks_core_friends_class_ || !is_likely_valid_object_ptr(uworks_core_friends_class_)) {
            log_user_management(now, "failed to resolve UWorksInterfaceCoreFriends class");
            return nullptr;
        }

        std::vector<RC::Unreal::UObject*> found{};
        collect_objects_by_class(uworks_core_friends_class_, found);
        for (auto* object : found) {
            if (!object || !is_likely_valid_object_ptr(object)) {
                continue;
            }
            const auto full_name = object->GetFullName();
            if (full_name.find(STR("Default__")) == RC::StringType::npos
                && !is_rejected_runtime_object_name(full_name)) {
                uworks_core_friends_ = object;
                return uworks_core_friends_;
            }
            if (!uworks_core_friends_) {
                uworks_core_friends_ = object;
            }
        }

        if (!uworks_core_friends_) {
            log_user_management(now, "UWorksInterfaceCoreFriends instance not found");
        }
        return uworks_core_friends_;
    }

    RC::Unreal::UObject* resolve_leaderboards_manager(uint64_t now) {
        if (leaderboards_manager_ && is_likely_valid_object_ptr(leaderboards_manager_)) {
            return leaderboards_manager_;
        }
        if (!meta_game_instance_ || !is_likely_valid_object_ptr(meta_game_instance_)) {
            log_user_management(now, "LeaderboardsManager resolve skipped without MetaGameInstance");
            return nullptr;
        }

        leaderboards_manager_class_ = resolve_class_cached(
            leaderboards_manager_class_,
            {
                STR("/Script/GameSkillsTrainer.LeaderboardsManager")
            }
        );
        if (!leaderboards_manager_class_ || !is_likely_valid_object_ptr(leaderboards_manager_class_)) {
            log_user_management(now, "failed to resolve LeaderboardsManager class");
            return nullptr;
        }

        leaderboards_manager_ = resolve_game_instance_subsystem_via_blueprint(
            now,
            meta_game_instance_,
            leaderboards_manager_class_
        );
        if (!leaderboards_manager_ || !is_likely_valid_object_ptr(leaderboards_manager_)) {
            log_user_management(now, "LeaderboardsManager subsystem not found");
            return nullptr;
        }
        return leaderboards_manager_;
    }

    RC::Unreal::UObject* resolve_steam_network_model(uint64_t now) {
        if (steam_network_model_ && is_likely_valid_object_ptr(steam_network_model_)) {
            return steam_network_model_;
        }
        if (!meta_game_instance_ || !is_likely_valid_object_ptr(meta_game_instance_)) {
            log_user_management(now, "SteamNetworkModel resolve skipped without MetaGameInstance");
            return nullptr;
        }

        steam_network_model_class_ = resolve_class_cached(
            steam_network_model_class_,
            {
                STR("/Script/KovaaKNetworkModels.SteamNetworkModel")
            }
        );
        if (!steam_network_model_class_ || !is_likely_valid_object_ptr(steam_network_model_class_)) {
            log_user_management(now, "failed to resolve SteamNetworkModel class");
            return nullptr;
        }

        steam_network_model_ = resolve_game_instance_subsystem_via_blueprint(
            now,
            meta_game_instance_,
            steam_network_model_class_
        );
        if (!steam_network_model_ || !is_likely_valid_object_ptr(steam_network_model_)) {
            log_user_management(now, "SteamNetworkModel subsystem not found");
            return nullptr;
        }
        return steam_network_model_;
    }

    RC::Unreal::UObject* resolve_active_leaderboards_widget(uint64_t now) {
        if (active_leaderboards_widget_
            && is_likely_valid_object_ptr(active_leaderboards_widget_)
            && now < next_active_leaderboards_widget_resolve_ms_) {
            return active_leaderboards_widget_;
        }

        leaderboards_widget_class_ = resolve_class_cached(
            leaderboards_widget_class_,
            {STR("/Script/GameSkillsTrainer.LeaderboardsWidget")}
        );
        pause_menu_widget_class_ = resolve_class_cached(
            pause_menu_widget_class_,
            {STR("/Script/GameSkillsTrainer.PauseMenuWidget")}
        );

        std::vector<RC::Unreal::UObject*> candidates{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("LeaderboardsWidget"), candidates);
        std::vector<RC::Unreal::UObject*> alt{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("LeaderboardsWidget_C"), alt);
        append_unique_objects(candidates, alt);
        if (leaderboards_widget_class_ && is_likely_valid_object_ptr(leaderboards_widget_class_)) {
            std::vector<RC::Unreal::UObject*> by_class{};
            collect_objects_by_class(leaderboards_widget_class_, by_class);
            append_unique_objects(candidates, by_class);
        }

        if (pause_menu_widget_class_ && is_likely_valid_object_ptr(pause_menu_widget_class_)) {
            std::vector<RC::Unreal::UObject*> pause_widgets{};
            collect_objects_by_class(pause_menu_widget_class_, pause_widgets);
            for (auto* pause_widget : pause_widgets) {
                if (!pause_widget || !is_likely_valid_object_ptr(pause_widget)) {
                    continue;
                }
                const auto full_name = pause_widget->GetFullName();
                if (is_rejected_runtime_object_name(full_name)) {
                    continue;
                }
                auto* pause_owner = static_cast<RC::Unreal::UStruct*>(pause_widget->GetClassPrivate());
                if (!pause_owner || !is_likely_valid_object_ptr(pause_owner)) {
                    continue;
                }
                RC::Unreal::UObject* leaderboard_widget = nullptr;
                if (!read_object_property_named(pause_owner, pause_widget, "pausemenuleaderboard", leaderboard_widget)) {
                    continue;
                }
                if (leaderboard_widget && is_likely_valid_object_ptr(leaderboard_widget)) {
                    std::vector<RC::Unreal::UObject*> wrapped{leaderboard_widget};
                    append_unique_objects(candidates, wrapped);
                }
            }
        }

        RC::Unreal::UObject* best = nullptr;
        int best_score = -1000000;
        for (auto* widget : candidates) {
            if (!widget || !is_likely_valid_object_ptr(widget)) {
                continue;
            }
            const auto full_name = widget->GetFullName();
            if (is_rejected_runtime_object_name(full_name)) {
                continue;
            }
            int score = 0;
            if (full_name.find(STR("/Engine/Transient.GameEngine_")) != RC::StringType::npos) score += 200;
            if (full_name.find(STR("PauseMenu")) != RC::StringType::npos) score += 100;
            if (full_name.find(STR("LeaderboardsWidget")) != RC::StringType::npos) score += 50;
            if (score > best_score) {
                best = widget;
                best_score = score;
            }
        }
        if (!best || !is_likely_valid_object_ptr(best)) {
            active_leaderboards_widget_ = nullptr;
            next_active_leaderboards_widget_resolve_ms_ = now + 1000;
            if (should_log_user_management(now)) {
                log_user_management(now, "active leaderboards widget not found");
            }
            return nullptr;
        }
        active_leaderboards_widget_ = best;
        next_active_leaderboards_widget_resolve_ms_ = now + 2000;
        return best;
    }

    bool emit_friend_scores_snapshot(
        const char* source,
        const std::string& scenario_name,
        uint64_t leaderboard_id,
        const std::vector<BridgeFriendScoreEntry>& entries,
        uint64_t now
    ) {
        if (entries.empty()) {
            return false;
        }

        const std::string source_name = source ? source : "unknown";
        last_friend_scores_response_ms_ = now;
        if (source_name == last_friend_scores_source_
            && scenario_name == last_friend_scores_scenario_
            && leaderboard_id == last_friend_scores_leaderboard_id_
            && bridge_friend_score_entries_equal(entries, last_friend_scores_entries_)) {
            return true;
        }

        const auto body_json = serialize_friend_scores_body_json(scenario_name, entries);
        const auto payload = build_friend_scores_event_payload(
            source_name.c_str(),
            scenario_name,
            leaderboard_id,
            200,
            body_json
        );
        if (payload.empty()) {
            return false;
        }

        last_friend_scores_source_ = source_name;
        last_friend_scores_scenario_ = scenario_name;
        last_friend_scores_leaderboard_id_ = leaderboard_id;
        last_friend_scores_entries_ = entries;
        last_emitted_friend_scores_snapshot_ = payload;
        persist_friend_scores_cache(scenario_name, leaderboard_id, 200, body_json, now);
        kovaaks::RustBridge::emit_json(payload.c_str());
        return true;
    }

    std::string current_user_management_scenario_name() const {
        if (!last_scenario_name_.empty()) {
            return last_scenario_name_;
        }
        if (!s_last_run_scenario_name.empty()) {
            return s_last_run_scenario_name;
        }
        return {};
    }

    bool is_user_management_live_gameplay_active() const {
        const bool active_scenario = s_last_pull_is_in_scenario == 1
            && s_last_pull_scenario_is_paused != 1
            && (!std::isfinite(s_last_pull_queue_time_remaining)
                || s_last_pull_queue_time_remaining <= 0.0001f);
        return s_last_pull_is_in_challenge == 1 || active_scenario;
    }

    bool should_refresh_user_management_user_profile() const {
        if (!has_last_emitted_user_profile_) {
            return true;
        }
        return !last_sa_http_auth_token_.empty()
            && last_emitted_user_profile_.kovaaks_user_id.empty();
    }

    bool read_leaderboard_id_for_scenario(
        const std::string& scenario_name,
        uint64_t& out_leaderboard_id,
        uint64_t now
    ) {
        out_leaderboard_id = 0;
        if (scenario_name.empty()) {
            return false;
        }
        auto* manager = resolve_leaderboards_manager(now);
        if (!manager || !is_likely_valid_object_ptr(manager)) {
            return false;
        }
        if (!leaderboards_get_leaderboard_id_fn_ || !is_likely_valid_object_ptr(leaderboards_get_leaderboard_id_fn_)) {
            leaderboards_get_leaderboard_id_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr,
                nullptr,
                STR("/Script/GameSkillsTrainer.LeaderboardsManager:GetLeaderboardId")
            );
        }
        if (!leaderboards_get_leaderboard_id_fn_ || !is_likely_valid_object_ptr(leaderboards_get_leaderboard_id_fn_)) {
            log_user_management(now, "LeaderboardsManager GetLeaderboardId function not found");
            return false;
        }

        bool found = false;
        const bool invoked = invoke_with_param_inspection(
            manager,
            leaderboards_get_leaderboard_id_fn_,
            [&](RC::Unreal::FProperty* property, void* value_ptr) {
                const auto property_name = canonicalize_property_name(normalize_ascii(property->GetName()));
                if (property_name == "scenarioname") {
                    (void)write_string_property_value(property, value_ptr, scenario_name);
                }
            },
            [&](RC::Unreal::FProperty* property, void* value_ptr) {
                const auto property_name = canonicalize_property_name(normalize_ascii(property->GetName()));
                if (property_name == "outleaderboardid") {
                    auto* struct_property = RC::Unreal::CastField<RC::Unreal::FStructProperty>(property);
                    if (!struct_property || !is_likely_valid_object_ptr(struct_property)) {
                        return;
                    }
                    auto* script_struct = resolve_struct_property_script_struct(struct_property);
                    if (!script_struct || !is_likely_valid_object_ptr(script_struct)) {
                        return;
                    }
                    uint64_t value = 0;
                    if (read_u64_property_named(reinterpret_cast<RC::Unreal::UStruct*>(script_struct), value_ptr, "value", value)) {
                        out_leaderboard_id = value;
                    }
                    return;
                }
                if (property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                    (void)read_bool_property_value(property, value_ptr, found);
                }
            }
        );
        if (!invoked || !found || out_leaderboard_id == 0) {
            char buffer[256]{};
            std::snprintf(
                buffer,
                sizeof(buffer),
                "GetLeaderboardId failed scenario='%s' found=%d leaderboard_id=%llu",
                scenario_name.c_str(),
                found ? 1 : 0,
                static_cast<unsigned long long>(out_leaderboard_id)
            );
            log_user_management(now, buffer);
            return false;
        }
        return true;
    }

    bool build_friend_scores_network_request(
        uint64_t leaderboard_id,
        std::string& out_url_path,
        std::string& out_request_body,
        std::string& out_verb,
        uint64_t now
    ) {
        out_url_path.clear();
        out_request_body.clear();
        out_verb.clear();

        if (!kvk_network_request_download_top_adjacent_fn_
            || !is_likely_valid_object_ptr(kvk_network_request_download_top_adjacent_fn_)) {
            kvk_network_request_download_top_adjacent_fn_ =
                RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                    nullptr,
                    nullptr,
                    STR("/Script/GameSkillsTrainer.KvKNetworkRequestFunctionLibrary:New_NetworkRequest_DownloadTopAdjacentLeaderboardEntries")
                );
        }
        if (!kvk_network_request_download_top_adjacent_fn_
            || !is_likely_valid_object_ptr(kvk_network_request_download_top_adjacent_fn_)) {
            log_user_management(now, "New_NetworkRequest_DownloadTopAdjacentLeaderboardEntries function not found");
            return false;
        }

        const bool invoked = invoke_with_param_inspection(
            nullptr,
            kvk_network_request_download_top_adjacent_fn_,
            [&](RC::Unreal::FProperty* property, void* value_ptr) {
                const auto property_name = canonicalize_property_name(normalize_ascii(property->GetName()));
                if (property_name == "indatarequest") {
                    if (auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property)) {
                        if (is_likely_valid_object_ptr(numeric)) {
                            numeric->SetIntPropertyValue(value_ptr, static_cast<int64_t>(1));
                        }
                    } else {
                        *reinterpret_cast<uint8_t*>(value_ptr) = 1;
                    }
                    return;
                }
                if (property_name == "inmetaleaderboard") {
                    auto* struct_property = RC::Unreal::CastField<RC::Unreal::FStructProperty>(property);
                    if (!struct_property || !is_likely_valid_object_ptr(struct_property)) {
                        return;
                    }
                    auto* script_struct = resolve_struct_property_script_struct(struct_property);
                    if (!script_struct || !is_likely_valid_object_ptr(script_struct)) {
                        return;
                    }
                    auto* owner = reinterpret_cast<RC::Unreal::UStruct*>(script_struct);
                    bool wrote_field = false;
                    for (RC::Unreal::FProperty* nested_property : enumerate_properties_in_chain(owner)) {
                        if (!nested_property || !is_likely_valid_object_ptr(nested_property)) {
                            continue;
                        }
                        if (canonicalize_property_name(normalize_ascii(nested_property->GetName())) != "value") {
                            continue;
                        }
                        void* nested_value_ptr = safe_property_value_ptr(nested_property, value_ptr);
                        if (!nested_value_ptr) {
                            continue;
                        }
                        if (auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(nested_property)) {
                            if (is_likely_valid_object_ptr(numeric) && numeric->IsInteger()) {
                                numeric->SetIntPropertyValue(nested_value_ptr, static_cast<int64_t>(leaderboard_id));
                                wrote_field = true;
                                break;
                            }
                        }
                    }
                    if (!wrote_field && is_likely_readable_region(value_ptr, sizeof(uint64_t))) {
                        *reinterpret_cast<uint64_t*>(value_ptr) = leaderboard_id;
                    }
                }
            },
            [&](RC::Unreal::FProperty* property, void* value_ptr) {
                if (!property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                    return;
                }
                auto* struct_property = RC::Unreal::CastField<RC::Unreal::FStructProperty>(property);
                if (!struct_property || !is_likely_valid_object_ptr(struct_property)) {
                    return;
                }
                auto* script_struct = resolve_struct_property_script_struct(struct_property);
                if (!script_struct || !is_likely_valid_object_ptr(script_struct)) {
                    return;
                }
                auto* owner = reinterpret_cast<RC::Unreal::UStruct*>(script_struct);
                (void)read_string_property_named(owner, value_ptr, "urlpath", out_url_path);
                (void)read_string_property_named(owner, value_ptr, "messagebody", out_request_body);
                (void)read_string_property_named(owner, value_ptr, "verb", out_verb);
            }
        );
        if (!invoked || out_url_path.empty() || out_verb.empty()) {
            char buffer[256]{};
            std::snprintf(
                buffer,
                sizeof(buffer),
                "failed to build friends leaderboard request leaderboard_id=%llu",
                static_cast<unsigned long long>(leaderboard_id)
            );
            log_user_management(now, buffer);
            return false;
        }
        return true;
    }

    bool send_friend_scores_request(
        const std::string& scenario_name,
        uint64_t leaderboard_id,
        const std::string& auth_token,
        const std::string& url_path,
        const std::string& request_body,
        const std::string& verb,
        uint64_t now
    ) {
        if (!targets_.send_sa_http_request || !is_likely_valid_object_ptr(targets_.send_sa_http_request)) {
            log_user_management(now, "Send_SAHttpRequest function not resolved");
            return false;
        }
        RC::Unreal::UObject* request_object = nullptr;
        const bool invoked = invoke_with_param_inspection(
            meta_game_instance_,
            targets_.send_sa_http_request,
            [&](RC::Unreal::FProperty* property, void* value_ptr) {
                const auto property_name = canonicalize_property_name(normalize_ascii(property->GetName()));
                if (property_name == "worldcontextobject") {
                    if (auto* object_property = RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property)) {
                        if (is_likely_valid_object_ptr(object_property)) {
                            auto* context = meta_game_instance_ && is_likely_valid_object_ptr(meta_game_instance_)
                                ? meta_game_instance_
                                : resolve_leaderboards_manager(now);
                            object_property->SetObjectPropertyValue(value_ptr, context);
                        }
                    }
                    return;
                }
                if (property_name != "params") {
                    return;
                }
                auto* struct_property = RC::Unreal::CastField<RC::Unreal::FStructProperty>(property);
                if (!struct_property || !is_likely_valid_object_ptr(struct_property)) {
                    return;
                }
                auto* script_struct = resolve_struct_property_script_struct(struct_property);
                if (!script_struct || !is_likely_valid_object_ptr(script_struct)) {
                    return;
                }
                auto* params_owner = reinterpret_cast<RC::Unreal::UStruct*>(script_struct);
                (void)write_string_property_named(params_owner, value_ptr, "steamauthtoken", auth_token);

                RC::Unreal::UStruct* network_request_owner = nullptr;
                void* network_request_ptr = nullptr;
                if (read_nested_struct_value_ptr(params_owner, value_ptr, "networkrequest", network_request_owner, network_request_ptr)) {
                    (void)write_string_property_named(network_request_owner, network_request_ptr, "urlpath", url_path);
                    (void)write_string_property_named(network_request_owner, network_request_ptr, "messagebody", request_body);
                    (void)write_string_property_named(network_request_owner, network_request_ptr, "verb", verb);
                }

                for (RC::Unreal::FProperty* nested_property : enumerate_properties_in_chain(params_owner)) {
                    if (!nested_property || !is_likely_valid_object_ptr(nested_property)) {
                        continue;
                    }
                    const auto nested_name = canonicalize_property_name(normalize_ascii(nested_property->GetName()));
                    void* nested_value_ptr = safe_property_value_ptr(nested_property, value_ptr);
                    if (!nested_value_ptr) {
                        continue;
                    }
                    if (nested_name == "maxretrycount") {
                        if (auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(nested_property)) {
                            if (is_likely_valid_object_ptr(numeric)) {
                                numeric->SetIntPropertyValue(nested_value_ptr, static_cast<int64_t>(1));
                            }
                        }
                    }
                }
            },
            [&](RC::Unreal::FProperty* property, void* value_ptr) {
                if (!property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                    return;
                }
                auto* object_property = RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property);
                if (!object_property || !is_likely_valid_object_ptr(object_property)) {
                    return;
                }
                request_object = object_property->GetObjectPropertyValue(value_ptr);
            }
        );
        if (!invoked || !request_object || !is_likely_valid_object_ptr(request_object)) {
            log_user_management(now, "Send_SAHttpRequest failed to return a request object");
            return false;
        }

        pending_friend_scores_requests_[request_object] = PendingFriendScoresRequest{
            scenario_name,
            leaderboard_id,
            now,
        };
        char buffer[320]{};
        std::snprintf(
            buffer,
            sizeof(buffer),
            "requested friends leaderboard scenario='%s' leaderboard_id=%llu url='%s'",
            scenario_name.c_str(),
            static_cast<unsigned long long>(leaderboard_id),
            url_path.c_str()
        );
        log_user_management(now, buffer);
        return true;
    }

    bool maybe_emit_friend_scores_from_manager_cache(
        const std::string& scenario_name,
        uint64_t leaderboard_id,
        uint64_t now
    ) {
        auto* manager = resolve_leaderboards_manager(now);
        if (!manager || !is_likely_valid_object_ptr(manager)) {
            return false;
        }

        auto* manager_owner = static_cast<RC::Unreal::UStruct*>(manager->GetClassPrivate());
        if (!manager_owner || !is_likely_valid_object_ptr(manager_owner)) {
            return false;
        }

        RC::Unreal::UObject* entries_cache = nullptr;
        if (!read_object_property_named(manager_owner, manager, "leaderboardsentriescache", entries_cache)) {
            log_user_management(now, "friends leaderboard cache object not available");
            return false;
        }
        if (!entries_cache || !is_likely_valid_object_ptr(entries_cache)) {
            log_user_management(now, "friends leaderboard cache pointer invalid");
            return false;
        }
        auto* cache_owner = static_cast<RC::Unreal::UStruct*>(entries_cache->GetClassPrivate());
        if (!cache_owner || !is_likely_valid_object_ptr(cache_owner)) {
            return false;
        }

        RC::Unreal::FProperty* pair_array_property = nullptr;
        void* pair_array_value_ptr = nullptr;
        for (RC::Unreal::FProperty* property : enumerate_properties_in_chain(cache_owner)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (canonicalize_property_name(normalize_ascii(property->GetName())) != "leaderboardentrypairs") {
                continue;
            }
            pair_array_property = property;
            pair_array_value_ptr = safe_property_value_ptr(property, entries_cache);
            break;
        }
        auto* pair_array = RC::Unreal::CastField<RC::Unreal::FArrayProperty>(pair_array_property);
        if (!pair_array || !is_likely_valid_object_ptr(pair_array) || !pair_array_value_ptr) {
            return false;
        }
        auto* pair_inner_struct = RC::Unreal::CastField<RC::Unreal::FStructProperty>(pair_array->GetInner());
        if (!pair_inner_struct || !is_likely_valid_object_ptr(pair_inner_struct)) {
            return false;
        }
        auto* pair_script_struct = resolve_struct_property_script_struct(pair_inner_struct);
        if (!pair_script_struct || !is_likely_valid_object_ptr(pair_script_struct)) {
            return false;
        }
        auto* pair_owner = reinterpret_cast<RC::Unreal::UStruct*>(pair_script_struct);
        auto* pair_script_array = reinterpret_cast<RC::Unreal::FScriptArray*>(pair_array_value_ptr);
        if (!pair_script_array || !is_likely_readable_region(pair_script_array, sizeof(RC::Unreal::FScriptArray))) {
            return false;
        }

        auto* pair_inner = pair_array->GetInner();
        if (!pair_inner || !is_likely_valid_object_ptr(pair_inner)) {
            return false;
        }
        const size_t pair_element_size = static_cast<size_t>(pair_inner->GetElementSize());
        auto* pair_data = static_cast<uint8_t*>(pair_script_array->GetData());
        const int32_t pair_count = pair_script_array->Num();
        if (pair_count <= 0 || !pair_data || pair_element_size == 0) {
            return false;
        }

        std::vector<BridgeFriendScoreEntry> entries{};
        entries.reserve(static_cast<size_t>(pair_count));
        std::unordered_map<std::string, uint8_t> seen_steam_ids{};
        seen_steam_ids.reserve(static_cast<size_t>(pair_count) * 2);
        for (int32_t pair_index = 0; pair_index < pair_count; ++pair_index) {
            void* pair_ptr = pair_data + (static_cast<size_t>(pair_index) * pair_element_size);
            RC::Unreal::FProperty* entries_property = nullptr;
            void* entries_value_ptr = nullptr;
            for (RC::Unreal::FProperty* property : enumerate_properties_in_chain(pair_owner)) {
                if (!property || !is_likely_valid_object_ptr(property)) {
                    continue;
                }
                if (canonicalize_property_name(normalize_ascii(property->GetName())) != "entries") {
                    continue;
                }
                entries_property = property;
                entries_value_ptr = safe_property_value_ptr(property, pair_ptr);
                break;
            }
            auto* entries_array = RC::Unreal::CastField<RC::Unreal::FArrayProperty>(entries_property);
            if (!entries_array || !is_likely_valid_object_ptr(entries_array) || !entries_value_ptr) {
                continue;
            }
            auto* entry_inner_struct = RC::Unreal::CastField<RC::Unreal::FStructProperty>(entries_array->GetInner());
            if (!entry_inner_struct || !is_likely_valid_object_ptr(entry_inner_struct)) {
                continue;
            }
            auto* entry_script_struct = resolve_struct_property_script_struct(entry_inner_struct);
            if (!entry_script_struct || !is_likely_valid_object_ptr(entry_script_struct)) {
                continue;
            }
            auto* entry_owner = reinterpret_cast<RC::Unreal::UStruct*>(entry_script_struct);
            auto* entry_script_array = reinterpret_cast<RC::Unreal::FScriptArray*>(entries_value_ptr);
            if (!entry_script_array || !is_likely_readable_region(entry_script_array, sizeof(RC::Unreal::FScriptArray))) {
                continue;
            }
            auto* entry_inner = entries_array->GetInner();
            if (!entry_inner || !is_likely_valid_object_ptr(entry_inner)) {
                continue;
            }
            const size_t entry_element_size = static_cast<size_t>(entry_inner->GetElementSize());
            auto* entry_data = static_cast<uint8_t*>(entry_script_array->GetData());
            const int32_t entry_count = entry_script_array->Num();
            if (entry_count <= 0 || !entry_data || entry_element_size == 0) {
                continue;
            }

            for (int32_t entry_index = 0; entry_index < entry_count; ++entry_index) {
                void* entry_ptr = entry_data + (static_cast<size_t>(entry_index) * entry_element_size);
                BridgeFriendScoreEntry entry{};
                OpaqueSteamId steam_id_value{};
                RC::Unreal::UStruct* id_owner = nullptr;
                void* id_ptr = nullptr;
                if (read_nested_struct_value_ptr(entry_owner, entry_ptr, "id", id_owner, id_ptr)
                    && id_ptr && is_likely_readable_region(id_ptr, sizeof(steam_id_value))) {
                    std::memcpy(&steam_id_value, id_ptr, sizeof(steam_id_value));
                    entry.steam_id = opaque_steam_id_to_string(steam_id_value);
                } else {
                    continue;
                }
                if (entry.steam_id.empty()) {
                    continue;
                }
                if (!seen_steam_ids.emplace(entry.steam_id, 0).second) {
                    continue;
                }
                (void)read_string_property_named(entry_owner, entry_ptr, "playersteamname", entry.display_name);
                (void)read_i32_property_named(entry_owner, entry_ptr, "score", entry.score);
                (void)read_i32_property_named(entry_owner, entry_ptr, "globalrank", entry.rank);
                bool plus_active = false;
                for (RC::Unreal::FProperty* property : enumerate_properties_in_chain(entry_owner)) {
                    if (!property || !is_likely_valid_object_ptr(property)) {
                        continue;
                    }
                    if (canonicalize_property_name(normalize_ascii(property->GetName())) != "kovaaksplusactive") {
                        continue;
                    }
                    void* value_ptr = safe_property_value_ptr(property, entry_ptr);
                    if (value_ptr && read_bool_property_value(property, value_ptr, plus_active)) {
                        entry.kovaaks_plus_active = plus_active;
                    }
                    break;
                }
                entries.emplace_back(std::move(entry));
            }
        }

        if (entries.empty()) {
            char buffer[192]{};
            std::snprintf(
                buffer,
                sizeof(buffer),
                "friends leaderboard cache empty scenario='%s' pair_count=%d",
                scenario_name.c_str(),
                pair_count
            );
            log_user_management(now, buffer);
            return false;
        }

        (void)emit_friend_scores_snapshot(
            "leaderboards_manager_cache",
            scenario_name,
            leaderboard_id,
            entries,
            now
        );

        char buffer[256]{};
        std::snprintf(
            buffer,
            sizeof(buffer),
            "emitted friends leaderboard cache snapshot scenario='%s' entries=%zu",
            scenario_name.c_str(),
            entries.size()
        );
        log_user_management(now, buffer);
        return true;
    }

    bool maybe_emit_friend_scores_from_widget(
        const std::string& scenario_name,
        uint64_t leaderboard_id,
        uint64_t now
    ) {
        auto* widget = resolve_active_leaderboards_widget(now);
        if (!widget || !is_likely_valid_object_ptr(widget)) {
            return false;
        }
        auto* widget_owner = static_cast<RC::Unreal::UStruct*>(widget->GetClassPrivate());
        if (!widget_owner || !is_likely_valid_object_ptr(widget_owner)) {
            return false;
        }

        uint64_t widget_leaderboard_id = 0;
        RC::Unreal::UStruct* requested_owner = nullptr;
        void* requested_ptr = nullptr;
        if (read_nested_struct_value_ptr(
                widget_owner,
                widget,
                "currentmetaleaderboardrequested",
                requested_owner,
                requested_ptr
            )) {
            (void)read_u64_property_named(requested_owner, requested_ptr, "value", widget_leaderboard_id);
        }

        std::string widget_scenario_name{};
        (void)read_string_property_named(widget_owner, widget, "currentleaderboardname", widget_scenario_name);
        const bool leaderboard_matches = widget_leaderboard_id != 0 && widget_leaderboard_id == leaderboard_id;
        const bool scenario_matches =
            !widget_scenario_name.empty()
            && normalize_ascii(string_type_from_utf8(widget_scenario_name.c_str()))
                == normalize_ascii(string_type_from_utf8(scenario_name.c_str()));
        if (!leaderboard_matches && !scenario_matches) {
            return false;
        }

        RC::Unreal::FProperty* players_property = nullptr;
        void* players_value_ptr = nullptr;
        for (RC::Unreal::FProperty* property : enumerate_properties_in_chain(widget_owner)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (canonicalize_property_name(normalize_ascii(property->GetName())) != "currentleaderboardplayers") {
                continue;
            }
            players_property = property;
            players_value_ptr = safe_property_value_ptr(property, widget);
            break;
        }
        auto* players_array = RC::Unreal::CastField<RC::Unreal::FArrayProperty>(players_property);
        if (!players_array || !is_likely_valid_object_ptr(players_array) || !players_value_ptr) {
            return false;
        }
        auto* player_inner_struct = RC::Unreal::CastField<RC::Unreal::FStructProperty>(players_array->GetInner());
        if (!player_inner_struct || !is_likely_valid_object_ptr(player_inner_struct)) {
            return false;
        }
        auto* player_script_struct = resolve_struct_property_script_struct(player_inner_struct);
        if (!player_script_struct || !is_likely_valid_object_ptr(player_script_struct)) {
            return false;
        }
        auto* player_owner = reinterpret_cast<RC::Unreal::UStruct*>(player_script_struct);
        auto* player_script_array = reinterpret_cast<RC::Unreal::FScriptArray*>(players_value_ptr);
        if (!player_script_array || !is_likely_readable_region(player_script_array, sizeof(RC::Unreal::FScriptArray))) {
            return false;
        }
        auto* player_inner = players_array->GetInner();
        if (!player_inner || !is_likely_valid_object_ptr(player_inner)) {
            return false;
        }
        const size_t player_element_size = static_cast<size_t>(player_inner->GetElementSize());
        auto* player_data = static_cast<uint8_t*>(player_script_array->GetData());
        const int32_t player_count = player_script_array->Num();
        if (player_count <= 0 || !player_data || player_element_size == 0) {
            return false;
        }

        std::vector<BridgeFriendScoreEntry> entries{};
        entries.reserve(static_cast<size_t>(player_count));
        std::unordered_map<std::string, uint8_t> seen_steam_ids{};
        seen_steam_ids.reserve(static_cast<size_t>(player_count) * 2);
        for (int32_t index = 0; index < player_count; ++index) {
            void* player_ptr = player_data + (static_cast<size_t>(index) * player_element_size);
            BridgeFriendScoreEntry entry{};
            RC::Unreal::UStruct* steam_id_owner = nullptr;
            void* steam_id_ptr = nullptr;
            OpaqueSteamId steam_id_value{};
            if (read_nested_struct_value_ptr(player_owner, player_ptr, "steamid", steam_id_owner, steam_id_ptr)
                && steam_id_ptr && is_likely_readable_region(steam_id_ptr, sizeof(steam_id_value))) {
                std::memcpy(&steam_id_value, steam_id_ptr, sizeof(steam_id_value));
                entry.steam_id = opaque_steam_id_to_string(steam_id_value);
            }
            if (entry.steam_id.empty()) {
                continue;
            }
            if (!seen_steam_ids.emplace(entry.steam_id, 0).second) {
                continue;
            }

            double score_value = 0.0;
            (void)read_string_property_named(player_owner, player_ptr, "playername", entry.display_name);
            (void)read_f64_property_named(player_owner, player_ptr, "score", score_value);
            (void)read_i32_property_named(player_owner, player_ptr, "rank", entry.rank);
            entry.score = static_cast<int32_t>(std::llround(score_value));

            bool plus_active = false;
            for (RC::Unreal::FProperty* property : enumerate_properties_in_chain(player_owner)) {
                if (!property || !is_likely_valid_object_ptr(property)) {
                    continue;
                }
                if (canonicalize_property_name(normalize_ascii(property->GetName())) != "kovaaksplusactive") {
                    continue;
                }
                void* value_ptr = safe_property_value_ptr(property, player_ptr);
                if (value_ptr && read_bool_property_value(property, value_ptr, plus_active)) {
                    entry.kovaaks_plus_active = plus_active;
                }
                break;
            }
            entries.emplace_back(std::move(entry));
        }

        if (entries.empty()) {
            return false;
        }
        (void)emit_friend_scores_snapshot(
            "leaderboards_widget",
            scenario_name,
            leaderboard_id,
            entries,
            now
        );
        char buffer[256]{};
        std::snprintf(
            buffer,
            sizeof(buffer),
            "emitted widget friends leaderboard snapshot scenario='%s' entries=%zu",
            scenario_name.c_str(),
            entries.size()
        );
        log_user_management(now, buffer);
        return true;
    }

    bool maybe_refresh_sa_http_auth_token(uint64_t now) {
        if (!last_sa_http_auth_token_.empty()) {
            return true;
        }

        auto* steam_network_model = resolve_steam_network_model(now);
        if (!steam_network_model || !is_likely_valid_object_ptr(steam_network_model)) {
            return false;
        }

        if (!steam_network_model_get_auth_token_value_or_fn_
            || !is_likely_valid_object_ptr(steam_network_model_get_auth_token_value_or_fn_)) {
            steam_network_model_get_auth_token_value_or_fn_ =
                RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                    nullptr,
                    nullptr,
                    STR("/Script/KovaaKNetworkModels.SteamNetworkModel:Get_AuthToken_ValueOr")
                );
        }
        if (!steam_network_model_get_auth_token_value_or_fn_
            || !is_likely_valid_object_ptr(steam_network_model_get_auth_token_value_or_fn_)) {
            log_user_management(now, "SteamNetworkModel Get_AuthToken_ValueOr function not found");
            return false;
        }

        std::string auth_token{};
        bool saw_out_value = false;
        const bool invoked = invoke_with_param_inspection(
            steam_network_model,
            steam_network_model_get_auth_token_value_or_fn_,
            [&](RC::Unreal::FProperty* property, void* value_ptr) {
                const auto property_name = canonicalize_property_name(normalize_ascii(property->GetName()));
                if (property_name != "valueifnull") {
                    return;
                }
                auto* struct_property = RC::Unreal::CastField<RC::Unreal::FStructProperty>(property);
                if (!struct_property || !is_likely_valid_object_ptr(struct_property)) {
                    return;
                }
                auto* script_struct = resolve_struct_property_script_struct(struct_property);
                if (!script_struct || !is_likely_valid_object_ptr(script_struct)) {
                    return;
                }
                auto* owner = reinterpret_cast<RC::Unreal::UStruct*>(script_struct);
                (void)write_string_property_named(owner, value_ptr, "value", "");
            },
            [&](RC::Unreal::FProperty* property, void* value_ptr) {
                const auto property_name = canonicalize_property_name(normalize_ascii(property->GetName()));
                if (property_name != "outvalue") {
                    return;
                }
                auto* struct_property = RC::Unreal::CastField<RC::Unreal::FStructProperty>(property);
                if (!struct_property || !is_likely_valid_object_ptr(struct_property)) {
                    return;
                }
                auto* script_struct = resolve_struct_property_script_struct(struct_property);
                if (!script_struct || !is_likely_valid_object_ptr(script_struct)) {
                    return;
                }
                saw_out_value = true;
                auto* owner = reinterpret_cast<RC::Unreal::UStruct*>(script_struct);
                (void)read_string_property_named(owner, value_ptr, "value", auth_token);
            }
        );
        if (!invoked) {
            log_user_management(now, "SteamNetworkModel Get_AuthToken_ValueOr invoke failed");
            return false;
        }
        if (!saw_out_value || auth_token.empty()) {
            if (now >= next_auth_token_request_ms_) {
                next_auth_token_request_ms_ = now + 10000;
                if (!send_steam_auth_token_request_fn_
                    || !is_likely_valid_object_ptr(send_steam_auth_token_request_fn_)) {
                    send_steam_auth_token_request_fn_ =
                        RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                            nullptr,
                            nullptr,
                            STR("/Script/KovaaKNetworkUtils.Send_SteamAuthTokenRequest:Send_SteamAuthTokenRequest")
                        );
                }
                if (!send_steam_auth_token_request_fn_
                    || !is_likely_valid_object_ptr(send_steam_auth_token_request_fn_)) {
                    log_user_management(now, "Send_SteamAuthTokenRequest function not found");
                } else {
                    const bool requested = invoke_with_param_inspection(
                        nullptr,
                        send_steam_auth_token_request_fn_,
                        [&](RC::Unreal::FProperty* property, void* value_ptr) {
                            const auto property_name =
                                canonicalize_property_name(normalize_ascii(property->GetName()));
                            if (property_name == "worldcontextobject") {
                                if (auto* object_property =
                                        RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property)) {
                                    if (is_likely_valid_object_ptr(object_property)
                                        && meta_game_instance_ && is_likely_valid_object_ptr(meta_game_instance_)) {
                                        object_property->SetObjectPropertyValue(value_ptr, meta_game_instance_);
                                    }
                                }
                                return;
                            }
                            if (property_name == "intimeoutseconds") {
                                if (auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property)) {
                                    if (is_likely_valid_object_ptr(numeric)) {
                                        numeric->SetFloatingPointPropertyValue(value_ptr, 10.0);
                                    }
                                }
                            }
                        },
                        [](RC::Unreal::FProperty*, void*) {}
                    );
                    if (requested) {
                        log_user_management(now, "requested Steam auth token refresh");
                    } else {
                        log_user_management(now, "Send_SteamAuthTokenRequest invoke failed");
                    }
                }
            }
            log_user_management(now, "SteamNetworkModel Get_AuthToken_ValueOr returned no token");
            return false;
        }

        last_sa_http_auth_token_ = auth_token;
        char buffer[192]{};
        std::snprintf(
            buffer,
            sizeof(buffer),
            "resolved SA auth token via SteamNetworkModel bytes=%zu",
            last_sa_http_auth_token_.size()
        );
        log_user_management(now, buffer);
        return true;
    }

    void maybe_request_active_friend_scores(uint64_t now, bool force) {
        prune_pending_friend_scores_requests(now);

        const auto scenario_name = current_user_management_scenario_name();
        if (scenario_name.empty()) {
            log_user_management(now, "friends leaderboard skipped without active scenario");
            return;
        }
        if (now < next_friend_scores_refresh_ms_ && scenario_name == last_friend_scores_scenario_) {
            return;
        }
        if (!force && is_user_management_live_gameplay_active()) {
            (void)maybe_emit_persisted_friend_scores_snapshot(scenario_name, 0, now);
            next_friend_scores_refresh_ms_ = now + 15000;
            return;
        }

        uint64_t leaderboard_id = 0;
        if (!read_leaderboard_id_for_scenario(scenario_name, leaderboard_id, now)) {
            if (maybe_emit_persisted_friend_scores_snapshot(scenario_name, 0, now)) {
                next_friend_scores_refresh_ms_ = now + 10000;
            }
            return;
        }
        if (maybe_emit_friend_scores_from_widget(scenario_name, leaderboard_id, now)) {
            last_friend_scores_scenario_ = scenario_name;
            last_friend_scores_leaderboard_id_ = leaderboard_id;
            next_friend_scores_refresh_ms_ = now + 30000;
            return;
        }

        const bool emitted_persisted_cache = maybe_emit_persisted_friend_scores_snapshot(scenario_name, leaderboard_id, now);

        if (!maybe_refresh_sa_http_auth_token(now)) {
            if (!emitted_persisted_cache) {
                log_user_management(now, "friends leaderboard request waiting for SA auth token");
            }
            if (emitted_persisted_cache) {
                next_friend_scores_refresh_ms_ = now + 10000;
            }
            return;
        }

        std::string url_path{};
        std::string request_body{};
        std::string verb{};
        if (!build_friend_scores_network_request(leaderboard_id, url_path, request_body, verb, now)) {
            if (emitted_persisted_cache) {
                next_friend_scores_refresh_ms_ = now + 10000;
            }
            return;
        }

        if (!send_friend_scores_request(
                scenario_name,
                leaderboard_id,
                last_sa_http_auth_token_,
                url_path,
                request_body,
                verb,
                now
            )) {
            if (emitted_persisted_cache) {
                next_friend_scores_refresh_ms_ = now + 10000;
            }
            return;
        }

        last_friend_scores_scenario_ = scenario_name;
        last_friend_scores_leaderboard_id_ = leaderboard_id;
        next_friend_scores_refresh_ms_ = now + 30000;
    }

    void handle_user_management_http_response(
        RC::Unreal::UObject* request_object,
        bool success,
        int32_t response_code,
        const std::string& response_contents,
        uint64_t now
    ) {
        if (!request_object || !is_likely_valid_object_ptr(request_object)) {
            return;
        }
        const auto it = pending_friend_scores_requests_.find(request_object);
        if (it == pending_friend_scores_requests_.end()) {
            return;
        }

        const auto request = it->second;
        pending_friend_scores_requests_.erase(it);
        if (!success || response_code < 200 || response_code >= 300 || response_contents.empty()) {
            char buffer[256]{};
            std::snprintf(
                buffer,
                sizeof(buffer),
                "friends leaderboard request failed scenario='%s' code=%d",
                request.scenario_name.c_str(),
                response_code
            );
            log_user_management(now, buffer);
            return;
        }

        std::string payload = "{\"ev\":\"kovaaks_friend_scores_snapshot\",\"source\":\"steam_sa_friends_leaderboard\",\"scenario_name\":\"";
        payload = build_friend_scores_event_payload(
            "steam_sa_friends_leaderboard",
            request.scenario_name,
            request.leaderboard_id,
            response_code,
            response_contents
        );
        if (payload.empty()) {
            return;
        }

        last_friend_scores_response_ms_ = now;
        persist_friend_scores_cache(
            request.scenario_name,
            request.leaderboard_id,
            response_code,
            response_contents,
            now
        );
        if (payload != last_emitted_friend_scores_snapshot_) {
            last_emitted_friend_scores_snapshot_ = payload;
            kovaaks::RustBridge::emit_json(payload.c_str());
        }

        char buffer[320]{};
        std::snprintf(
            buffer,
            sizeof(buffer),
            "received friends leaderboard scenario='%s' leaderboard_id=%llu bytes=%zu",
            request.scenario_name.c_str(),
            static_cast<unsigned long long>(request.leaderboard_id),
            response_contents.size()
        );
        log_user_management(now, buffer);
    }

    bool read_uworks_current_user(BridgeCurrentUserProfile& out_user, uint64_t now) {
        out_user = {};
        auto* user_interface = resolve_uworks_core_user(now);
        if (!user_interface || !is_likely_valid_object_ptr(user_interface)) {
            return false;
        }

        if (!uworks_b_logged_on_fn_ || !is_likely_valid_object_ptr(uworks_b_logged_on_fn_)) {
            uworks_b_logged_on_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr,
                nullptr,
                STR("/Script/UWorksCore.UWorksInterfaceCoreUser:BLoggedOn")
            );
        }
        if (!uworks_get_steam_id_fn_ || !is_likely_valid_object_ptr(uworks_get_steam_id_fn_)) {
            uworks_get_steam_id_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr,
                nullptr,
                STR("/Script/UWorksCore.UWorksInterfaceCoreUser:GetSteamID")
            );
        }
        if (!uworks_get_persona_name_fn_ || !is_likely_valid_object_ptr(uworks_get_persona_name_fn_)) {
            uworks_get_persona_name_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr,
                nullptr,
                STR("/Script/UWorksCore.UWorksInterfaceCoreFriends:GetPersonaName")
            );
        }
        if (!uworks_get_steam_id_fn_ || !is_likely_valid_object_ptr(uworks_get_steam_id_fn_)) {
            log_user_management(now, "UWorks GetSteamID function not found");
            return false;
        }

        bool is_logged_on = true;
        if (uworks_b_logged_on_fn_ && is_likely_valid_object_ptr(uworks_b_logged_on_fn_)) {
            const bool read_logged_on = invoke_bool_return(
                user_interface,
                uworks_b_logged_on_fn_,
                [](RC::Unreal::FProperty*, void*) {},
                is_logged_on
            );
            if (read_logged_on && !is_logged_on) {
                log_user_management(now, "UWorks user interface reports BLoggedOn=false");
                return false;
            }
        }

        OpaqueSteamId steam_id_value{};
        if (!invoke_struct_return(
                user_interface,
                uworks_get_steam_id_fn_,
                [](RC::Unreal::FProperty*, void*) {},
                steam_id_value
            )) {
            log_user_management(now, "UWorks GetSteamID returned no readable value");
            return false;
        }

        out_user.steam_id = opaque_steam_id_to_string(steam_id_value);
        if (out_user.steam_id.empty()) {
            log_user_management(now, "UWorks GetSteamID produced an empty SteamID64");
            return false;
        }

        if (auto* friends_interface = resolve_uworks_core_friends(now)) {
            (void)invoke_string_return(
                friends_interface,
                uworks_get_persona_name_fn_,
                [](RC::Unreal::FProperty*, void*) {},
                out_user.steam_name
            );
        }

        out_user.external_id = std::string("steam:") + out_user.steam_id;
        out_user.display_name = !out_user.steam_name.empty() ? out_user.steam_name : out_user.steam_id;

        BridgeLinkedIdentity steam_account{};
        steam_account.provider = "steam";
        steam_account.provider_account_id = out_user.steam_id;
        steam_account.username = !out_user.steam_name.empty() ? out_user.steam_name : out_user.steam_id;
        steam_account.display_name = out_user.display_name;
        out_user.linked_accounts.emplace_back(std::move(steam_account));
        (void)enrich_user_from_auth_token_claims(out_user, now);
        return true;
    }

    bool read_uworks_social_friends(
        std::vector<BridgeSocialFriendProfile>& out_friends,
        uint64_t now
    ) {
        out_friends.clear();
        auto* friends_interface = resolve_uworks_core_friends(now);
        if (!friends_interface || !is_likely_valid_object_ptr(friends_interface)) {
            return false;
        }

        if (!uworks_get_friend_count_fn_ || !is_likely_valid_object_ptr(uworks_get_friend_count_fn_)) {
            uworks_get_friend_count_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr,
                nullptr,
                STR("/Script/UWorksCore.UWorksInterfaceCoreFriends:GetFriendCount")
            );
        }
        if (!uworks_get_friend_by_index_fn_ || !is_likely_valid_object_ptr(uworks_get_friend_by_index_fn_)) {
            uworks_get_friend_by_index_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr,
                nullptr,
                STR("/Script/UWorksCore.UWorksInterfaceCoreFriends:GetFriendByIndex")
            );
        }
        if (!uworks_get_friend_persona_name_fn_ || !is_likely_valid_object_ptr(uworks_get_friend_persona_name_fn_)) {
            uworks_get_friend_persona_name_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr,
                nullptr,
                STR("/Script/UWorksCore.UWorksInterfaceCoreFriends:GetFriendPersonaName")
            );
        }
        if (!uworks_get_friend_count_fn_ || !is_likely_valid_object_ptr(uworks_get_friend_count_fn_)
            || !uworks_get_friend_by_index_fn_ || !is_likely_valid_object_ptr(uworks_get_friend_by_index_fn_)
            || !uworks_get_friend_persona_name_fn_ || !is_likely_valid_object_ptr(uworks_get_friend_persona_name_fn_)) {
            log_user_management(now, "UWorks friends functions not fully available");
            return false;
        }

        auto read_friend_count = [&](uint8_t friend_flag, int32_t& out_count) -> bool {
            uint8_t flag_storage[1]{friend_flag};
            return invoke_i32_return(
                friends_interface,
                uworks_get_friend_count_fn_,
                [&](RC::Unreal::FProperty* property, void* value_ptr) {
                    const auto property_name = canonicalize_property_name(normalize_ascii(property->GetName()));
                    if (property_name == "friendflags") {
                        (void)assign_script_array_bytes(value_ptr, flag_storage, 1);
                    }
                },
                out_count
            );
        };

        uint8_t active_friend_flag = 2;
        int32_t friend_count = 0;
        const bool have_immediate_count = read_friend_count(active_friend_flag, friend_count);
        if ((!have_immediate_count || friend_count <= 0) && read_friend_count(13, friend_count)) {
            active_friend_flag = 13;
        }
        if (friend_count <= 0) {
            log_user_management(now, "UWorks GetFriendCount returned no Steam friends");
            return false;
        }

        out_friends.reserve(static_cast<size_t>(friend_count));
        std::unordered_map<std::string, uint8_t> seen_steam_ids{};
        seen_steam_ids.reserve(static_cast<size_t>(friend_count) * 2);
        for (int32_t index = 0; index < friend_count; ++index) {
            uint8_t flag_storage[1]{active_friend_flag};
            OpaqueSteamId friend_id_value{};
            const bool got_friend_id = invoke_struct_return(
                friends_interface,
                uworks_get_friend_by_index_fn_,
                [&](RC::Unreal::FProperty* property, void* value_ptr) {
                    const auto property_name = canonicalize_property_name(normalize_ascii(property->GetName()));
                    if (property_name == "friend") {
                        *reinterpret_cast<int32_t*>(value_ptr) = index;
                        return;
                    }
                    if (property_name == "friendflags") {
                        (void)assign_script_array_bytes(value_ptr, flag_storage, 1);
                    }
                },
                friend_id_value
            );
            if (!got_friend_id) {
                continue;
            }

            BridgeSocialFriendProfile friend_profile{};
            friend_profile.platform = "steam";
            friend_profile.steam_id = opaque_steam_id_to_string(friend_id_value);
            if (friend_profile.steam_id.empty()) {
                continue;
            }
            if (!seen_steam_ids.emplace(friend_profile.steam_id, 0).second) {
                continue;
            }

            (void)invoke_string_return(
                friends_interface,
                uworks_get_friend_persona_name_fn_,
                [&](RC::Unreal::FProperty* property, void* value_ptr) {
                    const auto property_name = canonicalize_property_name(normalize_ascii(property->GetName()));
                    if (property_name == "steamidfriend") {
                        std::memcpy(value_ptr, &friend_id_value, sizeof(friend_id_value));
                    }
                },
                friend_profile.display_name
            );

            if (friend_profile.display_name.empty()) {
                friend_profile.display_name = friend_profile.steam_id;
            }
            friend_profile.username = friend_profile.steam_id;
            out_friends.emplace_back(std::move(friend_profile));
        }

        if (out_friends.empty()) {
            log_user_management(now, "UWorks returned no readable Steam friends");
            return false;
        }
        return true;
    }

    std::string serialize_bridge_user_snapshot(
        const BridgeCurrentUserProfile& user,
        const char* source
    ) const {
        std::string json;
        json.reserve(512 + (user.linked_accounts.size() * 160));
        json += "{\"ev\":\"kovaaks_user_snapshot\",\"source\":\"";
        json += escape_json_ascii(source ? source : "unknown");
        json += "\",\"username\":\"";
        json += escape_json_ascii(user.username);
        json += "\",\"display_name\":\"";
        json += escape_json_ascii(user.display_name);
        json += "\",\"avatar_url\":\"";
        json += escape_json_ascii(user.avatar_url);
        json += "\",\"kovaaks_user_id\":\"";
        json += escape_json_ascii(user.kovaaks_user_id);
        json += "\",\"external_id\":\"";
        json += escape_json_ascii(user.external_id);
        json += "\",\"steam_id\":\"";
        json += escape_json_ascii(user.steam_id);
        json += "\",\"steam_name\":\"";
        json += escape_json_ascii(user.steam_name);
        json += "\",\"linked_accounts\":[";
        for (size_t index = 0; index < user.linked_accounts.size(); ++index) {
            const auto& account = user.linked_accounts[index];
            if (index > 0) {
                json += ",";
            }
            json += "{\"provider\":\"";
            json += escape_json_ascii(account.provider);
            json += "\",\"provider_account_id\":\"";
            json += escape_json_ascii(account.provider_account_id);
            json += "\",\"username\":\"";
            json += escape_json_ascii(account.username);
            json += "\",\"display_name\":\"";
            json += escape_json_ascii(account.display_name);
            json += "\",\"avatar_url\":\"";
            json += escape_json_ascii(account.avatar_url);
            json += "\"}";
        }
        json += "]}";
        return json;
    }

    std::string serialize_bridge_friends_snapshot(
        const std::vector<BridgeSocialFriendProfile>& friends,
        const char* source
    ) const {
        std::string json;
        json.reserve(256 + (friends.size() * 160));
        json += "{\"ev\":\"kovaaks_friends_snapshot\",\"source\":\"";
        json += escape_json_ascii(source ? source : "unknown");
        json += "\",\"count\":";
        json += std::to_string(friends.size());
        json += ",\"friends\":[";
        for (size_t index = 0; index < friends.size(); ++index) {
            const auto& friend_profile = friends[index];
            if (index > 0) {
                json += ",";
            }
            json += "{\"platform\":\"";
            json += escape_json_ascii(friend_profile.platform);
            json += "\",\"username\":\"";
            json += escape_json_ascii(friend_profile.username);
            json += "\",\"display_name\":\"";
            json += escape_json_ascii(friend_profile.display_name);
            json += "\",\"avatar_url\":\"";
            json += escape_json_ascii(friend_profile.avatar_url);
            json += "\",\"steam_id\":\"";
            json += escape_json_ascii(friend_profile.steam_id);
            json += "\",\"kovaaks_user_id\":\"";
            json += escape_json_ascii(friend_profile.kovaaks_user_id);
            json += "\"}";
        }
        json += "]}";
        return json;
    }

    void maybe_emit_user_management_snapshot(uint64_t now, bool force) {
        if (!rust_ready_ || !kovaaks::RustBridge::is_connected()) {
            return;
        }
        if (!force && now < next_user_bridge_refresh_ms_) {
            return;
        }
        const bool live_gameplay_active = !force && is_user_management_live_gameplay_active();
        next_user_bridge_refresh_ms_ = now + (force ? 1000 : (live_gameplay_active ? 15000 : 5000));

        if (live_gameplay_active) {
            maybe_request_active_friend_scores(now, false);
            return;
        }

        if (!should_refresh_user_management_user_profile()) {
            maybe_request_active_friend_scores(now, force);
            return;
        }

        BridgeCurrentUserProfile user{};
        const char* user_source = "";
        bool have_user = false;
        if (read_uworks_current_user(user, now)) {
            have_user = true;
            user_source = "steam_uworks";
        }
        if (have_user) {
            if (force
                || !has_last_emitted_user_profile_
                || last_emitted_user_source_ != user_source
                || !bridge_current_user_profile_equals(user, last_emitted_user_profile_)) {
                const auto payload = serialize_bridge_user_snapshot(user, user_source);
                last_emitted_user_snapshot_ = payload;
                last_emitted_user_source_ = user_source;
                last_emitted_user_profile_ = user;
                has_last_emitted_user_profile_ = true;
                kovaaks::RustBridge::emit_json(payload.c_str());
            }
        }

        maybe_request_active_friend_scores(now, force);
        if (!have_user) {
            log_user_management(now, "tick produced no user");
        }
    }
