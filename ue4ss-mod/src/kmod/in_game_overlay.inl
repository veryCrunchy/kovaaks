    static auto in_game_overlay_enabled() -> bool {
        if (kmod_replay::replay_ingame_debug_overlay_enabled()) {
            return true;
        }
        if (env_flag_enabled("KOVAAKS_DISABLE_IN_GAME_OVERLAY")
            || std::filesystem::exists(std::filesystem::path(game_bin_dir() + L"kovaaks_disable_in_game_overlay.flag"))) {
            return false;
        }
        if (env_flag_enabled("KOVAAKS_ENABLE_IN_GAME_OVERLAY")
            || env_flag_enabled("KOVAAKS_IN_GAME_OVERLAY")
            || std::filesystem::exists(std::filesystem::path(game_bin_dir() + L"kovaaks_in_game_overlay.flag"))) {
            return true;
        }
        return false;
    }

    static auto in_game_overlay_find_controller() -> RC::Unreal::UObject* {
        std::vector<RC::Unreal::UObject*> candidates{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("NewCharacterPlayerController"), candidates);
        std::vector<RC::Unreal::UObject*> alt_candidates{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("NewCharacterPlayerController_C"), alt_candidates);
        append_unique_objects(candidates, alt_candidates);
        alt_candidates.clear();
        RC::Unreal::UObjectGlobals::FindAllOf(STR("MetaPlayerController"), alt_candidates);
        append_unique_objects(candidates, alt_candidates);
        alt_candidates.clear();
        RC::Unreal::UObjectGlobals::FindAllOf(STR("MetaPlayerController_C"), alt_candidates);
        append_unique_objects(candidates, alt_candidates);
        alt_candidates.clear();
        RC::Unreal::UObjectGlobals::FindAllOf(STR("PlayerController"), alt_candidates);
        append_unique_objects(candidates, alt_candidates);

        RC::Unreal::UObject* best = nullptr;
        int best_score = -1000000;
        for (auto* obj : candidates) {
            if (!ui_widget_probe_object_usable(obj)) {
                continue;
            }
            const auto full_name = obj->GetFullName();
            int score = 0;
            if (full_name.find(STR("/Engine/Transient.")) != RC::StringType::npos) score += 80;
            if (full_name.find(STR("Default__")) != RC::StringType::npos) score -= 1000;
            if (full_name.find(STR("/Script/")) != RC::StringType::npos) score -= 200;
            if (full_name.find(STR("NewCharacterPlayerController_C_")) != RC::StringType::npos) score += 150;
            if (full_name.find(STR("MetaPlayerController_C_")) != RC::StringType::npos) score += 180;
            if (full_name.find(STR("PlayerController_C_")) != RC::StringType::npos) score += 120;
            if (!best || score > best_score) {
                best = obj;
                best_score = score;
            }
        }

        if (!ui_widget_probe_object_usable(best)) {
            return nullptr;
        }
        return best;
    }

    static auto in_game_overlay_trim_ascii(const std::string& input) -> std::string {
        if (input.empty()) {
            return {};
        }
        size_t start = 0;
        while (start < input.size() && std::isspace(static_cast<unsigned char>(input[start]))) {
            ++start;
        }
        size_t end = input.size();
        while (end > start && std::isspace(static_cast<unsigned char>(input[end - 1]))) {
            --end;
        }
        return input.substr(start, end - start);
    }

    static auto in_game_overlay_read_env_utf8(const char* name) -> std::string {
        if (!name || !*name) {
            return {};
        }
        std::array<char, 4096> buf{};
        const auto len = GetEnvironmentVariableA(name, buf.data(), static_cast<DWORD>(buf.size()));
        if (len == 0 || len >= buf.size()) {
            return {};
        }
        return in_game_overlay_trim_ascii(std::string(buf.data(), static_cast<size_t>(len)));
    }

    static auto in_game_overlay_read_url_file_utf8(const std::filesystem::path& path) -> std::string {
        std::ifstream in{path};
        if (!in.is_open()) {
            return {};
        }
        std::string line{};
        std::getline(in, line);
        return in_game_overlay_trim_ascii(line);
    }

    static auto in_game_overlay_file_url_from_path(const std::filesystem::path& path) -> std::string {
        if (path.empty()) {
            return {};
        }
        auto resolved = path;
        if (!resolved.is_absolute()) {
            resolved = std::filesystem::path(game_bin_dir()) / resolved;
        }
        resolved = resolved.lexically_normal();
        auto wide = resolved.wstring();
        if (wide.empty()) {
            return {};
        }
        for (auto& ch : wide) {
            if (ch == L'\\') {
                ch = L'/';
            }
        }
        std::wstring prefixed = L"file:///";
        prefixed += wide;
        auto as_utf8 = utf8_from_wide(prefixed);
        if (as_utf8.empty()) {
            return {};
        }
        std::string encoded{};
        encoded.reserve(as_utf8.size() + 16);
        for (char ch : as_utf8) {
            if (ch == ' ') {
                encoded += "%20";
            } else {
                encoded.push_back(ch);
            }
        }
        return encoded;
    }

    static auto in_game_overlay_resolve_browser_url_utf8() -> std::string {
        if (auto env_url = in_game_overlay_read_env_utf8("KOVAAKS_IN_GAME_OVERLAY_URL"); !env_url.empty()) {
            return env_url;
        }

        const auto explicit_file = std::filesystem::path(game_bin_dir() + L"kovaaks_in_game_overlay_url.txt");
        if (std::filesystem::exists(explicit_file)) {
            if (auto file_url = in_game_overlay_read_url_file_utf8(explicit_file); !file_url.empty()) {
                return file_url;
            }
        }

        const auto local_html = std::filesystem::path(game_bin_dir() + L"aimmod_in_game_overlay.html");
        if (std::filesystem::exists(local_html)) {
            return in_game_overlay_file_url_from_path(local_html);
        }

        const auto bundled_html = std::filesystem::path(game_bin_dir()) / L"aimmod_overlay" / L"index.html";
        if (std::filesystem::exists(bundled_html)) {
            return in_game_overlay_file_url_from_path(bundled_html);
        }

        const auto staged_html = std::filesystem::path(game_bin_dir()) / L"dist" / L"index.html";
        if (std::filesystem::exists(staged_html)) {
            return in_game_overlay_file_url_from_path(staged_html);
        }

        return {};
    }

    static auto in_game_overlay_wide_from_utf8(const std::string& input) -> RC::StringType {
        if (input.empty()) {
            return {};
        }

        const int required = MultiByteToWideChar(
            CP_UTF8,
            MB_ERR_INVALID_CHARS,
            input.c_str(),
            static_cast<int>(input.size()),
            nullptr,
            0
        );
        if (required > 0) {
            std::wstring wide(static_cast<size_t>(required), L'\0');
            const int written = MultiByteToWideChar(
                CP_UTF8,
                0,
                input.c_str(),
                static_cast<int>(input.size()),
                wide.data(),
                required
            );
            if (written > 0) {
                return RC::StringType(wide.begin(), wide.end());
            }
        }

        RC::StringType fallback{};
        fallback.reserve(input.size());
        for (unsigned char ch : input) {
            fallback.push_back(static_cast<wchar_t>(ch));
        }
        return fallback;
    }

    static auto in_game_overlay_try_get_object_property(
        RC::Unreal::UObject* owner,
        const char* normalized_property_name,
        std::string* out_detail = nullptr
    ) -> RC::Unreal::UObject* {
        if (out_detail) {
            out_detail->clear();
        }
        if (!owner || !normalized_property_name || !*normalized_property_name) {
            if (out_detail) {
                *out_detail = "invalid_owner_or_property_name";
            }
            return nullptr;
        }

        auto try_direct_chain = [&](const wchar_t* chain_name, const char* chain_tag) -> RC::Unreal::UObject* {
            auto** value_ptr = owner->GetValuePtrByPropertyNameInChain<RC::Unreal::UObject*>(chain_name);
            if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(void*))) {
                return nullptr;
            }
            auto* value = *value_ptr;
            if (!value) {
                return nullptr;
            }
            if (ui_widget_probe_object_usable(value) || is_runtime_object_usable(value)) {
                if (out_detail) {
                    *out_detail = std::string{"direct_chain:"} + chain_tag;
                }
                return value;
            }
            if (is_likely_readable_region(value, sizeof(void*))) {
                if (out_detail) {
                    *out_detail = std::string{"direct_chain_readable:"} + chain_tag;
                }
                return value;
            }
            return nullptr;
        };

        if (std::strcmp(normalized_property_name, "crosshairhud") == 0) {
            if (auto* direct = try_direct_chain(STR("CrosshairHUD"), "CrosshairHUD")) {
                return direct;
            }
        } else if (std::strcmp(normalized_property_name, "hudwidget") == 0) {
            if (auto* direct = try_direct_chain(STR("HudWidget"), "HudWidget")) {
                return direct;
            }
        } else if (std::strcmp(normalized_property_name, "xsollabrowserwidget") == 0) {
            if (auto* direct = try_direct_chain(STR("XsollaBrowserWidget"), "XsollaBrowserWidget")) {
                return direct;
            }
        }

        auto* owner_class = owner->GetClassPrivate();
        if (!owner_class || !is_likely_valid_object_ptr(owner_class)) {
            if (out_detail) {
                *out_detail = "owner_class_unavailable";
            }
            return nullptr;
        }

        for (RC::Unreal::FProperty* property : enumerate_properties_in_chain(owner_class)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            auto* object_property = RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property);
            if (!object_property || !is_likely_valid_object_ptr(object_property)) {
                continue;
            }
            if (normalize_ascii(property->GetName()) != normalized_property_name) {
                continue;
            }

            void* value_ptr = safe_property_value_ptr(object_property, reinterpret_cast<void*>(owner));
            if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(void*))) {
                continue;
            }

            auto* value = object_property->GetObjectPropertyValue(value_ptr);
            if (!value) {
                continue;
            }

            if (ui_widget_probe_object_usable(value) || is_runtime_object_usable(value)) {
                if (out_detail) {
                    *out_detail = "reflection_ok";
                }
                return value;
            }
            if (is_likely_readable_region(value, sizeof(void*))) {
                if (out_detail) {
                    *out_detail = "reflection_readable";
                }
                return value;
            }
        }

        if (out_detail) {
            *out_detail = "property_not_found";
        }
        return nullptr;
    }

    static auto in_game_overlay_resolve_browser_widget(
        RC::Unreal::UObject* controller,
        std::string* out_detail = nullptr
    ) -> RC::Unreal::UObject* {
        if (out_detail) {
            out_detail->clear();
        }
        if (!ui_widget_probe_object_usable(controller)) {
            if (out_detail) {
                *out_detail = "controller_unusable";
            }
            return nullptr;
        }

        std::string hud_detail{};
        auto* crosshair_hud = in_game_overlay_try_get_object_property(controller, "crosshairhud", &hud_detail);
        if (!crosshair_hud || !is_likely_readable_region(crosshair_hud, sizeof(void*))) {
            if (out_detail) {
                *out_detail = std::string{"crosshair_hud_missing:"} + hud_detail;
            }
            return nullptr;
        }

        std::string hud_widget_detail{};
        auto* hud_widget = in_game_overlay_try_get_object_property(crosshair_hud, "hudwidget", &hud_widget_detail);
        if (!hud_widget || !is_likely_readable_region(hud_widget, sizeof(void*))) {
            if (out_detail) {
                *out_detail = std::string{"hud_widget_missing:"} + hud_widget_detail;
            }
            return nullptr;
        }

        std::string browser_detail{};
        auto* browser_widget = in_game_overlay_try_get_object_property(hud_widget, "xsollabrowserwidget", &browser_detail);
        if (!browser_widget || !is_likely_readable_region(browser_widget, sizeof(void*))) {
            if (out_detail) {
                *out_detail = std::string{"browser_widget_missing:"} + browser_detail;
            }
            return nullptr;
        }

        if (out_detail) {
            std::array<char, 320> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "crosshair=%s hud=%s browser=%s",
                hud_detail.c_str(),
                hud_widget_detail.c_str(),
                browser_detail.c_str()
            );
            *out_detail = buf.data();
        }
        return browser_widget;
    }

    static auto in_game_overlay_process_event_call(
        RC::Unreal::UObject* caller,
        RC::Unreal::UFunction* fn,
        void* params,
        const char* source,
        std::string* out_detail = nullptr
    ) -> bool {
        if (out_detail) {
            out_detail->clear();
        }
        if (!caller || !fn || !is_likely_valid_object_ptr(caller) || !is_likely_valid_object_ptr(fn)) {
            if (out_detail) {
                *out_detail = "invalid_caller_or_fn";
            }
            return false;
        }

        const uint64_t now_ms = GetTickCount64();
        if (is_function_quarantined(fn, now_ms)) {
            if (out_detail) {
                *out_detail = "fn_quarantined";
            }
            return false;
        }

        const bool global_latched = s_disable_direct_invoke_path.load(std::memory_order_acquire);
        set_direct_fault_context(source, caller, fn);
#if defined(_MSC_VER)
        __try {
            caller->ProcessEvent(fn, params);
            if (out_detail) {
                *out_detail = global_latched ? "ok_bypass_global_latch" : "ok";
            }
            return true;
        } __except(EXCEPTION_EXECUTE_HANDLER) {
            const auto faults = s_direct_invoke_faults.fetch_add(1, std::memory_order_relaxed) + 1;
            s_direct_poll_errors.fetch_add(1, std::memory_order_relaxed);
            s_direct_invoke_last_fault_ms.store(GetTickCount64(), std::memory_order_release);

            const bool quarantined = should_quarantine_invoke_fault(source, fn);
            uint32_t fn_hits = 0;
            if (quarantined) {
                fn_hits = quarantine_faulted_function(fn, now_ms);
            } else {
                s_disable_direct_invoke_path.store(true, std::memory_order_release);
            }

            if (out_detail) {
                std::array<char, 256> buf{};
                std::snprintf(
                    buf.data(),
                    buf.size(),
                    "fault mode=%s fn_hits=%u global_latched=%u",
                    quarantined ? "quarantine_fn" : "disable_global",
                    static_cast<unsigned>(fn_hits),
                    global_latched ? 1u : 0u
                );
                *out_detail = buf.data();
            }
            return false;
        }
#else
        caller->ProcessEvent(fn, params);
        if (out_detail) {
            *out_detail = global_latched ? "ok_bypass_global_latch" : "ok";
        }
        return true;
#endif
    }

    static auto in_game_overlay_set_w_text(
        RC::Unreal::UObject* widget,
        RC::Unreal::UFunction* set_text_fn,
        const RC::StringType& message,
        std::string* out_detail = nullptr
    ) -> bool {
        if (out_detail) {
            out_detail->clear();
        }
        if (!widget || !is_runtime_function_usable(set_text_fn) || message.empty()) {
            if (out_detail) {
                *out_detail = "invalid_widget_or_function_or_message";
            }
            return false;
        }
        if (!is_likely_valid_object_ptr(widget) && !is_likely_readable_region(widget, sizeof(void*))) {
            if (out_detail) {
                *out_detail = "widget_pointer_unusable";
            }
            return false;
        }

        int32_t param_size = static_cast<int32_t>(set_text_fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = set_text_fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x200;
        }
        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);

        bool wrote = false;
        const char* write_kind = "none";
        for (RC::Unreal::FProperty* property : enumerate_properties(set_text_fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_Parm)
                || property_has_any_flags(property, RC::Unreal::CPF_OutParm)
                || property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                continue;
            }

            const auto name = normalize_ascii(property->GetName());
            if (name != "text" && name != "intext" && name != "value") {
                continue;
            }

            void* value_ptr = safe_property_value_ptr(property, params.data());
            if (!value_ptr) {
                continue;
            }

            if (auto* str_property = RC::Unreal::CastField<RC::Unreal::FStrProperty>(property);
                str_property && is_likely_valid_object_ptr(str_property)) {
                RC::Unreal::FString value(message.c_str());
                str_property->SetPropertyValue(value_ptr, value);
                wrote = true;
                write_kind = "fstring";
                break;
            }

            if (auto* text_property = RC::Unreal::CastField<RC::Unreal::FTextProperty>(property);
                text_property && is_likely_valid_object_ptr(text_property)) {
                RC::Unreal::FText value{};
                value.SetString(RC::Unreal::FString(message.c_str()));
                text_property->SetPropertyValue(value_ptr, value);
                wrote = true;
                write_kind = "ftext";
                break;
            }
        }

        if (!wrote) {
            if (out_detail) {
                *out_detail = "no_supported_settext_param";
            }
            return false;
        }

        std::string pe_detail{};
        const bool ok = in_game_overlay_process_event_call(widget, set_text_fn, params.data(), "in_game_overlay_settext", &pe_detail);
        if (out_detail) {
            std::array<char, 192> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "write_kind=%s process_event=%s pe_detail=%s param_size=%d",
                write_kind,
                ok ? "ok" : "fault",
                pe_detail.c_str(),
                param_size
            );
            *out_detail = buf.data();
        }
        return ok;
    }

    static auto in_game_overlay_browser_load_url_safe(
        RC::Unreal::UObject* browser_widget,
        RC::Unreal::UFunction* load_url_fn,
        const std::string& url_utf8,
        std::string* out_detail = nullptr
    ) -> bool {
        if (out_detail) {
            out_detail->clear();
        }
        if (!browser_widget || !is_runtime_function_usable(load_url_fn) || url_utf8.empty()) {
            if (out_detail) {
                *out_detail = "invalid_browser_or_fn_or_url";
            }
            return false;
        }
        if (!is_likely_valid_object_ptr(browser_widget) && !is_likely_readable_region(browser_widget, sizeof(void*))) {
            if (out_detail) {
                *out_detail = "browser_widget_pointer_unusable";
            }
            return false;
        }

        int32_t param_size = static_cast<int32_t>(load_url_fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = load_url_fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x200;
        }
        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
        const RC::StringType url_w = in_game_overlay_wide_from_utf8(url_utf8);

        bool wrote = false;
        const char* write_kind = "none";
        for (RC::Unreal::FProperty* property : enumerate_properties(load_url_fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_Parm)
                || property_has_any_flags(property, RC::Unreal::CPF_OutParm)
                || property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                continue;
            }

            const auto name = normalize_ascii(property->GetName());
            if (!(name.empty() || name == "url" || name == "inurl" || name == "value")) {
                continue;
            }

            void* value_ptr = safe_property_value_ptr(property, params.data());
            if (!value_ptr) {
                continue;
            }

            if (auto* str_property = RC::Unreal::CastField<RC::Unreal::FStrProperty>(property);
                str_property && is_likely_valid_object_ptr(str_property)) {
                RC::Unreal::FString value(url_w.c_str());
                str_property->SetPropertyValue(value_ptr, value);
                wrote = true;
                write_kind = "fstring";
                break;
            }

            if (auto* text_property = RC::Unreal::CastField<RC::Unreal::FTextProperty>(property);
                text_property && is_likely_valid_object_ptr(text_property)) {
                RC::Unreal::FText value{};
                value.SetString(RC::Unreal::FString(url_w.c_str()));
                text_property->SetPropertyValue(value_ptr, value);
                wrote = true;
                write_kind = "ftext";
                break;
            }
        }

        if (!wrote) {
            if (out_detail) {
                *out_detail = "no_supported_loadurl_param";
            }
            return false;
        }

        std::string pe_detail{};
        const bool ok = in_game_overlay_process_event_call(
            browser_widget,
            load_url_fn,
            params.data(),
            "in_game_overlay_browser_loadurl",
            &pe_detail
        );

        if (out_detail) {
            std::array<char, 320> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "write_kind=%s process_event=%s pe_detail=%s url=%s param_size=%d",
                write_kind,
                ok ? "ok" : "fault",
                pe_detail.c_str(),
                url_utf8.c_str(),
                param_size
            );
            *out_detail = buf.data();
        }

        return ok;
    }

    static auto in_game_overlay_add_to_viewport_safe(
        RC::Unreal::UObject* widget,
        RC::Unreal::UFunction* add_to_viewport_fn,
        int32_t z_order,
        std::string* out_detail = nullptr
    ) -> bool {
        if (out_detail) {
            out_detail->clear();
        }
        if (!widget || !is_runtime_function_usable(add_to_viewport_fn)) {
            if (out_detail) {
                *out_detail = "invalid_widget_or_add_fn";
            }
            return false;
        }
        int32_t param_size = static_cast<int32_t>(add_to_viewport_fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = add_to_viewport_fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x40;
        }
        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);

        bool wrote_z_order = false;
        if (param_size >= static_cast<int32_t>(sizeof(int32_t))) {
            auto* z_ptr = reinterpret_cast<int32_t*>(params.data());
            if (is_likely_readable_region(z_ptr, sizeof(int32_t))) {
                *z_ptr = z_order;
                wrote_z_order = true;
            }
        }

        std::string pe_detail{};
        const bool ok = in_game_overlay_process_event_call(widget, add_to_viewport_fn, params.data(), "in_game_overlay_add_to_viewport", &pe_detail);
        if (out_detail) {
            std::array<char, 224> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "wrote_zorder=%u z=%d process_event=%s pe_detail=%s param_size=%d",
                wrote_z_order ? 1u : 0u,
                z_order,
                ok ? "ok" : "fault",
                pe_detail.c_str(),
                param_size
            );
            *out_detail = buf.data();
        }
        return ok;
    }

    static auto in_game_overlay_add_to_player_screen_safe(
        RC::Unreal::UObject* widget,
        RC::Unreal::UFunction* add_to_player_screen_fn,
        int32_t z_order,
        std::string* out_detail = nullptr
    ) -> bool {
        if (out_detail) {
            out_detail->clear();
        }
        if (!widget || !is_runtime_function_usable(add_to_player_screen_fn)) {
            if (out_detail) {
                *out_detail = "invalid_widget_or_add_player_screen_fn";
            }
            return false;
        }
        int32_t param_size = static_cast<int32_t>(add_to_player_screen_fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = add_to_player_screen_fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x40;
        }
        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);

        bool wrote_z_order = false;
        if (param_size >= static_cast<int32_t>(sizeof(int32_t))) {
            auto* z_ptr = reinterpret_cast<int32_t*>(params.data());
            if (is_likely_readable_region(z_ptr, sizeof(int32_t))) {
                *z_ptr = z_order;
                wrote_z_order = true;
            }
        }

        std::string pe_detail{};
        const bool invoked = in_game_overlay_process_event_call(widget, add_to_player_screen_fn, params.data(), "in_game_overlay_add_to_player_screen", &pe_detail);

        bool return_value = invoked;
        for (RC::Unreal::FProperty* property : enumerate_properties(add_to_player_screen_fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                continue;
            }
            auto* bool_property = RC::Unreal::CastField<RC::Unreal::FBoolProperty>(property);
            if (!bool_property || !is_likely_valid_object_ptr(bool_property)) {
                continue;
            }
            void* value_ptr = safe_property_value_ptr(property, params.data());
            if (!value_ptr) {
                continue;
            }
            return_value = bool_property->GetPropertyValue(value_ptr);
            break;
        }

        if (out_detail) {
            std::array<char, 256> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "wrote_zorder=%u z=%d process_event=%s pe_detail=%s return=%u param_size=%d",
                wrote_z_order ? 1u : 0u,
                z_order,
                invoked ? "ok" : "fault",
                pe_detail.c_str(),
                return_value ? 1u : 0u,
                param_size
            );
            *out_detail = buf.data();
        }

        return invoked && return_value;
    }

    static auto in_game_overlay_get_viewport_center_safe(
        RC::Unreal::UObject* controller,
        RC::Unreal::UFunction* get_viewport_size_fn,
        float* out_center_x,
        float* out_center_y,
        std::string* out_detail = nullptr
    ) -> bool {
        if (out_detail) {
            out_detail->clear();
        }
        if (!controller || !is_runtime_function_usable(get_viewport_size_fn) || !out_center_x || !out_center_y) {
            if (out_detail) {
                *out_detail = "invalid_controller_or_get_viewport_fn_or_output";
            }
            return false;
        }
        int32_t param_size = static_cast<int32_t>(get_viewport_size_fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = get_viewport_size_fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x20;
        }
        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);

        std::string pe_detail{};
        if (!in_game_overlay_process_event_call(controller, get_viewport_size_fn, params.data(), "in_game_overlay_get_viewport_size", &pe_detail)) {
            if (out_detail) {
                *out_detail = std::string{"get_viewport_process_event_fault:"} + pe_detail;
            }
            return false;
        }

        int32_t size_x = 0;
        int32_t size_y = 0;
        bool got_x = false;
        bool got_y = false;
        for (RC::Unreal::FProperty* property : enumerate_properties(get_viewport_size_fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_Parm)) {
                continue;
            }
            auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property);
            if (!numeric || !is_likely_valid_object_ptr(numeric)) {
                continue;
            }
            void* value_ptr = safe_property_value_ptr(property, params.data());
            if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(int32_t))) {
                continue;
            }
            const auto name = normalize_ascii(property->GetName());
            if (name == "sizex") {
                size_x = static_cast<int32_t>(numeric->GetSignedIntPropertyValue(value_ptr));
                got_x = true;
            } else if (name == "sizey") {
                size_y = static_cast<int32_t>(numeric->GetSignedIntPropertyValue(value_ptr));
                got_y = true;
            }
        }

        if ((!got_x || !got_y) && param_size >= 8) {
            auto* px = reinterpret_cast<int32_t*>(params.data() + 0x0);
            auto* py = reinterpret_cast<int32_t*>(params.data() + 0x4);
            if (is_likely_readable_region(px, sizeof(int32_t)) && is_likely_readable_region(py, sizeof(int32_t))) {
                if (!got_x) {
                    size_x = *px;
                }
                if (!got_y) {
                    size_y = *py;
                }
            }
        }

        if (size_x <= 0 || size_y <= 0) {
            if (out_detail) {
                std::array<char, 160> buf{};
                std::snprintf(buf.data(), buf.size(), "non_positive_viewport size_x=%d size_y=%d", size_x, size_y);
                *out_detail = buf.data();
            }
            return false;
        }

        *out_center_x = static_cast<float>(size_x) * 0.5f;
        *out_center_y = static_cast<float>(size_y) * 0.5f;
        if (out_detail) {
            std::array<char, 160> buf{};
            std::snprintf(buf.data(), buf.size(), "viewport=%dx%d center=(%.1f,%.1f)", size_x, size_y, static_cast<double>(*out_center_x), static_cast<double>(*out_center_y));
            *out_detail = buf.data();
        }
        return true;
    }

    static auto in_game_overlay_set_alignment_safe(
        RC::Unreal::UObject* widget,
        RC::Unreal::UFunction* set_alignment_fn,
        float align_x,
        float align_y,
        std::string* out_detail = nullptr
    ) -> bool {
        if (out_detail) {
            out_detail->clear();
        }
        if (!widget || !is_runtime_function_usable(set_alignment_fn)) {
            if (out_detail) {
                *out_detail = "invalid_widget_or_alignment_fn";
            }
            return false;
        }

        int32_t param_size = static_cast<int32_t>(set_alignment_fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = set_alignment_fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x40;
        }
        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);

        struct Vec2 { float X; float Y; };
        const Vec2 alignment{align_x, align_y};
        bool wrote_alignment = false;
        for (RC::Unreal::FProperty* property : enumerate_properties(set_alignment_fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_Parm)
                || property_has_any_flags(property, RC::Unreal::CPF_OutParm)
                || property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                continue;
            }
            if (normalize_ascii(property->GetName()) != "alignment") {
                continue;
            }
            void* value_ptr = safe_property_value_ptr(property, params.data());
            if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(Vec2))) {
                continue;
            }
            std::memcpy(value_ptr, &alignment, sizeof(Vec2));
            wrote_alignment = true;
            break;
        }

        if (!wrote_alignment) {
            if (out_detail) {
                *out_detail = "alignment_param_not_found";
            }
            return false;
        }

        std::string pe_detail{};
        const bool ok = in_game_overlay_process_event_call(widget, set_alignment_fn, params.data(), "in_game_overlay_set_alignment", &pe_detail);
        if (out_detail) {
            std::array<char, 192> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "alignment=(%.3f,%.3f) process_event=%s pe_detail=%s param_size=%d",
                static_cast<double>(align_x),
                static_cast<double>(align_y),
                ok ? "ok" : "fault",
                pe_detail.c_str(),
                param_size
            );
            *out_detail = buf.data();
        }
        return ok;
    }

    static auto in_game_overlay_set_position_safe(
        RC::Unreal::UObject* widget,
        RC::Unreal::UFunction* set_position_fn,
        float pos_x,
        float pos_y,
        bool remove_dpi_scale,
        std::string* out_detail = nullptr
    ) -> bool {
        if (out_detail) {
            out_detail->clear();
        }
        if (!widget || !is_runtime_function_usable(set_position_fn)) {
            if (out_detail) {
                *out_detail = "invalid_widget_or_position_fn";
            }
            return false;
        }

        int32_t param_size = static_cast<int32_t>(set_position_fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = set_position_fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x40;
        }
        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);

        struct Vec2 { float X; float Y; };
        const Vec2 position{pos_x, pos_y};
        bool wrote_position = false;
        bool wrote_dpi_flag = false;

        for (RC::Unreal::FProperty* property : enumerate_properties(set_position_fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_Parm)
                || property_has_any_flags(property, RC::Unreal::CPF_OutParm)
                || property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                continue;
            }

            const auto name = normalize_ascii(property->GetName());
            void* value_ptr = safe_property_value_ptr(property, params.data());
            if (!value_ptr) {
                continue;
            }

            if (name == "position") {
                if (!is_likely_readable_region(value_ptr, sizeof(Vec2))) {
                    continue;
                }
                std::memcpy(value_ptr, &position, sizeof(Vec2));
                wrote_position = true;
                continue;
            }

            if (name == "bremovedpiscale") {
                auto* bool_property = RC::Unreal::CastField<RC::Unreal::FBoolProperty>(property);
                if (bool_property && is_likely_valid_object_ptr(bool_property)) {
                    bool_property->SetPropertyValue(value_ptr, remove_dpi_scale);
                    wrote_dpi_flag = true;
                } else if (is_likely_readable_region(value_ptr, sizeof(uint8_t))) {
                    *reinterpret_cast<uint8_t*>(value_ptr) = remove_dpi_scale ? 1 : 0;
                    wrote_dpi_flag = true;
                }
            }
        }

        if (!wrote_position) {
            if (out_detail) {
                *out_detail = "position_param_not_found";
            }
            return false;
        }

        std::string pe_detail{};
        const bool ok = in_game_overlay_process_event_call(widget, set_position_fn, params.data(), "in_game_overlay_set_position", &pe_detail);
        if (out_detail) {
            std::array<char, 224> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "position=(%.1f,%.1f) remove_dpi=%u wrote_dpi=%u process_event=%s pe_detail=%s param_size=%d",
                static_cast<double>(pos_x),
                static_cast<double>(pos_y),
                remove_dpi_scale ? 1u : 0u,
                wrote_dpi_flag ? 1u : 0u,
                ok ? "ok" : "fault",
                pe_detail.c_str(),
                param_size
            );
            *out_detail = buf.data();
        }
        return ok;
    }

    static auto in_game_overlay_try_create_widget(
        RC::Unreal::UObject* world_context,
        RC::Unreal::UObject* owning_player,
        RC::Unreal::UClass* widget_class,
        RC::Unreal::UFunction* create_fn,
        int* out_status,
        RC::StringType* out_return_name
    ) -> RC::Unreal::UObject* {
        if (out_status) {
            *out_status = 0;
        }
        if (out_return_name) {
            out_return_name->clear();
        }

        if (!is_runtime_function_usable(create_fn)
            || !widget_class
            || !is_likely_valid_object_ptr(widget_class)) {
            if (out_status) {
                *out_status = 1;
            }
            return nullptr;
        }

        auto* library_cdo = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UObject*>(
            nullptr,
            nullptr,
            STR("/Script/UMG.Default__WidgetBlueprintLibrary")
        );
        if (!library_cdo || !is_likely_valid_object_ptr(library_cdo)) {
            if (out_status) {
                *out_status = 2;
            }
            return nullptr;
        }

        int32_t param_size = static_cast<int32_t>(create_fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = create_fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x200;
        }
        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);

        if (param_size >= 0x20) {
            auto* world_ptr = reinterpret_cast<RC::Unreal::UObject**>(params.data() + 0x00);
            auto* widget_type_ptr = reinterpret_cast<RC::Unreal::UObject**>(params.data() + 0x08);
            auto* owner_ptr = reinterpret_cast<RC::Unreal::UObject**>(params.data() + 0x10);
            if (is_likely_readable_region(world_ptr, sizeof(void*))) {
                *world_ptr = world_context;
            }
            if (is_likely_readable_region(widget_type_ptr, sizeof(void*))) {
                *widget_type_ptr = widget_class;
            }
            if (is_likely_readable_region(owner_ptr, sizeof(void*))) {
                *owner_ptr = owning_player;
            }
        }

        RC::Unreal::FObjectPropertyBase* output_object = nullptr;
        int output_priority = -1;

        for (RC::Unreal::FProperty* property : enumerate_properties(create_fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_Parm)) {
                continue;
            }

            const auto normalized_name = normalize_ascii(property->GetName());
            auto* object_property = RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property);

            const bool is_out = property_has_any_flags(property, RC::Unreal::CPF_OutParm)
                || property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)
                || normalized_name == "returnvalue";
            if (is_out) {
                if (object_property && is_likely_valid_object_ptr(object_property)) {
                    int priority = 0;
                    if (normalized_name == "returnvalue") {
                        priority = 5;
                    } else if (property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                        priority = 4;
                    } else if (property_has_any_flags(property, RC::Unreal::CPF_OutParm)) {
                        priority = 3;
                    }
                    if (!output_object || priority > output_priority) {
                        output_object = object_property;
                        output_priority = priority;
                    }
                }
                continue;
            }

            if (!object_property || !is_likely_valid_object_ptr(object_property)) {
                continue;
            }

            void* value_ptr = safe_property_value_ptr(property, params.data());
            if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(void*))) {
                continue;
            }

            if (normalized_name.find("worldcontextobject") != std::string::npos) {
                object_property->SetObjectPropertyValue(value_ptr, world_context);
            } else if (normalized_name == "widgettype") {
                object_property->SetObjectPropertyValue(value_ptr, widget_class);
            } else if (normalized_name == "owningplayer") {
                object_property->SetObjectPropertyValue(value_ptr, owning_player);
            }
        }

        if (!output_object || !is_likely_valid_object_ptr(output_object)) {
            if (out_status) {
                *out_status = 3;
            }
            return nullptr;
        }

        std::string pe_detail{};
        if (!in_game_overlay_process_event_call(library_cdo, create_fn, params.data(), "in_game_overlay_create_widget", &pe_detail)) {
            if (out_status) {
                *out_status = pe_detail.find("fn_quarantined") != std::string::npos ? 13 : 10;
            }
            return nullptr;
        }

        if (param_size >= 0x20) {
            auto* ret_ptr = reinterpret_cast<RC::Unreal::UObject**>(params.data() + 0x18);
            if (is_likely_readable_region(ret_ptr, sizeof(void*))) {
                auto* fast_value = *ret_ptr;
                if (fast_value) {
                    if (out_return_name && is_likely_valid_object_ptr(fast_value)) {
                        *out_return_name = fast_value->GetFullName();
                    }
                    if (out_status) {
                        *out_status = 9;
                    }
                    return fast_value;
                }
            }
        }

        void* output_ptr = safe_property_value_ptr(output_object, params.data());
        if (!output_ptr || !is_likely_readable_region(output_ptr, sizeof(void*))) {
            if (out_status) {
                *out_status = 4;
            }
            return nullptr;
        }

        auto* value = output_object->GetObjectPropertyValue(output_ptr);
        if (!value) {
            if (out_status) {
                *out_status = 5;
            }
            return nullptr;
        }

        if (!is_likely_valid_object_ptr(value)) {
            if (!is_likely_readable_region(value, sizeof(void*))) {
                if (out_status) {
                    *out_status = 5;
                }
                return nullptr;
            }
            if (out_status) {
                *out_status = 8;
            }
            return value;
        }

        const auto return_name = value->GetFullName();
        if (out_return_name) {
            *out_return_name = return_name;
        }
        if (return_name.find(STR("None.None:None.None")) != RC::StringType::npos) {
            if (out_status) {
                *out_status = 7;
            }
            return value;
        }
        if (out_status) {
            *out_status = 6;
        }
        return value;
    }

    inline static std::atomic<bool> s_in_game_overlay_fault_latched{false};
    inline static std::atomic<uint64_t> s_in_game_overlay_fault_retry_after_ms{0};
    inline static std::atomic<uint32_t> s_in_game_overlay_fault_count{0};
    inline static const char* s_in_game_overlay_stage = "init";

    static auto in_game_overlay_tick_impl(uint64_t now_ms) -> void {
        static uint64_t s_next_tick_ms = 0;
        static uint64_t s_next_spawn_attempt_ms = 0;
        static uint64_t s_last_set_text_ms = 0;
        static uint64_t s_last_diag_log_ms = 0;
        static uint64_t s_last_browser_diag_log_ms = 0;
        static uint64_t s_next_browser_attach_ms = 0;
        static uint64_t s_next_browser_load_attempt_ms = 0;
        static RC::Unreal::UObject* s_widget = nullptr;
        static RC::Unreal::UObject* s_browser_widget = nullptr;
        static RC::StringType s_last_text{};
        static std::string s_last_browser_url_loaded{};
        static uint32_t s_spawn_attempts = 0;
        static bool s_logged_enabled = false;

        if (!s_logged_enabled) {
            runtime_log_line("[in_game_overlay] enabled");
            runtime_log_line("[in_game_overlay] dump signatures: XsollaWebBrowserWidget::LoadUrl(FString); fallback: UWidgetBlueprintLibrary::Create(...); UUserWidget::AddToViewport(int32); UUserWidget::SetAlignmentInViewport(FVector2D); UUserWidget::SetPositionInViewport(FVector2D,bool); W_Text_C::SetText(FText)");
            kovaaks::RustBridge::emit_json("{\"ev\":\"in_game_overlay\",\"enabled\":true}");
            s_logged_enabled = true;
        }

        if (now_ms < s_next_tick_ms) {
            return;
        }
        s_next_tick_ms = now_ms + 200;

        if (s_widget && !ui_widget_probe_object_usable(s_widget)) {
            runtime_log_line("[in_game_overlay] widget invalidated; scheduling respawn");
            s_widget = nullptr;
            s_last_text.clear();
            s_next_spawn_attempt_ms = now_ms + 1000;
        }
        if (s_browser_widget && !ui_widget_probe_object_usable(s_browser_widget)) {
            runtime_log_line("[in_game_overlay] browser widget invalidated; scheduling reattach");
            s_browser_widget = nullptr;
            s_last_browser_url_loaded.clear();
            s_next_browser_attach_ms = now_ms + 1000;
        }

        s_in_game_overlay_stage = "resolve_controller";
        auto* controller = in_game_overlay_find_controller();
        s_in_game_overlay_stage = "resolve_widget_class";
        auto* widget_class = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UClass*>(
            nullptr,
            nullptr,
            STR("/Xsolla/Common/Components/Primitives/W_Text.W_Text_C")
        );
        s_in_game_overlay_stage = "resolve_create_fn";
        auto* create_widget_fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Script/UMG.WidgetBlueprintLibrary:Create")
        );
        s_in_game_overlay_stage = "resolve_add_fn";
        auto* add_to_viewport_fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Script/UMG.UserWidget:AddToViewport")
        );
        s_in_game_overlay_stage = "resolve_add_player_screen_fn";
        auto* add_to_player_screen_fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Script/UMG.UserWidget:AddToPlayerScreen")
        );
        s_in_game_overlay_stage = "resolve_align_fn";
        auto* set_alignment_in_viewport_fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Script/UMG.UserWidget:SetAlignmentInViewport")
        );
        s_in_game_overlay_stage = "resolve_position_fn";
        auto* set_position_in_viewport_fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Script/UMG.UserWidget:SetPositionInViewport")
        );
        s_in_game_overlay_stage = "resolve_viewport_fn";
        auto* get_viewport_size_fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Script/Engine.PlayerController:GetViewportSize")
        );
        s_in_game_overlay_stage = "resolve_set_text_fn";
        auto* set_text_fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Xsolla/Common/Components/Primitives/W_Text.W_Text_C:SetText")
        );
        s_in_game_overlay_stage = "resolve_browser_load_url_fn";
        auto* browser_load_url_fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Script/GameSkillsTrainer.XsollaWebBrowserWidget:LoadUrl")
        );
        s_in_game_overlay_stage = "resolve_browser_url";
        const auto browser_url_utf8 = in_game_overlay_resolve_browser_url_utf8();
        const bool browser_mode_requested = !browser_url_utf8.empty();
        const bool force_text_replay_hud = kmod_replay::replay_ingame_debug_overlay_enabled();

        if (browser_mode_requested) {
            if (!is_runtime_function_usable(browser_load_url_fn)) {
                if (s_last_browser_diag_log_ms == 0 || (now_ms - s_last_browser_diag_log_ms) >= 5000) {
                    s_last_browser_diag_log_ms = now_ms;
                    runtime_log_line("[in_game_overlay] browser mode requested but LoadUrl function unavailable");
                }
            } else {
                if (!ui_widget_probe_object_usable(s_browser_widget) && now_ms >= s_next_browser_attach_ms) {
                    s_in_game_overlay_stage = "resolve_browser_widget";
                    std::string browser_resolve_detail{};
                    auto* resolved_browser_widget = in_game_overlay_resolve_browser_widget(controller, &browser_resolve_detail);
                    if (ui_widget_probe_object_usable(resolved_browser_widget)) {
                        s_browser_widget = resolved_browser_widget;
                        s_last_browser_url_loaded.clear();
                        s_next_browser_load_attempt_ms = now_ms;
                        std::array<char, 512> bbuf{};
                        std::snprintf(
                            bbuf.data(),
                            bbuf.size(),
                            "[in_game_overlay] browser widget attached detail=%s",
                            browser_resolve_detail.c_str()
                        );
                        runtime_log_line(bbuf.data());
                        events_log_line(bbuf.data());
                    } else {
                        if (s_last_browser_diag_log_ms == 0 || (now_ms - s_last_browser_diag_log_ms) >= 5000) {
                            s_last_browser_diag_log_ms = now_ms;
                            std::array<char, 512> bbuf{};
                            std::snprintf(
                                bbuf.data(),
                                bbuf.size(),
                                "[in_game_overlay] browser widget unresolved detail=%s",
                                browser_resolve_detail.c_str()
                            );
                            runtime_log_line(bbuf.data());
                        }
                    }
                    s_next_browser_attach_ms = now_ms + 1000;
                }

                if (ui_widget_probe_object_usable(s_browser_widget)
                    && now_ms >= s_next_browser_load_attempt_ms
                    && s_last_browser_url_loaded != browser_url_utf8) {
                    s_in_game_overlay_stage = "browser_load_url";
                    std::string load_detail{};
                    const bool loaded = in_game_overlay_browser_load_url_safe(
                        s_browser_widget,
                        browser_load_url_fn,
                        browser_url_utf8,
                        &load_detail
                    );
                    std::array<char, 1024> bbuf{};
                    std::snprintf(
                        bbuf.data(),
                        bbuf.size(),
                        "[in_game_overlay] browser LoadUrl %s detail=%s",
                        loaded ? "ok" : "failed",
                        load_detail.c_str()
                    );
                    runtime_log_line(bbuf.data());
                    if (!loaded) {
                        events_log_line(bbuf.data());
                    }
                    if (loaded) {
                        s_last_browser_url_loaded = browser_url_utf8;
                        s_next_browser_load_attempt_ms = now_ms + 5000;
                        kovaaks::RustBridge::emit_json("{\"ev\":\"in_game_overlay_browser\",\"loaded\":true}");
                    } else {
                        s_next_browser_load_attempt_ms = now_ms + 1500;
                    }
                }
            }

            if (ui_widget_probe_object_usable(s_browser_widget)
                && s_last_browser_url_loaded == browser_url_utf8
                && !s_last_browser_url_loaded.empty()
                && !force_text_replay_hud) {
                return;
            }

            if (!force_text_replay_hud) {
                return;
            }
        }

        if (s_last_browser_diag_log_ms == 0 || (now_ms - s_last_browser_diag_log_ms) >= 8000) {
            s_last_browser_diag_log_ms = now_ms;
            runtime_log_line("[in_game_overlay] browser URL not configured; using legacy text HUD path");
        }

        const bool spawn_ready = ui_widget_probe_object_usable(controller)
            && widget_class
            && is_likely_valid_object_ptr(widget_class)
            && is_runtime_function_usable(create_widget_fn)
            && (
                is_runtime_function_usable(add_to_viewport_fn)
                || is_runtime_function_usable(add_to_player_screen_fn)
            );

        if (!spawn_ready && (s_last_diag_log_ms == 0 || (now_ms - s_last_diag_log_ms) >= 5000)) {
            s_last_diag_log_ms = now_ms;
            std::array<char, 384> rbuf{};
            std::snprintf(
                rbuf.data(),
                rbuf.size(),
                    "[in_game_overlay] spawn_not_ready stage=%s controller=%u widget_class=%u create_fn=%u add_fn=%u add_screen_fn=%u",
                s_in_game_overlay_stage,
                ui_widget_probe_object_usable(controller) ? 1u : 0u,
                (widget_class && is_likely_valid_object_ptr(widget_class)) ? 1u : 0u,
                is_runtime_function_usable(create_widget_fn) ? 1u : 0u,
                    is_runtime_function_usable(add_to_viewport_fn) ? 1u : 0u,
                    is_runtime_function_usable(add_to_player_screen_fn) ? 1u : 0u
            );
            runtime_log_line(rbuf.data());
        }

        if (!s_widget && spawn_ready && now_ms >= s_next_spawn_attempt_ms) {
            s_in_game_overlay_stage = "spawn_begin";
            ++s_spawn_attempts;
            int spawn_status = 0;
            RC::StringType return_name{};
            s_in_game_overlay_stage = "spawn_try_create";
            auto* created = in_game_overlay_try_create_widget(
                controller,
                controller,
                widget_class,
                create_widget_fn,
                &spawn_status,
                &return_name
            );
            s_in_game_overlay_stage = "spawn_created";

            if (ui_widget_probe_object_usable(created)) {
                std::string add_detail{};
                s_in_game_overlay_stage = "spawn_try_add_to_viewport";
                bool added = false;
                if (is_runtime_function_usable(add_to_viewport_fn)) {
                    added = in_game_overlay_add_to_viewport_safe(created, add_to_viewport_fn, 777, &add_detail);
                }
                if (!added && is_runtime_function_usable(add_to_player_screen_fn)) {
                    s_in_game_overlay_stage = "spawn_try_add_to_player_screen";
                    std::string add_screen_detail{};
                    const bool added_screen = in_game_overlay_add_to_player_screen_safe(
                        created,
                        add_to_player_screen_fn,
                        777,
                        &add_screen_detail
                    );
                    if (added_screen) {
                        added = true;
                        add_detail = std::string{"fallback_add_to_player_screen ok: "} + add_screen_detail;
                    } else {
                        add_detail += " | fallback_add_to_player_screen failed: ";
                        add_detail += add_screen_detail;
                    }
                }
                if (!added) {
                    std::array<char, 448> abuf{};
                    std::snprintf(
                        abuf.data(),
                        abuf.size(),
                        "[in_game_overlay] add_to_viewport failed attempt=%u status=%d detail=%s",
                        s_spawn_attempts,
                        spawn_status,
                        add_detail.c_str()
                    );
                    runtime_log_line(abuf.data());
                    events_log_line(abuf.data());
                }
                if (added
                    && is_runtime_function_usable(set_alignment_in_viewport_fn)
                    && is_runtime_function_usable(set_position_in_viewport_fn)) {
                    s_in_game_overlay_stage = "spawn_post_layout";
                    float center_x = 960.0f;
                    float center_y = 540.0f;
                    std::string center_detail{};
                    (void)in_game_overlay_get_viewport_center_safe(
                        controller,
                        get_viewport_size_fn,
                        &center_x,
                        &center_y,
                        &center_detail
                    );
                    std::string align_detail{};
                    const bool align_ok = in_game_overlay_set_alignment_safe(
                        created,
                        set_alignment_in_viewport_fn,
                        0.5f,
                        0.0f,
                        &align_detail
                    );
                    std::string pos_detail{};
                    const bool pos_ok = in_game_overlay_set_position_safe(
                        created,
                        set_position_in_viewport_fn,
                        center_x,
                        80.0f,
                        true,
                        &pos_detail
                    );
                    if (!align_ok || !pos_ok) {
                        std::array<char, 640> pbuf{};
                        std::snprintf(
                            pbuf.data(),
                            pbuf.size(),
                            "[in_game_overlay] post_spawn_layout partial center=%s align=%s position=%s",
                            center_detail.c_str(),
                            align_detail.c_str(),
                            pos_detail.c_str()
                        );
                        runtime_log_line(pbuf.data());
                        events_log_line(pbuf.data());
                    }
                }
                if (added) {
                    s_widget = created;
                    s_last_text.clear();
                    s_in_game_overlay_stage = "spawn_success";

                    std::array<char, 512> buf{};
                    std::snprintf(
                        buf.data(),
                        buf.size(),
                        "[in_game_overlay] widget spawned attempts=%u status=%d widget=%ls",
                        s_spawn_attempts,
                        spawn_status,
                        return_name.c_str()
                    );
                    runtime_log_line(buf.data());
                    events_log_line(buf.data());
                }
            } else {
                s_in_game_overlay_stage = "spawn_failed";
                std::array<char, 256> buf{};
                std::snprintf(
                    buf.data(),
                    buf.size(),
                    "[in_game_overlay] spawn failed attempts=%u status=%d",
                    s_spawn_attempts,
                    spawn_status
                );
                runtime_log_line(buf.data());
            }

            s_next_spawn_attempt_ms = now_ms + 2000;
        }

        if (!ui_widget_probe_object_usable(s_widget) || !is_runtime_function_usable(set_text_fn)) {
            return;
        }

        if ((now_ms - s_last_set_text_ms) < 400) {
            return;
        }
        s_last_set_text_ms = now_ms;

        const bool in_challenge = s_last_pull_is_in_challenge > 0;
        const bool in_scenario = s_last_pull_is_in_scenario > 0;
        const bool in_editor = s_last_pull_is_in_scenario_editor > 0 || s_last_pull_scenario_is_in_editor > 0;
        const bool paused = s_last_pull_scenario_is_paused > 0;
        const double queue_remaining = s_last_pull_queue_time_remaining > 0.0f
            ? static_cast<double>(s_last_pull_queue_time_remaining)
            : 0.0;
        const bool queued = queue_remaining > 0.0001 && !in_challenge;

        const wchar_t* state_label = L"MENU";
        if (in_editor) {
            state_label = L"EDITOR";
        } else if (paused) {
            state_label = L"PAUSED";
        } else if (in_challenge) {
            state_label = L"CHALLENGE";
        } else if (queued) {
            state_label = L"QUEUED";
        } else if (in_scenario) {
            state_label = L"SCENARIO";
        }

        const double score = s_last_pull_score > 0.0f
            ? static_cast<double>(s_last_pull_score)
            : 0.0;
        const int32_t kills = s_last_pull_kills > 0 ? s_last_pull_kills : 0;
        const double spm = s_last_pull_spm > 0.0f
            ? static_cast<double>(s_last_pull_spm)
            : 0.0;
        const double challenge_seconds = s_last_pull_challenge_seconds > 0.0f
            ? static_cast<double>(s_last_pull_challenge_seconds)
            : 0.0;
        const double challenge_fps = s_last_pull_challenge_average_fps > 0.0f
            ? static_cast<double>(s_last_pull_challenge_average_fps)
            : 0.0;
        const int32_t challenge_tick = s_last_pull_challenge_tick_count > 0
            ? s_last_pull_challenge_tick_count
            : 0;
        const double time_remaining = s_last_pull_time_remaining > 0.0f
            ? static_cast<double>(s_last_pull_time_remaining)
            : 0.0;

        std::wstring scenario_name_w{};
        if (!s_last_run_scenario_name.empty()) {
            scenario_name_w.assign(s_last_run_scenario_name.begin(), s_last_run_scenario_name.end());
            if (scenario_name_w.size() > 32) {
                scenario_name_w.resize(29);
                scenario_name_w += L"...";
            }
        }

        s_in_game_overlay_stage = "compose_text";
        RC::StringType overlay_text = STR("AimMod | ");
        overlay_text += state_label;
        if (!scenario_name_w.empty()) {
            overlay_text += STR(" | ");
            overlay_text += scenario_name_w;
        }

        if (in_challenge || in_scenario || queued) {
            overlay_text += STR(" | Score ");
            overlay_text += std::to_wstring(static_cast<long long>(std::llround(score)));
            overlay_text += STR(" | K ");
            overlay_text += std::to_wstring(static_cast<long long>(kills));
            overlay_text += STR(" | SPM ");
            overlay_text += std::to_wstring(static_cast<long long>(std::llround(spm)));
            if (challenge_seconds > 0.0001) {
                overlay_text += STR(" | CHs ");
                overlay_text += std::to_wstring(static_cast<long long>(std::llround(challenge_seconds)));
            }
            if (time_remaining > 0.0001) {
                overlay_text += STR(" | REM ");
                overlay_text += std::to_wstring(static_cast<long long>(std::llround(time_remaining)));
            }
            if (challenge_fps > 0.0001) {
                overlay_text += STR(" | FPS ");
                overlay_text += std::to_wstring(static_cast<long long>(std::llround(challenge_fps)));
            }
            if (challenge_tick > 0) {
                overlay_text += STR(" | TICK ");
                overlay_text += std::to_wstring(static_cast<long long>(challenge_tick));
            }
        } else {
            overlay_text += STR(" | waiting for live challenge metrics");
        }

        (void)kmod_replay::replay_ingame_append_debug_overlay_text(overlay_text);

        if (overlay_text == s_last_text) {
            return;
        }

        s_in_game_overlay_stage = "set_text";
        std::string set_text_detail{};
        s_in_game_overlay_stage = "set_text_invoke";
        if (in_game_overlay_set_w_text(s_widget, set_text_fn, overlay_text, &set_text_detail)) {
            s_last_text = overlay_text;
            if (s_last_diag_log_ms == 0 || (now_ms - s_last_diag_log_ms) >= 5000) {
                s_last_diag_log_ms = now_ms;
                std::array<char, 384> tbuf{};
                std::snprintf(
                    tbuf.data(),
                    tbuf.size(),
                    "[in_game_overlay] set_text ok stage=%s detail=%s",
                    s_in_game_overlay_stage,
                    set_text_detail.c_str()
                );
                runtime_log_line(tbuf.data());
            }
        } else {
            std::array<char, 384> tbuf{};
            std::snprintf(
                tbuf.data(),
                tbuf.size(),
                "[in_game_overlay] set_text failed stage=%s detail=%s",
                s_in_game_overlay_stage,
                set_text_detail.c_str()
            );
            runtime_log_line(tbuf.data());
            events_log_line(tbuf.data());
        }
    }

    static auto in_game_overlay_tick(uint64_t now_ms) -> void {
        if (!in_game_overlay_enabled()) {
            return;
        }
        if (s_in_game_overlay_fault_latched.load(std::memory_order_acquire)) {
            const auto retry_after = s_in_game_overlay_fault_retry_after_ms.load(std::memory_order_acquire);
            if (retry_after == 0 || now_ms < retry_after) {
                return;
            }
            s_in_game_overlay_fault_latched.store(false, std::memory_order_release);
            runtime_log_line("[in_game_overlay] retrying after prior fault");
        }

#if defined(_MSC_VER)
        __try {
            in_game_overlay_tick_impl(now_ms);
        } __except(EXCEPTION_EXECUTE_HANDLER) {
            s_in_game_overlay_fault_latched.store(true, std::memory_order_release);
            const auto fault_count = s_in_game_overlay_fault_count.fetch_add(1, std::memory_order_acq_rel) + 1;
            const uint64_t backoff_ms = static_cast<uint64_t>(std::min<uint32_t>(fault_count, 12u)) * 500;
            s_in_game_overlay_fault_retry_after_ms.store(now_ms + std::max<uint64_t>(1500, backoff_ms), std::memory_order_release);
            std::array<char, 320> fbuf{};
            std::snprintf(
                fbuf.data(),
                fbuf.size(),
                "[in_game_overlay] seh_fault_latched stage=%s (retry scheduled)",
                s_in_game_overlay_stage ? s_in_game_overlay_stage : "unknown"
            );
            runtime_log_line(fbuf.data());
            events_log_line(fbuf.data());
            kovaaks::RustBridge::emit_json("{\"ev\":\"in_game_overlay_fault\",\"latched\":true}");
        }
#else
        in_game_overlay_tick_impl(now_ms);
#endif
    }
