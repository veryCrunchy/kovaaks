#pragma once

#include <cstdint>

namespace kovaaks {

class RustBridge {
public:
    static bool startup();
    static void shutdown();
    static bool api_ready();
    static const wchar_t* last_dll_path();
    static uint32_t last_win32_error();

    static bool emit_i32(const char* ev, int32_t value);
    static bool emit_f32(const char* ev, float value);
    static bool emit_json(const char* json_line);

private:
    RustBridge() = delete;
};

} // namespace kovaaks
