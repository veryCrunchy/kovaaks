#include "rust_bridge.hpp"

#include <atomic>
#include <string>

#include <windows.h>

namespace {

using bridge_init_fn = bool (*)();
using bridge_shutdown_fn = void (*)();
using bridge_is_connected_fn = bool (*)();
using bridge_last_error_fn = uint32_t (*)();
using bridge_emit_i32_fn = bool (*)(const char*, int32_t);
using bridge_emit_f32_fn = bool (*)(const char*, float);
using bridge_emit_json_fn = bool (*)(const char*);

struct RustApi {
    HMODULE module = nullptr;
    bridge_init_fn init = nullptr;
    bridge_shutdown_fn shutdown = nullptr;
    bridge_is_connected_fn is_connected = nullptr;
    bridge_last_error_fn last_error = nullptr;
    bridge_emit_i32_fn emit_i32 = nullptr;
    bridge_emit_f32_fn emit_f32 = nullptr;
    bridge_emit_json_fn emit_json = nullptr;
};

RustApi g_api{};
std::wstring g_last_dll_path{};
std::atomic<DWORD> g_last_win32_error{0};
std::atomic<DWORD> g_last_transport_error{0};
std::atomic<ULONGLONG> g_last_reconnect_attempt_ms{0};

constexpr ULONGLONG k_min_reconnect_interval_ms = 250;

bool module_still_loaded(HMODULE expected_module, const void* symbol_address) {
    if (!expected_module || !symbol_address) {
        return false;
    }
    HMODULE by_address = nullptr;
    const BOOL ok = GetModuleHandleExW(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        static_cast<LPCWSTR>(symbol_address),
        &by_address
    );
    if (!ok || !by_address) {
        return false;
    }
    return by_address == expected_module;
}

void invalidate_api() {
    g_api = {};
}

void refresh_transport_error() {
    if (g_api.last_error && module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.last_error))) {
        g_last_transport_error.store(static_cast<DWORD>(g_api.last_error()), std::memory_order_relaxed);
        return;
    }
    g_last_transport_error.store(GetLastError(), std::memory_order_relaxed);
}

bool reconnect_now() {
    if (!g_api.init || !module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.init))) {
        return false;
    }
    const bool ok = g_api.init();
    if (!ok) {
        refresh_transport_error();
    }
    return ok;
}

void reconnect_throttled() {
    const ULONGLONG now = GetTickCount64();
    const ULONGLONG previous = g_last_reconnect_attempt_ms.load(std::memory_order_relaxed);
    if (now - previous < k_min_reconnect_interval_ms) {
        return;
    }
    g_last_reconnect_attempt_ms.store(now, std::memory_order_relaxed);
    (void)reconnect_now();
}

std::wstring module_dir() {
    wchar_t buffer[MAX_PATH] = {};
    if (!GetModuleFileNameW(nullptr, buffer, MAX_PATH)) {
        return L"";
    }
    std::wstring path(buffer);
    auto pos = path.find_last_of(L"\\/");
    if (pos == std::wstring::npos) {
        return L"";
    }
    return path.substr(0, pos + 1);
}

bool load_api() {
    if (g_api.module != nullptr) {
        return true;
    }

    const std::wstring dll_path = module_dir() + L"kovaaks_rust_core.dll";
    g_last_dll_path = dll_path;
    g_last_win32_error.store(0, std::memory_order_relaxed);
    g_last_transport_error.store(0, std::memory_order_relaxed);
    HMODULE mod = LoadLibraryW(dll_path.c_str());
    if (!mod) {
        g_last_win32_error.store(GetLastError(), std::memory_order_relaxed);
        return false;
    }

    g_api.module = mod;
    g_api.init = reinterpret_cast<bridge_init_fn>(GetProcAddress(mod, "bridge_init"));
    g_api.shutdown = reinterpret_cast<bridge_shutdown_fn>(GetProcAddress(mod, "bridge_shutdown"));
    g_api.is_connected = reinterpret_cast<bridge_is_connected_fn>(GetProcAddress(mod, "bridge_is_connected"));
    g_api.last_error = reinterpret_cast<bridge_last_error_fn>(GetProcAddress(mod, "bridge_last_error"));
    g_api.emit_i32 = reinterpret_cast<bridge_emit_i32_fn>(GetProcAddress(mod, "bridge_emit_i32"));
    g_api.emit_f32 = reinterpret_cast<bridge_emit_f32_fn>(GetProcAddress(mod, "bridge_emit_f32"));
    g_api.emit_json = reinterpret_cast<bridge_emit_json_fn>(GetProcAddress(mod, "bridge_emit_json"));

    if (!g_api.init || !g_api.shutdown || !g_api.emit_i32 || !g_api.emit_f32 || !g_api.emit_json) {
        g_last_win32_error.store(ERROR_PROC_NOT_FOUND, std::memory_order_relaxed);
        FreeLibrary(mod);
        g_api = {};
        return false;
    }

    return true;
}

} // namespace

