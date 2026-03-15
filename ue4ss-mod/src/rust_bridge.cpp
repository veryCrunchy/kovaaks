#include "rust_bridge.hpp"

#include <array>
#include <atomic>
#include <mutex>
#include <string>
#include <thread>

#include <windows.h>

namespace {

using bridge_init_fn = bool (*)();
using bridge_shutdown_fn = void (*)();
using bridge_is_connected_fn = bool (*)();
using bridge_last_error_fn = uint32_t (*)();
using bridge_emit_i32_fn = bool (*)(const char*, int32_t);
using bridge_emit_f32_fn = bool (*)(const char*, float);
using bridge_emit_json_fn = bool (*)(const char*);
using bridge_probe_transport_fn = bool (*)(const char*);
using bridge_poll_command_fn = int32_t (*)(char*, uint32_t);

struct RustApi {
    HMODULE module = nullptr;
    bridge_init_fn init = nullptr;
    bridge_shutdown_fn shutdown = nullptr;
    bridge_is_connected_fn is_connected = nullptr;
    bridge_last_error_fn last_error = nullptr;
    bridge_emit_i32_fn emit_i32 = nullptr;
    bridge_emit_f32_fn emit_f32 = nullptr;
    bridge_emit_json_fn emit_json = nullptr;
    bridge_probe_transport_fn probe_transport = nullptr;
    bridge_poll_command_fn poll_command = nullptr;
};

RustApi g_api{};
std::wstring g_last_dll_path{};
std::atomic<DWORD> g_last_win32_error{0};
std::atomic<DWORD> g_last_transport_error{0};
std::atomic<ULONGLONG> g_last_reconnect_attempt_ms{0};
std::atomic<ULONGLONG> g_last_probe_attempt_ms{0};
std::atomic<uint64_t> g_async_reconnect_event_seq{0};
std::atomic<int32_t> g_async_reconnect_event_kind{0};
std::atomic<DWORD> g_async_reconnect_event_win32{0};
std::atomic<DWORD> g_async_reconnect_event_transport{0};
std::atomic<bool> g_reconnect_worker_stop{false};
std::thread g_reconnect_worker{};
std::recursive_mutex g_api_mutex{};

constexpr ULONGLONG k_min_reconnect_interval_ms = 250;
constexpr ULONGLONG k_connected_probe_interval_ms = 1500;
constexpr const char* k_transport_probe_json = "{\"ev\":\"bridge_transport_probe\"}";

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
    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
    g_api = {};
}

void refresh_transport_error() {
    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
    if (g_api.last_error && module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.last_error))) {
        g_last_transport_error.store(static_cast<DWORD>(g_api.last_error()), std::memory_order_relaxed);
        return;
    }
    g_last_transport_error.store(GetLastError(), std::memory_order_relaxed);
}

void publish_async_reconnect_event(int32_t kind) {
    g_async_reconnect_event_win32.store(
        g_last_win32_error.load(std::memory_order_relaxed),
        std::memory_order_relaxed
    );
    g_async_reconnect_event_transport.store(
        g_last_transport_error.load(std::memory_order_relaxed),
        std::memory_order_relaxed
    );
    g_async_reconnect_event_kind.store(kind, std::memory_order_release);
    g_async_reconnect_event_seq.fetch_add(1, std::memory_order_acq_rel);
}

bool reconnect_now() {
    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
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
    const bool ok = reconnect_now();
    publish_async_reconnect_event(ok ? 1 : -1);
}

bool probe_connected_transport() {
    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
    const auto* probe_ptr = g_api.probe_transport
        ? reinterpret_cast<const void*>(g_api.probe_transport)
        : reinterpret_cast<const void*>(g_api.emit_json);
    if (!probe_ptr || !module_still_loaded(g_api.module, probe_ptr)) {
        invalidate_api();
        return false;
    }

    const ULONGLONG now = GetTickCount64();
    const ULONGLONG previous = g_last_probe_attempt_ms.load(std::memory_order_relaxed);
    if (now - previous < k_connected_probe_interval_ms) {
        return true;
    }

    g_last_probe_attempt_ms.store(now, std::memory_order_relaxed);
    const bool ok = g_api.probe_transport
        ? g_api.probe_transport(k_transport_probe_json)
        : g_api.emit_json(k_transport_probe_json);
    if (ok) {
        return true;
    }

    refresh_transport_error();
    return false;
}

void stop_reconnect_worker() {
    g_reconnect_worker_stop.store(true, std::memory_order_release);
    if (g_reconnect_worker.joinable()) {
        g_reconnect_worker.join();
    }
}

