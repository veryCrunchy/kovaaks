#[derive(Clone, Debug)]
pub struct BridgePresenceState {
    pub game_state_code: i32,
    pub game_state: String,
    pub scenario_name: Option<String>,
    pub scenario_type: Option<String>,
    pub scenario_subtype: Option<String>,
    pub score_per_minute: Option<f64>,
    pub accuracy_pct: Option<f64>,
    pub kills: Option<u32>,
    pub elapsed_secs: Option<f64>,
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
    const DISCORD_LARGE_IMAGE_KEY: &str = "https://s.crun.zip/aimmod.png";
    const DISCORD_SMALL_IMAGE_KEY: &str = "https://cdn.discordapp.com/app-icons/1162428887066742904/798981b85db0ce80a8168c1184ef92a2.png?size=1280";
    const AIMMOD_URL: &str = "https://github.com/veryCrunchy/kovaaks";
    const AIMMOD_DISCORD_URL: &str = "https://discord.gg/snwC66wShD";

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

    fn start_timestamp_from_elapsed(elapsed_secs: Option<f64>) -> Option<u64> {
        let secs = elapsed_secs?;
        if !secs.is_finite() || secs <= 0.0 {
            return None;
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
        let delta = Duration::from_secs_f64(secs.max(0.0));
        Some(now.checked_sub(delta)?.as_secs())
    }

    fn fmt_pct(value: f64) -> String {
        format!("{value:.1}%")
    }

    fn fmt_compact_number(value: f64) -> String {
        if value >= 1000.0 {
            format!("{:.1}k", value / 1000.0)
        } else {
            format!("{value:.0}")
        }
    }

    fn semantic_signature(state: &BridgePresenceState) -> String {
        let timer_bucket = if state.game_state_code == 2 {
            state
                .queue_time_remaining_secs
                .map(|v| v.max(0.0).round() as i64)
        } else {
            state.time_remaining_secs.map(|v| v.max(0.0).round() as i64)
        };
        let elapsed_bucket = state.elapsed_secs.map(|v| v.max(0.0).round() as i64);
        format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            state.game_state_code,
            state.game_state.trim(),
            state.scenario_name.as_deref().unwrap_or(""),
            state.scenario_type.as_deref().unwrap_or(""),
            state.scenario_subtype.as_deref().unwrap_or(""),
            state
                .score_per_minute
                .map(|v| v.round() as i64)
                .unwrap_or_default(),
            state
                .accuracy_pct
                .map(|v| (v * 10.0).round() as i64)
                .unwrap_or_default(),
            state.kills.unwrap_or_default(),
            elapsed_bucket.unwrap_or_default(),
            timer_bucket.unwrap_or_default(),
        )
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

        let mut detail_line = scenario_name;
        let mut state_parts: Vec<String> = Vec::new();
        let mut remaining = None;

        match state.game_state_code {
            4 => {
                state_parts.push("In Challenge".to_string());
                remaining = state.time_remaining_secs.filter(|v| *v > 0.0);
            }
            3 => state_parts.push("In Freeplay".to_string()),
            2 => {
                state_parts.push("Queued".to_string());
                remaining = state.queue_time_remaining_secs.filter(|v| *v > 0.0);
            }
            5 => state_parts.push("Scenario Paused".to_string()),
            6 => state_parts.push("In Scenario Editor".to_string()),
            1 => state_parts.push("Trainer Menu".to_string()),
            _ => {
                let normalized = clean_text(&state.game_state, 64);
                state_parts.push(if normalized.is_empty() {
                    "Main Menu".to_string()
                } else {
                    normalized
                });
            }
        }

        if let Some(kind) = family.clone() {
            state_parts.push(kind);
        }
        if let Some(sub) = subtype.clone() {
            state_parts.push(sub);
        }
        if let Some(accuracy) = state.accuracy_pct.filter(|v| v.is_finite() && *v > 0.0) {
            state_parts.push(format!("Acc {}", fmt_pct(accuracy)));
        }
        if let Some(spm) = state.score_per_minute.filter(|v| v.is_finite() && *v > 0.0) {
            state_parts.push(format!("SPM {}", fmt_compact_number(spm)));
        }
        if let Some(kills) = state.kills.filter(|v| *v > 0) {
            state_parts.push(format!("{kills} kills"));
        }
        if let Some(remain) = remaining {
            state_parts.push(format!("{} left", format_countdown(remain)));
        }

        detail_line = clean_text(&detail_line, 128);
        let state_line = clean_text(&state_parts.join(" • "), 128);

        let mut activity_obj = serde_json::Map::new();
        activity_obj.insert("details".to_string(), json!(detail_line));
        activity_obj.insert("state".to_string(), json!(state_line));
        activity_obj.insert(
            "assets".to_string(),
            json!({
                "large_image": DISCORD_LARGE_IMAGE_KEY,
                "large_text": "AimMod",
                "small_image": DISCORD_SMALL_IMAGE_KEY,
                "small_text": "KovaaK's Aim Trainer",
            }),
        );
        activity_obj.insert(
            "buttons".to_string(),
            json!([
                { "label": "AimMod", "url": AIMMOD_URL },
                { "label": "Discord", "url": AIMMOD_DISCORD_URL }
            ]),
        );

        let start_ts = start_timestamp_from_elapsed(state.elapsed_secs);
        let end_ts = end_timestamp_from_remaining(remaining);
        if start_ts.is_some() || end_ts.is_some() {
            let mut timestamps = serde_json::Map::new();
            if let Some(start_ts) = start_ts {
                timestamps.insert("start".to_string(), json!(start_ts));
            }
            if let Some(end_ts) = end_ts {
                timestamps.insert("end".to_string(), json!(end_ts));
            }
            activity_obj.insert(
                "timestamps".to_string(),
                serde_json::Value::Object(timestamps),
            );
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
        let signature = semantic_signature(&presence);
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
        let signature = semantic_signature(&state);
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
