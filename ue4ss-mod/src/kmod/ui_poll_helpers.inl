    static auto try_parse_int_text(const RC::StringType& text, int32_t& out_value) -> bool {
        if (text.empty()) {
            return false;
        }
        bool seen_digit = false;
        bool negative = false;
        int64_t accum = 0;
        for (size_t i = 0; i < text.size(); ++i) {
            const auto ch = text[i];
            if (!seen_digit && ch == STR('-')) {
                negative = true;
                continue;
            }
            if (ch >= STR('0') && ch <= STR('9')) {
                seen_digit = true;
                accum = (accum * 10) + static_cast<int64_t>(ch - STR('0'));
                if (accum > 2147483647LL) {
                    accum = 2147483647LL;
                }
            }
        }
        if (!seen_digit) {
            return false;
        }
        if (negative) {
            accum = -accum;
        }
        out_value = static_cast<int32_t>(accum);
        return true;
    }

    static auto try_parse_float_text(const RC::StringType& text, float& out_value) -> bool {
        std::string buffer;
        buffer.reserve(text.size());
        bool seen_digit = false;
        bool seen_dot = false;
        bool seen_sign = false;
        for (size_t i = 0; i < text.size(); ++i) {
            const auto ch = static_cast<char>(text[i]);
            if (ch >= '0' && ch <= '9') {
                buffer.push_back(ch);
                seen_digit = true;
                continue;
            }
            if (ch == '.' && !seen_dot) {
                buffer.push_back(ch);
                seen_dot = true;
                continue;
            }
            if (ch == ',' || ch == ' ') {
                continue;
            }
            if ((ch == '-' || ch == '+') && !seen_sign && !seen_digit) {
                buffer.push_back(ch);
                seen_sign = true;
                continue;
            }
        }
        if (!seen_digit || buffer.empty()) {
            return false;
        }
        char* end_ptr = nullptr;
        const float parsed = std::strtof(buffer.c_str(), &end_ptr);
        if (end_ptr == buffer.c_str() || (end_ptr && *end_ptr != '\0')) {
            return false;
        }
        out_value = parsed;
        return std::isfinite(out_value);
    }

    static auto try_parse_time_to_seconds(const RC::StringType& text, float& out_seconds) -> bool {
        std::vector<int32_t> parts{};
        parts.reserve(3);
        int32_t accum = 0;
        bool seen_digit = false;
        bool any_digit = false;
        for (size_t i = 0; i < text.size(); ++i) {
            const auto ch = static_cast<char>(text[i]);
            if (ch >= '0' && ch <= '9') {
                seen_digit = true;
                any_digit = true;
                accum = (accum * 10) + static_cast<int32_t>(ch - '0');
                continue;
            }
            if (ch == ':') {
                parts.push_back(accum);
                accum = 0;
                seen_digit = false;
                continue;
            }
            if (seen_digit) {
                // stop on first non-time token after a number segment
                break;
            }
        }
        if (seen_digit || !parts.empty()) {
            parts.push_back(accum);
        }
        if (parts.empty() || !any_digit) {
            return false;
        }
        int64_t total_seconds = 0;
        if (parts.size() == 3) {
            total_seconds = static_cast<int64_t>(parts[0]) * 3600LL
                + static_cast<int64_t>(parts[1]) * 60LL
                + static_cast<int64_t>(parts[2]);
        } else if (parts.size() == 2) {
            total_seconds = static_cast<int64_t>(parts[0]) * 60LL
                + static_cast<int64_t>(parts[1]);
        } else {
            total_seconds = static_cast<int64_t>(parts[0]);
        }
        if (total_seconds < 0) {
            return false;
        }
        out_seconds = static_cast<float>(total_seconds);
        return std::isfinite(out_seconds);
    }

    static auto emit_derived_counter_event(
        const char* field,
        const char* total_event,
        const char* delta_event,
        int32_t value,
        int32_t& last_value
    ) -> void {
        int32_t delta = 0;
        bool changed = false;
        {
            std::lock_guard<std::mutex> guard(s_state_mutex);
            if (last_value < 0) {
                changed = true;
                delta = 0;
            } else if (value != last_value) {
                changed = true;
                delta = value - last_value;
            }
            last_value = value;
        }
        if (!changed) {
            return;
        }
        if (delta < 0) {
            // Scenario/menu transitions can reset UI counters to a smaller baseline.
            // Emit the new total, but suppress negative "activity" deltas.
            delta = 0;
        }

        std::array<char, 256> total_msg{};
        std::snprintf(
            total_msg.data(),
            total_msg.size(),
            "{\"ev\":\"%s\",\"field\":\"%s\",\"total\":%d}",
            total_event,
            field,
            value
        );
        kovaaks::RustBridge::emit_json(total_msg.data());

        std::array<char, 256> delta_msg{};
        std::snprintf(
            delta_msg.data(),
            delta_msg.size(),
            "{\"ev\":\"%s\",\"field\":\"%s\",\"delta\":%d,\"total\":%d}",
            delta_event,
            field,
            delta,
            value
        );
        kovaaks::RustBridge::emit_json(delta_msg.data());

        if (delta > 0) {
            const char* alias_ev = nullptr;
            if (std::strcmp(field, "session_shots") == 0) {
                alias_ev = "shot_fired";
            } else if (std::strcmp(field, "session_hits") == 0) {
                alias_ev = "shot_hit";
            } else if (std::strcmp(field, "session_kills") == 0) {
                alias_ev = "kill";
            }
            if (alias_ev) {
                s_derived_alias_emits.fetch_add(1, std::memory_order_relaxed);
                std::array<char, 256> alias_msg{};
                std::snprintf(
                    alias_msg.data(),
                    alias_msg.size(),
                    "{\"ev\":\"%s\",\"delta\":%d,\"total\":%d,\"source\":\"derived_ui\"}",
                    alias_ev,
                    delta,
                    value
                );
                kovaaks::RustBridge::emit_json(alias_msg.data());
                std::array<char, 192> abuf{};
                std::snprintf(
                    abuf.data(),
                    abuf.size(),
                    "[derived_alias] ev=%s delta=%d total=%d",
                    alias_ev,
                    delta,
                    value
                );
                runtime_log_line(abuf.data());
                events_log_line(abuf.data());
            }
        }
        const auto dlog_idx = s_derived_counter_logs.fetch_add(1, std::memory_order_relaxed);
        if (dlog_idx < 2000) {
            std::array<char, 256> lbuf{};
            std::snprintf(
                lbuf.data(),
                lbuf.size(),
                "[derived_counter] field=%s total=%d delta=%d",
                field,
                value,
                delta
            );
            runtime_log_line(lbuf.data());
            events_log_line(lbuf.data());
        }
    }

    static auto maybe_emit_derived_ui_counter(const char* ui_field, const RC::StringType& text_value) -> bool {
        int32_t parsed = 0;
        if (!try_parse_int_text(text_value, parsed)) {
            return false;
        }
        if (std::strcmp(ui_field, "session_shots") == 0) {
            emit_derived_counter_event(
                "session_shots",
                "derived_shots_total",
                "derived_shots_delta",
                parsed,
                s_ui_last_session_shots
            );
            return true;
        } else if (std::strcmp(ui_field, "session_hits") == 0) {
            emit_derived_counter_event(
                "session_hits",
                "derived_hits_total",
                "derived_hits_delta",
                parsed,
                s_ui_last_session_hits
            );
            return true;
        } else if (std::strcmp(ui_field, "session_kills") == 0) {
            emit_derived_counter_event(
                "session_kills",
                "derived_kills_total",
                "derived_kills_delta",
                parsed,
                s_ui_last_session_kills
            );
            return true;
        }
        return false;
    }

    static auto is_counter_ui_field(const std::string& field) -> bool {
        return field == "session_shots" || field == "session_hits" || field == "session_kills";
    }

    static auto has_ascii_digit(const std::string& value) -> bool {
        for (const char ch : value) {
            if (ch >= '0' && ch <= '9') {
                return true;
            }
        }
        return false;
    }

    static auto trim_ascii_token(const RC::StringType& input) -> std::string {
        std::string out;
        out.reserve(input.size());
        bool prev_space = true;
        for (auto c : input) {
            const auto raw = static_cast<unsigned int>(c);
            if (raw > 0x7F) {
                continue;
            }
            char ch = static_cast<char>(raw);
            if (ch == '\r' || ch == '\n' || ch == '\t') {
                ch = ' ';
            }
            if (ch == ' ') {
                if (prev_space || out.empty()) {
                    continue;
                }
                out.push_back(' ');
                prev_space = true;
                continue;
            }
            if (ch < 0x20) {
                continue;
            }
            out.push_back(ch);
            prev_space = false;
        }
        while (!out.empty() && out.back() == ' ') {
            out.pop_back();
        }
        return out;
    }

    static auto looks_like_real_scenario_name(const std::string& value) -> bool {
        if (value.size() < 3 || value.size() > 160) {
            return false;
        }
        bool has_alnum = false;
        for (char ch : value) {
            if (std::isalnum(static_cast<unsigned char>(ch))) {
                has_alnum = true;
                break;
            }
        }
        if (!has_alnum) {
            return false;
        }
        std::string lower;
        lower.reserve(value.size());
        for (char ch : value) {
            lower.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
        }
        if (lower == "scenario" || lower == "scenariotitle" || lower == "none") {
            return false;
        }
        return true;
    }

    static auto maybe_update_ui_scenario_name(const RC::StringType& text_value, const char* source) -> bool {
        if (text_value.empty()) {
            return false;
        }
        const auto scenario_name = trim_ascii_token(text_value);
        if (!looks_like_real_scenario_name(scenario_name)) {
            return false;
        }

        bool changed = false;
        {
            std::lock_guard<std::mutex> guard(s_state_mutex);
            if (s_last_ui_scenario_name != scenario_name) {
                s_last_ui_scenario_name = scenario_name;
                s_last_ui_scenario_name_ms = GetTickCount64();
                changed = true;
            }
        }
        if (!changed) {
            return false;
        }

        const auto escaped = escape_json(scenario_name);
        const auto source_escaped = escape_json(source ? source : "unknown");
        std::array<char, 512> msg{};
        std::snprintf(
            msg.data(),
            msg.size(),
            "{\"ev\":\"ui_scenario_name\",\"field\":\"%s\",\"source\":\"%s\"}",
            escaped.c_str(),
            source_escaped.c_str()
        );
        kovaaks::RustBridge::emit_json(msg.data());
        return true;
    }

    static auto classify_session_ui_field(const RC::StringType& ctx_name) -> const char* {
        const auto n = normalize_ascii(ctx_name);
        if (n.find("scenariotitle") != std::string::npos
            || n.find("scenarioheader") != std::string::npos
            || n.find("challengeheader") != std::string::npos) {
            return "scenario_name";
        }
        if (n.find("distscore") != std::string::npos
            || n.find("palettedsumscore") != std::string::npos
            || n.find("challengescore") != std::string::npos) {
            return "session_score";
        }
        if (n.find("sessionstatistics") == std::string::npos) {
            return nullptr;
        }
        if (n.find("sessionshots") != std::string::npos || n.find("shotsfired") != std::string::npos) return "session_shots";
        if (n.find("sessionhits") != std::string::npos || n.find("shotshit") != std::string::npos) return "session_hits";
        if (n.find("killcounter") != std::string::npos || n.find("sessionkills") != std::string::npos) return "session_kills";
        if (n.find("damagedone") != std::string::npos) return "session_damage_done";
        if (n.find("damagepossible") != std::string::npos) return "session_damage_possible";
        if (n.find("damageeff") != std::string::npos || n.find("damageefficiency") != std::string::npos) return "session_damage_eff";
        if (n.find("kps") != std::string::npos || n.find("killspersecond") != std::string::npos) return "session_kps";
        if (n.find("killacc") != std::string::npos || n.find("killaccuracy") != std::string::npos) return "session_kill_acc";
        if (n.find("sessiontime") != std::string::npos || n.find("gametime") != std::string::npos) return "session_time";
        if (n.find("spm") != std::string::npos || n.find("scoreperminute") != std::string::npos) return "session_spm";
        if (n.find("averagettk") != std::string::npos || n.find("ttk") != std::string::npos) return "session_avg_ttk";
        return nullptr;
    }

    static auto resolve_textblock_text_property(RC::Unreal::UObject* text_block) -> RC::Unreal::FTextProperty* {
        if (!text_block || !is_likely_valid_object_ptr(text_block)) {
            return nullptr;
        }
        auto* text_block_class = *reinterpret_cast<RC::Unreal::UClass**>(
            reinterpret_cast<uint8_t*>(text_block) + 0x10
        );
        if (!text_block_class || !is_likely_valid_object_ptr(text_block_class)) {
            return nullptr;
        }
        const auto cached_it = s_textblock_text_property_cache.find(text_block_class);
        if (cached_it != s_textblock_text_property_cache.end()) {
            auto* cached = cached_it->second;
            if (cached && is_likely_valid_object_ptr(cached)) {
                return cached;
            }
        }

        RC::Unreal::FTextProperty* found = nullptr;
        for (RC::Unreal::FProperty* property : enumerate_properties_in_chain(text_block_class)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (property->GetName() != STR("Text")) {
                continue;
            }
            auto* text_property = RC::Unreal::CastField<RC::Unreal::FTextProperty>(property);
            if (!text_property || !is_likely_valid_object_ptr(text_property)) {
                continue;
            }
            found = text_property;
            break;
        }
        s_textblock_text_property_cache[text_block_class] = found;
        return found;
    }

    static auto read_textblock_text_value(RC::Unreal::UObject* text_block, RC::StringType& out_value) -> bool {
        out_value.clear();
        if (!text_block || !is_likely_valid_object_ptr(text_block)) {
            return false;
        }
        if (!s_text_get_fn || !is_likely_valid_object_ptr(s_text_get_fn)) {
            s_text_get_fn = find_fn(STR("/Script/UMG.TextBlock:GetText"));
        }

        if (auto* text_property = resolve_textblock_text_property(text_block)) {
            void* value_ptr = safe_property_value_ptr(text_property, text_block);
            if (value_ptr && is_likely_readable_region(value_ptr, sizeof(RC::Unreal::FText))) {
                auto* text_value = reinterpret_cast<RC::Unreal::FText*>(value_ptr);
                out_value = text_value->ToString();
                if (!out_value.empty()) {
                    return true;
                }
            }
        }

        if (s_text_get_fn && is_likely_valid_object_ptr(s_text_get_fn)) {
            struct TextBlockGetTextParams {
                RC::Unreal::FText ReturnValue;
            } params{};
            text_block->ProcessEvent(s_text_get_fn, &params);
            out_value = params.ReturnValue.ToString();
            return !out_value.empty();
        }
        return false;
    }