void ensure_reconnect_worker() {
    if (g_reconnect_worker.joinable()) {
        return;
    }

    g_reconnect_worker_stop.store(false, std::memory_order_release);
    g_reconnect_worker = std::thread([] {
        bool last_connected = false;
        while (!g_reconnect_worker_stop.load(std::memory_order_acquire)) {
            bool api_ready = false;
            {
                const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
                api_ready =
                    g_api.module != nullptr
                    && g_api.init != nullptr
                    && g_api.is_connected != nullptr;
            }
            if (api_ready) {
                bool connected = false;
                {
                    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
                    if (module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.is_connected))) {
                        connected = g_api.is_connected();
                    } else {
                        invalidate_api();
                    }
                }
                if (connected) {
                    connected = probe_connected_transport();
                }
                if (connected) {
                    if (!last_connected) {
                        publish_async_reconnect_event(1);
                    }
                    last_connected = true;
                } else {
                    if (last_connected) {
                        publish_async_reconnect_event(0);
                    }
                    last_connected = false;
                    reconnect_throttled();
                }
            } else if (last_connected) {
                last_connected = false;
                publish_async_reconnect_event(0);
            }
            Sleep(250);
        }
    });
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
    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
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
    g_api.probe_transport = reinterpret_cast<bridge_probe_transport_fn>(GetProcAddress(mod, "bridge_probe_transport"));
    g_api.poll_command = reinterpret_cast<bridge_poll_command_fn>(GetProcAddress(mod, "bridge_poll_command"));

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
    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
    if (!load_api()) {
        return false;
    }
    ensure_reconnect_worker();
    if (!g_api.init) {
        return false;
    }
    const bool connected = g_api.init();
    if (!connected) {
        refresh_transport_error();
    }
    // API is usable even if first transport connect fails; emit/reconnect paths can recover.
    return true;
}

bool RustBridge::reconnect() {
    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
    if (!load_api()) {
        return false;
    }
    ensure_reconnect_worker();
    return reconnect_now();
}

void RustBridge::shutdown() {
    stop_reconnect_worker();
    RustApi api_snapshot{};
    g_api_mutex.lock();
    if (!g_api.module) {
        g_api_mutex.unlock();
        return;
    }
    if (!module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.shutdown))) {
        // Module unload order during process detach can invalidate function pointers.
        // Drop API state and return without touching stale addresses.
        g_api = {};
        g_api_mutex.unlock();
        return;
    }
    api_snapshot = g_api;
    g_api = {};
    g_api_mutex.unlock();
    if (api_snapshot.shutdown) {
        // Process exit/unload can invalidate downstream state; keep shutdown best-effort.
#if defined(_MSC_VER)
        __try {
            api_snapshot.shutdown();
        } __except (EXCEPTION_EXECUTE_HANDLER) {
        }
#else
        api_snapshot.shutdown();
#endif
    }
    // Avoid aggressive FreeLibrary on shutdown path; process teardown will reclaim.
    // This trades a tiny leak on hot-reload for improved exit stability.
#if 0
    if (api_snapshot.module) {
        FreeLibrary(api_snapshot.module);
    }
#endif
}

bool RustBridge::api_ready() {
    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
    return g_api.module != nullptr && g_api.init != nullptr && g_api.emit_json != nullptr;
}

bool RustBridge::is_connected() {
    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
    if (!g_api.is_connected) {
        return false;
    }
    if (!module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.is_connected))) {
        invalidate_api();
        return false;
    }
    if (!g_api.is_connected()) {
        refresh_transport_error();
        return false;
    }
    return probe_connected_transport();
}

const wchar_t* RustBridge::last_dll_path() {
    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
    return g_last_dll_path.c_str();
}

uint32_t RustBridge::last_win32_error() {
    return static_cast<uint32_t>(g_last_win32_error.load(std::memory_order_relaxed));
}

uint32_t RustBridge::last_transport_error() {
    return static_cast<uint32_t>(g_last_transport_error.load(std::memory_order_relaxed));
}

bool RustBridge::read_async_reconnect_event(RustBridgeReconnectEvent& out_event) {
    const uint64_t sequence = g_async_reconnect_event_seq.load(std::memory_order_acquire);
    if (sequence == 0) {
        return false;
    }

    out_event.sequence = sequence;
    const int32_t kind = g_async_reconnect_event_kind.load(std::memory_order_acquire);
    out_event.kind = static_cast<RustBridgeReconnectEventKind>(kind);
    out_event.connected = kind > 0;
    out_event.win32_error = static_cast<uint32_t>(
        g_async_reconnect_event_win32.load(std::memory_order_acquire)
    );
    out_event.transport_error = static_cast<uint32_t>(
        g_async_reconnect_event_transport.load(std::memory_order_acquire)
    );
    return true;
}

bool RustBridge::emit_i32(const char* ev, int32_t value) {
    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
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
    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
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
    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
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

bool RustBridge::poll_command(std::string& out_json) {
    const std::lock_guard<std::recursive_mutex> lock(g_api_mutex);
    out_json.clear();
    if (!g_api.poll_command) {
        return false;
    }
    if (!module_still_loaded(g_api.module, reinterpret_cast<const void*>(g_api.poll_command))) {
        invalidate_api();
        return false;
    }

    std::array<char, 8192> buffer{};
    const int32_t n = g_api.poll_command(buffer.data(), static_cast<uint32_t>(buffer.size()));
    if (n <= 0) {
        return false;
    }

    const size_t len = static_cast<size_t>(n);
    if (len >= buffer.size()) {
        return false;
    }
    out_json.assign(buffer.data(), buffer.data() + len);
    return !out_json.empty();
}

} // namespace kovaaks
