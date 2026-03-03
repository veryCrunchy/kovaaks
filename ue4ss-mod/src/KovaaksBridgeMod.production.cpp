#include <DynamicOutput/Output.hpp>
#include <Mod/CppUserModBase.hpp>
#include <Unreal/FProperty.hpp>
#include <Unreal/Property/FNumericProperty.hpp>
#include <Unreal/Property/FObjectProperty.hpp>
#include <Unreal/UClass.hpp>
#include <Unreal/UFunction.hpp>
#include <Unreal/UObject.hpp>
#include <Unreal/UObjectGlobals.hpp>

#include <array>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include <limits>
#include <string>
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
    wchar_t module_path[MAX_PATH]{};
    if (!GetModuleFileNameW(nullptr, module_path, MAX_PATH)) {
        return {};
    }
    std::wstring path(module_path);
    const auto slash = path.find_last_of(L"\\/");
    if (slash == std::wstring::npos) {
        return {};
    }
    path.resize(slash + 1);
    return path;
}

bool env_flag_enabled(const char* key) {
    if (!key || !*key) {
        return false;
    }
    const char* v = std::getenv(key);
    if (!v) {
        return false;
    }
    std::string s(v);
    for (auto& c : s) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }
    return s == "1" || s == "true" || s == "yes" || s == "on";
}

