#[derive(Clone, Debug)]
pub struct BridgePresenceState {
    pub game_state_code: i32,
    pub game_state: String,
    pub scenario_name: Option<String>,
    pub scenario_type: Option<String>,
    pub scenario_subtype: Option<String>,
    pub time_remaining_secs: Option<f64>,
    pub queue_time_remaining_secs: Option<f64>,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::BridgePresenceState;
    use serde_json::json;
    use std::fs::OpenOptions;
    use std::io::{self, Write};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const DISCORD_CLIENT_ID: &str = "1162428887066742904";
    const DISCORD_PIPE_PREFIX: &str = r"\\.\pipe\discord-ipc-";
    const MAX_DISCORD_PIPES: u8 = 10;

    struct DiscordIpcClient {
        pipe: std::fs::File,
    }

    impl DiscordIpcClient {
        fn connect() -> io::Result<Self> {
            let mut last_err =
                io::Error::new(io::ErrorKind::NotConnected, "Discord IPC pipe not found");
            for idx in 0..MAX_DISCORD_PIPES {
                let pipe_path = format!("{DISCORD_PIPE_PREFIX}{idx}");
                match OpenOptions::new().read(true).write(true).open(&pipe_path) {
                    Ok(pipe) => {
                        let mut client = Self { pipe };
                        client.send_frame(0, &json!({ "v": 1, "client_id": DISCORD_CLIENT_ID }))?;
                        return Ok(client);
                    }
                    Err(err) => {
                        last_err = err;
                    }
                }
            }
            Err(last_err)
        }

        fn send_frame(&mut self, opcode: i32, payload: &serde_json::Value) -> io::Result<()> {
            let payload = serde_json::to_vec(payload)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
            let mut header = [0u8; 8];
            header[..4].copy_from_slice(&opcode.to_le_bytes());
            header[4..].copy_from_slice(&(payload.len() as i32).to_le_bytes());
            self.pipe.write_all(&header)?;
            self.pipe.write_all(&payload)?;
            self.pipe.flush()?;
            Ok(())
        }
    }

    #[derive(Default)]
    struct RpcState {
        client: Option<DiscordIpcClient>,
        last_signature: Option<String>,
        last_presence: Option<BridgePresenceState>,
        nonce: u64,
    }

