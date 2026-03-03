    struct EmitContextScope {
        const char* prev_origin{nullptr};
        const char* prev_origin_flag{nullptr};

        EmitContextScope(const char* origin, const char* origin_flag) {
            prev_origin = s_emit_origin;
            prev_origin_flag = s_emit_origin_flag;
            s_emit_origin = origin ? origin : "unknown";
            s_emit_origin_flag = origin_flag ? origin_flag : "unknown";
        }

        ~EmitContextScope() {
            s_emit_origin = prev_origin ? prev_origin : "unknown";
            s_emit_origin_flag = prev_origin_flag ? prev_origin_flag : "unknown";
        }
    };

    static auto emit_flag_snapshot_json(char* out, size_t out_size) -> void {
        if (!out || out_size == 0) {
            return;
        }
        std::snprintf(
            out,
            out_size,
            "\"flags\":{\"pe_enabled\":%u,\"profile_full\":%u,\"discovery\":%u,\"safe_mode\":%u,\"pe_enable_flag\":%u,\"pe_disable_flag\":%u,\"log_all\":%u,\"object_debug\":%u,\"non_ui_probe\":%u,\"ui_counter_fallback\":%u,\"score_ui_fallback\":%u,\"hook_process_internal\":%u,\"hook_process_local_script\":%u,\"class_probe_hooks\":%u,\"allow_unsafe_hooks\":%u,\"rust_enabled\":%u,\"pe_hook_registered\":%u,\"native_hooks_registered\":%u,\"process_internal_callbacks_registered\":%u,\"process_local_script_callbacks_registered\":%u}",
            s_pe_events_enabled ? 1u : 0u,
            s_profile_full ? 1u : 0u,
            s_discovery_enabled ? 1u : 0u,
            s_safe_mode_enabled ? 1u : 0u,
            s_pe_enabled_by_flag ? 1u : 0u,
            s_pe_disabled_by_flag ? 1u : 0u,
            s_log_all_events ? 1u : 0u,
            s_object_debug_enabled ? 1u : 0u,
            s_non_ui_probe_enabled ? 1u : 0u,
            s_ui_counter_fallback_enabled ? 1u : 0u,
            s_score_ui_fallback_enabled ? 1u : 0u,
            s_enable_process_internal_script_hook ? 1u : 0u,
            s_enable_process_local_script_hook ? 1u : 0u,
            s_class_probe_hooks_enabled ? 1u : 0u,
            s_allow_unsafe_hooks ? 1u : 0u,
            s_rust_enabled ? 1u : 0u,
            s_hook_registered.load(std::memory_order_acquire) ? 1u : 0u,
            s_native_hooks_registered.load(std::memory_order_acquire) ? 1u : 0u,
            s_process_internal_callbacks_registered.load(std::memory_order_acquire) ? 1u : 0u,
            s_process_local_script_callbacks_registered.load(std::memory_order_acquire) ? 1u : 0u
        );
    }

    static auto emit_int_event(const char* ev, int32_t value) -> void {
        s_emit_i32_count.fetch_add(1, std::memory_order_relaxed);
        const auto origin = s_emit_origin ? s_emit_origin : "unknown";
        const auto origin_flag = s_emit_origin_flag ? s_emit_origin_flag : "unknown";
        if (s_log_all_events) {
            std::array<char, 256> eb{};
            std::snprintf(
                eb.data(),
                eb.size(),
                "[emit_i32] ev=%s value=%d origin=%s origin_flag=%s",
                ev,
                value,
                origin,
                origin_flag
            );
            events_log_line(eb.data());
        }
        const auto log_idx = s_non_ui_emit_logs.fetch_add(1, std::memory_order_relaxed);
        if (log_idx < 400) {
            std::array<char, 320> rbuf{};
            std::snprintf(
                rbuf.data(),
                rbuf.size(),
                "[emit_non_ui_i32 #%u] ev=%s value=%d origin=%s origin_flag=%s pe=%u nup=%u uicf=%u suif=%u",
                log_idx + 1,
                ev,
                value,
                origin,
                origin_flag,
                s_pe_events_enabled ? 1u : 0u,
                s_non_ui_probe_enabled ? 1u : 0u,
                s_ui_counter_fallback_enabled ? 1u : 0u,
                s_score_ui_fallback_enabled ? 1u : 0u
            );
            runtime_log_line(rbuf.data());
            events_log_line(rbuf.data());
        }
        std::array<char, 768> flags_json{};
        emit_flag_snapshot_json(flags_json.data(), flags_json.size());
        std::array<char, 1024> msg{};
        std::snprintf(
            msg.data(),
            msg.size(),
            "{\"ev\":\"%s\",\"value\":%d,\"origin\":\"%s\",\"origin_flag\":\"%s\",%s}",
            ev,
            value,
            origin,
            origin_flag,
            flags_json.data()
        );
        kovaaks::RustBridge::emit_json(msg.data());
    }

    static auto emit_float_event(const char* ev, float value) -> void {
        if (!std::isfinite(value)) {
            return;
        }
        s_emit_f32_count.fetch_add(1, std::memory_order_relaxed);
        const auto origin = s_emit_origin ? s_emit_origin : "unknown";
        const auto origin_flag = s_emit_origin_flag ? s_emit_origin_flag : "unknown";
        if (s_log_all_events) {
            std::array<char, 256> eb{};
            std::snprintf(
                eb.data(),
                eb.size(),
                "[emit_f32] ev=%s value=%.6f origin=%s origin_flag=%s",
                ev,
                value,
                origin,
                origin_flag
            );
            events_log_line(eb.data());
        }
        const auto log_idx = s_non_ui_emit_logs.fetch_add(1, std::memory_order_relaxed);
        if (log_idx < 400) {
            std::array<char, 352> rbuf{};
            std::snprintf(
                rbuf.data(),
                rbuf.size(),
                "[emit_non_ui_f32 #%u] ev=%s value=%.6f origin=%s origin_flag=%s pe=%u nup=%u uicf=%u suif=%u",
                log_idx + 1,
                ev,
                static_cast<double>(value),
                origin,
                origin_flag,
                s_pe_events_enabled ? 1u : 0u,
                s_non_ui_probe_enabled ? 1u : 0u,
                s_ui_counter_fallback_enabled ? 1u : 0u,
                s_score_ui_fallback_enabled ? 1u : 0u
            );
            runtime_log_line(rbuf.data());
            events_log_line(rbuf.data());
        }
        std::array<char, 768> flags_json{};
        emit_flag_snapshot_json(flags_json.data(), flags_json.size());
        std::array<char, 1200> msg{};
        std::snprintf(
            msg.data(),
            msg.size(),
            "{\"ev\":\"%s\",\"value\":%.6f,\"origin\":\"%s\",\"origin_flag\":\"%s\",%s}",
            ev,
            static_cast<double>(value),
            origin,
            origin_flag,
            flags_json.data()
        );
        kovaaks::RustBridge::emit_json(msg.data());
    }

    static auto emit_simple_event(const char* ev) -> void {
        s_emit_simple_count.fetch_add(1, std::memory_order_relaxed);
        const auto origin = s_emit_origin ? s_emit_origin : "unknown";
        const auto origin_flag = s_emit_origin_flag ? s_emit_origin_flag : "unknown";
        if (s_log_all_events) {
            std::array<char, 224> eb{};
            std::snprintf(
                eb.data(),
                eb.size(),
                "[emit_simple] ev=%s origin=%s origin_flag=%s",
                ev,
                origin,
                origin_flag
            );
            events_log_line(eb.data());
        }
        std::array<char, 768> flags_json{};
        emit_flag_snapshot_json(flags_json.data(), flags_json.size());
        std::array<char, 1024> msg{};
        std::snprintf(
            msg.data(),
            msg.size(),
            "{\"ev\":\"%s\",\"origin\":\"%s\",\"origin_flag\":\"%s\",%s}",
            ev,
            origin,
            origin_flag,
            flags_json.data()
        );
        kovaaks::RustBridge::emit_json(msg.data());
    }
