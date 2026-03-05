#include <DynamicOutput/Output.hpp>
#include <Mod/CppUserModBase.hpp>
#include <Unreal/FText.hpp>
#include <Unreal/FProperty.hpp>
#include <Unreal/Property/FBoolProperty.hpp>
#include <Unreal/Property/FNumericProperty.hpp>
#include <Unreal/Property/FObjectProperty.hpp>
#include <Unreal/Property/FStrProperty.hpp>
#include <Unreal/Property/FTextProperty.hpp>
#include <Unreal/UClass.hpp>
#include <Unreal/UFunction.hpp>
#include <Unreal/UObject.hpp>
#include <Unreal/UObjectGlobals.hpp>

#include <array>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <initializer_list>
#include <limits>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#ifdef TEXT
#undef TEXT
#endif
#include <windows.h>

#include "rust_bridge.hpp"

namespace {

bool is_likely_readable_region(const void* ptr, size_t bytes) {
    if (!ptr || bytes == 0) {
        return false;
    }
    MEMORY_BASIC_INFORMATION mbi{};
    const auto q = VirtualQuery(ptr, &mbi, sizeof(mbi));
    if (q == 0 || mbi.State != MEM_COMMIT) {
        return false;
    }
    if (mbi.Protect & (PAGE_GUARD | PAGE_NOACCESS)) {
        return false;
    }
    const DWORD p = mbi.Protect & 0xFF;
    const bool readable =
        p == PAGE_READONLY ||
        p == PAGE_READWRITE ||
        p == PAGE_WRITECOPY ||
        p == PAGE_EXECUTE_READ ||
        p == PAGE_EXECUTE_READWRITE ||
        p == PAGE_EXECUTE_WRITECOPY;
    if (!readable) {
        return false;
    }
    const auto start = reinterpret_cast<uintptr_t>(ptr);
    const auto end = start + bytes;
    const auto region_start = reinterpret_cast<uintptr_t>(mbi.BaseAddress);
    const auto region_end = region_start + mbi.RegionSize;
    return start >= region_start && end <= region_end;
}

bool is_likely_valid_object_ptr(const void* ptr) {
    if (!is_likely_readable_region(ptr, sizeof(void*))) {
        return false;
    }
    const auto vtable = *reinterpret_cast<const uintptr_t*>(ptr);
    if (vtable < 0x10000ull) {
        return false;
    }
    return is_likely_readable_region(reinterpret_cast<const void*>(vtable), sizeof(void*));
}

std::wstring game_bin_dir() {
    wchar_t buffer[MAX_PATH] = {};
    if (!GetModuleFileNameW(nullptr, buffer, MAX_PATH)) {
        return L".\\";
    }
    std::wstring path(buffer);
    const auto pos = path.find_last_of(L"\\/");
    if (pos == std::wstring::npos) {
        return L".\\";
    }
    return path.substr(0, pos + 1);
}

bool env_flag_enabled(const char* name) {
    char value[16] = {};
    const auto len = GetEnvironmentVariableA(name, value, static_cast<DWORD>(sizeof(value)));
    if (len == 0 || len >= sizeof(value)) {
        return false;
    }
    return value[0] == '1' || value[0] == 'y' || value[0] == 'Y' || value[0] == 't' || value[0] == 'T';
}

std::string utf8_from_wide(const std::wstring& input) {
    if (input.empty()) {
        return {};
    }
    const int required = WideCharToMultiByte(
        CP_UTF8,
        0,
        input.c_str(),
        static_cast<int>(input.size()),
        nullptr,
        0,
        nullptr,
        nullptr
    );
    if (required <= 0) {
        return {};
    }

    std::string output(static_cast<size_t>(required), '\0');
    const int written = WideCharToMultiByte(
        CP_UTF8,
        0,
        input.c_str(),
        static_cast<int>(input.size()),
        output.data(),
        required,
        nullptr,
        nullptr
    );
    if (written <= 0) {
        return {};
    }
    return output;
}

RC::StringType string_type_from_utf8(const char* input) {
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

void runtime_log_line(const char* line) {
    RC::Output::send<RC::LogLevel::Warning>(
        STR("[kmod-prod] {}\n"),
        string_type_from_utf8(line)
    );
}

void events_log_line(const char* line) {
    RC::Output::send<RC::LogLevel::Warning>(
        STR("[kmod-prod-ev] {}\n"),
        string_type_from_utf8(line)
    );
}

void* safe_property_value_ptr(RC::Unreal::FProperty* property, void* container, int32_t array_index = 0) {
    if (!property || !container || !is_likely_valid_object_ptr(property)) {
        return nullptr;
    }
    const int32_t array_dim = property->GetArrayDim();
    if (array_index < 0 || (array_dim > 0 && array_index >= array_dim)) {
        return nullptr;
    }
    const int32_t offset = property->GetOffset_Internal();
    const int32_t element_size = property->GetElementSize();
    if (offset < 0 || element_size <= 0 || element_size > 0x100000) {
        return nullptr;
    }
    auto* value_ptr = reinterpret_cast<uint8_t*>(container)
        + static_cast<size_t>(offset)
        + static_cast<size_t>(element_size) * static_cast<size_t>(array_index);
    if (!is_likely_readable_region(value_ptr, static_cast<size_t>(element_size))) {
        return nullptr;
    }
    return value_ptr;
}

RC::StringType object_path_from_full_name(const RC::StringType& full_name) {
    const auto split = full_name.find(STR(" "));
    if (split == RC::StringType::npos) {
        return full_name;
    }
    if (split + 1 >= full_name.size()) {
        return RC::StringType{};
    }
    return full_name.substr(split + 1);
}

std::string normalize_ascii(const RC::StringType& input) {
    std::string out;
    out.reserve(input.size());
    for (auto c : input) {
        const auto ch = static_cast<unsigned int>(c);
        if (ch > 0x7F) {
            continue;
        }
        out.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
    }
    return out;
}

bool try_parse_int_text(const RC::StringType& text, int32_t& out_value) {
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

bool try_parse_float_text(const RC::StringType& text, float& out_value) {
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

bool try_parse_time_to_seconds(const RC::StringType& text, float& out_seconds) {
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

std::string trim_ascii_token(const RC::StringType& input) {
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

bool looks_like_real_scenario_name(const std::string& value) {
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

std::string escape_json_ascii(std::string_view value) {
    std::string out;
    out.reserve(value.size() + 8);
    for (char ch : value) {
        switch (ch) {
            case '\\': out += "\\\\"; break;
            case '"': out += "\\\""; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(ch) < 0x20) {
                    continue;
                }
                out.push_back(ch);
                break;
        }
    }
    return out;
}

const char* classify_session_ui_field(const RC::StringType& ctx_name) {
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
    if (n.find("sessiontime") != std::string::npos || n.find("gametime") != std::string::npos) return "session_time";
    if (n.find("spm") != std::string::npos || n.find("scoreperminute") != std::string::npos) return "session_spm";
    if (n.find("averagettk") != std::string::npos || n.find("ttk") != std::string::npos) return "session_avg_ttk";
    return nullptr;
}

void append_unique_objects(std::vector<RC::Unreal::UObject*>& dst, const std::vector<RC::Unreal::UObject*>& src) {
    std::unordered_set<RC::Unreal::UObject*> seen{};
    seen.reserve(dst.size() + src.size());
    for (auto* obj : dst) {
        if (obj) {
            seen.insert(obj);
        }
    }
    for (auto* obj : src) {
        if (!obj) {
            continue;
        }
        if (seen.insert(obj).second) {
            dst.push_back(obj);
        }
    }
}

bool is_rejected_runtime_object_name(const RC::StringType& full_name) {
    if (full_name.empty()) {
        return true;
    }
    if (full_name.find(STR("None.None:None.None")) != RC::StringType::npos) {
        return true;
    }
    if (full_name.find(STR("Default__")) != RC::StringType::npos) {
        return true;
    }
    if (full_name.find(STR("/Script/")) != RC::StringType::npos) {
        return true;
    }
    return false;
}

bool is_rejected_runtime_function_name(const RC::StringType& full_name) {
    if (full_name.empty()) {
        return true;
    }
    if (full_name.find(STR("Function None.")) != RC::StringType::npos) {
        return true;
    }
    if (full_name.find(STR("None.None:None.None")) != RC::StringType::npos) {
        return true;
    }
    return false;
}

void collect_objects_by_class(RC::Unreal::UClass* target_class, std::vector<RC::Unreal::UObject*>& out) {
    if (!target_class || !is_likely_valid_object_ptr(target_class)) {
        return;
    }
    const auto class_name = target_class->GetName();
    if (class_name.empty()) {
        return;
    }
    RC::Unreal::UObjectGlobals::FindAllOf(class_name, out);
}

} // namespace

class KovaaksBridgeModProduction final : public RC::CppUserModBase {
public:
    KovaaksBridgeModProduction(const KovaaksBridgeModProduction&) = delete;
    KovaaksBridgeModProduction& operator=(const KovaaksBridgeModProduction&) = delete;

    KovaaksBridgeModProduction() {
        ModName = STR("KovaaksBridgeMod");
        ModVersion = STR("0.1.0");
        ModDescription = STR("Stripped production direct-pull bridge.");
        ModAuthors = STR("veryCrunchy");

        verbose_logs_ = false;

        if (kovaaks::RustBridge::startup()) {
            rust_ready_ = true;
            kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_mod_loaded\"}");
            kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_mode\",\"mode\":\"production_stripped\"}");
            kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_prod_diag\",\"enabled\":0}");
            RC::Output::send<RC::LogLevel::Warning>(STR("[KovaaksBridgeMod] Rust bridge loaded (production stripped).\n"));
        } else {
            RC::Output::send<RC::LogLevel::Error>(
                STR("[KovaaksBridgeMod] Failed to load Rust bridge DLL. path={} win32_error={}\n"),
                RC::StringType(kovaaks::RustBridge::last_dll_path()),
                kovaaks::RustBridge::last_win32_error()
            );
        }
    }

    ~KovaaksBridgeModProduction() override {
        updates_disabled_ = true;
        if (text_set_hook_registered_ && text_set_fn_ && is_likely_valid_object_ptr(text_set_fn_)) {
            text_set_fn_->UnregisterHook(text_set_hook_id_);
            text_set_hook_registered_ = false;
            text_set_hook_id_ = 0;
        }
        const bool had_rust = rust_ready_;
        rust_ready_ = false;
        if (had_rust) {
            kovaaks::RustBridge::shutdown();
        }
    }

    auto on_unreal_init() -> void override {
#if defined(_MSC_VER)
        __try {
#endif
            resolve_targets(true);
            register_text_set_hook();
            if (verbose_logs_) {
                RC::Output::send<RC::LogLevel::Warning>(STR("[kmod-prod] on_unreal_init complete\n"));
            }
#if defined(_MSC_VER)
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            handle_runtime_fault("on_unreal_init");
            RC::Output::send<RC::LogLevel::Error>(
                STR("[kmod-prod] on_unreal_init crashed; runtime fault trapped\n")
            );
        }
#endif
    }

    auto on_ui_init() -> void override {}

    auto on_cpp_mods_loaded() -> void {
    }

    auto on_lua_start(
        RC::StringViewType,
        RC::LuaMadeSimple::Lua&,
        RC::LuaMadeSimple::Lua&,
        RC::LuaMadeSimple::Lua&,
        RC::LuaMadeSimple::Lua*
    ) -> void {
    }

    auto on_lua_start(
        RC::LuaMadeSimple::Lua&,
        RC::LuaMadeSimple::Lua&,
        RC::LuaMadeSimple::Lua&,
        RC::LuaMadeSimple::Lua*
    ) -> void {
    }

    auto on_lua_stop(
        RC::StringViewType,
        RC::LuaMadeSimple::Lua&,
        RC::LuaMadeSimple::Lua&,
        RC::LuaMadeSimple::Lua&,
        RC::LuaMadeSimple::Lua*
    ) -> void {
    }

    auto on_lua_stop(
        RC::LuaMadeSimple::Lua&,
        RC::LuaMadeSimple::Lua&,
        RC::LuaMadeSimple::Lua&,
        RC::LuaMadeSimple::Lua*
    ) -> void {
    }

    auto on_update() -> void override {
        if (!rust_ready_ || updates_disabled_) {
            return;
        }
#if defined(_MSC_VER)
        __try {
            on_update_impl();
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            handle_runtime_fault("on_update");
        }
#else
        on_update_impl();
#endif
    }

private:
    static auto enumerate_properties(RC::Unreal::UStruct* owner) -> std::vector<RC::Unreal::FProperty*> {
        std::vector<RC::Unreal::FProperty*> out{};
        if (!owner || !is_likely_valid_object_ptr(owner)) {
            return out;
        }
        std::unordered_set<RC::Unreal::FProperty*> seen{};
        auto* property = owner->GetPropertyLink();
        while (property && is_likely_valid_object_ptr(property)) {
            if (!seen.insert(property).second) {
                break;
            }
            out.emplace_back(property);
            auto* next = property->GetPropertyLinkNext();
            if (next == property) {
                break;
            }
            property = next;
        }
        return out;
    }

    static auto enumerate_properties_in_chain(RC::Unreal::UStruct* owner) -> std::vector<RC::Unreal::FProperty*> {
        std::vector<RC::Unreal::FProperty*> out{};
        if (!owner || !is_likely_valid_object_ptr(owner)) {
            return out;
        }
        std::unordered_set<RC::Unreal::UStruct*> seen_structs{};
        std::unordered_set<RC::Unreal::FProperty*> seen_properties{};
        for (auto* current = owner; current && is_likely_valid_object_ptr(current); current = current->GetSuperStruct()) {
            if (!seen_structs.insert(current).second) {
                break;
            }
            for (auto* property : enumerate_properties(current)) {
                if (!property || !is_likely_valid_object_ptr(property)) {
                    continue;
                }
                if (seen_properties.insert(property).second) {
                    out.emplace_back(property);
                }
            }
        }
        return out;
    }

    template <typename TFlags>
    static auto property_has_any_flags(
        const RC::Unreal::FProperty* property,
        TFlags flags
    ) -> bool {
        if (!property || !is_likely_valid_object_ptr(property)) {
            return false;
        }
        const auto current = static_cast<uint64_t>(property->GetPropertyFlags());
        const auto wanted = static_cast<uint64_t>(flags);
        return (current & wanted) != 0;
    }

    static auto is_runtime_object_usable(RC::Unreal::UObject* obj) -> bool {
        if (!obj || !is_likely_valid_object_ptr(obj)) {
            return false;
        }
        return !is_rejected_runtime_object_name(obj->GetFullName());
    }

    static auto is_runtime_function_usable(RC::Unreal::UFunction* fn) -> bool {
        if (!fn || !is_likely_valid_object_ptr(fn)) {
            return false;
        }
        return !is_rejected_runtime_function_name(fn->GetFullName());
    }

    static auto ui_widget_probe_object_usable(RC::Unreal::UObject* obj) -> bool {
        if (!is_runtime_object_usable(obj)) {
            return false;
        }
        const auto full_name = obj->GetFullName();
        return full_name.find(STR("None.None:None.None")) == RC::StringType::npos;
    }

    static auto set_direct_fault_context(
        const char*,
        RC::Unreal::UObject*,
        RC::Unreal::UFunction*
    ) -> void {
    }

    static auto should_quarantine_invoke_fault(
        const char*,
        RC::Unreal::UFunction*
    ) -> bool {
        return false;
    }

    static auto quarantine_faulted_function(
        RC::Unreal::UFunction*,
        uint64_t
    ) -> uint32_t {
        return 0;
    }

    static auto is_function_quarantined(
        RC::Unreal::UFunction*,
        uint64_t
    ) -> bool {
        return false;
    }

    auto sync_in_game_overlay_pull_cache(
        int32_t current_is_in_challenge,
        int32_t current_is_in_scenario,
        int32_t current_is_in_scenario_editor,
        float current_queue_time_remaining,
        float current_score_total,
        int32_t current_kills_total,
        float current_score_per_minute,
        float current_seconds,
        float current_challenge_average_fps,
        int32_t current_challenge_tick_count,
        float current_time_remaining
    ) -> void {
        const auto sanitize_state = [](int32_t current, int32_t fallback) -> int32_t {
            if (current >= 0) {
                return current;
            }
            if (fallback != std::numeric_limits<int32_t>::min()) {
                return fallback;
            }
            return -1;
        };
        const auto sanitize_metric = [](float current, float fallback) -> float {
            if (std::isfinite(current) && current >= 0.0f) {
                return current;
            }
            if (std::isfinite(fallback) && fallback >= 0.0f) {
                return fallback;
            }
            return -1.0f;
        };

        s_last_pull_is_in_challenge = sanitize_state(current_is_in_challenge, last_is_in_challenge_);
        s_last_pull_is_in_scenario = sanitize_state(current_is_in_scenario, last_is_in_scenario_);
        s_last_pull_is_in_scenario_editor = sanitize_state(current_is_in_scenario_editor, last_is_in_scenario_editor_);
        s_last_pull_scenario_is_in_editor = s_last_pull_is_in_scenario_editor;
        s_last_pull_scenario_is_paused = -1;

        s_last_pull_queue_time_remaining = sanitize_metric(current_queue_time_remaining, last_queue_time_remaining_);
        s_last_pull_score = sanitize_metric(current_score_total, last_score_total_);
        s_last_pull_kills = sanitize_state(current_kills_total, last_kills_total_);
        s_last_pull_spm = sanitize_metric(current_score_per_minute, last_score_per_minute_);
        s_last_pull_challenge_seconds = sanitize_metric(current_seconds, last_challenge_seconds_total_);
        s_last_pull_challenge_average_fps = sanitize_metric(current_challenge_average_fps, last_challenge_average_fps_);
        s_last_pull_challenge_tick_count = sanitize_state(current_challenge_tick_count, last_challenge_tick_count_);
        s_last_pull_time_remaining = sanitize_metric(current_time_remaining, last_time_remaining_);
        s_last_run_scenario_name = last_scenario_name_;
    }

    #include "kmod/in_game_overlay.inl"

    struct EmitTagScope {
        KovaaksBridgeModProduction& self;
        const char* prev_method{nullptr};
        const char* prev_origin_flag{nullptr};

        EmitTagScope(KovaaksBridgeModProduction& owner, const char* method, const char* origin_flag)
            : self(owner) {
            prev_method = self.emit_method_;
            prev_origin_flag = self.emit_origin_flag_;
            self.emit_method_ = method ? method : "unknown";
            self.emit_origin_flag_ = origin_flag ? origin_flag : "unknown";
        }

        ~EmitTagScope() {
            self.emit_method_ = prev_method ? prev_method : "unknown";
            self.emit_origin_flag_ = prev_origin_flag ? prev_origin_flag : "unknown";
        }
    };

    auto on_update_impl() -> void {
        const uint64_t now = GetTickCount64();
        if (now < fault_backoff_until_ms_) {
            return;
        }
        if (now < next_poll_ms_) {
            return;
        }
        next_poll_ms_ = now + 33; // ~30Hz

        resolve_targets(false);
        auto* receiver = resolve_state_receiver_instance(now);
        int32_t iv = 0;
        float fv = 0.0f;
        int32_t current_kills_total = -1;
        int32_t current_shots_fired = -1;
        int32_t current_shots_hit = -1;
        int32_t current_is_in_challenge = -1;
        int32_t current_is_in_scenario = -1;
        int32_t current_is_in_scenario_editor = -1;
        int32_t current_is_currently_in_benchmark = -1;
        int32_t current_is_in_trainer = -1;
        float current_seconds = -1.0f;
        float current_score_total = -1.0f;
        float current_score_per_minute = -1.0f;
        float current_kills_per_second = -1.0f;
        float current_accuracy = -1.0f;
        float current_challenge_average_fps = -1.0f;
        float current_damage_done = -1.0f;
        float current_damage_possible = -1.0f;
        float current_damage_efficiency = -1.0f;
        float current_time_remaining = -1.0f;
        float current_queue_time_remaining = -1.0f;
        int32_t current_challenge_tick_count = -1;
        RC::Unreal::UObject* meta = nullptr;
        RC::Unreal::UObject* scenario_manager = nullptr;

        {
            EmitTagScope state_scope(*this, "state_get", "non_ui_probe");

        if (receiver) {
            if (try_read_int(receiver, {
                    targets_.get_kills_value_else,
                    targets_.get_kills_value_or,
                    targets_.receive_kills_value_else,
                    targets_.receive_kills_single,
                    targets_.receive_kills
                }, iv)) {
                current_kills_total = iv;
                emit_pull_i32("pull_kills_total", last_kills_total_, iv, last_nonzero_kills_total_ms_, now);
            }
            if (try_read_int(receiver, {
                    targets_.get_shots_fired_value_else,
                    targets_.get_shots_fired_value_or,
                    targets_.receive_shots_fired_value_else,
                    targets_.receive_shots_fired_single,
                    targets_.receive_shots_fired
                }, iv)) {
                current_shots_fired = iv;
                emit_pull_i32("pull_shots_fired_total", last_shots_fired_, iv, last_nonzero_shots_fired_ms_, now);
            }
            if (try_read_int(receiver, {
                    targets_.get_shots_hit_value_else,
                    targets_.get_shots_hit_value_or,
                    targets_.receive_shots_hit_value_else,
                    targets_.receive_shots_hit_single,
                    targets_.receive_shots_hit
                }, iv)) {
                current_shots_hit = iv;
                emit_pull_i32("pull_shots_hit_total", last_shots_hit_, iv, last_nonzero_shots_hit_ms_, now);
            }
            if (try_read_float(receiver, {
                    targets_.get_score_value_else,
                    targets_.get_score_value_or,
                    targets_.receive_score_value_else,
                    targets_.receive_score_single,
                    targets_.receive_score
                }, fv)) {
                current_score_total = fv;
                emit_pull_f32("pull_score_total", last_score_total_, fv, last_nonzero_score_total_ms_, now);
            }
            if (try_read_float(receiver, {
                    targets_.get_accuracy_value_else,
                    targets_.get_accuracy_value_or,
                    targets_.receive_accuracy_value_else,
                    targets_.receive_accuracy_single,
                    targets_.receive_accuracy
                }, fv)) {
                current_accuracy = fv;
                emit_pull_f32("pull_accuracy", last_accuracy_, fv, last_nonzero_accuracy_ms_, now);
            }
            if (try_read_float(receiver, {
                    targets_.get_score_per_minute_value_else,
                    targets_.get_score_per_minute_value_or,
                    targets_.receive_score_per_minute_value_else,
                    targets_.receive_score_per_minute
                }, fv)) {
                current_score_per_minute = fv;
                emit_pull_f32("pull_score_per_minute", last_score_per_minute_, fv, last_nonzero_spm_ms_, now);
            }
            if (try_read_float(receiver, {
                    targets_.get_challenge_average_fps_value_else,
                    targets_.get_challenge_average_fps_value_or,
                    targets_.receive_challenge_average_fps_value_else,
                    targets_.receive_challenge_average_fps_value_or,
                    targets_.receive_challenge_average_fps_single,
                    targets_.receive_challenge_average_fps
                }, fv)) {
                current_challenge_average_fps = fv;
                emit_pull_f32("pull_challenge_average_fps", last_challenge_average_fps_, fv, last_nonzero_challenge_average_fps_ms_, now);
            }
            if (try_read_int(receiver, {
                    targets_.get_challenge_tick_count_value_else,
                    targets_.get_challenge_tick_count_value_or,
                    targets_.receive_challenge_tick_count_value_else,
                    targets_.receive_challenge_tick_count_value_or,
                    targets_.receive_challenge_tick_count_single,
                    targets_.receive_challenge_tick_count
                }, iv)) {
                current_challenge_tick_count = iv;
                emit_pull_i32("pull_challenge_tick_count_total", last_challenge_tick_count_, iv, last_nonzero_challenge_tick_count_ms_, now);
            }
            if (try_read_float(receiver, {
                    targets_.get_damage_done_value_else,
                    targets_.get_damage_done_value_or,
                    targets_.receive_damage_done_value_else,
                    targets_.receive_damage_done
                }, fv)) {
                current_damage_done = fv;
                emit_pull_f32("pull_damage_done", last_damage_done_, fv, last_nonzero_damage_done_ms_, now);
            }
            if (try_read_float(receiver, {
                    targets_.get_damage_possible_value_else,
                    targets_.get_damage_possible_value_or,
                    targets_.receive_damage_possible_value_else,
                    targets_.receive_damage_possible
                }, fv)) {
                current_damage_possible = fv;
                emit_pull_f32("pull_damage_possible", last_damage_possible_, fv, last_nonzero_damage_possible_ms_, now);
            }
            if (try_read_float(receiver, {
                    targets_.get_kills_per_second_value_else,
                    targets_.get_kills_per_second_value_or,
                    targets_.receive_kills_per_second_value_else,
                    targets_.receive_kills_per_second
                }, fv)) {
                current_kills_per_second = fv;
                emit_pull_f32("pull_kills_per_second", last_kills_per_second_, fv, last_nonzero_kills_per_second_ms_, now);
            }
            if (try_read_float(receiver, {
                    targets_.get_damage_efficiency_value_else,
                    targets_.get_damage_efficiency_value_or,
                    targets_.receive_damage_efficiency_value_else,
                    targets_.receive_damage_efficiency
                }, fv)) {
                current_damage_efficiency = fv;
                emit_pull_f32("pull_damage_efficiency", last_damage_efficiency_, fv, last_nonzero_damage_efficiency_ms_, now);
            }
            if (try_read_float(receiver, {
                    targets_.get_seconds_value_else,
                    targets_.get_seconds_value_or,
                    targets_.receive_seconds
                }, fv)) {
                current_seconds = fv;
                emit_pull_f32("pull_seconds_total", last_seconds_, fv, last_nonzero_seconds_ms_, now);
                emit_pull_f32("pull_challenge_seconds_total", last_challenge_seconds_total_, fv, last_nonzero_challenge_seconds_ms_, now);
            }
        }

        auto pull_bool_state = [&](RC::Unreal::UObject* source,
                                   const char* ev,
                                   int32_t& current_value,
                                   int32_t& last_value,
                                   std::initializer_list<RC::Unreal::UFunction*> fns) {
            bool bool_value = false;
            if (!source || !try_read_bool(source, fns, bool_value)) {
                return;
            }
            current_value = bool_value ? 1 : 0;
            emit_state_i32(ev, last_value, current_value);
        };

        meta = resolve_meta_game_instance(now);
        pull_bool_state(
            meta,
            "pull_is_in_trainer",
            current_is_in_trainer,
            last_is_in_trainer_,
            {targets_.meta_get_in_trainer}
        );

        scenario_manager = resolve_scenario_manager_instance(now);
        if (scenario_manager) {
            pull_bool_state(
                scenario_manager,
                "pull_is_in_challenge",
                current_is_in_challenge,
                last_is_in_challenge_,
                {targets_.scenario_is_in_challenge}
            );
            pull_bool_state(
                scenario_manager,
                "pull_is_in_scenario",
                current_is_in_scenario,
                last_is_in_scenario_,
                {targets_.scenario_is_in_scenario}
            );
            pull_bool_state(
                scenario_manager,
                "pull_is_in_scenario_editor",
                current_is_in_scenario_editor,
                last_is_in_scenario_editor_,
                {targets_.scenario_is_in_scenario_editor}
            );
            pull_bool_state(
                scenario_manager,
                "pull_is_currently_in_benchmark",
                current_is_currently_in_benchmark,
                last_is_currently_in_benchmark_,
                {targets_.scenario_is_currently_in_benchmark}
            );
            if (try_read_float(scenario_manager, {targets_.scenario_get_challenge_time_remaining}, fv)) {
                current_time_remaining = fv;
                emit_pull_f32("pull_time_remaining", last_time_remaining_, fv, last_nonzero_time_remaining_ms_, now);
            }
            if (try_read_float(scenario_manager, {targets_.scenario_get_challenge_queue_time_remaining}, fv)) {
                current_queue_time_remaining = fv;
                emit_pull_f32("pull_queue_time_remaining", last_queue_time_remaining_, fv, last_nonzero_queue_time_remaining_ms_, now);
            }
        }
        }

        {
        EmitTagScope ui_scope(*this, "ui_poll", "ui_counter_fallback");
        UiSnapshot ui{};
        if (copy_live_ui_snapshot(ui)) {
            if (!ui.scenario_name.empty() && ui.scenario_name != last_scenario_name_) {
                last_scenario_name_ = ui.scenario_name;
                const auto escaped = escape_json_ascii(ui.scenario_name);
                std::array<char, 512> json{};
                std::snprintf(
                    json.data(),
                    json.size(),
                    "{\"ev\":\"ui_scenario_name\",\"field\":\"%s\",\"source\":\"ui_text\"}",
                    escaped.c_str()
                );
                kovaaks::RustBridge::emit_json(json.data());
            }
            if (ui.kills >= 0 && (current_kills_total < 0 || ui.kills > current_kills_total)) {
                current_kills_total = ui.kills;
                emit_pull_i32("pull_kills_total", last_kills_total_, ui.kills, last_nonzero_kills_total_ms_, now);
            }
            if (ui.shots_fired >= 0 && (current_shots_fired < 0 || ui.shots_fired > current_shots_fired)) {
                current_shots_fired = ui.shots_fired;
                emit_pull_i32("pull_shots_fired_total", last_shots_fired_, ui.shots_fired, last_nonzero_shots_fired_ms_, now);
            }
            if (ui.shots_hit >= 0 && (current_shots_hit < 0 || ui.shots_hit > current_shots_hit)) {
                current_shots_hit = ui.shots_hit;
                emit_pull_i32("pull_shots_hit_total", last_shots_hit_, ui.shots_hit, last_nonzero_shots_hit_ms_, now);
            }
            if (std::isfinite(ui.seconds) && ui.seconds >= 0.0f
                && (current_seconds < 0.0f || current_seconds <= 0.0001f)) {
                current_seconds = ui.seconds;
                emit_pull_f32("pull_seconds_total", last_seconds_, ui.seconds, last_nonzero_seconds_ms_, now);
                emit_pull_f32("pull_challenge_seconds_total", last_challenge_seconds_total_, ui.seconds, last_nonzero_challenge_seconds_ms_, now);
            }
            if (std::isfinite(ui.score_per_minute) && ui.score_per_minute >= 0.0f
                && (current_score_per_minute < 0.0f || current_score_per_minute <= 0.0001f)) {
                current_score_per_minute = ui.score_per_minute;
                emit_pull_f32("pull_score_per_minute", last_score_per_minute_, ui.score_per_minute, last_nonzero_spm_ms_, now);
            }
            if (std::isfinite(ui.damage_done) && ui.damage_done >= 0.0f
                && (current_damage_done < 0.0f || current_damage_done <= 0.0001f)) {
                current_damage_done = ui.damage_done;
                emit_pull_f32("pull_damage_done", last_damage_done_, ui.damage_done, last_nonzero_damage_done_ms_, now);
            }
            if (std::isfinite(ui.damage_possible) && ui.damage_possible >= 0.0f
                && (current_damage_possible < 0.0f || current_damage_possible <= 0.0001f)) {
                current_damage_possible = ui.damage_possible;
                emit_pull_f32("pull_damage_possible", last_damage_possible_, ui.damage_possible, last_nonzero_damage_possible_ms_, now);
            }
            if (std::isfinite(ui.damage_efficiency) && ui.damage_efficiency >= 0.0f
                && (current_damage_efficiency < 0.0f || current_damage_efficiency <= 0.0001f)) {
                current_damage_efficiency = ui.damage_efficiency;
                emit_pull_f32("pull_damage_efficiency", last_damage_efficiency_, ui.damage_efficiency, last_nonzero_damage_efficiency_ms_, now);
            }
            if (std::isfinite(ui.kills_per_second) && ui.kills_per_second >= 0.0f
                && (current_kills_per_second < 0.0f || current_kills_per_second <= 0.0001f)) {
                current_kills_per_second = ui.kills_per_second;
                emit_pull_f32("pull_kills_per_second", last_kills_per_second_, ui.kills_per_second, last_nonzero_kills_per_second_ms_, now);
            } else if (std::isfinite(ui.avg_ttk) && ui.avg_ttk > 0.0001f && ui.avg_ttk < 120.0f
                && (current_kills_per_second < 0.0f || current_kills_per_second <= 0.0001f)) {
                const float kps_from_ttk = 1.0f / ui.avg_ttk;
                current_kills_per_second = kps_from_ttk;
                emit_pull_f32("pull_kills_per_second", last_kills_per_second_, kps_from_ttk, last_nonzero_kills_per_second_ms_, now);
            }
            if (std::isfinite(ui.score_total) && ui.score_total >= 0.0f
                && (current_score_total < 0.0f || current_score_total <= 0.0001f)) {
                current_score_total = ui.score_total;
                emit_pull_f32("pull_score_total", last_score_total_, ui.score_total, last_nonzero_score_total_ms_, now);
            }
        }
        }

        {
        EmitTagScope derived_scope(*this, "derived_spm_seconds", "non_ui_probe");
        if (current_accuracy < 0.0f && current_shots_fired > 0 && current_shots_hit >= 0) {
            current_accuracy = (static_cast<float>(current_shots_hit) * 100.0f)
                / static_cast<float>(current_shots_fired);
            emit_pull_f32("pull_accuracy", last_accuracy_, current_accuracy, last_nonzero_accuracy_ms_, now);
        }
        if ((current_score_total < 0.0f || current_score_total <= 0.0001f)
            && std::isfinite(current_score_per_minute) && current_score_per_minute > 0.0f
            && std::isfinite(current_seconds) && current_seconds > 0.0f) {
            const float derived_score_total = (current_score_per_minute * current_seconds) / 60.0f;
            current_score_total = derived_score_total;
            emit_pull_f32("pull_score_total_derived", last_score_total_, derived_score_total, last_nonzero_score_total_ms_, now);
        }
        }

        sync_in_game_overlay_pull_cache(
            current_is_in_challenge,
            current_is_in_scenario,
            current_is_in_scenario_editor,
            current_queue_time_remaining,
            current_score_total,
            current_kills_total,
            current_score_per_minute,
            current_seconds,
            current_challenge_average_fps,
            current_challenge_tick_count,
            current_time_remaining
        );
        in_game_overlay_tick(now);

        update_lifecycle_events(
            now,
            current_is_in_challenge,
            current_is_in_scenario,
            current_shots_fired,
            current_shots_hit,
            current_seconds,
            current_score_per_minute,
            current_damage_done,
            current_damage_possible,
            current_time_remaining,
            current_queue_time_remaining
        );

        const bool has_state_signal =
            current_is_in_challenge >= 0
            || current_is_in_scenario >= 0
            || current_is_in_scenario_editor >= 0
            || current_is_currently_in_benchmark >= 0
            || current_is_in_trainer >= 0;
        const bool has_nonzero_signal =
            (current_is_in_challenge > 0)
            || (current_kills_total > 0)
            || (current_shots_fired > 0)
            || (current_shots_hit > 0)
            || (std::isfinite(current_seconds) && current_seconds > 0.0001f)
            || (std::isfinite(current_score_total) && current_score_total > 0.0001f)
            || (std::isfinite(current_score_per_minute) && current_score_per_minute > 0.0001f)
            || (std::isfinite(current_kills_per_second) && current_kills_per_second > 0.0001f)
            || (std::isfinite(current_accuracy) && current_accuracy > 0.0001f)
            || (std::isfinite(current_damage_done) && current_damage_done > 0.0001f)
            || (std::isfinite(current_damage_possible) && current_damage_possible > 0.0001f)
            || (std::isfinite(current_damage_efficiency) && current_damage_efficiency > 0.0001f)
            || (std::isfinite(current_time_remaining) && current_time_remaining > 0.0001f)
            || (std::isfinite(current_queue_time_remaining) && current_queue_time_remaining > 0.0001f);
        const bool had_any_source =
            (receiver != nullptr)
            || (scenario_manager != nullptr)
            || (meta != nullptr);
        if (has_nonzero_signal || has_state_signal || !had_any_source) {
            zero_signal_streak_ = 0;
        } else if (++zero_signal_streak_ >= 90) { // ~3s at 30Hz
            reset_runtime_resolvers();
            zero_signal_streak_ = 0;
            fault_backoff_until_ms_ = now + 100;
            if (verbose_logs_) {
                RC::Output::send<RC::LogLevel::Warning>(STR("[kmod-prod] zero-signal streak hit, forcing resolver refresh\n"));
            }
        }

        if (verbose_logs_ && now >= next_diag_log_ms_) {
            next_diag_log_ms_ = now + 2000;
            const auto receiver_name = receiver ? receiver->GetFullName() : STR("null");
            const auto scenario_name = scenario_manager ? scenario_manager->GetFullName() : STR("null");
            const auto meta_name = meta ? meta->GetFullName() : STR("null");
            const uint64_t have_state_targets = static_cast<uint64_t>(
                targets_.get_shots_fired_value_else != nullptr || targets_.get_shots_fired_value_or != nullptr
                || targets_.receive_shots_fired_value_else != nullptr || targets_.receive_shots_fired_single != nullptr || targets_.receive_shots_fired != nullptr
                || targets_.get_shots_hit_value_else != nullptr || targets_.get_shots_hit_value_or != nullptr
                || targets_.receive_shots_hit_value_else != nullptr || targets_.receive_shots_hit_single != nullptr || targets_.receive_shots_hit != nullptr
                || targets_.get_score_per_minute_value_else != nullptr || targets_.get_score_per_minute_value_or != nullptr
                || targets_.receive_score_per_minute_value_else != nullptr || targets_.receive_score_per_minute != nullptr
                || targets_.get_kills_per_second_value_else != nullptr || targets_.get_kills_per_second_value_or != nullptr
                || targets_.receive_kills_per_second_value_else != nullptr || targets_.receive_kills_per_second != nullptr
                || targets_.get_damage_done_value_else != nullptr || targets_.get_damage_done_value_or != nullptr
                || targets_.receive_damage_done_value_else != nullptr || targets_.receive_damage_done != nullptr
                || targets_.get_damage_possible_value_else != nullptr || targets_.get_damage_possible_value_or != nullptr
                || targets_.receive_damage_possible_value_else != nullptr || targets_.receive_damage_possible != nullptr
                || targets_.get_damage_efficiency_value_else != nullptr || targets_.get_damage_efficiency_value_or != nullptr
                || targets_.receive_damage_efficiency_value_else != nullptr || targets_.receive_damage_efficiency != nullptr
                || targets_.get_seconds_value_else != nullptr || targets_.get_seconds_value_or != nullptr
                || targets_.receive_seconds != nullptr
            );
            const uint64_t have_scenario_targets = static_cast<uint64_t>(
                targets_.scenario_get_challenge_time_remaining != nullptr
                || targets_.scenario_get_challenge_queue_time_remaining != nullptr
                || targets_.scenario_is_in_challenge != nullptr
                || targets_.scenario_is_in_scenario != nullptr
                || targets_.scenario_is_in_scenario_editor != nullptr
                || targets_.scenario_is_currently_in_benchmark != nullptr
            );
            const uint64_t have_meta_targets = static_cast<uint64_t>(targets_.meta_get_in_trainer != nullptr);
            RC::Output::send<RC::LogLevel::Warning>(
                STR("[kmod-prod] sf={} sh={} ic={} is={} ise={} bench={} trainer={} sec={} spm={} kps={} dd={} dp={} de={} tr={} qtr={} receiver={} scenario={} meta={} tgt_state={} tgt_scenario={} tgt_meta={}\n"),
                last_shots_fired_,
                last_shots_hit_,
                last_is_in_challenge_,
                last_is_in_scenario_,
                last_is_in_scenario_editor_,
                last_is_currently_in_benchmark_,
                last_is_in_trainer_,
                static_cast<double>(last_seconds_),
                static_cast<double>(last_score_per_minute_),
                static_cast<double>(last_kills_per_second_),
                static_cast<double>(last_damage_done_),
                static_cast<double>(last_damage_possible_),
                static_cast<double>(last_damage_efficiency_),
                static_cast<double>(last_time_remaining_),
                static_cast<double>(last_queue_time_remaining_),
                receiver_name,
                scenario_name,
                meta_name,
                have_state_targets,
                have_scenario_targets,
                have_meta_targets
            );
        }
    }

    void handle_runtime_fault(const char* where) {
        ++fault_count_;
        const uint64_t now = GetTickCount64();
        const uint64_t backoff_ms = (fault_count_ < 20) ? 250 : 1000;
        fault_backoff_until_ms_ = now + backoff_ms;
        reset_runtime_resolvers();
        if (fault_count_ >= 200) {
            updates_disabled_ = true;
        }
        if (rust_ready_) {
            std::array<char, 192> json{};
            std::snprintf(
                json.data(),
                json.size(),
                "{\"ev\":\"ue4ss_prod_fault\",\"where\":\"%s\",\"count\":%u,\"disabled\":%u}",
                where ? where : "unknown",
                static_cast<unsigned int>(fault_count_),
                updates_disabled_ ? 1u : 0u
            );
            kovaaks::RustBridge::emit_json(json.data());
        }
        RC::Output::send<RC::LogLevel::Error>(
            STR("[kmod-prod] runtime fault trapped; backoff active (count={} disabled={})\n"),
            static_cast<uint64_t>(fault_count_),
            static_cast<uint64_t>(updates_disabled_ ? 1 : 0)
        );
    }

private:
    struct Targets {
        RC::Unreal::UFunction* get_kills_value_else{};
        RC::Unreal::UFunction* get_kills_value_or{};
        RC::Unreal::UFunction* receive_kills_value_else{};
        RC::Unreal::UFunction* receive_kills_single{};
        RC::Unreal::UFunction* receive_kills{};
        RC::Unreal::UFunction* get_score_value_else{};
        RC::Unreal::UFunction* get_score_value_or{};
        RC::Unreal::UFunction* receive_score_value_else{};
        RC::Unreal::UFunction* receive_score_single{};
        RC::Unreal::UFunction* receive_score{};
        RC::Unreal::UFunction* get_accuracy_value_else{};
        RC::Unreal::UFunction* get_accuracy_value_or{};
        RC::Unreal::UFunction* receive_accuracy_value_else{};
        RC::Unreal::UFunction* receive_accuracy_single{};
        RC::Unreal::UFunction* receive_accuracy{};
        RC::Unreal::UFunction* get_shots_fired_value_else{};
        RC::Unreal::UFunction* get_shots_fired_value_or{};
        RC::Unreal::UFunction* receive_shots_fired_value_else{};
        RC::Unreal::UFunction* receive_shots_fired_single{};
        RC::Unreal::UFunction* receive_shots_fired{};
        RC::Unreal::UFunction* get_shots_hit_value_else{};
        RC::Unreal::UFunction* get_shots_hit_value_or{};
        RC::Unreal::UFunction* receive_shots_hit_value_else{};
        RC::Unreal::UFunction* receive_shots_hit_single{};
        RC::Unreal::UFunction* receive_shots_hit{};
        RC::Unreal::UFunction* get_seconds_value_else{};
        RC::Unreal::UFunction* get_seconds_value_or{};
        RC::Unreal::UFunction* receive_seconds{};
        RC::Unreal::UFunction* get_score_per_minute_value_else{};
        RC::Unreal::UFunction* get_score_per_minute_value_or{};
        RC::Unreal::UFunction* receive_score_per_minute_value_else{};
        RC::Unreal::UFunction* receive_score_per_minute{};
        RC::Unreal::UFunction* get_kills_per_second_value_else{};
        RC::Unreal::UFunction* get_kills_per_second_value_or{};
        RC::Unreal::UFunction* receive_kills_per_second_value_else{};
        RC::Unreal::UFunction* receive_kills_per_second{};
        RC::Unreal::UFunction* get_damage_done_value_else{};
        RC::Unreal::UFunction* get_damage_done_value_or{};
        RC::Unreal::UFunction* receive_damage_done_value_else{};
        RC::Unreal::UFunction* receive_damage_done{};
        RC::Unreal::UFunction* get_damage_possible_value_else{};
        RC::Unreal::UFunction* get_damage_possible_value_or{};
        RC::Unreal::UFunction* receive_damage_possible_value_else{};
        RC::Unreal::UFunction* receive_damage_possible{};
        RC::Unreal::UFunction* get_damage_efficiency_value_else{};
        RC::Unreal::UFunction* get_damage_efficiency_value_or{};
        RC::Unreal::UFunction* receive_damage_efficiency_value_else{};
        RC::Unreal::UFunction* receive_damage_efficiency{};
        RC::Unreal::UFunction* get_challenge_average_fps_value_else{};
        RC::Unreal::UFunction* get_challenge_average_fps_value_or{};
        RC::Unreal::UFunction* receive_challenge_average_fps_value_else{};
        RC::Unreal::UFunction* receive_challenge_average_fps_value_or{};
        RC::Unreal::UFunction* receive_challenge_average_fps_single{};
        RC::Unreal::UFunction* receive_challenge_average_fps{};
        RC::Unreal::UFunction* get_challenge_tick_count_value_else{};
        RC::Unreal::UFunction* get_challenge_tick_count_value_or{};
        RC::Unreal::UFunction* receive_challenge_tick_count_value_else{};
        RC::Unreal::UFunction* receive_challenge_tick_count_value_or{};
        RC::Unreal::UFunction* receive_challenge_tick_count_single{};
        RC::Unreal::UFunction* receive_challenge_tick_count{};
        RC::Unreal::UFunction* meta_get_in_trainer{};
        RC::Unreal::UFunction* scenario_get_challenge_time_remaining{};
        RC::Unreal::UFunction* scenario_get_challenge_queue_time_remaining{};
        RC::Unreal::UFunction* scenario_is_in_challenge{};
        RC::Unreal::UFunction* scenario_is_in_scenario{};
        RC::Unreal::UFunction* scenario_is_in_scenario_editor{};
        RC::Unreal::UFunction* scenario_is_currently_in_benchmark{};
    };

    struct UiSnapshot {
        int32_t shots_fired{-1};
        int32_t shots_hit{-1};
        int32_t kills{-1};
        std::string scenario_name{};
        float seconds{-1.0f};
        float score_per_minute{-1.0f};
        float score_total{-1.0f};
        float kills_per_second{-1.0f};
        float damage_done{-1.0f};
        float damage_possible{-1.0f};
        float damage_efficiency{-1.0f};
        float avg_ttk{-1.0f};
    };

    struct NumericInvokeResult {
        bool valid{false};
        bool is_floating{false};
        double as_float{0.0};
        int64_t as_int{0};
    };

    struct BoolInvokeResult {
        bool valid{false};
        bool value{false};
    };

    static inline std::atomic<bool> s_disable_direct_invoke_path{false};
    static inline std::atomic<uint64_t> s_direct_invoke_faults{0};
    static inline std::atomic<uint64_t> s_direct_poll_errors{0};
    static inline std::atomic<uint64_t> s_direct_invoke_last_fault_ms{0};

    static inline int32_t s_last_pull_is_in_challenge{-1};
    static inline int32_t s_last_pull_is_in_scenario{-1};
    static inline int32_t s_last_pull_is_in_scenario_editor{-1};
    static inline int32_t s_last_pull_scenario_is_in_editor{-1};
    static inline int32_t s_last_pull_scenario_is_paused{-1};
    static inline float s_last_pull_queue_time_remaining{-1.0f};
    static inline float s_last_pull_score{-1.0f};
    static inline int32_t s_last_pull_kills{-1};
    static inline float s_last_pull_spm{-1.0f};
    static inline float s_last_pull_challenge_seconds{-1.0f};
    static inline float s_last_pull_challenge_average_fps{-1.0f};
    static inline int32_t s_last_pull_challenge_tick_count{-1};
    static inline float s_last_pull_time_remaining{-1.0f};
    static inline std::string s_last_run_scenario_name{};

    bool rust_ready_{false};
    Targets targets_{};

    RC::Unreal::UObject* meta_game_instance_{nullptr};
    RC::Unreal::UObject* state_receiver_instance_{nullptr};
    RC::Unreal::UObject* scenario_manager_instance_{nullptr};
    RC::Unreal::UClass* meta_game_instance_class_{nullptr};
    RC::Unreal::UClass* state_receiver_class_{nullptr};
    RC::Unreal::UClass* scenario_manager_class_{nullptr};
    RC::Unreal::UFunction* text_set_fn_{nullptr};
    RC::Unreal::UFunction* text_get_fn_{nullptr};
    uint64_t text_set_hook_id_{0};
    bool text_set_hook_registered_{false};
    std::unordered_map<RC::Unreal::UClass*, RC::Unreal::FTextProperty*> text_property_cache_{};
    std::mutex ui_mutex_{};
    UiSnapshot ui_live_snapshot_{};
    bool ui_live_updated_{false};

    std::unordered_map<RC::Unreal::UFunction*, RC::Unreal::UClass*> cached_owner_class_{};

    uint64_t next_poll_ms_{0};
    uint64_t next_targets_resolve_ms_{0};
    uint64_t next_meta_resolve_ms_{0};
    uint64_t next_receiver_resolve_ms_{0};
    uint64_t next_scenario_resolve_ms_{0};
    uint64_t fault_backoff_until_ms_{0};
    uint32_t zero_signal_streak_{0};

    int32_t last_kills_total_{std::numeric_limits<int32_t>::min()};
    int32_t last_shots_fired_{std::numeric_limits<int32_t>::min()};
    int32_t last_shots_hit_{std::numeric_limits<int32_t>::min()};
    int32_t last_is_in_challenge_{std::numeric_limits<int32_t>::min()};
    int32_t last_is_in_scenario_{std::numeric_limits<int32_t>::min()};
    int32_t last_is_in_scenario_editor_{std::numeric_limits<int32_t>::min()};
    int32_t last_is_currently_in_benchmark_{std::numeric_limits<int32_t>::min()};
    int32_t last_is_in_trainer_{std::numeric_limits<int32_t>::min()};
    float last_seconds_{std::numeric_limits<float>::quiet_NaN()};
    float last_score_total_{std::numeric_limits<float>::quiet_NaN()};
    float last_score_per_minute_{std::numeric_limits<float>::quiet_NaN()};
    float last_kills_per_second_{std::numeric_limits<float>::quiet_NaN()};
    float last_accuracy_{std::numeric_limits<float>::quiet_NaN()};
    float last_challenge_seconds_total_{std::numeric_limits<float>::quiet_NaN()};
    float last_challenge_average_fps_{std::numeric_limits<float>::quiet_NaN()};
    int32_t last_challenge_tick_count_{std::numeric_limits<int32_t>::min()};
    float last_damage_done_{std::numeric_limits<float>::quiet_NaN()};
    float last_damage_possible_{std::numeric_limits<float>::quiet_NaN()};
    float last_damage_efficiency_{std::numeric_limits<float>::quiet_NaN()};
    float last_time_remaining_{std::numeric_limits<float>::quiet_NaN()};
    float last_queue_time_remaining_{std::numeric_limits<float>::quiet_NaN()};
    std::string last_scenario_name_{};

    uint64_t last_nonzero_kills_total_ms_{0};
    uint64_t last_nonzero_shots_fired_ms_{0};
    uint64_t last_nonzero_shots_hit_ms_{0};
    uint64_t last_nonzero_seconds_ms_{0};
    uint64_t last_nonzero_score_total_ms_{0};
    uint64_t last_nonzero_spm_ms_{0};
    uint64_t last_nonzero_kills_per_second_ms_{0};
    uint64_t last_nonzero_accuracy_ms_{0};
    uint64_t last_nonzero_challenge_seconds_ms_{0};
    uint64_t last_nonzero_challenge_average_fps_ms_{0};
    uint64_t last_nonzero_challenge_tick_count_ms_{0};
    uint64_t last_nonzero_damage_done_ms_{0};
    uint64_t last_nonzero_damage_possible_ms_{0};
    uint64_t last_nonzero_damage_efficiency_ms_{0};
    uint64_t last_nonzero_time_remaining_ms_{0};
    uint64_t last_nonzero_queue_time_remaining_ms_{0};
    bool lifecycle_active_{false};
    bool lifecycle_initialized_{false};
    bool lifecycle_queued_{false};
    bool lifecycle_seen_progress_{false};
    uint64_t last_lifecycle_signal_ms_{0};
    bool verbose_logs_{false};
    uint64_t next_diag_log_ms_{0};
    bool updates_disabled_{false};
    uint32_t fault_count_{0};
    const char* emit_method_{"unknown"};
    const char* emit_origin_flag_{"unknown"};

    void reset_runtime_resolvers() {
        meta_game_instance_ = nullptr;
        state_receiver_instance_ = nullptr;
        scenario_manager_instance_ = nullptr;
        next_meta_resolve_ms_ = 0;
        next_receiver_resolve_ms_ = 0;
        next_scenario_resolve_ms_ = 0;
        next_targets_resolve_ms_ = 0;
    }

    static void emit_simple_event(const char* ev) {
        std::array<char, 96> json{};
        std::snprintf(json.data(), json.size(), "{\"ev\":\"%s\"}", ev);
        kovaaks::RustBridge::emit_json(json.data());
    }

    void emit_lifecycle_start(uint64_t now) {
        lifecycle_active_ = true;
        lifecycle_queued_ = false;
        lifecycle_seen_progress_ = false;
        last_lifecycle_signal_ms_ = now;
        emit_simple_event("session_start");
        emit_simple_event("challenge_start");
        emit_simple_event("scenario_start");
    }

    void emit_lifecycle_end(bool completed) {
        lifecycle_active_ = false;
        emit_simple_event("challenge_end");
        emit_simple_event("scenario_end");
        if (completed) {
            emit_simple_event("challenge_complete");
            emit_simple_event("challenge_completed");
            emit_simple_event("post_challenge_complete");
        } else {
            emit_simple_event("challenge_canceled");
        }
        emit_simple_event("session_end");
    }

    void update_lifecycle_events(
        uint64_t now,
        int32_t is_in_challenge,
        int32_t is_in_scenario,
        int32_t shots_fired,
        int32_t shots_hit,
        float seconds_total,
        float score_per_minute,
        float damage_done,
        float damage_possible,
        float time_remaining,
        float queue_time_remaining
    ) {
        const auto has_float = [](float v) {
            return std::isfinite(v) && v >= 0.0f;
        };
        const auto has_positive_float = [](float v) {
            return std::isfinite(v) && v > 0.0001f;
        };

        const bool has_signal =
            is_in_challenge >= 0 ||
            is_in_scenario >= 0 ||
            shots_fired >= 0 ||
            shots_hit >= 0 ||
            has_float(seconds_total) ||
            has_float(score_per_minute) ||
            has_float(damage_done) ||
            has_float(damage_possible) ||
            has_float(time_remaining) ||
            has_float(queue_time_remaining);
        if (!has_signal) {
            return;
        }

        const bool progress_signal =
            shots_fired > 0 ||
            shots_hit > 0 ||
            has_positive_float(seconds_total) ||
            has_positive_float(score_per_minute) ||
            has_positive_float(damage_done) ||
            has_positive_float(damage_possible);
        const bool queue_signal = has_positive_float(queue_time_remaining);
        const bool known_in_challenge = is_in_challenge >= 0;
        const bool known_in_scenario = is_in_scenario >= 0;
        bool active_signal = false;
        if (known_in_challenge) {
            active_signal = (is_in_challenge != 0);
        } else if (known_in_scenario) {
            active_signal = (is_in_scenario != 0);
        } else {
            active_signal = progress_signal || has_positive_float(time_remaining);
        }

        if (!lifecycle_initialized_) {
            lifecycle_initialized_ = true;
            lifecycle_queued_ = queue_signal;
            lifecycle_seen_progress_ = false;
            if (queue_signal && !active_signal) {
                emit_simple_event("challenge_queued");
            }
            if (active_signal) {
                emit_lifecycle_start(now);
                lifecycle_seen_progress_ = progress_signal;
            }
            return;
        }

        if (queue_signal && !lifecycle_queued_ && !lifecycle_active_) {
            lifecycle_queued_ = true;
            emit_simple_event("challenge_queued");
        } else if (!queue_signal && !lifecycle_active_) {
            lifecycle_queued_ = false;
        }

        if (active_signal) {
            if (!lifecycle_active_) {
                emit_lifecycle_start(now);
            }
            if (progress_signal) {
                lifecycle_seen_progress_ = true;
            }
            last_lifecycle_signal_ms_ = now;
            return;
        }

        if (!lifecycle_active_) {
            return;
        }

        if (known_in_challenge || known_in_scenario) {
            emit_lifecycle_end(lifecycle_seen_progress_ || progress_signal);
            return;
        }

        constexpr uint64_t k_idle_end_ms = 2000;
        if (last_lifecycle_signal_ms_ > 0 && (now - last_lifecycle_signal_ms_) > k_idle_end_ms) {
            emit_lifecycle_end(lifecycle_seen_progress_ || progress_signal);
        }
    }

    void resolve_targets(bool force) {
        const uint64_t now = GetTickCount64();
        if (!force && now < next_targets_resolve_ms_) {
            return;
        }
        next_targets_resolve_ms_ = now + 2000;

        auto resolve_fn = [](const wchar_t* path) -> RC::Unreal::UFunction* {
            auto* fn = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr, nullptr, path
            );
            if (fn && is_likely_valid_object_ptr(fn)
                && !is_rejected_runtime_function_name(fn->GetFullName())) {
                return fn;
            }
            return nullptr;
        };

        targets_.get_kills_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Kills_ValueElse"));
        targets_.get_kills_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Kills_ValueOr"));
        targets_.receive_kills_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Kills_ValueElse"));
        targets_.receive_kills_single = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Kills_Single"));
        targets_.receive_kills = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Kills"));
        targets_.get_score_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Score_ValueElse"));
        targets_.get_score_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Score_ValueOr"));
        targets_.receive_score_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Score_ValueElse"));
        targets_.receive_score_single = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Score_Single"));
        targets_.receive_score = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Score"));
        targets_.get_accuracy_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Accuracy_ValueElse"));
        targets_.get_accuracy_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Accuracy_ValueOr"));
        targets_.receive_accuracy_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Accuracy_ValueElse"));
        targets_.receive_accuracy_single = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Accuracy_Single"));
        targets_.receive_accuracy = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Accuracy"));
        targets_.get_shots_fired_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ShotsFired_ValueElse"));
        targets_.get_shots_fired_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ShotsFired_ValueOr"));
        targets_.receive_shots_fired_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ShotsFired_ValueElse"));
        targets_.receive_shots_fired_single = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ShotsFired_Single"));
        targets_.receive_shots_fired = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ShotsFired"));
        targets_.get_shots_hit_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ShotsHit_ValueElse"));
        targets_.get_shots_hit_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ShotsHit_ValueOr"));
        targets_.receive_shots_hit_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ShotsHit_ValueElse"));
        targets_.receive_shots_hit_single = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ShotsHit_Single"));
        targets_.receive_shots_hit = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ShotsHit"));
        targets_.get_seconds_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Seconds_ValueElse"));
        targets_.get_seconds_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Seconds_ValueOr"));
        targets_.receive_seconds = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Seconds"));
        targets_.get_score_per_minute_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ScorePerMinute_ValueElse"));
        targets_.get_score_per_minute_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ScorePerMinute_ValueOr"));
        targets_.receive_score_per_minute_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ScorePerMinute_ValueElse"));
        targets_.receive_score_per_minute = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ScorePerMinute"));
        targets_.get_kills_per_second_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_KillsPerSecond_ValueElse"));
        targets_.get_kills_per_second_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_KillsPerSecond_ValueOr"));
        targets_.receive_kills_per_second_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_KillsPerSecond_ValueElse"));
        targets_.receive_kills_per_second = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_KillsPerSecond"));
        targets_.get_damage_done_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamageDone_ValueElse"));
        targets_.get_damage_done_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamageDone_ValueOr"));
        targets_.receive_damage_done_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_DamageDone_ValueElse"));
        targets_.receive_damage_done = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_DamageDone"));
        targets_.get_damage_possible_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamagePossible_ValueElse"));
        targets_.get_damage_possible_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamagePossible_ValueOr"));
        targets_.receive_damage_possible_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_DamagePossible_ValueElse"));
        targets_.receive_damage_possible = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_DamagePossible"));
        targets_.get_damage_efficiency_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamageEfficiency_ValueElse"));
        targets_.get_damage_efficiency_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamageEfficiency_ValueOr"));
        targets_.receive_damage_efficiency_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_DamageEfficiency_ValueElse"));
        targets_.receive_damage_efficiency = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_DamageEfficiency"));
        targets_.get_challenge_average_fps_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ChallengeAverageFPS_ValueElse"));
        targets_.get_challenge_average_fps_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ChallengeAverageFPS_ValueOr"));
        targets_.receive_challenge_average_fps_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeAverageFPS_ValueElse"));
        targets_.receive_challenge_average_fps_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeAverageFPS_ValueOr"));
        targets_.receive_challenge_average_fps_single = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeAverageFPS_Single"));
        targets_.receive_challenge_average_fps = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeAverageFPS"));
        targets_.get_challenge_tick_count_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ChallengeTickCount_ValueElse"));
        targets_.get_challenge_tick_count_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ChallengeTickCount_ValueOr"));
        targets_.receive_challenge_tick_count_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeTickCount_ValueElse"));
        targets_.receive_challenge_tick_count_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeTickCount_ValueOr"));
        targets_.receive_challenge_tick_count_single = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeTickCount_Single"));
        targets_.receive_challenge_tick_count = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeTickCount"));
        targets_.meta_get_in_trainer = resolve_fn(STR("/Script/GameSkillsTrainer.GTheMetaGameInstance:GetInTrainer"));
        targets_.scenario_get_challenge_time_remaining = resolve_fn(STR("/Script/GameSkillsTrainer.ScenarioManager:GetChallengeTimeRemaining"));
        targets_.scenario_get_challenge_queue_time_remaining = resolve_fn(STR("/Script/GameSkillsTrainer.ScenarioManager:GetChallengeQueueTimeRemaining"));
        targets_.scenario_is_in_challenge = resolve_fn(STR("/Script/GameSkillsTrainer.ScenarioManager:IsInChallenge"));
        targets_.scenario_is_in_scenario = resolve_fn(STR("/Script/GameSkillsTrainer.ScenarioManager:IsInScenario"));
        targets_.scenario_is_in_scenario_editor = resolve_fn(STR("/Script/GameSkillsTrainer.ScenarioManager:IsInScenarioEditor"));
        targets_.scenario_is_currently_in_benchmark = resolve_fn(STR("/Script/GameSkillsTrainer.ScenarioManager:IsCurrentlyInBenchmark"));
    }

    RC::Unreal::UClass* resolve_function_owner_class(RC::Unreal::UFunction* fn) {
        if (!fn || !is_likely_valid_object_ptr(fn)) {
            return nullptr;
        }
        const auto it = cached_owner_class_.find(fn);
        if (it != cached_owner_class_.end() && is_likely_valid_object_ptr(it->second)) {
            return it->second;
        }

        const auto full_name = fn->GetFullName();
        const auto space_pos = full_name.find(STR(" "));
        if (space_pos == RC::StringType::npos) {
            return nullptr;
        }
        const auto colon_pos = full_name.find(STR(":"), space_pos + 1);
        if (colon_pos == RC::StringType::npos || colon_pos <= (space_pos + 1)) {
            return nullptr;
        }
        const auto class_path = full_name.substr(space_pos + 1, colon_pos - (space_pos + 1));
        auto* owner_class = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UClass*>(
            nullptr, nullptr, class_path.c_str()
        );
        if (owner_class && is_likely_valid_object_ptr(owner_class)) {
            cached_owner_class_[fn] = owner_class;
            return owner_class;
        }
        return nullptr;
    }

    static RC::Unreal::UObject* resolve_class_default_object(RC::Unreal::UClass* owner_class) {
        if (!owner_class || !is_likely_valid_object_ptr(owner_class)) {
            return nullptr;
        }
        auto* cdo = *reinterpret_cast<RC::Unreal::UObject**>(
            reinterpret_cast<uint8_t*>(owner_class) + 0x118
        );
        if (cdo && is_likely_valid_object_ptr(cdo)) {
            return cdo;
        }
        return nullptr;
    }

    RC::Unreal::UObject* resolve_receive_caller(RC::Unreal::UObject* preferred, RC::Unreal::UFunction* fn) {
        if (!fn || !is_likely_valid_object_ptr(fn)) {
            return nullptr;
        }
        auto* owner_class = resolve_function_owner_class(fn);
        if (owner_class && is_likely_valid_object_ptr(owner_class) && fn->HasAnyFunctionFlags(RC::Unreal::FUNC_Static)) {
            if (auto* cdo = resolve_class_default_object(owner_class)) {
                return cdo;
            }
        }
        if (owner_class && is_likely_valid_object_ptr(owner_class)) {
            if (preferred && is_likely_valid_object_ptr(preferred) && preferred->IsA(owner_class)) {
                return preferred;
            }
            if (meta_game_instance_ && is_likely_valid_object_ptr(meta_game_instance_) && meta_game_instance_->IsA(owner_class)) {
                return meta_game_instance_;
            }
            if (auto* cdo = resolve_class_default_object(owner_class)) {
                return cdo;
            }
        }
        if (preferred && is_likely_valid_object_ptr(preferred)) {
            return preferred;
        }
        if (meta_game_instance_ && is_likely_valid_object_ptr(meta_game_instance_)) {
            return meta_game_instance_;
        }
        return nullptr;
    }

    NumericInvokeResult invoke_numeric_ufunction(RC::Unreal::UObject* receiver, RC::Unreal::UFunction* fn) {
        NumericInvokeResult result{};
        auto* caller = resolve_receive_caller(receiver, fn);
        if (!caller || !fn || !is_likely_valid_object_ptr(fn)) {
            return result;
        }

        int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x200;
        }
        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);

