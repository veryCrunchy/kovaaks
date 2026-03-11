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

    RC::Unreal::UClass* xsolla_login_subsystem_class_{nullptr};
    RC::Unreal::UObject* xsolla_login_subsystem_{nullptr};
    RC::Unreal::UFunction* xsolla_get_user_details_fn_{nullptr};
    RC::Unreal::UFunction* xsolla_get_login_data_fn_{nullptr};
    RC::Unreal::UFunction* xsolla_get_social_friends_fn_{nullptr};
    RC::Unreal::UFunction* xsolla_get_linked_social_networks_fn_{nullptr};
    RC::Unreal::UFunction* xsolla_get_login_settings_fn_{nullptr};
    RC::Unreal::UFunction* get_game_instance_subsystem_fn_{nullptr};
    uint64_t next_user_bridge_refresh_ms_{0};
    uint64_t next_user_management_debug_log_ms_{0};
    std::string last_user_management_debug_message_{};
    std::string last_emitted_user_snapshot_{};
    std::string last_emitted_friends_snapshot_{};

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
        if (kovaaks::RustBridge::is_connected()) {
            std::string json = "{\"ev\":\"kovaaks_user_debug\",\"message\":\"";
            json += escape_json_ascii(message);
            json += "\"}";
            kovaaks::RustBridge::emit_json(json.c_str());
        }
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
        const auto wanted_key = canonicalize_property_name(wanted_name);
        for (RC::Unreal::FProperty* property : enumerate_properties_in_chain(owner)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (canonicalize_property_name(normalize_ascii(property->GetName())) != wanted_key) {
                continue;
            }
            auto* str_property = RC::Unreal::CastField<RC::Unreal::FStrProperty>(property);
            if (!str_property || !is_likely_valid_object_ptr(str_property)) {
                continue;
            }
            void* value_ptr = safe_property_value_ptr(property, container);
            if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(RC::Unreal::FString))) {
                continue;
            }
            out = trim_nonempty_ascii(
                utf8_from_fstring(str_property->GetPropertyValue(value_ptr))
            );
            return !out.empty();
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
        const auto wanted_key = canonicalize_property_name(wanted_name);
        for (RC::Unreal::FProperty* property : enumerate_properties_in_chain(owner)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (canonicalize_property_name(normalize_ascii(property->GetName())) != wanted_key) {
                continue;
            }
            auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property);
            if (!numeric || !is_likely_valid_object_ptr(numeric) || !numeric->IsInteger()) {
                continue;
            }
            void* value_ptr = safe_property_value_ptr(property, container);
            if (!value_ptr) {
                continue;
            }
            out = static_cast<int32_t>(numeric->GetSignedIntPropertyValue(value_ptr));
            return true;
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

    bool read_string_array_struct_field(
        RC::Unreal::FProperty* property,
        void* value_ptr,
        const char* field_name,
        std::vector<BridgeLinkedIdentity>& out_accounts
    ) {
        auto* array_property = RC::Unreal::CastField<RC::Unreal::FArrayProperty>(property);
        if (!array_property || !is_likely_valid_object_ptr(array_property)) {
            return false;
        }
        auto* inner_struct = RC::Unreal::CastField<RC::Unreal::FStructProperty>(array_property->GetInner());
        if (!inner_struct || !is_likely_valid_object_ptr(inner_struct)) {
            return false;
        }
        auto* script_struct = RC::Unreal::ToRawPtr(inner_struct->GetStruct());
        if (!script_struct || !is_likely_valid_object_ptr(script_struct)) {
            return false;
        }
        auto* struct_owner = reinterpret_cast<RC::Unreal::UStruct*>(script_struct);

        auto* inner_property = array_property->GetInner();
        if (!inner_property || !is_likely_valid_object_ptr(inner_property)) {
            return false;
        }
        const auto element_size = static_cast<size_t>(inner_property->GetElementSize());
        if (element_size == 0) {
            return false;
        }

        auto* script_array = reinterpret_cast<RC::Unreal::FScriptArray*>(value_ptr);
        if (!script_array || !is_likely_readable_region(script_array, sizeof(RC::Unreal::FScriptArray))) {
            return false;
        }
        auto* data_ptr = static_cast<uint8_t*>(script_array->GetData());
        const int32_t item_count = script_array->Num();
        if (item_count > 0 && !data_ptr) {
            return false;
        }
        for (int32_t index = 0; index < item_count; ++index) {
            auto* item_ptr = data_ptr + (static_cast<size_t>(index) * element_size);
            if (!item_ptr) {
                continue;
            }
            BridgeLinkedIdentity account{};
            read_string_property_named(struct_owner, item_ptr, "provider", account.provider);
            read_string_property_named(struct_owner, item_ptr, "socialid", account.provider_account_id);
            read_string_property_named(struct_owner, item_ptr, "nickname", account.username);
            read_string_property_named(struct_owner, item_ptr, "fullname", account.display_name);
            read_string_property_named(struct_owner, item_ptr, "picture", account.avatar_url);
            if (account.provider.empty() || account.provider_account_id.empty()) {
                continue;
            }
            if (account.display_name.empty()) {
                account.display_name = account.username;
            }
            out_accounts.emplace_back(std::move(account));
        }
        return !out_accounts.empty();
    }

    bool read_social_friends_from_struct(
        RC::Unreal::UStruct* owner,
        void* container,
        std::vector<BridgeSocialFriendProfile>& out_friends
    ) {
        if (!owner || !container) {
            return false;
        }
        for (RC::Unreal::FProperty* property : enumerate_properties_in_chain(owner)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (normalize_ascii(property->GetName()) != "data") {
                continue;
            }
            auto* array_property = RC::Unreal::CastField<RC::Unreal::FArrayProperty>(property);
            if (!array_property || !is_likely_valid_object_ptr(array_property)) {
                continue;
            }
            void* value_ptr = safe_property_value_ptr(property, container);
            if (!value_ptr) {
                continue;
            }
            auto* inner_struct = RC::Unreal::CastField<RC::Unreal::FStructProperty>(array_property->GetInner());
            if (!inner_struct || !is_likely_valid_object_ptr(inner_struct)) {
                continue;
            }
            auto* script_struct = RC::Unreal::ToRawPtr(inner_struct->GetStruct());
            if (!script_struct || !is_likely_valid_object_ptr(script_struct)) {
                continue;
            }
            auto* struct_owner = reinterpret_cast<RC::Unreal::UStruct*>(script_struct);
            auto* inner_property = array_property->GetInner();
            if (!inner_property || !is_likely_valid_object_ptr(inner_property)) {
                continue;
            }
            const auto element_size = static_cast<size_t>(inner_property->GetElementSize());
            if (element_size == 0) {
                continue;
            }
            auto* script_array = reinterpret_cast<RC::Unreal::FScriptArray*>(value_ptr);
            if (!script_array || !is_likely_readable_region(script_array, sizeof(RC::Unreal::FScriptArray))) {
                continue;
            }
            auto* data_ptr = static_cast<uint8_t*>(script_array->GetData());
            const int32_t item_count = script_array->Num();
            if (item_count > 0 && !data_ptr) {
                continue;
            }
            for (int32_t index = 0; index < item_count; ++index) {
                auto* item_ptr = data_ptr + (static_cast<size_t>(index) * element_size);
                if (!item_ptr) {
                    continue;
                }
                BridgeSocialFriendProfile friend_profile{};
                read_string_property_named(struct_owner, item_ptr, "platform", friend_profile.platform);
                read_string_property_named(struct_owner, item_ptr, "name", friend_profile.display_name);
                read_string_property_named(struct_owner, item_ptr, "avatar", friend_profile.avatar_url);
                read_string_property_named(struct_owner, item_ptr, "userid", friend_profile.steam_id);
                read_string_property_named(struct_owner, item_ptr, "xluid", friend_profile.kovaaks_user_id);
                read_string_property_named(struct_owner, item_ptr, "tag", friend_profile.username);
                if (friend_profile.username.empty()) {
                    friend_profile.username = friend_profile.steam_id;
                }
                if (friend_profile.display_name.empty()) {
                    friend_profile.display_name = friend_profile.username;
                }
                if (friend_profile.platform.empty() || friend_profile.display_name.empty()) {
                    continue;
                }
                if (normalize_ascii(string_type_from_utf8(friend_profile.platform.c_str())) != "steam") {
                    continue;
                }
                out_friends.emplace_back(std::move(friend_profile));
            }
            break;
        }
        return !out_friends.empty();
    }

    bool read_xsolla_login_data_user(
        RC::Unreal::UObject* subsystem,
        BridgeCurrentUserProfile& out_user,
        uint64_t now
    ) {
        if (!subsystem || !is_likely_valid_object_ptr(subsystem)) {
            return false;
        }
        if (!xsolla_get_login_data_fn_ || !is_likely_valid_object_ptr(xsolla_get_login_data_fn_)) {
            xsolla_get_login_data_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr,
                nullptr,
                STR("/Script/XsollaLogin.XsollaLoginSubsystem:GetLoginData")
            );
        }
        if (!xsolla_get_login_data_fn_ || !is_likely_valid_object_ptr(xsolla_get_login_data_fn_)) {
            log_user_management(now, "GetLoginData function not found");
            return false;
        }

        const bool ok = visit_return_property(
            subsystem,
            xsolla_get_login_data_fn_,
            [&](RC::Unreal::FProperty* return_property, void* value_ptr) {
                auto* struct_property = RC::Unreal::CastField<RC::Unreal::FStructProperty>(return_property);
                if (!struct_property || !is_likely_valid_object_ptr(struct_property)) {
                    return false;
                }
                auto* script_struct = RC::Unreal::ToRawPtr(struct_property->GetStruct());
                if (!script_struct || !is_likely_valid_object_ptr(script_struct)) {
                    return false;
                }
                auto* struct_owner = reinterpret_cast<RC::Unreal::UStruct*>(script_struct);
                std::string username{};
                if (!read_string_property_named(struct_owner, value_ptr, "username", username)) {
                    return false;
                }
                if (out_user.username.empty()) {
                    out_user.username = username;
                }
                if (out_user.display_name.empty()) {
                    out_user.display_name = username;
                }
                return !username.empty();
            }
        );
        if (ok) {
            log_user_management(now, "resolved current user via GetLoginData fallback");
        }
        return ok;
    }

    bool read_xsolla_login_settings_platform_account_id(
        BridgeCurrentUserProfile& out_user,
        uint64_t now
    ) {
        if (!xsolla_get_login_settings_fn_ || !is_likely_valid_object_ptr(xsolla_get_login_settings_fn_)) {
            xsolla_get_login_settings_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr,
                nullptr,
                STR("/Script/XsollaLogin.XsollaLoginLibrary:GetLoginSettings")
            );
        }
        if (!xsolla_get_login_settings_fn_ || !is_likely_valid_object_ptr(xsolla_get_login_settings_fn_)) {
            log_user_management(now, "GetLoginSettings function not found");
            return false;
        }

        bool found = false;
        (void)visit_return_property(
            nullptr,
            xsolla_get_login_settings_fn_,
            [&](RC::Unreal::FProperty*, void* value_ptr) {
                if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(void*))) {
                    return false;
                }
                auto* settings = *reinterpret_cast<RC::Unreal::UObject**>(value_ptr);
                if (!settings || !is_likely_valid_object_ptr(settings)) {
                    return false;
                }
                auto* owner = reinterpret_cast<RC::Unreal::UStruct*>(settings->GetClass());
                if (!owner || !is_likely_valid_object_ptr(owner)) {
                    return false;
                }
                std::string platform_account_id{};
                if (!read_string_property_named(
                        owner,
                        settings,
                        "platformaccountid",
                        platform_account_id
                    )) {
                    return false;
                }
                if (out_user.steam_id.empty()) {
                    out_user.steam_id = platform_account_id;
                }
                found = !platform_account_id.empty();
                return found;
            }
        );
        if (found) {
            log_user_management(now, "resolved steam platform account id from login settings");
        }
        return found;
    }

    RC::Unreal::UObject* resolve_xsolla_login_subsystem(uint64_t now) {
        if (xsolla_login_subsystem_ && is_likely_valid_object_ptr(xsolla_login_subsystem_)) {
            return xsolla_login_subsystem_;
        }

        auto* meta = resolve_meta_game_instance(now);
        xsolla_login_subsystem_class_ = resolve_class_cached(
            xsolla_login_subsystem_class_,
            {
                STR("/Script/XsollaLogin.XsollaLoginSubsystem"),
                STR("/Script/XsollaLogin.UXsollaLoginSubsystem"),
                STR("/Script/XsollaLogin.Default__XsollaLoginSubsystem")
            }
        );
        if (!xsolla_login_subsystem_class_ || !is_likely_valid_object_ptr(xsolla_login_subsystem_class_)) {
            log_user_management(now, "failed to resolve XsollaLoginSubsystem class");
            return nullptr;
        }

        if (meta && is_likely_valid_object_ptr(meta)) {
            if (auto* subsystem = resolve_game_instance_subsystem_via_blueprint(
                    now,
                    meta,
                    xsolla_login_subsystem_class_
                )) {
                xsolla_login_subsystem_ = subsystem;
                log_user_management(now, "resolved XsollaLoginSubsystem via SubsystemBlueprintLibrary");
                return xsolla_login_subsystem_;
            }
        }

        std::vector<RC::Unreal::UObject*> found{};
        collect_objects_by_class(xsolla_login_subsystem_class_, found);
        for (auto* obj : found) {
            if (!obj || !is_likely_valid_object_ptr(obj)) {
                continue;
            }
            const auto full_name = obj->GetFullName();
            if (is_rejected_runtime_object_name(full_name)) {
                continue;
            }
            if (meta && is_likely_valid_object_ptr(meta)
                && full_name.find(object_path_from_full_name(meta->GetFullName())) != RC::StringType::npos) {
                xsolla_login_subsystem_ = obj;
                return xsolla_login_subsystem_;
            }
            if (!xsolla_login_subsystem_) {
                xsolla_login_subsystem_ = obj;
            }
        }
        if (!xsolla_login_subsystem_) {
            log_user_management(now, "XsollaLoginSubsystem instance not found");
        }
        return xsolla_login_subsystem_;
    }

    bool read_xsolla_current_user(BridgeCurrentUserProfile& out_user, uint64_t now) {
        out_user = {};
        auto* subsystem = resolve_xsolla_login_subsystem(now);
        if (!subsystem || !is_likely_valid_object_ptr(subsystem)) {
            return false;
        }

        if (!xsolla_get_user_details_fn_ || !is_likely_valid_object_ptr(xsolla_get_user_details_fn_)) {
            xsolla_get_user_details_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr,
                nullptr,
                STR("/Script/XsollaLogin.XsollaLoginSubsystem:GetUserDetails")
            );
        }
        if (!xsolla_get_user_details_fn_ || !is_likely_valid_object_ptr(xsolla_get_user_details_fn_)) {
            log_user_management(now, "GetUserDetails function not found");
            return false;
        }
        if (!xsolla_get_linked_social_networks_fn_ || !is_likely_valid_object_ptr(xsolla_get_linked_social_networks_fn_)) {
            xsolla_get_linked_social_networks_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr,
                nullptr,
                STR("/Script/XsollaLogin.XsollaLoginSubsystem:GetLinkedSocialNetworks")
            );
        }

        const bool got_user_details = visit_return_property(
            subsystem,
            xsolla_get_user_details_fn_,
            [&](RC::Unreal::FProperty* return_property, void* value_ptr) {
                auto* struct_property = RC::Unreal::CastField<RC::Unreal::FStructProperty>(return_property);
                if (!struct_property || !is_likely_valid_object_ptr(struct_property)) {
                    return false;
                }
                auto* script_struct = RC::Unreal::ToRawPtr(struct_property->GetStruct());
                if (!script_struct || !is_likely_valid_object_ptr(script_struct)) {
                    return false;
                }
                auto* struct_owner = reinterpret_cast<RC::Unreal::UStruct*>(script_struct);
                read_string_property_named(struct_owner, value_ptr, "id", out_user.kovaaks_user_id);
                read_string_property_named(struct_owner, value_ptr, "external_id", out_user.external_id);
                read_string_property_named(struct_owner, value_ptr, "nickname", out_user.username);
                read_string_property_named(struct_owner, value_ptr, "name", out_user.display_name);
                read_string_property_named(struct_owner, value_ptr, "picture", out_user.avatar_url);
                if (out_user.username.empty()) {
                    read_string_property_named(struct_owner, value_ptr, "tag", out_user.username);
                }
                if (out_user.display_name.empty()) {
                    out_user.display_name = out_user.username;
                }
                if (out_user.username.empty()) {
                    out_user.username = out_user.display_name;
                }
                return !out_user.kovaaks_user_id.empty() || !out_user.username.empty();
            }
        );
        bool got_user = got_user_details;
        if (!got_user) {
            got_user = read_xsolla_login_data_user(subsystem, out_user, now);
        }
        if (!got_user) {
            log_user_management(now, "GetUserDetails/GetLoginData returned no readable identity");
            return false;
        }

        (void)visit_return_property(
            subsystem,
            xsolla_get_linked_social_networks_fn_,
            [&](RC::Unreal::FProperty* return_property, void* value_ptr) {
                out_user.linked_accounts.clear();
                return read_string_array_struct_field(
                    return_property,
                    value_ptr,
                    "provider",
                    out_user.linked_accounts
                );
            }
        );

        for (const auto& account : out_user.linked_accounts) {
            const auto provider = normalize_ascii(string_type_from_utf8(account.provider.c_str()));
            if (provider == "steam") {
                out_user.steam_id = account.provider_account_id;
                out_user.steam_name = !account.display_name.empty()
                    ? account.display_name
                    : account.username;
                if (out_user.username.empty()) {
                    out_user.username = account.username;
                }
                if (out_user.display_name.empty()) {
                    out_user.display_name = out_user.steam_name;
                }
                if (out_user.avatar_url.empty()) {
                    out_user.avatar_url = account.avatar_url;
                }
                break;
            }
        }

        if (out_user.steam_id.empty()) {
            (void)read_xsolla_login_settings_platform_account_id(out_user, now);
        }

        if (out_user.display_name.empty()) {
            out_user.display_name = out_user.username;
        }
        return !out_user.username.empty() || !out_user.steam_id.empty() || !out_user.kovaaks_user_id.empty();
    }

    bool read_xsolla_social_friends(
        std::vector<BridgeSocialFriendProfile>& out_friends,
        uint64_t now
    ) {
        out_friends.clear();
        auto* subsystem = resolve_xsolla_login_subsystem(now);
        if (!subsystem || !is_likely_valid_object_ptr(subsystem)) {
            return false;
        }

        if (!xsolla_get_social_friends_fn_ || !is_likely_valid_object_ptr(xsolla_get_social_friends_fn_)) {
            xsolla_get_social_friends_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr,
                nullptr,
                STR("/Script/XsollaLogin.XsollaLoginSubsystem:GetSocialFriends")
            );
        }
        if (!xsolla_get_social_friends_fn_ || !is_likely_valid_object_ptr(xsolla_get_social_friends_fn_)) {
            log_user_management(now, "GetSocialFriends function not found");
            return false;
        }

        const bool ok = visit_return_property(
            subsystem,
            xsolla_get_social_friends_fn_,
            [&](RC::Unreal::FProperty* return_property, void* value_ptr) {
                auto* struct_property = RC::Unreal::CastField<RC::Unreal::FStructProperty>(return_property);
                if (!struct_property || !is_likely_valid_object_ptr(struct_property)) {
                    return false;
                }
                auto* script_struct = RC::Unreal::ToRawPtr(struct_property->GetStruct());
                if (!script_struct || !is_likely_valid_object_ptr(script_struct)) {
                    return false;
                }
                auto* struct_owner = reinterpret_cast<RC::Unreal::UStruct*>(script_struct);
                return read_social_friends_from_struct(struct_owner, value_ptr, out_friends);
            }
        );
        if (!ok) {
            log_user_management(now, "GetSocialFriends returned no readable friends");
        }
        return ok;
    }

    std::string serialize_bridge_user_snapshot(const BridgeCurrentUserProfile& user) const {
        std::string json;
        json.reserve(512 + (user.linked_accounts.size() * 160));
        json += "{\"ev\":\"kovaaks_user_snapshot\",\"source\":\"xsolla_login\",\"username\":\"";
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
        const std::vector<BridgeSocialFriendProfile>& friends
    ) const {
        std::string json;
        json.reserve(256 + (friends.size() * 160));
        json += "{\"ev\":\"kovaaks_friends_snapshot\",\"source\":\"xsolla_login\",\"count\":";
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
        next_user_bridge_refresh_ms_ = now + (force ? 1000 : 5000);
        log_user_management(now, force ? "tick force=1" : "tick force=0");

        BridgeCurrentUserProfile user{};
        const bool have_user = read_xsolla_current_user(user, now);
        if (have_user) {
            const auto payload = serialize_bridge_user_snapshot(user);
            if (force || payload != last_emitted_user_snapshot_) {
                last_emitted_user_snapshot_ = payload;
                kovaaks::RustBridge::emit_json(payload.c_str());
            }
        }

        std::vector<BridgeSocialFriendProfile> friends{};
        const bool have_friends = read_xsolla_social_friends(friends, now);
        if (have_friends) {
            std::sort(
                friends.begin(),
                friends.end(),
                [](const BridgeSocialFriendProfile& lhs, const BridgeSocialFriendProfile& rhs) {
                    if (lhs.display_name == rhs.display_name) {
                        return lhs.steam_id < rhs.steam_id;
                    }
                    return lhs.display_name < rhs.display_name;
                }
            );
            const auto payload = serialize_bridge_friends_snapshot(friends);
            if (force || payload != last_emitted_friends_snapshot_) {
                last_emitted_friends_snapshot_ = payload;
                kovaaks::RustBridge::emit_json(payload.c_str());
            }
        }
        if (!have_user && !have_friends) {
            log_user_management(now, "tick produced no user or friends");
        }
    }