bool prod_logs_flag_enabled() {
    const std::wstring path = game_bin_dir() + L"kovaaks_prod_logs.flag";
    const DWORD attr = GetFileAttributesW(path.c_str());
    return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
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

        verbose_logs_ = env_flag_enabled("KOVAAKS_PROD_LOGS") || prod_logs_flag_enabled();

        if (kovaaks::RustBridge::startup()) {
            rust_ready_ = true;
            kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_mod_loaded\"}");
            kovaaks::RustBridge::emit_json("{\"ev\":\"ue4ss_mode\",\"mode\":\"production_stripped\"}");
            kovaaks::RustBridge::emit_json(verbose_logs_
                ? "{\"ev\":\"ue4ss_prod_diag\",\"enabled\":1}"
                : "{\"ev\":\"ue4ss_prod_diag\",\"enabled\":0}");
            RC::Output::send<RC::LogLevel::Warning>(STR("[KovaaksBridgeMod] Rust bridge loaded (production stripped).\n"));
            if (verbose_logs_) {
                RC::Output::send<RC::LogLevel::Warning>(STR("[kmod-prod] diagnostics enabled (env KOVAAKS_PROD_LOGS or kovaaks_prod_logs.flag)\n"));
            }
        } else {
            RC::Output::send<RC::LogLevel::Error>(
                STR("[KovaaksBridgeMod] Failed to load Rust bridge DLL. path={} win32_error={}\n"),
                RC::StringType(kovaaks::RustBridge::last_dll_path()),
                kovaaks::RustBridge::last_win32_error()
            );
        }
    }

    ~KovaaksBridgeModProduction() override {
        if (rust_ready_) {
            kovaaks::RustBridge::shutdown();
            rust_ready_ = false;
        }
    }

    auto on_unreal_init() -> void override {
        resolve_targets(true);
        if (verbose_logs_) {
            RC::Output::send<RC::LogLevel::Warning>(STR("[kmod-prod] on_unreal_init complete\n"));
        }
    }

    auto on_ui_init() -> void override {}

    auto on_update() -> void override {
        if (!rust_ready_) {
            return;
        }
        const uint64_t now = GetTickCount64();
        if (now < next_poll_ms_) {
            return;
        }
        next_poll_ms_ = now + 33; // ~30Hz

        resolve_targets(false);
        auto* receiver = resolve_state_receiver_instance(now);
        int32_t iv = 0;
        float fv = 0.0f;
        int32_t current_shots_fired = -1;
        int32_t current_shots_hit = -1;
        float current_seconds = -1.0f;
        float current_score_per_minute = -1.0f;
        float current_damage_done = -1.0f;
        float current_damage_possible = -1.0f;
        float current_time_remaining = -1.0f;
        float current_challenge_seconds = -1.0f;
        float current_challenge_time_length = -1.0f;

        if (receiver) {
            if (try_read_int(receiver, {targets_.get_shots_fired_value_else, targets_.get_shots_fired_value_or}, iv)) {
                current_shots_fired = iv;
                emit_pull_i32("pull_shots_fired_total", last_shots_fired_, iv, last_nonzero_shots_fired_ms_, now);
            }
            if (try_read_int(receiver, {targets_.get_shots_hit_value_else, targets_.get_shots_hit_value_or}, iv)) {
                current_shots_hit = iv;
                emit_pull_i32("pull_shots_hit_total", last_shots_hit_, iv, last_nonzero_shots_hit_ms_, now);
            }
            if (try_read_float(receiver, {targets_.get_score_per_minute_value_else, targets_.get_score_per_minute_value_or}, fv)) {
                current_score_per_minute = fv;
                emit_pull_f32("pull_score_per_minute", last_score_per_minute_, fv, last_nonzero_spm_ms_, now);
            }
            if (try_read_float(receiver, {targets_.get_damage_done_value_else, targets_.get_damage_done_value_or}, fv)) {
                current_damage_done = fv;
                emit_pull_f32("pull_damage_done", last_damage_done_, fv, last_nonzero_damage_done_ms_, now);
            }
            if (try_read_float(receiver, {targets_.get_damage_possible_value_else, targets_.get_damage_possible_value_or}, fv)) {
                current_damage_possible = fv;
                emit_pull_f32("pull_damage_possible", last_damage_possible_, fv, last_nonzero_damage_possible_ms_, now);
            }
            if (try_read_float(receiver, {targets_.get_seconds_value_else, targets_.get_seconds_value_or}, fv)) {
                current_seconds = fv;
                emit_pull_f32("pull_seconds_total", last_seconds_, fv, last_nonzero_seconds_ms_, now);
            }
        }

        auto* sandbox_stats = resolve_sandbox_session_stats_instance(now);
        if (sandbox_stats) {
            if (try_read_float(sandbox_stats, {targets_.sandbox_get_challenge_time_in_seconds}, fv)) {
                current_challenge_seconds = fv;
                if (current_seconds < 0.0f) {
                    current_seconds = fv;
                }
                emit_pull_f32("pull_challenge_seconds_total", last_challenge_seconds_, fv, last_nonzero_challenge_seconds_ms_, now);
                emit_pull_f32("pull_seconds_total", last_seconds_, fv, last_nonzero_seconds_ms_, now);
            }
            if (try_read_float(sandbox_stats, {targets_.sandbox_get_realtime_challenge_time_length}, fv)) {
                current_challenge_time_length = fv;
                emit_pull_f32("pull_challenge_time_length", last_challenge_time_length_, fv, last_nonzero_challenge_time_length_ms_, now);
            }
        }

        auto* scenario_manager = resolve_scenario_manager_instance(now);
        if (scenario_manager && try_read_float(scenario_manager, {targets_.scenario_get_challenge_time_remaining}, fv)) {
            current_time_remaining = fv;
            emit_pull_f32("pull_time_remaining", last_time_remaining_, fv, last_nonzero_time_remaining_ms_, now);
        }

        update_lifecycle_events(
            now,
            current_shots_fired,
            current_shots_hit,
            current_seconds,
            current_score_per_minute,
            current_damage_done,
            current_damage_possible,
            current_time_remaining,
            current_challenge_seconds,
            current_challenge_time_length
        );

        if (verbose_logs_ && now >= next_diag_log_ms_) {
            next_diag_log_ms_ = now + 2000;
            RC::Output::send<RC::LogLevel::Warning>(
                STR("[kmod-prod] sf=%d sh=%d sec=%.3f spm=%.3f dd=%.3f dp=%.3f tr=%.3f ch_sec=%.3f\n"),
                last_shots_fired_,
                last_shots_hit_,
                static_cast<double>(last_seconds_),
                static_cast<double>(last_score_per_minute_),
                static_cast<double>(last_damage_done_),
                static_cast<double>(last_damage_possible_),
                static_cast<double>(last_time_remaining_),
                static_cast<double>(last_challenge_seconds_)
            );
        }
    }

