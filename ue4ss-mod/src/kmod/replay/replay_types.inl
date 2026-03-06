namespace kmod_replay {

enum class GameStateCode : int32_t {
    Menu = 0,
    TrainerMenu = 1,
    Queued = 2,
    Freeplay = 3,
    Challenge = 4,
    Paused = 5,
    Editor = 6,
    Replay = 7,
};

struct ReplayVec3 {
    float x{0.0f};
    float y{0.0f};
    float z{0.0f};
};

struct ReplayRotator {
    float pitch{0.0f};
    float yaw{0.0f};
    float roll{0.0f};
};

struct ReplayEntity {
    std::string id{};
    std::string profile{};
    bool is_player{false};
    bool is_bot{false};
    ReplayVec3 location{};
    ReplayRotator rotation{};
    ReplayVec3 velocity{};
};

struct ReplayEntityActorRef {
    ReplayEntity entity{};
    RC::Unreal::UObject* actor{nullptr};
};

struct ReplayContext {
    uint64_t run_id{0};
    std::string scenario_name{};
    std::string scenario_id{};
    std::string scenario_manager_id{};
    std::string map_name{};
    float map_scale{-1.0f};
    int32_t scenario_play_type{-1};
    int32_t is_replay{0};
};

struct ReplayScalars {
    int32_t is_in_challenge{-1};
    int32_t is_in_scenario{-1};
    int32_t is_in_scenario_editor{-1};
    int32_t is_in_trainer{-1};
    int32_t scenario_is_paused{-1};
    int32_t scenario_is_enabled{-1};
    float challenge_seconds_total{-1.0f};
    float session_seconds_total{-1.0f};
    float time_remaining{-1.0f};
    float queue_time_remaining{-1.0f};
    float score_metric_total{-1.0f};
    float score_total_derived{-1.0f};
    float score_total_selected{-1.0f};
    GameStateCode game_state_code{GameStateCode::Menu};
    std::string game_state{};
    std::string score_source{};
};

struct ReplayTickInput {
    uint64_t now_ms{0};
    bool bridge_connected{false};
    ReplayContext context{};
    ReplayScalars scalars{};
};

struct ReplaySamplerState {
    uint64_t next_sample_ms{0};
    uint64_t last_sample_ms{0};
    int32_t sample_hz{60};
};

struct ReplayRuntimeState {
    bool initialized{false};
    bool run_active{false};
    uint64_t current_run_id{0};
    uint64_t seq{0};
    uint64_t last_keyframe_ms{0};
    uint64_t keyframes_emitted{0};
    uint64_t deltas_emitted{0};
    uint64_t samples_emitted{0};

    ReplaySamplerState sampler{};

    ReplayContext last_context{};
    ReplayScalars last_scalars{};
    std::unordered_map<std::string, ReplayEntity> last_entities{};
};

struct ReplayDeltaFrame {
    bool has_scalar_changes{false};
    bool context_changed{false};
    std::vector<ReplayEntity> upserts{};
    std::vector<std::string> removes{};
};

enum class BridgeCommandKind : int32_t {
    Unknown = 0,
    StateSnapshotRequest = 1,
    ReplayPlayStart = 2,
    ReplayPlayStop = 3,
    ReplayEntityMeta = 4,
    ReplayEntityPose = 5,
    ReplayRemoveEntity = 6,
};

struct BridgeCommand {
    BridgeCommandKind kind{BridgeCommandKind::Unknown};
    std::string raw{};
    std::string reason{};
    std::string session_id{};
    std::string map_name{};
    float map_scale{-1.0f};
    int32_t force_freeplay{1};
    int32_t hide_ui{1};
    int32_t bootstrap_timeout_ms{12000};
    ReplayEntity entity{};
    std::string entity_id{};
};

} // namespace kmod_replay
