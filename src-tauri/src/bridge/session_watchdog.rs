fn request_state_sync_if_flow_stalled() {
    const RESYNC_STALL_AFTER: Duration = Duration::from_millis(1200);
    const RESYNC_COOLDOWN: Duration = Duration::from_millis(900);

    if in_game_replay_active_flag().load(Ordering::SeqCst) {
        return;
    }

    let should_request = {
        let mut state = bridge_session_state().lock().unwrap();
        if !state.session_active {
            return;
        }

        let now = Instant::now();
        let last_flow = state.last_pull_event_at.or(state.last_stats_flow_at);
        let Some(last_flow) = last_flow else {
            return;
        };

        if now.duration_since(last_flow) < RESYNC_STALL_AFTER {
            return;
        }

        if let Some(last_req) = state.last_state_resync_request_at {
            if now.duration_since(last_req) < RESYNC_COOLDOWN {
                return;
            }
        }
        if state.state_resync_pending {
            return;
        }

        state.last_state_resync_request_at = Some(now);
        state.state_resync_pending = true;
        true
    };

    if should_request {
        if !request_mod_state_sync("bridge:pull_flow_stall") {
            let mut state = bridge_session_state().lock().unwrap();
            state.state_resync_pending = false;
            state.last_state_resync_request_at = None;
        }
    }
}

fn start_session_idle_watchdog() {
    if SESSION_IDLE_WATCHDOG_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::Builder::new()
        .name("bridge-session-idle-watchdog".into())
        .spawn(move || loop {
            request_state_sync_if_flow_stalled();
            std::thread::sleep(SESSION_IDLE_WATCHDOG_TICK);
        })
        .ok();
}