private:
    struct Targets {
        RC::Unreal::UFunction* get_shots_fired_value_else{};
        RC::Unreal::UFunction* get_shots_fired_value_or{};
        RC::Unreal::UFunction* get_shots_hit_value_else{};
        RC::Unreal::UFunction* get_shots_hit_value_or{};
        RC::Unreal::UFunction* get_seconds_value_else{};
        RC::Unreal::UFunction* get_seconds_value_or{};
        RC::Unreal::UFunction* get_score_per_minute_value_else{};
        RC::Unreal::UFunction* get_score_per_minute_value_or{};
        RC::Unreal::UFunction* get_damage_done_value_else{};
        RC::Unreal::UFunction* get_damage_done_value_or{};
        RC::Unreal::UFunction* get_damage_possible_value_else{};
        RC::Unreal::UFunction* get_damage_possible_value_or{};
        RC::Unreal::UFunction* meta_get_sandbox_session_stats{};
        RC::Unreal::UFunction* sandbox_get_challenge_time_in_seconds{};
        RC::Unreal::UFunction* sandbox_get_realtime_challenge_time_length{};
        RC::Unreal::UFunction* scenario_get_challenge_time_remaining{};
    };

    struct NumericInvokeResult {
        bool valid{false};
        bool is_floating{false};
        double as_float{0.0};
        int64_t as_int{0};
    };

    bool rust_ready_{false};
    Targets targets_{};

    RC::Unreal::UObject* meta_game_instance_{nullptr};
    RC::Unreal::UObject* state_receiver_instance_{nullptr};
    RC::Unreal::UObject* sandbox_session_stats_instance_{nullptr};
    RC::Unreal::UObject* scenario_manager_instance_{nullptr};
    RC::Unreal::UClass* meta_game_instance_class_{nullptr};
    RC::Unreal::UClass* state_receiver_class_{nullptr};
    RC::Unreal::UClass* scenario_manager_class_{nullptr};

    std::unordered_map<RC::Unreal::UFunction*, RC::Unreal::UClass*> cached_owner_class_{};

    uint64_t next_poll_ms_{0};
    uint64_t next_targets_resolve_ms_{0};
    uint64_t next_meta_resolve_ms_{0};
    uint64_t next_receiver_resolve_ms_{0};
    uint64_t next_sandbox_resolve_ms_{0};
    uint64_t next_scenario_resolve_ms_{0};

    int32_t last_shots_fired_{std::numeric_limits<int32_t>::min()};
    int32_t last_shots_hit_{std::numeric_limits<int32_t>::min()};
    float last_seconds_{std::numeric_limits<float>::quiet_NaN()};
    float last_score_per_minute_{std::numeric_limits<float>::quiet_NaN()};
    float last_damage_done_{std::numeric_limits<float>::quiet_NaN()};
    float last_damage_possible_{std::numeric_limits<float>::quiet_NaN()};
    float last_time_remaining_{std::numeric_limits<float>::quiet_NaN()};
    float last_challenge_seconds_{std::numeric_limits<float>::quiet_NaN()};
    float last_challenge_time_length_{std::numeric_limits<float>::quiet_NaN()};

    uint64_t last_nonzero_shots_fired_ms_{0};
    uint64_t last_nonzero_shots_hit_ms_{0};
    uint64_t last_nonzero_seconds_ms_{0};
    uint64_t last_nonzero_spm_ms_{0};
    uint64_t last_nonzero_damage_done_ms_{0};
    uint64_t last_nonzero_damage_possible_ms_{0};
    uint64_t last_nonzero_time_remaining_ms_{0};
    uint64_t last_nonzero_challenge_seconds_ms_{0};
    uint64_t last_nonzero_challenge_time_length_ms_{0};
    bool lifecycle_active_{false};
    bool lifecycle_initialized_{false};
    uint64_t last_lifecycle_signal_ms_{0};
    bool verbose_logs_{false};
    uint64_t next_diag_log_ms_{0};

    static void emit_simple_event(const char* ev) {
        std::array<char, 96> json{};
        std::snprintf(json.data(), json.size(), "{\"ev\":\"%s\"}", ev);
        kovaaks::RustBridge::emit_json(json.data());
    }

    void update_lifecycle_events(
        uint64_t now,
        int32_t shots_fired,
        int32_t shots_hit,
        float seconds_total,
        float score_per_minute,
        float damage_done,
        float damage_possible,
        float time_remaining,
        float challenge_seconds,
        float challenge_time_length
    ) {
        const auto has_float = [](float v) {
            return std::isfinite(v) && v >= 0.0f;
        };
        const auto has_positive_float = [](float v) {
            return std::isfinite(v) && v > 0.0001f;
        };

        const bool has_signal =
            shots_fired >= 0 ||
            shots_hit >= 0 ||
            has_float(seconds_total) ||
            has_float(score_per_minute) ||
            has_float(damage_done) ||
            has_float(damage_possible) ||
            has_float(time_remaining) ||
            has_float(challenge_seconds) ||
            has_float(challenge_time_length);
        if (!has_signal) {
            return;
        }

        const bool active_signal =
            shots_fired > 0 ||
            shots_hit > 0 ||
            has_positive_float(seconds_total) ||
            has_positive_float(score_per_minute) ||
            has_positive_float(damage_done) ||
            has_positive_float(damage_possible) ||
            has_positive_float(time_remaining) ||
            has_positive_float(challenge_seconds);

        if (!lifecycle_initialized_) {
            lifecycle_initialized_ = true;
            lifecycle_active_ = active_signal;
            if (lifecycle_active_) {
                last_lifecycle_signal_ms_ = now;
                emit_simple_event("session_start");
                emit_simple_event("challenge_start");
            }
            return;
        }

        constexpr uint64_t k_idle_end_ms = 2000;

        if (active_signal) {
            last_lifecycle_signal_ms_ = now;
            if (!lifecycle_active_) {
                lifecycle_active_ = true;
                emit_simple_event("session_start");
                emit_simple_event("challenge_start");
            }
            return;
        }

        if (lifecycle_active_ && last_lifecycle_signal_ms_ > 0 && (now - last_lifecycle_signal_ms_) > k_idle_end_ms) {
            lifecycle_active_ = false;
            emit_simple_event("challenge_end");
            emit_simple_event("session_end");
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
            if (fn && is_likely_valid_object_ptr(fn)) {
                return fn;
            }
            return nullptr;
        };

        targets_.get_shots_fired_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ShotsFired_ValueElse"));
        targets_.get_shots_fired_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ShotsFired_ValueOr"));
        targets_.get_shots_hit_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ShotsHit_ValueElse"));
        targets_.get_shots_hit_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ShotsHit_ValueOr"));
        targets_.get_seconds_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Seconds_ValueElse"));
        targets_.get_seconds_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_Seconds_ValueOr"));
        targets_.get_score_per_minute_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ScorePerMinute_ValueElse"));
        targets_.get_score_per_minute_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_ScorePerMinute_ValueOr"));
        targets_.get_damage_done_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamageDone_ValueElse"));
        targets_.get_damage_done_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamageDone_ValueOr"));
        targets_.get_damage_possible_value_else = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamagePossible_ValueElse"));
        targets_.get_damage_possible_value_or = resolve_fn(STR("/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Get_DamagePossible_ValueOr"));
        targets_.meta_get_sandbox_session_stats = resolve_fn(STR("/Script/GameSkillsTrainer.GTheMetaGameInstance:GetSandboxSessionStats"));
        targets_.sandbox_get_challenge_time_in_seconds = resolve_fn(STR("/Script/GameSkillsTrainer.SandboxSessionStats:GetChallengeTimeInSeconds"));
        targets_.sandbox_get_realtime_challenge_time_length = resolve_fn(STR("/Script/GameSkillsTrainer.SandboxSessionStats:GetRealtimeChallengeTimeLength"));
        targets_.scenario_get_challenge_time_remaining = resolve_fn(STR("/Script/GameSkillsTrainer.ScenarioManager:GetChallengeTimeRemaining"));
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

        for (RC::Unreal::FProperty* property : fn->ForEachProperty()) {
            if (!property || !is_likely_valid_object_ptr(property)) {
                continue;
            }
            if (!property->HasAnyPropertyFlags(RC::Unreal::CPF_Parm)) {
                continue;
            }
            const auto normalized_name = normalize_ascii(property->GetName());

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

        if (!output_numeric || !is_likely_valid_object_ptr(output_numeric)) {
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

    RC::Unreal::UObject* invoke_object_ufunction(RC::Unreal::UObject* receiver, RC::Unreal::UFunction* fn) {
        auto* caller = resolve_receive_caller(receiver, fn);
        if (!caller || !fn || !is_likely_valid_object_ptr(fn)) {
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
                    if (meta_game_instance_ && is_likely_valid_object_ptr(meta_game_instance_)) {
                        context_object = meta_game_instance_;
                    } else if (receiver && is_likely_valid_object_ptr(receiver)) {
                        context_object = receiver;
                    } else {
                        context_object = caller;
                    }
                    object_property->SetObjectPropertyValue(value_ptr, context_object);
                }
                continue;
            }

            const bool is_out = property->HasAnyPropertyFlags(RC::Unreal::CPF_OutParm)
                || property->HasAnyPropertyFlags(RC::Unreal::CPF_ReturnParm);
            const bool has_output_name = (normalized_name == "outvalue" || normalized_name == "returnvalue");
            if (!is_out && !has_output_name) {
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

    bool try_read_int(RC::Unreal::UObject* receiver, std::initializer_list<RC::Unreal::UFunction*> fns, int32_t& out) {
        for (auto* fn : fns) {
            if (!fn || !is_likely_valid_object_ptr(fn)) {
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
            int score = 0;
            if (full_name.find(STR("Default__")) != RC::StringType::npos) score -= 1000;
            if (full_name.find(STR("/Script/")) != RC::StringType::npos) score -= 100;
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
            const auto object_path = object_path_from_full_name(full_name);
            int score = 0;
            if (full_name.find(STR("Default__")) != RC::StringType::npos) score -= 1000;
            if (full_name.find(STR("/Script/")) != RC::StringType::npos) score -= 100;
            if (full_name.find(STR("/Engine/Transient.")) != RC::StringType::npos) score += 40;
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

    RC::Unreal::UObject* resolve_sandbox_session_stats_instance(uint64_t now) {
        if (sandbox_session_stats_instance_ && is_likely_valid_object_ptr(sandbox_session_stats_instance_) && now < next_sandbox_resolve_ms_) {
            return sandbox_session_stats_instance_;
        }
        next_sandbox_resolve_ms_ = now + 1000;

        auto* meta = resolve_meta_game_instance(now);
        RC::StringType meta_path{};
        if (meta && is_likely_valid_object_ptr(meta)) {
            meta_path = object_path_from_full_name(meta->GetFullName());
        }

        RC::Unreal::UObject* found = nullptr;
        if (meta && is_likely_valid_object_ptr(meta) && targets_.meta_get_sandbox_session_stats) {
            found = invoke_object_ufunction(meta, targets_.meta_get_sandbox_session_stats);
        }
        if (!found || !is_likely_valid_object_ptr(found)) {
            std::vector<RC::Unreal::UObject*> all{};
            RC::Unreal::UObjectGlobals::FindAllOf(STR("SandboxSessionStats"), all);
            std::vector<RC::Unreal::UObject*> alt{};
            RC::Unreal::UObjectGlobals::FindAllOf(STR("SandboxSessionStats_C"), alt);
            append_unique_objects(all, alt);

            RC::Unreal::UObject* best = nullptr;
            RC::Unreal::UObject* best_meta_scoped = nullptr;
            int best_score = -1000000;
            int best_meta_scoped_score = -1000000;
            for (auto* obj : all) {
                if (!obj || !is_likely_valid_object_ptr(obj)) {
                    continue;
                }
                const auto full_name = obj->GetFullName();
                const auto object_path = object_path_from_full_name(full_name);
                int score = 0;
                if (full_name.find(STR("Default__")) != RC::StringType::npos) score -= 1000;
                if (full_name.find(STR("/Script/")) != RC::StringType::npos) score -= 100;
                if (full_name.find(STR("/Engine/Transient.")) != RC::StringType::npos) score += 40;
                if (full_name.find(STR("TheMetaGameInstance")) != RC::StringType::npos) score += 220;
                if (full_name.find(STR("SandboxSessionStats_")) != RC::StringType::npos) score += 120;
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
            found = best_meta_scoped ? best_meta_scoped : best;
        }
        if (found && is_likely_valid_object_ptr(found)) {
            sandbox_session_stats_instance_ = found;
        }
        return sandbox_session_stats_instance_;
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
            const auto object_path = object_path_from_full_name(full_name);
            int score = 0;
            if (full_name.find(STR("Default__")) != RC::StringType::npos) score -= 1000;
            if (full_name.find(STR("/Script/")) != RC::StringType::npos) score -= 100;
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

    void emit_pull_i32(const char* ev, int32_t& last_value, int32_t value, uint64_t& last_nonzero_ms, uint64_t now) {
        if (value < 0) {
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
        if (!kovaaks::RustBridge::emit_i32(ev, value)) {
            std::array<char, 160> json{};
            std::snprintf(json.data(), json.size(), "{\"ev\":\"%s\",\"value\":%d}", ev, value);
            kovaaks::RustBridge::emit_json(json.data());
        }

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
        constexpr uint64_t k_zero_suppress_ms = 2500;
        if (value == 0.0f && std::isfinite(last_value) && last_value > 0.0f && (now - last_nonzero_ms) < k_zero_suppress_ms) {
            return;
        }
        if (value > 0.0f) {
            last_nonzero_ms = now;
        }
        if (std::isfinite(last_value) && std::fabs(static_cast<double>(last_value) - static_cast<double>(value)) <= 0.0001) {
            return;
        }
        last_value = value;
        if (!kovaaks::RustBridge::emit_f32(ev, value)) {
            std::array<char, 192> json{};
            std::snprintf(json.data(), json.size(), "{\"ev\":\"%s\",\"value\":%.6f}", ev, static_cast<double>(value));
            kovaaks::RustBridge::emit_json(json.data());
        }
    }
};

extern "C" __declspec(dllexport) RC::CppUserModBase* start_mod() {
    return new KovaaksBridgeModProduction();
}

extern "C" __declspec(dllexport) void uninstall_mod(RC::CppUserModBase* mod) {
    delete mod;
}
