#include <DynamicOutput/Output.hpp>
#include <Mod/CppUserModBase.hpp>
#include <Unreal/Hooks.hpp>
#include <Unreal/FText.hpp>
#include <Unreal/FProperty.hpp>
#include <Unreal/Property/FBoolProperty.hpp>
#include <Unreal/Property/FNumericProperty.hpp>
#include <Unreal/Property/FObjectProperty.hpp>
#include <Unreal/Property/FStructProperty.hpp>
#include <Unreal/Property/FTextProperty.hpp>
#include <Unreal/UClass.hpp>
#include <Unreal/UFunction.hpp>
#include <Unreal/UObject.hpp>
#include <Unreal/UObjectGlobals.hpp>
#include <Unreal/UScriptStruct.hpp>

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
#include <mutex>
#include <string>
#include <utility>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#ifdef TEXT
#undef TEXT
#endif
#include <windows.h>

#include "rust_bridge.hpp"

namespace {

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

void trace_line(const char* line) {
    static std::mutex s_trace_mutex;
    std::lock_guard<std::mutex> lock(s_trace_mutex);

    const std::wstring path = game_bin_dir() + L"KovaaksBridgeMod.trace.log";
    std::ofstream out(std::filesystem::path(path), std::ios::app);
    if (!out.is_open()) {
        return;
    }
    out << line << "\n";
}

void runtime_log_line(const char* line) {
    static std::mutex s_runtime_log_mutex;
    std::lock_guard<std::mutex> lock(s_runtime_log_mutex);

    const std::wstring path = game_bin_dir() + L"KovaaksBridgeMod.runtime.log";
    std::ofstream out(std::filesystem::path(path), std::ios::app);
    if (!out.is_open()) {
        return;
    }
    out << line << "\n";
}

void events_log_line(const char* line) {
    static std::mutex s_events_log_mutex;
    std::lock_guard<std::mutex> lock(s_events_log_mutex);

    const std::wstring path = game_bin_dir() + L"KovaaksBridgeMod.events.log";
    std::ofstream out(std::filesystem::path(path), std::ios::app);
    if (!out.is_open()) {
        return;
    }
    out << line << "\n";
}

bool env_flag_enabled(const char* name) {
    char value[16] = {};
    const auto len = GetEnvironmentVariableA(name, value, static_cast<DWORD>(sizeof(value)));
    if (len == 0 || len >= sizeof(value)) {
        return false;
    }
    return value[0] == '1' || value[0] == 'y' || value[0] == 'Y' || value[0] == 't' || value[0] == 'T';
}

bool file_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_discovery.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool disable_pe_hook_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_disable_pe_hook.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool enable_pe_hook_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_enable_pe_hook.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool payload_profile_is_full() {
    const std::wstring path = game_bin_dir() + L".kovaaks_overlay_profile";
    std::ifstream in{std::filesystem::path(path)};
    if (!in.is_open()) {
        return false;
    }
    std::string value;
    std::getline(in, value);
    for (char& c : value) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }
    return value == "full";
}

bool safe_mode_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_safe_mode.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool no_rust_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_no_rust.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool log_all_events_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_log_all_events.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool object_debug_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_object_debug.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool non_ui_probe_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_non_ui_probe.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool ui_counter_fallback_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_ui_counter_fallback.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool score_ui_fallback_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_score_ui_fallback.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool process_internal_script_hook_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_hook_process_internal.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool process_local_script_hook_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_hook_process_local_script.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool process_event_detour_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_hook_process_event.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool ui_settext_hook_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_ui_settext_hook.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool native_hooks_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_native_hooks.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool unsafe_hooks_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_allow_unsafe_hooks.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool class_probe_hooks_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_class_probe_hooks.flag";
    return std::filesystem::exists(std::filesystem::path(path));
}

bool consume_reload_flags_request() {
    const std::wstring path = game_bin_dir() + L"kovaaks_reload_flags.flag";
    const auto fs_path = std::filesystem::path(path);
    if (!std::filesystem::exists(fs_path)) {
        return false;
    }
    std::error_code ec;
    std::filesystem::remove(fs_path, ec);
    return true;
}

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
    std::string out(static_cast<size_t>(required), '\0');
    const int written = WideCharToMultiByte(
        CP_UTF8,
        0,
        input.c_str(),
        static_cast<int>(input.size()),
        out.data(),
        required,
        nullptr,
        nullptr
    );
    if (written <= 0) {
        return {};
    }
    out.resize(static_cast<size_t>(written));
    return out;
}

std::string escape_json(const std::string& input) {
    std::string out;
    out.reserve(input.size() + 16);
    for (unsigned char c : input) {
        switch (c) {
        case '\"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (c < 0x20) {
                char buf[8] = {};
                std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned int>(c));
                out += buf;
            } else {
                out.push_back(static_cast<char>(c));
            }
            break;
        }
    }
    return out;
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

std::wstring current_module_path() {
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(&current_module_path),
            &module
        ) || module == nullptr) {
        return L"<unknown>";
    }
    wchar_t buffer[MAX_PATH] = {};
    const auto len = GetModuleFileNameW(module, buffer, MAX_PATH);
    if (len == 0) {
        return L"<unknown>";
    }
    return std::wstring(buffer, len);
}

} // namespace

class KovaaksBridgeMod final : public RC::CppUserModBase {
public:
    KovaaksBridgeMod(const KovaaksBridgeMod&) = delete;
    KovaaksBridgeMod& operator=(const KovaaksBridgeMod&) = delete;

    KovaaksBridgeMod() {
        ModName = STR("KovaaksBridgeMod");
        ModVersion = STR("0.1.0");
        ModDescription = STR("UE4SS mod shim that forwards events to Rust core.");
        ModAuthors = STR("veryCrunchy");

        trace_line("ctor: enter");
        runtime_log_line("[KovaaksBridgeMod] ctor: enter");
        const auto module_path = current_module_path();
        RC::Output::send<RC::LogLevel::Warning>(
            STR("[KovaaksBridgeMod] module path: {}\n"),
            RC::StringType(module_path.c_str())
        );
        {
            std::array<char, 512> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "[KovaaksBridgeMod] module path: %ls",
                module_path.c_str()
            );
            runtime_log_line(buf.data());
        }
        const auto previous = s_live_instances.fetch_add(1, std::memory_order_acq_rel);
        if (previous == 0) {
            s_rust_enabled = !no_rust_flag_enabled();
            if (!s_rust_enabled) {
                RC::Output::send<RC::LogLevel::Warning>(
                    STR("[KovaaksBridgeMod] Rust bridge disabled by kovaaks_no_rust.flag\n")
                );
                trace_line("ctor: rust bridge disabled by flag");
                runtime_log_line("[KovaaksBridgeMod] Rust bridge disabled by kovaaks_no_rust.flag");
            } else if (kovaaks::RustBridge::startup()) {
                kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_mod_loaded\"}");
                RC::Output::send<RC::LogLevel::Warning>(STR("[KovaaksBridgeMod] Rust bridge loaded.\n"));
                trace_line("ctor: rust bridge startup ok");
                runtime_log_line("[KovaaksBridgeMod] Rust bridge startup ok");
            } else {
                RC::Output::send<RC::LogLevel::Error>(
                    STR("[KovaaksBridgeMod] Failed to load Rust bridge DLL. path={} win32_error={}\n"),
                    RC::StringType(kovaaks::RustBridge::last_dll_path()),
                    kovaaks::RustBridge::last_win32_error()
                );
                std::array<char, 256> buf{};
                std::snprintf(
                    buf.data(),
                    buf.size(),
                    "ctor: rust bridge startup failed err=%u",
                    kovaaks::RustBridge::last_win32_error()
                );
                trace_line(buf.data());
                {
                    std::array<char, 256> rbuf{};
                    std::snprintf(
                        rbuf.data(),
                        rbuf.size(),
                        "[KovaaksBridgeMod] Rust bridge startup failed err=%u",
                        kovaaks::RustBridge::last_win32_error()
                    );
                    runtime_log_line(rbuf.data());
                }
            }
        } else {
            RC::Output::send<RC::LogLevel::Warning>(
                STR("[KovaaksBridgeMod] duplicate mod instance detected (count={})\n"),
                previous + 1
            );
            std::array<char, 96> buf{};
            std::snprintf(buf.data(), buf.size(), "ctor: duplicate instance count=%u", previous + 1);
            trace_line(buf.data());
            {
                std::array<char, 256> rbuf{};
                std::snprintf(
                    rbuf.data(),
                    rbuf.size(),
                    "[KovaaksBridgeMod] duplicate mod instance detected (count=%u)",
                    previous + 1
                );
                runtime_log_line(rbuf.data());
            }
        }
        trace_line("ctor: exit");
        runtime_log_line("[KovaaksBridgeMod] ctor: exit");
    }

    ~KovaaksBridgeMod() override {
        trace_line("dtor: enter");
        const auto previous = s_live_instances.fetch_sub(1, std::memory_order_acq_rel);
        const auto remaining = previous > 0 ? previous - 1 : 0;
        if (remaining == 0) {
            for (const auto& binding : s_native_hook_bindings) {
                if (binding.first) {
                    binding.first->UnregisterHook(binding.second);
                }
            }
            s_native_hook_bindings.clear();
            if (s_rust_enabled) {
                kovaaks::RustBridge::shutdown();
            }
            s_hook_registered.store(false, std::memory_order_release);
            s_native_hooks_registered.store(false, std::memory_order_release);
            s_process_internal_callbacks_registered.store(false, std::memory_order_release);
            s_process_local_script_callbacks_registered.store(false, std::memory_order_release);
            s_process_event_detour_installed.store(false, std::memory_order_release);
            s_process_internal_detour_installed.store(false, std::memory_order_release);
            s_process_local_script_detour_installed.store(false, std::memory_order_release);
        }
        trace_line("dtor: exit");
    }

    auto on_unreal_init() -> void override {
        using namespace RC::Unreal;

        trace_line("on_unreal_init: enter");
        runtime_log_line("[KovaaksBridgeMod] on_unreal_init: enter");
        refresh_runtime_flags(true);
        if (s_log_all_events) {
            events_log_line("[init] log_all_events enabled");
        }
        if (s_safe_mode_enabled) {
            RC::Output::send<RC::LogLevel::Warning>(
                STR("[KovaaksBridgeMod] SAFE MODE enabled (no target resolve, no ProcessEvent hook).\n")
            );
            kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_safe_mode\",\"enabled\":true}");
            runtime_log_line("[KovaaksBridgeMod] SAFE MODE enabled");
            return;
        }

        if (s_discovery_enabled) {
            RC::Output::send<RC::LogLevel::Warning>(
                STR("[KovaaksBridgeMod] global discovery mode enabled (diagnostic only).\n")
            );
            trace_line("on_unreal_init: discovery enabled");
        }
        kovaaks::RustBridge::emit_json(s_discovery_enabled
                                           ? "{\"ev\":\"ue4ss_discovery_mode\",\"enabled\":true}"
                                           : "{\"ev\":\"ue4ss_discovery_mode\",\"enabled\":false}");
        RC::Output::send<RC::LogLevel::Warning>(
            STR("[KovaaksBridgeMod] pe flags: enable={} disable={} profile_full={} discovery={} safe_mode={} log_all={} object_debug={} non_ui_probe={} allow_unsafe_hooks={}\n"),
            s_pe_enabled_by_flag ? 1 : 0,
            s_pe_disabled_by_flag ? 1 : 0,
            s_profile_full ? 1 : 0,
            s_discovery_enabled ? 1 : 0,
            s_safe_mode_enabled ? 1 : 0,
            s_log_all_events ? 1 : 0,
            s_object_debug_enabled ? 1 : 0,
            s_non_ui_probe_enabled ? 1 : 0,
            s_allow_unsafe_hooks ? 1 : 0
        );
        {
            std::array<char, 384> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "[KovaaksBridgeMod] flags: enable_pe_hook=%u disable_pe_hook=%u profile_full=%u discovery=%u safe_mode=%u no_rust=%u log_all=%u object_debug=%u non_ui_probe=%u allow_unsafe_hooks=%u",
                s_pe_enabled_by_flag ? 1 : 0,
                s_pe_disabled_by_flag ? 1 : 0,
                s_profile_full ? 1 : 0,
                s_discovery_enabled ? 1 : 0,
                s_safe_mode_enabled ? 1 : 0,
                no_rust_flag_enabled() ? 1 : 0,
                s_log_all_events ? 1 : 0,
                s_object_debug_enabled ? 1 : 0,
                s_non_ui_probe_enabled ? 1 : 0,
                s_allow_unsafe_hooks ? 1 : 0
            );
            runtime_log_line(buf.data());
        }

        // Always resolve targets once so direct-pull diagnostics can still function
        // even when ProcessEvent hooks are intentionally disabled.
        resolve_targets();
        {
            std::array<char, 192> rbuf{};
            std::snprintf(
                rbuf.data(),
                rbuf.size(),
                "[KovaaksBridgeMod] target resolve complete (count=%u) before PE gating",
                s_resolved_target_count
            );
            runtime_log_line(rbuf.data());
        }

        if (!s_pe_events_enabled) {
            RC::Output::send<RC::LogLevel::Warning>(
                STR("[KovaaksBridgeMod] ProcessEvent hook disabled. Create kovaaks_enable_pe_hook.flag to enable.\n")
            );
            kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_pe_hook\",\"enabled\":false}");
            {
                std::array<char, 256> rbuf{};
                std::snprintf(
                    rbuf.data(),
                    rbuf.size(),
                    "[KovaaksBridgeMod] ProcessEvent hook disabled (enable=%u disable=%u safe_mode=%u profile_full=%u)",
                    s_pe_enabled_by_flag ? 1 : 0,
                    s_pe_disabled_by_flag ? 1 : 0,
                    s_safe_mode_enabled ? 1 : 0,
                    s_profile_full ? 1 : 0
                );
                runtime_log_line(rbuf.data());
            }
            return;
        }

        const bool enable_process_event_detour =
            env_flag_enabled("KOVAAKS_HOOK_PROCESS_EVENT")
            || process_event_detour_flag_enabled();
        if (enable_process_event_detour) {
            // Explicitly install the UE4SS ProcessEvent detour once.
            const bool detour_already_installed =
                s_process_event_detour_installed.exchange(true, std::memory_order_acq_rel);
            if (!detour_already_installed) {
                HookProcessEvent();
                RC::Output::send<RC::LogLevel::Warning>(
                    STR("[KovaaksBridgeMod] HookProcessEvent detour requested.\n")
                );
                runtime_log_line("[KovaaksBridgeMod] HookProcessEvent detour requested");
            }
        } else {
            runtime_log_line("[KovaaksBridgeMod] HookProcessEvent detour disabled (opt-in)");
        }
        if (s_enable_process_internal_script_hook) {
            const bool process_internal_detour_already_installed =
                s_process_internal_detour_installed.exchange(true, std::memory_order_acq_rel);
            if (!process_internal_detour_already_installed) {
                HookProcessInternal();
                RC::Output::send<RC::LogLevel::Warning>(
                    STR("[KovaaksBridgeMod] HookProcessInternal detour requested.\n")
                );
                runtime_log_line("[KovaaksBridgeMod] HookProcessInternal detour requested");
            }
        } else {
            runtime_log_line("[KovaaksBridgeMod] ProcessInternal script hook disabled (opt-in)");
        }
        if (s_enable_process_local_script_hook) {
            const bool process_local_script_detour_already_installed =
                s_process_local_script_detour_installed.exchange(true, std::memory_order_acq_rel);
            if (!process_local_script_detour_already_installed) {
                HookProcessLocalScriptFunction();
                RC::Output::send<RC::LogLevel::Warning>(
                    STR("[KovaaksBridgeMod] HookProcessLocalScriptFunction detour requested.\n")
                );
                runtime_log_line("[KovaaksBridgeMod] HookProcessLocalScriptFunction detour requested");
            }
        } else {
            runtime_log_line("[KovaaksBridgeMod] ProcessLocalScriptFunction hook disabled (opt-in)");
        }

        const bool native_hooks_requested =
            env_flag_enabled("KOVAAKS_NATIVE_HOOKS")
            || native_hooks_flag_enabled();
        const bool enable_native_hooks = native_hooks_requested && s_allow_unsafe_hooks;
        if (enable_native_hooks) {
            register_native_u_function_hooks();
            kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_native_hooks\",\"enabled\":true}");
        } else {
            if (native_hooks_requested && !s_allow_unsafe_hooks) {
                runtime_log_line("[KovaaksBridgeMod] native UFunction hooks requested but blocked (set kovaaks_allow_unsafe_hooks.flag)");
                kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_native_hooks\",\"enabled\":false,\"blocked\":1}");
            } else {
                kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_native_hooks\",\"enabled\":false}");
            }
            runtime_log_line("[KovaaksBridgeMod] native UFunction hooks disabled (opt-in)");
        }
        if (enable_process_event_detour) {
            const bool already_hooked = s_hook_registered.exchange(true, std::memory_order_acq_rel);
            if (!already_hooked) {
                Hook::RegisterProcessEventPreCallback(&process_event_pre_hook);
                Hook::RegisterProcessEventPostCallback(&process_event_post_hook);
                kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_pe_hook\",\"enabled\":true}");
                runtime_log_line("[KovaaksBridgeMod] ProcessEvent pre/post callbacks registered");
            } else {
                RC::Output::send<RC::LogLevel::Warning>(
                    STR("[KovaaksBridgeMod] skipping duplicate ProcessEvent hook registration.\n")
                );
                trace_line("on_unreal_init: duplicate hook registration skipped");
            }
        } else {
            kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_pe_hook\",\"enabled\":false}");
            runtime_log_line("[KovaaksBridgeMod] ProcessEvent pre/post callbacks skipped (detour opt-in)");
        }
        if (s_enable_process_internal_script_hook) {
            const bool process_internal_callbacks_already_registered =
                s_process_internal_callbacks_registered.exchange(true, std::memory_order_acq_rel);
            if (!process_internal_callbacks_already_registered) {
                Hook::RegisterProcessInternalPostCallback(&process_internal_post_hook);
                runtime_log_line("[KovaaksBridgeMod] ProcessInternal post callback registered");
                kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_process_internal_hook\",\"enabled\":true}");
            }
        } else {
            kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_process_internal_hook\",\"enabled\":false}");
        }
        if (s_enable_process_local_script_hook) {
            const bool process_local_script_callbacks_already_registered =
                s_process_local_script_callbacks_registered.exchange(true, std::memory_order_acq_rel);
            if (!process_local_script_callbacks_already_registered) {
                Hook::RegisterProcessLocalScriptFunctionPostCallback(&process_local_script_post_hook);
                runtime_log_line("[KovaaksBridgeMod] ProcessLocalScriptFunction post callback registered");
                kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_process_local_script_hook\",\"enabled\":true}");
            }
        } else {
            kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_process_local_script_hook\",\"enabled\":false}");
        }

        std::array<char, 128> msg{};
        std::snprintf(
            msg.data(),
            msg.size(),
            "{\"ev\":\"ue4ss_hooks_ready\",\"targets\":%u}",
            s_resolved_target_count
        );
        kovaaks::RustBridge::emit_json(msg.data());

        RC::Output::send<RC::LogLevel::Warning>(
            STR("[KovaaksBridgeMod] bridge initialized ({} targets).\n"),
            s_resolved_target_count
        );
        std::array<char, 128> buf{};
        std::snprintf(buf.data(), buf.size(), "on_unreal_init: hook installed targets=%u", s_resolved_target_count);
        trace_line(buf.data());
        {
            std::array<char, 160> rbuf{};
            std::snprintf(
                rbuf.data(),
                rbuf.size(),
                "[KovaaksBridgeMod] bridge initialized targets=%u",
                s_resolved_target_count
            );
            runtime_log_line(rbuf.data());
        }
    }

    auto on_ui_init() -> void override {}
    auto on_update() -> void override {
        refresh_runtime_flags(false);
        if (s_non_ui_probe_enabled || s_log_all_events || s_object_debug_enabled) {
            poll_state_receiver_values();
        }
        if (!s_log_all_events && !s_object_debug_enabled && !s_non_ui_probe_enabled) {
            return;
        }
        const auto now = GetTickCount64();
        const auto prev = s_last_events_heartbeat_ms.load(std::memory_order_relaxed);
        if (prev == 0 || (now - prev) >= 2000) {
            s_last_events_heartbeat_ms.store(now, std::memory_order_relaxed);
            events_log_line("[heartbeat] diagnostic probe active");
            std::array<char, 512> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "[hook_stats] pe_cb=%llu pi_cb=%llu pls_cb=%llu script_faults=%llu post_seen=%llu native_hook_calls=%llu class_probe_calls=%llu ui_settext_calls=%llu ui_field_calls=%llu ui_derived_calls=%llu emits_named=%llu emits_i32=%llu emits_f32=%llu emits_simple=%llu derived_alias=%llu recv_score=%llu recv_shots_fired=%llu recv_shots_hit=%llu pull_calls=%llu pull_resolve=%llu pull_emits=%llu pull_err=%llu pull_miss=%llu pull_null_fn=%llu pull_reselect=%llu pull_prop_reads=%llu pull_prop_emits=%llu",
                static_cast<unsigned long long>(s_process_event_callback_count.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_process_internal_callback_count.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_process_local_script_callback_count.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_script_callback_faults.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_process_event_post_seen.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_bound_hook_calls.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_class_probe_hook_calls.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_ui_settext_hook_calls.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_ui_field_update_calls.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_ui_derived_emit_calls.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_emit_named_count.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_emit_i32_count.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_emit_f32_count.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_emit_simple_count.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_derived_alias_emits.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_receive_score_hits.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_receive_shots_fired_hits.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_receive_shots_hit_hits.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_direct_poll_calls.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_direct_poll_resolve_hits.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_direct_poll_value_emits.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_direct_poll_errors.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_direct_poll_resolve_misses.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_direct_poll_null_fn.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_direct_poll_reselects.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_direct_poll_prop_reads.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(s_direct_poll_prop_emits.load(std::memory_order_relaxed))
            );
            events_log_line(buf.data());
        }
    }

