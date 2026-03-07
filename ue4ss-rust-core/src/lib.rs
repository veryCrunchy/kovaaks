#![allow(clippy::missing_safety_doc)]

mod pipe;

use std::ffi::CStr;
use std::os::raw::c_char;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static EVENT_SEQ: AtomicU64 = AtomicU64::new(1);

fn sanitize_event_name(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == ':' || ch == '-' {
            out.push(ch);
        }
    }
    if out.is_empty() {
        "unknown".to_string()
    } else {
        out
    }
}

fn cstr_opt<'a>(ptr: *const c_char) -> Option<&'a CStr> {
    if ptr.is_null() {
        return None;
    }
    Some(unsafe { CStr::from_ptr(ptr) })
}

fn event_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn contains_json_key(json: &str, key: &str) -> bool {
    json.contains(key)
}

fn stamp_json_payload(json: &str) -> String {
    let trimmed = json.trim();
    if !(trimmed.starts_with('{') && trimmed.ends_with('}')) {
        return json.to_string();
    }

    let has_ts = contains_json_key(trimmed, "\"ts_ms\":");
    let has_seq = contains_json_key(trimmed, "\"seq\":");
    if has_ts && has_seq {
        return trimmed.to_string();
    }

    let ts_ms = event_timestamp_ms();
    let seq = EVENT_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut out = String::with_capacity(trimmed.len() + 48);
    let body = &trimmed[..trimmed.len() - 1];
    out.push_str(body);

    if trimmed.len() > 2 {
        out.push(',');
    }
    if !has_ts {
        out.push_str(&format!("\"ts_ms\":{}", ts_ms));
        if !has_seq {
            out.push(',');
        }
    }
    if !has_seq {
        out.push_str(&format!("\"seq\":{}", seq));
    }
    out.push('}');
    out
}

fn emit_json(json: &str) -> bool {
    let payload = stamp_json_payload(json);
    if !pipe::is_connected() && pipe::connect().is_err() {
        return false;
    }
    pipe::write_event(&payload)
}

fn emit_i32(ev: &str, v: i32) -> bool {
    let ev = sanitize_event_name(ev);
    emit_json(&format!(r#"{{"ev":"{ev}","v":{v}}}"#))
}

fn emit_f32(ev: &str, v: f32) -> bool {
    if !v.is_finite() {
        return false;
    }
    let ev = sanitize_event_name(ev);
    emit_json(&format!(r#"{{"ev":"{ev}","v":{v:.4}}}"#))
}

#[no_mangle]
pub extern "C" fn bridge_init() -> bool {
    pipe::connect().is_ok()
}

#[no_mangle]
pub extern "C" fn bridge_shutdown() {
    pipe::close();
}

#[no_mangle]
pub extern "C" fn bridge_is_connected() -> bool {
    pipe::is_connected()
}

#[no_mangle]
pub extern "C" fn bridge_last_error() -> u32 {
    pipe::last_error()
}

#[no_mangle]
pub extern "C" fn bridge_emit_i32(ev: *const c_char, v: i32) -> bool {
    let Some(ev) = cstr_opt(ev) else {
        return false;
    };
    let Ok(ev) = ev.to_str() else {
        return false;
    };
    emit_i32(ev, v)
}

#[no_mangle]
pub extern "C" fn bridge_emit_f32(ev: *const c_char, v: f32) -> bool {
    let Some(ev) = cstr_opt(ev) else {
        return false;
    };
    let Ok(ev) = ev.to_str() else {
        return false;
    };
    emit_f32(ev, v)
}

#[no_mangle]
pub extern "C" fn bridge_emit_json(json: *const c_char) -> bool {
    let Some(json) = cstr_opt(json) else {
        return false;
    };
    let Ok(json) = json.to_str() else {
        return false;
    };
    emit_json(json)
}

#[no_mangle]
pub extern "C" fn bridge_poll_command(out_json: *mut c_char, out_len: u32) -> i32 {
    if out_json.is_null() || out_len == 0 {
        return -1;
    }

    let out_len = out_len as usize;
    if out_len < 2 {
        return -1;
    }

    let out = unsafe { std::slice::from_raw_parts_mut(out_json as *mut u8, out_len) };
    pipe::poll_command_line(out)
}

#[no_mangle]
pub extern "C" fn bridge_emit_shot_hit(dmg: f32) -> bool {
    if !dmg.is_finite() {
        return false;
    }
    emit_json(&format!(r#"{{"ev":"shot_hit","dmg":{dmg:.4}}}"#))
}

#[no_mangle]
pub extern "C" fn bridge_emit_shot_fired(possible: f32) -> bool {
    if !possible.is_finite() {
        return false;
    }
    emit_json(&format!(r#"{{"ev":"shot_fired","possible":{possible:.4}}}"#))
}

#[no_mangle]
pub extern "C" fn bridge_emit_shot_miss() -> bool {
    emit_json(r#"{"ev":"shot_miss"}"#)
}

#[no_mangle]
pub extern "C" fn bridge_emit_kill() -> bool {
    emit_json(r#"{"ev":"kill"}"#)
}

#[no_mangle]
pub extern "C" fn bridge_emit_challenge_start() -> bool {
    emit_json(r#"{"ev":"challenge_start"}"#)
}

#[no_mangle]
pub extern "C" fn bridge_emit_challenge_queued() -> bool {
    emit_json(r#"{"ev":"challenge_queued"}"#)
}

#[no_mangle]
pub extern "C" fn bridge_emit_challenge_complete() -> bool {
    emit_json(r#"{"ev":"challenge_complete"}"#)
}

#[no_mangle]
pub extern "C" fn bridge_emit_challenge_canceled() -> bool {
    emit_json(r#"{"ev":"challenge_canceled"}"#)
}
