#include "rust_bridge.hpp"

#include <string>

#include <windows.h>

namespace {

using bridge_init_fn = bool (*)();
using bridge_shutdown_fn = void (*)();
using bridge_emit_i32_fn = bool (*)(const char*, int32_t);
using bridge_emit_f32_fn = bool (*)(const char*, float);
using bridge_emit_json_fn = bool (*)(const char*);

struct RustApi {
    HMODULE module = nullptr;
    bridge_init_fn init = nullptr;
    bridge_shutdown_fn shutdown = nullptr;
    bridge_emit_i32_fn emit_i32 = nullptr;
    bridge_emit_f32_fn emit_f32 = nullptr;
    bridge_emit_json_fn emit_json = nullptr;
};

RustApi g_api{};
std::wstring g_last_dll_path{};
DWORD g_last_win32_error = 0;

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
    g_last_win32_error = 0;
    HMODULE mod = LoadLibraryW(dll_path.c_str());
    if (!mod) {
        g_last_win32_error = GetLastError();
        return false;
    }

    g_api.module = mod;
    g_api.init = reinterpret_cast<bridge_init_fn>(GetProcAddress(mod, "bridge_init"));
    g_api.shutdown = reinterpret_cast<bridge_shutdown_fn>(GetProcAddress(mod, "bridge_shutdown"));
    g_api.emit_i32 = reinterpret_cast<bridge_emit_i32_fn>(GetProcAddress(mod, "bridge_emit_i32"));
    g_api.emit_f32 = reinterpret_cast<bridge_emit_f32_fn>(GetProcAddress(mod, "bridge_emit_f32"));
    g_api.emit_json = reinterpret_cast<bridge_emit_json_fn>(GetProcAddress(mod, "bridge_emit_json"));

    if (!g_api.init || !g_api.shutdown || !g_api.emit_i32 || !g_api.emit_f32 || !g_api.emit_json) {
        g_last_win32_error = ERROR_PROC_NOT_FOUND;
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
    return g_api.init ? g_api.init() : false;
}

void RustBridge::shutdown() {
    if (g_api.shutdown) {
        g_api.shutdown();
    }
    if (g_api.module) {
        FreeLibrary(g_api.module);
    }
    g_api = {};
}

bool RustBridge::api_ready() {
    return g_api.module != nullptr && g_api.init != nullptr && g_api.emit_json != nullptr;
}

const wchar_t* RustBridge::last_dll_path() {
    return g_last_dll_path.c_str();
}

uint32_t RustBridge::last_win32_error() {
    return static_cast<uint32_t>(g_last_win32_error);
}

bool RustBridge::emit_i32(const char* ev, int32_t value) {
    if (!g_api.emit_i32) {
        return false;
    }
    return g_api.emit_i32(ev, value);
}

bool RustBridge::emit_f32(const char* ev, float value) {
    if (!g_api.emit_f32) {
        return false;
    }
    return g_api.emit_f32(ev, value);
}

bool RustBridge::emit_json(const char* json_line) {
    if (!g_api.emit_json) {
        return false;
    }
    return g_api.emit_json(json_line);
}

} // namespace kovaaks