private:
    enum class EventKind : uint8_t {
        None = 0,
        Score,
        Kills,
        ShotsHit,
        ShotsFired,
        Seconds,
        DamageDone,
        DamagePossible,
        ChallengeSeconds,
        ChallengeTickCount,
        ShotHit,
        ShotFired,
        ShotMissed,
        Kill,
        ChallengeQueued,
        ChallengeComplete,
        ChallengeCanceled,
        PostChallengeComplete,
        ChallengeStart,
        ChallengeRestart,
        ChallengeQuit,
        ChallengeCompleted,
    };

    enum class PullMetricKind : uint8_t {
        Unknown = 0,
        Score,
        Kills,
        ShotsHit,
        ShotsFired,
        Seconds,
        DamageDone,
        DamagePossible,
        DamageEfficiency,
        ScorePerMinute,
        KillsPerSecond,
        Accuracy,
        KillEfficiency,
        TimeRemaining,
        DistanceTraveled,
        MBS,
        AverageTimeDilationModifier,
        AverageTargetSizeModifier,
    };

    struct ReceiverNumericBinding {
        RC::Unreal::FNumericProperty* property{};
        RC::Unreal::FObjectPropertyBase* owner_object_property{};
        RC::StringType property_name{};
        RC::StringType owner_property_name{};
        PullMetricKind metric{PullMetricKind::Unknown};
        bool is_floating{};
        std::string probe_key{};
        std::string emit_name{};
    };

    static auto event_kind_name(EventKind kind) -> const char* {
        switch (kind) {
        case EventKind::Score: return "score";
        case EventKind::Kills: return "kills";
        case EventKind::ShotsHit: return "shots_hit";
        case EventKind::ShotsFired: return "shots_fired";
        case EventKind::Seconds: return "seconds";
        case EventKind::DamageDone: return "damage_done";
        case EventKind::DamagePossible: return "damage_possible";
        case EventKind::ChallengeSeconds: return "challenge_seconds";
        case EventKind::ChallengeTickCount: return "challenge_tick_count";
        case EventKind::ShotHit: return "shot_hit";
        case EventKind::ShotFired: return "shot_fired";
        case EventKind::ShotMissed: return "shot_missed";
        case EventKind::Kill: return "kill";
        case EventKind::ChallengeQueued: return "challenge_queued";
        case EventKind::ChallengeComplete: return "challenge_complete";
        case EventKind::ChallengeCanceled: return "challenge_canceled";
        case EventKind::PostChallengeComplete: return "post_challenge_complete";
        case EventKind::ChallengeStart: return "challenge_start";
        case EventKind::ChallengeRestart: return "challenge_restart";
        case EventKind::ChallengeQuit: return "challenge_quit";
        case EventKind::ChallengeCompleted: return "challenge_completed";
        case EventKind::None:
        default:
            return "none";
        }
    }

    struct Targets {
        RC::Unreal::UFunction* send_score{};
        RC::Unreal::UFunction* send_random_sens_scale{};
        RC::Unreal::UFunction* send_kills{};
        RC::Unreal::UFunction* send_shots_hit{};
        RC::Unreal::UFunction* send_shots_fired{};
        RC::Unreal::UFunction* send_seconds{};
        RC::Unreal::UFunction* send_damage_done{};
        RC::Unreal::UFunction* send_damage_possible{};
        RC::Unreal::UFunction* send_challenge_seconds{};
        RC::Unreal::UFunction* send_challenge_tick_count{};
        RC::Unreal::UFunction* reset_transient_data{};
        RC::Unreal::UFunction* reset_shots_hit{};
        RC::Unreal::UFunction* reset_shots_fired{};
        RC::Unreal::UFunction* reset_seconds{};
        RC::Unreal::UFunction* reset_score{};
        RC::Unreal::UFunction* reset_random_sens_scale{};
        RC::Unreal::UFunction* reset_kills{};
        RC::Unreal::UFunction* reset_damage_possible{};
        RC::Unreal::UFunction* reset_damage_done{};
        RC::Unreal::UFunction* reset_challenge_tick_count{};
        RC::Unreal::UFunction* reset_challenge_seconds{};
        RC::Unreal::UFunction* job_context_has_completed{};
        RC::Unreal::UFunction* receive_score{};
        RC::Unreal::UFunction* receive_score_single{};
        RC::Unreal::UFunction* receive_score_value_else{};
        RC::Unreal::UFunction* receive_score_value_or{};
        RC::Unreal::UFunction* get_score_value_or{};
        RC::Unreal::UFunction* get_score_value_else{};
        RC::Unreal::UFunction* receive_kills{};
        RC::Unreal::UFunction* get_kills_value_or{};
        RC::Unreal::UFunction* get_kills_value_else{};
        RC::Unreal::UFunction* receive_shots_hit{};
        RC::Unreal::UFunction* receive_shots_fired{};
        RC::Unreal::UFunction* receive_shots_hit_single{};
        RC::Unreal::UFunction* receive_shots_hit_value_else{};
        RC::Unreal::UFunction* get_shots_hit_value_or{};
        RC::Unreal::UFunction* get_shots_hit_value_else{};
        RC::Unreal::UFunction* receive_shots_fired_single{};
        RC::Unreal::UFunction* receive_shots_fired_value_else{};
        RC::Unreal::UFunction* receive_shots_fired_value_or{};
        RC::Unreal::UFunction* get_shots_fired_value_or{};
        RC::Unreal::UFunction* get_shots_fired_value_else{};
        RC::Unreal::UFunction* receive_seconds{};
        RC::Unreal::UFunction* get_seconds_value_or{};
        RC::Unreal::UFunction* get_seconds_value_else{};
        RC::Unreal::UFunction* receive_damage_done{};
        RC::Unreal::UFunction* receive_damage_done_value_else{};
        RC::Unreal::UFunction* get_damage_done_value_or{};
        RC::Unreal::UFunction* get_damage_done_value_else{};
        RC::Unreal::UFunction* receive_damage_possible{};
        RC::Unreal::UFunction* receive_damage_possible_value_else{};
        RC::Unreal::UFunction* get_damage_possible_value_or{};
        RC::Unreal::UFunction* get_damage_possible_value_else{};
        RC::Unreal::UFunction* receive_damage_efficiency{};
        RC::Unreal::UFunction* receive_damage_efficiency_value_else{};
        RC::Unreal::UFunction* get_damage_efficiency_value_or{};
        RC::Unreal::UFunction* get_damage_efficiency_value_else{};
        RC::Unreal::UFunction* receive_score_per_minute{};
        RC::Unreal::UFunction* receive_score_per_minute_value_else{};
        RC::Unreal::UFunction* get_score_per_minute_value_or{};
        RC::Unreal::UFunction* get_score_per_minute_value_else{};
        RC::Unreal::UFunction* receive_accuracy{};
        RC::Unreal::UFunction* receive_accuracy_single{};
        RC::Unreal::UFunction* receive_accuracy_value_else{};
        RC::Unreal::UFunction* receive_accuracy_value_or{};
        RC::Unreal::UFunction* get_accuracy_value_or{};
        RC::Unreal::UFunction* get_accuracy_value_else{};
        RC::Unreal::UFunction* receive_challenge_average_fps{};
        RC::Unreal::UFunction* receive_challenge_average_fps_single{};
        RC::Unreal::UFunction* receive_challenge_average_fps_value_else{};
        RC::Unreal::UFunction* receive_challenge_average_fps_value_or{};
        RC::Unreal::UFunction* get_challenge_average_fps_value_or{};
        RC::Unreal::UFunction* get_challenge_average_fps_value_else{};
        RC::Unreal::UFunction* receive_random_sens_scale{};
        RC::Unreal::UFunction* receive_random_sens_scale_single{};
        RC::Unreal::UFunction* receive_random_sens_scale_value_else{};
        RC::Unreal::UFunction* receive_random_sens_scale_value_or{};
        RC::Unreal::UFunction* get_random_sens_scale_value_or{};
        RC::Unreal::UFunction* get_random_sens_scale_value_else{};
        RC::Unreal::UFunction* receive_kills_per_second{};
        RC::Unreal::UFunction* receive_kills_per_second_value_else{};
        RC::Unreal::UFunction* get_kills_per_second_value_or{};
        RC::Unreal::UFunction* get_kills_per_second_value_else{};
        RC::Unreal::UFunction* receive_challenge_seconds{};
        RC::Unreal::UFunction* receive_challenge_seconds_single{};
        RC::Unreal::UFunction* receive_challenge_seconds_value_else{};
        RC::Unreal::UFunction* receive_challenge_seconds_value_or{};
        RC::Unreal::UFunction* receive_challenge_tick_count{};
        RC::Unreal::UFunction* receive_challenge_tick_count_single{};
        RC::Unreal::UFunction* receive_challenge_tick_count_value_else{};
        RC::Unreal::UFunction* receive_challenge_tick_count_value_or{};
        RC::Unreal::UFunction* get_challenge_seconds_value_or{};
        RC::Unreal::UFunction* get_challenge_seconds_value_else{};
        RC::Unreal::UFunction* get_challenge_tick_count_value_or{};
        RC::Unreal::UFunction* get_challenge_tick_count_value_else{};
        RC::Unreal::UFunction* receive_challenge_score{};
        RC::Unreal::UFunction* receive_challenge_score_single{};
        RC::Unreal::UFunction* receive_challenge_score_value_or{};
        RC::Unreal::UFunction* receive_challenge_score_value_else{};
        RC::Unreal::UFunction* get_challenge_score_value_or{};
        RC::Unreal::UFunction* get_challenge_score_value_else{};
        RC::Unreal::UFunction* stats_calculate_score{};
        RC::Unreal::UFunction* stats_get_last_score{};
        RC::Unreal::UFunction* stats_get_session_best_score{};
        RC::Unreal::UFunction* stats_get_previous_session_best_score{};
        RC::Unreal::UFunction* stats_get_previous_high_score{};
        RC::Unreal::UFunction* stats_get_last_challenge_time_remaining{};
        RC::Unreal::UFunction* scenario_get_challenge_time_elapsed{};
        RC::Unreal::UFunction* scenario_get_challenge_time_remaining_runtime{};
        RC::Unreal::UFunction* scenario_get_realtime_challenge_time_length{};
        RC::Unreal::UFunction* meta_get_sandbox_session_stats{};
        RC::Unreal::UFunction* sandbox_get_challenge_time_in_seconds{};
        RC::Unreal::UFunction* sandbox_get_realtime_challenge_time_length{};

        RC::Unreal::UFunction* send_shot_hit_br{};
        RC::Unreal::UFunction* send_shot_missed_br{};
        RC::Unreal::UFunction* send_shot_fired_br{};
        RC::Unreal::UFunction* send_kill_br{};
        RC::Unreal::UFunction* receive_shot_hit_br{};
        RC::Unreal::UFunction* receive_shot_missed_br{};
        RC::Unreal::UFunction* receive_shot_fired_br{};
        RC::Unreal::UFunction* receive_kill_br{};

        RC::Unreal::UFunction* send_shot_hit_weapon{};
        RC::Unreal::UFunction* send_shot_missed_weapon{};
        RC::Unreal::UFunction* send_shot_fired_weapon{};
        RC::Unreal::UFunction* send_kill_weapon{};
        RC::Unreal::UFunction* receive_shot_hit_weapon{};
        RC::Unreal::UFunction* receive_shot_missed_weapon{};
        RC::Unreal::UFunction* receive_shot_fired_weapon{};
        RC::Unreal::UFunction* receive_kill_weapon{};

        RC::Unreal::UFunction* send_challenge_queued{};
        RC::Unreal::UFunction* send_challenge_complete{};
        RC::Unreal::UFunction* send_challenge_canceled{};
        RC::Unreal::UFunction* send_post_challenge_complete{};

        RC::Unreal::UFunction* on_challenge_started{};
        RC::Unreal::UFunction* on_challenge_restarted{};
        RC::Unreal::UFunction* on_challenge_quit{};
        RC::Unreal::UFunction* on_challenge_completed{};
        RC::Unreal::UFunction* meta_notify_player_fire_weapon{};
        RC::Unreal::UFunction* meta_on_hit_scan{};
        RC::Unreal::UFunction* meta_on_spawn_projectile{};
    };

    static inline Targets s_targets{};
    static inline uint32_t s_resolved_target_count{};
    static inline std::unordered_set<RC::Unreal::UFunction*> s_discovered_fallback_targets{};
    static inline std::unordered_map<RC::Unreal::UFunction*, EventKind> s_cached_event_kind{};
    static inline std::unordered_map<RC::Unreal::UFunction*, RC::Unreal::UClass*> s_cached_owner_class{};
    static inline std::unordered_map<RC::Unreal::UFunction*, uint32_t> s_process_event_counts{};
    static inline std::unordered_map<RC::Unreal::UFunction*, uint32_t> s_unknown_counts{};
    static inline std::unordered_map<RC::Unreal::UFunction*, uint32_t> s_probe_counts{};
    static inline uint32_t s_new_event_logs_emitted{};
    static inline uint32_t s_trace_event_sample{};
    static inline bool s_discovery_enabled{};
    static inline bool s_safe_mode_enabled{};
    static inline bool s_rust_enabled{};
    static inline bool s_profile_full{};
    static inline bool s_pe_enabled_by_flag{};
    static inline bool s_pe_disabled_by_flag{};
    static inline bool s_pe_events_enabled{};
    static inline bool s_log_all_events{};
    static inline bool s_object_debug_enabled{};
    static inline bool s_non_ui_probe_enabled{};
    static inline bool s_ui_counter_fallback_enabled{};
    static inline bool s_score_ui_fallback_enabled{};
    static inline bool s_enable_process_internal_script_hook{};
    static inline bool s_enable_process_local_script_hook{};
    static inline bool s_class_probe_hooks_enabled{};
    static inline bool s_allow_unsafe_hooks{};
    static inline RC::Unreal::UFunction* s_text_get_fn{};
    static inline std::atomic<uint32_t> s_live_instances{0};
    static inline std::atomic<bool> s_hook_registered{false};
    static inline std::atomic<bool> s_native_hooks_registered{false};
    static inline std::atomic<bool> s_process_internal_callbacks_registered{false};
    static inline std::atomic<bool> s_process_local_script_callbacks_registered{false};
    static inline std::atomic<uint32_t> s_flag_refresh_counter{0};
    static inline std::atomic<bool> s_process_event_detour_installed{false};
    static inline std::atomic<bool> s_process_internal_detour_installed{false};
    static inline std::atomic<bool> s_process_local_script_detour_installed{false};
    static inline std::atomic<uint64_t> s_process_event_callback_count{0};
    static inline std::atomic<uint64_t> s_process_internal_callback_count{0};
    static inline std::atomic<uint64_t> s_process_local_script_callback_count{0};
    static inline std::atomic<uint64_t> s_last_process_local_script_ms{0};
    static inline std::atomic<uint64_t> s_script_callback_faults{0};
    static inline std::atomic<uint32_t> s_last_receive_score_bits{0xFFFFFFFFu};
    static inline std::atomic<int32_t> s_last_receive_shots_fired{-1};
    static inline std::atomic<int32_t> s_last_receive_shots_hit{-1};
    static inline std::atomic<uint64_t> s_last_events_heartbeat_ms{0};
    static inline std::atomic<uint64_t> s_process_event_post_seen{0};
    static inline std::atomic<uint32_t> s_non_ui_emit_logs{0};
    static inline std::atomic<bool> s_probe_hooks_registered{false};
    static inline std::atomic<uint64_t> s_bound_hook_calls{0};
    static inline std::atomic<uint64_t> s_ui_settext_hook_calls{0};
    static inline std::atomic<uint64_t> s_ui_field_update_calls{0};
    static inline std::atomic<uint64_t> s_ui_derived_emit_calls{0};
    static inline std::atomic<uint64_t> s_emit_named_count{0};
    static inline std::atomic<uint64_t> s_emit_i32_count{0};
    static inline std::atomic<uint64_t> s_emit_f32_count{0};
    static inline std::atomic<uint64_t> s_emit_simple_count{0};
    static inline std::atomic<uint64_t> s_derived_counter_logs{0};
    static inline std::atomic<uint64_t> s_derived_alias_emits{0};
    static inline std::atomic<uint64_t> s_class_probe_hook_calls{0};
    static inline std::atomic<uint64_t> s_receive_score_hits{0};
    static inline std::atomic<uint64_t> s_receive_shots_fired_hits{0};
    static inline std::atomic<uint64_t> s_receive_shots_hit_hits{0};
    static inline thread_local const char* s_emit_origin{"unknown"};
    static inline thread_local const char* s_emit_origin_flag{"unknown"};
    static inline std::atomic<uint64_t> s_direct_poll_calls{0};
    static inline std::atomic<uint64_t> s_direct_poll_resolve_hits{0};
    static inline std::atomic<uint64_t> s_direct_poll_value_emits{0};
    static inline std::atomic<uint64_t> s_direct_poll_errors{0};
    static inline std::atomic<uint64_t> s_direct_poll_resolve_misses{0};
    static inline std::atomic<uint64_t> s_direct_poll_null_fn{0};
    static inline std::atomic<uint64_t> s_direct_poll_reselects{0};
    static inline std::atomic<uint64_t> s_direct_poll_prop_reads{0};
    static inline std::atomic<uint64_t> s_direct_poll_prop_emits{0};
    static inline int32_t s_ui_last_session_shots{-1};
    static inline int32_t s_ui_last_session_hits{-1};
    static inline int32_t s_ui_last_session_kills{-1};
    static inline std::unordered_map<std::string, std::string> s_ui_poll_last_values{};
    static inline std::unordered_map<RC::Unreal::UClass*, RC::Unreal::FTextProperty*> s_textblock_text_property_cache{};
    static inline uint64_t s_next_ui_poll_ms{};
    static inline RC::Unreal::UClass* s_meta_game_instance_class{};
    static inline RC::Unreal::UClass* s_state_receiver_class{};
    static inline RC::Unreal::UClass* s_scenario_state_receiver_class{};
    static inline RC::Unreal::UClass* s_stats_manager_class{};
    static inline RC::Unreal::UClass* s_scenario_manager_class{};
    static inline RC::Unreal::UObject* s_meta_game_instance{};
    static inline RC::Unreal::UObject* s_state_receiver_instance{};
    static inline RC::Unreal::UObject* s_scenario_state_receiver_instance{};
    static inline RC::Unreal::UObject* s_stats_manager_instance{};
    static inline RC::Unreal::UObject* s_scenario_manager_instance{};
    static inline RC::Unreal::UObject* s_sandbox_session_stats_instance{};
    static inline RC::Unreal::UClass* s_receiver_props_bound_class{};
    static inline std::vector<ReceiverNumericBinding> s_receiver_numeric_bindings{};
    static inline std::unordered_map<std::string, uint64_t> s_receiver_prop_last_bits{};
    static inline std::unordered_map<std::string, uint32_t> s_receiver_prop_emit_counts{};
    static inline RC::Unreal::UClass* s_stats_props_bound_class{};
    static inline std::vector<ReceiverNumericBinding> s_stats_numeric_bindings{};
    static inline std::unordered_map<std::string, uint64_t> s_stats_prop_last_bits{};
    static inline std::unordered_map<std::string, uint32_t> s_stats_prop_emit_counts{};
    static inline std::unordered_map<uint64_t, uint64_t> s_invoke_numeric_last_bits{};
    static inline uint64_t s_next_meta_resolve_ms{};
    static inline uint64_t s_next_receiver_resolve_ms{};
    static inline uint64_t s_next_scenario_receiver_resolve_ms{};
    static inline uint64_t s_next_stats_manager_resolve_ms{};
    static inline uint64_t s_next_scenario_manager_resolve_ms{};
    static inline uint64_t s_next_sandbox_stats_resolve_ms{};
    static inline uint64_t s_next_stats_bind_retry_ms{};
    static inline uint64_t s_next_receiver_activity_probe_ms{};
    static inline uint64_t s_last_pull_emit_ms{};
    static inline uint64_t s_last_pull_success_ms{};
    static inline int32_t s_last_pull_kills{-1};
    static inline int32_t s_last_pull_shots_fired{-1};
    static inline int32_t s_last_pull_shots_hit{-1};
    static inline float s_last_pull_score{-1.0f};
    static inline float s_last_pull_seconds{-1.0f};
    static inline float s_last_pull_spm{-1.0f};
    static inline float s_last_pull_kps{-1.0f};
    static inline float s_last_pull_damage_done{-1.0f};
    static inline float s_last_pull_damage_possible{-1.0f};
    static inline float s_last_pull_damage_efficiency{-1.0f};
    static inline float s_last_pull_kill_efficiency{-1.0f};
    static inline float s_last_pull_time_remaining{-1.0f};
    static inline float s_last_pull_distance_traveled{-1.0f};
    static inline float s_last_pull_mbs{-1.0f};
    static inline float s_last_pull_average_time_dilation_modifier{-1.0f};
    static inline float s_last_pull_average_target_size_modifier{-1.0f};
    static inline int32_t s_last_pull_mult_average_time_dilation_modifier{-1};
    static inline int32_t s_last_pull_mult_average_target_size_modifier{-1};
    static inline float s_last_pull_accuracy{-1.0f};
    static inline float s_last_pull_challenge_average_fps{-1.0f};
    static inline float s_last_pull_random_sens_scale{-1.0f};
    static inline float s_last_pull_challenge_seconds{-1.0f};
    static inline float s_last_pull_challenge_time_length{-1.0f};
    static inline int32_t s_last_pull_challenge_tick_count{-1};
    static inline float s_last_pull_last_score{-1.0f};
    static inline float s_last_pull_session_best_score{-1.0f};
    static inline float s_last_pull_previous_session_best_score{-1.0f};
    static inline float s_last_pull_previous_high_score{-1.0f};
    static inline float s_last_pull_last_challenge_time_remaining{-1.0f};
    static inline float s_last_pull_score_derived{-1.0f};
    static inline std::string s_last_pull_score_source{"none"};
    static inline uint64_t s_last_nonzero_score_ms{};
    static inline uint64_t s_last_nonzero_shots_fired_ms{};
    static inline uint64_t s_last_nonzero_shots_hit_ms{};
    static inline uint64_t s_last_nonzero_kills_ms{};
    static inline uint64_t s_last_nonzero_seconds_ms{};
    static inline uint64_t s_last_nonzero_spm_ms{};
    static inline uint64_t s_last_nonzero_damage_done_ms{};
    static inline uint64_t s_last_nonzero_damage_possible_ms{};
    static inline uint64_t s_next_pull_debug_ms{};
    static constexpr size_t k_event_kind_slot_count = static_cast<size_t>(EventKind::ChallengeCompleted) + 1;
    static inline std::array<std::atomic<uint64_t>, k_event_kind_slot_count> s_event_kind_hits{};
    static inline std::vector<std::pair<RC::Unreal::UFunction*, RC::Unreal::CallbackId>> s_native_hook_bindings{};
    static inline std::mutex s_state_mutex{};
    static constexpr uint32_t k_max_new_event_logs = 100000;
    static constexpr bool k_enable_global_discovery = false;

    static auto refresh_runtime_flags(bool force) -> void {
        uint32_t n = s_flag_refresh_counter.fetch_add(1, std::memory_order_relaxed) + 1;
        bool reload_requested = false;
        if (!force) {
            // Check for explicit reload requests frequently.
            if ((n % 30) == 0) {
                reload_requested = consume_reload_flags_request();
            }
            // Poll periodically even without explicit reload request.
            if (!reload_requested && (n % 120) != 0) {
                return;
            }
        }

        const bool prev_discovery = s_discovery_enabled;
        const bool prev_safe_mode = s_safe_mode_enabled;
        const bool prev_profile_full = s_profile_full;
        const bool prev_pe_enable_flag = s_pe_enabled_by_flag;
        const bool prev_pe_disable_flag = s_pe_disabled_by_flag;
        const bool prev_pe_events_enabled = s_pe_events_enabled;
        const bool prev_log_all_events = s_log_all_events;
        const bool prev_object_debug = s_object_debug_enabled;
        const bool prev_non_ui_probe = s_non_ui_probe_enabled;
        const bool prev_ui_counter_fallback = s_ui_counter_fallback_enabled;
        const bool prev_score_ui_fallback = s_score_ui_fallback_enabled;
        const bool prev_enable_process_internal_script_hook = s_enable_process_internal_script_hook;
        const bool prev_enable_process_local_script_hook = s_enable_process_local_script_hook;
        const bool prev_class_probe_hooks = s_class_probe_hooks_enabled;
        const bool prev_allow_unsafe_hooks = s_allow_unsafe_hooks;

        const bool profile_full = payload_profile_is_full();
        const bool discovery = k_enable_global_discovery || env_flag_enabled("KOVAAKS_DISCOVERY") || file_flag_enabled();
        const bool safe_mode = safe_mode_flag_enabled();
        const bool log_all_events = env_flag_enabled("KOVAAKS_LOG_ALL_EVENTS") || log_all_events_flag_enabled();
        const bool object_debug = env_flag_enabled("KOVAAKS_OBJECT_DEBUG") || object_debug_flag_enabled();
        const bool non_ui_probe = env_flag_enabled("KOVAAKS_NON_UI_PROBE") || non_ui_probe_flag_enabled();
        const bool ui_counter_fallback = env_flag_enabled("KOVAAKS_UI_COUNTER_FALLBACK")
            || ui_counter_fallback_flag_enabled();
        const bool score_ui_fallback = env_flag_enabled("KOVAAKS_SCORE_UI_FALLBACK")
            || score_ui_fallback_flag_enabled();
        const bool enable_process_internal_script_hook =
            env_flag_enabled("KOVAAKS_HOOK_PROCESS_INTERNAL")
            || process_internal_script_hook_flag_enabled();
        const bool enable_process_local_script_hook =
            env_flag_enabled("KOVAAKS_HOOK_PROCESS_LOCAL_SCRIPT")
            || process_local_script_hook_flag_enabled();
        const bool class_probe_hooks =
            env_flag_enabled("KOVAAKS_CLASS_PROBE_HOOKS")
            || class_probe_hooks_flag_enabled();
        const bool allow_unsafe_hooks =
            env_flag_enabled("KOVAAKS_ALLOW_UNSAFE_HOOKS")
            || unsafe_hooks_flag_enabled();
        // Stability-first: only explicit flags/env enable runtime hooks.
        // Do not auto-enable from profile_full, because that can crash on some builds.
        const bool pe_enable_flag = enable_pe_hook_flag_enabled() || discovery || log_all_events || object_debug || non_ui_probe;
        const bool pe_disable_flag = disable_pe_hook_flag_enabled();
        const bool pe_events_enabled = pe_enable_flag && !pe_disable_flag && !safe_mode;

        s_profile_full = profile_full;
        s_discovery_enabled = discovery;
        s_safe_mode_enabled = safe_mode;
        s_pe_enabled_by_flag = pe_enable_flag;
        s_pe_disabled_by_flag = pe_disable_flag;
        s_pe_events_enabled = pe_events_enabled;
        s_log_all_events = log_all_events;
        s_object_debug_enabled = object_debug;
        s_non_ui_probe_enabled = non_ui_probe;
        s_ui_counter_fallback_enabled = ui_counter_fallback;
        s_score_ui_fallback_enabled = score_ui_fallback;
        s_enable_process_internal_script_hook = enable_process_internal_script_hook;
        s_enable_process_local_script_hook = enable_process_local_script_hook;
        s_class_probe_hooks_enabled = class_probe_hooks;
        s_allow_unsafe_hooks = allow_unsafe_hooks;

        const bool changed = prev_discovery != discovery
            || prev_safe_mode != safe_mode
            || prev_profile_full != profile_full
            || prev_pe_enable_flag != pe_enable_flag
            || prev_pe_disable_flag != pe_disable_flag
            || prev_pe_events_enabled != pe_events_enabled
            || prev_log_all_events != log_all_events
            || prev_object_debug != object_debug
            || prev_non_ui_probe != non_ui_probe
            || prev_ui_counter_fallback != ui_counter_fallback
            || prev_score_ui_fallback != score_ui_fallback
            || prev_enable_process_internal_script_hook != enable_process_internal_script_hook
            || prev_enable_process_local_script_hook != enable_process_local_script_hook
            || prev_class_probe_hooks != class_probe_hooks
            || prev_allow_unsafe_hooks != allow_unsafe_hooks;
        if (!force && !reload_requested && !changed) {
            return;
        }

        std::array<char, 320> buf{};
        std::snprintf(
            buf.data(),
            buf.size(),
            "[KovaaksBridgeMod] runtime flags refresh force=%u request=%u changed=%u enable_pe_hook=%u disable_pe_hook=%u profile_full=%u discovery=%u safe_mode=%u pe_events_enabled=%u pi_script=%u pls_script=%u",
            force ? 1 : 0,
            reload_requested ? 1 : 0,
            changed ? 1 : 0,
            pe_enable_flag ? 1 : 0,
            pe_disable_flag ? 1 : 0,
            profile_full ? 1 : 0,
            discovery ? 1 : 0,
            safe_mode ? 1 : 0,
            pe_events_enabled ? 1 : 0,
            enable_process_internal_script_hook ? 1 : 0,
            enable_process_local_script_hook ? 1 : 0
        );
        {
            std::array<char, 160> eb{};
            std::snprintf(
                eb.data(),
                eb.size(),
                "[KovaaksBridgeMod] log_all_events=%u object_debug=%u non_ui_probe=%u ui_counter_fallback=%u score_ui_fallback=%u pi_script=%u pls_script=%u class_probe_hooks=%u allow_unsafe_hooks=%u",
                log_all_events ? 1 : 0,
                object_debug ? 1 : 0,
                non_ui_probe ? 1 : 0,
                ui_counter_fallback ? 1 : 0,
                score_ui_fallback ? 1 : 0,
                enable_process_internal_script_hook ? 1 : 0,
                enable_process_local_script_hook ? 1 : 0,
                class_probe_hooks ? 1 : 0,
                allow_unsafe_hooks ? 1 : 0
            );
            runtime_log_line(eb.data());
        }
        if (log_all_events) {
            events_log_line("[flags] log_all_events=1");
        }
        runtime_log_line(buf.data());
        RC::Output::send<RC::LogLevel::Warning>(
            STR("[KovaaksBridgeMod] runtime flags refresh: enable={} disable={} profile_full={} discovery={} safe_mode={} pe_events_enabled={} log_all={} object_debug={} non_ui_probe={} ui_counter_fallback={} score_ui_fallback={} pi_script={} pls_script={} class_probe_hooks={} allow_unsafe_hooks={}\n"),
            pe_enable_flag ? 1 : 0,
            pe_disable_flag ? 1 : 0,
            profile_full ? 1 : 0,
            discovery ? 1 : 0,
            safe_mode ? 1 : 0,
            pe_events_enabled ? 1 : 0,
            log_all_events ? 1 : 0,
            object_debug ? 1 : 0,
            non_ui_probe ? 1 : 0,
            ui_counter_fallback ? 1 : 0,
            score_ui_fallback ? 1 : 0,
            enable_process_internal_script_hook ? 1 : 0,
            enable_process_local_script_hook ? 1 : 0,
            class_probe_hooks ? 1 : 0,
            allow_unsafe_hooks ? 1 : 0
        );

        std::array<char, 512> ev{};
        std::snprintf(
            ev.data(),
            ev.size(),
            "{\"ev\":\"ue4ss_runtime_flags\",\"enable\":%u,\"disable\":%u,\"profile_full\":%u,\"discovery\":%u,\"safe_mode\":%u,\"pe_enabled\":%u,\"log_all\":%u,\"object_debug\":%u,\"non_ui_probe\":%u,\"ui_counter_fallback\":%u,\"score_ui_fallback\":%u,\"hook_process_internal\":%u,\"hook_process_local_script\":%u,\"class_probe_hooks\":%u,\"allow_unsafe_hooks\":%u,\"rust_enabled\":%u}",
            pe_enable_flag ? 1 : 0,
            pe_disable_flag ? 1 : 0,
            profile_full ? 1 : 0,
            discovery ? 1 : 0,
            safe_mode ? 1 : 0,
            pe_events_enabled ? 1 : 0,
            log_all_events ? 1 : 0,
            object_debug ? 1 : 0,
            non_ui_probe ? 1 : 0,
            ui_counter_fallback ? 1 : 0,
            score_ui_fallback ? 1 : 0,
            enable_process_internal_script_hook ? 1 : 0,
            enable_process_local_script_hook ? 1 : 0,
            class_probe_hooks ? 1 : 0,
            allow_unsafe_hooks ? 1 : 0,
            s_rust_enabled ? 1 : 0
        );
        kovaaks::RustBridge::emit_json(ev.data());
    }

    static auto find_fn(const wchar_t* full_path) -> RC::Unreal::UFunction* {
        return RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UFunction*>(nullptr, nullptr, full_path);
    }

    static auto track_target(const wchar_t* full_path, RC::Unreal::UFunction*& out) -> void {
        out = find_fn(full_path);
        if (out) {
            ++s_resolved_target_count;
            RC::Output::send<RC::LogLevel::Verbose>(
                STR("[KovaaksBridgeMod] target resolved: {}\n"),
                out->GetFullName()
            );
        } else {
            RC::Output::send<RC::LogLevel::Warning>(
                STR("[KovaaksBridgeMod] target missing: {}\n"),
                RC::StringType(full_path)
            );
        }
    }

    static auto resolve_targets() -> void {
        s_targets = {};
        s_resolved_target_count = 0;

        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Send_Score"), s_targets.send_score);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Send_RandomSensScale"), s_targets.send_random_sens_scale);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Send_Kills"), s_targets.send_kills);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Send_ShotsHit"), s_targets.send_shots_hit);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Send_ShotsFired"), s_targets.send_shots_fired);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Send_Seconds"), s_targets.send_seconds);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Send_DamageDone"), s_targets.send_damage_done);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Send_DamagePossible"), s_targets.send_damage_possible);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Send_ChallengeSeconds"), s_targets.send_challenge_seconds);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Send_ChallengeTickCount"), s_targets.send_challenge_tick_count);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Reset_TransientData"), s_targets.reset_transient_data);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Reset_ShotsHit"), s_targets.reset_shots_hit);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Reset_ShotsFired"), s_targets.reset_shots_fired);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Reset_Seconds"), s_targets.reset_seconds);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Reset_Score"), s_targets.reset_score);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Reset_RandomSensScale"), s_targets.reset_random_sens_scale);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Reset_Kills"), s_targets.reset_kills);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Reset_DamagePossible"), s_targets.reset_damage_possible);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Reset_DamageDone"), s_targets.reset_damage_done);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Reset_ChallengeTickCount"), s_targets.reset_challenge_tick_count);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Reset_ChallengeSeconds"), s_targets.reset_challenge_seconds);
        track_target(STR("/Script/KovaaKFramework.JobContext:HasCompleted"), s_targets.job_context_has_completed);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Score"), s_targets.receive_score);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Score_Single"), s_targets.receive_score_single);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Score_ValueElse"), s_targets.receive_score_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Score_ValueOr"), s_targets.receive_score_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Score_ValueOr"), s_targets.get_score_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Score_ValueElse"), s_targets.get_score_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Kills"), s_targets.receive_kills);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Kills_ValueOr"), s_targets.get_kills_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Kills_ValueElse"), s_targets.get_kills_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ShotsHit"), s_targets.receive_shots_hit);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ShotsFired"), s_targets.receive_shots_fired);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ShotsHit_Single"), s_targets.receive_shots_hit_single);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ShotsHit_ValueElse"), s_targets.receive_shots_hit_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ShotsHit_ValueOr"), s_targets.get_shots_hit_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ShotsHit_ValueElse"), s_targets.get_shots_hit_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ShotsFired_Single"), s_targets.receive_shots_fired_single);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ShotsFired_ValueElse"), s_targets.receive_shots_fired_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ShotsFired_ValueOr"), s_targets.receive_shots_fired_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ShotsFired_ValueOr"), s_targets.get_shots_fired_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ShotsFired_ValueElse"), s_targets.get_shots_fired_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Seconds"), s_targets.receive_seconds);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Seconds_ValueOr"), s_targets.get_seconds_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Seconds_ValueElse"), s_targets.get_seconds_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_DamageDone"), s_targets.receive_damage_done);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_DamageDone_ValueElse"), s_targets.receive_damage_done_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamageDone_ValueOr"), s_targets.get_damage_done_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamageDone_ValueElse"), s_targets.get_damage_done_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_DamagePossible"), s_targets.receive_damage_possible);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_DamagePossible_ValueElse"), s_targets.receive_damage_possible_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamagePossible_ValueOr"), s_targets.get_damage_possible_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamagePossible_ValueElse"), s_targets.get_damage_possible_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_DamageEfficiency"), s_targets.receive_damage_efficiency);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_DamageEfficiency_ValueElse"), s_targets.receive_damage_efficiency_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamageEfficiency_ValueOr"), s_targets.get_damage_efficiency_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamageEfficiency_ValueElse"), s_targets.get_damage_efficiency_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ScorePerMinute"), s_targets.receive_score_per_minute);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ScorePerMinute_ValueElse"), s_targets.receive_score_per_minute_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ScorePerMinute_ValueOr"), s_targets.get_score_per_minute_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ScorePerMinute_ValueElse"), s_targets.get_score_per_minute_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Accuracy"), s_targets.receive_accuracy);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Accuracy_Single"), s_targets.receive_accuracy_single);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Accuracy_ValueElse"), s_targets.receive_accuracy_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Accuracy_ValueOr"), s_targets.receive_accuracy_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Accuracy_ValueOr"), s_targets.get_accuracy_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Accuracy_ValueElse"), s_targets.get_accuracy_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeAverageFPS"), s_targets.receive_challenge_average_fps);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeAverageFPS_Single"), s_targets.receive_challenge_average_fps_single);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeAverageFPS_ValueElse"), s_targets.receive_challenge_average_fps_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeAverageFPS_ValueOr"), s_targets.receive_challenge_average_fps_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ChallengeAverageFPS_ValueOr"), s_targets.get_challenge_average_fps_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ChallengeAverageFPS_ValueElse"), s_targets.get_challenge_average_fps_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_RandomSensScale"), s_targets.receive_random_sens_scale);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_RandomSensScale_Single"), s_targets.receive_random_sens_scale_single);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_RandomSensScale_ValueElse"), s_targets.receive_random_sens_scale_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_RandomSensScale_ValueOr"), s_targets.receive_random_sens_scale_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_RandomSensScale_ValueOr"), s_targets.get_random_sens_scale_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_RandomSensScale_ValueElse"), s_targets.get_random_sens_scale_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_KillsPerSecond"), s_targets.receive_kills_per_second);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_KillsPerSecond_ValueElse"), s_targets.receive_kills_per_second_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_KillsPerSecond_ValueOr"), s_targets.get_kills_per_second_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_KillsPerSecond_ValueElse"), s_targets.get_kills_per_second_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeSeconds"), s_targets.receive_challenge_seconds);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeSeconds_Single"), s_targets.receive_challenge_seconds_single);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeSeconds_ValueElse"), s_targets.receive_challenge_seconds_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeSeconds_ValueOr"), s_targets.receive_challenge_seconds_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeTickCount"), s_targets.receive_challenge_tick_count);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeTickCount_Single"), s_targets.receive_challenge_tick_count_single);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeTickCount_ValueElse"), s_targets.receive_challenge_tick_count_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ChallengeTickCount_ValueOr"), s_targets.receive_challenge_tick_count_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ChallengeSeconds_ValueOr"), s_targets.get_challenge_seconds_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ChallengeSeconds_ValueElse"), s_targets.get_challenge_seconds_value_else);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ChallengeTickCount_ValueOr"), s_targets.get_challenge_tick_count_value_or);
        track_target(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ChallengeTickCount_ValueElse"), s_targets.get_challenge_tick_count_value_else);
        track_target(STR("/Script/KovaaKFramework.ScenarioStateReceiver:Receive_ChallengeScore"), s_targets.receive_challenge_score);
        track_target(STR("/Script/KovaaKFramework.ScenarioStateReceiver:Receive_ChallengeScore_Single"), s_targets.receive_challenge_score_single);
        track_target(STR("/Script/KovaaKFramework.ScenarioStateReceiver:Receive_ChallengeScore_ValueOr"), s_targets.receive_challenge_score_value_or);
        track_target(STR("/Script/KovaaKFramework.ScenarioStateReceiver:Receive_ChallengeScore_ValueElse"), s_targets.receive_challenge_score_value_else);
        track_target(STR("/Script/KovaaKFramework.ScenarioStateReceiver:Get_ChallengeScore_ValueOr"), s_targets.get_challenge_score_value_or);
        track_target(STR("/Script/KovaaKFramework.ScenarioStateReceiver:Get_ChallengeScore_ValueElse"), s_targets.get_challenge_score_value_else);
        track_target(STR("/Script/GameSkillsTrainer.StatsManager:CalculateScore"), s_targets.stats_calculate_score);
        track_target(STR("/Script/GameSkillsTrainer.StatsManager:GetLastScore"), s_targets.stats_get_last_score);
        track_target(STR("/Script/GameSkillsTrainer.StatsManager:GetSessionBestScore"), s_targets.stats_get_session_best_score);
        track_target(STR("/Script/GameSkillsTrainer.StatsManager:GetPreviousSessionBestScore"), s_targets.stats_get_previous_session_best_score);
        track_target(STR("/Script/GameSkillsTrainer.StatsManager:GetPreviousHighScore"), s_targets.stats_get_previous_high_score);
        track_target(STR("/Script/GameSkillsTrainer.StatsManager:GetLastChallengeTimeRemaining"), s_targets.stats_get_last_challenge_time_remaining);
        track_target(STR("/Script/GameSkillsTrainer.ScenarioManager:GetChallengeTimeElapsed"), s_targets.scenario_get_challenge_time_elapsed);
        track_target(STR("/Script/GameSkillsTrainer.ScenarioManager:GetChallengeTimeRemaining"), s_targets.scenario_get_challenge_time_remaining_runtime);
        track_target(STR("/Script/GameSkillsTrainer.ScenarioManager:GetRealtimeChallengeTimeLength"), s_targets.scenario_get_realtime_challenge_time_length);
        track_target(STR("/Script/GameSkillsTrainer.GTheMetaGameInstance:GetSandboxSessionStats"), s_targets.meta_get_sandbox_session_stats);
        track_target(STR("/Script/GameSkillsTrainer.SandboxSessionStats:GetChallengeTimeInSeconds"), s_targets.sandbox_get_challenge_time_in_seconds);
        track_target(STR("/Script/GameSkillsTrainer.SandboxSessionStats:GetRealtimeChallengeTimeLength"), s_targets.sandbox_get_realtime_challenge_time_length);

        track_target(STR("/Script/GameSkillsTrainer.PerformanceIndicatorsBroadcastReceiver:Send_ShotHit"), s_targets.send_shot_hit_br);
        track_target(STR("/Script/GameSkillsTrainer.PerformanceIndicatorsBroadcastReceiver:Send_ShotMissed"), s_targets.send_shot_missed_br);
        track_target(STR("/Script/GameSkillsTrainer.PerformanceIndicatorsBroadcastReceiver:Send_ShotFired"), s_targets.send_shot_fired_br);
        track_target(STR("/Script/GameSkillsTrainer.PerformanceIndicatorsBroadcastReceiver:Send_Kill"), s_targets.send_kill_br);
        track_target(STR("/Script/GameSkillsTrainer.PerformanceIndicatorsBroadcastReceiver:Receive_ShotHit"), s_targets.receive_shot_hit_br);
        track_target(STR("/Script/GameSkillsTrainer.PerformanceIndicatorsBroadcastReceiver:Receive_ShotMissed"), s_targets.receive_shot_missed_br);
        track_target(STR("/Script/GameSkillsTrainer.PerformanceIndicatorsBroadcastReceiver:Receive_ShotFired"), s_targets.receive_shot_fired_br);
        track_target(STR("/Script/GameSkillsTrainer.PerformanceIndicatorsBroadcastReceiver:Receive_Kill"), s_targets.receive_kill_br);

        track_target(STR("/Script/GameSkillsTrainer.WeaponParentActor:Send_ShotHit"), s_targets.send_shot_hit_weapon);
        track_target(STR("/Script/GameSkillsTrainer.WeaponParentActor:Send_ShotMissed"), s_targets.send_shot_missed_weapon);
        track_target(STR("/Script/GameSkillsTrainer.WeaponParentActor:Send_ShotFired"), s_targets.send_shot_fired_weapon);
        track_target(STR("/Script/GameSkillsTrainer.WeaponParentActor:Send_Kill"), s_targets.send_kill_weapon);
        track_target(STR("/Script/GameSkillsTrainer.WeaponParentActor:Receive_ShotHit"), s_targets.receive_shot_hit_weapon);
        track_target(STR("/Script/GameSkillsTrainer.WeaponParentActor:Receive_ShotMissed"), s_targets.receive_shot_missed_weapon);
        track_target(STR("/Script/GameSkillsTrainer.WeaponParentActor:Receive_ShotFired"), s_targets.receive_shot_fired_weapon);
        track_target(STR("/Script/GameSkillsTrainer.WeaponParentActor:Receive_Kill"), s_targets.receive_kill_weapon);

        track_target(STR("/Script/KovaaKFramework.ScenarioBroadcastReceiver:Send_ChallengeQueued"), s_targets.send_challenge_queued);
        track_target(STR("/Script/KovaaKFramework.ScenarioBroadcastReceiver:Send_ChallengeComplete"), s_targets.send_challenge_complete);
        track_target(STR("/Script/KovaaKFramework.ScenarioBroadcastReceiver:Send_ChallengeCanceled"), s_targets.send_challenge_canceled);
        track_target(STR("/Script/KovaaKFramework.ScenarioBroadcastReceiver:Send_PostChallengeComplete"), s_targets.send_post_challenge_complete);

        track_target(STR("/Script/GameSkillsTrainer.AnalyticsManager:OnChallengeStarted"), s_targets.on_challenge_started);
        track_target(STR("/Script/GameSkillsTrainer.AnalyticsManager:OnChallengeRestarted"), s_targets.on_challenge_restarted);
        track_target(STR("/Script/GameSkillsTrainer.AnalyticsManager:OnChallengeQuit"), s_targets.on_challenge_quit);
        track_target(STR("/Script/GameSkillsTrainer.AnalyticsManager:OnChallengeCompleted"), s_targets.on_challenge_completed);
        track_target(STR("/Script/GameSkillsTrainer.GTheMetaGameInstance:NotifyPlayerFireWeapon"), s_targets.meta_notify_player_fire_weapon);
        track_target(STR("/Script/GameSkillsTrainer.GTheMetaGameInstance:OnHitScan"), s_targets.meta_on_hit_scan);
        track_target(STR("/Script/GameSkillsTrainer.GTheMetaGameInstance:OnSpawnProjectile"), s_targets.meta_on_spawn_projectile);
    }

    #include "kmod/emit_context.inl"
    #include "kmod/ui_poll_helpers.inl"
    #include "kmod/pull_source.inl"

    static auto emit_event_kind(EventKind kind) -> bool {
        auto reset_derived_counters = []() {
            std::lock_guard<std::mutex> guard(s_state_mutex);
            s_ui_last_session_shots = -1;
            s_ui_last_session_hits = -1;
            s_ui_last_session_kills = -1;
        };
        const auto emit_named = [](const char* ev) -> bool {
            s_emit_named_count.fetch_add(1, std::memory_order_relaxed);
            const auto origin = s_emit_origin ? s_emit_origin : "unknown";
            const auto origin_flag = s_emit_origin_flag ? s_emit_origin_flag : "unknown";
            if (s_log_all_events) {
                std::array<char, 256> buf{};
                std::snprintf(
                    buf.data(),
                    buf.size(),
                    "[emit] ev=%s origin=%s origin_flag=%s",
                    ev,
                    origin,
                    origin_flag
                );
                events_log_line(buf.data());
            }
            const auto log_idx = s_non_ui_emit_logs.fetch_add(1, std::memory_order_relaxed);
            if (log_idx < 200) {
                std::array<char, 320> rbuf{};
                std::snprintf(
                    rbuf.data(),
                    rbuf.size(),
                    "[emit_non_ui #%u] ev=%s origin=%s origin_flag=%s pe=%u nup=%u uicf=%u suif=%u",
                    log_idx + 1,
                    ev,
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
                "{\"ev\":\"%s\",\"origin\":\"%s\",\"origin_flag\":\"%s\",%s}",
                ev,
                origin,
                origin_flag,
                flags_json.data()
            );
            kovaaks::RustBridge::emit_json(msg.data());
            return true;
        };
        switch (kind) {
        case EventKind::Score: return emit_named("score");
        case EventKind::Kills: return emit_named("kills");
        case EventKind::ShotsHit: return emit_named("shots_hit");
        case EventKind::ShotsFired: return emit_named("shots_fired");
        case EventKind::Seconds: return emit_named("seconds");
        case EventKind::DamageDone: return emit_named("damage_done");
        case EventKind::DamagePossible: return emit_named("damage_possible");
        case EventKind::ChallengeSeconds: return emit_named("challenge_seconds");
        case EventKind::ChallengeTickCount: return emit_named("challenge_tick_count");
        case EventKind::ShotHit: return emit_named("shot_hit");
        case EventKind::ShotFired: return emit_named("shot_fired");
        case EventKind::ShotMissed: return emit_named("shot_missed");
        case EventKind::Kill: return emit_named("kill");
        case EventKind::ChallengeQueued: return emit_named("challenge_queued");
        case EventKind::ChallengeComplete: return emit_named("challenge_complete");
        case EventKind::ChallengeCanceled: return emit_named("challenge_canceled");
        case EventKind::PostChallengeComplete: return emit_named("post_challenge_complete");
        case EventKind::ChallengeStart:
            reset_derived_counters();
            return emit_named("challenge_start");
        case EventKind::ChallengeRestart:
            reset_derived_counters();
            return emit_named("challenge_restart");
        case EventKind::ChallengeQuit: return emit_named("challenge_quit");
        case EventKind::ChallengeCompleted: return emit_named("challenge_completed");
        case EventKind::None:
        default:
            return false;
        }
    }

    static auto classify_event_kind(RC::Unreal::UFunction* function) -> EventKind {
        if (!function || !is_likely_valid_object_ptr(function)) {
            return EventKind::None;
        }
        {
            std::lock_guard<std::mutex> guard(s_state_mutex);
            auto it = s_cached_event_kind.find(function);
            if (it != s_cached_event_kind.end()) {
                return it->second;
            }
        }

        EventKind kind = EventKind::None;
        const auto full_name = function->GetFullName();
        if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Send_Score")) != RC::StringType::npos) {
            kind = EventKind::Score;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Send_Kills")) != RC::StringType::npos) {
            kind = EventKind::Kills;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Send_ShotsHit")) != RC::StringType::npos) {
            kind = EventKind::ShotsHit;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Send_ShotsFired")) != RC::StringType::npos) {
            kind = EventKind::ShotsFired;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Send_Seconds")) != RC::StringType::npos) {
            kind = EventKind::Seconds;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Send_DamageDone")) != RC::StringType::npos) {
            kind = EventKind::DamageDone;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Send_DamagePossible")) != RC::StringType::npos) {
            kind = EventKind::DamagePossible;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Send_ChallengeSeconds")) != RC::StringType::npos) {
            kind = EventKind::ChallengeSeconds;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Send_ChallengeTickCount")) != RC::StringType::npos) {
            kind = EventKind::ChallengeTickCount;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_Score")) != RC::StringType::npos) {
            kind = EventKind::Score;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_Kills")) != RC::StringType::npos) {
            kind = EventKind::Kills;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_ShotsHit")) != RC::StringType::npos) {
            kind = EventKind::ShotsHit;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_ShotsFired")) != RC::StringType::npos) {
            kind = EventKind::ShotsFired;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_Seconds")) != RC::StringType::npos) {
            kind = EventKind::Seconds;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_DamageDone")) != RC::StringType::npos) {
            kind = EventKind::DamageDone;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_DamagePossible")) != RC::StringType::npos) {
            kind = EventKind::DamagePossible;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_ChallengeSeconds")) != RC::StringType::npos) {
            kind = EventKind::ChallengeSeconds;
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_ChallengeTickCount")) != RC::StringType::npos) {
            kind = EventKind::ChallengeTickCount;
        } else if (full_name.find(STR(":Receive_ShotHit")) != RC::StringType::npos) {
            kind = EventKind::ShotHit;
        } else if (full_name.find(STR(":Receive_ShotFired")) != RC::StringType::npos) {
            kind = EventKind::ShotFired;
        } else if (full_name.find(STR(":Receive_ShotMissed")) != RC::StringType::npos) {
            kind = EventKind::ShotMissed;
        } else if (full_name.find(STR(":Receive_Kill")) != RC::StringType::npos) {
            kind = EventKind::Kill;
        } else if (full_name.find(STR(":Send_ShotHit")) != RC::StringType::npos) {
            kind = EventKind::ShotHit;
        } else if (full_name.find(STR(":Send_ShotFired")) != RC::StringType::npos) {
            kind = EventKind::ShotFired;
        } else if (full_name.find(STR(":Send_ShotMissed")) != RC::StringType::npos) {
            kind = EventKind::ShotMissed;
        } else if (full_name.find(STR(":Send_Kills")) != RC::StringType::npos) {
            kind = EventKind::Kills;
        } else if (full_name.find(STR(":Send_Kill")) != RC::StringType::npos) {
            kind = EventKind::Kill;
        } else if (full_name.find(STR("ScenarioBroadcastReceiver:Send_ChallengeQueued")) != RC::StringType::npos) {
            kind = EventKind::ChallengeQueued;
        } else if (full_name.find(STR("ScenarioBroadcastReceiver:Send_ChallengeComplete")) != RC::StringType::npos) {
            kind = EventKind::ChallengeComplete;
        } else if (full_name.find(STR("ScenarioBroadcastReceiver:Send_ChallengeCanceled")) != RC::StringType::npos) {
            kind = EventKind::ChallengeCanceled;
        } else if (full_name.find(STR("ScenarioBroadcastReceiver:Send_PostChallengeComplete")) != RC::StringType::npos) {
            kind = EventKind::PostChallengeComplete;
        } else if (full_name.find(STR("AnalyticsManager:OnChallengeStarted")) != RC::StringType::npos) {
            kind = EventKind::ChallengeStart;
        } else if (full_name.find(STR("AnalyticsManager:OnChallengeRestarted")) != RC::StringType::npos) {
            kind = EventKind::ChallengeRestart;
        } else if (full_name.find(STR("AnalyticsManager:OnChallengeQuit")) != RC::StringType::npos) {
            kind = EventKind::ChallengeQuit;
        } else if (full_name.find(STR("AnalyticsManager:OnChallengeCompleted")) != RC::StringType::npos) {
            kind = EventKind::ChallengeCompleted;
        } else if (full_name.find(STR("GTheMetaGameInstance:NotifyPlayerFireWeapon")) != RC::StringType::npos) {
            kind = EventKind::ShotFired;
        } else if (full_name.find(STR("GTheMetaGameInstance:OnHitScan")) != RC::StringType::npos) {
            kind = EventKind::ShotHit;
        } else if (full_name.find(STR("GTheMetaGameInstance:OnSpawnProjectile")) != RC::StringType::npos) {
            kind = EventKind::ShotFired;
        }

        {
            std::lock_guard<std::mutex> guard(s_state_mutex);
            s_cached_event_kind.emplace(function, kind);
        }
        return kind;
    }

    static auto is_non_ui_probe_candidate(const RC::StringType& full_name) -> bool {
        if (full_name.find(STR("UMG.")) != RC::StringType::npos) {
            return false;
        }
        if (full_name.find(STR(":SetText")) != RC::StringType::npos) {
            return false;
        }
        if (full_name.find(STR("Widget")) != RC::StringType::npos) {
            return false;
        }
        if (full_name.find(STR("PerformanceIndicatorsStateReceiver:")) != RC::StringType::npos) {
            return true;
        }
        if (full_name.find(STR("PerformanceIndicatorsBroadcastReceiver:")) != RC::StringType::npos) {
            return true;
        }
        if (full_name.find(STR("WeaponParentActor:")) != RC::StringType::npos) {
            return true;
        }
        if (full_name.find(STR("ScenarioBroadcastReceiver:")) != RC::StringType::npos) {
            return true;
        }
        if (full_name.find(STR("AnalyticsManager:")) != RC::StringType::npos) {
            return true;
        }
        if (full_name.find(STR("GTheMetaGameInstance:")) != RC::StringType::npos) {
            return true;
        }
        return false;
    }

    static auto is_probe_function_name_interesting(const RC::StringType& full_name) -> bool {
        const auto has_any = [&](std::initializer_list<const wchar_t*> needles) {
            for (const auto* needle : needles) {
                if (needle && full_name.find(needle) != RC::StringType::npos) {
                    return true;
                }
            }
            return false;
        };

        if (full_name.find(STR("PerformanceIndicatorsStateReceiver:")) != RC::StringType::npos) {
            return has_any({
                STR(":Send_"), STR(":Receive_"), STR(":Get_"),
                STR("Shot"), STR("Kill"), STR("Score"), STR("Damage"), STR("Second"), STR("Challenge")
            });
        }
        if (full_name.find(STR("PerformanceIndicatorsBroadcastReceiver:")) != RC::StringType::npos) {
            return has_any({
                STR(":Send_"), STR(":Receive_"), STR(":Get_"),
                STR("Shot"), STR("Kill"), STR("Score"), STR("Damage"), STR("Second")
            });
        }
        if (full_name.find(STR("WeaponParentActor:")) != RC::StringType::npos) {
            return has_any({STR("Shot"), STR("Kill"), STR("Hit"), STR("Miss"), STR("Fire")});
        }
        if (full_name.find(STR("ScenarioBroadcastReceiver:")) != RC::StringType::npos) {
            return has_any({STR("Challenge"), STR("Scenario"), STR("Complete"), STR("Cancel"), STR("Queue")});
        }
        if (full_name.find(STR("ScenarioManager:")) != RC::StringType::npos) {
            return has_any({STR("Challenge"), STR("Scenario"), STR("Time"), STR("Score"), STR("Kill"), STR("Shot")});
        }
        if (full_name.find(STR("AnalyticsManager:")) != RC::StringType::npos) {
            return has_any({STR("Challenge"), STR("Score"), STR("Kill"), STR("Shot"), STR("Restart"), STR("Quit"), STR("Complete")});
        }
        if (full_name.find(STR("GTheMetaGameInstance:")) != RC::StringType::npos) {
            return has_any({STR("FireWeapon"), STR("Hit"), STR("SpawnProjectile"), STR("Challenge"), STR("Score"), STR("Kill"), STR("Shot")});
        }
        return false;
    }

    static auto allow_class_probe_log() -> bool {
        static std::atomic<uint64_t> s_probe_window_start_ms{0};
        static std::atomic<uint32_t> s_probe_window_count{0};
        constexpr uint32_t k_max_per_second = 60;

        const auto now = GetTickCount64();
        uint64_t window = s_probe_window_start_ms.load(std::memory_order_relaxed);
        if (window == 0 || (now - window) >= 1000) {
            s_probe_window_start_ms.store(now, std::memory_order_relaxed);
            s_probe_window_count.store(0, std::memory_order_relaxed);
        }
        const auto count = s_probe_window_count.fetch_add(1, std::memory_order_relaxed) + 1;
        return count <= k_max_per_second;
    }

    static auto pull_metric_name(PullMetricKind metric) -> const char* {
        switch (metric) {
        case PullMetricKind::Score: return "score";
        case PullMetricKind::Kills: return "kills";
        case PullMetricKind::ShotsHit: return "shots_hit";
        case PullMetricKind::ShotsFired: return "shots_fired";
        case PullMetricKind::Seconds: return "seconds";
        case PullMetricKind::DamageDone: return "damage_done";
        case PullMetricKind::DamagePossible: return "damage_possible";
        case PullMetricKind::DamageEfficiency: return "damage_efficiency";
        case PullMetricKind::ScorePerMinute: return "score_per_minute";
        case PullMetricKind::KillsPerSecond: return "kills_per_second";
        case PullMetricKind::Accuracy: return "accuracy";
        case PullMetricKind::KillEfficiency: return "kill_efficiency";
        case PullMetricKind::TimeRemaining: return "time_remaining";
        case PullMetricKind::DistanceTraveled: return "distance_traveled";
        case PullMetricKind::MBS: return "mbs";
        case PullMetricKind::AverageTimeDilationModifier: return "average_time_dilation_modifier";
        case PullMetricKind::AverageTargetSizeModifier: return "average_target_size_modifier";
        case PullMetricKind::Unknown:
        default:
            return "unknown";
        }
    }

    static auto normalize_ascii(const RC::StringType& input) -> std::string {
        std::string out;
        out.reserve(input.size());
        for (const auto ch : input) {
            const auto u = static_cast<uint32_t>(ch);
            if (u >= 'A' && u <= 'Z') {
                out.push_back(static_cast<char>(u + 32));
            } else if (u >= 'a' && u <= 'z') {
                out.push_back(static_cast<char>(u));
            } else if (u >= '0' && u <= '9') {
                out.push_back(static_cast<char>(u));
            } else if (u == '_') {
                // Ignore separators for easier token matching.
            }
        }
        return out;
    }

    static auto classify_pull_metric(const RC::StringType& property_name) -> PullMetricKind {
        const auto n = normalize_ascii(property_name);
        if (n.empty()) {
            return PullMetricKind::Unknown;
        }
        if (n.find("shotsfired") != std::string::npos) return PullMetricKind::ShotsFired;
        if (n.find("shotshit") != std::string::npos) return PullMetricKind::ShotsHit;
        if (n.find("scoreperminute") != std::string::npos || n == "spm") return PullMetricKind::ScorePerMinute;
        if (n.find("killspersecond") != std::string::npos || n == "kps") return PullMetricKind::KillsPerSecond;
        if (n.find("damagepossible") != std::string::npos) return PullMetricKind::DamagePossible;
        if (n.find("damagedone") != std::string::npos) return PullMetricKind::DamageDone;
        if (n.find("accuracy") != std::string::npos || n == "acc") return PullMetricKind::Accuracy;
        if (n.find("killefficiency") != std::string::npos) return PullMetricKind::KillEfficiency;
        if (n.find("timeremaining") != std::string::npos) return PullMetricKind::TimeRemaining;
        if (n.find("distancetraveled") != std::string::npos) return PullMetricKind::DistanceTraveled;
        if (n == "mbs") return PullMetricKind::MBS;
        if (n.find("averagetimedilationmodifier") != std::string::npos) {
            return PullMetricKind::AverageTimeDilationModifier;
        }
        if (n.find("averagetargetsizemodifier") != std::string::npos) {
            return PullMetricKind::AverageTargetSizeModifier;
        }
        if (n.find("damageefficiency") != std::string::npos || n.find("damageeff") != std::string::npos) {
            return PullMetricKind::DamageEfficiency;
        }
        if (n == "kills" || n.find("killcounter") != std::string::npos) return PullMetricKind::Kills;
        if (n == "score"
            || n.find("totalscore") != std::string::npos
            || n.find("currentscore") != std::string::npos
            || n.find("challengescore") != std::string::npos) {
            return PullMetricKind::Score;
        }
        if (n == "seconds" || n == "sessiontime" || n.find("challengeseconds") != std::string::npos) {
            return PullMetricKind::Seconds;
        }
        return PullMetricKind::Unknown;
    }

    static auto should_emit_receiver_prop_probe(const std::string& probe_key) -> bool {
        std::lock_guard<std::mutex> guard(s_state_mutex);
        uint32_t& count = s_receiver_prop_emit_counts[probe_key];
        ++count;
        return count <= 20 || (count % 100) == 0;
    }

    static auto should_emit_stats_prop_probe(const std::string& probe_key) -> bool {
        std::lock_guard<std::mutex> guard(s_state_mutex);
        uint32_t& count = s_stats_prop_emit_counts[probe_key];
        ++count;
        return count <= 20 || (count % 100) == 0;
    }

    static auto append_receiver_numeric_binding(
        std::vector<ReceiverNumericBinding>& bindings,
        std::unordered_set<std::string>& seen_keys,
        RC::Unreal::FNumericProperty* numeric,
        const RC::StringType& property_name,
        RC::Unreal::FObjectPropertyBase* owner_object_property,
        const RC::StringType& owner_property_name
    ) -> bool {
        if (!numeric || !is_likely_valid_object_ptr(numeric) || property_name.empty()) {
            return false;
        }

        ReceiverNumericBinding binding{};
        binding.property = numeric;
        binding.owner_object_property = owner_object_property;
        binding.property_name = property_name;
        binding.owner_property_name = owner_property_name;
        binding.metric = classify_pull_metric(property_name);
        if (binding.metric == PullMetricKind::Unknown && !owner_property_name.empty()) {
            binding.metric = classify_pull_metric(owner_property_name);
        }
        if (binding.metric == PullMetricKind::Unknown && !owner_property_name.empty()) {
            RC::StringType combined_name = owner_property_name;
            combined_name += STR("_");
            combined_name += property_name;
            binding.metric = classify_pull_metric(combined_name);
        }
        binding.is_floating = numeric->IsFloatingPoint();

        RC::StringType emit_name_w = property_name;
        if (!owner_property_name.empty()) {
            emit_name_w = owner_property_name;
            emit_name_w += STR(".");
            emit_name_w += property_name;
        }
        binding.emit_name = utf8_from_wide(emit_name_w);
        if (binding.emit_name.empty()) {
            binding.emit_name = "unnamed_numeric";
        }

        std::array<char, 128> key_buf{};
        std::snprintf(
            key_buf.data(),
            key_buf.size(),
            "%p|%p",
            static_cast<void*>(owner_object_property),
            static_cast<void*>(numeric)
        );
        binding.probe_key = key_buf.data();
        if (!seen_keys.insert(binding.probe_key).second) {
            return false;
        }

        // Log property binding details for debugging
        std::array<char, 256> logbuf{};
        std::snprintf(
            logbuf.data(),
            logbuf.size(),
            "[bind_prop] name=%s owner=%s type=%s is_float=%d metric=%d ptr=%p owner_ptr=%p",
            binding.emit_name.c_str(),
            owner_property_name.empty() ? "<none>" : utf8_from_wide(owner_property_name).c_str(),
            numeric->IsFloatingPoint() ? "float" : "int",
            binding.is_floating ? 1 : 0,
            static_cast<int>(binding.metric),
            static_cast<void*>(numeric),
            static_cast<void*>(owner_object_property)
        );
        runtime_log_line(logbuf.data());
        events_log_line(logbuf.data());
        bindings.emplace_back(std::move(binding));
        return true;
    }

    static auto bind_state_receiver_numeric_properties(RC::Unreal::UObject* receiver) -> bool {
        if (!receiver || !is_likely_valid_object_ptr(receiver)) {
            return false;
        }
        // UObject::ClassPrivate is stable at +0x10 for this game/version.
        auto* receiver_class = *reinterpret_cast<RC::Unreal::UClass**>(
            reinterpret_cast<uint8_t*>(receiver) + 0x10
        );
        if (!receiver_class || !is_likely_valid_object_ptr(receiver_class)) {
            return false;
        }
        if (s_receiver_props_bound_class == receiver_class) {
            return !s_receiver_numeric_bindings.empty();
        }

        s_receiver_props_bound_class = receiver_class;
        s_receiver_numeric_bindings.clear();
        s_receiver_prop_last_bits.clear();
        s_receiver_prop_emit_counts.clear();
        std::unordered_set<std::string> seen_keys{};
        uint32_t direct_count = 0;
        uint32_t one_hop_count = 0;

        for (RC::Unreal::FProperty* property : receiver_class->ForEachPropertyInChain()) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property);
            if (!numeric || !is_likely_valid_object_ptr(numeric)) {
                continue;
            }
            const auto prop_name = property->GetName();
            if (prop_name.empty()) {
                continue;
            }
            if (append_receiver_numeric_binding(
                    s_receiver_numeric_bindings,
                    seen_keys,
                    numeric,
                    prop_name,
                    nullptr,
                    RC::StringType{}
                )) {
                ++direct_count;
            }
        }

        // Shipping builds can strip/flatten numeric fields on the receiver class.
        // Fallback: scan one hop into referenced UObject fields and bind their numeric properties.
        if (s_receiver_numeric_bindings.empty()) {
            for (RC::Unreal::FProperty* property : receiver_class->ForEachPropertyInChain()) {
                if (!property || !is_likely_valid_object_ptr(property)) {
                    continue;
                }
                auto* object_property = RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property);
                if (!object_property || !is_likely_valid_object_ptr(object_property)) {
                    continue;
                }
                const auto object_property_name = property->GetName();
                if (object_property_name.empty()) {
                    continue;
                }

                void* object_value_ptr = object_property->ContainerPtrToValuePtr<void>(
                    reinterpret_cast<void*>(receiver)
                );
                if (!object_value_ptr || !is_likely_readable_region(object_value_ptr, sizeof(void*))) {
                    continue;
                }
                auto* referenced_object = object_property->GetObjectPropertyValue(object_value_ptr);
                if (!referenced_object || !is_likely_valid_object_ptr(referenced_object)) {
                    continue;
                }

                auto* referenced_class = *reinterpret_cast<RC::Unreal::UClass**>(
                    reinterpret_cast<uint8_t*>(referenced_object) + 0x10
                );
                if (!referenced_class || !is_likely_valid_object_ptr(referenced_class)) {
                    continue;
                }

                for (RC::Unreal::FProperty* sub_property : referenced_class->ForEachPropertyInChain()) {
                    if (!sub_property || !is_likely_valid_object_ptr(sub_property)) {
                        continue;
                    }
                    auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(sub_property);
                    if (!numeric || !is_likely_valid_object_ptr(numeric)) {
                        continue;
                    }
                    const auto sub_name = sub_property->GetName();
                    if (sub_name.empty()) {
                        continue;
                    }
                    if (append_receiver_numeric_binding(
                            s_receiver_numeric_bindings,
                            seen_keys,
                            numeric,
                            sub_name,
                            object_property,
                            object_property_name
                        )) {
                        ++one_hop_count;
                    }
                }
            }
        }

        std::array<char, 320> buf{};
        std::snprintf(
            buf.data(),
            buf.size(),
            "[direct_pull] bound %u numeric receiver properties on class=%ls (direct=%u one_hop=%u)",
            static_cast<unsigned>(s_receiver_numeric_bindings.size()),
            receiver_class->GetFullName().c_str(),
            direct_count,
            one_hop_count
        );
        runtime_log_line(buf.data());
        events_log_line(buf.data());
        return !s_receiver_numeric_bindings.empty();
    }

    static auto bind_stats_manager_numeric_properties(RC::Unreal::UObject* stats_manager) -> bool {
        if (!stats_manager || !is_likely_valid_object_ptr(stats_manager)) {
            return false;
        }
        auto* stats_class = *reinterpret_cast<RC::Unreal::UClass**>(
            reinterpret_cast<uint8_t*>(stats_manager) + 0x10
        );
        if (!stats_class || !is_likely_valid_object_ptr(stats_class)) {
            return false;
        }
        if (s_stats_props_bound_class == stats_class) {
            if (!s_stats_numeric_bindings.empty()) {
                return true;
            }
            const auto now = GetTickCount64();
            if (now < s_next_stats_bind_retry_ms) {
                return false;
            }
            // Class stayed the same, but previous bind was empty.
            // Retry periodically because referenced members can appear later in session lifecycle.
            s_next_stats_bind_retry_ms = now + 1000;
        }

        s_stats_props_bound_class = stats_class;
        s_stats_numeric_bindings.clear();
        s_stats_prop_last_bits.clear();
        s_stats_prop_emit_counts.clear();
        std::unordered_set<std::string> seen_keys{};
        uint32_t direct_count = 0;
        uint32_t one_hop_count = 0;

        for (RC::Unreal::FProperty* property : stats_class->ForEachPropertyInChain()) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property);
            if (!numeric || !is_likely_valid_object_ptr(numeric)) {
                continue;
            }
            const auto prop_name = property->GetName();
            if (prop_name.empty()) {
                continue;
            }
            if (append_receiver_numeric_binding(
                    s_stats_numeric_bindings,
                    seen_keys,
                    numeric,
                    prop_name,
                    nullptr,
                    RC::StringType{}
                )) {
                ++direct_count;
            }
        }

        if (s_stats_numeric_bindings.empty()) {
            for (RC::Unreal::FProperty* property : stats_class->ForEachPropertyInChain()) {
                if (!property || !is_likely_valid_object_ptr(property)) {
                    continue;
                }
                auto* object_property = RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property);
                if (!object_property || !is_likely_valid_object_ptr(object_property)) {
                    continue;
                }
                const auto object_property_name = property->GetName();
                if (object_property_name.empty()) {
                    continue;
                }

                void* object_value_ptr = object_property->ContainerPtrToValuePtr<void>(
                    reinterpret_cast<void*>(stats_manager)
                );
                if (!object_value_ptr || !is_likely_readable_region(object_value_ptr, sizeof(void*))) {
                    continue;
                }
                auto* referenced_object = object_property->GetObjectPropertyValue(object_value_ptr);
                if (!referenced_object || !is_likely_valid_object_ptr(referenced_object)) {
                    continue;
                }

                auto* referenced_class = *reinterpret_cast<RC::Unreal::UClass**>(
                    reinterpret_cast<uint8_t*>(referenced_object) + 0x10
                );
                if (!referenced_class || !is_likely_valid_object_ptr(referenced_class)) {
                    continue;
                }

                for (RC::Unreal::FProperty* sub_property : referenced_class->ForEachPropertyInChain()) {
                    if (!sub_property || !is_likely_valid_object_ptr(sub_property)) {
                        continue;
                    }
                    auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(sub_property);
                    if (!numeric || !is_likely_valid_object_ptr(numeric)) {
                        continue;
                    }
                    const auto sub_name = sub_property->GetName();
                    if (sub_name.empty()) {
                        continue;
                    }
                    if (append_receiver_numeric_binding(
                            s_stats_numeric_bindings,
                            seen_keys,
                            numeric,
                            sub_name,
                            object_property,
                            object_property_name
                        )) {
                        ++one_hop_count;
                    }
                }
            }
        }

        std::array<char, 320> buf{};
        std::snprintf(
            buf.data(),
            buf.size(),
            "[direct_pull] bound %u stats numeric properties on class=%ls (direct=%u one_hop=%u)",
            static_cast<unsigned>(s_stats_numeric_bindings.size()),
            stats_class->GetFullName().c_str(),
            direct_count,
            one_hop_count
        );
        runtime_log_line(buf.data());
        events_log_line(buf.data());
        if (!s_stats_numeric_bindings.empty()) {
            s_next_stats_bind_retry_ms = 0;
        }
        return !s_stats_numeric_bindings.empty();
    }

    static auto should_emit_probe_for(RC::Unreal::UFunction* function) -> bool {
        std::lock_guard<std::mutex> guard(s_state_mutex);
        uint32_t& count = s_probe_counts[function];
        ++count;
        return count <= 20 || (count % 100) == 0;
    }

    static auto try_read_probe_scalar(const void* parms, size_t offset, uint32_t& u32_out, int32_t& i32_out, float& f32_out) -> bool {
        if (!parms) {
            return false;
        }
        const auto* ptr = reinterpret_cast<const uint8_t*>(parms) + offset;
        if (!is_likely_readable_region(ptr, sizeof(uint32_t))) {
            return false;
        }
        std::memcpy(&u32_out, ptr, sizeof(u32_out));
        std::memcpy(&i32_out, ptr, sizeof(i32_out));
        std::memcpy(&f32_out, ptr, sizeof(f32_out));
        return true;
    }

    static auto safe_extract_frame50(
        RC::Unreal::FFrame& stack,
        RC::Unreal::UFunction*& out_function,
        RC::Unreal::UObject*& out_object,
        void*& out_locals
    ) -> bool {
        out_function = nullptr;
        out_object = nullptr;
        out_locals = nullptr;
        __try {
            auto* frame_50 = reinterpret_cast<RC::Unreal::FFrame_50_AndBelow*>(&stack);
            if (!frame_50) {
                return false;
            }
            out_function = frame_50->Node;
            out_object = frame_50->Object;
            out_locals = static_cast<void*>(frame_50->Locals);
            return true;
        } __except(EXCEPTION_EXECUTE_HANDLER) {
            return false;
        }
    }

    static auto poll_session_statistics_ui_text(uint64_t now_ms, bool emit_detail_events) -> bool {
        if (now_ms < s_next_ui_poll_ms) {
            return false;
        }
        s_next_ui_poll_ms = now_ms + 200;
        EmitContextScope emit_ctx(
            "ui_poll",
            s_ui_counter_fallback_enabled ? "ui_counter_fallback" : "ui_poll"
        );
        const bool allow_counter_metric_emits = s_ui_counter_fallback_enabled;

        std::vector<RC::Unreal::UObject*> text_blocks{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("TextBlock"), text_blocks);
        if (text_blocks.empty()) {
            return false;
        }

        struct UiPollSelection {
            RC::StringType wide_value{};
            std::string utf8_value{};
            std::string source_path_utf8{};
            bool has_digit{false};
            bool has_counter_value{false};
            int32_t counter_value{0};
        };

        std::unordered_map<std::string, UiPollSelection> selected_by_field{};
        bool emitted_any = false;
        uint32_t scanned = 0;
        uint32_t emitted = 0;
        const auto maybe_emit_ui_pull_f32 = [](const char* ev, float& last, float value) {
            if (!std::isfinite(value) || value < 0.0f) {
                return;
            }
            if (std::fabs(last - value) > 0.0001f) {
                last = value;
                emit_float_event(ev, value);
            }
        };

        for (auto* obj : text_blocks) {
            if (!obj || !is_likely_valid_object_ptr(obj)) {
                continue;
            }
            const auto full_name = obj->GetFullName();
            if (full_name.find(STR("SessionStatistics")) == RC::StringType::npos
                && full_name.find(STR("DistScore")) == RC::StringType::npos
                && full_name.find(STR("ChallengeScore")) == RC::StringType::npos
                && full_name.find(STR("SumScore")) == RC::StringType::npos) {
                continue;
            }
            const auto* ui_field = classify_session_ui_field(full_name);
            if (!ui_field) {
                continue;
            }
            ++scanned;

            RC::StringType text_value{};
            if (!read_textblock_text_value(obj, text_value)) {
                continue;
            }
            const auto text_utf8 = utf8_from_wide(text_value);
            if (text_utf8.empty()) {
                continue;
            }
            const std::string field_key(ui_field);
            int32_t parsed_i32 = 0;
            const bool parsed_ok = try_parse_int_text(text_value, parsed_i32);
            const bool is_counter = is_counter_ui_field(field_key);
            const bool has_digit = has_ascii_digit(text_utf8);

            auto& selected = selected_by_field[field_key];
            bool take = false;
            if (selected.utf8_value.empty()) {
                take = true;
            } else if (is_counter && parsed_ok) {
                if (!selected.has_counter_value || parsed_i32 > selected.counter_value) {
                    take = true;
                } else if (parsed_i32 == selected.counter_value && text_utf8.size() > selected.utf8_value.size()) {
                    take = true;
                }
            } else {
                if (has_digit && !selected.has_digit) {
                    take = true;
                } else if (has_digit == selected.has_digit && text_utf8.size() > selected.utf8_value.size()) {
                    take = true;
                }
            }
            if (!take) {
                continue;
            }
            selected.wide_value = text_value;
            selected.utf8_value = text_utf8;
            selected.source_path_utf8 = utf8_from_wide(full_name);
            selected.has_digit = has_digit;
            selected.has_counter_value = is_counter && parsed_ok;
            if (selected.has_counter_value) {
                selected.counter_value = parsed_i32;
            }
        }

        for (const auto& [field_key, selected] : selected_by_field) {
            if (selected.utf8_value.empty()) {
                continue;
            }
            const auto it = s_ui_poll_last_values.find(field_key);
            if (it != s_ui_poll_last_values.end() && it->second == selected.utf8_value) {
                continue;
            }
            s_ui_poll_last_values[field_key] = selected.utf8_value;
            ++emitted;
            emitted_any = true;
            if (emit_detail_events) {
                s_ui_field_update_calls.fetch_add(1, std::memory_order_relaxed);
                const auto value_escaped = escape_json(selected.utf8_value);
                std::string msg = std::string("{\"ev\":\"ui_field_update\",\"field\":\"")
                    + field_key + "\",\"value\":\"" + value_escaped + "\",\"source\":\"ui_poll\"}";
                kovaaks::RustBridge::emit_json(msg.c_str());
            }

            if (selected.has_counter_value) {
                const int32_t parsed_i32 = selected.counter_value;
                if (field_key == "session_shots") {
                    s_ui_last_session_shots = parsed_i32;
                    if (emit_detail_events) {
                        emit_derived_counter_event(
                            "session_shots",
                            "derived_shots_total",
                            "derived_shots_delta",
                            parsed_i32,
                            s_ui_last_session_shots
                        );
                    }
                    if (allow_counter_metric_emits && s_last_pull_shots_fired != parsed_i32) {
                        s_last_pull_shots_fired = parsed_i32;
                        if (parsed_i32 > 0) {
                            s_last_nonzero_shots_fired_ms = now_ms;
                        }
                        emit_int_event("pull_shots_fired_total", parsed_i32);
                        emit_ui_pull_source_once("pull_shots_fired_total", field_key, selected.source_path_utf8, static_cast<double>(parsed_i32));
                    }
                } else if (field_key == "session_hits") {
                    s_ui_last_session_hits = parsed_i32;
                    if (emit_detail_events) {
                        emit_derived_counter_event(
                            "session_hits",
                            "derived_hits_total",
                            "derived_hits_delta",
                            parsed_i32,
                            s_ui_last_session_hits
                        );
                    }
                    if (allow_counter_metric_emits && s_last_pull_shots_hit != parsed_i32) {
                        s_last_pull_shots_hit = parsed_i32;
                        if (parsed_i32 > 0) {
                            s_last_nonzero_shots_hit_ms = now_ms;
                        }
                        emit_int_event("pull_shots_hit_total", parsed_i32);
                        emit_ui_pull_source_once("pull_shots_hit_total", field_key, selected.source_path_utf8, static_cast<double>(parsed_i32));
                    }
                } else if (field_key == "session_kills") {
                    s_ui_last_session_kills = parsed_i32;
                    if (emit_detail_events) {
                        emit_derived_counter_event(
                            "session_kills",
                            "derived_kills_total",
                            "derived_kills_delta",
                            parsed_i32,
                            s_ui_last_session_kills
                        );
                    }
                    if (allow_counter_metric_emits && s_last_pull_kills != parsed_i32) {
                        s_last_pull_kills = parsed_i32;
                        if (parsed_i32 > 0) {
                            s_last_nonzero_kills_ms = now_ms;
                        }
                        emit_int_event("pull_kills_total", parsed_i32);
                        emit_ui_pull_source_once("pull_kills_total", field_key, selected.source_path_utf8, static_cast<double>(parsed_i32));
                    }
                }
                continue;
            }

            float parsed_f32 = 0.0f;
            if (field_key == "session_time") {
                if (allow_counter_metric_emits && try_parse_time_to_seconds(selected.wide_value, parsed_f32)) {
                    maybe_emit_ui_pull_f32("pull_seconds_total", s_last_pull_seconds, parsed_f32);
                    emit_ui_pull_source_once("pull_seconds_total", field_key, selected.source_path_utf8, static_cast<double>(parsed_f32));
                }
            } else if (field_key == "session_score") {
                if (allow_counter_metric_emits && try_parse_float_text(selected.wide_value, parsed_f32)) {
                    if (parsed_f32 > 0.0f) {
                        s_last_nonzero_score_ms = now_ms;
                    }
                    maybe_emit_ui_pull_f32("pull_score_total", s_last_pull_score, parsed_f32);
                    emit_ui_pull_source_once("pull_score_total", field_key, selected.source_path_utf8, static_cast<double>(parsed_f32));
                }
            } else if (field_key == "session_spm") {
                if (allow_counter_metric_emits && try_parse_float_text(selected.wide_value, parsed_f32)) {
                    maybe_emit_ui_pull_f32("pull_score_per_minute", s_last_pull_spm, parsed_f32);
                    emit_ui_pull_source_once("pull_score_per_minute", field_key, selected.source_path_utf8, static_cast<double>(parsed_f32));
                }
            } else if (field_key == "session_kps") {
                if (allow_counter_metric_emits && try_parse_float_text(selected.wide_value, parsed_f32)) {
                    maybe_emit_ui_pull_f32("pull_kills_per_second", s_last_pull_kps, parsed_f32);
                    emit_ui_pull_source_once("pull_kills_per_second", field_key, selected.source_path_utf8, static_cast<double>(parsed_f32));
                }
            } else if (field_key == "session_damage_done") {
                if (allow_counter_metric_emits && try_parse_float_text(selected.wide_value, parsed_f32)) {
                    maybe_emit_ui_pull_f32("pull_damage_done", s_last_pull_damage_done, parsed_f32);
                    emit_ui_pull_source_once("pull_damage_done", field_key, selected.source_path_utf8, static_cast<double>(parsed_f32));
                }
            } else if (field_key == "session_damage_possible") {
                if (allow_counter_metric_emits && try_parse_float_text(selected.wide_value, parsed_f32)) {
                    maybe_emit_ui_pull_f32("pull_damage_possible", s_last_pull_damage_possible, parsed_f32);
                    emit_ui_pull_source_once("pull_damage_possible", field_key, selected.source_path_utf8, static_cast<double>(parsed_f32));
                }
            } else if (field_key == "session_damage_eff") {
                if (allow_counter_metric_emits && try_parse_float_text(selected.wide_value, parsed_f32)) {
                    maybe_emit_ui_pull_f32("pull_damage_efficiency", s_last_pull_damage_efficiency, parsed_f32);
                    emit_ui_pull_source_once("pull_damage_efficiency", field_key, selected.source_path_utf8, static_cast<double>(parsed_f32));
                }
            }

            if (emit_detail_events) {
                maybe_emit_derived_ui_counter(field_key.c_str(), selected.wide_value);
            }
        }

        if ((s_non_ui_probe_enabled || s_log_all_events) && emitted > 0) {
            std::array<char, 192> lbuf{};
            std::snprintf(
                lbuf.data(),
                lbuf.size(),
                "[ui_poll] scanned=%u emitted=%u detail=%u origin=ui_poll origin_flag=%s",
                scanned,
                emitted,
                emit_detail_events ? 1u : 0u,
                s_ui_counter_fallback_enabled ? "ui_counter_fallback" : "ui_poll"
            );
            events_log_line(lbuf.data());
        }
        return emitted_any;
    }

    static auto poll_live_score_ui_text(uint64_t now_ms, float& out_score) -> bool {
        out_score = 0.0f;
        static uint64_t s_next_score_ui_poll_ms = 0;
        static std::string s_last_score_ui_source{};
        if (now_ms < s_next_score_ui_poll_ms) {
            return false;
        }
        s_next_score_ui_poll_ms = now_ms + 100; // up to 10Hz for live score
        EmitContextScope emit_ctx(
            "score_ui_poll",
            s_score_ui_fallback_enabled ? "score_ui_fallback" : "score_ui_poll"
        );

        std::vector<RC::Unreal::UObject*> text_blocks{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("TextBlock"), text_blocks);
        if (text_blocks.empty()) {
            return false;
        }

        bool found_any = false;
        float best_value = 0.0f;
        int best_rank = -1000000;
        RC::StringType best_source{};
        for (auto* obj : text_blocks) {
            if (!obj || !is_likely_valid_object_ptr(obj)) {
                continue;
            }
            const auto full_name = obj->GetFullName();
            if (full_name.find(STR("DistScore")) == RC::StringType::npos
                && full_name.find(STR("ChallengeScore")) == RC::StringType::npos
                && full_name.find(STR("SumScore")) == RC::StringType::npos) {
                continue;
            }

            RC::StringType text_value{};
            if (!read_textblock_text_value(obj, text_value)) {
                continue;
            }

            float parsed = 0.0f;
            if (!try_parse_float_text(text_value, parsed) || !std::isfinite(parsed)) {
                continue;
            }

            int rank = 0;
            if (full_name.find(STR("DistScore")) != RC::StringType::npos) rank += 300;
            if (full_name.find(STR("ChallengeScore")) != RC::StringType::npos) rank += 250;
            if (full_name.find(STR("SumScore")) != RC::StringType::npos) rank += 200;
            if (full_name.find(STR("PlayerUI")) != RC::StringType::npos) rank += 80;
            if (full_name.find(STR("PauseMenu")) != RC::StringType::npos) rank -= 400;
            if (full_name.find(STR("Leaderboard")) != RC::StringType::npos) rank -= 500;
            if (full_name.find(STR("PlayerOnLeaderboard")) != RC::StringType::npos) rank -= 500;
            if (full_name.find(STR("GameUI")) != RC::StringType::npos) rank += 120;
            if (full_name.find(STR("SessionStatistics")) != RC::StringType::npos) rank += 160;
            if (parsed <= 0.0f) rank -= 220;
            rank += static_cast<int>(std::fabs(static_cast<double>(parsed)));

            if (!found_any || rank > best_rank) {
                found_any = true;
                best_rank = rank;
                best_value = parsed;
                best_source = full_name;
            }
        }

        if (!found_any) {
            return false;
        }

        if (best_value <= 0.0f && s_last_pull_score > 0.0f && (now_ms - s_last_nonzero_score_ms) < 3000) {
            return false;
        }

        out_score = best_value;
        const auto source_utf8 = utf8_from_wide(best_source);
        if ((s_non_ui_probe_enabled || s_log_all_events)
            && source_utf8 != s_last_score_ui_source) {
            s_last_score_ui_source = source_utf8;
            const auto src_escaped = escape_json(source_utf8);
            std::array<char, 640> msg{};
            std::snprintf(
                msg.data(),
                msg.size(),
                "{\"ev\":\"score_ui_source\",\"source\":\"%s\",\"rank\":%d}",
                src_escaped.c_str(),
                best_rank
            );
            kovaaks::RustBridge::emit_json(msg.data());
        }
        return true;
    }

    template <size_t N>
    static auto resolve_class_cached(
        RC::Unreal::UClass*& cached,
        const std::array<const wchar_t*, N>& class_paths,
        const char* tag
    ) -> RC::Unreal::UClass* {
        if (cached && is_likely_valid_object_ptr(cached)) {
            return cached;
        }
        for (const auto* path : class_paths) {
            if (!path) {
                continue;
            }
            auto* cls = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UClass*>(nullptr, nullptr, path);
            if (cls && is_likely_valid_object_ptr(cls)) {
                cached = cls;
                std::array<char, 512> buf{};
                std::snprintf(
                    buf.data(),
                    buf.size(),
                    "[class_resolve] tag=%s path=%ls class=%ls",
                    tag,
                    path,
                    cls->GetFullName().c_str()
                );
                runtime_log_line(buf.data());
                events_log_line(buf.data());
                return cached;
            }
        }
        return nullptr;
    }

    static auto append_unique_objects(std::vector<RC::Unreal::UObject*>& dst, const std::vector<RC::Unreal::UObject*>& src) -> void {
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

    static auto collect_objects_by_class(RC::Unreal::UClass* target_class, std::vector<RC::Unreal::UObject*>& out) -> void {
        if (!target_class || !is_likely_valid_object_ptr(target_class)) {
            return;
        }
        const auto class_name = target_class->GetName();
        if (class_name.empty()) {
            return;
        }
        RC::Unreal::UObjectGlobals::FindAllOf(class_name, out);
    }

    static auto resolve_meta_game_instance(uint64_t now_ms) -> RC::Unreal::UObject* {
        if (s_meta_game_instance && is_likely_valid_object_ptr(s_meta_game_instance) && now_ms < s_next_meta_resolve_ms) {
            return s_meta_game_instance;
        }
        s_next_meta_resolve_ms = now_ms + 2000;

        std::vector<RC::Unreal::UObject*> found_all{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("TheMetaGameInstance_C"), found_all);
        std::vector<RC::Unreal::UObject*> found_name_alt{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("GTheMetaGameInstance"), found_name_alt);
        append_unique_objects(found_all, found_name_alt);

        const auto name_hits = found_all.size();
        const bool do_class_scan = true;
        size_t class_hits = 0;
        if (do_class_scan) {
            auto* cls = resolve_class_cached(
                s_meta_game_instance_class,
                std::array<const wchar_t*, 3>{
                    STR("/Script/GameSkillsTrainer.GTheMetaGameInstance"),
                    STR("/Script/GameSkillsTrainer.TheMetaGameInstance_C"),
                    STR("/Script/GameSkillsTrainer.GTheMetaGameInstance_C")
                },
                "meta_instance"
            );
            std::vector<RC::Unreal::UObject*> by_class{};
            collect_objects_by_class(cls, by_class);
            class_hits = by_class.size();
            append_unique_objects(found_all, by_class);
        }

        RC::Unreal::UObject* best = nullptr;
        int best_score = -1000000;
        for (auto* obj : found_all) {
            if (!obj || !is_likely_valid_object_ptr(obj)) {
                continue;
            }
            const auto full_name = obj->GetFullName();
            const auto object_path = object_path_from_full_name(full_name);
            int score = 0;
            if (full_name.find(STR("Default__")) != RC::StringType::npos) score -= 1000;
            if (full_name.find(STR("/Script/")) != RC::StringType::npos) score -= 100;
            if (full_name.find(STR("/Engine/Transient.GameEngine_")) != RC::StringType::npos) score += 200;
            if (full_name.find(STR(":TheMetaGameInstance_C_")) != RC::StringType::npos) score += 300;
            if (object_path.find(STR("/Engine/Transient.GameEngine_")) == 0) score += 200;
            if (object_path.find(STR(":")) == RC::StringType::npos &&
                object_path.find(STR("TheMetaGameInstance_C_")) != RC::StringType::npos) score += 200;
            if (!best || score > best_score) {
                best = obj;
                best_score = score;
            }
        }

        if (best && is_likely_valid_object_ptr(best)) {
            const bool changed = (best != s_meta_game_instance);
            s_meta_game_instance = best;
            if (changed) {
                const auto object_path = object_path_from_full_name(best->GetFullName());
                std::array<char, 384> buf{};
                std::snprintf(
                    buf.data(),
                    buf.size(),
                    "[direct_pull] resolved meta_instance=%ls path=%ls name_hits=%u class_hits=%u merged=%u score=%d",
                    best->GetFullName().c_str(),
                    object_path.c_str(),
                    static_cast<unsigned>(name_hits),
                    static_cast<unsigned>(class_hits),
                    static_cast<unsigned>(found_all.size()),
                    best_score
                );
                runtime_log_line(buf.data());
                events_log_line(buf.data());
            }
        }
        return s_meta_game_instance;
    }

    static auto resolve_state_receiver_instance(uint64_t now_ms) -> RC::Unreal::UObject* {
        if (s_state_receiver_instance && is_likely_valid_object_ptr(s_state_receiver_instance) && now_ms < s_next_receiver_resolve_ms) {
            return s_state_receiver_instance;
        }
        s_next_receiver_resolve_ms = now_ms + 2000;
        auto* meta_instance = resolve_meta_game_instance(now_ms);
        RC::StringType meta_name{};
        RC::StringType meta_path{};
        if (meta_instance && is_likely_valid_object_ptr(meta_instance)) {
            meta_name = meta_instance->GetFullName();
            meta_path = object_path_from_full_name(meta_name);
        }

        std::vector<RC::Unreal::UObject*> found_all{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("PerformanceIndicatorsStateReceiver"), found_all);
        std::vector<RC::Unreal::UObject*> found_name_alt{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("PerformanceIndicatorsStateReceiver_C"), found_name_alt);
        append_unique_objects(found_all, found_name_alt);

        const auto name_hits = found_all.size();
        const bool do_class_scan = found_all.empty() || s_log_all_events || s_object_debug_enabled || s_non_ui_probe_enabled;
        size_t class_hits = 0;
        if (do_class_scan) {
            auto* cls = resolve_class_cached(
                s_state_receiver_class,
                std::array<const wchar_t*, 3>{
                    STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver"),
                    STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver_C"),
                    STR("/Game/FirstPersonBP/Blueprints/PerformanceIndicatorsStateReceiver.PerformanceIndicatorsStateReceiver_C")
                },
                "state_receiver"
            );
            std::vector<RC::Unreal::UObject*> by_class{};
            collect_objects_by_class(cls, by_class);
            class_hits = by_class.size();
            append_unique_objects(found_all, by_class);
        }

        auto score_candidate = [](const RC::StringType& full_name) -> int {
            int score = 0;
            if (full_name.find(STR("Default__")) != RC::StringType::npos) score -= 1000;
            if (full_name.find(STR("/Script/")) != RC::StringType::npos) score -= 100;
            if (full_name.find(STR("/Engine/Transient.")) != RC::StringType::npos) score += 40;
            if (full_name.find(STR("TheMetaGameInstance")) != RC::StringType::npos) score += 200;
            if (full_name.find(STR("PerformanceIndicatorsStateReceiver_")) != RC::StringType::npos) score += 120;
            return score;
        };

        RC::Unreal::UObject* best = nullptr;
        RC::Unreal::UObject* best_meta_scoped = nullptr;
        int best_score = -1000000;
        int best_meta_scoped_score = -1000000;
        for (auto* obj : found_all) {
            if (!obj || !is_likely_valid_object_ptr(obj)) {
                continue;
            }
            const auto full_name = obj->GetFullName();
            const auto object_path = object_path_from_full_name(full_name);
            const int score = score_candidate(full_name);
            if (!best || score > best_score) {
                best = obj;
                best_score = score;
            }
            if (!meta_path.empty()) {
                RC::StringType outer_prefix = meta_path;
                outer_prefix += STR(".");
                if (object_path.rfind(outer_prefix, 0) == 0) {
                    if (!best_meta_scoped || score > best_meta_scoped_score) {
                        best_meta_scoped = obj;
                        best_meta_scoped_score = score;
                    }
                }
            }
        }

        auto* found = best_meta_scoped ? best_meta_scoped : best;
        const int chosen_score = best_meta_scoped ? best_meta_scoped_score : best_score;
        if (!found || !is_likely_valid_object_ptr(found)) {
            found = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UObject*>(
                nullptr,
                nullptr,
                STR("/Script/KovaaKFramework.Default__PerformanceIndicatorsStateReceiver")
            );
        }
        if (!found || !is_likely_valid_object_ptr(found)) {
            if (s_state_receiver_instance && is_likely_valid_object_ptr(s_state_receiver_instance)) {
                return s_state_receiver_instance;
            }
            const auto misses = s_direct_poll_resolve_misses.fetch_add(1, std::memory_order_relaxed) + 1;
            if ((misses % 30ull) == 1ull) {
                events_log_line("[direct_pull] receiver resolve miss");
            }
            return nullptr;
        }

        const bool changed = (found != s_state_receiver_instance);
        if (changed && s_state_receiver_instance) {
            s_direct_poll_reselects.fetch_add(1, std::memory_order_relaxed);
        }
        if (changed) {
            std::lock_guard<std::mutex> guard(s_state_mutex);
            s_invoke_numeric_last_bits.clear();
        }
        s_state_receiver_instance = found;
        s_direct_poll_resolve_hits.fetch_add(1, std::memory_order_relaxed);
        if (changed || s_log_all_events) {
            std::array<char, 512> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "[direct_pull] resolved receiver=%ls name_hits=%u class_hits=%u merged=%u score=%d meta_scoped=%u changed=%u meta_path=%ls",
                found->GetFullName().c_str(),
                static_cast<unsigned>(name_hits),
                static_cast<unsigned>(class_hits),
                static_cast<unsigned>(found_all.size()),
                chosen_score,
                best_meta_scoped ? 1u : 0u,
                changed ? 1u : 0u,
                meta_path.c_str()
            );
            runtime_log_line(buf.data());
            events_log_line(buf.data());
        }
        if (!best_meta_scoped && !meta_path.empty()) {
            std::array<char, 512> mbuf{};
            std::snprintf(
                mbuf.data(),
                mbuf.size(),
                "[direct_pull] meta scope mismatch receiver_path=%ls meta_path=%ls",
                object_path_from_full_name(found->GetFullName()).c_str(),
                meta_path.c_str()
            );
            runtime_log_line(mbuf.data());
            events_log_line(mbuf.data());
        }
        return found;
    }

    static auto resolve_scenario_state_receiver_instance(uint64_t now_ms) -> RC::Unreal::UObject* {
        if (s_scenario_state_receiver_instance && is_likely_valid_object_ptr(s_scenario_state_receiver_instance)
            && now_ms < s_next_scenario_receiver_resolve_ms) {
            return s_scenario_state_receiver_instance;
        }
        s_next_scenario_receiver_resolve_ms = now_ms + 2000;
        auto* meta_instance = resolve_meta_game_instance(now_ms);
        RC::StringType meta_path{};
        if (meta_instance && is_likely_valid_object_ptr(meta_instance)) {
            meta_path = object_path_from_full_name(meta_instance->GetFullName());
        }

        std::vector<RC::Unreal::UObject*> found_all{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("ScenarioStateReceiver"), found_all);
        std::vector<RC::Unreal::UObject*> found_name_alt{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("ScenarioStateReceiver_C"), found_name_alt);
        append_unique_objects(found_all, found_name_alt);

        const auto name_hits = found_all.size();
        const bool do_class_scan = found_all.empty() || s_log_all_events || s_object_debug_enabled || s_non_ui_probe_enabled;
        size_t class_hits = 0;
        if (do_class_scan) {
            auto* cls = resolve_class_cached(
                s_scenario_state_receiver_class,
                std::array<const wchar_t*, 3>{
                    STR("/Script/KovaaKFramework.ScenarioStateReceiver"),
                    STR("/Script/KovaaKFramework.ScenarioStateReceiver_C"),
                    STR("/Game/FirstPersonBP/Blueprints/ScenarioStateReceiver.ScenarioStateReceiver_C")
                },
                "scenario_state_receiver"
            );
            std::vector<RC::Unreal::UObject*> by_class{};
            collect_objects_by_class(cls, by_class);
            class_hits = by_class.size();
            append_unique_objects(found_all, by_class);
        }

        auto score_candidate = [](const RC::StringType& full_name) -> int {
            int score = 0;
            if (full_name.find(STR("Default__")) != RC::StringType::npos) score -= 1000;
            if (full_name.find(STR("/Script/")) != RC::StringType::npos) score -= 100;
            if (full_name.find(STR("/Engine/Transient.")) != RC::StringType::npos) score += 40;
            if (full_name.find(STR("TheMetaGameInstance")) != RC::StringType::npos) score += 200;
            if (full_name.find(STR("ScenarioStateReceiver_")) != RC::StringType::npos) score += 120;
            return score;
        };

        RC::Unreal::UObject* best = nullptr;
        RC::Unreal::UObject* best_meta_scoped = nullptr;
        int best_score = -1000000;
        int best_meta_scoped_score = -1000000;
        for (auto* obj : found_all) {
            if (!obj || !is_likely_valid_object_ptr(obj)) {
                continue;
            }
            const auto full_name = obj->GetFullName();
            const auto object_path = object_path_from_full_name(full_name);
            const int score = score_candidate(full_name);
            if (!best || score > best_score) {
                best = obj;
                best_score = score;
            }
            if (!meta_path.empty()) {
                RC::StringType outer_prefix = meta_path;
                outer_prefix += STR(".");
                if (object_path.rfind(outer_prefix, 0) == 0) {
                    if (!best_meta_scoped || score > best_meta_scoped_score) {
                        best_meta_scoped = obj;
                        best_meta_scoped_score = score;
                    }
                }
            }
        }

        auto* found = best_meta_scoped ? best_meta_scoped : best;
        const int chosen_score = best_meta_scoped ? best_meta_scoped_score : best_score;
        if (!found || !is_likely_valid_object_ptr(found)) {
            found = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UObject*>(
                nullptr,
                nullptr,
                STR("/Script/KovaaKFramework.Default__ScenarioStateReceiver")
            );
        }
        if (!found || !is_likely_valid_object_ptr(found)) {
            return s_scenario_state_receiver_instance;
        }

        const bool changed = (found != s_scenario_state_receiver_instance);
        s_scenario_state_receiver_instance = found;
        if (changed || s_log_all_events) {
            std::array<char, 512> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "[direct_pull] resolved scenario_receiver=%ls name_hits=%u class_hits=%u merged=%u score=%d meta_scoped=%u changed=%u meta_path=%ls",
                found->GetFullName().c_str(),
                static_cast<unsigned>(name_hits),
                static_cast<unsigned>(class_hits),
                static_cast<unsigned>(found_all.size()),
                chosen_score,
                best_meta_scoped ? 1u : 0u,
                changed ? 1u : 0u,
                meta_path.c_str()
            );
            runtime_log_line(buf.data());
            events_log_line(buf.data());
        }
        return found;
    }

    static auto resolve_stats_manager_instance(uint64_t now_ms) -> RC::Unreal::UObject* {
        if (s_stats_manager_instance && is_likely_valid_object_ptr(s_stats_manager_instance)
            && now_ms < s_next_stats_manager_resolve_ms) {
            return s_stats_manager_instance;
        }
        s_next_stats_manager_resolve_ms = now_ms + 2000;
        auto* meta_instance = resolve_meta_game_instance(now_ms);
        RC::StringType meta_path{};
        if (meta_instance && is_likely_valid_object_ptr(meta_instance)) {
            meta_path = object_path_from_full_name(meta_instance->GetFullName());
        }

        std::vector<RC::Unreal::UObject*> found_all{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("StatsManager"), found_all);
        std::vector<RC::Unreal::UObject*> found_name_alt{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("StatsManager_C"), found_name_alt);
        append_unique_objects(found_all, found_name_alt);

        const auto name_hits = found_all.size();
        const bool do_class_scan = found_all.empty() || s_log_all_events || s_object_debug_enabled || s_non_ui_probe_enabled;
        size_t class_hits = 0;
        if (do_class_scan) {
            auto* cls = resolve_class_cached(
                s_stats_manager_class,
                std::array<const wchar_t*, 2>{
                    STR("/Script/GameSkillsTrainer.StatsManager"),
                    STR("/Script/GameSkillsTrainer.StatsManager_C")
                },
                "stats_manager"
            );
            std::vector<RC::Unreal::UObject*> by_class{};
            collect_objects_by_class(cls, by_class);
            class_hits = by_class.size();
            append_unique_objects(found_all, by_class);
        }

        auto score_candidate = [](const RC::StringType& full_name) -> int {
            int score = 0;
            if (full_name.find(STR("Default__")) != RC::StringType::npos) score -= 1000;
            if (full_name.find(STR("/Script/")) != RC::StringType::npos) score -= 100;
            if (full_name.find(STR("/Engine/Transient.")) != RC::StringType::npos) score += 40;
            if (full_name.find(STR("TheMetaGameInstance")) != RC::StringType::npos) score += 240;
            if (full_name.find(STR("StatsManager_")) != RC::StringType::npos) score += 120;
            return score;
        };

        RC::Unreal::UObject* best = nullptr;
        RC::Unreal::UObject* best_meta_scoped = nullptr;
        int best_score = -1000000;
        int best_meta_scoped_score = -1000000;
        for (auto* obj : found_all) {
            if (!obj || !is_likely_valid_object_ptr(obj)) {
                continue;
            }
            const auto full_name = obj->GetFullName();
            const auto object_path = object_path_from_full_name(full_name);
            const int score = score_candidate(full_name);
            if (!best || score > best_score) {
                best = obj;
                best_score = score;
            }
            if (!meta_path.empty()) {
                RC::StringType outer_prefix = meta_path;
                outer_prefix += STR(".");
                if (object_path.rfind(outer_prefix, 0) == 0) {
                    if (!best_meta_scoped || score > best_meta_scoped_score) {
                        best_meta_scoped = obj;
                        best_meta_scoped_score = score;
                    }
                }
            }
        }

        auto* found = best_meta_scoped ? best_meta_scoped : best;
        const int chosen_score = best_meta_scoped ? best_meta_scoped_score : best_score;
        if (!found || !is_likely_valid_object_ptr(found)) {
            found = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UObject*>(
                nullptr,
                nullptr,
                STR("/Script/GameSkillsTrainer.Default__StatsManager")
            );
        }
        if (!found || !is_likely_valid_object_ptr(found)) {
            return s_stats_manager_instance;
        }

        const bool changed = (found != s_stats_manager_instance);
        s_stats_manager_instance = found;
        if (changed) {
            s_stats_props_bound_class = nullptr;
            s_stats_numeric_bindings.clear();
            s_stats_prop_last_bits.clear();
            s_stats_prop_emit_counts.clear();
            s_next_stats_bind_retry_ms = 0;
        }
        if (changed || s_log_all_events) {
            std::array<char, 512> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "[direct_pull] resolved stats_manager=%ls name_hits=%u class_hits=%u merged=%u score=%d meta_scoped=%u changed=%u meta_path=%ls",
                found->GetFullName().c_str(),
                static_cast<unsigned>(name_hits),
                static_cast<unsigned>(class_hits),
                static_cast<unsigned>(found_all.size()),
                chosen_score,
                best_meta_scoped ? 1u : 0u,
                changed ? 1u : 0u,
                meta_path.c_str()
            );
            runtime_log_line(buf.data());
            events_log_line(buf.data());
        }
        return found;
    }

    static auto resolve_scenario_manager_instance(uint64_t now_ms) -> RC::Unreal::UObject* {
        if (s_scenario_manager_instance && is_likely_valid_object_ptr(s_scenario_manager_instance)
            && now_ms < s_next_scenario_manager_resolve_ms) {
            return s_scenario_manager_instance;
        }
        s_next_scenario_manager_resolve_ms = now_ms + 2000;
        auto* meta_instance = resolve_meta_game_instance(now_ms);
        RC::StringType meta_path{};
        if (meta_instance && is_likely_valid_object_ptr(meta_instance)) {
            meta_path = object_path_from_full_name(meta_instance->GetFullName());
        }

        std::vector<RC::Unreal::UObject*> found_all{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("ScenarioManager"), found_all);
        std::vector<RC::Unreal::UObject*> found_name_alt{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("ScenarioManager_C"), found_name_alt);
        append_unique_objects(found_all, found_name_alt);

        const auto name_hits = found_all.size();
        size_t class_hits = 0;
        {
            auto* cls = resolve_class_cached(
                s_scenario_manager_class,
                std::array<const wchar_t*, 2>{
                    STR("/Script/GameSkillsTrainer.ScenarioManager"),
                    STR("/Script/GameSkillsTrainer.ScenarioManager_C")
                },
                "scenario_manager"
            );
            std::vector<RC::Unreal::UObject*> by_class{};
            collect_objects_by_class(cls, by_class);
            class_hits = by_class.size();
            append_unique_objects(found_all, by_class);
        }

        auto score_candidate = [](const RC::StringType& full_name) -> int {
            int score = 0;
            if (full_name.find(STR("Default__")) != RC::StringType::npos) score -= 1000;
            if (full_name.find(STR("/Script/")) != RC::StringType::npos) score -= 100;
            if (full_name.find(STR("/Engine/Transient.")) != RC::StringType::npos) score += 40;
            if (full_name.find(STR("TheMetaGameInstance")) != RC::StringType::npos) score += 220;
            if (full_name.find(STR("ScenarioManager_")) != RC::StringType::npos) score += 120;
            return score;
        };

        RC::Unreal::UObject* best = nullptr;
        RC::Unreal::UObject* best_meta_scoped = nullptr;
        int best_score = -1000000;
        int best_meta_scoped_score = -1000000;
        for (auto* obj : found_all) {
            if (!obj || !is_likely_valid_object_ptr(obj)) {
                continue;
            }
            const auto full_name = obj->GetFullName();
            const auto object_path = object_path_from_full_name(full_name);
            const int score = score_candidate(full_name);
            if (!best || score > best_score) {
                best = obj;
                best_score = score;
            }
            if (!meta_path.empty()) {
                RC::StringType outer_prefix = meta_path;
                outer_prefix += STR(".");
                if (object_path.rfind(outer_prefix, 0) == 0) {
                    if (!best_meta_scoped || score > best_meta_scoped_score) {
                        best_meta_scoped = obj;
                        best_meta_scoped_score = score;
                    }
                }
            }
        }

        auto* found = best_meta_scoped ? best_meta_scoped : best;
        const int chosen_score = best_meta_scoped ? best_meta_scoped_score : best_score;
        if (!found || !is_likely_valid_object_ptr(found)) {
            found = RC::Unreal::UObjectGlobals::StaticFindObject<RC::Unreal::UObject*>(
                nullptr,
                nullptr,
                STR("/Script/GameSkillsTrainer.Default__ScenarioManager")
            );
        }
        if (!found || !is_likely_valid_object_ptr(found)) {
            return s_scenario_manager_instance;
        }

        const bool changed = (found != s_scenario_manager_instance);
        s_scenario_manager_instance = found;
        if (changed || s_log_all_events) {
            std::array<char, 512> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "[direct_pull] resolved scenario_manager=%ls name_hits=%u class_hits=%u merged=%u score=%d meta_scoped=%u changed=%u meta_path=%ls",
                found->GetFullName().c_str(),
                static_cast<unsigned>(name_hits),
                static_cast<unsigned>(class_hits),
                static_cast<unsigned>(found_all.size()),
                chosen_score,
                best_meta_scoped ? 1u : 0u,
                changed ? 1u : 0u,
                meta_path.c_str()
            );
            runtime_log_line(buf.data());
            events_log_line(buf.data());
        }
        return found;
    }

    static auto resolve_sandbox_session_stats_instance(uint64_t now_ms) -> RC::Unreal::UObject* {
        if (s_sandbox_session_stats_instance && is_likely_valid_object_ptr(s_sandbox_session_stats_instance)
            && now_ms < s_next_sandbox_stats_resolve_ms) {
            return s_sandbox_session_stats_instance;
        }
        s_next_sandbox_stats_resolve_ms = now_ms + 1000;

        auto* meta_instance = resolve_meta_game_instance(now_ms);
        RC::StringType meta_path{};
        if (meta_instance && is_likely_valid_object_ptr(meta_instance)) {
            meta_path = object_path_from_full_name(meta_instance->GetFullName());
        }

        RC::Unreal::UObject* found = nullptr;
        if (meta_instance && is_likely_valid_object_ptr(meta_instance) && s_targets.meta_get_sandbox_session_stats) {
            found = invoke_object_ufunction(meta_instance, s_targets.meta_get_sandbox_session_stats);
        }

        if (!found || !is_likely_valid_object_ptr(found)) {
            std::vector<RC::Unreal::UObject*> found_all{};
            RC::Unreal::UObjectGlobals::FindAllOf(STR("SandboxSessionStats"), found_all);
            std::vector<RC::Unreal::UObject*> found_name_alt{};
            RC::Unreal::UObjectGlobals::FindAllOf(STR("SandboxSessionStats_C"), found_name_alt);
            append_unique_objects(found_all, found_name_alt);

            auto score_candidate = [](const RC::StringType& full_name) -> int {
                int score = 0;
                if (full_name.find(STR("Default__")) != RC::StringType::npos) score -= 1000;
                if (full_name.find(STR("/Script/")) != RC::StringType::npos) score -= 100;
                if (full_name.find(STR("/Engine/Transient.")) != RC::StringType::npos) score += 40;
                if (full_name.find(STR("TheMetaGameInstance")) != RC::StringType::npos) score += 220;
                if (full_name.find(STR("SandboxSessionStats_")) != RC::StringType::npos) score += 120;
                return score;
            };

            RC::Unreal::UObject* best = nullptr;
            RC::Unreal::UObject* best_meta_scoped = nullptr;
            int best_score = -1000000;
            int best_meta_scoped_score = -1000000;
            for (auto* obj : found_all) {
                if (!obj || !is_likely_valid_object_ptr(obj)) {
                    continue;
                }
                const auto full_name = obj->GetFullName();
                const auto object_path = object_path_from_full_name(full_name);
                const int score = score_candidate(full_name);
                if (!best || score > best_score) {
                    best = obj;
                    best_score = score;
                }
                if (!meta_path.empty()) {
                    RC::StringType outer_prefix = meta_path;
                    outer_prefix += STR(".");
                    if (object_path.rfind(outer_prefix, 0) == 0) {
                        if (!best_meta_scoped || score > best_meta_scoped_score) {
                            best_meta_scoped = obj;
                            best_meta_scoped_score = score;
                        }
                    }
                }
            }
            found = best_meta_scoped ? best_meta_scoped : best;
        }

        if (!found || !is_likely_valid_object_ptr(found)) {
            return s_sandbox_session_stats_instance;
        }

        const bool changed = (found != s_sandbox_session_stats_instance);
        s_sandbox_session_stats_instance = found;
        if (changed || s_log_all_events || s_non_ui_probe_enabled) {
            std::array<char, 512> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "[direct_pull] resolved sandbox_session_stats=%ls changed=%u meta_path=%ls",
                found->GetFullName().c_str(),
                changed ? 1u : 0u,
                meta_path.c_str()
            );
            runtime_log_line(buf.data());
            events_log_line(buf.data());
        }
        return found;
    }

    static auto resolve_function_owner_class(RC::Unreal::UFunction* fn) -> RC::Unreal::UClass* {
        if (!fn || !is_likely_valid_object_ptr(fn)) {
            return nullptr;
        }
        {
            std::lock_guard<std::mutex> guard(s_state_mutex);
            const auto it = s_cached_owner_class.find(fn);
            if (it != s_cached_owner_class.end() && is_likely_valid_object_ptr(it->second)) {
                return it->second;
            }
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
            nullptr,
            nullptr,
            class_path.c_str()
        );
        if (owner_class && is_likely_valid_object_ptr(owner_class)) {
            std::lock_guard<std::mutex> guard(s_state_mutex);
            s_cached_owner_class[fn] = owner_class;
            return owner_class;
        }
        return nullptr;
    }

    static auto resolve_class_default_object(RC::Unreal::UClass* owner_class) -> RC::Unreal::UObject* {
        if (!owner_class || !is_likely_valid_object_ptr(owner_class)) {
            return nullptr;
        }
        // UE4.26/4.27 layout: UClass::ClassDefaultObject at +0x118.
        auto* cdo = *reinterpret_cast<RC::Unreal::UObject**>(
            reinterpret_cast<uint8_t*>(owner_class) + 0x118
        );
        if (cdo && is_likely_valid_object_ptr(cdo)) {
            return cdo;
        }
        return nullptr;
    }

    static auto resolve_receive_caller(RC::Unreal::UObject* preferred, RC::Unreal::UFunction* fn) -> RC::Unreal::UObject* {
        if (!fn || !is_likely_valid_object_ptr(fn)) {
            return nullptr;
        }
        auto* owner_class = resolve_function_owner_class(fn);
        if (owner_class && is_likely_valid_object_ptr(owner_class)
            && fn->HasAnyFunctionFlags(RC::Unreal::FUNC_Static)) {
            if (auto* cdo = resolve_class_default_object(owner_class)) {
                return cdo;
            }
        }
        if (owner_class && is_likely_valid_object_ptr(owner_class)) {
            if (preferred && is_likely_valid_object_ptr(preferred) && preferred->IsA(owner_class)) {
                return preferred;
            }
            if (s_meta_game_instance && is_likely_valid_object_ptr(s_meta_game_instance)
                && s_meta_game_instance->IsA(owner_class)) {
                return s_meta_game_instance;
            }
            if (auto* cdo = resolve_class_default_object(owner_class)) {
                return cdo;
            }
        }
        if (preferred && is_likely_valid_object_ptr(preferred)) {
            return preferred;
        }
        if (s_meta_game_instance && is_likely_valid_object_ptr(s_meta_game_instance)) {
            return s_meta_game_instance;
        }
        return nullptr;
    }

    static auto make_invoke_numeric_probe_key(
        const RC::Unreal::UFunction* fn,
        const RC::Unreal::FNumericProperty* output_numeric,
        bool is_floating
    ) -> uint64_t {
        const uint64_t fn_bits = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(fn));
        const uint64_t out_bits = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(output_numeric));
        uint64_t key = fn_bits ^ (out_bits + 0x9e3779b97f4a7c15ull + (fn_bits << 6) + (fn_bits >> 2));
        if (is_floating) {
            key ^= 0xa5a5a5a5a5a5a5a5ull;
        } else {
            key ^= 0x5a5a5a5a5a5a5a5aull;
        }
        return key;
    }

    static auto should_log_invoke_numeric_change(
        const RC::Unreal::UFunction* fn,
        const RC::Unreal::FNumericProperty* output_numeric,
        bool is_floating,
        uint64_t value_bits
    ) -> bool {
        if (!fn || !output_numeric) {
            return false;
        }
        const uint64_t key = make_invoke_numeric_probe_key(fn, output_numeric, is_floating);
        std::lock_guard<std::mutex> guard(s_state_mutex);
        const auto it = s_invoke_numeric_last_bits.find(key);
        if (it != s_invoke_numeric_last_bits.end() && it->second == value_bits) {
            return false;
        }
        s_invoke_numeric_last_bits[key] = value_bits;
        return true;
    }

    struct NumericInvokeResult {
        bool valid{false};
        bool is_floating{false};
        double as_float{0.0};
        int64_t as_int{0};
    };

    static auto invoke_numeric_ufunction(
        RC::Unreal::UObject* receiver,
        RC::Unreal::UFunction* fn
    ) -> NumericInvokeResult {
        NumericInvokeResult result{};
        auto* caller = resolve_receive_caller(receiver, fn);
        if (!caller || !fn || !is_likely_valid_object_ptr(fn)) {
            if (!fn) {
                s_direct_poll_null_fn.fetch_add(1, std::memory_order_relaxed);
            }
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
        bool has_latent_action_info_param = false;
        const auto fn_name_ascii = normalize_ascii(fn->GetName());

        for (RC::Unreal::FProperty* property : fn->ForEachProperty()) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property->HasAnyPropertyFlags(RC::Unreal::CPF_Parm)) {
                continue;
            }

            const auto name = property->GetName();
            const auto normalized_name = normalize_ascii(name);
            if (normalized_name == "latentactioninfo") {
                has_latent_action_info_param = true;
            }
            const bool is_out = property->HasAnyPropertyFlags(RC::Unreal::CPF_OutParm)
                || property->HasAnyPropertyFlags(RC::Unreal::CPF_ReturnParm);
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
                } else if (property->HasAnyPropertyFlags(RC::Unreal::CPF_ReturnParm)) {
                    priority = 3;
                } else if (property->HasAnyPropertyFlags(RC::Unreal::CPF_OutParm)) {
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
                    void* value_ptr = property->ContainerPtrToValuePtr<void>(params.data());
                    if (value_ptr && is_likely_readable_region(value_ptr, sizeof(void*))) {
                        RC::Unreal::UObject* context_object = nullptr;
                        if (s_meta_game_instance && is_likely_valid_object_ptr(s_meta_game_instance)) {
                            context_object = s_meta_game_instance;
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
                    void* value_ptr = property->ContainerPtrToValuePtr<void>(params.data());
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

        if (has_latent_action_info_param && fn_name_ascii.rfind("receive_", 0) == 0) {
            if (s_non_ui_probe_enabled || s_log_all_events) {
                static std::atomic<uint64_t> s_skip_latent_logs{0};
                const auto idx = s_skip_latent_logs.fetch_add(1, std::memory_order_relaxed);
                if (idx < 80) {
                    std::array<char, 768> lbuf{};
                    std::snprintf(
                        lbuf.data(),
                        lbuf.size(),
                        "[invoke_numeric] skip latent receive fn=%ls caller=%ls parm_size=%d",
                        fn->GetFullName().c_str(),
                        caller->GetFullName().c_str(),
                        param_size
                    );
                    events_log_line(lbuf.data());
                }
            }
            return result;
        }

        if (!output_numeric || !is_likely_valid_object_ptr(output_numeric)) {
            if (s_non_ui_probe_enabled || s_log_all_events) {
                static std::atomic<uint64_t> s_missing_output_logs{0};
                const auto idx = s_missing_output_logs.fetch_add(1, std::memory_order_relaxed);
                if (idx < 40) {
                    std::array<char, 640> mbuf{};
                    std::snprintf(
                        mbuf.data(),
                        mbuf.size(),
                        "[invoke_numeric] no output numeric param fn=%ls caller=%ls parm_size=%d",
                        fn->GetFullName().c_str(),
                        caller->GetFullName().c_str(),
                        param_size
                    );
                    events_log_line(mbuf.data());
                }
            }
            return result;
        }

        caller->ProcessEvent(fn, params.data());

        void* output_ptr = output_numeric->ContainerPtrToValuePtr<void>(params.data());
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
            if (s_non_ui_probe_enabled || s_log_all_events) {
                uint64_t bits = 0;
                std::memcpy(&bits, &value, sizeof(bits));
                if (should_log_invoke_numeric_change(fn, output_numeric, true, bits)) {
                    std::array<char, 768> ibuf{};
                    std::snprintf(
                        ibuf.data(),
                        ibuf.size(),
                        "[invoke_numeric] fn=%ls caller=%ls out=%ls kind=float value=%.6f flags=0x%llx parm_size=%d",
                        fn->GetFullName().c_str(),
                        caller->GetFullName().c_str(),
                        output_numeric->GetName().c_str(),
                        value,
                        static_cast<unsigned long long>(output_numeric->GetPropertyFlags()),
                        param_size
                    );
                    events_log_line(ibuf.data());
                }
            }
            return result;
        }

        if (output_numeric->IsInteger()) {
            result.valid = true;
            result.is_floating = false;
            result.as_int = output_numeric->GetSignedIntPropertyValue(output_ptr);
            if (s_non_ui_probe_enabled || s_log_all_events) {
                const uint64_t bits = static_cast<uint64_t>(result.as_int);
                if (should_log_invoke_numeric_change(fn, output_numeric, false, bits)) {
                    std::array<char, 768> ibuf{};
                    std::snprintf(
                        ibuf.data(),
                        ibuf.size(),
                        "[invoke_numeric] fn=%ls caller=%ls out=%ls kind=int value=%lld flags=0x%llx parm_size=%d",
                        fn->GetFullName().c_str(),
                        caller->GetFullName().c_str(),
                        output_numeric->GetName().c_str(),
                        static_cast<long long>(result.as_int),
                        static_cast<unsigned long long>(output_numeric->GetPropertyFlags()),
                        param_size
                    );
                    events_log_line(ibuf.data());
                }
            }
            return result;
        }

        return result;
    }

    static auto invoke_object_ufunction(
        RC::Unreal::UObject* receiver,
        RC::Unreal::UFunction* fn
    ) -> RC::Unreal::UObject* {
        auto* caller = resolve_receive_caller(receiver, fn);
        if (!caller || !fn || !is_likely_valid_object_ptr(fn)) {
            if (!fn) {
                s_direct_poll_null_fn.fetch_add(1, std::memory_order_relaxed);
            }
            return nullptr;
        }

        int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x10000) {
            param_size = 0x200;
        }
        std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);

        RC::Unreal::FObjectPropertyBase* output_object = nullptr;
        int output_priority = -1;

        for (RC::Unreal::FProperty* property : fn->ForEachProperty()) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property->HasAnyPropertyFlags(RC::Unreal::CPF_Parm)) {
                continue;
            }

            auto* object_property = RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property);
            if (!object_property || !is_likely_valid_object_ptr(object_property)) {
                continue;
            }

            const auto normalized_name = normalize_ascii(property->GetName());
            if (normalized_name.find("worldcontextobject") != std::string::npos) {
                void* value_ptr = property->ContainerPtrToValuePtr<void>(params.data());
                if (value_ptr && is_likely_readable_region(value_ptr, sizeof(void*))) {
                    RC::Unreal::UObject* context_object = nullptr;
                    if (s_meta_game_instance && is_likely_valid_object_ptr(s_meta_game_instance)) {
                        context_object = s_meta_game_instance;
                    } else if (receiver && is_likely_valid_object_ptr(receiver)) {
                        context_object = receiver;
                    } else {
                        context_object = caller;
                    }
                    object_property->SetObjectPropertyValue(value_ptr, context_object);
                }
            }

            const bool is_out = property->HasAnyPropertyFlags(RC::Unreal::CPF_OutParm)
                || property->HasAnyPropertyFlags(RC::Unreal::CPF_ReturnParm);
            const bool has_output_name = (normalized_name == "outvalue" || normalized_name == "returnvalue");
            if (!(is_out || has_output_name)) {
                continue;
            }

            int priority = 0;
            if (normalized_name == "outvalue") {
                priority = 5;
            } else if (normalized_name == "returnvalue") {
                priority = 4;
            } else if (property->HasAnyPropertyFlags(RC::Unreal::CPF_ReturnParm)) {
                priority = 3;
            } else if (property->HasAnyPropertyFlags(RC::Unreal::CPF_OutParm)) {
                priority = 2;
            } else {
                priority = 1;
            }
            if (!output_object || priority > output_priority) {
                output_object = object_property;
                output_priority = priority;
            }
        }

        if (!output_object || !is_likely_valid_object_ptr(output_object)) {
            return nullptr;
        }

        caller->ProcessEvent(fn, params.data());

        void* output_ptr = output_object->ContainerPtrToValuePtr<void>(params.data());
        if (!output_ptr || !is_likely_readable_region(output_ptr, sizeof(void*))) {
            return nullptr;
        }
        auto* value = output_object->GetObjectPropertyValue(output_ptr);
        if (!value || !is_likely_valid_object_ptr(value)) {
            return nullptr;
        }
        return value;
    }

    struct ScoreNativeSnapshot {
        bool has_score{};
        bool has_kills{};
        bool has_shots_hit{};
        bool has_shots_fired{};
        bool has_accuracy{};
        bool has_damage_done{};
        bool has_damage_possible{};
        bool has_damage_efficiency{};
        bool has_kill_efficiency{};
        bool has_time_remaining{};
        bool has_distance_traveled{};
        bool has_mbs{};
        bool has_average_time_dilation_modifier{};
        bool has_average_target_size_modifier{};
        bool has_mult_average_time_dilation_modifier{};
        bool has_mult_average_target_size_modifier{};
        float score{};
        float accuracy{};
        float damage_done{};
        float damage_possible{};
        float damage_efficiency{};
        float kill_efficiency{};
        float time_remaining{};
        float distance_traveled{};
        float mbs{};
        float average_time_dilation_modifier{};
        float average_target_size_modifier{};
        bool mult_average_time_dilation_modifier{};
        bool mult_average_target_size_modifier{};
        int32_t kills{};
        int32_t shots_hit{};
        int32_t shots_fired{};
    };

    static auto score_snapshot_has_any_value(const ScoreNativeSnapshot& s) -> bool {
        return s.has_score
            || s.has_kills
            || s.has_shots_hit
            || s.has_shots_fired
            || s.has_accuracy
            || s.has_damage_done
            || s.has_damage_possible
            || s.has_damage_efficiency
            || s.has_kill_efficiency
            || s.has_time_remaining
            || s.has_distance_traveled
            || s.has_mbs
            || s.has_average_time_dilation_modifier
            || s.has_average_target_size_modifier
            || s.has_mult_average_time_dilation_modifier
            || s.has_mult_average_target_size_modifier;
    }

    static auto score_snapshot_changed(const ScoreNativeSnapshot& prev, const ScoreNativeSnapshot& cur) -> bool {
        auto float_changed = [](float a, float b) -> bool {
            if (!std::isfinite(a) && !std::isfinite(b)) {
                return false;
            }
            if (!std::isfinite(a) || !std::isfinite(b)) {
                return true;
            }
            return std::fabs(static_cast<double>(a) - static_cast<double>(b)) > 0.0001;
        };

        if (prev.has_score != cur.has_score
            || prev.has_kills != cur.has_kills
            || prev.has_shots_hit != cur.has_shots_hit
            || prev.has_shots_fired != cur.has_shots_fired
            || prev.has_accuracy != cur.has_accuracy
            || prev.has_damage_done != cur.has_damage_done
            || prev.has_damage_possible != cur.has_damage_possible
            || prev.has_damage_efficiency != cur.has_damage_efficiency
            || prev.has_kill_efficiency != cur.has_kill_efficiency
            || prev.has_time_remaining != cur.has_time_remaining
            || prev.has_distance_traveled != cur.has_distance_traveled
            || prev.has_mbs != cur.has_mbs
            || prev.has_average_time_dilation_modifier != cur.has_average_time_dilation_modifier
            || prev.has_average_target_size_modifier != cur.has_average_target_size_modifier
            || prev.has_mult_average_time_dilation_modifier != cur.has_mult_average_time_dilation_modifier
            || prev.has_mult_average_target_size_modifier != cur.has_mult_average_target_size_modifier) {
            return true;
        }

        if (prev.has_score && float_changed(prev.score, cur.score)) return true;
        if (prev.has_kills && prev.kills != cur.kills) return true;
        if (prev.has_shots_hit && prev.shots_hit != cur.shots_hit) return true;
        if (prev.has_shots_fired && prev.shots_fired != cur.shots_fired) return true;
        if (prev.has_accuracy && float_changed(prev.accuracy, cur.accuracy)) return true;
        if (prev.has_damage_done && float_changed(prev.damage_done, cur.damage_done)) return true;
        if (prev.has_damage_possible && float_changed(prev.damage_possible, cur.damage_possible)) return true;
        if (prev.has_damage_efficiency && float_changed(prev.damage_efficiency, cur.damage_efficiency)) return true;
        if (prev.has_kill_efficiency && float_changed(prev.kill_efficiency, cur.kill_efficiency)) return true;
        if (prev.has_time_remaining && float_changed(prev.time_remaining, cur.time_remaining)) return true;
        if (prev.has_distance_traveled && float_changed(prev.distance_traveled, cur.distance_traveled)) return true;
        if (prev.has_mbs && float_changed(prev.mbs, cur.mbs)) return true;
        if (prev.has_average_time_dilation_modifier
            && float_changed(prev.average_time_dilation_modifier, cur.average_time_dilation_modifier)) return true;
        if (prev.has_average_target_size_modifier
            && float_changed(prev.average_target_size_modifier, cur.average_target_size_modifier)) return true;
        if (prev.has_mult_average_time_dilation_modifier
            && prev.mult_average_time_dilation_modifier != cur.mult_average_time_dilation_modifier) return true;
        if (prev.has_mult_average_target_size_modifier
            && prev.mult_average_target_size_modifier != cur.mult_average_target_size_modifier) return true;
        return false;
    }

    static auto score_snapshot_is_missing_sentinel(const ScoreNativeSnapshot& s) -> bool {
        bool has_any = false;
        bool sentinel = true;
        auto float_is_sentinel = [](float v) -> bool {
            return std::isfinite(v) && v <= -0.999f;
        };
        if (s.has_score) { has_any = true; sentinel = sentinel && float_is_sentinel(s.score); }
        if (s.has_kills) { has_any = true; sentinel = sentinel && s.kills == -1; }
        if (s.has_shots_hit) { has_any = true; sentinel = sentinel && s.shots_hit == -1; }
        if (s.has_shots_fired) { has_any = true; sentinel = sentinel && s.shots_fired == -1; }
        if (s.has_accuracy) { has_any = true; sentinel = sentinel && float_is_sentinel(s.accuracy); }
        if (s.has_damage_done) { has_any = true; sentinel = sentinel && float_is_sentinel(s.damage_done); }
        if (s.has_damage_possible) { has_any = true; sentinel = sentinel && float_is_sentinel(s.damage_possible); }
        if (s.has_damage_efficiency) { has_any = true; sentinel = sentinel && float_is_sentinel(s.damage_efficiency); }
        if (s.has_kill_efficiency) { has_any = true; sentinel = sentinel && float_is_sentinel(s.kill_efficiency); }
        if (s.has_time_remaining) { has_any = true; sentinel = sentinel && float_is_sentinel(s.time_remaining); }
        if (s.has_distance_traveled) { has_any = true; sentinel = sentinel && float_is_sentinel(s.distance_traveled); }
        if (s.has_mbs) { has_any = true; sentinel = sentinel && float_is_sentinel(s.mbs); }
        if (s.has_average_time_dilation_modifier) {
            has_any = true;
            sentinel = sentinel && float_is_sentinel(s.average_time_dilation_modifier);
        }
        if (s.has_average_target_size_modifier) {
            has_any = true;
            sentinel = sentinel && float_is_sentinel(s.average_target_size_modifier);
        }
        if (s.has_mult_average_time_dilation_modifier) {
            has_any = true;
            sentinel = false;
        }
        if (s.has_mult_average_target_size_modifier) {
            has_any = true;
            sentinel = false;
        }
        return has_any && sentinel;
    }

    static auto resolve_struct_property_script_struct(RC::Unreal::FStructProperty* struct_property) -> RC::Unreal::UScriptStruct* {
        if (!struct_property || !is_likely_valid_object_ptr(struct_property)) {
            return nullptr;
        }
        const auto it = RC::Unreal::FStructProperty::MemberOffsets.find(STR("Struct"));
        if (it == RC::Unreal::FStructProperty::MemberOffsets.end()) {
            return nullptr;
        }
        const int32_t offset = it->second;
        if (offset <= 0 || offset > 0x400) {
            return nullptr;
        }
        auto** script_struct_ptr = reinterpret_cast<RC::Unreal::UScriptStruct**>(
            reinterpret_cast<uint8_t*>(struct_property) + static_cast<size_t>(offset)
        );
        if (!script_struct_ptr || !is_likely_readable_region(script_struct_ptr, sizeof(void*))) {
            return nullptr;
        }
        auto* script_struct = *script_struct_ptr;
        if (!script_struct || !is_likely_valid_object_ptr(script_struct)) {
            return nullptr;
        }
        return script_struct;
    }

    static auto set_struct_numeric_valueifnull_sentinel(
        RC::Unreal::UScriptStruct* script_struct,
        void* struct_ptr
    ) -> void {
        if (!script_struct || !is_likely_valid_object_ptr(script_struct) || !struct_ptr) {
            return;
        }
        for (RC::Unreal::FProperty* field : script_struct->ForEachPropertyInChain()) {
            if (!field || !is_likely_valid_object_ptr(field)) {
                continue;
            }
            auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(field);
            if (!numeric || !is_likely_valid_object_ptr(numeric)) {
                continue;
            }
            void* field_ptr = field->ContainerPtrToValuePtr<void>(struct_ptr);
            if (!field_ptr || !is_likely_readable_region(field_ptr, sizeof(double))) {
                continue;
            }
            if (numeric->IsFloatingPoint()) {
                numeric->SetFloatingPointPropertyValue(field_ptr, -1.0);
            } else if (numeric->IsInteger()) {
                numeric->SetIntPropertyValue(field_ptr, static_cast<int64_t>(-1));
            }
        }
    }

    static auto invoke_score_native_ufunction(
        RC::Unreal::UObject* receiver,
        RC::Unreal::UFunction* fn,
        ScoreNativeSnapshot& out_snapshot
    ) -> bool {
        out_snapshot = {};
        if (!fn || !is_likely_valid_object_ptr(fn)) {
            return false;
        }

        int32_t param_size = static_cast<int32_t>(fn->GetParmsSize());
        if (param_size <= 0 || param_size > 0x4000) {
            param_size = fn->GetPropertiesSize();
        }
        if (param_size <= 0 || param_size > 0x4000) {
            param_size = 0x400;
        }
        auto* owner_class = resolve_function_owner_class(fn);
        const bool fn_is_static = fn->HasAnyFunctionFlags(RC::Unreal::FUNC_Static);
        auto* resolved_caller = resolve_receive_caller(receiver, fn);
        auto* owner_cdo = resolve_class_default_object(owner_class);

        std::array<RC::Unreal::UObject*, 8> candidates{
            receiver,
            s_scenario_state_receiver_instance,
            s_state_receiver_instance,
            s_meta_game_instance,
            resolved_caller,
            owner_cdo,
            nullptr,
            nullptr
        };

        bool found_any_candidate = false;
        int32_t best_signal = -1;
        ScoreNativeSnapshot best_snapshot{};
        std::unordered_set<RC::Unreal::UObject*> seen_callers{};

        for (auto* caller : candidates) {
            if (!caller || !is_likely_valid_object_ptr(caller)) {
                continue;
            }
            if (!seen_callers.emplace(caller).second) {
                continue;
            }

            if (!fn_is_static && owner_class && is_likely_valid_object_ptr(owner_class) && !caller->IsA(owner_class)) {
                continue;
            }

            std::vector<uint8_t> params(static_cast<size_t>(param_size), 0);
            RC::Unreal::FStructProperty* out_struct = nullptr;
            int out_priority = -1;

            for (RC::Unreal::FProperty* property : fn->ForEachProperty()) {
                if (!property || !is_likely_valid_object_ptr(property)) {
                    continue;
                }
                if (!property->HasAnyPropertyFlags(RC::Unreal::CPF_Parm)) {
                    continue;
                }
                const auto normalized_name = normalize_ascii(property->GetName());
                if (auto* object_property = RC::Unreal::CastField<RC::Unreal::FObjectPropertyBase>(property)) {
                    if (normalized_name.find("worldcontextobject") != std::string::npos) {
                        void* value_ptr = property->ContainerPtrToValuePtr<void>(params.data());
                        if (value_ptr && is_likely_readable_region(value_ptr, sizeof(void*))) {
                            RC::Unreal::UObject* context_object = nullptr;
                            if (s_meta_game_instance && is_likely_valid_object_ptr(s_meta_game_instance)) {
                                context_object = s_meta_game_instance;
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

                auto* struct_property = RC::Unreal::CastField<RC::Unreal::FStructProperty>(property);
                if (!struct_property || !is_likely_valid_object_ptr(struct_property)) {
                    continue;
                }
                if (normalized_name.find("valueifnull") != std::string::npos) {
                    void* value_ptr = property->ContainerPtrToValuePtr<void>(params.data());
                    if (value_ptr) {
                        auto* valueifnull_struct = resolve_struct_property_script_struct(struct_property);
                        set_struct_numeric_valueifnull_sentinel(valueifnull_struct, value_ptr);
                    }
                }

                const bool is_out = property->HasAnyPropertyFlags(RC::Unreal::CPF_OutParm)
                    || property->HasAnyPropertyFlags(RC::Unreal::CPF_ReturnParm);
                const bool has_output_name = (normalized_name == "outvalue" || normalized_name == "returnvalue");
                if (!(is_out || has_output_name)) {
                    continue;
                }
                int priority = 0;
                if (normalized_name == "outvalue") {
                    priority = 5;
                } else if (normalized_name == "returnvalue") {
                    priority = 4;
                } else if (property->HasAnyPropertyFlags(RC::Unreal::CPF_ReturnParm)) {
                    priority = 3;
                } else if (property->HasAnyPropertyFlags(RC::Unreal::CPF_OutParm)) {
                    priority = 2;
                } else {
                    priority = 1;
                }
                if (!out_struct || priority > out_priority) {
                    out_struct = struct_property;
                    out_priority = priority;
                }
            }

            if (!out_struct || !is_likely_valid_object_ptr(out_struct)) {
                continue;
            }

            caller->ProcessEvent(fn, params.data());

            void* struct_ptr = out_struct->ContainerPtrToValuePtr<void>(params.data());
            if (!struct_ptr) {
                continue;
            }
            auto* script_struct = resolve_struct_property_script_struct(out_struct);
            if (!script_struct || !is_likely_valid_object_ptr(script_struct)) {
                continue;
            }
            int32_t struct_size = script_struct->GetPropertiesSize();
            if (struct_size <= 0 || struct_size > 0x4000) {
                struct_size = 0x100;
            }
            if (!is_likely_readable_region(struct_ptr, static_cast<size_t>(struct_size))) {
                continue;
            }

            ScoreNativeSnapshot current{};
            bool found_any = false;
            for (RC::Unreal::FProperty* property : script_struct->ForEachPropertyInChain()) {
                if (!property || !is_likely_valid_object_ptr(property)) {
                    continue;
                }
                const auto field = normalize_ascii(property->GetName());
                if (field.empty()) {
                    continue;
                }
                void* value_ptr = property->ContainerPtrToValuePtr<void>(struct_ptr);
                if (!value_ptr) {
                    continue;
                }
                if (auto* bool_property = RC::Unreal::CastField<RC::Unreal::FBoolProperty>(property);
                    bool_property && is_likely_valid_object_ptr(bool_property)) {
                    if (!is_likely_readable_region(value_ptr, sizeof(uint8_t))) {
                        continue;
                    }
                    const bool bv = bool_property->GetPropertyValue(value_ptr);
                    if (field == "multaveragetimedilationmodifier") {
                        current.has_mult_average_time_dilation_modifier = true;
                        current.mult_average_time_dilation_modifier = bv;
                        found_any = true;
                    } else if (field == "multaveragetargetsizemodifier") {
                        current.has_mult_average_target_size_modifier = true;
                        current.mult_average_target_size_modifier = bv;
                        found_any = true;
                    }
                    continue;
                }

                auto* numeric = RC::Unreal::CastField<RC::Unreal::FNumericProperty>(property);
                if (!numeric || !is_likely_valid_object_ptr(numeric)) {
                    continue;
                }
                if (!is_likely_readable_region(value_ptr, sizeof(double))) {
                    continue;
                }

                if (numeric->IsFloatingPoint()) {
                    const double value = numeric->GetFloatingPointPropertyValue(value_ptr);
                    if (!std::isfinite(value)) {
                        continue;
                    }
                    const float fv = static_cast<float>(value);
                    if (field == "score") {
                        current.has_score = true;
                        current.score = fv;
                        found_any = true;
                    } else if (field == "accuracy") {
                        current.has_accuracy = true;
                        current.accuracy = fv;
                        found_any = true;
                    } else if (field == "damagedone") {
                        current.has_damage_done = true;
                        current.damage_done = fv;
                        found_any = true;
                    } else if (field == "damagepossible") {
                        current.has_damage_possible = true;
                        current.damage_possible = fv;
                        found_any = true;
                    } else if (field == "damageefficiency") {
                        current.has_damage_efficiency = true;
                        current.damage_efficiency = fv;
                        found_any = true;
                    } else if (field == "killefficiency") {
                        current.has_kill_efficiency = true;
                        current.kill_efficiency = fv;
                        found_any = true;
                    } else if (field == "timeremaining") {
                        current.has_time_remaining = true;
                        current.time_remaining = fv;
                        found_any = true;
                    } else if (field == "distancetraveled") {
                        current.has_distance_traveled = true;
                        current.distance_traveled = fv;
                        found_any = true;
                    } else if (field == "mbs") {
                        current.has_mbs = true;
                        current.mbs = fv;
                        found_any = true;
                    } else if (field == "averagetimedilationmodifier") {
                        current.has_average_time_dilation_modifier = true;
                        current.average_time_dilation_modifier = fv;
                        found_any = true;
                    } else if (field == "averagetargetsizemodifier") {
                        current.has_average_target_size_modifier = true;
                        current.average_target_size_modifier = fv;
                        found_any = true;
                    }
                } else if (numeric->IsInteger()) {
                    const int32_t iv = static_cast<int32_t>(numeric->GetSignedIntPropertyValue(value_ptr));
                    if (field == "killcount") {
                        current.has_kills = true;
                        current.kills = iv;
                        found_any = true;
                    } else if (field == "shotshit") {
                        current.has_shots_hit = true;
                        current.shots_hit = iv;
                        found_any = true;
                    } else if (field == "shotsfired") {
                        current.has_shots_fired = true;
                        current.shots_fired = iv;
                        found_any = true;
                    }
                }
            }

            if (!found_any) {
                continue;
            }
            if (score_snapshot_is_missing_sentinel(current)) {
                continue;
            }
            found_any_candidate = true;
            const int32_t signal = static_cast<int32_t>(std::fabs(static_cast<double>(current.score)))
                + std::abs(current.kills)
                + std::abs(current.shots_hit)
                + std::abs(current.shots_fired)
                + static_cast<int32_t>(std::fabs(static_cast<double>(current.accuracy)))
                + static_cast<int32_t>(std::fabs(static_cast<double>(current.damage_done)))
                + static_cast<int32_t>(std::fabs(static_cast<double>(current.damage_possible)))
                + static_cast<int32_t>(std::fabs(static_cast<double>(current.damage_efficiency)))
                + static_cast<int32_t>(std::fabs(static_cast<double>(current.kill_efficiency)))
                + static_cast<int32_t>(std::fabs(static_cast<double>(current.time_remaining)))
                + static_cast<int32_t>(std::fabs(static_cast<double>(current.distance_traveled)))
                + static_cast<int32_t>(std::fabs(static_cast<double>(current.mbs)));
            if (signal > best_signal) {
                best_signal = signal;
                best_snapshot = current;
            }
        }

        if (!found_any_candidate) {
            return false;
        }
        out_snapshot = best_snapshot;
        return true;
    }

    static auto call_receive_float(RC::Unreal::UObject* receiver, RC::Unreal::UFunction* fn, float& out_value) -> bool {
        const auto result = invoke_numeric_ufunction(receiver, fn);
        if (!result.valid) {
            return false;
        }
        if (result.is_floating) {
            out_value = static_cast<float>(result.as_float);
            return std::isfinite(out_value);
        }
        out_value = static_cast<float>(result.as_int);
        return std::isfinite(out_value);
    }

    static auto call_receive_int(RC::Unreal::UObject* receiver, RC::Unreal::UFunction* fn, int32_t& out_value) -> bool {
        const auto result = invoke_numeric_ufunction(receiver, fn);
        if (!result.valid) {
            return false;
        }
        if (result.is_floating) {
            if (!std::isfinite(result.as_float)) {
                return false;
            }
            out_value = static_cast<int32_t>(std::llround(result.as_float));
            return true;
        }
        out_value = static_cast<int32_t>(result.as_int);
        return true;
    }

    static auto call_receive_float_value_else(RC::Unreal::UObject* receiver, RC::Unreal::UFunction* fn, float& out_value) -> bool {
        return call_receive_float(receiver, fn, out_value);
    }

    static auto call_receive_int_value_else(RC::Unreal::UObject* receiver, RC::Unreal::UFunction* fn, int32_t& out_value) -> bool {
        return call_receive_int(receiver, fn, out_value);
    }

    static auto call_get_float_value_else(RC::Unreal::UObject* receiver, RC::Unreal::UFunction* fn, float& out_value) -> bool {
        return call_receive_float(receiver, fn, out_value);
    }

    static auto call_get_int_value_else(RC::Unreal::UObject* receiver, RC::Unreal::UFunction* fn, int32_t& out_value) -> bool {
        return call_receive_int(receiver, fn, out_value);
    }

    static auto probe_and_select_active_receiver(uint64_t now_ms) -> void {
        if (now_ms < s_next_receiver_activity_probe_ms) {
            return;
        }
        s_next_receiver_activity_probe_ms = now_ms + (s_non_ui_probe_enabled ? 1000 : 2500);

        auto* meta_instance = resolve_meta_game_instance(now_ms);
        RC::StringType meta_path{};
        if (meta_instance && is_likely_valid_object_ptr(meta_instance)) {
            meta_path = object_path_from_full_name(meta_instance->GetFullName());
        }

        std::vector<RC::Unreal::UObject*> found_all{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("PerformanceIndicatorsStateReceiver"), found_all);
        std::vector<RC::Unreal::UObject*> found_name_alt{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("PerformanceIndicatorsStateReceiver_C"), found_name_alt);
        append_unique_objects(found_all, found_name_alt);

        auto* receiver_class = resolve_class_cached(
            s_state_receiver_class,
            std::array<const wchar_t*, 3>{
                STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver"),
                STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver_C"),
                STR("/Game/FirstPersonBP/Blueprints/PerformanceIndicatorsStateReceiver.PerformanceIndicatorsStateReceiver_C")
            },
            "state_receiver"
        );
        if (receiver_class && is_likely_valid_object_ptr(receiver_class)) {
            std::vector<RC::Unreal::UObject*> by_class{};
            collect_objects_by_class(receiver_class, by_class);
            append_unique_objects(found_all, by_class);
        }
        if (found_all.empty()) {
            return;
        }

        RC::Unreal::UObject* best = nullptr;
        int best_rank = -1;
        int best_signal = -1;
        uint32_t debug_logged = 0;

        for (auto* candidate : found_all) {
            if (!candidate || !is_likely_valid_object_ptr(candidate)) {
                continue;
            }
            if (receiver_class && is_likely_valid_object_ptr(receiver_class) && !candidate->IsA(receiver_class)) {
                continue;
            }

            int32_t fired = 0;
            int32_t hit = 0;
            int32_t kills = 0;
            float score = 0.0f;
            bool got_any = false;

            if (call_get_int_value_else(candidate, s_targets.get_shots_fired_value_else, fired)
                || call_get_int_value_else(candidate, s_targets.get_shots_fired_value_or, fired)) {
                got_any = true;
            } else if (call_receive_int_value_else(candidate, s_targets.receive_shots_fired_value_else, fired)
                || call_receive_int(candidate, s_targets.receive_shots_fired_single, fired)
                || call_receive_int(candidate, s_targets.receive_shots_fired, fired)) {
                got_any = true;
            }
            if (call_get_int_value_else(candidate, s_targets.get_shots_hit_value_else, hit)
                || call_get_int_value_else(candidate, s_targets.get_shots_hit_value_or, hit)) {
                got_any = true;
            } else if (call_receive_int_value_else(candidate, s_targets.receive_shots_hit_value_else, hit)
                || call_receive_int(candidate, s_targets.receive_shots_hit_single, hit)
                || call_receive_int(candidate, s_targets.receive_shots_hit, hit)) {
                got_any = true;
            }
            if (call_get_int_value_else(candidate, s_targets.get_kills_value_else, kills)
                || call_get_int_value_else(candidate, s_targets.get_kills_value_or, kills)) {
                got_any = true;
            } else if (call_receive_int(candidate, s_targets.receive_kills, kills)) {
                got_any = true;
            }
            if (call_get_float_value_else(candidate, s_targets.get_score_value_else, score)
                || call_get_float_value_else(candidate, s_targets.get_score_value_or, score)) {
                got_any = true;
            } else if (call_receive_float_value_else(candidate, s_targets.receive_score_value_else, score)
                || call_receive_float(candidate, s_targets.receive_score_single, score)
                || call_receive_float(candidate, s_targets.receive_score, score)) {
                got_any = true;
            }
            if (!got_any) {
                continue;
            }

            const int signal = std::abs(fired) + std::abs(hit) + std::abs(kills)
                + static_cast<int>(std::fabs(static_cast<double>(score)));
            const auto candidate_path = object_path_from_full_name(candidate->GetFullName());
            bool meta_scoped = false;
            if (!meta_path.empty()) {
                RC::StringType outer_prefix = meta_path;
                outer_prefix += STR(".");
                meta_scoped = (candidate_path.rfind(outer_prefix, 0) == 0);
            }
            const int rank = signal * 1000 + (meta_scoped ? 100 : 0);
            if (rank > best_rank) {
                best = candidate;
                best_rank = rank;
                best_signal = signal;
            }

            if (s_non_ui_probe_enabled && debug_logged < 6) {
                ++debug_logged;
                std::array<char, 640> pbuf{};
                std::snprintf(
                    pbuf.data(),
                    pbuf.size(),
                    "[direct_pull_probe] candidate=%ls signal=%d fired=%d hit=%d kills=%d score=%.3f meta_scoped=%u",
                    candidate->GetFullName().c_str(),
                    signal,
                    fired,
                    hit,
                    kills,
                    static_cast<double>(score),
                    meta_scoped ? 1u : 0u
                );
                events_log_line(pbuf.data());
            }
        }

        if (!best || !is_likely_valid_object_ptr(best)) {
            return;
        }
        if (best_signal <= 0 && s_state_receiver_instance && is_likely_valid_object_ptr(s_state_receiver_instance)) {
            return;
        }
        if (best != s_state_receiver_instance) {
            s_state_receiver_instance = best;
            s_next_receiver_resolve_ms = now_ms + 2000;
            s_receiver_props_bound_class = nullptr;
            s_receiver_numeric_bindings.clear();
            s_receiver_prop_last_bits.clear();
            s_receiver_prop_emit_counts.clear();

            std::array<char, 512> sbuf{};
            std::snprintf(
                sbuf.data(),
                sbuf.size(),
                "[direct_pull_probe] selected receiver=%ls signal=%d rank=%d",
                best->GetFullName().c_str(),
                best_signal,
                best_rank
            );
            runtime_log_line(sbuf.data());
            events_log_line(sbuf.data());
        }
    }

    static auto poll_state_receiver_values() -> void {
        if (s_safe_mode_enabled || !s_rust_enabled) {
            return;
        }
        const auto now = GetTickCount64();
        static uint64_t s_next_poll_ms = 0;
        if (now < s_next_poll_ms) {
            return;
        }
        s_next_poll_ms = now + 33; // ~30 Hz
        EmitContextScope emit_ctx(
            "direct_pull",
            s_non_ui_probe_enabled ? "non_ui_probe" : "direct_pull"
        );
        s_direct_poll_calls.fetch_add(1, std::memory_order_relaxed);

        probe_and_select_active_receiver(now);

        auto* receiver = resolve_state_receiver_instance(now);
        if (!receiver) {
            if (s_object_debug_enabled || s_ui_counter_fallback_enabled) {
                poll_session_statistics_ui_text(now, s_object_debug_enabled);
            }
            return;
        }
        const auto has_pull_targets = []() -> bool {
            return s_targets.get_shots_fired_value_else
                || s_targets.get_shots_fired_value_or
                || s_targets.receive_shots_fired_value_else
                || s_targets.receive_shots_fired
                || s_targets.get_shots_hit_value_else
                || s_targets.get_shots_hit_value_or
                || s_targets.receive_shots_hit_value_else
                || s_targets.receive_shots_hit
                || s_targets.get_score_value_else
                || s_targets.get_score_value_or
                || s_targets.receive_score_value_else
                || s_targets.receive_score
                || s_targets.receive_challenge_score
                || s_targets.receive_challenge_score_single
                || s_targets.receive_challenge_score_value_or
                || s_targets.receive_challenge_score_value_else
                || s_targets.get_challenge_score_value_or
                || s_targets.get_challenge_score_value_else
                || s_targets.get_accuracy_value_or
                || s_targets.get_accuracy_value_else
                || s_targets.receive_accuracy
                || s_targets.receive_accuracy_single
                || s_targets.receive_accuracy_value_else
                || s_targets.receive_accuracy_value_or
                || s_targets.get_challenge_average_fps_value_or
                || s_targets.get_challenge_average_fps_value_else
                || s_targets.receive_challenge_average_fps
                || s_targets.receive_challenge_average_fps_single
                || s_targets.receive_challenge_average_fps_value_else
                || s_targets.receive_challenge_average_fps_value_or
                || s_targets.get_random_sens_scale_value_or
                || s_targets.get_random_sens_scale_value_else
                || s_targets.receive_random_sens_scale
                || s_targets.receive_random_sens_scale_single
                || s_targets.receive_random_sens_scale_value_else
                || s_targets.receive_random_sens_scale_value_or
                || s_targets.get_challenge_seconds_value_or
                || s_targets.get_challenge_seconds_value_else
                || s_targets.receive_challenge_seconds
                || s_targets.receive_challenge_seconds_single
                || s_targets.receive_challenge_seconds_value_else
                || s_targets.receive_challenge_seconds_value_or
                || s_targets.get_challenge_tick_count_value_or
                || s_targets.get_challenge_tick_count_value_else
                || s_targets.receive_challenge_tick_count
                || s_targets.receive_challenge_tick_count_single
                || s_targets.receive_challenge_tick_count_value_else
                || s_targets.receive_challenge_tick_count_value_or
                || s_targets.meta_get_sandbox_session_stats
                || s_targets.sandbox_get_challenge_time_in_seconds
                || s_targets.sandbox_get_realtime_challenge_time_length;
        };
        static uint64_t s_next_target_retry_ms = 0;
        if (!has_pull_targets() && now >= s_next_target_retry_ms) {
            s_next_target_retry_ms = now + 1000;
            resolve_targets();
            std::array<char, 176> tbuf{};
            std::snprintf(
                tbuf.data(),
                tbuf.size(),
                "[direct_pull] re-resolved targets count=%u",
                s_resolved_target_count
            );
            runtime_log_line(tbuf.data());
            if (s_non_ui_probe_enabled || s_log_all_events || s_object_debug_enabled) {
                events_log_line(tbuf.data());
            }
        }

        auto emit_pull_i32 = [now](const char* ev, int32_t& last, int32_t value) {
            if (value < 0) {
                return;
            }
            if (value == 0) {
                constexpr uint64_t k_zero_suppress_ms = 2500;
                // Guard against stale direct-pull zeros clobbering active session counters.
                if (std::strcmp(ev, "pull_shots_fired_total") == 0 && s_ui_last_session_shots > 0) {
                    return;
                }
                if (std::strcmp(ev, "pull_shots_hit_total") == 0 && s_ui_last_session_hits > 0) {
                    return;
                }
                if (std::strcmp(ev, "pull_kills_total") == 0 && s_ui_last_session_kills > 0) {
                    return;
                }
                if (std::strcmp(ev, "pull_shots_fired_total") == 0 && last > 0
                    && (now - s_last_nonzero_shots_fired_ms) < k_zero_suppress_ms) {
                    return;
                }
                if (std::strcmp(ev, "pull_shots_hit_total") == 0 && last > 0
                    && (now - s_last_nonzero_shots_hit_ms) < k_zero_suppress_ms) {
                    return;
                }
                if (std::strcmp(ev, "pull_kills_total") == 0 && last > 0
                    && (now - s_last_nonzero_kills_ms) < k_zero_suppress_ms) {
                    return;
                }
            } else {
                if (std::strcmp(ev, "pull_shots_fired_total") == 0) {
                    s_last_nonzero_shots_fired_ms = now;
                } else if (std::strcmp(ev, "pull_shots_hit_total") == 0) {
                    s_last_nonzero_shots_hit_ms = now;
                } else if (std::strcmp(ev, "pull_kills_total") == 0) {
                    s_last_nonzero_kills_ms = now;
                }
            }
            if (last != value) {
                last = value;
                s_direct_poll_value_emits.fetch_add(1, std::memory_order_relaxed);
                s_last_pull_emit_ms = now;
                emit_int_event(ev, value);
            }
        };
        auto emit_pull_f32 = [now](const char* ev, float& last, float value) {
            if (!std::isfinite(value)) {
                return;
            }
            if (value < 0.0f) {
                return;
            }
            constexpr uint64_t k_zero_suppress_ms = 2500;
            if (value == 0.0f) {
                if (std::strcmp(ev, "pull_seconds_total") == 0 && last > 0.0f
                    && (now - s_last_nonzero_seconds_ms) < k_zero_suppress_ms) {
                    return;
                }
                if (std::strcmp(ev, "pull_score_per_minute") == 0 && last > 0.0f
                    && (now - s_last_nonzero_spm_ms) < k_zero_suppress_ms) {
                    return;
                }
                if (std::strcmp(ev, "pull_damage_done") == 0 && last > 0.0f
                    && (now - s_last_nonzero_damage_done_ms) < k_zero_suppress_ms) {
                    return;
                }
                if (std::strcmp(ev, "pull_damage_possible") == 0 && last > 0.0f
                    && (now - s_last_nonzero_damage_possible_ms) < k_zero_suppress_ms) {
                    return;
                }
            } else {
                if (std::strcmp(ev, "pull_seconds_total") == 0) {
                    s_last_nonzero_seconds_ms = now;
                } else if (std::strcmp(ev, "pull_score_per_minute") == 0) {
                    s_last_nonzero_spm_ms = now;
                } else if (std::strcmp(ev, "pull_damage_done") == 0) {
                    s_last_nonzero_damage_done_ms = now;
                } else if (std::strcmp(ev, "pull_damage_possible") == 0) {
                    s_last_nonzero_damage_possible_ms = now;
                }
            }
            if (std::strcmp(ev, "pull_score_total") == 0) {
                if (value == 0.0f && last > 0.0f && (now - s_last_nonzero_score_ms) < k_zero_suppress_ms) {
                    return;
                }
                if (value > 0.0f) {
                    s_last_nonzero_score_ms = now;
                }
            }
            if (std::fabs(last - value) > 0.0001f) {
                last = value;
                s_direct_poll_value_emits.fetch_add(1, std::memory_order_relaxed);
                s_last_pull_emit_ms = now;
                emit_float_event(ev, value);
            }
        };
        auto emit_pull_score = [now, &emit_pull_f32](const char* source, float value) {
            const float before = s_last_pull_score;
            emit_pull_f32("pull_score_total", s_last_pull_score, value);
            const bool changed = std::fabs(static_cast<double>(before) - static_cast<double>(s_last_pull_score)) > 0.0001;
            if (changed) {
                s_last_pull_score_source = source ? source : "unknown";
            }
            if ((s_non_ui_probe_enabled || s_log_all_events) && changed) {
                const auto origin = s_emit_origin ? s_emit_origin : "unknown";
                const auto origin_flag = s_emit_origin_flag ? s_emit_origin_flag : "unknown";
                std::array<char, 256> sbuf{};
                std::snprintf(
                    sbuf.data(),
                    sbuf.size(),
                    "[score_source] source=%s value=%.3f origin=%s origin_flag=%s",
                    source ? source : "unknown",
                    static_cast<double>(s_last_pull_score),
                    origin,
                    origin_flag
                );
                events_log_line(sbuf.data());
                std::array<char, 768> flags_json{};
                emit_flag_snapshot_json(flags_json.data(), flags_json.size());
                std::array<char, 1200> msg{};
                std::snprintf(
                    msg.data(),
                    msg.size(),
                    "{\"ev\":\"score_source\",\"source\":\"%s\",\"value\":%.6f,\"origin\":\"%s\",\"origin_flag\":\"%s\",%s}",
                    source ? source : "unknown",
                    static_cast<double>(s_last_pull_score),
                    origin,
                    origin_flag,
                    flags_json.data()
                );
                kovaaks::RustBridge::emit_json(msg.data());
            }
            (void)now;
        };
        auto try_get_int_with_source = [](RC::Unreal::UObject* recv, std::initializer_list<RC::Unreal::UFunction*> fns, int32_t& out, RC::Unreal::UFunction*& used) -> bool {
            used = nullptr;
            for (auto* fn : fns) {
                if (!fn) {
                    continue;
                }
                if (call_get_int_value_else(recv, fn, out)) {
                    used = fn;
                    return true;
                }
            }
            return false;
        };
        auto try_get_float_with_source = [](RC::Unreal::UObject* recv, std::initializer_list<RC::Unreal::UFunction*> fns, float& out, RC::Unreal::UFunction*& used) -> bool {
            used = nullptr;
            for (auto* fn : fns) {
                if (!fn) {
                    continue;
                }
                if (call_get_float_value_else(recv, fn, out)) {
                    used = fn;
                    return true;
                }
            }
            return false;
        };
        auto try_receive_int_with_source = [](RC::Unreal::UObject* recv, std::initializer_list<RC::Unreal::UFunction*> fns, int32_t& out, RC::Unreal::UFunction*& used) -> bool {
            used = nullptr;
            for (auto* fn : fns) {
                if (!fn) {
                    continue;
                }
                if (call_receive_int_value_else(recv, fn, out) || call_receive_int(recv, fn, out)) {
                    used = fn;
                    return true;
                }
            }
            return false;
        };
        auto try_receive_float_with_source = [](RC::Unreal::UObject* recv, std::initializer_list<RC::Unreal::UFunction*> fns, float& out, RC::Unreal::UFunction*& used) -> bool {
            used = nullptr;
            for (auto* fn : fns) {
                if (!fn) {
                    continue;
                }
                if (call_receive_float_value_else(recv, fn, out) || call_receive_float(recv, fn, out)) {
                    used = fn;
                    return true;
                }
            }
            return false;
        };

        struct ScorePullCandidate {
            bool valid{false};
            int rank{-1};
            float value{0.0f};
            const char* source{nullptr};
        };
        ScorePullCandidate score_candidate{};
        constexpr int k_score_rank_state = 20;
        constexpr int k_score_rank_ui = 50;
        constexpr int k_score_rank_scenario_numeric = 70;
        constexpr int k_score_rank_derived = 80;
        constexpr int k_score_rank_receiver_property = 90;
        constexpr int k_score_rank_stats_property = 92;
        constexpr int k_score_rank_stats_native = 95;
        constexpr int k_score_rank_scenario_native = 100;
        auto has_active_live_metrics = [now]() -> bool {
            constexpr uint64_t k_recent_metric_ms = 5000;
            if (s_last_pull_shots_fired > 0) return true;
            if (s_last_pull_shots_hit > 0) return true;
            if (s_last_pull_kills > 0) return true;
            if (s_last_pull_spm > 0.0f) return true;
            if (s_last_pull_seconds > 0.0f) return true;
            if (s_last_pull_damage_done > 0.0f) return true;
            if (s_last_pull_damage_possible > 0.0f) return true;
            if (s_last_pull_shots_fired > 0 && (now - s_last_nonzero_shots_fired_ms) < k_recent_metric_ms) return true;
            if (s_last_pull_shots_hit > 0 && (now - s_last_nonzero_shots_hit_ms) < k_recent_metric_ms) return true;
            if (s_last_pull_kills > 0 && (now - s_last_nonzero_kills_ms) < k_recent_metric_ms) return true;
            if (s_last_pull_spm > 0.0f && (now - s_last_nonzero_spm_ms) < k_recent_metric_ms) return true;
            if (s_last_pull_seconds > 0.0f && (now - s_last_nonzero_seconds_ms) < k_recent_metric_ms) return true;
            if (s_last_pull_damage_done > 0.0f && (now - s_last_nonzero_damage_done_ms) < k_recent_metric_ms) return true;
            if (s_last_pull_damage_possible > 0.0f && (now - s_last_nonzero_damage_possible_ms) < k_recent_metric_ms) return true;
            return false;
        };
        auto consider_score_candidate = [&](const char* source, float value, int rank) {
            if (!std::isfinite(value) || value < 0.0f) {
                return;
            }
            // State receiver score calls are noisy in live sessions (0/999/default-like values).
            // Ignore them entirely while other live metrics are active.
            if (rank <= k_score_rank_state && has_active_live_metrics()) {
                return;
            }
            if (!score_candidate.valid
                || rank > score_candidate.rank
                || (rank == score_candidate.rank
                    && std::fabs(static_cast<double>(value)) > std::fabs(static_cast<double>(score_candidate.value)))) {
                score_candidate.valid = true;
                score_candidate.rank = rank;
                score_candidate.value = value;
                score_candidate.source = source;
            }
        };

        bool any_value_read = false;
        int32_t i32v = 0;
        float f32v = 0.0f;
        RC::Unreal::UFunction* source_fn = nullptr;

        if (bind_state_receiver_numeric_properties(receiver)) {
            for (const auto& binding : s_receiver_numeric_bindings) {
                auto* property = binding.property;
                if (!property || !is_likely_valid_object_ptr(property)) {
                    continue;
                }
                void* value_container = reinterpret_cast<void*>(receiver);
                if (binding.owner_object_property) {
                    auto* object_property = binding.owner_object_property;
                    if (!is_likely_valid_object_ptr(object_property)) {
                        continue;
                    }
                    void* object_value_ptr = object_property->ContainerPtrToValuePtr<void>(
                        reinterpret_cast<void*>(receiver)
                    );
                    if (!object_value_ptr || !is_likely_readable_region(object_value_ptr, sizeof(void*))) {
                        continue;
                    }
                    auto* referenced_object = object_property->GetObjectPropertyValue(object_value_ptr);
                    if (!referenced_object || !is_likely_valid_object_ptr(referenced_object)) {
                        continue;
                    }
                    value_container = reinterpret_cast<void*>(referenced_object);
                }
                void* value_ptr = property->ContainerPtrToValuePtr<void>(value_container);
                if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(double))) {
                    continue;
                }
                s_direct_poll_prop_reads.fetch_add(1, std::memory_order_relaxed);
                any_value_read = true;

                if (binding.is_floating) {
                    const double value = property->GetFloatingPointPropertyValue(value_ptr);
                    if (!std::isfinite(value)) {
                        continue;
                    }
                    const float value_f = static_cast<float>(value);
                    switch (binding.metric) {
                    case PullMetricKind::Score: consider_score_candidate("receiver_property", value_f, k_score_rank_receiver_property); break;
                    case PullMetricKind::Seconds: emit_pull_f32("pull_seconds_total", s_last_pull_seconds, value_f); break;
                    case PullMetricKind::ScorePerMinute: emit_pull_f32("pull_score_per_minute", s_last_pull_spm, value_f); break;
                    case PullMetricKind::KillsPerSecond: emit_pull_f32("pull_kills_per_second", s_last_pull_kps, value_f); break;
                    case PullMetricKind::DamageDone: emit_pull_f32("pull_damage_done", s_last_pull_damage_done, value_f); break;
                    case PullMetricKind::DamagePossible: emit_pull_f32("pull_damage_possible", s_last_pull_damage_possible, value_f); break;
                    case PullMetricKind::DamageEfficiency: emit_pull_f32("pull_damage_efficiency", s_last_pull_damage_efficiency, value_f); break;
                    case PullMetricKind::Accuracy: emit_pull_f32("pull_accuracy", s_last_pull_accuracy, value_f); break;
                    case PullMetricKind::KillEfficiency: emit_pull_f32("pull_kill_efficiency", s_last_pull_kill_efficiency, value_f); break;
                    case PullMetricKind::TimeRemaining: emit_pull_f32("pull_time_remaining", s_last_pull_time_remaining, value_f); break;
                    case PullMetricKind::DistanceTraveled: emit_pull_f32("pull_distance_traveled", s_last_pull_distance_traveled, value_f); break;
                    case PullMetricKind::MBS: emit_pull_f32("pull_mbs", s_last_pull_mbs, value_f); break;
                    case PullMetricKind::AverageTimeDilationModifier:
                        emit_pull_f32("pull_average_time_dilation_modifier", s_last_pull_average_time_dilation_modifier, value_f);
                        break;
                    case PullMetricKind::AverageTargetSizeModifier:
                        emit_pull_f32("pull_average_target_size_modifier", s_last_pull_average_target_size_modifier, value_f);
                        break;
                    case PullMetricKind::Unknown:
                    case PullMetricKind::Kills:
                    case PullMetricKind::ShotsHit:
                    case PullMetricKind::ShotsFired:
                        break;
                    }

                    if (s_non_ui_probe_enabled) {
                        uint64_t bits = 0;
                        std::memcpy(&bits, &value, sizeof(bits));
                        const auto it = s_receiver_prop_last_bits.find(binding.probe_key);
                        const bool changed = (it == s_receiver_prop_last_bits.end() || it->second != bits);
                        s_receiver_prop_last_bits[binding.probe_key] = bits;
                        if (changed && should_emit_receiver_prop_probe(binding.probe_key)) {
                            s_direct_poll_prop_emits.fetch_add(1, std::memory_order_relaxed);
                            const auto name_utf8 = escape_json(binding.emit_name);
                            std::array<char, 512> msg{};
                            std::snprintf(
                                msg.data(),
                                msg.size(),
                                "{\"ev\":\"receiver_prop\",\"name\":\"%s\",\"metric\":\"%s\",\"kind\":\"float\",\"value\":%.6f}",
                                name_utf8.c_str(),
                                pull_metric_name(binding.metric),
                                static_cast<double>(value_f)
                            );
                            kovaaks::RustBridge::emit_json(msg.data());
                        }
                    }
                } else {
                    const int64_t value = property->GetSignedIntPropertyValue(value_ptr);
                    const int32_t value_i = static_cast<int32_t>(value);
                    switch (binding.metric) {
                    case PullMetricKind::Kills: emit_pull_i32("pull_kills_total", s_last_pull_kills, value_i); break;
                    case PullMetricKind::ShotsHit: emit_pull_i32("pull_shots_hit_total", s_last_pull_shots_hit, value_i); break;
                    case PullMetricKind::ShotsFired: emit_pull_i32("pull_shots_fired_total", s_last_pull_shots_fired, value_i); break;
                    case PullMetricKind::Unknown:
                    case PullMetricKind::Score:
                    case PullMetricKind::Seconds:
                    case PullMetricKind::DamageDone:
                    case PullMetricKind::DamagePossible:
                    case PullMetricKind::DamageEfficiency:
                    case PullMetricKind::ScorePerMinute:
                    case PullMetricKind::KillsPerSecond:
                    case PullMetricKind::Accuracy:
                    case PullMetricKind::KillEfficiency:
                    case PullMetricKind::TimeRemaining:
                    case PullMetricKind::DistanceTraveled:
                    case PullMetricKind::MBS:
                    case PullMetricKind::AverageTimeDilationModifier:
                    case PullMetricKind::AverageTargetSizeModifier:
                        break;
                    }

                    if (s_non_ui_probe_enabled) {
                        const uint64_t bits = static_cast<uint64_t>(value);
                        const auto it = s_receiver_prop_last_bits.find(binding.probe_key);
                        const bool changed = (it == s_receiver_prop_last_bits.end() || it->second != bits);
                        s_receiver_prop_last_bits[binding.probe_key] = bits;
                        if (changed && should_emit_receiver_prop_probe(binding.probe_key)) {
                            s_direct_poll_prop_emits.fetch_add(1, std::memory_order_relaxed);
                            const auto name_utf8 = escape_json(binding.emit_name);
                            std::array<char, 512> msg{};
                            std::snprintf(
                                msg.data(),
                                msg.size(),
                                "{\"ev\":\"receiver_prop\",\"name\":\"%s\",\"metric\":\"%s\",\"kind\":\"int\",\"value\":%lld}",
                                name_utf8.c_str(),
                                pull_metric_name(binding.metric),
                                static_cast<long long>(value)
                            );
                            kovaaks::RustBridge::emit_json(msg.data());
                        }
                    }
                }
            }
        }

        if (try_get_int_with_source(receiver, {s_targets.get_shots_fired_value_else, s_targets.get_shots_fired_value_or}, i32v, source_fn)) {
            emit_pull_i32("pull_shots_fired_total", s_last_pull_shots_fired, i32v);
            emit_state_pull_source_once("pull_shots_fired_total", "state_get", receiver, source_fn, static_cast<double>(i32v));
            any_value_read = true;
        } else if (try_receive_int_with_source(receiver, {s_targets.receive_shots_fired_value_else, s_targets.receive_shots_fired_single, s_targets.receive_shots_fired}, i32v, source_fn)) {
            emit_pull_i32("pull_shots_fired_total", s_last_pull_shots_fired, i32v);
            emit_state_pull_source_once("pull_shots_fired_total", "state_receive", receiver, source_fn, static_cast<double>(i32v));
            any_value_read = true;
        } else {
            s_direct_poll_errors.fetch_add(1, std::memory_order_relaxed);
        }
        if (try_get_int_with_source(receiver, {s_targets.get_shots_hit_value_else, s_targets.get_shots_hit_value_or}, i32v, source_fn)) {
            emit_pull_i32("pull_shots_hit_total", s_last_pull_shots_hit, i32v);
            emit_state_pull_source_once("pull_shots_hit_total", "state_get", receiver, source_fn, static_cast<double>(i32v));
            any_value_read = true;
        } else if (try_receive_int_with_source(receiver, {s_targets.receive_shots_hit_value_else, s_targets.receive_shots_hit_single, s_targets.receive_shots_hit}, i32v, source_fn)) {
            emit_pull_i32("pull_shots_hit_total", s_last_pull_shots_hit, i32v);
            emit_state_pull_source_once("pull_shots_hit_total", "state_receive", receiver, source_fn, static_cast<double>(i32v));
            any_value_read = true;
        } else {
            s_direct_poll_errors.fetch_add(1, std::memory_order_relaxed);
        }
        if (call_get_float_value_else(receiver, s_targets.get_score_value_else, f32v)
            || call_get_float_value_else(receiver, s_targets.get_score_value_or, f32v)) {
            consider_score_candidate("state_get_score", f32v, k_score_rank_state);
            any_value_read = true;
        } else if (call_receive_float_value_else(receiver, s_targets.receive_score_value_else, f32v)
            || call_receive_float(receiver, s_targets.receive_score_single, f32v)
            || call_receive_float(receiver, s_targets.receive_score, f32v)) {
            consider_score_candidate("state_receive_score", f32v, k_score_rank_state);
            any_value_read = true;
        } else {
            s_direct_poll_errors.fetch_add(1, std::memory_order_relaxed);
        }
        if (try_get_int_with_source(receiver, {s_targets.get_kills_value_else, s_targets.get_kills_value_or}, i32v, source_fn)) {
            emit_pull_i32("pull_kills_total", s_last_pull_kills, i32v);
            emit_state_pull_source_once("pull_kills_total", "state_get", receiver, source_fn, static_cast<double>(i32v));
            any_value_read = true;
        } else if (try_receive_int_with_source(receiver, {s_targets.receive_kills}, i32v, source_fn)) {
            emit_pull_i32("pull_kills_total", s_last_pull_kills, i32v);
            emit_state_pull_source_once("pull_kills_total", "state_receive", receiver, source_fn, static_cast<double>(i32v));
            any_value_read = true;
        }
        if (try_get_float_with_source(receiver, {s_targets.get_seconds_value_else, s_targets.get_seconds_value_or}, f32v, source_fn)) {
            emit_pull_f32("pull_seconds_total", s_last_pull_seconds, f32v);
            emit_state_pull_source_once("pull_seconds_total", "state_get", receiver, source_fn, static_cast<double>(f32v));
            any_value_read = true;
        } else if (try_receive_float_with_source(receiver, {s_targets.receive_seconds}, f32v, source_fn)) {
            emit_pull_f32("pull_seconds_total", s_last_pull_seconds, f32v);
            emit_state_pull_source_once("pull_seconds_total", "state_receive", receiver, source_fn, static_cast<double>(f32v));
            any_value_read = true;
        }
        if (try_get_float_with_source(receiver, {s_targets.get_score_per_minute_value_else, s_targets.get_score_per_minute_value_or}, f32v, source_fn)) {
            emit_pull_f32("pull_score_per_minute", s_last_pull_spm, f32v);
            emit_state_pull_source_once("pull_score_per_minute", "state_get", receiver, source_fn, static_cast<double>(f32v));
            any_value_read = true;
        } else if (try_receive_float_with_source(receiver, {s_targets.receive_score_per_minute_value_else, s_targets.receive_score_per_minute}, f32v, source_fn)) {
            emit_pull_f32("pull_score_per_minute", s_last_pull_spm, f32v);
            emit_state_pull_source_once("pull_score_per_minute", "state_receive", receiver, source_fn, static_cast<double>(f32v));
            any_value_read = true;
        }
        if (try_get_float_with_source(receiver, {s_targets.get_kills_per_second_value_else, s_targets.get_kills_per_second_value_or}, f32v, source_fn)) {
            emit_pull_f32("pull_kills_per_second", s_last_pull_kps, f32v);
            emit_state_pull_source_once("pull_kills_per_second", "state_get", receiver, source_fn, static_cast<double>(f32v));
            any_value_read = true;
        } else if (try_receive_float_with_source(receiver, {s_targets.receive_kills_per_second_value_else, s_targets.receive_kills_per_second}, f32v, source_fn)) {
            emit_pull_f32("pull_kills_per_second", s_last_pull_kps, f32v);
            emit_state_pull_source_once("pull_kills_per_second", "state_receive", receiver, source_fn, static_cast<double>(f32v));
            any_value_read = true;
        }
        if (call_get_float_value_else(receiver, s_targets.get_accuracy_value_else, f32v)
            || call_get_float_value_else(receiver, s_targets.get_accuracy_value_or, f32v)) {
            emit_pull_f32("pull_accuracy", s_last_pull_accuracy, f32v);
            any_value_read = true;
        } else if (call_receive_float_value_else(receiver, s_targets.receive_accuracy_value_else, f32v)
            || call_receive_float_value_else(receiver, s_targets.receive_accuracy_value_or, f32v)
            || call_receive_float(receiver, s_targets.receive_accuracy_single, f32v)
            || call_receive_float(receiver, s_targets.receive_accuracy, f32v)) {
            emit_pull_f32("pull_accuracy", s_last_pull_accuracy, f32v);
            any_value_read = true;
        }
        if (call_get_float_value_else(receiver, s_targets.get_challenge_average_fps_value_else, f32v)
            || call_get_float_value_else(receiver, s_targets.get_challenge_average_fps_value_or, f32v)) {
            emit_pull_f32("pull_challenge_average_fps", s_last_pull_challenge_average_fps, f32v);
            any_value_read = true;
        } else if (call_receive_float_value_else(receiver, s_targets.receive_challenge_average_fps_value_else, f32v)
            || call_receive_float_value_else(receiver, s_targets.receive_challenge_average_fps_value_or, f32v)
            || call_receive_float(receiver, s_targets.receive_challenge_average_fps_single, f32v)
            || call_receive_float(receiver, s_targets.receive_challenge_average_fps, f32v)) {
            emit_pull_f32("pull_challenge_average_fps", s_last_pull_challenge_average_fps, f32v);
            any_value_read = true;
        }
        if (call_get_float_value_else(receiver, s_targets.get_random_sens_scale_value_else, f32v)
            || call_get_float_value_else(receiver, s_targets.get_random_sens_scale_value_or, f32v)) {
            emit_pull_f32("pull_random_sens_scale", s_last_pull_random_sens_scale, f32v);
            any_value_read = true;
        } else if (call_receive_float_value_else(receiver, s_targets.receive_random_sens_scale_value_else, f32v)
            || call_receive_float_value_else(receiver, s_targets.receive_random_sens_scale_value_or, f32v)
            || call_receive_float(receiver, s_targets.receive_random_sens_scale_single, f32v)
            || call_receive_float(receiver, s_targets.receive_random_sens_scale, f32v)) {
            emit_pull_f32("pull_random_sens_scale", s_last_pull_random_sens_scale, f32v);
            any_value_read = true;
        }
        if (call_get_float_value_else(receiver, s_targets.get_challenge_seconds_value_else, f32v)
            || call_get_float_value_else(receiver, s_targets.get_challenge_seconds_value_or, f32v)
            || call_receive_float(receiver, s_targets.receive_challenge_seconds, f32v)) {
            emit_pull_f32("pull_challenge_seconds_total", s_last_pull_challenge_seconds, f32v);
            any_value_read = true;
        } else if (call_receive_float_value_else(receiver, s_targets.receive_challenge_seconds_value_else, f32v)
            || call_receive_float_value_else(receiver, s_targets.receive_challenge_seconds_value_or, f32v)
            || call_receive_float(receiver, s_targets.receive_challenge_seconds_single, f32v)) {
            emit_pull_f32("pull_challenge_seconds_total", s_last_pull_challenge_seconds, f32v);
            any_value_read = true;
        }
        if (call_get_int_value_else(receiver, s_targets.get_challenge_tick_count_value_else, i32v)
            || call_get_int_value_else(receiver, s_targets.get_challenge_tick_count_value_or, i32v)
            || call_receive_int(receiver, s_targets.receive_challenge_tick_count, i32v)) {
            emit_pull_i32("pull_challenge_tick_count_total", s_last_pull_challenge_tick_count, i32v);
            any_value_read = true;
        } else if (call_receive_int_value_else(receiver, s_targets.receive_challenge_tick_count_value_else, i32v)
            || call_receive_int_value_else(receiver, s_targets.receive_challenge_tick_count_value_or, i32v)
            || call_receive_int(receiver, s_targets.receive_challenge_tick_count_single, i32v)) {
            emit_pull_i32("pull_challenge_tick_count_total", s_last_pull_challenge_tick_count, i32v);
            any_value_read = true;
        }
        if (try_get_float_with_source(receiver, {s_targets.get_damage_done_value_else, s_targets.get_damage_done_value_or}, f32v, source_fn)) {
            emit_pull_f32("pull_damage_done", s_last_pull_damage_done, f32v);
            emit_state_pull_source_once("pull_damage_done", "state_get", receiver, source_fn, static_cast<double>(f32v));
            any_value_read = true;
        } else if (try_receive_float_with_source(receiver, {s_targets.receive_damage_done_value_else, s_targets.receive_damage_done}, f32v, source_fn)) {
            emit_pull_f32("pull_damage_done", s_last_pull_damage_done, f32v);
            emit_state_pull_source_once("pull_damage_done", "state_receive", receiver, source_fn, static_cast<double>(f32v));
            any_value_read = true;
        }
        if (try_get_float_with_source(receiver, {s_targets.get_damage_possible_value_else, s_targets.get_damage_possible_value_or}, f32v, source_fn)) {
            emit_pull_f32("pull_damage_possible", s_last_pull_damage_possible, f32v);
            emit_state_pull_source_once("pull_damage_possible", "state_get", receiver, source_fn, static_cast<double>(f32v));
            any_value_read = true;
        } else if (try_receive_float_with_source(receiver, {s_targets.receive_damage_possible_value_else, s_targets.receive_damage_possible}, f32v, source_fn)) {
            emit_pull_f32("pull_damage_possible", s_last_pull_damage_possible, f32v);
            emit_state_pull_source_once("pull_damage_possible", "state_receive", receiver, source_fn, static_cast<double>(f32v));
            any_value_read = true;
        }
        if (try_get_float_with_source(receiver, {s_targets.get_damage_efficiency_value_else, s_targets.get_damage_efficiency_value_or}, f32v, source_fn)) {
            emit_pull_f32("pull_damage_efficiency", s_last_pull_damage_efficiency, f32v);
            emit_state_pull_source_once("pull_damage_efficiency", "state_get", receiver, source_fn, static_cast<double>(f32v));
            any_value_read = true;
        } else if (try_receive_float_with_source(receiver, {s_targets.receive_damage_efficiency_value_else, s_targets.receive_damage_efficiency}, f32v, source_fn)) {
            emit_pull_f32("pull_damage_efficiency", s_last_pull_damage_efficiency, f32v);
            emit_state_pull_source_once("pull_damage_efficiency", "state_receive", receiver, source_fn, static_cast<double>(f32v));
            any_value_read = true;
        }

        auto* scenario_receiver = resolve_scenario_state_receiver_instance(now);
        if (scenario_receiver && is_likely_valid_object_ptr(scenario_receiver)) {
            if (call_get_float_value_else(scenario_receiver, s_targets.get_challenge_score_value_else, f32v)
                || call_get_float_value_else(scenario_receiver, s_targets.get_challenge_score_value_or, f32v)
                || call_receive_float_value_else(scenario_receiver, s_targets.receive_challenge_score_value_else, f32v)
                || call_receive_float_value_else(scenario_receiver, s_targets.receive_challenge_score_value_or, f32v)
                || call_receive_float(scenario_receiver, s_targets.receive_challenge_score_single, f32v)
                || call_receive_float(scenario_receiver, s_targets.receive_challenge_score, f32v)) {
                consider_score_candidate("scenario_numeric", f32v, k_score_rank_scenario_numeric);
                any_value_read = true;
            }
            ScoreNativeSnapshot score_native{};
            bool has_native_score_snapshot = false;
            const char* score_native_source = "none";
            int score_native_signal = -1;
            auto score_native_signal_value = [](const ScoreNativeSnapshot& s) -> int {
                int signal = 0;
                if (s.has_score) signal += static_cast<int>(std::fabs(static_cast<double>(s.score)));
                if (s.has_kills) signal += std::abs(s.kills);
                if (s.has_shots_hit) signal += std::abs(s.shots_hit);
                if (s.has_shots_fired) signal += std::abs(s.shots_fired);
                if (s.has_accuracy) signal += static_cast<int>(std::fabs(static_cast<double>(s.accuracy)));
                if (s.has_damage_done) signal += static_cast<int>(std::fabs(static_cast<double>(s.damage_done)));
                if (s.has_damage_possible) signal += static_cast<int>(std::fabs(static_cast<double>(s.damage_possible)));
                if (s.has_damage_efficiency) signal += static_cast<int>(std::fabs(static_cast<double>(s.damage_efficiency)));
                if (s.has_kill_efficiency) signal += static_cast<int>(std::fabs(static_cast<double>(s.kill_efficiency)));
                if (s.has_time_remaining) signal += static_cast<int>(std::fabs(static_cast<double>(s.time_remaining)));
                if (s.has_distance_traveled) signal += static_cast<int>(std::fabs(static_cast<double>(s.distance_traveled)));
                if (s.has_mbs) signal += static_cast<int>(std::fabs(static_cast<double>(s.mbs)));
                if (s.has_average_time_dilation_modifier) {
                    signal += static_cast<int>(std::fabs(static_cast<double>(s.average_time_dilation_modifier)));
                }
                if (s.has_average_target_size_modifier) {
                    signal += static_cast<int>(std::fabs(static_cast<double>(s.average_target_size_modifier)));
                }
                return signal;
            };
            auto consider_native_score_snapshot = [&](const char* source, RC::Unreal::UFunction* fn) {
                if (!fn || !is_likely_valid_object_ptr(fn)) {
                    return;
                }
                ScoreNativeSnapshot snapshot{};
                if (!invoke_score_native_ufunction(scenario_receiver, fn, snapshot)) {
                    return;
                }
                if (!score_snapshot_has_any_value(snapshot)) {
                    return;
                }
                const int signal = score_native_signal_value(snapshot);
                if (!has_native_score_snapshot || signal > score_native_signal) {
                    has_native_score_snapshot = true;
                    score_native = snapshot;
                    score_native_signal = signal;
                    score_native_source = source;
                }
            };
            consider_native_score_snapshot("scenario_receive_challenge_score", s_targets.receive_challenge_score);
            consider_native_score_snapshot("scenario_receive_challenge_score_single", s_targets.receive_challenge_score_single);
            consider_native_score_snapshot("scenario_receive_challenge_score_value_else", s_targets.receive_challenge_score_value_else);
            consider_native_score_snapshot("scenario_receive_challenge_score_value_or", s_targets.receive_challenge_score_value_or);
            consider_native_score_snapshot("scenario_get_challenge_score_value_else", s_targets.get_challenge_score_value_else);
            consider_native_score_snapshot("scenario_get_challenge_score_value_or", s_targets.get_challenge_score_value_or);

            if (has_native_score_snapshot) {
                if (score_native.has_score) {
                    const bool stale_zero_score = score_native.score <= 0.0f
                        && (s_last_pull_shots_fired > 0 || s_last_pull_shots_hit > 0
                            || s_last_pull_damage_done > 0.0f || s_last_pull_spm > 0.0f);
                    if (!stale_zero_score) {
                        consider_score_candidate("scenario_score_native", score_native.score, k_score_rank_scenario_native);
                        any_value_read = true;
                    }
                }
                if (score_native.has_kills) {
                    emit_pull_i32("pull_kills_total", s_last_pull_kills, score_native.kills);
                    any_value_read = true;
                }
                if (score_native.has_shots_hit) {
                    emit_pull_i32("pull_shots_hit_total", s_last_pull_shots_hit, score_native.shots_hit);
                    any_value_read = true;
                }
                if (score_native.has_shots_fired) {
                    emit_pull_i32("pull_shots_fired_total", s_last_pull_shots_fired, score_native.shots_fired);
                    any_value_read = true;
                }
                if (score_native.has_accuracy) {
                    emit_pull_f32("pull_accuracy", s_last_pull_accuracy, score_native.accuracy);
                    any_value_read = true;
                }
                if (score_native.has_damage_done) {
                    emit_pull_f32("pull_damage_done", s_last_pull_damage_done, score_native.damage_done);
                    any_value_read = true;
                }
                if (score_native.has_damage_possible) {
                    emit_pull_f32("pull_damage_possible", s_last_pull_damage_possible, score_native.damage_possible);
                    any_value_read = true;
                }
                if (score_native.has_damage_efficiency) {
                    emit_pull_f32("pull_damage_efficiency", s_last_pull_damage_efficiency, score_native.damage_efficiency);
                    any_value_read = true;
                }
                if (score_native.has_kill_efficiency) {
                    emit_pull_f32("pull_kill_efficiency", s_last_pull_kill_efficiency, score_native.kill_efficiency);
                    any_value_read = true;
                }
                if (score_native.has_time_remaining) {
                    emit_pull_f32("pull_time_remaining", s_last_pull_time_remaining, score_native.time_remaining);
                    any_value_read = true;
                }
                if (score_native.has_distance_traveled) {
                    emit_pull_f32("pull_distance_traveled", s_last_pull_distance_traveled, score_native.distance_traveled);
                    any_value_read = true;
                }
                if (score_native.has_mbs) {
                    emit_pull_f32("pull_mbs", s_last_pull_mbs, score_native.mbs);
                    any_value_read = true;
                }
                if (score_native.has_average_time_dilation_modifier) {
                    emit_pull_f32(
                        "pull_average_time_dilation_modifier",
                        s_last_pull_average_time_dilation_modifier,
                        score_native.average_time_dilation_modifier
                    );
                    any_value_read = true;
                }
                if (score_native.has_average_target_size_modifier) {
                    emit_pull_f32(
                        "pull_average_target_size_modifier",
                        s_last_pull_average_target_size_modifier,
                        score_native.average_target_size_modifier
                    );
                    any_value_read = true;
                }
                if (score_native.has_mult_average_time_dilation_modifier) {
                    emit_pull_i32(
                        "pull_mult_average_time_dilation_modifier",
                        s_last_pull_mult_average_time_dilation_modifier,
                        score_native.mult_average_time_dilation_modifier ? 1 : 0
                    );
                    any_value_read = true;
                }
                if (score_native.has_mult_average_target_size_modifier) {
                    emit_pull_i32(
                        "pull_mult_average_target_size_modifier",
                        s_last_pull_mult_average_target_size_modifier,
                        score_native.mult_average_target_size_modifier ? 1 : 0
                    );
                    any_value_read = true;
                }
                if (s_non_ui_probe_enabled || s_log_all_events) {
                    static ScoreNativeSnapshot s_last_logged_scenario{};
                    static bool s_has_last_logged_scenario = false;
                    static RC::Unreal::UObject* s_last_logged_scenario_receiver = nullptr;
                    const bool receiver_changed = (scenario_receiver != s_last_logged_scenario_receiver);
                    const bool has_any = score_snapshot_has_any_value(score_native);
                    if (has_any && (!s_has_last_logged_scenario || receiver_changed
                        || score_snapshot_changed(s_last_logged_scenario, score_native))) {
                        s_last_logged_scenario_receiver = scenario_receiver;
                        s_last_logged_scenario = score_native;
                        s_has_last_logged_scenario = true;
                        std::array<char, 1024> sbuf{};
                        std::snprintf(
                            sbuf.data(),
                            sbuf.size(),
                            "[direct_pull] scenario_score source=%s hs=%u hk=%u hh=%u hf=%u hacc=%u hdd=%u hdp=%u hde=%u hke=%u htr=%u hdt=%u hmbs=%u hatd=%u hats=%u hmatd=%u hmats=%u score=%.3f kills=%d fired=%d hit=%d acc=%.3f dmg_done=%.3f dmg_pos=%.3f dmg_eff=%.3f kill_eff=%.3f t_rem=%.3f dist=%.3f mbs=%.3f atd=%.3f ats=%.3f matd=%d mats=%d",
                            score_native_source,
                            score_native.has_score ? 1u : 0u,
                            score_native.has_kills ? 1u : 0u,
                            score_native.has_shots_hit ? 1u : 0u,
                            score_native.has_shots_fired ? 1u : 0u,
                            score_native.has_accuracy ? 1u : 0u,
                            score_native.has_damage_done ? 1u : 0u,
                            score_native.has_damage_possible ? 1u : 0u,
                            score_native.has_damage_efficiency ? 1u : 0u,
                            score_native.has_kill_efficiency ? 1u : 0u,
                            score_native.has_time_remaining ? 1u : 0u,
                            score_native.has_distance_traveled ? 1u : 0u,
                            score_native.has_mbs ? 1u : 0u,
                            score_native.has_average_time_dilation_modifier ? 1u : 0u,
                            score_native.has_average_target_size_modifier ? 1u : 0u,
                            score_native.has_mult_average_time_dilation_modifier ? 1u : 0u,
                            score_native.has_mult_average_target_size_modifier ? 1u : 0u,
                            static_cast<double>(score_native.score),
                            score_native.kills,
                            score_native.shots_fired,
                            score_native.shots_hit,
                            static_cast<double>(score_native.accuracy),
                            static_cast<double>(score_native.damage_done),
                            static_cast<double>(score_native.damage_possible),
                            static_cast<double>(score_native.damage_efficiency),
                            static_cast<double>(score_native.kill_efficiency),
                            static_cast<double>(score_native.time_remaining),
                            static_cast<double>(score_native.distance_traveled),
                            static_cast<double>(score_native.mbs),
                            static_cast<double>(score_native.average_time_dilation_modifier),
                            static_cast<double>(score_native.average_target_size_modifier),
                            score_native.mult_average_time_dilation_modifier ? 1 : 0,
                            score_native.mult_average_target_size_modifier ? 1 : 0
                        );
                        events_log_line(sbuf.data());
                    }
                }
            }
        }
        auto* stats_manager = resolve_stats_manager_instance(now);
        if (stats_manager && is_likely_valid_object_ptr(stats_manager)) {
            if (bind_stats_manager_numeric_properties(stats_manager)) {
                for (const auto& binding : s_stats_numeric_bindings) {
                    auto* property = binding.property;
                    if (!property || !is_likely_valid_object_ptr(property)) {
                        continue;
                    }
                    void* value_container = reinterpret_cast<void*>(stats_manager);
                    if (binding.owner_object_property) {
                        auto* object_property = binding.owner_object_property;
                        if (!is_likely_valid_object_ptr(object_property)) {
                            continue;
                        }
                        void* object_value_ptr = object_property->ContainerPtrToValuePtr<void>(
                            reinterpret_cast<void*>(stats_manager)
                        );
                        if (!object_value_ptr || !is_likely_readable_region(object_value_ptr, sizeof(void*))) {
                            continue;
                        }
                        auto* referenced_object = object_property->GetObjectPropertyValue(object_value_ptr);
                        if (!referenced_object || !is_likely_valid_object_ptr(referenced_object)) {
                            continue;
                        }
                        value_container = reinterpret_cast<void*>(referenced_object);
                    }
                    void* value_ptr = property->ContainerPtrToValuePtr<void>(value_container);
                    if (!value_ptr || !is_likely_readable_region(value_ptr, sizeof(double))) {
                        continue;
                    }
                    s_direct_poll_prop_reads.fetch_add(1, std::memory_order_relaxed);
                    any_value_read = true;

                    if (binding.is_floating) {
                        const double value = property->GetFloatingPointPropertyValue(value_ptr);
                        if (!std::isfinite(value)) {
                            continue;
                        }
                        const float value_f = static_cast<float>(value);
                        switch (binding.metric) {
                        case PullMetricKind::Score:
                            consider_score_candidate("stats_property", value_f, k_score_rank_stats_property);
                            break;
                        case PullMetricKind::Seconds:
                            emit_pull_f32("pull_seconds_total", s_last_pull_seconds, value_f);
                            break;
                        case PullMetricKind::ScorePerMinute:
                            emit_pull_f32("pull_score_per_minute", s_last_pull_spm, value_f);
                            break;
                        case PullMetricKind::KillsPerSecond:
                            emit_pull_f32("pull_kills_per_second", s_last_pull_kps, value_f);
                            break;
                        case PullMetricKind::DamageDone:
                            emit_pull_f32("pull_damage_done", s_last_pull_damage_done, value_f);
                            break;
                        case PullMetricKind::DamagePossible:
                            emit_pull_f32("pull_damage_possible", s_last_pull_damage_possible, value_f);
                            break;
                        case PullMetricKind::DamageEfficiency:
                            emit_pull_f32("pull_damage_efficiency", s_last_pull_damage_efficiency, value_f);
                            break;
                        case PullMetricKind::Accuracy:
                            emit_pull_f32("pull_accuracy", s_last_pull_accuracy, value_f);
                            break;
                        case PullMetricKind::KillEfficiency:
                            emit_pull_f32("pull_kill_efficiency", s_last_pull_kill_efficiency, value_f);
                            break;
                        case PullMetricKind::TimeRemaining:
                            emit_pull_f32("pull_time_remaining", s_last_pull_time_remaining, value_f);
                            break;
                        case PullMetricKind::DistanceTraveled:
                            emit_pull_f32("pull_distance_traveled", s_last_pull_distance_traveled, value_f);
                            break;
                        case PullMetricKind::MBS:
                            emit_pull_f32("pull_mbs", s_last_pull_mbs, value_f);
                            break;
                        case PullMetricKind::AverageTimeDilationModifier:
                            emit_pull_f32(
                                "pull_average_time_dilation_modifier",
                                s_last_pull_average_time_dilation_modifier,
                                value_f
                            );
                            break;
                        case PullMetricKind::AverageTargetSizeModifier:
                            emit_pull_f32(
                                "pull_average_target_size_modifier",
                                s_last_pull_average_target_size_modifier,
                                value_f
                            );
                            break;
                        case PullMetricKind::Unknown:
                        case PullMetricKind::Kills:
                        case PullMetricKind::ShotsHit:
                        case PullMetricKind::ShotsFired:
                            break;
                        }

                        if (s_non_ui_probe_enabled) {
                            uint64_t bits = 0;
                            std::memcpy(&bits, &value, sizeof(bits));
                            const auto it = s_stats_prop_last_bits.find(binding.probe_key);
                            const bool changed = (it == s_stats_prop_last_bits.end() || it->second != bits);
                            s_stats_prop_last_bits[binding.probe_key] = bits;
                            if (changed && should_emit_stats_prop_probe(binding.probe_key)) {
                                s_direct_poll_prop_emits.fetch_add(1, std::memory_order_relaxed);
                                const auto name_utf8 = escape_json(binding.emit_name);
                                std::array<char, 512> msg{};
                                std::snprintf(
                                    msg.data(),
                                    msg.size(),
                                    "{\"ev\":\"stats_prop\",\"name\":\"%s\",\"metric\":\"%s\",\"kind\":\"float\",\"value\":%.6f}",
                                    name_utf8.c_str(),
                                    pull_metric_name(binding.metric),
                                    static_cast<double>(value_f)
                                );
                                kovaaks::RustBridge::emit_json(msg.data());
                            }
                        }
                    } else {
                        const int64_t value = property->GetSignedIntPropertyValue(value_ptr);
                        const int32_t value_i = static_cast<int32_t>(value);
                        switch (binding.metric) {
                        case PullMetricKind::Kills:
                            emit_pull_i32("pull_kills_total", s_last_pull_kills, value_i);
                            break;
                        case PullMetricKind::ShotsHit:
                            emit_pull_i32("pull_shots_hit_total", s_last_pull_shots_hit, value_i);
                            break;
                        case PullMetricKind::ShotsFired:
                            emit_pull_i32("pull_shots_fired_total", s_last_pull_shots_fired, value_i);
                            break;
                        case PullMetricKind::Unknown:
                        case PullMetricKind::Score:
                        case PullMetricKind::Seconds:
                        case PullMetricKind::DamageDone:
                        case PullMetricKind::DamagePossible:
                        case PullMetricKind::DamageEfficiency:
                        case PullMetricKind::ScorePerMinute:
                        case PullMetricKind::KillsPerSecond:
                        case PullMetricKind::Accuracy:
                        case PullMetricKind::KillEfficiency:
                        case PullMetricKind::TimeRemaining:
                        case PullMetricKind::DistanceTraveled:
                        case PullMetricKind::MBS:
                        case PullMetricKind::AverageTimeDilationModifier:
                        case PullMetricKind::AverageTargetSizeModifier:
                            break;
                        }

                        if (s_non_ui_probe_enabled) {
                            const uint64_t bits = static_cast<uint64_t>(value);
                            const auto it = s_stats_prop_last_bits.find(binding.probe_key);
                            const bool changed = (it == s_stats_prop_last_bits.end() || it->second != bits);
                            s_stats_prop_last_bits[binding.probe_key] = bits;
                            if (changed && should_emit_stats_prop_probe(binding.probe_key)) {
                                s_direct_poll_prop_emits.fetch_add(1, std::memory_order_relaxed);
                                const auto name_utf8 = escape_json(binding.emit_name);
                                std::array<char, 512> msg{};
                                std::snprintf(
                                    msg.data(),
                                    msg.size(),
                                    "{\"ev\":\"stats_prop\",\"name\":\"%s\",\"metric\":\"%s\",\"kind\":\"int\",\"value\":%lld}",
                                    name_utf8.c_str(),
                                    pull_metric_name(binding.metric),
                                    static_cast<long long>(value)
                                );
                                kovaaks::RustBridge::emit_json(msg.data());
                            }
                        }
                    }
                }
            }

            ScoreNativeSnapshot stats_score{};
            if (invoke_score_native_ufunction(stats_manager, s_targets.stats_calculate_score, stats_score)) {
                if (stats_score.has_score) {
                    const bool stale_zero_score = stats_score.score <= 0.0f
                        && (s_last_pull_shots_fired > 0 || s_last_pull_shots_hit > 0
                            || s_last_pull_damage_done > 0.0f || s_last_pull_spm > 0.0f);
                    if (!stale_zero_score) {
                        consider_score_candidate("stats_calculate_score", stats_score.score, k_score_rank_stats_native);
                        any_value_read = true;
                    }
                }
                if (stats_score.has_kills) {
                    emit_pull_i32("pull_kills_total", s_last_pull_kills, stats_score.kills);
                    any_value_read = true;
                }
                if (stats_score.has_shots_hit) {
                    emit_pull_i32("pull_shots_hit_total", s_last_pull_shots_hit, stats_score.shots_hit);
                    any_value_read = true;
                }
                if (stats_score.has_shots_fired) {
                    emit_pull_i32("pull_shots_fired_total", s_last_pull_shots_fired, stats_score.shots_fired);
                    any_value_read = true;
                }
                if (stats_score.has_accuracy) {
                    emit_pull_f32("pull_accuracy", s_last_pull_accuracy, stats_score.accuracy);
                    any_value_read = true;
                }
                if (stats_score.has_damage_done) {
                    emit_pull_f32("pull_damage_done", s_last_pull_damage_done, stats_score.damage_done);
                    any_value_read = true;
                }
                if (stats_score.has_damage_possible) {
                    emit_pull_f32("pull_damage_possible", s_last_pull_damage_possible, stats_score.damage_possible);
                    any_value_read = true;
                }
                if (stats_score.has_damage_efficiency) {
                    emit_pull_f32("pull_damage_efficiency", s_last_pull_damage_efficiency, stats_score.damage_efficiency);
                    any_value_read = true;
                }
                if (stats_score.has_kill_efficiency) {
                    emit_pull_f32("pull_kill_efficiency", s_last_pull_kill_efficiency, stats_score.kill_efficiency);
                    any_value_read = true;
                }
                if (stats_score.has_time_remaining) {
                    emit_pull_f32("pull_time_remaining", s_last_pull_time_remaining, stats_score.time_remaining);
                    any_value_read = true;
                }
                if (stats_score.has_distance_traveled) {
                    emit_pull_f32("pull_distance_traveled", s_last_pull_distance_traveled, stats_score.distance_traveled);
                    any_value_read = true;
                }
                if (stats_score.has_mbs) {
                    emit_pull_f32("pull_mbs", s_last_pull_mbs, stats_score.mbs);
                    any_value_read = true;
                }
                if (stats_score.has_average_time_dilation_modifier) {
                    emit_pull_f32(
                        "pull_average_time_dilation_modifier",
                        s_last_pull_average_time_dilation_modifier,
                        stats_score.average_time_dilation_modifier
                    );
                    any_value_read = true;
                }
                if (stats_score.has_average_target_size_modifier) {
                    emit_pull_f32(
                        "pull_average_target_size_modifier",
                        s_last_pull_average_target_size_modifier,
                        stats_score.average_target_size_modifier
                    );
                    any_value_read = true;
                }
                if (stats_score.has_mult_average_time_dilation_modifier) {
                    emit_pull_i32(
                        "pull_mult_average_time_dilation_modifier",
                        s_last_pull_mult_average_time_dilation_modifier,
                        stats_score.mult_average_time_dilation_modifier ? 1 : 0
                    );
                    any_value_read = true;
                }
                if (stats_score.has_mult_average_target_size_modifier) {
                    emit_pull_i32(
                        "pull_mult_average_target_size_modifier",
                        s_last_pull_mult_average_target_size_modifier,
                        stats_score.mult_average_target_size_modifier ? 1 : 0
                    );
                    any_value_read = true;
                }
                if (s_non_ui_probe_enabled || s_log_all_events) {
                    static ScoreNativeSnapshot s_last_logged_stats{};
                    static bool s_has_last_logged_stats = false;
                    static RC::Unreal::UObject* s_last_logged_stats_manager = nullptr;
                    const bool manager_changed = (stats_manager != s_last_logged_stats_manager);
                    const bool has_any = score_snapshot_has_any_value(stats_score);
                    if (has_any && (!s_has_last_logged_stats || manager_changed
                        || score_snapshot_changed(s_last_logged_stats, stats_score))) {
                        s_last_logged_stats_manager = stats_manager;
                        s_last_logged_stats = stats_score;
                        s_has_last_logged_stats = true;
                        std::array<char, 1024> sbuf{};
                        std::snprintf(
                            sbuf.data(),
                            sbuf.size(),
                            "[direct_pull] stats_calc_score hs=%u hk=%u hh=%u hf=%u hacc=%u hdd=%u hdp=%u hde=%u hke=%u htr=%u hdt=%u hmbs=%u hatd=%u hats=%u hmatd=%u hmats=%u score=%.3f kills=%d fired=%d hit=%d acc=%.3f dmg_done=%.3f dmg_pos=%.3f dmg_eff=%.3f kill_eff=%.3f t_rem=%.3f dist=%.3f mbs=%.3f atd=%.3f ats=%.3f matd=%d mats=%d",
                            stats_score.has_score ? 1u : 0u,
                            stats_score.has_kills ? 1u : 0u,
                            stats_score.has_shots_hit ? 1u : 0u,
                            stats_score.has_shots_fired ? 1u : 0u,
                            stats_score.has_accuracy ? 1u : 0u,
                            stats_score.has_damage_done ? 1u : 0u,
                            stats_score.has_damage_possible ? 1u : 0u,
                            stats_score.has_damage_efficiency ? 1u : 0u,
                            stats_score.has_kill_efficiency ? 1u : 0u,
                            stats_score.has_time_remaining ? 1u : 0u,
                            stats_score.has_distance_traveled ? 1u : 0u,
                            stats_score.has_mbs ? 1u : 0u,
                            stats_score.has_average_time_dilation_modifier ? 1u : 0u,
                            stats_score.has_average_target_size_modifier ? 1u : 0u,
                            stats_score.has_mult_average_time_dilation_modifier ? 1u : 0u,
                            stats_score.has_mult_average_target_size_modifier ? 1u : 0u,
                            static_cast<double>(stats_score.score),
                            stats_score.kills,
                            stats_score.shots_fired,
                            stats_score.shots_hit,
                            static_cast<double>(stats_score.accuracy),
                            static_cast<double>(stats_score.damage_done),
                            static_cast<double>(stats_score.damage_possible),
                            static_cast<double>(stats_score.damage_efficiency),
                            static_cast<double>(stats_score.kill_efficiency),
                            static_cast<double>(stats_score.time_remaining),
                            static_cast<double>(stats_score.distance_traveled),
                            static_cast<double>(stats_score.mbs),
                            static_cast<double>(stats_score.average_time_dilation_modifier),
                            static_cast<double>(stats_score.average_target_size_modifier),
                            stats_score.mult_average_time_dilation_modifier ? 1 : 0,
                            stats_score.mult_average_target_size_modifier ? 1 : 0
                        );
                        events_log_line(sbuf.data());
                    }
                }
            }
            if (call_receive_float(stats_manager, s_targets.stats_get_last_score, f32v)) {
                emit_pull_f32("pull_last_score", s_last_pull_last_score, f32v);
                any_value_read = true;
            }
            if (call_receive_float(stats_manager, s_targets.stats_get_session_best_score, f32v)) {
                emit_pull_f32("pull_session_best_score", s_last_pull_session_best_score, f32v);
                any_value_read = true;
            }
            if (call_receive_float(stats_manager, s_targets.stats_get_previous_session_best_score, f32v)) {
                emit_pull_f32("pull_previous_session_best_score", s_last_pull_previous_session_best_score, f32v);
                any_value_read = true;
            }
            if (call_receive_float(stats_manager, s_targets.stats_get_previous_high_score, f32v)) {
                emit_pull_f32("pull_previous_high_score", s_last_pull_previous_high_score, f32v);
                any_value_read = true;
            }
            if (call_receive_float(stats_manager, s_targets.stats_get_last_challenge_time_remaining, f32v)) {
                emit_pull_f32("pull_last_challenge_time_remaining", s_last_pull_last_challenge_time_remaining, f32v);
                any_value_read = true;
            }
        }
        auto* scenario_manager = resolve_scenario_manager_instance(now);
        if (scenario_manager && is_likely_valid_object_ptr(scenario_manager)) {
            if (call_receive_float(scenario_manager, s_targets.scenario_get_challenge_time_elapsed, f32v)) {
                emit_pull_f32("pull_challenge_seconds_total", s_last_pull_challenge_seconds, f32v);
                if (f32v > 0.0f) {
                    emit_pull_f32("pull_seconds_total", s_last_pull_seconds, f32v);
                }
                any_value_read = true;
            }
            if (call_receive_float(scenario_manager, s_targets.scenario_get_challenge_time_remaining_runtime, f32v)) {
                emit_pull_f32("pull_time_remaining", s_last_pull_time_remaining, f32v);
                any_value_read = true;
            }
            if (call_receive_float(scenario_manager, s_targets.scenario_get_realtime_challenge_time_length, f32v)) {
                emit_pull_f32("pull_challenge_time_length", s_last_pull_challenge_time_length, f32v);
                any_value_read = true;
            }
        }
        auto* sandbox_session_stats = resolve_sandbox_session_stats_instance(now);
        if (sandbox_session_stats && is_likely_valid_object_ptr(sandbox_session_stats)) {
            if (call_receive_float(sandbox_session_stats, s_targets.sandbox_get_challenge_time_in_seconds, f32v)) {
                emit_pull_f32("pull_challenge_seconds_total", s_last_pull_challenge_seconds, f32v);
                if (f32v > 0.0f) {
                    emit_pull_f32("pull_seconds_total", s_last_pull_seconds, f32v);
                }
                any_value_read = true;
            }
            if (call_receive_float(sandbox_session_stats, s_targets.sandbox_get_realtime_challenge_time_length, f32v)) {
                emit_pull_f32("pull_challenge_time_length", s_last_pull_challenge_time_length, f32v);
                any_value_read = true;
            }
        }
        // Score can remain zero via direct state/scenario/stats calls in some runtime contexts.
        // Fallback to live score text widgets without enabling full object debug/UI field spam.
        if (s_score_ui_fallback_enabled && poll_live_score_ui_text(now, f32v)) {
            if (f32v > 0.0f || s_last_pull_score <= 0.0f) {
                consider_score_candidate("ui_score_widget", f32v, k_score_rank_ui);
                any_value_read = true;
            }
        }
        if (s_object_debug_enabled || s_ui_counter_fallback_enabled) {
            if (poll_session_statistics_ui_text(now, s_object_debug_enabled)) {
                any_value_read = true;
            }
        }
        // Derived score fallback from working metrics path.
        // When direct score sources are unstable/zero, SPM * seconds gives a usable live score signal.
        const bool spm_fresh = s_last_pull_spm > 0.0f && (now - s_last_nonzero_spm_ms) < 4000;
        const bool seconds_fresh = s_last_pull_seconds > 0.0f && (now - s_last_nonzero_seconds_ms) < 4000;
        if (spm_fresh && seconds_fresh) {
            const float derived_score = (s_last_pull_spm * s_last_pull_seconds) / 60.0f;
            if (std::isfinite(derived_score) && derived_score >= 0.0f && derived_score < 100000000.0f) {
                emit_pull_f32("pull_score_total_derived", s_last_pull_score_derived, derived_score);
                consider_score_candidate("derived_spm_seconds", derived_score, k_score_rank_derived);
                any_value_read = true;
            }
        }

        if (score_candidate.valid) {
            emit_pull_score(score_candidate.source, score_candidate.value);
            any_value_read = true;
        }

        if (any_value_read) {
            s_last_pull_success_ms = now;
        }

        if (s_last_pull_success_ms == 0) {
            s_last_pull_success_ms = now;
        } else if ((now - s_last_pull_success_ms) > 5000) {
            s_state_receiver_instance = nullptr;
            s_scenario_state_receiver_instance = nullptr;
            s_stats_manager_instance = nullptr;
            s_scenario_manager_instance = nullptr;
            s_sandbox_session_stats_instance = nullptr;
            s_receiver_props_bound_class = nullptr;
            s_receiver_numeric_bindings.clear();
            s_receiver_prop_last_bits.clear();
            s_receiver_prop_emit_counts.clear();
            s_stats_props_bound_class = nullptr;
            s_stats_numeric_bindings.clear();
            s_stats_prop_last_bits.clear();
            s_stats_prop_emit_counts.clear();
            s_next_stats_bind_retry_ms = 0;
            {
                std::lock_guard<std::mutex> guard(s_state_mutex);
                s_invoke_numeric_last_bits.clear();
            }
            s_next_receiver_resolve_ms = 0;
            s_next_scenario_receiver_resolve_ms = 0;
            s_next_stats_manager_resolve_ms = 0;
            s_next_scenario_manager_resolve_ms = 0;
            s_next_sandbox_stats_resolve_ms = 0;
            events_log_line("[direct_pull] stale values detected, forcing receiver reselect");
            s_last_pull_success_ms = now;
        }

        if ((s_log_all_events || s_non_ui_probe_enabled) && now >= s_next_pull_debug_ms) {
            s_next_pull_debug_ms = now + 1000;
            struct PullDebugSnapshot {
                int32_t kills{-1};
                int32_t fired{-1};
                int32_t hit{-1};
                float score{-1.0f};
                char score_source[48]{};
                float sec{-1.0f};
                float spm{-1.0f};
                float kps{-1.0f};
                float acc{-1.0f};
                float ch_sec{-1.0f};
                float ch_len{-1.0f};
                int32_t ch_tick{-1};
                float ch_fps{-1.0f};
                float sens{-1.0f};
                float dmg_done{-1.0f};
                float dmg_pos{-1.0f};
                float dmg_eff{-1.0f};
                float kill_eff{-1.0f};
                float time_remaining{-1.0f};
                float distance_traveled{-1.0f};
                float mbs{-1.0f};
                float avg_time_dilation{-1.0f};
                float avg_target_size{-1.0f};
                int32_t mult_avg_time_dilation{-1};
                int32_t mult_avg_target_size{-1};
                float last_score{-1.0f};
                float sess_best{-1.0f};
                float prev_sess_best{-1.0f};
                float prev_high{-1.0f};
                float last_time_remaining{-1.0f};
                float score_derived{-1.0f};
            };
            static PullDebugSnapshot s_last_debug_snapshot{};
            static bool s_has_debug_snapshot = false;
            PullDebugSnapshot current{};
            current.kills = s_last_pull_kills;
            current.fired = s_last_pull_shots_fired;
            current.hit = s_last_pull_shots_hit;
            current.score = s_last_pull_score;
            std::snprintf(
                current.score_source,
                sizeof(current.score_source),
                "%s",
                s_last_pull_score_source.empty() ? "none" : s_last_pull_score_source.c_str()
            );
            current.sec = s_last_pull_seconds;
            current.spm = s_last_pull_spm;
            current.kps = s_last_pull_kps;
            current.acc = s_last_pull_accuracy;
            current.ch_sec = s_last_pull_challenge_seconds;
            current.ch_len = s_last_pull_challenge_time_length;
            current.ch_tick = s_last_pull_challenge_tick_count;
            current.ch_fps = s_last_pull_challenge_average_fps;
            current.sens = s_last_pull_random_sens_scale;
            current.dmg_done = s_last_pull_damage_done;
            current.dmg_pos = s_last_pull_damage_possible;
            current.dmg_eff = s_last_pull_damage_efficiency;
            current.kill_eff = s_last_pull_kill_efficiency;
            current.time_remaining = s_last_pull_time_remaining;
            current.distance_traveled = s_last_pull_distance_traveled;
            current.mbs = s_last_pull_mbs;
            current.avg_time_dilation = s_last_pull_average_time_dilation_modifier;
            current.avg_target_size = s_last_pull_average_target_size_modifier;
            current.mult_avg_time_dilation = s_last_pull_mult_average_time_dilation_modifier;
            current.mult_avg_target_size = s_last_pull_mult_average_target_size_modifier;
            current.last_score = s_last_pull_last_score;
            current.sess_best = s_last_pull_session_best_score;
            current.prev_sess_best = s_last_pull_previous_session_best_score;
            current.prev_high = s_last_pull_previous_high_score;
            current.last_time_remaining = s_last_pull_last_challenge_time_remaining;
            current.score_derived = s_last_pull_score_derived;

            if (!s_has_debug_snapshot
                || std::memcmp(&s_last_debug_snapshot, &current, sizeof(PullDebugSnapshot)) != 0) {
                s_last_debug_snapshot = current;
                s_has_debug_snapshot = true;
                std::array<char, 768> dbuf{};
                std::snprintf(
                    dbuf.data(),
                    dbuf.size(),
                    "[direct_pull_values] kills=%d fired=%d hit=%d score=%.3f score_src=%s score_derived=%.3f sec=%.3f spm=%.3f kps=%.3f acc=%.3f ch_sec=%.3f ch_len=%.3f ch_tick=%d ch_fps=%.3f sens=%.3f dmg_done=%.3f dmg_pos=%.3f dmg_eff=%.3f kill_eff=%.3f t_rem=%.3f dist=%.3f mbs=%.3f atd=%.3f ats=%.3f matd=%d mats=%d last=%.3f best=%.3f prev_best=%.3f prev_high=%.3f last_t_rem=%.3f origin=%s origin_flag=%s",
                    current.kills,
                    current.fired,
                    current.hit,
                    static_cast<double>(current.score),
                    current.score_source,
                    static_cast<double>(current.score_derived),
                    static_cast<double>(current.sec),
                    static_cast<double>(current.spm),
                    static_cast<double>(current.kps),
                    static_cast<double>(current.acc),
                    static_cast<double>(current.ch_sec),
                    static_cast<double>(current.ch_len),
                    current.ch_tick,
                    static_cast<double>(current.ch_fps),
                    static_cast<double>(current.sens),
                    static_cast<double>(current.dmg_done),
                    static_cast<double>(current.dmg_pos),
                    static_cast<double>(current.dmg_eff),
                    static_cast<double>(current.kill_eff),
                    static_cast<double>(current.time_remaining),
                    static_cast<double>(current.distance_traveled),
                    static_cast<double>(current.mbs),
                    static_cast<double>(current.avg_time_dilation),
                    static_cast<double>(current.avg_target_size),
                    current.mult_avg_time_dilation,
                    current.mult_avg_target_size,
                    static_cast<double>(current.last_score),
                    static_cast<double>(current.sess_best),
                    static_cast<double>(current.prev_sess_best),
                    static_cast<double>(current.prev_high),
                    static_cast<double>(current.last_time_remaining),
                    s_emit_origin ? s_emit_origin : "unknown",
                    s_emit_origin_flag ? s_emit_origin_flag : "unknown"
                );
                events_log_line(dbuf.data());
            }
        }
    }

    static auto bind_probe_hook(RC::Unreal::UFunction* fn) -> bool {
        if (!fn || !is_likely_valid_object_ptr(fn)) {
            return false;
        }
        const auto full_name = fn->GetFullName();
        if (full_name.empty() || full_name.find(STR(" None.")) != RC::StringType::npos) {
            return false;
        }
        // Stability gate: only bind native functions with a valid native pointer.
        // Script-only UFunctions can cause UE4SS dispatch faults under wide probing.
        const auto native_fn = fn->GetFunc();
        if (!native_fn || !fn->HasAnyFunctionFlags(RC::Unreal::EFunctionFlags::FUNC_Native)) {
            return false;
        }
        for (const auto& existing : s_native_hook_bindings) {
            if (existing.first == fn) {
                return false;
            }
        }
        const auto callback_id = fn->RegisterPostHook(
            [](RC::Unreal::UnrealScriptFunctionCallableContext& call_ctx, void* custom_data) {
                if (!s_pe_events_enabled) {
                    return;
                }
                auto* hooked_fn = reinterpret_cast<RC::Unreal::UFunction*>(custom_data);
                if (!hooked_fn || !is_likely_valid_object_ptr(hooked_fn)) {
                    return;
                }
                s_class_probe_hook_calls.fetch_add(1, std::memory_order_relaxed);
                if (!(s_log_all_events || s_object_debug_enabled || s_non_ui_probe_enabled)) {
                    return;
                }
                if (!should_emit_probe_for(hooked_fn)) {
                    return;
                }
                const auto full_name = hooked_fn->GetFullName();
                const bool strict_non_ui = s_non_ui_probe_enabled && !s_log_all_events && !s_object_debug_enabled;
                if (strict_non_ui) {
                    if (full_name.find(STR("/Script/")) == RC::StringType::npos) {
                        return;
                    }
                    if (!is_non_ui_probe_candidate(full_name)) {
                        return;
                    }
                    if (!is_probe_function_name_interesting(full_name)) {
                        return;
                    }
                    if (!allow_class_probe_log()) {
                        return;
                    }
                }
                RC::StringType ctx_name(STR("<null>"));
                if (call_ctx.Context && is_likely_valid_object_ptr(call_ctx.Context)) {
                    ctx_name = call_ctx.Context->GetFullName();
                }
                const auto fn_utf8 = escape_json(utf8_from_wide(full_name));
                const auto ctx_utf8 = escape_json(utf8_from_wide(ctx_name));
                auto* frame_50 = reinterpret_cast<RC::Unreal::FFrame_50_AndBelow*>(&call_ctx.TheStack);
                void* parms = frame_50 ? static_cast<void*>(frame_50->Locals) : nullptr;
                uint32_t u32_0 = 0;
                uint32_t u32_20 = 0;
                uint32_t ret_u32 = 0;
                int32_t i32_0 = 0;
                int32_t i32_20 = 0;
                int32_t ret_i32 = 0;
                float f32_0 = 0.0f;
                float f32_20 = 0.0f;
                float ret_f32 = 0.0f;
                const bool has_0 = try_read_probe_scalar(parms, 0x0, u32_0, i32_0, f32_0);
                const bool has_20 = try_read_probe_scalar(parms, 0x20, u32_20, i32_20, f32_20);
                const bool has_ret = try_read_probe_scalar(call_ctx.RESULT_DECL, 0x0, ret_u32, ret_i32, ret_f32);
                const double f32_0_safe = (has_0 && std::isfinite(f32_0)) ? static_cast<double>(f32_0) : 0.0;
                const double f32_20_safe = (has_20 && std::isfinite(f32_20)) ? static_cast<double>(f32_20) : 0.0;
                const double ret_f32_safe = (has_ret && std::isfinite(ret_f32)) ? static_cast<double>(ret_f32) : 0.0;
                std::array<char, 4096> msg{};
                std::snprintf(
                    msg.data(),
                    msg.size(),
                    "{\"ev\":\"class_hook_probe\",\"fn\":\"%s\",\"ctx\":\"%s\",\"has_parms\":%u,\"has_0\":%u,\"u32_0\":%u,\"i32_0\":%d,\"f32_0\":%.6f,\"has_20\":%u,\"u32_20\":%u,\"i32_20\":%d,\"f32_20\":%.6f,\"has_ret\":%u,\"ret_u32\":%u,\"ret_i32\":%d,\"ret_f32\":%.6f}",
                    fn_utf8.c_str(),
                    ctx_utf8.c_str(),
                    parms ? 1u : 0u,
                    has_0 ? 1u : 0u,
                    static_cast<unsigned>(u32_0),
                    i32_0,
                    f32_0_safe,
                    has_20 ? 1u : 0u,
                    static_cast<unsigned>(u32_20),
                    i32_20,
                    f32_20_safe,
                    has_ret ? 1u : 0u,
                    static_cast<unsigned>(ret_u32),
                    ret_i32,
                    ret_f32_safe
                );
                kovaaks::RustBridge::emit_json(msg.data());
                std::array<char, 1024> lbuf{};
                std::snprintf(
                    lbuf.data(),
                    lbuf.size(),
                    "[class_hook_probe] fn=%ls has_0=%u i32_0=%d f32_0=%.6f has_20=%u i32_20=%d f32_20=%.6f has_ret=%u ret_i32=%d ret_f32=%.6f",
                    full_name.c_str(),
                    has_0 ? 1u : 0u,
                    i32_0,
                    f32_0_safe,
                    has_20 ? 1u : 0u,
                    i32_20,
                    f32_20_safe,
                    has_ret ? 1u : 0u,
                    ret_i32,
                    ret_f32_safe
                );
                events_log_line(lbuf.data());
            },
            fn
        );
        s_native_hook_bindings.emplace_back(fn, callback_id);
        return true;
    }

    static auto register_diagnostic_probe_hooks() -> void {
        if (!(s_log_all_events || s_object_debug_enabled || s_non_ui_probe_enabled)) {
            return;
        }
        if (!s_class_probe_hooks_enabled) {
            return;
        }
        const bool already = s_probe_hooks_registered.exchange(true, std::memory_order_acq_rel);
        if (already) {
            return;
        }

        std::vector<RC::Unreal::UObject*> all_functions{};
        RC::Unreal::UObjectGlobals::FindAllOf(STR("Function"), all_functions);
        if (all_functions.empty()) {
            s_probe_hooks_registered.store(false, std::memory_order_release);
            return;
        }

        const std::array<const wchar_t*, 7> probe_needles{
            STR("PerformanceIndicatorsStateReceiver:"),
            STR("PerformanceIndicatorsBroadcastReceiver:"),
            STR("WeaponParentActor:"),
            STR("ScenarioBroadcastReceiver:"),
            STR("ScenarioManager:"),
            STR("AnalyticsManager:"),
            STR("GTheMetaGameInstance:")
        };
        uint32_t class_probe_bound = 0;
        const bool strict_non_ui = s_non_ui_probe_enabled && !s_log_all_events && !s_object_debug_enabled;
        constexpr uint32_t k_max_strict_probe_hooks = 128;
        constexpr uint32_t k_max_probe_hooks = 256;
        for (auto* obj : all_functions) {
            if (!obj || !is_likely_valid_object_ptr(obj)) {
                continue;
            }
            const auto full_name = obj->GetFullName();
            bool matches = false;
            for (const auto* needle : probe_needles) {
                if (needle && full_name.find(needle) != RC::StringType::npos) {
                    matches = true;
                    break;
                }
            }
            if (!matches) {
                continue;
            }
            if (strict_non_ui) {
                if (full_name.find(STR("/Script/")) == RC::StringType::npos) {
                    continue;
                }
                if (!is_non_ui_probe_candidate(full_name)) {
                    continue;
                }
                if (!is_probe_function_name_interesting(full_name)) {
                    continue;
                }
            }
            if (bind_probe_hook(static_cast<RC::Unreal::UFunction*>(obj))) {
                ++class_probe_bound;
                if (strict_non_ui && class_probe_bound >= k_max_strict_probe_hooks) {
                    break;
                }
                if (class_probe_bound >= k_max_probe_hooks) {
                    break;
                }
            }
        }
        std::array<char, 192> pbuf{};
        std::snprintf(
            pbuf.data(),
            pbuf.size(),
            "[KovaaksBridgeMod] class probe hooks bound=%u (from %u functions)",
            class_probe_bound,
            static_cast<uint32_t>(all_functions.size())
        );
        runtime_log_line(pbuf.data());
        events_log_line(pbuf.data());
    }

    static auto register_native_u_function_hooks() -> void {
        const bool already = s_native_hooks_registered.exchange(true, std::memory_order_acq_rel);
        if (already) {
            return;
        }

        s_native_hook_bindings.clear();
        auto bind = [](RC::Unreal::UFunction* fn, EventKind kind) {
            if (!fn) {
                return;
            }
            const auto native_fn = fn->GetFunc();
            const auto func_ptr = fn->GetFuncPtr();
            if (!native_fn || !func_ptr || !fn->HasAnyFunctionFlags(RC::Unreal::EFunctionFlags::FUNC_Native)) {
                return;
            }
            const auto callback_id = fn->RegisterPostHook(
                [](RC::Unreal::UnrealScriptFunctionCallableContext&, void* custom_data) {
                    if (!s_pe_events_enabled) {
                        return;
                    }
                    const auto raw = reinterpret_cast<uintptr_t>(custom_data);
                    const auto event_kind = static_cast<EventKind>(raw);
                    s_bound_hook_calls.fetch_add(1, std::memory_order_relaxed);
                    const auto idx = static_cast<size_t>(event_kind);
                    if (idx < k_event_kind_slot_count) {
                        const auto hit = s_event_kind_hits[idx].fetch_add(1, std::memory_order_relaxed) + 1;
                        if (hit <= 5) {
                            std::array<char, 160> buf{};
                            std::snprintf(
                                buf.data(),
                                buf.size(),
                                "[hook_kind_hit] kind=%s count=%llu",
                                event_kind_name(event_kind),
                                static_cast<unsigned long long>(hit)
                            );
                            events_log_line(buf.data());
                        }
                    }
                    emit_event_kind(event_kind);
                },
                reinterpret_cast<void*>(static_cast<uintptr_t>(kind))
            );
            s_native_hook_bindings.emplace_back(fn, callback_id);
        };
        // Match the explicit target set with direct UFunction hooks.
        bind(s_targets.send_score, EventKind::Score);
        bind(s_targets.send_kills, EventKind::Kills);
        bind(s_targets.send_shots_hit, EventKind::ShotsHit);
        bind(s_targets.send_shots_fired, EventKind::ShotsFired);
        bind(s_targets.send_seconds, EventKind::Seconds);
        bind(s_targets.send_damage_done, EventKind::DamageDone);
        bind(s_targets.send_damage_possible, EventKind::DamagePossible);
        bind(s_targets.send_challenge_seconds, EventKind::ChallengeSeconds);
        bind(s_targets.send_challenge_tick_count, EventKind::ChallengeTickCount);
        bind(s_targets.receive_score, EventKind::Score);
        bind(s_targets.receive_score_single, EventKind::Score);
        bind(s_targets.receive_score_value_else, EventKind::Score);
        bind(s_targets.receive_score_value_or, EventKind::Score);
        bind(s_targets.receive_kills, EventKind::Kills);
        bind(s_targets.receive_shots_hit, EventKind::ShotsHit);
        bind(s_targets.receive_shots_fired, EventKind::ShotsFired);
        bind(s_targets.receive_shots_hit_single, EventKind::ShotsHit);
        bind(s_targets.receive_shots_hit_value_else, EventKind::ShotsHit);
        bind(s_targets.receive_shots_fired_single, EventKind::ShotsFired);
        bind(s_targets.receive_shots_fired_value_else, EventKind::ShotsFired);
        bind(s_targets.receive_shots_fired_value_or, EventKind::ShotsFired);
        bind(s_targets.receive_seconds, EventKind::Seconds);
        bind(s_targets.receive_damage_done, EventKind::DamageDone);
        bind(s_targets.receive_damage_possible, EventKind::DamagePossible);
        bind(s_targets.receive_damage_efficiency, EventKind::DamagePossible);
        bind(s_targets.receive_score_per_minute, EventKind::Score);
        bind(s_targets.receive_kills_per_second, EventKind::Kills);
        bind(s_targets.receive_challenge_seconds, EventKind::ChallengeSeconds);
        bind(s_targets.receive_challenge_tick_count, EventKind::ChallengeTickCount);

        bind(s_targets.send_shot_hit_br, EventKind::ShotHit);
        bind(s_targets.send_shot_missed_br, EventKind::ShotMissed);
        bind(s_targets.send_shot_fired_br, EventKind::ShotFired);
        bind(s_targets.send_kill_br, EventKind::Kill);
        bind(s_targets.receive_shot_hit_br, EventKind::ShotHit);
        bind(s_targets.receive_shot_missed_br, EventKind::ShotMissed);
        bind(s_targets.receive_shot_fired_br, EventKind::ShotFired);
        bind(s_targets.receive_kill_br, EventKind::Kill);
        bind(s_targets.send_shot_hit_weapon, EventKind::ShotHit);
        bind(s_targets.send_shot_missed_weapon, EventKind::ShotMissed);
        bind(s_targets.send_shot_fired_weapon, EventKind::ShotFired);
        bind(s_targets.send_kill_weapon, EventKind::Kill);
        bind(s_targets.receive_shot_hit_weapon, EventKind::ShotHit);
        bind(s_targets.receive_shot_missed_weapon, EventKind::ShotMissed);
        bind(s_targets.receive_shot_fired_weapon, EventKind::ShotFired);
        bind(s_targets.receive_kill_weapon, EventKind::Kill);

        bind(s_targets.send_challenge_queued, EventKind::ChallengeQueued);
        bind(s_targets.send_challenge_complete, EventKind::ChallengeComplete);
        bind(s_targets.send_challenge_canceled, EventKind::ChallengeCanceled);
        bind(s_targets.send_post_challenge_complete, EventKind::PostChallengeComplete);
        bind(s_targets.on_challenge_started, EventKind::ChallengeStart);
        bind(s_targets.on_challenge_restarted, EventKind::ChallengeRestart);
        bind(s_targets.on_challenge_quit, EventKind::ChallengeQuit);
        bind(s_targets.on_challenge_completed, EventKind::ChallengeCompleted);
        bind(s_targets.meta_notify_player_fire_weapon, EventKind::ShotFired);
        bind(s_targets.meta_on_hit_scan, EventKind::ShotHit);
        bind(s_targets.meta_on_spawn_projectile, EventKind::ShotFired);

        const bool enable_ui_settext_hook =
            env_flag_enabled("KOVAAKS_UI_SETTEXT_HOOK")
            || ui_settext_hook_flag_enabled();
        // Focused fallback on SessionStatistics widget updates.
        auto* text_set_fn = find_fn(STR("/Script/UMG.TextBlock:SetText"));
        s_text_get_fn = find_fn(STR("/Script/UMG.TextBlock:GetText"));
        if (enable_ui_settext_hook && text_set_fn) {
            const auto callback_id = text_set_fn->RegisterPostHook(
                [](RC::Unreal::UnrealScriptFunctionCallableContext& call_ctx, void*) {
                    if (!s_pe_events_enabled || !call_ctx.Context || !is_likely_valid_object_ptr(call_ctx.Context)) {
                        return;
                    }
                    s_ui_settext_hook_calls.fetch_add(1, std::memory_order_relaxed);
                    const auto ctx_name = call_ctx.Context->GetFullName();
                    auto* frame_50 = reinterpret_cast<RC::Unreal::FFrame_50_AndBelow*>(&call_ctx.TheStack);
                    void* locals = frame_50 ? static_cast<void*>(frame_50->Locals) : nullptr;
                    RC::StringType text_value{};
                    bool have_text_value = false;
                    if (locals && is_likely_readable_region(locals, sizeof(RC::Unreal::FText))) {
                        struct TextBlockSetTextParams {
                            RC::Unreal::FText InText;
                        };
                        auto* set_params = reinterpret_cast<TextBlockSetTextParams*>(locals);
                        text_value = set_params->InText.ToString();
                        have_text_value = !text_value.empty();
                    }
                    if (!have_text_value && s_text_get_fn && is_likely_valid_object_ptr(s_text_get_fn)) {
                        struct TextBlockGetTextParams {
                            RC::Unreal::FText ReturnValue;
                        } params{};
                        call_ctx.Context->ProcessEvent(s_text_get_fn, &params);
                        text_value = params.ReturnValue.ToString();
                        have_text_value = !text_value.empty();
                    }
                    if (s_log_all_events || s_object_debug_enabled) {
                        std::array<char, 3072> buf{};
                        std::snprintf(
                            buf.data(),
                            buf.size(),
                            "[ui_settext] ctx=%ls text=%ls",
                            ctx_name.c_str(),
                            text_value.c_str()
                        );
                        events_log_line(buf.data());
                    }
                    const auto ui_field = classify_session_ui_field(ctx_name);
                    if (ui_field != nullptr) {
                        s_ui_field_update_calls.fetch_add(1, std::memory_order_relaxed);
                        if (s_log_all_events || s_object_debug_enabled) {
                            std::array<char, 160> lbuf{};
                            std::snprintf(lbuf.data(), lbuf.size(), "[ui_field] field=%s", ui_field);
                            events_log_line(lbuf.data());
                        }
                        const auto value_utf8 = escape_json(utf8_from_wide(text_value));
                        std::string msg;
                        if (value_utf8.empty()) {
                            msg = std::string("{\"ev\":\"ui_field_update\",\"field\":\"") + ui_field + "\"}";
                        } else {
                            msg = std::string("{\"ev\":\"ui_field_update\",\"field\":\"") + ui_field
                                + "\",\"value\":\"" + value_utf8 + "\"}";
                        }
                        kovaaks::RustBridge::emit_json(msg.c_str());
                        if (maybe_emit_derived_ui_counter(ui_field, text_value)) {
                            s_ui_derived_emit_calls.fetch_add(1, std::memory_order_relaxed);
                        } else if ((s_non_ui_probe_enabled || s_log_all_events || s_object_debug_enabled) && !text_value.empty()) {
                            std::array<char, 256> pbuf{};
                            std::snprintf(
                                pbuf.data(),
                                pbuf.size(),
                                "[ui_field_parse_miss] field=%s text=%ls",
                                ui_field,
                                text_value.c_str()
                            );
                            events_log_line(pbuf.data());
                        }
                    }
                    if (ctx_name.find(STR("SessionStatistics_C")) == RC::StringType::npos) {
                        return;
                    }

                    if (ctx_name.find(STR("SessionHits")) != RC::StringType::npos) {
                        emit_simple_event("session_hits_ui_update");
                    } else if (ctx_name.find(STR("SessionShots")) != RC::StringType::npos) {
                        emit_simple_event("session_shots_ui_update");
                    } else if (ctx_name.find(STR("KillCounter")) != RC::StringType::npos) {
                        emit_simple_event("session_kills_ui_update");
                    } else if (ctx_name.find(STR("DamageDone")) != RC::StringType::npos) {
                        emit_simple_event("session_damage_done_ui_update");
                    } else if (ctx_name.find(STR("DamagePossible")) != RC::StringType::npos) {
                        emit_simple_event("session_damage_possible_ui_update");
                    } else {
                        emit_simple_event("session_stats_ui_update");
                    }

                },
                nullptr
            );
            s_native_hook_bindings.emplace_back(text_set_fn, callback_id);
        } else if (!enable_ui_settext_hook) {
            runtime_log_line("[KovaaksBridgeMod] TextBlock:SetText hook disabled (opt-in)");
        }

        register_diagnostic_probe_hooks();

        std::array<char, 160> buf{};
        std::snprintf(
            buf.data(),
            buf.size(),
            "[KovaaksBridgeMod] native UFunction hooks registered (%u)",
            static_cast<uint32_t>(s_native_hook_bindings.size())
        );
        runtime_log_line(buf.data());
        RC::Output::send<RC::LogLevel::Warning>(
            STR("[KovaaksBridgeMod] native UFunction hooks registered ({}).\n"),
            static_cast<uint32_t>(s_native_hook_bindings.size())
        );
    }

    static auto process_script_post_common(
        const char* source,
        RC::Unreal::UObject* context,
        RC::Unreal::UFunction* function,
        void* parms,
        void* result_decl
    ) -> void {
        refresh_runtime_flags(false);
        if (!s_pe_events_enabled) {
            return;
        }
        const char* source_flag = "script_hook";
        if (source && std::strcmp(source, "process_internal") == 0) {
            source_flag = "hook_process_internal";
        } else if (source && std::strcmp(source, "process_local_script") == 0) {
            source_flag = "hook_process_local_script";
        }
        EmitContextScope emit_ctx(source ? source : "script_hook", source_flag);
        if (!function || !is_likely_valid_object_ptr(function)) {
            return;
        }
        const auto full_name = function->GetFullName();
        if (full_name.empty()) {
            return;
        }
        RC::StringType ctx_name(STR("<null>"));
        if (context && is_likely_valid_object_ptr(context)) {
            ctx_name = context->GetFullName();
        }
        const auto fn_utf8 = escape_json(utf8_from_wide(full_name));
        const auto ctx_utf8 = escape_json(utf8_from_wide(ctx_name));

        if ((s_non_ui_probe_enabled || s_log_all_events) && is_non_ui_probe_candidate(full_name) && should_emit_probe_for(function)) {
            const bool strict_non_ui = s_non_ui_probe_enabled && !s_log_all_events && !s_object_debug_enabled;
            if (!strict_non_ui || (is_probe_function_name_interesting(full_name) && allow_class_probe_log())) {
                uint32_t u32_0 = 0;
                uint32_t u32_20 = 0;
                uint32_t ret_u32 = 0;
                int32_t i32_0 = 0;
                int32_t i32_20 = 0;
                int32_t ret_i32 = 0;
                float f32_0 = 0.0f;
                float f32_20 = 0.0f;
                float ret_f32 = 0.0f;
                const bool has_0 = try_read_probe_scalar(parms, 0x0, u32_0, i32_0, f32_0);
                const bool has_20 = try_read_probe_scalar(parms, 0x20, u32_20, i32_20, f32_20);
                const bool has_ret = try_read_probe_scalar(result_decl, 0x0, ret_u32, ret_i32, ret_f32);
                const double f32_0_safe = (has_0 && std::isfinite(f32_0)) ? static_cast<double>(f32_0) : 0.0;
                const double f32_20_safe = (has_20 && std::isfinite(f32_20)) ? static_cast<double>(f32_20) : 0.0;
                const double ret_f32_safe = (has_ret && std::isfinite(ret_f32)) ? static_cast<double>(ret_f32) : 0.0;

                std::array<char, 4096> msg{};
                std::snprintf(
                    msg.data(),
                    msg.size(),
                    "{\"ev\":\"script_hook_probe\",\"src\":\"%s\",\"fn\":\"%s\",\"ctx\":\"%s\",\"has_parms\":%u,\"has_0\":%u,\"u32_0\":%u,\"i32_0\":%d,\"f32_0\":%.6f,\"has_20\":%u,\"u32_20\":%u,\"i32_20\":%d,\"f32_20\":%.6f,\"has_ret\":%u,\"ret_u32\":%u,\"ret_i32\":%d,\"ret_f32\":%.6f}",
                    source ? source : "unknown",
                    fn_utf8.c_str(),
                    ctx_utf8.c_str(),
                    parms ? 1u : 0u,
                    has_0 ? 1u : 0u,
                    static_cast<unsigned>(u32_0),
                    i32_0,
                    f32_0_safe,
                    has_20 ? 1u : 0u,
                    static_cast<unsigned>(u32_20),
                    i32_20,
                    f32_20_safe,
                    has_ret ? 1u : 0u,
                    static_cast<unsigned>(ret_u32),
                    ret_i32,
                    ret_f32_safe
                );
                kovaaks::RustBridge::emit_json(msg.data());
            }
        }

        // Parse key receiver values from script frame locals where possible.
        if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_Score")) != RC::StringType::npos) {
            s_receive_score_hits.fetch_add(1, std::memory_order_relaxed);
            uint32_t bits = 0;
            int32_t i32_unused = 0;
            float score = 0.0f;
            if (try_read_probe_scalar(parms, 0x20, bits, i32_unused, score) && std::isfinite(score)) {
                const auto prev = s_last_receive_score_bits.exchange(bits, std::memory_order_relaxed);
                if (bits != prev) {
                    emit_float_event("score_total", score);
                }
            }
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_ShotsFired")) != RC::StringType::npos) {
            s_receive_shots_fired_hits.fetch_add(1, std::memory_order_relaxed);
            uint32_t u32_unused = 0;
            int32_t fired = 0;
            float f32_unused = 0.0f;
            if (try_read_probe_scalar(parms, 0x20, u32_unused, fired, f32_unused)) {
                const auto prev = s_last_receive_shots_fired.exchange(fired, std::memory_order_relaxed);
                if (fired != prev) {
                    emit_int_event("shots_fired_total", fired);
                }
            }
        } else if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_ShotsHit")) != RC::StringType::npos) {
            s_receive_shots_hit_hits.fetch_add(1, std::memory_order_relaxed);
            uint32_t u32_unused = 0;
            int32_t hit = 0;
            float f32_unused = 0.0f;
            if (try_read_probe_scalar(parms, 0x20, u32_unused, hit, f32_unused)) {
                const auto prev = s_last_receive_shots_hit.exchange(hit, std::memory_order_relaxed);
                if (hit != prev) {
                    emit_int_event("shots_hit_total", hit);
                }
            }
        }

        // Emit simple scalar "Get_*" script returns for diagnostics.
        if (result_decl && is_non_ui_probe_candidate(full_name)) {
            uint32_t ret_u32 = 0;
            int32_t ret_i32 = 0;
            float ret_f32 = 0.0f;
            if (try_read_probe_scalar(result_decl, 0x0, ret_u32, ret_i32, ret_f32)) {
                if (full_name.find(STR("ScenarioManager:GetChallengeTimeRemaining")) != RC::StringType::npos && std::isfinite(ret_f32)) {
                    emit_float_event("challenge_time_remaining", ret_f32);
                } else if (full_name.find(STR("ScenarioManager:GetChallengeQueueTimeRemaining")) != RC::StringType::npos && std::isfinite(ret_f32)) {
                    emit_float_event("challenge_queue_time_remaining", ret_f32);
                } else if (full_name.find(STR("ScenarioManager:IsInChallenge")) != RC::StringType::npos) {
                    emit_int_event("is_in_challenge", ret_i32 != 0 ? 1 : 0);
                }
            }
        }

        const auto kind = classify_event_kind(function);
        if (kind != EventKind::None) {
            const auto idx = static_cast<size_t>(kind);
            if (idx < k_event_kind_slot_count) {
                const auto hit = s_event_kind_hits[idx].fetch_add(1, std::memory_order_relaxed) + 1;
                if (hit <= 5 && (s_non_ui_probe_enabled || s_log_all_events)) {
                    std::array<char, 192> buf{};
                    std::snprintf(
                        buf.data(),
                        buf.size(),
                        "[script_kind_hit] src=%s kind=%s count=%llu",
                        source ? source : "unknown",
                        event_kind_name(kind),
                        static_cast<unsigned long long>(hit)
                    );
                    events_log_line(buf.data());
                }
            }
            emit_event_kind(kind);
        }
    }

    static auto process_internal_post_hook(
        RC::Unreal::UObject* context,
        RC::Unreal::FFrame& stack,
        void* result_decl
    ) -> void {
        __try {
            s_process_internal_callback_count.fetch_add(1, std::memory_order_relaxed);
            const auto last_plsf_ms = s_last_process_local_script_ms.load(std::memory_order_relaxed);
            const auto now_ms = GetTickCount64();
            // On UE4.22+ ProcessLocalScriptFunction is the canonical path; skip duplicate ProcessInternal work.
            if (last_plsf_ms != 0 && (now_ms - last_plsf_ms) < 1000) {
                return;
            }
            RC::Unreal::UFunction* function = nullptr;
            RC::Unreal::UObject* frame_object = nullptr;
            void* parms = nullptr;
            if (!safe_extract_frame50(stack, function, frame_object, parms)) {
                return;
            }
            RC::Unreal::UObject* dispatch_context = context;
            if ((!dispatch_context || !is_likely_valid_object_ptr(dispatch_context)) && frame_object) {
                dispatch_context = frame_object;
            }
            process_script_post_common("process_internal", dispatch_context, function, parms, result_decl);
        } __except(EXCEPTION_EXECUTE_HANDLER) {
            const auto faults = s_script_callback_faults.fetch_add(1, std::memory_order_relaxed) + 1;
            if (faults <= 10 || (faults % 100) == 0) {
                events_log_line("[script_hook_fault] src=process_internal");
            }
        }
    }

    static auto process_local_script_post_hook(
        RC::Unreal::UObject* context,
        RC::Unreal::FFrame& stack,
        void* result_decl
    ) -> void {
        __try {
            const auto count = s_process_local_script_callback_count.fetch_add(1, std::memory_order_relaxed) + 1;
            s_last_process_local_script_ms.store(GetTickCount64(), std::memory_order_relaxed);
            if (count == 1) {
                runtime_log_line("[KovaaksBridgeMod] first ProcessLocalScriptFunction callback observed");
                kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_plsf_first_callback\"}");
            }
            RC::Unreal::UFunction* function = nullptr;
            RC::Unreal::UObject* frame_object = nullptr;
            void* parms = nullptr;
            if (!safe_extract_frame50(stack, function, frame_object, parms)) {
                return;
            }
            RC::Unreal::UObject* dispatch_context = context;
            if ((!dispatch_context || !is_likely_valid_object_ptr(dispatch_context)) && frame_object) {
                dispatch_context = frame_object;
            }
            process_script_post_common("process_local_script", dispatch_context, function, parms, result_decl);
        } __except(EXCEPTION_EXECUTE_HANDLER) {
            const auto faults = s_script_callback_faults.fetch_add(1, std::memory_order_relaxed) + 1;
            if (faults <= 10 || (faults % 100) == 0) {
                events_log_line("[script_hook_fault] src=process_local_script");
            }
        }
    }

    static auto process_event_pre_hook(
        RC::Unreal::UObject* context,
        RC::Unreal::UFunction* function,
        void* parms
    ) -> void {
        // Some UE4 builds appear to skip post callbacks in specific call paths.
        // If we haven't seen post activity yet, run the same dispatch from pre
        // so diagnostics/events still flow.
        if (s_process_event_post_seen.load(std::memory_order_relaxed) == 0) {
            process_event_post_hook(context, function, parms);
        }
    }

    static auto process_event_post_hook(
        RC::Unreal::UObject* context,
        RC::Unreal::UFunction* function,
        void* parms
    ) -> void {
        s_process_event_post_seen.fetch_add(1, std::memory_order_relaxed);
        const auto callback_count =
            s_process_event_callback_count.fetch_add(1, std::memory_order_relaxed) + 1;
        if (callback_count == 1) {
            RC::Output::send<RC::LogLevel::Warning>(
                STR("[KovaaksBridgeMod] first ProcessEvent callback observed.\n")
            );
            runtime_log_line("[KovaaksBridgeMod] first ProcessEvent callback observed");
            kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_pe_first_callback\"}");
        } else if ((callback_count % 5000) == 0) {
            std::array<char, 128> cb_buf{};
            std::snprintf(
                cb_buf.data(),
                cb_buf.size(),
                "[KovaaksBridgeMod] ProcessEvent callback count=%llu",
                static_cast<unsigned long long>(callback_count)
            );
            runtime_log_line(cb_buf.data());
        }

        refresh_runtime_flags(false);
        if (!s_pe_events_enabled) {
            return;
        }
        EmitContextScope emit_ctx("process_event", "hook_process_event");
        if (s_log_all_events || s_object_debug_enabled || s_non_ui_probe_enabled) {
            register_diagnostic_probe_hooks();
        }
        if (!function || !is_likely_valid_object_ptr(function)) {
            return;
        }

        // Secondary capture path from state receiver "Receive_*" reads that
        // SessionStatistics uses in blueprint logic. These fire even when
        // Send_* paths are skipped.
        const auto full_name = function->GetFullName();
        RC::StringType ctx_name(STR("<null>"));
        if (context && is_likely_valid_object_ptr(context)) {
            ctx_name = context->GetFullName();
        }
        const auto fn_utf8 = escape_json(utf8_from_wide(full_name));
        const auto ctx_utf8 = escape_json(utf8_from_wide(ctx_name));
        const auto emit_hook_trace = [&](const char* name) {
            std::array<char, 3072> msg{};
            std::snprintf(
                msg.data(),
                msg.size(),
                "{\"ev\":\"hook_event\",\"name\":\"%s\",\"fn\":\"%s\",\"ctx\":\"%s\"}",
                name,
                fn_utf8.c_str(),
                ctx_utf8.c_str()
            );
            kovaaks::RustBridge::emit_json(msg.data());
        };
        const auto emit_hook_trace_i32 = [&](const char* name, int32_t value) {
            std::array<char, 3072> msg{};
            std::snprintf(
                msg.data(),
                msg.size(),
                "{\"ev\":\"hook_event\",\"name\":\"%s\",\"value\":%d,\"fn\":\"%s\",\"ctx\":\"%s\"}",
                name,
                value,
                fn_utf8.c_str(),
                ctx_utf8.c_str()
            );
            kovaaks::RustBridge::emit_json(msg.data());
        };
        const auto emit_hook_trace_f32 = [&](const char* name, float value) {
            std::array<char, 3072> msg{};
            std::snprintf(
                msg.data(),
                msg.size(),
                "{\"ev\":\"hook_event\",\"name\":\"%s\",\"value\":%.6f,\"fn\":\"%s\",\"ctx\":\"%s\"}",
                name,
                static_cast<double>(value),
                fn_utf8.c_str(),
                ctx_utf8.c_str()
            );
            kovaaks::RustBridge::emit_json(msg.data());
        };
        if (s_log_all_events || s_object_debug_enabled) {
            std::array<char, 2048> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "[pe] n=%llu fn=%ls ctx=%ls",
                static_cast<unsigned long long>(callback_count),
                full_name.c_str(),
                ctx_name.c_str()
            );
            events_log_line(buf.data());
        }
        if ((s_non_ui_probe_enabled || s_log_all_events) && is_non_ui_probe_candidate(full_name) && should_emit_probe_for(function)) {
            uint32_t u32_0 = 0;
            uint32_t u32_20 = 0;
            int32_t i32_0 = 0;
            int32_t i32_20 = 0;
            float f32_0 = 0.0f;
            float f32_20 = 0.0f;
            const bool has_0 = try_read_probe_scalar(parms, 0x0, u32_0, i32_0, f32_0);
            const bool has_20 = try_read_probe_scalar(parms, 0x20, u32_20, i32_20, f32_20);
            const double f32_0_safe = (has_0 && std::isfinite(f32_0)) ? static_cast<double>(f32_0) : 0.0;
            const double f32_20_safe = (has_20 && std::isfinite(f32_20)) ? static_cast<double>(f32_20) : 0.0;
            std::array<char, 4096> msg{};
            std::snprintf(
                msg.data(),
                msg.size(),
                "{\"ev\":\"hook_probe\",\"fn\":\"%s\",\"ctx\":\"%s\",\"has_parms\":%u,\"has_0\":%u,\"u32_0\":%u,\"i32_0\":%d,\"f32_0\":%.6f,\"has_20\":%u,\"u32_20\":%u,\"i32_20\":%d,\"f32_20\":%.6f}",
                fn_utf8.c_str(),
                ctx_utf8.c_str(),
                parms ? 1u : 0u,
                has_0 ? 1u : 0u,
                static_cast<unsigned>(u32_0),
                i32_0,
                f32_0_safe,
                has_20 ? 1u : 0u,
                static_cast<unsigned>(u32_20),
                i32_20,
                f32_20_safe
            );
            kovaaks::RustBridge::emit_json(msg.data());
            std::array<char, 1024> lbuf{};
            std::snprintf(
                lbuf.data(),
                lbuf.size(),
                "[hook_probe] fn=%ls has_0=%u i32_0=%d f32_0=%.6f has_20=%u i32_20=%d f32_20=%.6f",
                full_name.c_str(),
                has_0 ? 1u : 0u,
                i32_0,
                f32_0_safe,
                has_20 ? 1u : 0u,
                i32_20,
                f32_20_safe
            );
            events_log_line(lbuf.data());
        }

        if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_Score")) != RC::StringType::npos) {
            s_receive_score_hits.fetch_add(1, std::memory_order_relaxed);
            if (parms) {
                const float value = *reinterpret_cast<const float*>(
                    reinterpret_cast<const uint8_t*>(parms) + 0x20
                );
                uint32_t bits = 0;
                std::memcpy(&bits, &value, sizeof(bits));
                const auto prev = s_last_receive_score_bits.exchange(bits, std::memory_order_relaxed);
                if (bits != prev) {
                    emit_float_event("score_total", value);
                }
                emit_float_event("score_counter", value);
                emit_hook_trace_f32("receive_score", value);
            }
            emit_event_kind(EventKind::Score);
            return;
        }

        if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_ShotsFired")) != RC::StringType::npos) {
            s_receive_shots_fired_hits.fetch_add(1, std::memory_order_relaxed);
            bool has_value = false;
            int32_t value = 0;
            if (parms) {
                value = *reinterpret_cast<const int32_t*>(
                    reinterpret_cast<const uint8_t*>(parms) + 0x20
                );
                has_value = true;
                const auto prev = s_last_receive_shots_fired.exchange(value, std::memory_order_relaxed);
                if (value != prev) {
                    emit_int_event("shots_fired_total", value);
                }
                emit_hook_trace_i32("receive_shots_fired", value);
            }
            if (has_value) {
                emit_int_event("shots_fired_counter", value);
            }
            emit_event_kind(EventKind::ShotsFired);
            return;
        }
        if (full_name.find(STR("PerformanceIndicatorsStateReceiver:Receive_ShotsHit")) != RC::StringType::npos) {
            s_receive_shots_hit_hits.fetch_add(1, std::memory_order_relaxed);
            bool has_value = false;
            int32_t value = 0;
            if (parms) {
                value = *reinterpret_cast<const int32_t*>(
                    reinterpret_cast<const uint8_t*>(parms) + 0x20
                );
                has_value = true;
                const auto prev = s_last_receive_shots_hit.exchange(value, std::memory_order_relaxed);
                if (value != prev) {
                    emit_int_event("shots_hit_total", value);
                }
                emit_hook_trace_i32("receive_shots_hit", value);
            }
            if (has_value) {
                emit_int_event("shots_hit_counter", value);
            }
            emit_event_kind(EventKind::ShotsHit);
            return;
        }

        // Performance indicator scalar values
        if (function == s_targets.send_score) {
            if (parms && is_likely_readable_region(parms, sizeof(float))) {
                const float value = *reinterpret_cast<const float*>(parms);
                emit_hook_trace_f32("send_score", value);
            } else {
                emit_hook_trace("send_score");
            }
            kovaaks::RustBridge::emit_json("{\"ev\":\"score\"}");
            return;
        }
        if (function == s_targets.send_random_sens_scale) {
            if (parms && is_likely_readable_region(parms, sizeof(float))) {
                const float value = *reinterpret_cast<const float*>(parms);
                emit_hook_trace_f32("send_random_sens_scale", value);
            } else {
                emit_hook_trace("send_random_sens_scale");
            }
            kovaaks::RustBridge::emit_json("{\"ev\":\"random_sens_scale\"}");
            return;
        }
        if (function == s_targets.send_kills) {
            if (parms && is_likely_readable_region(parms, sizeof(int32_t))) {
                const int32_t value = *reinterpret_cast<const int32_t*>(parms);
                emit_hook_trace_i32("send_kills", value);
            } else {
                emit_hook_trace("send_kills");
            }
            kovaaks::RustBridge::emit_json("{\"ev\":\"kills\"}");
            return;
        }
        if (function == s_targets.send_shots_hit) {
            if (parms && is_likely_readable_region(parms, sizeof(int32_t))) {
                const int32_t value = *reinterpret_cast<const int32_t*>(parms);
                emit_hook_trace_i32("send_shots_hit", value);
            } else {
                emit_hook_trace("send_shots_hit");
            }
            kovaaks::RustBridge::emit_json("{\"ev\":\"shots_hit\"}");
            return;
        }
        if (function == s_targets.send_shots_fired) {
            if (parms && is_likely_readable_region(parms, sizeof(int32_t))) {
                const int32_t value = *reinterpret_cast<const int32_t*>(parms);
                emit_hook_trace_i32("send_shots_fired", value);
            } else {
                emit_hook_trace("send_shots_fired");
            }
            kovaaks::RustBridge::emit_json("{\"ev\":\"shots_fired\"}");
            return;
        }
        if (function == s_targets.send_seconds) {
            if (parms && is_likely_readable_region(parms, sizeof(float))) {
                const float value = *reinterpret_cast<const float*>(parms);
                emit_hook_trace_f32("send_seconds", value);
            } else {
                emit_hook_trace("send_seconds");
            }
            kovaaks::RustBridge::emit_json("{\"ev\":\"seconds\"}");
            return;
        }
        if (function == s_targets.send_damage_done) {
            if (parms && is_likely_readable_region(parms, sizeof(float))) {
                const float value = *reinterpret_cast<const float*>(parms);
                emit_hook_trace_f32("send_damage_done", value);
            } else {
                emit_hook_trace("send_damage_done");
            }
            kovaaks::RustBridge::emit_json("{\"ev\":\"damage_done\"}");
            return;
        }
        if (function == s_targets.send_damage_possible) {
            if (parms && is_likely_readable_region(parms, sizeof(float))) {
                const float value = *reinterpret_cast<const float*>(parms);
                emit_hook_trace_f32("send_damage_possible", value);
            } else {
                emit_hook_trace("send_damage_possible");
            }
            kovaaks::RustBridge::emit_json("{\"ev\":\"damage_possible\"}");
            return;
        }
        if (function == s_targets.send_challenge_seconds) {
            if (parms && is_likely_readable_region(parms, sizeof(float))) {
                const float value = *reinterpret_cast<const float*>(parms);
                emit_hook_trace_f32("send_challenge_seconds", value);
            } else {
                emit_hook_trace("send_challenge_seconds");
            }
            kovaaks::RustBridge::emit_json("{\"ev\":\"challenge_seconds\"}");
            return;
        }
        if (function == s_targets.send_challenge_tick_count) {
            if (parms && is_likely_readable_region(parms, sizeof(int32_t))) {
                const int32_t value = *reinterpret_cast<const int32_t*>(parms);
                emit_hook_trace_i32("send_challenge_tick_count", value);
            } else {
                emit_hook_trace("send_challenge_tick_count");
            }
            kovaaks::RustBridge::emit_json("{\"ev\":\"challenge_tick_count\"}");
            return;
        }
        if (function == s_targets.reset_transient_data) {
            emit_hook_trace("reset_transient_data");
            kovaaks::RustBridge::emit_json("{\"ev\":\"reset_transient_data\"}");
            return;
        }
        if (function == s_targets.reset_shots_hit) {
            emit_hook_trace("reset_shots_hit");
            kovaaks::RustBridge::emit_json("{\"ev\":\"reset_shots_hit\"}");
            return;
        }
        if (function == s_targets.reset_shots_fired) {
            emit_hook_trace("reset_shots_fired");
            kovaaks::RustBridge::emit_json("{\"ev\":\"reset_shots_fired\"}");
            return;
        }
        if (function == s_targets.reset_seconds) {
            emit_hook_trace("reset_seconds");
            kovaaks::RustBridge::emit_json("{\"ev\":\"reset_seconds\"}");
            return;
        }
        if (function == s_targets.reset_score) {
            emit_hook_trace("reset_score");
            kovaaks::RustBridge::emit_json("{\"ev\":\"reset_score\"}");
            return;
        }
        if (function == s_targets.reset_random_sens_scale) {
            emit_hook_trace("reset_random_sens_scale");
            kovaaks::RustBridge::emit_json("{\"ev\":\"reset_random_sens_scale\"}");
            return;
        }
        if (function == s_targets.reset_kills) {
            emit_hook_trace("reset_kills");
            kovaaks::RustBridge::emit_json("{\"ev\":\"reset_kills\"}");
            return;
        }
        if (function == s_targets.reset_damage_possible) {
            emit_hook_trace("reset_damage_possible");
            kovaaks::RustBridge::emit_json("{\"ev\":\"reset_damage_possible\"}");
            return;
        }
        if (function == s_targets.reset_damage_done) {
            emit_hook_trace("reset_damage_done");
            kovaaks::RustBridge::emit_json("{\"ev\":\"reset_damage_done\"}");
            return;
        }
        if (function == s_targets.reset_challenge_tick_count) {
            emit_hook_trace("reset_challenge_tick_count");
            kovaaks::RustBridge::emit_json("{\"ev\":\"reset_challenge_tick_count\"}");
            return;
        }
        if (function == s_targets.reset_challenge_seconds) {
            emit_hook_trace("reset_challenge_seconds");
            kovaaks::RustBridge::emit_json("{\"ev\":\"reset_challenge_seconds\"}");
            return;
        }
        if (function == s_targets.job_context_has_completed) {
            emit_hook_trace("job_context_has_completed");
            kovaaks::RustBridge::emit_json("{\"ev\":\"job_context_has_completed\"}");
            return;
        }

        // Per-shot broadcast events
        if (function == s_targets.send_shot_hit_br || function == s_targets.send_shot_hit_weapon) {
            emit_hook_trace("send_shot_hit");
            kovaaks::RustBridge::emit_json("{\"ev\":\"shot_hit\"}");
            return;
        }
        if (function == s_targets.send_shot_fired_br || function == s_targets.send_shot_fired_weapon) {
            emit_hook_trace("send_shot_fired");
            kovaaks::RustBridge::emit_json("{\"ev\":\"shot_fired\"}");
            return;
        }
        if (function == s_targets.send_shot_missed_br || function == s_targets.send_shot_missed_weapon) {
            emit_hook_trace("send_shot_missed");
            kovaaks::RustBridge::emit_json("{\"ev\":\"shot_missed\"}");
            return;
        }
        if (function == s_targets.send_kill_br || function == s_targets.send_kill_weapon) {
            emit_hook_trace("send_kill");
            kovaaks::RustBridge::emit_json("{\"ev\":\"kill\"}");
            return;
        }

        if (function == s_targets.meta_notify_player_fire_weapon) {
            emit_hook_trace("meta_notify_player_fire_weapon");
            kovaaks::RustBridge::emit_json("{\"ev\":\"shot_fired\"}");
            return;
        }
        if (function == s_targets.meta_on_hit_scan) {
            if (parms && is_likely_readable_region(parms, 0x8D)) {
                const uint8_t is_headshot = *(reinterpret_cast<const uint8_t*>(parms) + 0x8C) & 0x1;
                emit_hook_trace_i32("meta_on_hit_scan", is_headshot ? 1 : 0);
                if (is_headshot) {
                    kovaaks::RustBridge::emit_json("{\"ev\":\"headshot\"}");
                }
            } else {
                emit_hook_trace("meta_on_hit_scan");
            }
            kovaaks::RustBridge::emit_json("{\"ev\":\"shot_hit\"}");
            return;
        }
        if (function == s_targets.meta_on_spawn_projectile) {
            emit_hook_trace("meta_on_spawn_projectile");
            kovaaks::RustBridge::emit_json("{\"ev\":\"shot_fired\"}");
            return;
        }

        // Challenge lifecycle (ScenarioBroadcastReceiver)
        if (function == s_targets.send_challenge_queued) {
            emit_hook_trace("challenge_queued");
            kovaaks::RustBridge::emit_json("{\"ev\":\"challenge_queued\"}");
            return;
        }
        if (function == s_targets.send_challenge_complete) {
            emit_hook_trace("challenge_complete");
            kovaaks::RustBridge::emit_json("{\"ev\":\"challenge_complete\"}");
            return;
        }
        if (function == s_targets.send_challenge_canceled) {
            emit_hook_trace("challenge_canceled");
            kovaaks::RustBridge::emit_json("{\"ev\":\"challenge_canceled\"}");
            return;
        }
        if (function == s_targets.send_post_challenge_complete) {
            emit_hook_trace("post_challenge_complete");
            kovaaks::RustBridge::emit_json("{\"ev\":\"post_challenge_complete\"}");
            return;
        }

        // AnalyticsManager challenge lifecycle mirrors
        if (function == s_targets.on_challenge_started) {
            emit_hook_trace("challenge_start");
            kovaaks::RustBridge::emit_json("{\"ev\":\"challenge_start\"}");
            return;
        }
        if (function == s_targets.on_challenge_restarted) {
            emit_hook_trace("challenge_restart");
            kovaaks::RustBridge::emit_json("{\"ev\":\"challenge_restart\"}");
            return;
        }
        if (function == s_targets.on_challenge_quit) {
            emit_hook_trace("challenge_quit");
            kovaaks::RustBridge::emit_json("{\"ev\":\"challenge_quit\"}");
            return;
        }
        if (function == s_targets.on_challenge_completed) {
            emit_hook_trace("challenge_completed");
            kovaaks::RustBridge::emit_json("{\"ev\":\"challenge_completed\"}");
            return;
        }

        // Pointer matching can drift across engine updates/hot-reload cycles.
        // Use cached name-based classification as a resilient fallback.
        const auto fallback_kind = classify_event_kind(function);
        if (fallback_kind != EventKind::None) {
            emit_hook_trace(event_kind_name(fallback_kind));
            if (emit_event_kind(fallback_kind)) {
                return;
            }
        }

        if (!s_discovery_enabled) {
            return;
        }

        const auto fn_ptr = static_cast<const void*>(function);
        const auto ctx_ptr = static_cast<const void*>(context);

        // Global discovery: this hook sees all ProcessEvent-driven UFunction calls.
        // We log newly seen functions (bounded) plus a sparse periodic sample.
        uint32_t pe_count = 0;
        uint32_t new_log_index = 0;
        bool emit_new = false;
        bool emit_limit_reached = false;
        bool emit_seen = false;
        {
            std::lock_guard<std::mutex> guard(s_state_mutex);
            pe_count = ++s_process_event_counts[function];
            if (pe_count == 1) {
                if (s_new_event_logs_emitted < k_max_new_event_logs) {
                    ++s_new_event_logs_emitted;
                    new_log_index = s_new_event_logs_emitted;
                    emit_new = true;
                } else if (s_new_event_logs_emitted == k_max_new_event_logs) {
                    ++s_new_event_logs_emitted;
                    emit_limit_reached = true;
                }
            } else if ((pe_count % 500) == 0) {
                emit_seen = true;
            }
        }
        if (emit_new) {
            RC::Output::send<RC::LogLevel::Warning>(
                STR("[KovaaksBridgeMod] pe_new #{} fn_ptr={} ctx_ptr={}\n"),
                new_log_index,
                fn_ptr,
                ctx_ptr
            );
            {
                std::array<char, 192> buf{};
                std::snprintf(
                    buf.data(),
                    buf.size(),
                    "[pe_new #%u] fn_ptr=%p ctx_ptr=%p",
                    new_log_index,
                    fn_ptr,
                    ctx_ptr
                );
                runtime_log_line(buf.data());
            }
        } else if (emit_limit_reached) {
            RC::Output::send<RC::LogLevel::Warning>(
                STR("[KovaaksBridgeMod] pe_new log limit reached ({}). Continuing periodic samples only.\n"),
                k_max_new_event_logs
            );
        } else if (emit_seen) {
            RC::Output::send<RC::LogLevel::Warning>(
                STR("[KovaaksBridgeMod] pe_seen #{} fn_ptr={} ctx_ptr={}\n"),
                pe_count,
                fn_ptr,
                ctx_ptr
            );
            {
                std::array<char, 192> buf{};
                std::snprintf(
                    buf.data(),
                    buf.size(),
                    "[pe_seen #%u] fn_ptr=%p ctx_ptr=%p",
                    pe_count,
                    fn_ptr,
                    ctx_ptr
                );
                runtime_log_line(buf.data());
            }
            bool do_trace_sample = false;
            uint32_t sample_index = 0;
            {
                std::lock_guard<std::mutex> guard(s_state_mutex);
                if (s_trace_event_sample < 100) {
                    ++s_trace_event_sample;
                    sample_index = s_trace_event_sample;
                    do_trace_sample = true;
                }
            }
            if (do_trace_sample) {
                std::array<char, 256> buf{};
                std::snprintf(buf.data(), buf.size(), "process_event sample #%u count=%u", sample_index, pe_count);
                trace_line(buf.data());
            }
        }

        bool is_new_fallback = false;
        {
            std::lock_guard<std::mutex> guard(s_state_mutex);
            is_new_fallback = s_discovered_fallback_targets.insert(function).second;
        }
        if (is_new_fallback) {
            RC::Output::send<RC::LogLevel::Warning>(
                STR("[KovaaksBridgeMod] fallback candidate function ptr fn_ptr={} ctx_ptr={}\n"),
                fn_ptr,
                ctx_ptr
            );
            std::array<char, 192> buf{};
            std::snprintf(
                buf.data(),
                buf.size(),
                "[fallback_new] fn_ptr=%p ctx_ptr=%p",
                fn_ptr,
                ctx_ptr
            );
            runtime_log_line(buf.data());
        }
        if ((pe_count % 250) == 0) {
            kovaaks::RustBridge::emit_json("{\"ev\":\"process_event_activity\"}");
        }

        // Periodic unknown call sampling to help identify hot functions while shooting.
        // Logs are intentionally sparse to avoid UE4SS log spam.
        uint32_t call_count = 0;
        {
            std::lock_guard<std::mutex> guard(s_state_mutex);
            call_count = ++s_unknown_counts[function];
        }
        if (call_count <= 3 || (call_count % 100) == 0) {
            RC::Output::send<RC::LogLevel::Warning>(
                STR("[KovaaksBridgeMod] unknown_pe #{} fn_ptr={} ctx_ptr={}\n"),
                call_count,
                fn_ptr,
                ctx_ptr
            );
        }
    }
};

extern "C" __declspec(dllexport) RC::CppUserModBase* start_mod() {
    return new KovaaksBridgeMod();
}

extern "C" __declspec(dllexport) void uninstall_mod(RC::CppUserModBase* mod) {
    delete mod;
}