        RC::Unreal::FNumericProperty* output_numeric = nullptr;
        int output_priority = -1;

        for (RC::Unreal::FProperty* property : enumerate_properties(fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_Parm)) {
                continue;
            }
            const auto normalized_name = normalize_ascii(property->GetName());

            const bool is_out = property_has_any_flags(property, RC::Unreal::CPF_OutParm)
                || property_has_any_flags(property, RC::Unreal::CPF_ReturnParm);
            const bool has_output_name = (normalized_name == "outvalue" || normalized_name == "returnvalue");

            if (is_out || has_output_name) {
                auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property);
                if (!numeric || !is_likely_valid_object_ptr(numeric)) {
                    continue;
                }
                int priority = 0;
                if (normalized_name == "outvalue") {
                    priority = 5;
                } else if (normalized_name == "returnvalue") {
                    priority = 4;
                } else if (property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                    priority = 3;
                } else if (property_has_any_flags(property, RC::Unreal::CPF_OutParm)) {
                    priority = 2;
                } else {
                    priority = 1;
                }
                if (!output_numeric || priority > output_priority) {
                    output_numeric = numeric;
                    output_priority = priority;
                }
                continue;
            }

            if (auto* object_property = RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property)) {
                if (normalized_name.find("worldcontextobject") != std::string::npos) {
                    void* value_ptr = safe_property_value_ptr(property, params.data());
                    if (value_ptr && is_likely_readable_region(value_ptr, sizeof(void*))) {
                        RC::Unreal::UObject* context_object = nullptr;
                        if (meta_game_instance_ && is_likely_valid_object_ptr(meta_game_instance_)) {
                            context_object = meta_game_instance_;
                        } else if (receiver && is_likely_valid_object_ptr(receiver)) {
                            context_object = receiver;
                        } else {
                            context_object = caller;
                        }
                        object_property->SetObjectPropertyValue(value_ptr, context_object);
                    }
                }
                continue;
            }

            if (auto* numeric_property = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property)) {
                if (normalized_name.find("valueifnull") != std::string::npos) {
                    void* value_ptr = safe_property_value_ptr(property, params.data());
                    if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(double))) {
                        continue;
                    }
                    if (numeric_property->IsFloatingPoint()) {
                        numeric_property->SetFloatingPointPropertyValue(value_ptr, -1.0);
                    } else {
                        numeric_property->SetIntPropertyValue(value_ptr, static_cast<int64_t>(-1));
                    }
                }
            }
        }

        if (!output_numeric || !is_likely_valid_object_ptr(output_numeric)) {
            return result;
        }

        caller->ProcessEvent(fn, params.data());
        void* output_ptr = safe_property_value_ptr(output_numeric, params.data());
        if (!output_ptr || !is_likely_readable_region(output_ptr, sizeof(double))) {
            return result;
        }

        if (output_numeric->IsFloatingPoint()) {
            const double value = output_numeric->GetFloatingPointPropertyValue(output_ptr);
            if (!std::isfinite(value)) {
                return result;
            }
            result.valid = true;
            result.is_floating = true;
            result.as_float = value;
            return result;
        }
        if (output_numeric->IsInteger()) {
            result.valid = true;
            result.is_floating = false;
            result.as_int = output_numeric->GetSignedIntPropertyValue(output_ptr);
            return result;
        }
        return result;
    }

    BoolInvokeResult invoke_bool_ufunction(RC::Unreal::UObject* receiver, RC::Unreal::UFunction* fn) {
        BoolInvokeResult result{};
        auto* caller = resolve_receive_caller(receiver, fn);
        if (!caller || !fn || !is_likely_valid_object_ptr(fn)) {
            return result;
        }

        int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x200;
        }
        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);

        RC::Unreal::FBoolProperty* output_bool = nullptr;
        int output_priority = -1;

        for (RC::Unreal::FProperty* property : enumerate_properties(fn)) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property_has_any_flags(property, RC::Unreal::CPF_Parm)) {
                continue;
            }
            const auto normalized_name = normalize_ascii(property->GetName());

            const bool is_out = property_has_any_flags(property, RC::Unreal::CPF_OutParm)
                || property_has_any_flags(property, RC::Unreal::CPF_ReturnParm);
            const bool has_output_name = (normalized_name == "outvalue" || normalized_name == "returnvalue");

            if (is_out || has_output_name) {
                auto* bool_property = RC::Unreal::CastField<RC::Unreal::FBoolProperty>(property);
                if (!bool_property || !is_likely_valid_object_ptr(bool_property)) {
                    continue;
                }
                int priority = 0;
                if (normalized_name == "outvalue") {
                    priority = 5;
                } else if (normalized_name == "returnvalue") {
                    priority = 4;
                } else if (property_has_any_flags(property, RC::Unreal::CPF_ReturnParm)) {
                    priority = 3;
                } else if (property_has_any_flags(property, RC::Unreal::CPF_OutParm)) {
                    priority = 2;
                } else {
                    priority = 1;
                }
                if (!output_bool || priority > output_priority) {
                    output_bool = bool_property;
                    output_priority = priority;
                }
                continue;
            }

            if (auto* object_property = RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property)) {
                if (normalized_name.find("worldcontextobject") != std::string::npos) {
                    void* value_ptr = safe_property_value_ptr(property, params.data());
                    if (value_ptr && is_likely_readable_region(value_ptr, sizeof(void*))) {
                        RC::Unreal::UObject* context_object = nullptr;
                        if (meta_game_instance_ && is_likely_valid_object_ptr(meta_game_instance_)) {
                            context_object = meta_game_instance_;
                        } else if (receiver && is_likely_valid_object_ptr(receiver)) {
                            context_object = receiver;
                        } else {
                            context_object = caller;
                        }
                        object_property->SetObjectPropertyValue(value_ptr, context_object);
                    }
                }
                continue;
            }
        }

        if (!output_bool || !is_likely_valid_object_ptr(output_bool)) {
            return result;
        }

        caller->ProcessEvent(fn, params.data());
        void* output_ptr = safe_property_value_ptr(output_bool, params.data());
        if (!output_ptr || !is_likely_readable_region(output_ptr, sizeof(uint8_t))) {
            return result;
        }

        result.valid = true;
        result.value = output_bool->GetPropertyValue(output_ptr);
        return result;
    }

    bool try_read_int(RC::Unreal::UObject* receiver, std::initializer_list<RC::Unreal::UFunction*> fns, int32_t& out) {
        for (auto* fn : fns) {
            if (!fn || !is_likely_valid_object_ptr(fn)) {
                continue;
            }
            if (is_rejected_runtime_function_name(fn->GetFullName())) {
                continue;
            }
            const auto result = invoke_numeric_ufunction(receiver, fn);
            if (!result.valid) {
                continue;
            }
            if (result.is_floating) {
                if (!std::isfinite(result.as_float)) {
                    continue;
                }
                out = static_cast<int32_t>(std::llround(result.as_float));
            } else {
                out = static_cast<int32_t>(result.as_int);
            }
            return true;
        }
        return false;
    }

    bool try_read_float(RC::Unreal::UObject* receiver, std::initializer_list<RC::Unreal::UFunction*> fns, float& out) {
        for (auto* fn : fns) {
            if (!fn || !is_likely_valid_object_ptr(fn)) {
                continue;
            }
            if (is_rejected_runtime_function_name(fn->GetFullName())) {
                continue;
            }
            const auto result = invoke_numeric_ufunction(receiver, fn);
            if (!result.valid) {
                continue;
            }
            if (result.is_floating) {
                out = static_cast<float>(result.as_float);
            } else {
                out = static_cast<float>(result.as_int);
            }
            if (!std::isfinite(out)) {
                continue;
            }
            return true;
        }
        return false;
    }

    bool try_read_bool(RC::Unreal::UObject* receiver, std::initializer_list<RC::Unreal::UFunction*> fns, bool& out) {
        for (auto* fn : fns) {
            if (!fn || !is_likely_valid_object_ptr(fn)) {
                continue;
            }
            if (is_rejected_runtime_function_name(fn->GetFullName())) {
                continue;
            }
            const auto result = invoke_bool_ufunction(receiver, fn);
            if (!result.valid) {
                continue;
            }
            out = result.value;
            return true;
        }
        return false;
    }

    RC::Unreal::UClass* resolve_class_cached(
        RC::Unreal::UClass*& cache,
        std::initializer_list<const wchar_t*> candidate_paths
    ) {
        if (cache && is_likely_valid_object_ptr(cache)) {
            return cache;
        }
        for (const auto* path : candidate_paths) {
            if (!path) {
                continue;
            }
            auto* cls = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UClass*>(nullptr, nullptr, path);
            if (cls && is_likely_valid_object_ptr(cls)) {
                cache = cls;
                return cache;
            }
        }
        return nullptr;
    }

    RC::Unreal::UObject* resolve_meta_game_instance(uint64_t now) {
        if (meta_game_instance_ && is_likely_valid_object_ptr(meta_game_instance_) && now < next_meta_resolve_ms_) {
            return meta_game_instance_;
        }
        next_meta_resolve_ms_ = now + 2000;

        std::vector<RC::Unreal::UObject*> found{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("TheMetaGameInstance_C"), found);
        std::vector<RC::Unreal::UObject*> alt{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("GTheMetaGameInstance"), alt);
        append_unique_objects(found, alt);

        auto* cls = resolve_class_cached(
            meta_game_instance_class_,
            {STR("/Script/GameSkillsTrainer.GTheMetaGameInstance"),
             STR("/Script/GameSkillsTrainer.TheMetaGameInstance_C"),
             STR("/Script/GameSkillsTrainer.GTheMetaGameInstance_C")}
        );
        if (cls && is_likely_valid_object_ptr(cls)) {
            std::vector<RC::Unreal::UObject*> by_class{};
            collect_objects_by_class(cls, by_class);
            append_unique_objects(found, by_class);
        }

        RC::Unreal::UObject* best = nullptr;
        int best_score = -1000000;
        for (auto* obj : found) {
            if (!obj || !is_likely_valid_object_ptr(obj)) {
                continue;
            }
            const auto full_name = obj->GetFullName();
            if (is_rejected_runtime_object_name(full_name)) {
                continue;
            }
            int score = 0;
            if (full_name.find(STR("/Engine/Transient.GameEngine_")) != RC::StringType::npos) score += 200;
            if (full_name.find(STR(":TheMetaGameInstance_C_")) != RC::StringType::npos) score += 300;
            if (score > best_score) {
                best = obj;
                best_score = score;
            }
        }
        if (best && is_likely_valid_object_ptr(best)) {
            meta_game_instance_ = best;
        }
        return meta_game_instance_;
    }

    RC::Unreal::UObject* resolve_state_receiver_instance(uint64_t now) {
        if (state_receiver_instance_ && is_likely_valid_object_ptr(state_receiver_instance_) && now < next_receiver_resolve_ms_) {
            return state_receiver_instance_;
        }
        next_receiver_resolve_ms_ = now + 2000;

        auto* meta = resolve_meta_game_instance(now);
        RC::StringType meta_path{};
        if (meta && is_likely_valid_object_ptr(meta)) {
            meta_path = object_path_from_full_name(meta->GetFullName());
        }

        std::vector<RC::Unreal::UObject*> found{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("PerformanceIndicatorsStateReceiver"), found);
        std::vector<RC::Unreal::UObject*> alt{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("PerformanceIndicatorsStateReceiver_C"), alt);
        append_unique_objects(found, alt);

        auto* cls = resolve_class_cached(
            state_receiver_class_,
            {STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver"),
             STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver_C"),
             STR("/Game/FirstPersonBP/Blueprints/PerformanceIndicatorsStateReceiver.PerformanceIndicatorsStateReceiver_C")}
        );
        if (cls && is_likely_valid_object_ptr(cls)) {
            std::vector<RC::Unreal::UObject*> by_class{};
            collect_objects_by_class(cls, by_class);
            append_unique_objects(found, by_class);
        }

        RC::Unreal::UObject* best = nullptr;
        RC::Unreal::UObject* best_meta_scoped = nullptr;
        int best_score = -1000000;
        int best_meta_scoped_score = -1000000;
        for (auto* obj : found) {
            if (!obj || !is_likely_valid_object_ptr(obj)) {
                continue;
            }
            const auto full_name = obj->GetFullName();
            if (is_rejected_runtime_object_name(full_name)) {
                continue;
            }
            const auto object_path = object_path_from_full_name(full_name);
            int score = 0;
            if (full_name.find(STR("/Engine/Transient.GameEngine_")) != RC::StringType::npos) score += 200;
            if (full_name.find(STR("/Engine/Transient.")) != RC::StringType::npos) score += 60;
            if (full_name.find(STR("TheMetaGameInstance")) != RC::StringType::npos) score += 200;
            if (full_name.find(STR("PerformanceIndicatorsStateReceiver_")) != RC::StringType::npos) score += 120;
            if (score > best_score) {
                best = obj;
                best_score = score;
            }
            if (!meta_path.empty()) {
                RC::StringType prefix = meta_path;
                prefix += STR(".");
                if (object_path.rfind(prefix, 0) == 0 && score > best_meta_scoped_score) {
                    best_meta_scoped = obj;
                    best_meta_scoped_score = score;
                }
            }
        }
        auto* chosen = best_meta_scoped ? best_meta_scoped : best;
        if (chosen && is_likely_valid_object_ptr(chosen)) {
            state_receiver_instance_ = chosen;
        }
        return state_receiver_instance_;
    }

    RC::Unreal::UObject* resolve_scenario_manager_instance(uint64_t now) {
        if (scenario_manager_instance_ && is_likely_valid_object_ptr(scenario_manager_instance_) && now < next_scenario_resolve_ms_) {
            return scenario_manager_instance_;
        }
        next_scenario_resolve_ms_ = now + 1000;

        auto* meta = resolve_meta_game_instance(now);
        RC::StringType meta_path{};
        if (meta && is_likely_valid_object_ptr(meta)) {
            meta_path = object_path_from_full_name(meta->GetFullName());
        }

        std::vector<RC::Unreal::UObject*> all{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("ScenarioManager"), all);
        std::vector<RC::Unreal::UObject*> alt{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("ScenarioManager_C"), alt);
        append_unique_objects(all, alt);

        auto* cls = resolve_class_cached(
            scenario_manager_class_,
            {STR("/Script/GameSkillsTrainer.ScenarioManager"),
             STR("/Script/GameSkillsTrainer.ScenarioManager_C")}
        );
        if (cls && is_likely_valid_object_ptr(cls)) {
            std::vector<RC::Unreal::UObject*> by_class{};
            collect_objects_by_class(cls, by_class);
            append_unique_objects(all, by_class);
        }

        RC::Unreal::UObject* best = nullptr;
        RC::Unreal::UObject* best_meta_scoped = nullptr;
        int best_score = -1000000;
        int best_meta_scoped_score = -1000000;
        for (auto* obj : all) {
            if (!obj || !is_likely_valid_object_ptr(obj)) {
                continue;
            }
            const auto full_name = obj->GetFullName();
            if (is_rejected_runtime_object_name(full_name)) {
                continue;
            }
            const auto object_path = object_path_from_full_name(full_name);
            int score = 0;
            if (full_name.find(STR("/Engine/Transient.GameEngine_")) != RC::StringType::npos) score += 180;
            if (full_name.find(STR("/Engine/Transient.")) != RC::StringType::npos) score += 40;
            if (full_name.find(STR("TheMetaGameInstance")) != RC::StringType::npos) score += 220;
            if (full_name.find(STR("ScenarioManager_")) != RC::StringType::npos) score += 120;
            if (score > best_score) {
                best = obj;
                best_score = score;
            }
            if (!meta_path.empty()) {
                RC::StringType prefix = meta_path;
                prefix += STR(".");
                if (object_path.rfind(prefix, 0) == 0 && score > best_meta_scoped_score) {
                    best_meta_scoped = obj;
                    best_meta_scoped_score = score;
                }
            }
        }
        auto* chosen = best_meta_scoped ? best_meta_scoped : best;
        if (chosen && is_likely_valid_object_ptr(chosen)) {
            scenario_manager_instance_ = chosen;
        }
        return scenario_manager_instance_;
    }

    RC::Unreal::FTextProperty* resolve_textblock_text_property(RC::Unreal::UObject* text_block) {
        if (!text_block || !is_likely_valid_object_ptr(text_block)) {
            return nullptr;
        }
        auto* text_block_class = *reinterpret_cast<RC::Unreal::UClass**>(
            reinterpret_cast<uint8_t*>(text_block) + 0x10
        );
        if (!text_block_class || !is_likely_valid_object_ptr(text_block_class)) {
            return nullptr;
        }
        const auto cached_it = text_property_cache_.find(text_block_class);
        if (cached_it != text_property_cache_.end()) {
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
        text_property_cache_[text_block_class] = found;
        return found;
    }

    bool read_textblock_text_value(RC::Unreal::UObject* text_block, RC::StringType& out_value) {
        out_value.clear();
        if (!text_block || !is_likely_valid_object_ptr(text_block)) {
            return false;
        }
        if (!text_get_fn_ || !is_likely_valid_object_ptr(text_get_fn_)) {
            text_get_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
                nullptr,
                nullptr,
                STR("/Script/UMG.TextBlock:GetText")
            );
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

        if (text_get_fn_ && is_likely_valid_object_ptr(text_get_fn_)) {
            struct TextBlockGetTextParams {
                RC::Unreal::FText ReturnValue;
            } params{};
            text_block->ProcessEvent(text_get_fn_, &params);
            out_value = params.ReturnValue.ToString();
            return !out_value.empty();
        }
        return false;
    }

    void apply_ui_text_field(const char* ui_field, const RC::StringType& text_value) {
        if (!ui_field || text_value.empty()) {
            return;
        }
        std::lock_guard<std::mutex> guard(ui_mutex_);
        float parsed_f32 = 0.0f;
        int32_t parsed_i32 = 0;

        if (std::strcmp(ui_field, "session_shots") == 0) {
            if (try_parse_int_text(text_value, parsed_i32)) {
                ui_live_snapshot_.shots_fired = parsed_i32;
                ui_live_updated_ = true;
            }
            return;
        }
        if (std::strcmp(ui_field, "session_hits") == 0) {
            if (try_parse_int_text(text_value, parsed_i32)) {
                ui_live_snapshot_.shots_hit = parsed_i32;
                ui_live_updated_ = true;
            }
            return;
        }
        if (std::strcmp(ui_field, "session_kills") == 0) {
            if (try_parse_int_text(text_value, parsed_i32)) {
                ui_live_snapshot_.kills = parsed_i32;
                ui_live_updated_ = true;
            }
            return;
        }
        if (std::strcmp(ui_field, "scenario_name") == 0) {
            const auto scenario = trim_ascii_token(text_value);
            if (looks_like_real_scenario_name(scenario)) {
                ui_live_snapshot_.scenario_name = scenario;
                ui_live_updated_ = true;
            }
            return;
        }
        if (std::strcmp(ui_field, "session_time") == 0) {
            if (try_parse_time_to_seconds(text_value, parsed_f32)) {
                ui_live_snapshot_.seconds = parsed_f32;
                ui_live_updated_ = true;
            }
            return;
        }
        if (std::strcmp(ui_field, "session_spm") == 0) {
            if (try_parse_float_text(text_value, parsed_f32)) {
                ui_live_snapshot_.score_per_minute = parsed_f32;
                ui_live_updated_ = true;
            }
            return;
        }
        if (std::strcmp(ui_field, "session_score") == 0) {
            if (try_parse_float_text(text_value, parsed_f32)) {
                ui_live_snapshot_.score_total = parsed_f32;
                ui_live_updated_ = true;
            }
            return;
        }
        if (std::strcmp(ui_field, "session_kps") == 0) {
            if (try_parse_float_text(text_value, parsed_f32)) {
                ui_live_snapshot_.kills_per_second = parsed_f32;
                ui_live_updated_ = true;
            }
            return;
        }
        if (std::strcmp(ui_field, "session_damage_done") == 0) {
            if (try_parse_float_text(text_value, parsed_f32)) {
                ui_live_snapshot_.damage_done = parsed_f32;
                ui_live_updated_ = true;
            }
            return;
        }
        if (std::strcmp(ui_field, "session_damage_possible") == 0) {
            if (try_parse_float_text(text_value, parsed_f32)) {
                ui_live_snapshot_.damage_possible = parsed_f32;
                ui_live_updated_ = true;
            }
            return;
        }
        if (std::strcmp(ui_field, "session_damage_eff") == 0) {
            if (try_parse_float_text(text_value, parsed_f32)) {
                ui_live_snapshot_.damage_efficiency = parsed_f32;
                ui_live_updated_ = true;
            }
            return;
        }
        if (std::strcmp(ui_field, "session_avg_ttk") == 0) {
            if (try_parse_float_text(text_value, parsed_f32)) {
                ui_live_snapshot_.avg_ttk = parsed_f32;
                ui_live_updated_ = true;
            }
            return;
        }
    }

    void register_text_set_hook() {
        if (text_set_hook_registered_) {
            return;
        }
        text_set_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Script/UMG.TextBlock:SetText")
        );
        if (!text_set_fn_ || !is_likely_valid_object_ptr(text_set_fn_)) {
            kovaaks::RustBridge::emit_json("{\"ev\":\"ui_textupdate_hook\",\"enabled\":0}");
            return;
        }
        text_get_fn_ = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(
            nullptr,
            nullptr,
            STR("/Script/UMG.TextBlock:GetText")
        );

        text_set_hook_id_ = text_set_fn_->RegisterPostHook(
            [](RC::Unreal::UnrealScriptFunctionCallableContext& call_ctx, void* custom_data) {
                auto* self = reinterpret_cast<KovaaksBridgeModProduction*>(custom_data);
                if (!self || !self->rust_ready_ || self->updates_disabled_) {
                    return;
                }
                self->handle_text_set_hook(call_ctx);
            },
            this
        );
        text_set_hook_registered_ = true;
        kovaaks::RustBridge::emit_json("{\"ev\":\"ui_textupdate_hook\",\"enabled\":1}");
    }

    void handle_text_set_hook(RC::Unreal::UnrealScriptFunctionCallableContext& call_ctx) {
#if defined(_MSC_VER)
        __try {
            handle_text_set_hook_impl(call_ctx);
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            return;
        }
#else
        handle_text_set_hook_impl(call_ctx);
#endif
    }

    void handle_text_set_hook_impl(RC::Unreal::UnrealScriptFunctionCallableContext& call_ctx) {
        if (!call_ctx.Context || !is_likely_valid_object_ptr(call_ctx.Context)) {
            return;
        }

        const auto ctx_name = call_ctx.Context->GetFullName();
        const auto* ui_field = classify_session_ui_field(ctx_name);
        if (!ui_field) {
            return;
        }

        RC::StringType text_value{};
        if (!read_textblock_text_value(call_ctx.Context, text_value) || text_value.empty()) {
            return;
        }
        apply_ui_text_field(ui_field, text_value);
    }

    bool copy_live_ui_snapshot(UiSnapshot& out) {
        std::lock_guard<std::mutex> guard(ui_mutex_);
        if (!ui_live_updated_) {
            return false;
        }
        out = ui_live_snapshot_;
        return true;
    }

    void emit_state_i32(const char* ev, int32_t& last_value, int32_t value) {
        if (value != 0 && value != 1) {
            return;
        }
        if (last_value == value) {
            return;
        }
        last_value = value;
        std::array<char, 256> json{};
        std::snprintf(
            json.data(),
            json.size(),
            "{\"ev\":\"%s\",\"value\":%d,\"method\":\"%s\",\"origin_flag\":\"%s\",\"source\":\"production_stripped\"}",
            ev,
            value,
            emit_method_ ? emit_method_ : "unknown",
            emit_origin_flag_ ? emit_origin_flag_ : "unknown"
        );
        kovaaks::RustBridge::emit_json(json.data());
    }

    void emit_pull_i32(const char* ev, int32_t& last_value, int32_t value, uint64_t& last_nonzero_ms, uint64_t now) {
        if (value < 0) {
            return;
        }
        if (value == 0 && last_nonzero_ms == 0) {
            return;
        }
        constexpr uint64_t k_zero_suppress_ms = 2500;
        if (value == 0 && last_value > 0 && (now - last_nonzero_ms) < k_zero_suppress_ms) {
            return;
        }
        if (value > 0) {
            last_nonzero_ms = now;
        }
        if (last_value == value) {
            return;
        }
        const int32_t prev = last_value;
        last_value = value;
        std::array<char, 320> json{};
        std::snprintf(
            json.data(),
            json.size(),
            "{\"ev\":\"%s\",\"value\":%d,\"method\":\"%s\",\"origin_flag\":\"%s\",\"source\":\"production_stripped\"}",
            ev,
            value,
            emit_method_ ? emit_method_ : "unknown",
            emit_origin_flag_ ? emit_origin_flag_ : "unknown"
        );
        kovaaks::RustBridge::emit_json(json.data());

        if (prev >= 0 && value > prev) {
            const int32_t delta = value - prev;
            const char* alias_ev = nullptr;
            if (std::strcmp(ev, "pull_shots_fired_total") == 0) {
                alias_ev = "shot_fired";
            } else if (std::strcmp(ev, "pull_shots_hit_total") == 0) {
                alias_ev = "shot_hit";
            } else if (std::strcmp(ev, "pull_kills_total") == 0) {
                alias_ev = "kill";
            }
            if (alias_ev) {
                std::array<char, 192> alias_json{};
                std::snprintf(
                    alias_json.data(),
                    alias_json.size(),
                    "{\"ev\":\"%s\",\"delta\":%d,\"total\":%d,\"source\":\"pull\"}",
                    alias_ev,
                    delta,
                    value
                );
                kovaaks::RustBridge::emit_json(alias_json.data());
            }
        }
    }

    void emit_pull_f32(const char* ev, float& last_value, float value, uint64_t& last_nonzero_ms, uint64_t now) {
        if (!std::isfinite(value) || value < 0.0f) {
            return;
        }
        const bool is_qrem = (std::strcmp(ev, "pull_queue_time_remaining") == 0);
        if (value == 0.0f && last_nonzero_ms == 0 && !is_qrem) {
            return;
        }
        constexpr uint64_t k_zero_suppress_ms = 2500;
        if (value == 0.0f && std::isfinite(last_value) && last_value > 0.0f
            && (now - last_nonzero_ms) < k_zero_suppress_ms && !is_qrem) {
            return;
        }
        if (value > 0.0f) {
            last_nonzero_ms = now;
        }
        if (std::isfinite(last_value) && std::fabs(static_cast<double>(last_value) - static_cast<double>(value)) <= 0.0001) {
            return;
        }
        last_value = value;
        std::array<char, 352> json{};
        std::snprintf(
            json.data(),
            json.size(),
            "{\"ev\":\"%s\",\"value\":%.6f,\"method\":\"%s\",\"origin_flag\":\"%s\",\"source\":\"production_stripped\"}",
            ev,
            static_cast<double>(value),
            emit_method_ ? emit_method_ : "unknown",
            emit_origin_flag_ ? emit_origin_flag_ : "unknown"
        );
        kovaaks::RustBridge::emit_json(json.data());
    }
};

extern "C" __declspec(dllexport) RC::CppUserModBase* start_mod() {
    return new KovaaksBridgeModProduction();
}

extern "C" __declspec(dllexport) void uninstall_mod(RC::CppUserModBase* mod) {
    delete mod;
}
