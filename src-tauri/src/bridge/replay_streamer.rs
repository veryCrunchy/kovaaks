fn set_in_game_replay_session_id(session_id: Option<String>) {
    if let Ok(mut slot) = in_game_replay_session_id_slot().lock() {
        *slot = session_id;
    }
}

fn clear_in_game_replay_session_if_matches(session_id: &str) {
    if let Ok(mut slot) = in_game_replay_session_id_slot().lock() {
        if slot.as_deref() == Some(session_id) {
            *slot = None;
        }
    }
}

fn replay_thread_cancelled(stop_flag: &AtomicBool, session_id: &str) -> bool {
    if stop_flag.load(Ordering::SeqCst) {
        return true;
    }
    if let Ok(slot) = in_game_replay_session_id_slot().lock() {
        if slot.as_deref() != Some(session_id) {
            return true;
        }
    }
    false
}

pub fn stop_in_game_replay_stream() -> Result<(), String> {
    in_game_replay_active_flag().store(false, Ordering::SeqCst);
    set_in_game_replay_session_id(None);
    if let Ok(mut slot) = in_game_replay_stop_flag().lock() {
        if let Some(flag) = slot.take() {
            flag.store(true, Ordering::SeqCst);
        }
    }
    let stop_cmd = serde_json::json!({
        "cmd": "replay_play_stop"
    })
    .to_string();
    if !enqueue_bridge_command_blocking(stop_cmd) {
        return Err("bridge command queue saturated".to_string());
    }
    Ok(())
}

