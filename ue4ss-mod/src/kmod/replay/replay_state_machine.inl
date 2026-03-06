namespace kmod_replay {

static auto game_state_code_to_string(GameStateCode code) -> const char* {
    switch (code) {
    case GameStateCode::Menu: return "menu";
    case GameStateCode::TrainerMenu: return "trainer_menu";
    case GameStateCode::Queued: return "queued";
    case GameStateCode::Freeplay: return "freeplay";
    case GameStateCode::Challenge: return "challenge";
    case GameStateCode::Paused: return "paused";
    case GameStateCode::Editor: return "editor";
    case GameStateCode::Replay: return "replay";
    default: return "menu";
    }
}

static auto derive_game_state_code(
    int32_t is_in_scenario_editor,
    int32_t scenario_is_paused,
    int32_t is_in_challenge,
    int32_t is_in_scenario,
    int32_t is_in_trainer,
    float queue_time_remaining,
    float time_remaining,
    int32_t is_replay
) -> GameStateCode {
    if (is_in_scenario_editor == 1) {
        return GameStateCode::Editor;
    }
    if (is_replay == 1) {
        return GameStateCode::Replay;
    }
    if (scenario_is_paused == 1) {
        return GameStateCode::Paused;
    }

    const bool has_queue = std::isfinite(queue_time_remaining) && queue_time_remaining > 0.0001f;
    const bool has_time = std::isfinite(time_remaining) && time_remaining > 0.0001f;
    const bool queue_sentinel_only =
        has_queue
        && !has_time
        && is_in_challenge != 1
        && is_in_scenario != 1
        && is_in_trainer != 1
        && std::fabs(static_cast<double>(queue_time_remaining) - 1.0) <= 0.0001;
    const bool effective_queue = has_queue && !queue_sentinel_only;

    if (is_in_challenge == 1 || has_time) {
        return GameStateCode::Challenge;
    }
    if (effective_queue) {
        return GameStateCode::Queued;
    }
    if (is_in_scenario == 1) {
        return GameStateCode::Freeplay;
    }
    if (is_in_trainer == 1) {
        return GameStateCode::TrainerMenu;
    }
    return GameStateCode::Menu;
}

static auto normalize_replay_score(
    float score_metric_total,
    float score_total_derived,
    const std::string& score_source,
    float& out_selected,
    std::string& out_source
) -> void {
    out_selected = -1.0f;
    out_source = "none";

    if (std::isfinite(score_metric_total) && score_metric_total >= 0.0f) {
        out_selected = score_metric_total;
        out_source = "metric_score_total";
        return;
    }

    if (std::isfinite(score_total_derived) && score_total_derived >= 0.0f) {
        out_selected = score_total_derived;
        out_source = "derived";
        return;
    }

    if (!score_source.empty()) {
        out_source = score_source;
    }
}

} // namespace kmod_replay