namespace kovaaks {

bool RustBridge::startup() {
    if (!load_api()) {
        return false;
    }
    if (!g_api.init) {
        return false;
    }
    const bool ok = g_api.init();
    if (!ok) {
        refresh_transport_error();
    }
    return ok;
}

bool RustBridge::reconnect() {
    if (!load_api()) {
        return false;
    }
    return reconnect_now();
}

void RustBridge::shutdown() {
    if (!g_api.module) {
        return;
    }
    if (!module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.shutdown))) {
        // Module unload order during process detach can invalidate function pointers.
        // Drop API state and return without touching stale addresses.
        invalidate_api();
        return;
    }
    if (g_api.shutdown) {
        // Process exit/unload can invalidate downstream state; keep shutdown best-effort.
#if defined(_MSC_VER)
        __try {
            g_api.shutdown();
        } __except (EXCEPTION_EXECUTE_HANDLER) {
        }
#else
        g_api.shutdown();
#endif
    }
    // Avoid aggressive FreeLibrary on shutdown path; process teardown will reclaim.
    // This trades a tiny leak on hot-reload for improved exit stability.
#if 0
    if (g_api.module) {
        FreeLibrary(g_api.module);
    }
#endif
    invalidate_api();
}

bool RustBridge::api_ready() {
    return g_api.module != nullptr && g_api.init != nullptr && g_api.emit_json != nullptr;
}

bool RustBridge::is_connected() {
    if (!g_api.is_connected) {
        return false;
    }
    if (!module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.is_connected))) {
        invalidate_api();
        return false;
    }
    return g_api.is_connected();
}

const wchar_t* RustBridge::last_dll_path() {
    return g_last_dll_path.c_str();
}

uint32_t RustBridge::last_win32_error() {
    return static_cast<uint32_t>(g_last_win32_error.load(std::memory_order_relaxed));
}

uint32_t RustBridge::last_transport_error() {
    return static_cast<uint32_t>(g_last_transport_error.load(std::memory_order_relaxed));
}

bool RustBridge::emit_i32(const char* ev, int32_t value) {
    if (!g_api.emit_i32) {
        return false;
    }
    if (!module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.emit_i32))) {
        invalidate_api();
        return false;
    }
    if (g_api.emit_i32(ev, value)) {
        return true;
    }
    refresh_transport_error();
    reconnect_throttled();
    if (!module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.emit_i32))) {
        invalidate_api();
        return false;
    }
    if (g_api.emit_i32(ev, value)) {
        return true;
    }
    refresh_transport_error();
    return false;
}

bool RustBridge::emit_f32(const char* ev, float value) {
    if (!g_api.emit_f32) {
        return false;
    }
    if (!module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.emit_f32))) {
        invalidate_api();
        return false;
    }
    if (g_api.emit_f32(ev, value)) {
        return true;
    }
    refresh_transport_error();
    reconnect_throttled();
    if (!module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.emit_f32))) {
        invalidate_api();
        return false;
    }
    if (g_api.emit_f32(ev, value)) {
        return true;
    }
    refresh_transport_error();
    return false;
}

bool RustBridge::emit_json(const char* json_line) {
    if (!g_api.emit_json) {
        return false;
    }
    if (!module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.emit_json))) {
        invalidate_api();
        return false;
    }
    if (g_api.emit_json(json_line)) {
        return true;
    }
    refresh_transport_error();
    reconnect_throttled();
    if (!module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.emit_json))) {
        invalidate_api();
        return false;
    }
    if (g_api.emit_json(json_line)) {
        return true;
    }
    refresh_transport_error();
    return false;
}

} // namespace kovaaks
