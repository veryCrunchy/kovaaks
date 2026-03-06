#[derive(Clone, Debug, Default)]
struct InGameReplayReadyState {
    session_id: String,
    started: bool,
    ready: bool,
    ok: bool,
    completed: bool,
    failed: bool,
    interrupted: bool,
    reason: String,
    phase: String,
    in_scenario: bool,
    in_challenge: bool,
    map_ready: bool,
    map_loading: bool,
    map_fully_loaded: bool,
    have_entities: bool,
    runtime_refs: u64,
    entities: u64,
    bound: u64,
    ts_ms: u64,
    last_status_at: Option<Instant>,
}

fn in_game_replay_ready_state() -> &'static Mutex<InGameReplayReadyState> {
    static STATE: OnceLock<Mutex<InGameReplayReadyState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(InGameReplayReadyState::default()))
}

fn reset_in_game_replay_ready_state(session_id: &str) {
    if let Ok(mut state) = in_game_replay_ready_state().lock() {
        state.session_id = session_id.to_string();
        state.started = false;
        state.ready = false;
        state.ok = false;
        state.completed = false;
        state.failed = false;
        state.interrupted = false;
        state.reason.clear();
        state.phase.clear();
        state.in_scenario = false;
        state.in_challenge = false;
        state.map_ready = false;
        state.map_loading = false;
        state.map_fully_loaded = false;
        state.have_entities = false;
        state.runtime_refs = 0;
        state.entities = 0;
        state.bound = 0;
        state.ts_ms = 0;
        state.last_status_at = None;
    }
}

fn note_in_game_replay_event(raw: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return;
    };
    let Some(obj) = value.as_object() else {
        return;
    };
    let Some(ev) = obj.get("ev").and_then(|v| v.as_str()) else {
        return;
    };
    if !matches!(
        ev,
        "replay_playback_started"
            | "replay_playback_status"
            | "replay_playback_ready"
            | "replay_playback_complete"
            | "replay_playback_failed"
            | "replay_playback_interrupted"
    ) {
        return;
    }

    let session_id = obj
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if session_id.is_empty() {
        return;
    }

    let ts_ms = obj.get("ts_ms").and_then(replay_json_u64).unwrap_or(0);
    if let Ok(mut state) = in_game_replay_ready_state().lock() {
        if !state.session_id.is_empty() && state.session_id != session_id {
            return;
        }
        state.session_id = session_id;
        state.ts_ms = ts_ms;
        match ev {
            "replay_playback_started" => {
                state.started = true;
                state.phase = obj
                    .get("phase")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
            }
            "replay_playback_status" => {
                state.phase = obj
                    .get("phase")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                state.in_scenario = obj
                    .get("in_scenario")
                    .and_then(replay_json_boolish)
                    .unwrap_or(false);
                state.in_challenge = obj
                    .get("in_challenge")
                    .and_then(replay_json_boolish)
                    .unwrap_or(false);
                state.map_ready = obj
                    .get("map_ready")
                    .and_then(replay_json_boolish)
                    .unwrap_or(false);
                state.map_loading = obj
                    .get("map_loading")
                    .and_then(replay_json_boolish)
                    .unwrap_or(false);
                state.map_fully_loaded = obj
                    .get("map_fully_loaded")
                    .and_then(replay_json_boolish)
                    .unwrap_or(false);
                state.have_entities = obj
                    .get("have_entities")
                    .and_then(replay_json_boolish)
                    .unwrap_or(false);
                state.runtime_refs = obj.get("runtime_refs").and_then(replay_json_u64).unwrap_or(0);
                state.entities = obj.get("entities").and_then(replay_json_u64).unwrap_or(0);
                state.bound = obj.get("bound").and_then(replay_json_u64).unwrap_or(0);
                state.reason = obj
                    .get("ready_reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                state.last_status_at = Some(Instant::now());
            }
            "replay_playback_ready" => {
                state.ready = true;
                state.ok = obj.get("ok").and_then(replay_json_boolish).unwrap_or(false);
                state.reason = obj
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
            }
            "replay_playback_complete" => {
                state.completed = true;
                state.reason = "completed".to_string();
                if let Ok(mut slot) = in_game_replay_stop_flag().lock() {
                    *slot = None;
                }
                if let Ok(mut slot) = in_game_replay_session_id_slot().lock() {
                    *slot = None;
                }
                in_game_replay_active_flag().store(false, Ordering::SeqCst);
            }
            "replay_playback_failed" => {
                state.failed = true;
                state.reason = obj
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                state.phase = obj
                    .get("phase")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
            }
            "replay_playback_interrupted" => {
                state.interrupted = true;
                state.reason = obj
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
            }
            _ => {}
        }
    }
}

fn replay_bootstrap_can_stream_best_effort(state: &InGameReplayReadyState) -> bool {
    state.in_scenario
        || state.have_entities
        || state.bound > 0
        || (state.map_ready && state.map_fully_loaded && !state.map_loading)
}

enum ReplayReadyWaitResult {
    ReadyOk { reason: String },
    ReadyBestEffort { reason: String },
    Failed { reason: String },
    Interrupted { reason: String },
    TimedOut,
    Cancelled,
}

fn wait_for_in_game_replay_ready(
    session_id: &str,
    stop_flag: &Arc<AtomicBool>,
    timeout: Duration,
    ready_policy: &str,
) -> ReplayReadyWaitResult {
    let start = Instant::now();
    let mut saw_started = false;
    let mut saw_progress = false;
    while start.elapsed() < timeout {
        if stop_flag.load(Ordering::SeqCst) {
            return ReplayReadyWaitResult::Cancelled;
        }
        if saw_started && !bridge_dll_connected_flag().load(Ordering::SeqCst) {
            return ReplayReadyWaitResult::Failed {
                reason: "bridge_disconnected".to_string(),
            };
        }

        if let Ok(state) = in_game_replay_ready_state().lock() {
            if state.session_id == session_id {
                if state.started {
                    saw_started = true;
                }
                if replay_bootstrap_can_stream_best_effort(&state) {
                    saw_progress = true;
                }
                if state.failed {
                    return ReplayReadyWaitResult::Failed {
                        reason: state.reason.clone(),
                    };
                }
                if state.interrupted {
                    return ReplayReadyWaitResult::Interrupted {
                        reason: state.reason.clone(),
                    };
                }
                if state.ready {
                    if state.ok {
                        return ReplayReadyWaitResult::ReadyOk {
                            reason: state.reason.clone(),
                        };
                    }
                    if replay_policy_is_best_effort(ready_policy)
                        && state.reason.eq_ignore_ascii_case("timeout")
                        && replay_bootstrap_can_stream_best_effort(&state)
                    {
                        return ReplayReadyWaitResult::ReadyBestEffort {
                            reason: state.reason.clone(),
                        };
                    }
                    return ReplayReadyWaitResult::Failed {
                        reason: if state.reason.is_empty() {
                            "ready_not_ok".to_string()
                        } else {
                            state.reason.clone()
                        },
                    };
                }
            }
        }

        std::thread::sleep(Duration::from_millis(40));
    }

    if replay_policy_is_best_effort(ready_policy) && saw_started && saw_progress {
        ReplayReadyWaitResult::ReadyBestEffort {
            reason: "timeout_with_progress".to_string(),
        }
    } else {
        ReplayReadyWaitResult::TimedOut
    }
}