pub fn start_in_game_replay_stream(
    session_id: &str,
    stream: super::BridgeTickStreamV1,
    speed: f64,
) -> Result<(), String> {
    let frames = build_in_game_replay_frames(&stream);
    if frames.is_empty() {
        return Err("replay has no tick_stream_v1 frame data".to_string());
    }
    let frame_chunks = build_in_game_replay_frame_chunks(&frames);
    if frame_chunks.is_empty() {
        return Err("replay chunk encoder produced no payload".to_string());
    }
    let mut bootstrap = parse_replay_bootstrap_context(&stream);
    let (expected_bot_count, expected_bot_profiles) = derive_replay_bot_expectations(&frames);
    bootstrap.expected_bot_count = expected_bot_count;
    bootstrap.expected_bot_profiles = expected_bot_profiles;

    let safe_session_id = sanitize_state_request_reason(session_id);
    if in_game_replay_active_flag().load(Ordering::SeqCst) {
        if let Ok(slot) = in_game_replay_session_id_slot().lock() {
            if slot.as_deref() == Some(safe_session_id.as_str()) {
                log::info!(
                    "bridge: in-game replay start ignored; session already active ({})",
                    safe_session_id
                );
                return Ok(());
            }
        }
    }

    stop_in_game_replay_stream()?;

    let stop_flag = Arc::new(AtomicBool::new(false));
    {
        let mut slot = in_game_replay_stop_flag()
            .lock()
            .map_err(|e| format!("replay stop lock poisoned: {e}"))?;
        *slot = Some(stop_flag.clone());
    }
    set_in_game_replay_session_id(Some(safe_session_id.clone()));

    let speed = if speed.is_finite() {
        speed.clamp(0.1, 4.0)
    } else {
        1.0
    };
    in_game_replay_active_flag().store(true, Ordering::SeqCst);
    let safe_session_id_for_thread = safe_session_id.clone();

    std::thread::Builder::new()
        .name("bridge-in-game-replay".into())
        .spawn(move || {
            reset_in_game_replay_ready_state(&safe_session_id_for_thread);

            if replay_thread_cancelled(stop_flag.as_ref(), &safe_session_id_for_thread) {
                in_game_replay_active_flag().store(false, Ordering::SeqCst);
                clear_in_game_replay_session_if_matches(&safe_session_id_for_thread);
                return;
            }
            let load_begin_cmd = serde_json::json!({
                "cmd": "replay_load_begin",
                "session_id": safe_session_id_for_thread,
                "total_chunks": frame_chunks.len(),
                "total_frames": frames.len()
            })
            .to_string();
            if !enqueue_bridge_command_blocking(load_begin_cmd) {
                in_game_replay_active_flag().store(false, Ordering::SeqCst);
                clear_in_game_replay_session_if_matches(&safe_session_id_for_thread);
                return;
            }

            for (chunk_index, payload) in frame_chunks.iter().enumerate() {
                if replay_thread_cancelled(stop_flag.as_ref(), &safe_session_id_for_thread) {
                    in_game_replay_active_flag().store(false, Ordering::SeqCst);
                    clear_in_game_replay_session_if_matches(&safe_session_id_for_thread);
                    return;
                }
                let load_chunk_cmd = serde_json::json!({
                    "cmd": "replay_load_chunk",
                    "session_id": safe_session_id_for_thread,
                    "chunk_index": chunk_index,
                    "total_chunks": frame_chunks.len(),
                    "payload": payload
                })
                .to_string();
                if !enqueue_bridge_command_blocking(load_chunk_cmd) {
                    in_game_replay_active_flag().store(false, Ordering::SeqCst);
                    clear_in_game_replay_session_if_matches(&safe_session_id_for_thread);
                    return;
                }
            }

            if replay_thread_cancelled(stop_flag.as_ref(), &safe_session_id_for_thread) {
                in_game_replay_active_flag().store(false, Ordering::SeqCst);
                clear_in_game_replay_session_if_matches(&safe_session_id_for_thread);
                return;
            }
            let load_end_cmd = serde_json::json!({
                "cmd": "replay_load_end",
                "session_id": safe_session_id_for_thread,
                "total_chunks": frame_chunks.len(),
                "total_frames": frames.len()
            })
            .to_string();
            if !enqueue_bridge_command_blocking(load_end_cmd) {
                in_game_replay_active_flag().store(false, Ordering::SeqCst);
                clear_in_game_replay_session_if_matches(&safe_session_id_for_thread);
                return;
            }

            if replay_thread_cancelled(stop_flag.as_ref(), &safe_session_id_for_thread) {
                in_game_replay_active_flag().store(false, Ordering::SeqCst);
                clear_in_game_replay_session_if_matches(&safe_session_id_for_thread);
                return;
            }
            let start_cmd = serde_json::json!({
                "cmd": "replay_play_start",
                "session_id": safe_session_id_for_thread,
                "speed": speed,
                "map_name": bootstrap.map_name.clone().unwrap_or_default(),
                "map_scale": bootstrap.map_scale.unwrap_or(1.0),
                "hide_ui": if bootstrap.hide_ui { 1 } else { 0 },
                "force_freeplay": if bootstrap.force_freeplay { 1 } else { 0 },
                "bootstrap_timeout_ms": bootstrap.bootstrap_timeout_ms,
                "ready_policy": bootstrap.ready_policy.clone(),
                "status_interval_ms": bootstrap.status_interval_ms,
                "expected_bot_count": bootstrap.expected_bot_count,
                "expected_bot_profiles": bootstrap.expected_bot_profiles.clone()
            })
            .to_string();
            if !enqueue_bridge_command_blocking(start_cmd) {
                in_game_replay_active_flag().store(false, Ordering::SeqCst);
                clear_in_game_replay_session_if_matches(&safe_session_id_for_thread);
                return;
            }

            match wait_for_in_game_replay_ready(
                &safe_session_id_for_thread,
                &stop_flag,
                Duration::from_millis(bootstrap.bootstrap_timeout_ms.saturating_add(3000)),
                &bootstrap.ready_policy,
            ) {
                ReplayReadyWaitResult::ReadyOk { reason } => {
                    log::info!(
                        "bridge: in-game replay ready (session={}, reason={reason})",
                        safe_session_id_for_thread
                    );
                }
                ReplayReadyWaitResult::ReadyBestEffort { reason } => {
                    log::warn!(
                        "bridge: in-game replay proceeding best-effort (session={}, reason={reason})",
                        safe_session_id_for_thread
                    );
                }
                ReplayReadyWaitResult::Failed { reason } => {
                    log::warn!(
                        "bridge: in-game replay bootstrap failed (session={}, reason={reason}); aborting stream",
                        safe_session_id_for_thread
                    );
                    let stop_cmd = serde_json::json!({
                        "cmd": "replay_play_stop"
                    })
                    .to_string();
                    let _ = enqueue_bridge_command_blocking(stop_cmd);
                    in_game_replay_active_flag().store(false, Ordering::SeqCst);
                    clear_in_game_replay_session_if_matches(&safe_session_id_for_thread);
                    return;
                }
                ReplayReadyWaitResult::Interrupted { reason } => {
                    log::warn!(
                        "bridge: in-game replay interrupted during bootstrap (session={}, reason={reason}); aborting stream",
                        safe_session_id_for_thread
                    );
                    let stop_cmd = serde_json::json!({
                        "cmd": "replay_play_stop"
                    })
                    .to_string();
                    let _ = enqueue_bridge_command_blocking(stop_cmd);
                    in_game_replay_active_flag().store(false, Ordering::SeqCst);
                    clear_in_game_replay_session_if_matches(&safe_session_id_for_thread);
                    return;
                }
                ReplayReadyWaitResult::TimedOut => {
                    log::warn!(
                        "bridge: in-game replay ready wait timed out (session={}); aborting stream",
                        safe_session_id_for_thread
                    );
                    let stop_cmd = serde_json::json!({
                        "cmd": "replay_play_stop"
                    })
                    .to_string();
                    let _ = enqueue_bridge_command_blocking(stop_cmd);
                    in_game_replay_active_flag().store(false, Ordering::SeqCst);
                    clear_in_game_replay_session_if_matches(&safe_session_id_for_thread);
                    return;
                }
                ReplayReadyWaitResult::Cancelled => {
                    in_game_replay_active_flag().store(false, Ordering::SeqCst);
                    clear_in_game_replay_session_if_matches(&safe_session_id_for_thread);
                    return;
                }
            }
        })
        .map_err(|e| {
            in_game_replay_active_flag().store(false, Ordering::SeqCst);
            clear_in_game_replay_session_if_matches(&safe_session_id);
            format!("failed to spawn in-game replay thread: {e}")
        })?;

    Ok(())
}
