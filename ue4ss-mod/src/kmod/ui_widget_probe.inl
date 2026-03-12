    static auto ui_widget_probe_enabled() -> bool {
        return env_flag_enabled("KOVAAKS_UI_WIDGET_PROBE")
            || ui_widget_probe_flag_enabled();
    }

    static auto ui_widget_probe_object_usable(RC::Unreal::UObject* obj) -> bool {
        if (!is_runtime_object_usable(obj)) {
            return false;
        }
        const auto full_name = obj->GetFullName();
        if (full_name.find(STR("None.None:None.None")) != RC::StringType::npos) {
            return false;
        }
        return true;
    }

    static auto ui_widget_probe_create_widget(
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

        // Fast path for this game's UMG Create signature from object dump:
        // WorldContextObject @ 0x00, WidgetType @ 0x08, OwningPlayer @ 0x10, ReturnValue @ 0x18.
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
                if (!output_object && object_property && is_likely_valid_object_ptr(object_property)) {
                    output_object = object_property;
                }
                continue;
            }

            void* value_ptr = safe_property_value_ptr(property, params.data());
            if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(void*))) {
                continue;
            }

            if (normalized_name.find("worldcontextobject") != std::string::npos
                && object_property
                && is_likely_valid_object_ptr(object_property)) {
                object_property->SetObjectPropertyValue(value_ptr, world_context);
            } else if (normalized_name == "widgettype") {
                if (object_property && is_likely_valid_object_ptr(object_property)) {
                    object_property->SetObjectPropertyValue(value_ptr, widget_class);
                } else {
                    *reinterpret_cast<RC::Unreal::UObject**>(value_ptr) = widget_class;
                }
            } else if (normalized_name == "owningplayer"
                && object_property
                && is_likely_valid_object_ptr(object_property)) {
                object_property->SetObjectPropertyValue(value_ptr, owning_player);
            }
        }

        if (!output_object || !is_likely_valid_object_ptr(output_object)) {
            if (out_status) {
                *out_status = 3;
            }
            return nullptr;
        }

        library_cdo->ProcessEvent(create_fn, params.data());

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

    static auto ui_widget_probe_add_to_viewport(
        RC::Unreal::UObject* widget,
        RC::Unreal::UFunction* add_to_viewport_fn
    ) -> bool {
        if (!widget || !is_runtime_function_usable(add_to_viewport_fn)) {
            return false;
        }
        if (!is_likely_valid_object_ptr(widget) && !is_likely_readable_region(widget, sizeof(void*))) {
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

        for (RC::Unreal::FProperty* property : enumerate_properties(add_to_viewport_fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_Parm)
                || property_has_any_flags(property, RC::Unreal::CPF_OutParm)
                || property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                continue;
            }

            auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property);
            if (!numeric || !is_likely_valid_object_ptr(numeric)) {
                continue;
            }
            const auto name = normalize_ascii(property->GetName());
            if (name != "zorder") {
                continue;
            }
            void* value_ptr = safe_property_value_ptr(property, params.data());
            if (!value_ptr) {
                continue;
            }
            numeric->SetIntPropertyValue(value_ptr, static_cast<int64_t>(777));
        }

        widget->ProcessEvent(add_to_viewport_fn, params.data());
        return true;
    }

    struct UiWidgetProbeVec2 {
        float X;
        float Y;
    };

    static auto ui_widget_probe_set_w_text(
        RC::Unreal::UObject* widget,
        RC::Unreal::UFunction* set_text_fn,
        const wchar_t* message
    ) -> bool {
        (void)widget;
        (void)set_text_fn;
        (void)message;
        return false;
    }

    static auto ui_widget_probe_get_viewport_center(
        RC::Unreal::UObject* controller,
        RC::Unreal::UFunction* get_viewport_size_fn,
        float* out_center_x,
        float* out_center_y
    ) -> bool {
        if (!controller || !is_runtime_function_usable(get_viewport_size_fn)) {
            return false;
        }
        if (!out_center_x || !out_center_y) {
            return false;
        }
        if (!is_likely_valid_object_ptr(controller) && !is_likely_readable_region(controller, sizeof(void*))) {
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

        controller->ProcessEvent(get_viewport_size_fn, params.data());

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
            return false;
        }

        *out_center_x = static_cast<float>(size_x) * 0.5f;
        *out_center_y = static_cast<float>(size_y) * 0.5f;
        return true;
    }

    static auto ui_widget_probe_set_alignment_in_viewport(
        RC::Unreal::UObject* widget,
        RC::Unreal::UFunction* set_alignment_fn,
        float align_x,
        float align_y
    ) -> bool {
        if (!widget || !is_runtime_function_usable(set_alignment_fn)) {
            return false;
        }
        if (!is_likely_valid_object_ptr(widget) && !is_likely_readable_region(widget, sizeof(void*))) {
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

        bool wrote = false;
        const UiWidgetProbeVec2 alignment{align_x, align_y};
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
            if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(UiWidgetProbeVec2))) {
                continue;
            }
            std::memcpy(value_ptr, &alignment, sizeof(UiWidgetProbeVec2));
            wrote = true;
            break;
        }

        if (!wrote) {
            return false;
        }

        widget->ProcessEvent(set_alignment_fn, params.data());
        return true;
    }

    static auto ui_widget_probe_set_position_in_viewport(
        RC::Unreal::UObject* widget,
        RC::Unreal::UFunction* set_position_fn,
        float pos_x,
        float pos_y,
        bool remove_dpi_scale
    ) -> bool {
        if (!widget || !is_runtime_function_usable(set_position_fn)) {
            return false;
        }
        if (!is_likely_valid_object_ptr(widget) && !is_likely_readable_region(widget, sizeof(void*))) {
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

        bool wrote_position = false;
        bool wrote_dpi_flag = false;
        const UiWidgetProbeVec2 position{pos_x, pos_y};

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
                if (!is_likely_readable_region(value_ptr, sizeof(UiWidgetProbeVec2))) {
                    continue;
                }
                std::memcpy(value_ptr, &position, sizeof(UiWidgetProbeVec2));
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
            return false;
        }

        widget->ProcessEvent(set_position_fn, params.data());
        return wrote_dpi_flag || true;
    }

    static auto ui_widget_probe_tick(uint64_t now_ms) -> void {
        if (!ui_widget_probe_enabled()) {
            return;
        }

        static uint64_t s_next_probe_ms = 0;
        static RC::Unreal::UObject* s_last_controller = nullptr;
        static RC::Unreal::UObject* s_last_player_ui = nullptr;
        static RC::Unreal::UObject* s_spawned_widget = nullptr;
        static RC::StringType s_last_spawn_class{};
        static RC::StringType s_last_spawn_class_source{};
        static RC::StringType s_last_spawn_context{};
        static RC::StringType s_last_spawn_owner{};
        static uint32_t s_spawn_attempts = 0;
        static bool s_spawn_success = false;
        static bool s_text_set_attempted = false;
        static bool s_text_set_success = false;
        static bool s_add_to_viewport_attempted = false;
        static bool s_add_to_viewport_success = false;
        static bool s_center_attempted = false;
        static bool s_center_success = false;
        static int s_last_spawn_status = 0;
        static RC::StringType s_last_spawn_return_name{};
        static uint64_t s_next_spawn_attempt_ms = 0;
        static uint64_t s_last_emit_ms = 0;
        if (now_ms < s_next_probe_ms) {
            return;
        }
        s_next_probe_ms = now_ms + 1000;

        std::vector<RC::Unreal::UObject*> candidates{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("NewCharacterPlayerController"), candidates);
        std::vector<RC::Unreal::UObject*> alt_candidates{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("NewCharacterPlayerController_C"), alt_candidates);
        append_unique_objects(candidates, alt_candidates);

        RC::Unreal::UObject* controller = nullptr;
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
            if (!controller || score > best_score) {
                controller = obj;
                best_score = score;
            }
        }
        if (!ui_widget_probe_object_usable(controller)) {
            controller = nullptr;
        }

        RC::Unreal::UObject* player_ui = nullptr;
        if (controller && is_likely_valid_object_ptr(controller)) {
            auto** player_ui_ptr = controller->GetValuePtrByPropertyNameInChain<RC::Unreal::UObject*>(STR("PlayerUI"));
            if (player_ui_ptr && is_likely_readable_region(player_ui_ptr, sizeof(void*))) {
                auto* value = *player_ui_ptr;
                if (ui_widget_probe_object_usable(value)) {
                    player_ui = value;
                }
            }

            if (!ui_widget_probe_object_usable(player_ui)) {
                auto* controller_class = controller->GetClassPrivate();
                if (controller_class && is_likely_valid_object_ptr(controller_class)) {
                    for (RC::Unreal::FProperty* property : enumerate_properties_in_chain(controller_class)) {
                        if (!property || !is_likely_valid_object_ptr(property)) {
                            continue;
                        }
                        auto* object_property = RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property);
                        if (!object_property || !is_likely_valid_object_ptr(object_property)) {
                            continue;
                        }
                        const auto name = property->GetName();
                        if (name.empty() || normalize_ascii(name) != "playerui") {
                            continue;
                        }
                        void* value_ptr = safe_property_value_ptr(object_property, reinterpret_cast<void*>(controller));
                        if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(void*))) {
                            continue;
                        }
                        auto* value = object_property->GetObjectPropertyValue(value_ptr);
                        if (ui_widget_probe_object_usable(value)) {
                            player_ui = value;
                            break;
                        }
                    }
                }
            }
        }
        if (!ui_widget_probe_object_usable(player_ui)) {
            player_ui = nullptr;
        }

        RC::Unreal::UClass* player_ui_class = nullptr;
        RC::StringType player_ui_class_path{};
        const std::array<const wchar_t*, 7> spawn_class_paths{
            STR("/Game/FirstPersonBP/Blueprints/UI/WBP_HUD.WBP_HUD_C"),
            STR("/Game/FirstPersonBP/Blueprints/UI/GameUI/PlayerUI.PlayerUI_C"),
            STR("/Script/GameSkillsTrainer.PlayerUiWidget"),
            STR("/Script/GameSkillsTrainer.MetaHudWidget"),
            STR("/Script/GameSkillsTrainer.ScenarioPlayerWidget"),
            STR("/Script/GameSkillsTrainer.SessionStatisticsWidget"),
            STR("/Script/GameSkillsTrainer.ChallengeEndScoreWidget")
        };
        for (const auto* path : spawn_class_paths) {
            auto* cls = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UClass*>(
                nullptr,
                nullptr,
                path
            );
            if (cls && is_likely_valid_object_ptr(cls)) {
                player_ui_class = cls;
                player_ui_class_path = path;
                break;
            }
        }
        auto* add_to_viewport_fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Script/UMG.UserWidget:AddToViewport")
        );
        auto* create_widget_fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Script/UMG.WidgetBlueprintLibrary:Create")
        );
        auto* set_alignment_in_viewport_fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Script/UMG.UserWidget:SetAlignmentInViewport")
        );
        auto* set_position_in_viewport_fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Script/UMG.UserWidget:SetPositionInViewport")
        );
        auto* get_viewport_size_fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Script/Engine.PlayerController:GetViewportSize")
        );
        const bool spawn_ready = is_runtime_object_usable(controller)
            && player_ui_class
            && is_likely_valid_object_ptr(player_ui_class)
            && is_runtime_function_usable(create_widget_fn);

        std::array<char, 512> pmsg{};
        std::snprintf(
            pmsg.data(),
            pmsg.size(),
            "{\"ev\":\"ui_widget_spawn_ping\",\"ready\":%u,\"attempts\":%u,\"success\":%u,\"status\":%d,\"text_attempted\":%u,\"text_success\":%u,\"add_attempted\":%u,\"add_success\":%u,\"center_attempted\":%u,\"center_success\":%u}",
            spawn_ready ? 1u : 0u,
            s_spawn_attempts,
            s_spawn_success ? 1u : 0u,
            s_last_spawn_status,
            s_text_set_attempted ? 1u : 0u,
            s_text_set_success ? 1u : 0u,
            s_add_to_viewport_attempted ? 1u : 0u,
            s_add_to_viewport_success ? 1u : 0u,
            s_center_attempted ? 1u : 0u,
            s_center_success ? 1u : 0u
        );
        kovaaks::RustBridge::emit_json(pmsg.data());

        std::array<char, 512> plog{};
        std::snprintf(
            plog.data(),
            plog.size(),
            "[ui_widget_spawn_ping] ready=%u attempts=%u success=%u status=%d text_attempted=%u text_success=%u add_attempted=%u add_success=%u center_attempted=%u center_success=%u",
            spawn_ready ? 1u : 0u,
            s_spawn_attempts,
            s_spawn_success ? 1u : 0u,
            s_last_spawn_status,
            s_text_set_attempted ? 1u : 0u,
            s_text_set_success ? 1u : 0u,
            s_add_to_viewport_attempted ? 1u : 0u,
            s_add_to_viewport_success ? 1u : 0u,
            s_center_attempted ? 1u : 0u,
            s_center_success ? 1u : 0u
        );
        runtime_log_line(plog.data());
        events_log_line(plog.data());

        static bool s_last_spawn_ready = false;
        if (!spawn_ready) {
            if (s_last_spawn_ready) {
                s_spawn_attempts = 0;
                s_spawn_success = false;
                s_text_set_attempted = false;
                s_text_set_success = false;
                s_add_to_viewport_attempted = false;
                s_add_to_viewport_success = false;
                s_center_attempted = false;
                s_center_success = false;
                s_next_spawn_attempt_ms = now_ms + 1000;
            }
        }
        s_last_spawn_ready = spawn_ready;

        if (!s_spawn_success
            && spawn_ready
            && now_ms >= s_next_spawn_attempt_ms) {
            ++s_spawn_attempts;
            s_next_spawn_attempt_ms = now_ms + 2000;
            s_spawned_widget = nullptr;
            s_last_spawn_class.clear();
            s_last_spawn_class_source.clear();
            s_last_spawn_context.clear();
            s_last_spawn_owner.clear();
            s_last_spawn_status = 0;
            s_last_spawn_return_name.clear();
            s_text_set_attempted = false;
            s_text_set_success = false;
            s_add_to_viewport_attempted = false;
            s_add_to_viewport_success = false;
            s_center_attempted = false;
            s_center_success = false;

            std::array<RC::Unreal::UObject*, 3> world_context_candidates{
                controller,
                s_meta_game_instance,
                player_ui
            };
            std::array<RC::Unreal::UObject*, 2> owning_player_candidates{
                controller,
                nullptr
            };
            for (const auto* path : spawn_class_paths) {
                auto* cls = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UClass*>(
                    nullptr,
                    nullptr,
                    path
                );
                if (!cls || !is_likely_valid_object_ptr(cls)) {
                    continue;
                }
                for (auto* world_ctx : world_context_candidates) {
                    if (!ui_widget_probe_object_usable(world_ctx)) {
                        continue;
                    }
                    for (auto* owner_ctx : owning_player_candidates) {
                        if (owner_ctx && !ui_widget_probe_object_usable(owner_ctx)) {
                            continue;
                        }
                        int spawn_status = 0;
                        RC::StringType return_name{};
                        auto* created = ui_widget_probe_create_widget(
                            world_ctx,
                            owner_ctx,
                            cls,
                            create_widget_fn,
                            &spawn_status,
                            &return_name
                        );
                        s_last_spawn_status = spawn_status;
                        s_last_spawn_class = path;
                        s_last_spawn_class_source = s_last_spawn_class.rfind(STR("/Script/"), 0) == 0
                            ? RC::StringType{STR("script")}
                            : RC::StringType{STR("asset")};
                        s_last_spawn_context = world_ctx->GetFullName();
                        s_last_spawn_owner = owner_ctx ? owner_ctx->GetFullName() : RC::StringType{STR("<null>")};
                        s_last_spawn_return_name = return_name;

                        static uint32_t s_subattempt_logs = 0;
                        if (s_subattempt_logs < 200) {
                            ++s_subattempt_logs;
                            std::array<char, 1024> subbuf{};
                            std::snprintf(
                                subbuf.data(),
                                subbuf.size(),
                                "[ui_widget_spawn_try] attempt=%u class=%ls class_source=%ls world_context=%ls owning_player=%ls status=%d return=%ls",
                                s_spawn_attempts,
                                s_last_spawn_class.c_str(),
                                s_last_spawn_class_source.c_str(),
                                s_last_spawn_context.c_str(),
                                s_last_spawn_owner.c_str(),
                                s_last_spawn_status,
                                s_last_spawn_return_name.c_str()
                            );
                            runtime_log_line(subbuf.data());
                            events_log_line(subbuf.data());
                        }

                        if (!created || (!is_likely_valid_object_ptr(created) && !is_likely_readable_region(created, sizeof(void*)))) {
                            continue;
                        }
                        s_spawned_widget = created;
                        break;
                    }
                    if (s_spawned_widget) {
                        break;
                    }
                }
                if (s_spawned_widget) {
                    break;
                }
            }
            s_spawn_success = is_runtime_object_usable(s_spawned_widget);
            if (s_spawn_success) {
                const bool is_script_class = s_last_spawn_class_source == STR("script");
                const bool allow_add_for_class = !is_script_class;
                if (allow_add_for_class && is_runtime_function_usable(add_to_viewport_fn)) {
                    s_add_to_viewport_attempted = true;
                    s_add_to_viewport_success = ui_widget_probe_add_to_viewport(
                        s_spawned_widget,
                        add_to_viewport_fn
                    );

                    if (s_add_to_viewport_success
                        && is_runtime_function_usable(set_alignment_in_viewport_fn)
                        && is_runtime_function_usable(set_position_in_viewport_fn)) {
                        float center_x = 960.0f;
                        float center_y = 540.0f;
                        (void)ui_widget_probe_get_viewport_center(
                            controller,
                            get_viewport_size_fn,
                            &center_x,
                            &center_y
                        );

                        s_center_attempted = true;
                        const bool alignment_ok = ui_widget_probe_set_alignment_in_viewport(
                            s_spawned_widget,
                            set_alignment_in_viewport_fn,
                            0.5f,
                            0.5f
                        );
                        const bool position_ok = ui_widget_probe_set_position_in_viewport(
                            s_spawned_widget,
                            set_position_in_viewport_fn,
                            center_x,
                            center_y,
                            true
                        );
                        s_center_success = alignment_ok && position_ok;

                        std::array<char, 256> cbuf{};
                        std::snprintf(
                            cbuf.data(),
                            cbuf.size(),
                            "[ui_widget_center] attempted=%u success=%u x=%.1f y=%.1f",
                            s_center_attempted ? 1u : 0u,
                            s_center_success ? 1u : 0u,
                            center_x,
                            center_y
                        );
                        runtime_log_line(cbuf.data());
                        events_log_line(cbuf.data());
                    }
                } else {
                    std::array<char, 512> skipbuf{};
                    std::snprintf(
                        skipbuf.data(),
                        skipbuf.size(),
                        "[ui_widget_add_to_viewport_skip] class_source=%ls has_add_to_viewport_fn=%u",
                        s_last_spawn_class_source.c_str(),
                        is_runtime_function_usable(add_to_viewport_fn) ? 1u : 0u
                    );
                    runtime_log_line(skipbuf.data());
                    events_log_line(skipbuf.data());
                }
            }

            const auto spawned_name = s_last_spawn_return_name;
            std::array<char, 512> smsg{};
            std::snprintf(
                smsg.data(),
                smsg.size(),
                "{\"ev\":\"ui_widget_spawn_test\",\"attempt\":%u,\"created\":%u,\"text_attempted\":%u,\"text_set\":%u,\"add_attempted\":%u,\"added_to_viewport\":%u,\"center_attempted\":%u,\"centered\":%u,\"status\":%d,\"class_source\":\"%s\"}",
                s_spawn_attempts,
                s_spawn_success ? 1u : 0u,
                s_text_set_attempted ? 1u : 0u,
                s_text_set_success ? 1u : 0u,
                s_add_to_viewport_attempted ? 1u : 0u,
                s_add_to_viewport_success ? 1u : 0u,
                s_center_attempted ? 1u : 0u,
                s_center_success ? 1u : 0u,
                s_last_spawn_status,
                escape_json(utf8_from_wide(s_last_spawn_class_source)).c_str()
            );
            kovaaks::RustBridge::emit_json(smsg.data());

            std::array<char, 1400> slog{};
            std::snprintf(
                slog.data(),
                slog.size(),
                "[ui_widget_spawn_test] attempt=%u created=%u text_attempted=%u text_set=%u add_attempted=%u added_to_viewport=%u center_attempted=%u centered=%u class=%ls class_source=%ls world_context=%ls owning_player=%ls status=%d widget=%ls create_return=%ls",
                s_spawn_attempts,
                s_spawn_success ? 1u : 0u,
                s_text_set_attempted ? 1u : 0u,
                s_text_set_success ? 1u : 0u,
                s_add_to_viewport_attempted ? 1u : 0u,
                s_add_to_viewport_success ? 1u : 0u,
                s_center_attempted ? 1u : 0u,
                s_center_success ? 1u : 0u,
                s_last_spawn_class.c_str(),
                s_last_spawn_class_source.c_str(),
                s_last_spawn_context.c_str(),
                s_last_spawn_owner.c_str(),
                s_last_spawn_status,
                spawned_name.c_str(),
                s_last_spawn_return_name.c_str()
            );
            runtime_log_line(slog.data());
            events_log_line(slog.data());
        }

        const bool changed = (controller != s_last_controller) || (player_ui != s_last_player_ui);
        const bool periodic = (s_last_emit_ms == 0) || ((now_ms - s_last_emit_ms) >= 10000);
        if (!changed && !periodic) {
            return;
        }

        s_last_controller = controller;
        s_last_player_ui = player_ui;
        s_last_emit_ms = now_ms;

        const auto controller_name = controller ? controller->GetFullName() : RC::StringType{};
        const auto player_ui_name = player_ui ? player_ui->GetFullName() : RC::StringType{};
        const auto controller_utf8 = escape_json(utf8_from_wide(controller_name));
        const auto player_ui_utf8 = escape_json(utf8_from_wide(player_ui_name));

        std::array<char, 1400> msg{};
        std::snprintf(
            msg.data(),
            msg.size(),
            "{\"ev\":\"ui_widget_probe\",\"controller\":\"%s\",\"player_ui\":\"%s\",\"has_playerui_class\":%u,\"has_create_widget\":%u,\"has_add_to_viewport\":%u,\"spawn_ready\":%u,\"spawn_attempted\":%u,\"spawn_attempts\":%u,\"spawn_success\":%u,\"spawn_text_attempted\":%u,\"spawn_text_set\":%u,\"spawn_add_attempted\":%u,\"spawn_added_to_viewport\":%u,\"spawn_center_attempted\":%u,\"spawn_centered\":%u,\"spawn_class\":\"%s\",\"spawn_class_source\":\"%s\",\"spawn_context\":\"%s\",\"spawn_status\":%d,\"changed\":%u}",
            controller_utf8.c_str(),
            player_ui_utf8.c_str(),
            (player_ui_class && is_likely_valid_object_ptr(player_ui_class)) ? 1u : 0u,
            (create_widget_fn && is_runtime_function_usable(create_widget_fn)) ? 1u : 0u,
            (add_to_viewport_fn && is_runtime_function_usable(add_to_viewport_fn)) ? 1u : 0u,
            spawn_ready ? 1u : 0u,
            s_spawn_attempts > 0 ? 1u : 0u,
            s_spawn_attempts,
            s_spawn_success ? 1u : 0u,
            s_text_set_attempted ? 1u : 0u,
            s_text_set_success ? 1u : 0u,
            s_add_to_viewport_attempted ? 1u : 0u,
            s_add_to_viewport_success ? 1u : 0u,
            s_center_attempted ? 1u : 0u,
            s_center_success ? 1u : 0u,
            escape_json(utf8_from_wide(s_last_spawn_class)).c_str(),
            escape_json(utf8_from_wide(s_last_spawn_class_source)).c_str(),
            escape_json(utf8_from_wide(s_last_spawn_context)).c_str(),
            s_last_spawn_status,
            changed ? 1u : 0u
        );
        kovaaks::RustBridge::emit_json(msg.data());

        std::array<char, 1400> lbuf{};
        std::snprintf(
            lbuf.data(),
            lbuf.size(),
            "[ui_widget_probe] controller=%ls player_ui=%ls has_playerui_class=%u has_create_widget=%u has_add_to_viewport=%u spawn_attempted=%u spawn_attempts=%u spawn_success=%u spawn_text_attempted=%u spawn_text_set=%u spawn_add_attempted=%u spawn_added_to_viewport=%u spawn_center_attempted=%u spawn_centered=%u spawn_class=%ls spawn_class_source=%ls spawn_context=%ls spawn_status=%d changed=%u",
            controller_name.c_str(),
            player_ui_name.c_str(),
            (player_ui_class && is_likely_valid_object_ptr(player_ui_class)) ? 1u : 0u,
            (create_widget_fn && is_runtime_function_usable(create_widget_fn)) ? 1u : 0u,
            (add_to_viewport_fn && is_runtime_function_usable(add_to_viewport_fn)) ? 1u : 0u,
            s_spawn_attempts > 0 ? 1u : 0u,
            s_spawn_attempts,
            s_spawn_success ? 1u : 0u,
            s_text_set_attempted ? 1u : 0u,
            s_text_set_success ? 1u : 0u,
            s_add_to_viewport_attempted ? 1u : 0u,
            s_add_to_viewport_success ? 1u : 0u,
            s_center_attempted ? 1u : 0u,
            s_center_success ? 1u : 0u,
            s_last_spawn_class.c_str(),
            s_last_spawn_class_source.c_str(),
            s_last_spawn_context.c_str(),
            s_last_spawn_status,
            changed ? 1u : 0u
        );
        runtime_log_line(lbuf.data());
        events_log_line(lbuf.data());
    }
