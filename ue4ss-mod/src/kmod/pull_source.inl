    static inline std::unordered_map<std::string, std::string> s_ui_pull_source_sig{};
    static inline std::unordered_map<std::string, std::string> s_state_pull_source_sig{};

    static auto emit_ui_pull_source_once(
        const char* metric,
        const std::string& field,
        const std::string& source_path,
        double value
    ) -> void {
        if (!(s_non_ui_probe_enabled || s_log_all_events)) {
            return;
        }
        if (!std::isfinite(value) || value < 0.0) {
            return;
        }

        const std::string metric_key = metric ? metric : "unknown";
        const std::string sig = std::string("ui_poll|") + field + "|" + source_path;
        const auto it = s_ui_pull_source_sig.find(metric_key);
        if (it != s_ui_pull_source_sig.end() && it->second == sig) {
            return;
        }
        s_ui_pull_source_sig[metric_key] = sig;

        const auto src_esc = escape_json(source_path);
        const auto origin_flag = s_ui_counter_fallback_enabled ? "ui_counter_fallback" : "ui_poll";
        std::array<char, 1024> lbuf{};
        std::snprintf(
            lbuf.data(),
            lbuf.size(),
            "[pull_source] metric=%s method=ui_poll field=%s source=%s value=%.3f origin_flag=%s",
            metric_key.c_str(),
            field.c_str(),
            source_path.c_str(),
            value,
            origin_flag
        );
        events_log_line(lbuf.data());

        std::array<char, 768> flags_json{};
        emit_flag_snapshot_json(flags_json.data(), flags_json.size());

        std::array<char, 2000> msg{};
        std::snprintf(
            msg.data(),
            msg.size(),
            "{\"ev\":\"pull_source\",\"metric\":\"%s\",\"method\":\"ui_poll\",\"field\":\"%s\",\"fn\":\"%s\",\"receiver\":\"%s\",\"value\":%.6f,\"origin\":\"ui_poll\",\"origin_flag\":\"%s\",%s}",
            metric_key.c_str(),
            field.c_str(),
            src_esc.c_str(),
            src_esc.c_str(),
            value,
            origin_flag,
            flags_json.data()
        );
        kovaaks::RustBridge::emit_json(msg.data());
    }

    static auto emit_state_pull_source_once(
        const char* metric,
        const char* method,
        RC::Unreal::UObject* caller,
        RC::Unreal::UFunction* fn,
        double value
    ) -> void {
        if (!(s_non_ui_probe_enabled || s_log_all_events)) {
            return;
        }
        if (!std::isfinite(value) || value < 0.0) {
            return;
        }

        const std::string metric_key = metric ? metric : "unknown";
        const std::string method_key = method ? method : "unknown";
        const std::string fn_utf8 = fn ? utf8_from_wide(fn->GetFullName()) : std::string("null");
        const std::string caller_utf8 = caller ? utf8_from_wide(caller->GetFullName()) : std::string("null");
        const std::string sig = method_key + "|" + fn_utf8 + "|" + caller_utf8;
        const auto it = s_state_pull_source_sig.find(metric_key);
        if (it != s_state_pull_source_sig.end() && it->second == sig) {
            return;
        }
        s_state_pull_source_sig[metric_key] = sig;

        const auto fn_esc = escape_json(fn_utf8);
        const auto caller_esc = escape_json(caller_utf8);
        const auto origin = s_emit_origin ? s_emit_origin : "unknown";
        const auto origin_flag = s_emit_origin_flag ? s_emit_origin_flag : "unknown";

        std::array<char, 1024> lbuf{};
        std::snprintf(
            lbuf.data(),
            lbuf.size(),
            "[pull_source] metric=%s method=%s fn=%s receiver=%s value=%.3f origin_flag=%s",
            metric_key.c_str(),
            method_key.c_str(),
            fn_utf8.c_str(),
            caller_utf8.c_str(),
            value,
            origin_flag
        );
        events_log_line(lbuf.data());

        std::array<char, 768> flags_json{};
        emit_flag_snapshot_json(flags_json.data(), flags_json.size());

        std::array<char, 2200> msg{};
        std::snprintf(
            msg.data(),
            msg.size(),
            "{\"ev\":\"pull_source\",\"metric\":\"%s\",\"method\":\"%s\",\"fn\":\"%s\",\"receiver\":\"%s\",\"value\":%.6f,\"origin\":\"%s\",\"origin_flag\":\"%s\",%s}",
            metric_key.c_str(),
            method_key.c_str(),
            fn_esc.c_str(),
            caller_esc.c_str(),
            value,
            origin,
            origin_flag,
            flags_json.data()
        );
        kovaaks::RustBridge::emit_json(msg.data());
    }