    fn rpc_state() -> &'static Mutex<RpcState> {
        static STATE: OnceLock<Mutex<RpcState>> = OnceLock::new();
        STATE.get_or_init(|| Mutex::new(RpcState::default()))
    }

    fn format_countdown(secs: f64) -> String {
        let total = secs.max(0.0).round() as u64;
        let minutes = total / 60;
        let seconds = total % 60;
        format!("{minutes:02}:{seconds:02}")
    }

    fn clean_text(input: &str, max_len: usize) -> String {
        let mut out = String::new();
        for ch in input.chars() {
            if ch.is_control() {
                continue;
            }
            out.push(ch);
            if out.len() >= max_len {
                break;
            }
        }
        out.trim().to_string()
    }

    fn end_timestamp_from_remaining(remaining_secs: Option<f64>) -> Option<u64> {
        let secs = remaining_secs?;
        if !secs.is_finite() || secs <= 0.0 {
            return None;
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
        let delta = Duration::from_secs_f64(secs.max(0.0));
        Some(now.checked_add(delta)?.as_secs())
    }

    fn build_activity(state: &BridgePresenceState) -> serde_json::Value {
        let scenario_name = state
            .scenario_name
            .as_deref()
            .map(|s| clean_text(s, 120))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "KovaaK's Aim Trainer".to_string());

        let family = state
            .scenario_type
            .as_deref()
            .map(|s| clean_text(s, 64))
            .filter(|s| !s.is_empty());
        let subtype = state
            .scenario_subtype
            .as_deref()
            .map(|s| clean_text(s, 64))
            .filter(|s| !s.is_empty());

        let state_line = match state.game_state_code {
            4 => {
                if let Some(remain) = state.time_remaining_secs.filter(|v| *v > 0.0) {
                    format!("Challenge - {} left", format_countdown(remain))
                } else {
                    "In Challenge".to_string()
                }
            }
            3 => "In Freeplay".to_string(),
            2 => {
                if let Some(remain) = state.queue_time_remaining_secs.filter(|v| *v > 0.0) {
                    format!("Queue - {} left", format_countdown(remain))
                } else {
                    "Queued".to_string()
                }
            }
            5 => "Scenario Paused".to_string(),
            6 => "In Scenario Editor".to_string(),
            1 => "Trainer Menu".to_string(),
            _ => {
                let normalized = clean_text(&state.game_state, 64);
                if normalized.is_empty() {
                    "Main Menu".to_string()
                } else {
                    normalized
                }
            }
        };

        let mut detail_line = scenario_name;
        if let Some(kind) = family {
            if let Some(sub) = subtype {
                detail_line = format!("{detail_line} ({kind}: {sub})");
            } else {
                detail_line = format!("{detail_line} ({kind})");
            }
        }
        detail_line = clean_text(&detail_line, 128);

        let mut activity_obj = serde_json::Map::new();
        activity_obj.insert("details".to_string(), json!(detail_line));
        activity_obj.insert("state".to_string(), json!(clean_text(&state_line, 128)));

        let remaining = if state.game_state_code == 2 {
            state.queue_time_remaining_secs
        } else {
            state.time_remaining_secs
        };
        if let Some(end_ts) = end_timestamp_from_remaining(remaining) {
            activity_obj.insert("timestamps".to_string(), json!({ "end": end_ts }));
        }

        serde_json::Value::Object(activity_obj)
    }

    fn send_activity(state: &mut RpcState, activity: &serde_json::Value) -> io::Result<()> {
        if state.client.is_none() {
            state.client = Some(DiscordIpcClient::connect()?);
        }

        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "args": {
                "pid": std::process::id(),
                "activity": activity,
            },
            "nonce": format!("aimmod-rpc-{}", state.nonce),
        });
        state.nonce = state.nonce.wrapping_add(1);

        let result = state
            .client
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotConnected, "missing Discord client"))?
            .send_frame(1, &payload);

        if result.is_err() {
            state.client = None;
        }
        result
    }

    fn try_send_cached_presence(state: &mut RpcState) {
        let Some(presence) = state.last_presence.clone() else {
            return;
        };
        let activity = build_activity(&presence);
        let signature = serde_json::to_string(&activity).unwrap_or_default();
        let sent_ok = if send_activity(state, &activity).is_ok() {
            true
        } else {
            send_activity(state, &activity).is_ok()
        };

        if sent_ok {
            state.last_signature = Some(signature);
        }
    }

    pub fn start() {
        static STARTED: OnceLock<()> = OnceLock::new();
        if STARTED.set(()).is_err() {
            return;
        }

        let _ = std::thread::Builder::new()
            .name("discord-rpc-heartbeat".into())
            .spawn(|| {
                loop {
                    std::thread::sleep(Duration::from_secs(15));
                    let Ok(mut guard) = rpc_state().lock() else {
                        continue;
                    };
                    if guard.client.is_some() && guard.last_signature.is_some() {
                        continue;
                    }
                    try_send_cached_presence(&mut guard);
                }
            });
    }

    pub fn update_presence_from_bridge(state: BridgePresenceState) {
        start();
        let activity = build_activity(&state);
        let signature = serde_json::to_string(&activity).unwrap_or_default();
        let Ok(mut guard) = rpc_state().lock() else {
            return;
        };

        guard.last_presence = Some(state);

        if guard.last_signature.as_ref() == Some(&signature) {
            return;
        }

        let sent_ok = if send_activity(&mut guard, &activity).is_ok() {
            true
        } else {
            send_activity(&mut guard, &activity).is_ok()
        };

        if sent_ok {
            guard.last_signature = Some(signature);
        }
    }
}

#[cfg(target_os = "windows")]
pub fn start() {
    imp::start();
}

#[cfg(not(target_os = "windows"))]
pub fn start() {}

#[cfg(target_os = "windows")]
pub fn update_presence_from_bridge(state: BridgePresenceState) {
    imp::update_presence_from_bridge(state);
}

#[cfg(not(target_os = "windows"))]
pub fn update_presence_from_bridge(_state: BridgePresenceState) {}
