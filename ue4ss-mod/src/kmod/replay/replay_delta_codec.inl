namespace kmod_replay {

static auto replay_float_changed(float a, float b, float eps = 0.0001f) -> bool {
    const bool a_valid = std::isfinite(a);
    const bool b_valid = std::isfinite(b);
    if (a_valid != b_valid) {
        return true;
    }
    if (!a_valid && !b_valid) {
        return false;
    }
    return std::fabs(static_cast<double>(a) - static_cast<double>(b)) > static_cast<double>(eps);
}

static auto replay_entity_changed(const ReplayEntity& prev, const ReplayEntity& cur) -> bool {
    if (prev.profile != cur.profile) return true;
    if (prev.is_player != cur.is_player) return true;
    if (prev.is_bot != cur.is_bot) return true;

    if (replay_float_changed(prev.location.x, cur.location.x)) return true;
    if (replay_float_changed(prev.location.y, cur.location.y)) return true;
    if (replay_float_changed(prev.location.z, cur.location.z)) return true;

    if (replay_float_changed(prev.rotation.pitch, cur.rotation.pitch)) return true;
    if (replay_float_changed(prev.rotation.yaw, cur.rotation.yaw)) return true;
    if (replay_float_changed(prev.rotation.roll, cur.rotation.roll)) return true;

    if (replay_float_changed(prev.velocity.x, cur.velocity.x)) return true;
    if (replay_float_changed(prev.velocity.y, cur.velocity.y)) return true;
    if (replay_float_changed(prev.velocity.z, cur.velocity.z)) return true;

    return false;
}

static auto replay_context_changed(const ReplayContext& prev, const ReplayContext& cur) -> bool {
    return prev.run_id != cur.run_id
        || prev.scenario_name != cur.scenario_name
        || prev.scenario_id != cur.scenario_id
        || prev.scenario_manager_id != cur.scenario_manager_id
        || prev.map_name != cur.map_name
        || replay_float_changed(prev.map_scale, cur.map_scale)
        || prev.scenario_play_type != cur.scenario_play_type
        || prev.is_replay != cur.is_replay;
}

static auto replay_scalars_changed(const ReplayScalars& prev, const ReplayScalars& cur) -> bool {
    return prev.is_in_challenge != cur.is_in_challenge
        || prev.is_in_scenario != cur.is_in_scenario
        || prev.is_in_scenario_editor != cur.is_in_scenario_editor
        || prev.is_in_trainer != cur.is_in_trainer
        || prev.scenario_is_paused != cur.scenario_is_paused
        || prev.scenario_is_enabled != cur.scenario_is_enabled
        || replay_float_changed(prev.challenge_seconds_total, cur.challenge_seconds_total)
        || replay_float_changed(prev.session_seconds_total, cur.session_seconds_total)
        || replay_float_changed(prev.time_remaining, cur.time_remaining)
        || replay_float_changed(prev.queue_time_remaining, cur.queue_time_remaining)
        || replay_float_changed(prev.score_metric_total, cur.score_metric_total)
        || replay_float_changed(prev.score_total_derived, cur.score_total_derived)
        || replay_float_changed(prev.score_total_selected, cur.score_total_selected)
        || prev.game_state_code != cur.game_state_code
        || prev.game_state != cur.game_state
        || prev.score_source != cur.score_source;
}

static auto replay_build_delta(
    const ReplayRuntimeState& runtime,
    const ReplayContext& context,
    const ReplayScalars& scalars,
    const std::vector<ReplayEntity>& entities,
    ReplayDeltaFrame& out_delta
) -> void {
    out_delta = ReplayDeltaFrame{};

    out_delta.context_changed = replay_context_changed(runtime.last_context, context);
    out_delta.has_scalar_changes = replay_scalars_changed(runtime.last_scalars, scalars);

    std::unordered_map<std::string, ReplayEntity> current_map{};
    current_map.reserve(entities.size());
    for (const auto& entity : entities) {
        current_map[entity.id] = entity;

        const auto prev_it = runtime.last_entities.find(entity.id);
        if (prev_it == runtime.last_entities.end()) {
            out_delta.upserts.emplace_back(entity);
            continue;
        }
        if (replay_entity_changed(prev_it->second, entity)) {
            out_delta.upserts.emplace_back(entity);
        }
    }

    for (const auto& prev_pair : runtime.last_entities) {
        if (current_map.find(prev_pair.first) == current_map.end()) {
            out_delta.removes.emplace_back(prev_pair.first);
        }
    }
}

} // namespace kmod_replay
