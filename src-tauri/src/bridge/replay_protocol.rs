#[derive(Clone, Debug)]
struct InGameReplayEntityCommand {
    id: String,
    profile: String,
    is_player: bool,
    is_bot: bool,
    x: f64,
    y: f64,
    z: f64,
    pitch: f64,
    yaw: f64,
    roll: f64,
    vx: f64,
    vy: f64,
    vz: f64,
}

#[derive(Clone, Debug)]
struct InGameReplayFrameCommand {
    ts_ms: u64,
    seq: u64,
    upserts: Vec<InGameReplayEntityCommand>,
    removes: Vec<String>,
}

#[derive(Clone, Debug, Default)]
struct InGameReplayBootstrapContext {
    map_name: Option<String>,
    map_scale: Option<f64>,
    hide_ui: bool,
    force_freeplay: bool,
    bootstrap_timeout_ms: u64,
    ready_policy: String,
    status_interval_ms: u64,
    expected_bot_count: Option<u64>,
    expected_bot_profiles: Vec<String>,
}

fn replay_json_boolish(value: &serde_json::Value) -> Option<bool> {
    match value {
        serde_json::Value::Bool(v) => Some(*v),
        serde_json::Value::Number(n) => n.as_f64().map(|v| v >= 0.5),
        serde_json::Value::String(s) => {
            let t = s.trim().to_ascii_lowercase();
            if t == "1" || t == "true" {
                Some(true)
            } else if t == "0" || t == "false" {
                Some(false)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn replay_json_u64(value: &serde_json::Value) -> Option<u64> {
    replay_json_number(value).and_then(|v| {
        if v.is_finite() && v >= 0.0 {
            Some(v.round() as u64)
        } else {
            None
        }
    })
}

fn parse_replay_entity_command(value: &serde_json::Value) -> Option<InGameReplayEntityCommand> {
    let obj = value.as_object()?;
    let id = obj.get("id")?.as_str()?.trim().to_string();
    if id.is_empty() {
        return None;
    }

    let profile = obj
        .get("profile")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let is_player = obj
        .get("is_player")
        .and_then(replay_json_boolish)
        .unwrap_or(false);
    let is_bot = obj.get("is_bot").and_then(replay_json_boolish).unwrap_or(false);

    let location = obj.get("location").and_then(|v| v.as_object())?;
    let rotation = obj.get("rotation").and_then(|v| v.as_object())?;
    let velocity = obj.get("velocity").and_then(|v| v.as_object());

    let x = location.get("x").and_then(replay_json_number).unwrap_or(0.0);
    let y = location.get("y").and_then(replay_json_number).unwrap_or(0.0);
    let z = location.get("z").and_then(replay_json_number).unwrap_or(0.0);
    let pitch = rotation
        .get("pitch")
        .and_then(replay_json_number)
        .unwrap_or(0.0);
    let yaw = rotation
        .get("yaw")
        .and_then(replay_json_number)
        .unwrap_or(0.0);
    let roll = rotation
        .get("roll")
        .and_then(replay_json_number)
        .unwrap_or(0.0);

    let vx = velocity
        .and_then(|v| v.get("x"))
        .and_then(replay_json_number)
        .unwrap_or(0.0);
    let vy = velocity
        .and_then(|v| v.get("y"))
        .and_then(replay_json_number)
        .unwrap_or(0.0);
    let vz = velocity
        .and_then(|v| v.get("z"))
        .and_then(replay_json_number)
        .unwrap_or(0.0);

    Some(InGameReplayEntityCommand {
        id,
        profile,
        is_player,
        is_bot,
        x,
        y,
        z,
        pitch,
        yaw,
        roll,
        vx,
        vy,
        vz,
    })
}

fn parse_replay_frame_command(
    value: &serde_json::Value,
    entity_field: &str,
) -> Option<InGameReplayFrameCommand> {
    let obj = value.as_object()?;
    let ts_ms = obj.get("ts_ms").and_then(replay_json_u64).unwrap_or(0);
    let seq = obj.get("seq").and_then(replay_json_u64).unwrap_or(ts_ms);

    let mut upserts = Vec::new();
    if let Some(entries) = obj.get(entity_field).and_then(|v| v.as_array()) {
        upserts.reserve(entries.len());
        for entry in entries {
            if let Some(entity) = parse_replay_entity_command(entry) {
                upserts.push(entity);
            }
        }
    }

    let mut removes = Vec::new();
    if let Some(entries) = obj.get("remove").and_then(|v| v.as_array()) {
        removes.reserve(entries.len());
        for entry in entries {
            if let Some(id) = entry.as_str() {
                let id = id.trim();
                if !id.is_empty() {
                    removes.push(id.to_string());
                }
            }
        }
    }

    Some(InGameReplayFrameCommand {
        ts_ms,
        seq,
        upserts,
        removes,
    })
}

fn build_in_game_replay_frames(stream: &super::BridgeTickStreamV1) -> Vec<InGameReplayFrameCommand> {
    let mut frames = Vec::with_capacity(stream.keyframes.len() + stream.deltas.len());
    for value in &stream.keyframes {
        if let Some(frame) = parse_replay_frame_command(value, "entities") {
            frames.push(frame);
        }
    }
    for value in &stream.deltas {
        if let Some(frame) = parse_replay_frame_command(value, "upserts") {
            frames.push(frame);
        }
    }
    frames.sort_by_key(|frame| (frame.ts_ms, frame.seq));
    frames
}

fn replay_base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    let mut i = 0usize;
    while i + 3 <= data.len() {
        let b0 = data[i];
        let b1 = data[i + 1];
        let b2 = data[i + 2];
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(TABLE[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize] as char);
        out.push(TABLE[(b2 & 0x3F) as usize] as char);
        i += 3;
    }
    match data.len().saturating_sub(i) {
        1 => {
            let b0 = data[i];
            out.push(TABLE[(b0 >> 2) as usize] as char);
            out.push(TABLE[((b0 & 0x03) << 4) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let b0 = data[i];
            let b1 = data[i + 1];
            out.push(TABLE[(b0 >> 2) as usize] as char);
            out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
            out.push(TABLE[((b1 & 0x0F) << 2) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

fn replay_chunk_push_u16(buf: &mut Vec<u8>, value: u16) {
    buf.extend_from_slice(&value.to_le_bytes());
}

fn replay_chunk_push_u32(buf: &mut Vec<u8>, value: u32) {
    buf.extend_from_slice(&value.to_le_bytes());
}

fn replay_chunk_push_u64(buf: &mut Vec<u8>, value: u64) {
    buf.extend_from_slice(&value.to_le_bytes());
}

fn replay_chunk_push_f32(buf: &mut Vec<u8>, value: f64) {
    let value = if value.is_finite() { value as f32 } else { 0.0 };
    buf.extend_from_slice(&value.to_le_bytes());
}

fn replay_chunk_push_string(buf: &mut Vec<u8>, value: &str) {
    let bytes = value.as_bytes();
    let len = bytes.len().min(u16::MAX as usize);
    replay_chunk_push_u16(buf, len as u16);
    buf.extend_from_slice(&bytes[..len]);
}

fn replay_encode_frame_into_chunk(buf: &mut Vec<u8>, frame: &InGameReplayFrameCommand) {
    replay_chunk_push_u64(buf, frame.ts_ms);
    replay_chunk_push_u64(buf, frame.seq);
    replay_chunk_push_u32(buf, frame.upserts.len() as u32);
    replay_chunk_push_u32(buf, frame.removes.len() as u32);

    for entity in &frame.upserts {
        replay_chunk_push_string(buf, &entity.id);
        replay_chunk_push_string(buf, &entity.profile);
        let mut flags = 0u8;
        if entity.is_player {
            flags |= 0x01;
        }
        if entity.is_bot {
            flags |= 0x02;
        }
        buf.push(flags);
        replay_chunk_push_f32(buf, entity.x);
        replay_chunk_push_f32(buf, entity.y);
        replay_chunk_push_f32(buf, entity.z);
        replay_chunk_push_f32(buf, entity.pitch);
        replay_chunk_push_f32(buf, entity.yaw);
        replay_chunk_push_f32(buf, entity.roll);
        replay_chunk_push_f32(buf, entity.vx);
        replay_chunk_push_f32(buf, entity.vy);
        replay_chunk_push_f32(buf, entity.vz);
    }

    for entity_id in &frame.removes {
        replay_chunk_push_string(buf, entity_id);
    }
}

fn build_in_game_replay_frame_chunks(frames: &[InGameReplayFrameCommand]) -> Vec<String> {
    const MAX_RAW_CHUNK_BYTES: usize = 4096;
    let mut chunks = Vec::new();
    let mut current = Vec::with_capacity(MAX_RAW_CHUNK_BYTES);

    for frame in frames {
        let mut encoded_frame = Vec::new();
        replay_encode_frame_into_chunk(&mut encoded_frame, frame);
        if !current.is_empty() && current.len() + encoded_frame.len() > MAX_RAW_CHUNK_BYTES {
            chunks.push(replay_base64_encode(&current));
            current.clear();
        }
        current.extend_from_slice(&encoded_frame);
    }

    if !current.is_empty() {
        chunks.push(replay_base64_encode(&current));
    }

    chunks
}

fn parse_replay_bootstrap_context(stream: &super::BridgeTickStreamV1) -> InGameReplayBootstrapContext {
    let mut bootstrap = InGameReplayBootstrapContext {
        map_name: None,
        map_scale: None,
        hide_ui: true,
        force_freeplay: true,
        bootstrap_timeout_ms: 12_000,
        ready_policy: "best_effort".to_string(),
        status_interval_ms: 250,
        expected_bot_count: None,
        expected_bot_profiles: Vec::new(),
    };

    if let Some(obj) = stream.context.as_ref().and_then(|v| v.as_object()) {
        if bootstrap.map_name.is_none() {
            if let Some(value) = obj.get("map_name").and_then(|v| v.as_str()) {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    bootstrap.map_name = Some(trimmed.to_string());
                }
            }
        }
        if bootstrap.map_scale.is_none() {
            if let Some(value) = obj.get("map_scale").and_then(replay_json_number) {
                if value.is_finite() && value > 0.0 {
                    bootstrap.map_scale = Some(value);
                }
            }
        }
        if let Some(policy) = obj.get("ready_policy").and_then(|v| v.as_str()) {
            let p = policy.trim().to_ascii_lowercase();
            if p == "strict" || p == "best_effort" {
                bootstrap.ready_policy = p;
            }
        }
        if let Some(v) = obj.get("status_interval_ms").and_then(replay_json_u64) {
            bootstrap.status_interval_ms = v.clamp(50, 5000);
        }
    }

    if bootstrap.map_name.is_none() || bootstrap.map_scale.is_none() {
        for value in &stream.keyframes {
            let Some(frame_obj) = value.as_object() else {
                continue;
            };
            let Some(context_obj) = frame_obj.get("context").and_then(|v| v.as_object()) else {
                continue;
            };

            if bootstrap.map_name.is_none() {
                if let Some(value) = context_obj.get("map_name").and_then(|v| v.as_str()) {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        bootstrap.map_name = Some(trimmed.to_string());
                    }
                }
            }
            if bootstrap.map_scale.is_none() {
                if let Some(value) = context_obj.get("map_scale").and_then(replay_json_number) {
                    if value.is_finite() && value > 0.0 {
                        bootstrap.map_scale = Some(value);
                    }
                }
            }

            if bootstrap.map_name.is_some() && bootstrap.map_scale.is_some() {
                break;
            }
        }
    }

    bootstrap
}

fn derive_replay_bot_expectations(
    frames: &[InGameReplayFrameCommand],
) -> (Option<u64>, Vec<String>) {
    let mut ids: HashSet<String> = HashSet::new();
    let mut profiles: HashSet<String> = HashSet::new();
    for frame in frames {
        for entity in &frame.upserts {
            if !entity.is_bot {
                continue;
            }
            ids.insert(entity.id.clone());
            let profile = entity.profile.trim();
            if !profile.is_empty() {
                profiles.insert(profile.to_string());
            }
        }
    }
    let mut expected_profiles = profiles.into_iter().collect::<Vec<_>>();
    expected_profiles.sort();
    let expected_bot_count = if ids.is_empty() {
        None
    } else {
        Some(ids.len() as u64)
    };
    (expected_bot_count, expected_profiles)
}

fn replay_policy_is_best_effort(policy: &str) -> bool {
    policy.trim().eq_ignore_ascii_case("best_effort")
}
