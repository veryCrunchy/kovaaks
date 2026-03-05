#pragma once

#include <cstdint>
#include <string>

namespace kovaaks {

class RustBridge {
public:
    static bool startup();
    static bool reconnect();
    static void shutdown();
    static bool api_ready();
    static bool is_connected();
    static const wchar_t* last_dll_path();
    static uint32_t last_win32_error();
    static uint32_t last_transport_error();

    static bool emit_i32(const char* ev, int32_t value);
    static bool emit_f32(const char* ev, float value);
    static bool emit_json(const char* json_line);
    static bool poll_command(std::string& out_json);

private:
    RustBridge() = delete;
};

} // namespace kovaaks
