namespace kmod_replay {

static auto replay_escape_json(const std::string& input) -> std::string {
    std::string out;
    out.reserve(input.size() + 16);
    for (unsigned char c : input) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (c < 0x20) {
                char buf[7]{};
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

static auto replay_append_f32(std::string& out, float value) -> void {
    if (!std::isfinite(value)) {
        out += "null";
        return;
    }
    char buf[48]{};
    std::snprintf(buf, sizeof(buf), "%.6f", static_cast<double>(value));
    out += buf;
}

static auto replay_append_u64(std::string& out, uint64_t value) -> void {
    char buf[32]{};
    std::snprintf(buf, sizeof(buf), "%llu", static_cast<unsigned long long>(value));
    out += buf;
}

static auto replay_append_i32(std::string& out, int32_t value) -> void {
    char buf[24]{};
    std::snprintf(buf, sizeof(buf), "%d", value);
    out += buf;
}

static auto replay_append_entity_json(std::string& out, const ReplayEntity& entity) -> void {
    out += "{\"id\":\"";
    out += replay_escape_json(entity.id);
    out += "\",\"profile\":\"";
    out += replay_escape_json(entity.profile);
    out += "\",\"is_player\":";
    out += entity.is_player ? "true" : "false";
    out += ",\"is_bot\":";
    out += entity.is_bot ? "true" : "false";
    out += ",\"location\":{";
    out += "\"x\":";
    replay_append_f32(out, entity.location.x);
    out += ",\"y\":";
    replay_append_f32(out, entity.location.y);
    out += ",\"z\":";
    replay_append_f32(out, entity.location.z);
    out += "},\"rotation\":{";
    out += "\"pitch\":";
    replay_append_f32(out, entity.rotation.pitch);
    out += ",\"yaw\":";
    replay_append_f32(out, entity.rotation.yaw);
    out += ",\"roll\":";
    replay_append_f32(out, entity.rotation.roll);
    out += "},\"velocity\":{";
    out += "\"x\":";
    replay_append_f32(out, entity.velocity.x);
    out += ",\"y\":";
    replay_append_f32(out, entity.velocity.y);
    out += ",\"z\":";
    replay_append_f32(out, entity.velocity.z);
    out += "}}";
}

static auto replay_append_context_json(std::string& out, const ReplayContext& context) -> void {
    out += "\"context\":{";
    out += "\"run_id\":";
    replay_append_u64(out, context.run_id);
    out += ",\"scenario_name\":\"";
    out += replay_escape_json(context.scenario_name);
    out += "\",\"scenario_id\":\"";
    out += replay_escape_json(context.scenario_id);
    out += "\",\"scenario_manager_id\":\"";
    out += replay_escape_json(context.scenario_manager_id);
    out += "\",\"map_name\":\"";
    out += replay_escape_json(context.map_name);
    out += "\",\"map_scale\":";
    replay_append_f32(out, context.map_scale);
    out += ",\"scenario_play_type\":";
    replay_append_i32(out, context.scenario_play_type);
    out += ",\"is_replay\":";
    replay_append_i32(out, context.is_replay);
    out += "}";
}

static auto replay_append_scalars_json(std::string& out, const ReplayScalars& scalars) -> void {
    out += "\"scalars\":{";
    out += "\"is_in_challenge\":";
    replay_append_i32(out, scalars.is_in_challenge);
    out += ",\"is_in_scenario\":";
    replay_append_i32(out, scalars.is_in_scenario);
    out += ",\"is_in_scenario_editor\":";
    replay_append_i32(out, scalars.is_in_scenario_editor);
    out += ",\"is_in_trainer\":";
    replay_append_i32(out, scalars.is_in_trainer);
    out += ",\"scenario_is_paused\":";
    replay_append_i32(out, scalars.scenario_is_paused);
    out += ",\"scenario_is_enabled\":";
    replay_append_i32(out, scalars.scenario_is_enabled);
    out += ",\"challenge_seconds_total\":";
    replay_append_f32(out, scalars.challenge_seconds_total);
    out += ",\"session_seconds_total\":";
    replay_append_f32(out, scalars.session_seconds_total);
    out += ",\"time_remaining\":";
    replay_append_f32(out, scalars.time_remaining);
    out += ",\"queue_time_remaining\":";
    replay_append_f32(out, scalars.queue_time_remaining);
    out += ",\"score_metric_total\":";
    replay_append_f32(out, scalars.score_metric_total);
    out += ",\"score_total_derived\":";
    replay_append_f32(out, scalars.score_total_derived);
    out += ",\"score_total\":";
    replay_append_f32(out, scalars.score_total_selected);
    out += ",\"game_state_code\":";
    replay_append_i32(out, static_cast<int32_t>(scalars.game_state_code));
    out += ",\"game_state\":\"";
    out += replay_escape_json(scalars.game_state);
    out += "\",\"score_source\":\"";
    out += replay_escape_json(scalars.score_source);
    out += "\"}";
}

static auto replay_emit_context_event(
    const ReplayRuntimeState& runtime,
    uint64_t now_ms,
    const ReplayContext& context
) -> void {
    std::string msg;
    msg.reserve(1024);
    msg += "{\"ev\":\"replay_context\",\"ts_ms\":";
    replay_append_u64(msg, now_ms);
    msg += ",\"sample_hz\":";
    replay_append_i32(msg, runtime.sampler.sample_hz);
    msg += ",\"keyframe_interval_ms\":1000,";
    replay_append_context_json(msg, context);
    msg += "}";
    kovaaks::RustBridge::emit_json(msg.c_str());
}

static auto replay_emit_keyframe_event(
    ReplayRuntimeState& runtime,
    uint64_t now_ms,
    const ReplayContext& context,
    const ReplayScalars& scalars,
    const std::vector<ReplayEntity>& entities
) -> void {
    std::string msg;
    msg.reserve(4096 + entities.size() * 256);
    msg += "{\"ev\":\"replay_tick_keyframe\",\"ts_ms\":";
    replay_append_u64(msg, now_ms);
    msg += ",\"seq\":";
    replay_append_u64(msg, runtime.seq);
    msg += ",\"sample_hz\":";
    replay_append_i32(msg, runtime.sampler.sample_hz);
    msg += ",\"keyframe_interval_ms\":1000,";
    replay_append_context_json(msg, context);
    msg += ",";
    replay_append_scalars_json(msg, scalars);
    msg += ",\"entities\":[";
    bool first = true;
    for (const auto& entity : entities) {
        if (!first) {
            msg += ",";
        }
        first = false;
        replay_append_entity_json(msg, entity);
    }
    msg += "]}";

    kovaaks::RustBridge::emit_json(msg.c_str());

    runtime.keyframes_emitted += 1;
    runtime.last_keyframe_ms = now_ms;
}

static auto replay_emit_delta_event(
    ReplayRuntimeState& runtime,
    uint64_t now_ms,
    const ReplayContext& context,
    const ReplayScalars& scalars,
    const ReplayDeltaFrame& delta
) -> void {
    std::string msg;
    msg.reserve(3072 + delta.upserts.size() * 256 + delta.removes.size() * 64);
    msg += "{\"ev\":\"replay_tick_delta\",\"ts_ms\":";
    replay_append_u64(msg, now_ms);
    msg += ",\"seq\":";
    replay_append_u64(msg, runtime.seq);
    msg += ",\"sample_hz\":";
    replay_append_i32(msg, runtime.sampler.sample_hz);
    msg += ",\"keyframe_interval_ms\":1000,";
    replay_append_context_json(msg, context);
    msg += ",";
    replay_append_scalars_json(msg, scalars);
    msg += ",\"upserts\":[";
    bool first = true;
    for (const auto& entity : delta.upserts) {
        if (!first) {
            msg += ",";
        }
        first = false;
        replay_append_entity_json(msg, entity);
    }
    msg += "],\"remove\":[";
    first = true;
    for (const auto& id : delta.removes) {
        if (!first) {
            msg += ",";
        }
        first = false;
        msg += "\"";
        msg += replay_escape_json(id);
        msg += "\"";
    }
    msg += "]}";

    kovaaks::RustBridge::emit_json(msg.c_str());
    runtime.deltas_emitted += 1;
}

static auto replay_emit_end_event(
    ReplayRuntimeState& runtime,
    uint64_t now_ms,
    const ReplayScalars& scalars,
    const char* reason
) -> void {
    std::string msg;
    msg.reserve(1024);
    msg += "{\"ev\":\"replay_tick_end\",\"ts_ms\":";
    replay_append_u64(msg, now_ms);
    msg += ",\"run_id\":";
    replay_append_u64(msg, runtime.current_run_id);
    msg += ",\"reason\":\"";
    msg += replay_escape_json(reason ? reason : "unknown");
    msg += "\",\"samples\":";
    replay_append_u64(msg, runtime.samples_emitted);
    msg += ",\"keyframes\":";
    replay_append_u64(msg, runtime.keyframes_emitted);
    msg += ",\"deltas\":";
    replay_append_u64(msg, runtime.deltas_emitted);
    msg += ",\"final_score_total\":";
    replay_append_f32(msg, scalars.score_total_selected);
    msg += ",\"score_source\":\"";
    msg += replay_escape_json(scalars.score_source);
    msg += "\"}";
    kovaaks::RustBridge::emit_json(msg.c_str());
}

static auto replay_runtime_state() -> ReplayRuntimeState& {
    static ReplayRuntimeState state{};
    return state;
}

static auto replay_update_runtime_baseline(
    ReplayRuntimeState& runtime,
    const ReplayContext& context,
    const ReplayScalars& scalars,
    const std::vector<ReplayEntity>& entities
) -> void {
    runtime.last_context = context;
    runtime.last_scalars = scalars;
    runtime.last_entities.clear();
    runtime.last_entities.reserve(entities.size());
    for (const auto& entity : entities) {
        runtime.last_entities[entity.id] = entity;
    }
}

static auto replay_prepare_scalars(ReplayScalars& scalars) -> void {
    float selected_score = -1.0f;
    std::string selected_source{};
    normalize_replay_score(
        scalars.score_metric_total,
        scalars.score_total_derived,
        scalars.score_source,
        selected_score,
        selected_source
    );
    scalars.score_total_selected = selected_score;
    scalars.score_source = selected_source;

    scalars.game_state_code = derive_game_state_code(
        scalars.is_in_scenario_editor,
        scalars.scenario_is_paused,
        scalars.is_in_challenge,
        scalars.is_in_scenario,
        scalars.is_in_trainer,
        scalars.queue_time_remaining,
        scalars.time_remaining,
        0
    );
    scalars.game_state = game_state_code_to_string(scalars.game_state_code);
}

static auto replay_context_has_valid_map(const ReplayContext& context) -> bool {
    return !context.map_name.empty() && std::isfinite(context.map_scale) && context.map_scale > 0.0f;
}

static auto replay_apply_context_fallback(
    const ReplayRuntimeState& runtime,
    ReplayContext& context
) -> void {
    const bool current_has_map = replay_context_has_valid_map(context);
    const bool baseline_has_map = replay_context_has_valid_map(runtime.last_context);
    if (!current_has_map && baseline_has_map) {
        context.map_name = runtime.last_context.map_name;
        context.map_scale = runtime.last_context.map_scale;
    }
}

static auto replay_apply_entity_fallback(
    const ReplayRuntimeState& runtime,
    const ReplayScalars& scalars,
    std::vector<ReplayEntity>& entities
) -> void {
    const bool in_active_state = scalars.is_in_challenge == 1 || scalars.is_in_scenario == 1;
    if (!in_active_state || !entities.empty() || runtime.last_entities.empty()) {
        return;
    }

    entities.reserve(runtime.last_entities.size());
    for (const auto& kv : runtime.last_entities) {
        entities.push_back(kv.second);
    }
}

static auto replay_tick(const ReplayTickInput& input) -> void {
    auto& runtime = replay_runtime_state();
    if (!runtime.initialized) {
        runtime.initialized = true;
        replay_sampler_reset(runtime.sampler, input.now_ms);
    }

    if (!input.bridge_connected) {
        if (runtime.run_active) {
            replay_emit_end_event(runtime, input.now_ms, runtime.last_scalars, "bridge_disconnected");
        }
        runtime.run_active = false;
        runtime.last_entities.clear();
        return;
    }

    const bool should_be_active = input.scalars.is_in_challenge == 1 || input.scalars.is_in_scenario == 1;

    if (!runtime.run_active && should_be_active) {
        runtime.run_active = true;
        runtime.seq = 0;
        runtime.keyframes_emitted = 0;
        runtime.deltas_emitted = 0;
        runtime.samples_emitted = 0;
        runtime.last_keyframe_ms = 0;
        runtime.last_context = ReplayContext{};
        runtime.last_scalars = ReplayScalars{};
        runtime.last_entities.clear();
        replay_sampler_reset(runtime.sampler, input.now_ms);

        if (input.context.run_id > 0) {
            runtime.current_run_id = input.context.run_id;
        } else {
            runtime.current_run_id += 1;
        }
    } else if (runtime.run_active && !should_be_active) {
        replay_emit_end_event(runtime, input.now_ms, runtime.last_scalars, "state_transition");
        runtime.run_active = false;
        runtime.last_entities.clear();
        return;
    }

    if (!runtime.run_active) {
        return;
    }

    if (!replay_sampler_should_sample(runtime.sampler, input.now_ms)) {
        return;
    }

    ReplayContext context = input.context;
    if (context.run_id == 0) {
        context.run_id = runtime.current_run_id;
    }
    replay_collect_map_context(context);
    replay_apply_context_fallback(runtime, context);

    ReplayScalars scalars = input.scalars;
    replay_prepare_scalars(scalars);

    std::vector<ReplayEntity> entities{};
    replay_collect_entities(entities);
    replay_apply_entity_fallback(runtime, scalars, entities);

    const bool context_changed = replay_context_changed(runtime.last_context, context);
    if (context_changed || runtime.keyframes_emitted == 0) {
        replay_emit_context_event(runtime, input.now_ms, context);
    }

    const bool keyframe_due = runtime.last_keyframe_ms == 0
        || (input.now_ms - runtime.last_keyframe_ms) >= 1000
        || context_changed;

    if (keyframe_due) {
        replay_emit_keyframe_event(runtime, input.now_ms, context, scalars, entities);
        replay_update_runtime_baseline(runtime, context, scalars, entities);
        runtime.seq += 1;
        runtime.samples_emitted += 1;
        return;
    }

    ReplayDeltaFrame delta{};
    replay_build_delta(runtime, context, scalars, entities, delta);

    if (delta.context_changed || delta.has_scalar_changes || !delta.upserts.empty() || !delta.removes.empty()) {
        replay_emit_delta_event(runtime, input.now_ms, context, scalars, delta);
    }

    replay_update_runtime_baseline(runtime, context, scalars, entities);
    runtime.seq += 1;
    runtime.samples_emitted += 1;
}

} // namespace kmod_replay
