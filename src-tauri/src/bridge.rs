//! Named-pipe server + UE4SS injector for KovaaK's.
//!
//! On startup the pipe server is created and waits (in a background thread)
//! for the injected DLL to connect.  Once connected it reads newline-delimited
//! JSON and emits each event as a `"bridge-event"` Tauri event.
//!
//! Injection is triggered by the `inject_bridge` Tauri command:
//!   1. Deploy bundled UE4SS payload files into KovaaK's `Binaries/Win64`.
//!   2. Find `FPSAimTrainer-Win64-Shipping.exe` in the process list.
//!   3. `OpenProcess` → `VirtualAllocEx` + `WriteProcessMemory` → `CreateRemoteThread(LoadLibraryW)`.
//!
//! Both the server and injector are no-ops on non-Windows builds.

pub const BRIDGE_EVENT: &str = "bridge-event";
#[cfg(target_os = "windows")]
pub const BRIDGE_PARSED_EVENT: &str = "bridge-parsed-event";
#[cfg(target_os = "windows")]
pub const BRIDGE_METRIC_EVENT: &str = "bridge-metric";
pub const UE4SS_LOG_EVENT: &str = "ue4ss-log-line";
const INJECTION_DEFERRED_ERROR_PREFIX: &str = "KovaaK's process is not ready for injection";
#[cfg(target_os = "windows")]
const EVENT_STATS_PANEL_UPDATE: &str = "stats-panel-update";
#[cfg(target_os = "windows")]
const EVENT_SESSION_START: &str = "session-start";
#[cfg(target_os = "windows")]
const EVENT_SESSION_END: &str = "session-end";
#[cfg(target_os = "windows")]
const EVENT_CHALLENGE_START: &str = "challenge-start";
#[cfg(target_os = "windows")]
const EVENT_CHALLENGE_END: &str = "challenge-end";

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, serde::Serialize)]
pub struct BridgeParsedEvent {
    pub ev: String,
    pub value: Option<f64>,
    pub total: Option<f64>,
    pub delta: Option<f64>,
    pub field: Option<String>,
    pub source: Option<String>,
    pub method: Option<String>,
    pub origin: Option<String>,
    pub origin_flag: Option<String>,
    pub fn_name: Option<String>,
    pub receiver: Option<String>,
    pub raw: String,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, serde::Serialize, PartialEq)]
struct BridgeStatsPanelEvent {
    session_time_secs: Option<f64>,
    kills: Option<u32>,
    kps: Option<f64>,
    accuracy_hits: Option<u32>,
    accuracy_shots: Option<u32>,
    accuracy_pct: Option<f64>,
    damage_dealt: Option<f64>,
    damage_total: Option<f64>,
    spm: Option<f64>,
    ttk_secs: Option<f64>,
    challenge_seconds_total: Option<f64>,
    challenge_time_length: Option<f64>,
    challenge_tick_count_total: Option<u32>,
    challenge_average_fps: Option<f64>,
    random_sens_scale: Option<f64>,
    time_remaining: Option<f64>,
    queue_time_remaining: Option<f64>,
    is_in_challenge: Option<bool>,
    is_in_scenario: Option<bool>,
    is_in_scenario_editor: Option<bool>,
    is_in_trainer: Option<bool>,
    scenario_is_paused: Option<bool>,
    scenario_is_enabled: Option<bool>,
    scenario_play_type: Option<i32>,
    game_state_code: i32,
    game_state: String,
    scenario_name: Option<String>,
    scenario_type: String,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct BridgeTickStreamV1 {
    pub sample_hz: Option<u32>,
    pub keyframe_interval_ms: Option<u32>,
    pub context: Option<serde_json::Value>,
    pub keyframes: Vec<serde_json::Value>,
    pub deltas: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct BridgeRunEventCounts {
    pub shot_fired_events: u32,
    pub shot_hit_events: u32,
    pub kill_events: u32,
    pub challenge_queued_events: u32,
    pub challenge_start_events: u32,
    pub challenge_end_events: u32,
    pub challenge_complete_events: u32,
    pub challenge_canceled_events: u32,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct BridgeRunTimelinePoint {
    pub t_sec: u32,
    pub score_per_minute: Option<f64>,
    pub kills_per_second: Option<f64>,
    pub accuracy_pct: Option<f64>,
    pub damage_efficiency: Option<f64>,
    pub score_total: Option<f64>,
    pub score_total_derived: Option<f64>,
    pub kills: Option<f64>,
    pub shots_fired: Option<f64>,
    pub shots_hit: Option<f64>,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct BridgeRunSnapshot {
    pub duration_secs: Option<f64>,
    pub score_total: Option<f64>,
    pub score_total_derived: Option<f64>,
    pub score_per_minute: Option<f64>,
    pub shots_fired: Option<f64>,
    pub shots_hit: Option<f64>,
    pub kills: Option<f64>,
    pub kills_per_second: Option<f64>,
    pub damage_done: Option<f64>,
    pub damage_possible: Option<f64>,
    pub damage_efficiency: Option<f64>,
    pub accuracy_pct: Option<f64>,
    pub peak_score_per_minute: Option<f64>,
    pub peak_kills_per_second: Option<f64>,
    #[serde(default)]
    pub paired_shot_hits: u32,
    #[serde(default)]
    pub avg_fire_to_hit_ms: Option<f64>,
    #[serde(default)]
    pub p90_fire_to_hit_ms: Option<f64>,
    #[serde(default)]
    pub avg_shots_to_hit: Option<f64>,
    #[serde(default)]
    pub corrective_shot_ratio: Option<f64>,
    pub started_at_unix_ms: Option<u64>,
    pub ended_at_unix_ms: Option<u64>,
    pub event_counts: BridgeRunEventCounts,
    pub timeline: Vec<BridgeRunTimelinePoint>,
    #[serde(default)]
    pub tick_stream_v1: Option<BridgeTickStreamV1>,
}

#[cfg(target_os = "windows")]
fn parse_bridge_payload(raw: &str) -> Option<BridgeParsedEvent> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = parsed.as_object()?;
    let raw_ev = obj.get("ev")?.as_str()?.trim();
    let mut ev = raw_ev.to_string();
    if ev.is_empty() {
        return None;
    }
    // Treat pull_source as the underlying pull metric so downstream consumers
    // can use the non-null working paths directly.
    if raw_ev == "pull_source" {
        if let Some(metric) = parse_payload_string(obj, "metric") {
            let m = metric.trim();
            if m.starts_with("pull_") {
                ev = m.to_string();
            }
        }
    }
    let source = parse_payload_string(obj, "source")
        .or_else(|| parse_payload_string(obj, "src"))
        .or_else(|| parse_payload_string(obj, "fn"))
        .or_else(|| parse_payload_string(obj, "receiver"));
    Some(BridgeParsedEvent {
        ev,
        // Support both legacy and compact payload keys emitted by the mod.
        value: parse_payload_number(obj, "value").or_else(|| parse_payload_number(obj, "v")),
        total: parse_payload_number(obj, "total").or_else(|| parse_payload_number(obj, "t")),
        delta: parse_payload_number(obj, "delta").or_else(|| parse_payload_number(obj, "d")),
        field: parse_payload_string(obj, "field"),
        source,
        method: parse_payload_string(obj, "method"),
        origin: parse_payload_string(obj, "origin"),
        origin_flag: parse_payload_string(obj, "origin_flag"),
        fn_name: parse_payload_string(obj, "fn"),
        receiver: parse_payload_string(obj, "receiver"),
        raw: raw.to_string(),
    })
}

#[cfg(target_os = "windows")]
fn parse_payload_number(
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<f64> {
    match obj.get(key) {
        Some(serde_json::Value::Number(n)) => n.as_f64(),
        Some(serde_json::Value::String(s)) => s.parse::<f64>().ok(),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn parse_payload_string(
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    obj.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

#[cfg(target_os = "windows")]
fn is_metric_event_name(ev: &str) -> bool {
    if ev.starts_with("ui_") {
        return false;
    }
    ev.starts_with("pull_")
        || ev.starts_with("derived_")
        || ev.starts_with("shot_")
        || ev.starts_with("challenge_")
        || ev == "is_in_challenge"
        || ev == "queue_time_remaining"
        || ev == "score_source"
        || ev == "qrem"
        || ev == "ch"
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeFlagState {
    pub profile: String,
    pub enable_pe_hook: bool,
    pub disable_pe_hook: bool,
    pub discovery: bool,
    pub safe_mode: bool,
    pub no_rust: bool,
    pub log_all_events: bool,
    pub object_debug: bool,
    pub non_ui_probe: bool,
    pub ui_counter_fallback: bool,
    pub score_ui_fallback: bool,
    pub hook_process_internal: bool,
    pub hook_process_local_script: bool,
    pub class_probe_hooks: bool,
    pub class_probe_scalar_reads: bool,
    pub class_probe_scan_all: bool,
    pub allow_unsafe_hooks: bool,
    pub native_hooks: bool,
    pub hook_process_event: bool,
    pub detour_callbacks: bool,
    pub direct_pull_invoke: bool,
    pub experimental_runtime: bool,
    pub ui_settext_hook: bool,
    pub ui_widget_probe: bool,
    pub in_game_overlay: bool,
}

// ─── Windows implementation ───────────────────────────────────────────────────

#[cfg(target_os = "windows")]
#[allow(unsafe_op_in_unsafe_fn)]
mod imp {
    use super::BridgeStatsPanelEvent;
    use std::collections::{HashSet, VecDeque};
    use std::ffi::OsStr;
    use std::io::{Read, Seek, SeekFrom};
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use tauri::{AppHandle, Emitter};

    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, HWND, LPARAM};
    use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
    use windows::Win32::System::Diagnostics::Debug::WriteProcessMemory;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, MODULEENTRY32W, Module32FirstW, Module32NextW, PROCESSENTRY32W,
        Process32FirstW, Process32NextW, TH32CS_SNAPMODULE, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows::Win32::System::Memory::{
        MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE, VirtualAllocEx, VirtualFreeEx,
    };
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
        PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    use windows::Win32::System::Threading::{
        CreateRemoteThread, GetProcessTimes, OpenProcess, PROCESS_ALL_ACCESS,
        PROCESS_QUERY_LIMITED_INFORMATION, WaitForSingleObject,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
        VIRTUAL_KEY, VK_CONTROL,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GetWindow, GetWindowThreadProcessId, IsWindowVisible, SW_RESTORE,
        SetForegroundWindow, ShowWindow,
    };
    use windows::core::{BOOL, PCSTR};

    static STARTED: AtomicBool = AtomicBool::new(false);
    static COMMAND_PIPE_STARTED: AtomicBool = AtomicBool::new(false);
    static LOG_TAILER_STARTED: AtomicBool = AtomicBool::new(false);
    static SESSION_IDLE_WATCHDOG_STARTED: AtomicBool = AtomicBool::new(false);
    static LOG_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
    const GAME_EXE: &str = "FPSAimTrainer-Win64-Shipping.exe";
    const UE4SS_DLL: &str = "UE4SS.dll";
    const PAYLOAD_MANIFEST_FILE: &str = ".kovaaks_overlay_payload_manifest.txt";
    const PAYLOAD_PROFILE_FILE: &str = ".kovaaks_overlay_profile";
    const PAYLOAD_DEPLOY_INFO_FILE: &str = ".kovaaks_overlay_deploy_info.txt";
    const IN_GAME_OVERLAY_DIST_DIR: &str = "dist";
    const IN_GAME_OVERLAY_TARGET_DIR: &str = "aimmod_overlay";
    const IN_GAME_OVERLAY_INDEX_FILE: &str = "index.html";
    const IN_GAME_OVERLAY_URL_FILE: &str = "kovaaks_in_game_overlay_url.txt";
    const COMMAND_PIPE_NAME: &str = "\\\\.\\pipe\\kovaaks-bridge-cmd";
    const LOG_RING_CAPACITY: usize = 1200;
    const MAX_BRIDGE_COMMAND_QUEUE: usize = 8192;
    const SESSION_IDLE_PAUSE_AFTER: Duration = Duration::from_millis(1800);
    const SESSION_IDLE_WATCHDOG_TICK: Duration = Duration::from_millis(300);
    const EARLY_SESSION_END_GUARD: Duration = Duration::from_millis(2500);
    const INJECTION_MIN_PROCESS_AGE: Duration = Duration::from_secs(5);
    // ERROR_PIPE_CONNECTED HRESULT (client connected before ConnectNamedPipe — still OK)
    const ERROR_PIPE_CONNECTED_HRESULT: i32 = 0x80070217u32 as i32;

    fn sanitize_state_request_reason(reason: &str) -> String {
        let mut out = String::with_capacity(reason.len());
        for ch in reason.chars() {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | ':' | '.') {
                out.push(ch);
            }
        }
        if out.is_empty() {
            "unknown".to_string()
        } else {
            out
        }
    }

    fn bridge_command_queue() -> &'static Mutex<VecDeque<String>> {
        static QUEUE: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
        QUEUE.get_or_init(|| Mutex::new(VecDeque::with_capacity(MAX_BRIDGE_COMMAND_QUEUE)))
    }

    fn in_game_replay_stop_flag() -> &'static Mutex<Option<Arc<AtomicBool>>> {
        static STOP_FLAG: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();
        STOP_FLAG.get_or_init(|| Mutex::new(None))
    }

    fn in_game_replay_active_flag() -> &'static AtomicBool {
        static ACTIVE: AtomicBool = AtomicBool::new(false);
        &ACTIVE
    }

    fn in_game_replay_session_id_slot() -> &'static Mutex<Option<String>> {
        static SESSION_ID: OnceLock<Mutex<Option<String>>> = OnceLock::new();
        SESSION_ID.get_or_init(|| Mutex::new(None))
    }

    fn bridge_dll_connected_flag() -> &'static AtomicBool {
        static CONNECTED: AtomicBool = AtomicBool::new(false);
        &CONNECTED
    }

    fn mark_bridge_dll_connected(connected: bool) {
        bridge_dll_connected_flag().store(connected, Ordering::SeqCst);
        if connected {
            return;
        }
        if let Ok(slot) = in_game_replay_stop_flag().lock() {
            if let Some(flag) = slot.as_ref() {
                flag.store(true, Ordering::SeqCst);
            }
        }
        if let Ok(mut slot) = in_game_replay_session_id_slot().lock() {
            *slot = None;
        }
        in_game_replay_active_flag().store(false, Ordering::SeqCst);
    }

    fn filetime_to_unix_duration(value: FILETIME) -> Option<Duration> {
        const WINDOWS_TO_UNIX_EPOCH_100NS: u64 = 116_444_736_000_000_000;
        let ticks_100ns = ((value.dwHighDateTime as u64) << 32) | u64::from(value.dwLowDateTime);
        if ticks_100ns < WINDOWS_TO_UNIX_EPOCH_100NS {
            return None;
        }
        let unix_100ns = ticks_100ns - WINDOWS_TO_UNIX_EPOCH_100NS;
        let secs = unix_100ns / 10_000_000;
        let nanos = ((unix_100ns % 10_000_000) * 100) as u32;
        Some(Duration::new(secs, nanos))
    }

    fn process_age(pid: u32) -> Option<Duration> {
        let proc = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let result =
            unsafe { GetProcessTimes(proc, &mut created, &mut exited, &mut kernel, &mut user) };
        let _ = unsafe { CloseHandle(proc) };
        if result.is_err() {
            return None;
        }

        let created_at = filetime_to_unix_duration(created)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?;
        now.checked_sub(created_at)
    }

    fn ensure_game_ready_for_injection(pid: u32) -> Result<(), String> {
        if find_main_window_for_pid(pid).is_none() {
            return Err(format!(
                "{}: waiting for KovaaK's main window",
                super::INJECTION_DEFERRED_ERROR_PREFIX
            ));
        }

        if let Some(age) = process_age(pid) {
            if age < INJECTION_MIN_PROCESS_AGE {
                return Err(format!(
                    "{}: waiting for process warmup (pid {pid}, age={} ms)",
                    super::INJECTION_DEFERRED_ERROR_PREFIX,
                    age.as_millis()
                ));
            }
        }

        Ok(())
    }

    fn enqueue_bridge_command(json_line: String) -> bool {
        if json_line.trim().is_empty() {
            return true;
        }
        if let Ok(mut queue) = bridge_command_queue().lock() {
            if queue.len() >= MAX_BRIDGE_COMMAND_QUEUE {
                return false;
            }
            queue.push_back(json_line);
            return true;
        }
        false
    }

    fn enqueue_bridge_command_blocking(json_line: String) -> bool {
        if json_line.trim().is_empty() {
            return true;
        }
        let mut retries = 0u32;
        loop {
            if enqueue_bridge_command(json_line.clone()) {
                return true;
            }
            retries = retries.saturating_add(1);
            if retries >= 2000 {
                log::warn!("bridge: command queue saturated; dropping command after retries");
                return false;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn request_mod_state_sync(reason: &str) {
        let reason = sanitize_state_request_reason(reason);
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let cmd = format!(
            "{{\"cmd\":\"state_snapshot_request\",\"reason\":\"{}\",\"ts_ms\":{}}}",
            reason, now_ms
        );
        let _ = enqueue_bridge_command(cmd);
        log::info!("bridge: queued mod state sync request ({})", reason);
    }

    include!("bridge/replay_protocol.rs");
    include!("bridge/replay_handshake.rs");
    include!("bridge/replay_streamer.rs");

    #[derive(Clone, Debug)]
    struct BridgeCompatState {
        stats: super::BridgeStatsPanelEvent,
        last_nonzero_spm: Option<Instant>,
        last_nonzero_damage_done: Option<Instant>,
        last_nonzero_damage_total: Option<Instant>,
        last_nonzero_seconds: Option<Instant>,
        last_nonzero_score_total: Option<Instant>,
        score_metric_total: Option<f64>,
        score_total_derived: Option<f64>,
    }

    #[derive(Clone, Debug, Default)]
    struct BridgeSessionState {
        session_active: bool,
        challenge_active: bool,
        session_started_at: Option<Instant>,
        recovery_start_streak: u8,
        tracking_paused_by_idle: bool,
        last_stats_flow_at: Option<Instant>,
        last_pull_event_at: Option<Instant>,
        last_state_resync_request_at: Option<Instant>,
        state_resync_pending: bool,
    }

    #[derive(Clone, Debug, Default)]
    struct ChallengeHookState {
        stable: Option<bool>,
        candidate: Option<bool>,
        candidate_count: u8,
    }

    #[derive(Copy, Clone, Debug, Eq, PartialEq)]
    enum ChallengeTransition {
        None,
        Entered,
        Exited,
    }

    const MAX_RUN_TIMELINE_POINTS: usize = 1800;
    const MAX_PENDING_SHOT_EVENTS: usize = 4096;
    const MAX_SHOT_LATENCY_SAMPLES: usize = 8192;
    const MAX_TICK_STREAM_KEYFRAMES: usize = 12000;
    const MAX_TICK_STREAM_DELTAS: usize = 72000;
    const RUN_CAPTURE_HINT_REALIGN_THRESHOLD_SECS: f64 = 1.25;

    #[derive(Clone, Debug, Default)]
    struct RunCaptureMetrics {
        duration_secs: Option<f64>,
        score_total: Option<f64>,
        score_total_derived: Option<f64>,
        score_per_minute: Option<f64>,
        shots_fired: Option<f64>,
        shots_hit: Option<f64>,
        kills: Option<f64>,
        kills_per_second: Option<f64>,
        damage_done: Option<f64>,
        damage_possible: Option<f64>,
        damage_efficiency: Option<f64>,
        accuracy_pct: Option<f64>,
    }

    #[derive(Clone, Debug, Default)]
    struct RunCaptureState {
        started_at: Option<Instant>,
        started_at_unix_ms: Option<u64>,
        ended_at_unix_ms: Option<u64>,
        duration_from_challenge_secs: bool,
        metrics: RunCaptureMetrics,
        peak_score_per_minute: Option<f64>,
        peak_kills_per_second: Option<f64>,
        pending_shot_times: VecDeque<Instant>,
        shot_to_hit_latencies_ms: Vec<f64>,
        paired_shot_hits: u32,
        shots_since_last_hit: u32,
        total_shots_to_hit: u64,
        corrective_hits: u32,
        event_counts: super::BridgeRunEventCounts,
        timeline: Vec<super::BridgeRunTimelinePoint>,
        tick_stream_v1: super::BridgeTickStreamV1,
    }

    fn run_capture_state() -> &'static Mutex<RunCaptureState> {
        static STATE: OnceLock<Mutex<RunCaptureState>> = OnceLock::new();
        STATE.get_or_init(|| Mutex::new(RunCaptureState::default()))
    }

    fn unix_now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn finite_non_negative(v: Option<f64>) -> Option<f64> {
        match v {
            Some(n) if n.is_finite() && n >= 0.0 => Some(n),
            _ => None,
        }
    }

    fn percentile_from_sorted(sorted: &[f64], p: f64) -> Option<f64> {
        if sorted.is_empty() {
            return None;
        }
        let pp = p.clamp(0.0, 100.0);
        let idx = ((sorted.len() - 1) as f64 * (pp / 100.0)).round() as usize;
        sorted.get(idx).copied()
    }

    fn observe_shot_fired_for_recovery(state: &mut RunCaptureState, count: u32) {
        if count == 0 {
            return;
        }
        let now = Instant::now();
        for _ in 0..count {
            state.pending_shot_times.push_back(now);
        }
        state.shots_since_last_hit = state.shots_since_last_hit.saturating_add(count);

        if state.pending_shot_times.len() > MAX_PENDING_SHOT_EVENTS {
            let trim = state.pending_shot_times.len() - MAX_PENDING_SHOT_EVENTS;
            for _ in 0..trim {
                let _ = state.pending_shot_times.pop_front();
            }
        }
    }

    fn observe_shot_hit_for_recovery(state: &mut RunCaptureState, count: u32) {
        if count == 0 {
            return;
        }
        let now = Instant::now();

        for idx in 0..count {
            if let Some(fired_at) = state.pending_shot_times.pop_front() {
                let dt = now.duration_since(fired_at).as_secs_f64() * 1000.0;
                if dt.is_finite() && dt >= 0.0 {
                    state.shot_to_hit_latencies_ms.push(dt);
                }
            }

            let shots_used = if idx == 0 {
                state.shots_since_last_hit.max(1)
            } else {
                1
            };
            if shots_used > 1 {
                state.corrective_hits = state.corrective_hits.saturating_add(1);
            }
            state.total_shots_to_hit = state.total_shots_to_hit.saturating_add(shots_used as u64);
            state.paired_shot_hits = state.paired_shot_hits.saturating_add(1);
        }

        state.shots_since_last_hit = 0;

        if state.shot_to_hit_latencies_ms.len() > MAX_SHOT_LATENCY_SAMPLES {
            let trim = state.shot_to_hit_latencies_ms.len() - MAX_SHOT_LATENCY_SAMPLES;
            state.shot_to_hit_latencies_ms.drain(0..trim);
        }
    }

    fn begin_run_capture_locked(
        state: &mut RunCaptureState,
        now: Instant,
        start_secs: Option<f64>,
    ) {
        let start_secs = finite_non_negative(start_secs);
        let start_instant = start_secs
            .and_then(|s| now.checked_sub(Duration::from_secs_f64(s)))
            .unwrap_or(now);
        let now_ms = unix_now_ms();
        let start_ms = start_secs
            .map(|s| now_ms.saturating_sub((s * 1000.0).round().max(0.0) as u64))
            .unwrap_or(now_ms);

        state.started_at = Some(start_instant);
        state.started_at_unix_ms = Some(start_ms);
        state.ended_at_unix_ms = None;
        state.duration_from_challenge_secs = false;
        state.metrics = RunCaptureMetrics::default();
        state.peak_score_per_minute = None;
        state.peak_kills_per_second = None;
        state.pending_shot_times.clear();
        state.shot_to_hit_latencies_ms.clear();
        state.paired_shot_hits = 0;
        state.shots_since_last_hit = 0;
        state.total_shots_to_hit = 0;
        state.corrective_hits = 0;
        state.event_counts = super::BridgeRunEventCounts::default();
        state.timeline.clear();
        state.tick_stream_v1 = super::BridgeTickStreamV1::default();
    }

    fn align_run_capture_start_with_hint_locked(
        state: &mut RunCaptureState,
        now: Instant,
        time_hint_secs: Option<f64>,
    ) {
        let Some(hint_secs) = finite_non_negative(time_hint_secs) else {
            return;
        };
        let hinted_start = now
            .checked_sub(Duration::from_secs_f64(hint_secs))
            .unwrap_or(now);
        let hinted_start_ms = unix_now_ms().saturating_sub((hint_secs * 1000.0).round() as u64);

        match state.started_at {
            None => {
                state.started_at = Some(hinted_start);
                state.started_at_unix_ms = Some(hinted_start_ms);
            }
            Some(started_at) => {
                let elapsed_secs = now.duration_since(started_at).as_secs_f64();
                if (elapsed_secs - hint_secs).abs() > RUN_CAPTURE_HINT_REALIGN_THRESHOLD_SECS {
                    state.started_at = Some(hinted_start);
                    state.started_at_unix_ms = Some(hinted_start_ms);
                }
            }
        }
    }

    fn ensure_run_capture_started_locked(state: &mut RunCaptureState, time_hint_secs: Option<f64>) {
        let now = Instant::now();
        if state.started_at.is_none() {
            begin_run_capture_locked(state, now, time_hint_secs);
        } else {
            align_run_capture_start_with_hint_locked(state, now, time_hint_secs);
        }
    }

    fn run_capture_time_secs(state: &RunCaptureState, time_hint_secs: Option<f64>) -> Option<f64> {
        if let Some(hint) = finite_non_negative(time_hint_secs) {
            return Some(hint);
        }
        if let Some(d) = finite_non_negative(state.metrics.duration_secs) {
            return Some(d);
        }
        state.started_at.map(|t0| t0.elapsed().as_secs_f64())
    }

    fn run_capture_has_data(state: &RunCaptureState) -> bool {
        if !state.timeline.is_empty() {
            return true;
        }
        if state.event_counts.shot_fired_events > 0
            || state.event_counts.shot_hit_events > 0
            || state.event_counts.kill_events > 0
            || state.event_counts.challenge_queued_events > 0
            || state.event_counts.challenge_start_events > 0
            || state.event_counts.challenge_end_events > 0
            || state.event_counts.challenge_complete_events > 0
            || state.event_counts.challenge_canceled_events > 0
        {
            return true;
        }
        state.metrics.duration_secs.is_some()
            || state.metrics.score_total.is_some()
            || state.metrics.score_total_derived.is_some()
            || state.metrics.score_per_minute.is_some()
            || state.metrics.shots_fired.is_some()
            || state.metrics.shots_hit.is_some()
            || state.metrics.kills.is_some()
            || state.metrics.kills_per_second.is_some()
            || state.metrics.damage_done.is_some()
            || state.metrics.damage_possible.is_some()
            || state.metrics.damage_efficiency.is_some()
            || state.metrics.accuracy_pct.is_some()
            || state.tick_stream_v1.context.is_some()
            || !state.tick_stream_v1.keyframes.is_empty()
            || !state.tick_stream_v1.deltas.is_empty()
    }

    fn record_run_timeline_point_locked(state: &mut RunCaptureState, time_hint_secs: Option<f64>) {
        ensure_run_capture_started_locked(state, time_hint_secs);

        let Some(t_sec_f64) = run_capture_time_secs(state, time_hint_secs) else {
            return;
        };
        let t_sec = t_sec_f64.max(0.0).floor() as u32;

        let computed_accuracy = match (state.metrics.shots_hit, state.metrics.shots_fired) {
            (Some(hits), Some(shots)) if shots > 0.0 => Some((hits / shots) * 100.0),
            _ => None,
        };
        let computed_damage_eff = match (state.metrics.damage_done, state.metrics.damage_possible) {
            (Some(done), Some(possible)) if possible > 0.0 => Some((done / possible) * 100.0),
            _ => None,
        };

        let next = super::BridgeRunTimelinePoint {
            t_sec,
            score_per_minute: state.metrics.score_per_minute,
            kills_per_second: state.metrics.kills_per_second,
            accuracy_pct: state.metrics.accuracy_pct.or(computed_accuracy),
            damage_efficiency: state.metrics.damage_efficiency.or(computed_damage_eff),
            score_total: state.metrics.score_total,
            score_total_derived: state.metrics.score_total_derived,
            kills: state.metrics.kills,
            shots_fired: state.metrics.shots_fired,
            shots_hit: state.metrics.shots_hit,
        };

        if let Some(last) = state.timeline.last_mut() {
            if last.t_sec == t_sec {
                last.score_per_minute = next.score_per_minute.or(last.score_per_minute);
                last.kills_per_second = next.kills_per_second.or(last.kills_per_second);
                last.accuracy_pct = next.accuracy_pct.or(last.accuracy_pct);
                last.damage_efficiency = next.damage_efficiency.or(last.damage_efficiency);
                last.score_total = next.score_total.or(last.score_total);
                last.score_total_derived = next.score_total_derived.or(last.score_total_derived);
                last.kills = next.kills.or(last.kills);
                last.shots_fired = next.shots_fired.or(last.shots_fired);
                last.shots_hit = next.shots_hit.or(last.shots_hit);
                return;
            }
        }

        state.timeline.push(next);
        if state.timeline.len() > MAX_RUN_TIMELINE_POINTS {
            let trim = state.timeline.len() - MAX_RUN_TIMELINE_POINTS;
            state.timeline.drain(0..trim);
        }
    }

    fn observe_run_stats_snapshot(stats: &BridgeStatsPanelEvent) {
        let Ok(mut state) = run_capture_state().lock() else {
            return;
        };

        let challenge_secs = finite_non_negative(stats.challenge_seconds_total);
        let session_secs = finite_non_negative(stats.session_time_secs);
        if let Some(value) = challenge_secs {
            state.metrics.duration_secs = Some(value);
            state.duration_from_challenge_secs = true;
        } else if !state.duration_from_challenge_secs {
            state.metrics.duration_secs = session_secs;
        }
        state.metrics.kills = stats.kills.map(|v| v as f64);
        state.metrics.kills_per_second = finite_non_negative(stats.kps);
        state.metrics.shots_hit = stats.accuracy_hits.map(|v| v as f64);
        state.metrics.shots_fired = stats.accuracy_shots.map(|v| v as f64);
        state.metrics.accuracy_pct = finite_non_negative(stats.accuracy_pct);
        state.metrics.damage_done = finite_non_negative(stats.damage_dealt);
        state.metrics.damage_possible = finite_non_negative(stats.damage_total);
        state.metrics.score_per_minute = finite_non_negative(stats.spm);

        if let Some(spm) = state.metrics.score_per_minute {
            state.peak_score_per_minute = Some(
                state
                    .peak_score_per_minute
                    .map_or(spm, |prev| prev.max(spm)),
            );
        }
        if let Some(kps) = state.metrics.kills_per_second {
            state.peak_kills_per_second = Some(
                state
                    .peak_kills_per_second
                    .map_or(kps, |prev| prev.max(kps)),
            );
        }

        let duration_hint = state.metrics.duration_secs;
        record_run_timeline_point_locked(&mut state, duration_hint);
    }

    fn observe_run_metric_event(parsed: &super::BridgeParsedEvent) {
        let Ok(mut state) = run_capture_state().lock() else {
            return;
        };

        let mut should_record = false;
        let mut time_hint_secs = None;

        match parsed.ev.as_str() {
            "session_start" | "challenge_start" | "scenario_start" => {
                let duration_hint = state.metrics.duration_secs;
                ensure_run_capture_started_locked(&mut state, duration_hint);
                state.event_counts.challenge_start_events =
                    state.event_counts.challenge_start_events.saturating_add(1);
            }
            "challenge_queued" => {
                let duration_hint = state.metrics.duration_secs;
                ensure_run_capture_started_locked(&mut state, duration_hint);
                state.event_counts.challenge_queued_events =
                    state.event_counts.challenge_queued_events.saturating_add(1);
            }
            "challenge_end" | "scenario_end" => {
                let duration_hint = state.metrics.duration_secs;
                ensure_run_capture_started_locked(&mut state, duration_hint);
                state.event_counts.challenge_end_events =
                    state.event_counts.challenge_end_events.saturating_add(1);
            }
            "challenge_complete" | "challenge_completed" | "post_challenge_complete" => {
                let duration_hint = state.metrics.duration_secs;
                ensure_run_capture_started_locked(&mut state, duration_hint);
                state.event_counts.challenge_complete_events = state
                    .event_counts
                    .challenge_complete_events
                    .saturating_add(1);
            }
            "challenge_canceled" | "challenge_quit" => {
                let duration_hint = state.metrics.duration_secs;
                ensure_run_capture_started_locked(&mut state, duration_hint);
                state.event_counts.challenge_canceled_events = state
                    .event_counts
                    .challenge_canceled_events
                    .saturating_add(1);
            }
            _ => {}
        }

        if parsed.ev == "shot_fired" {
            let duration_hint = state.metrics.duration_secs;
            ensure_run_capture_started_locked(&mut state, duration_hint);
            let inc = finite_non_negative(parsed.delta)
                .map(|v| v.round().max(1.0) as u32)
                .unwrap_or(1);
            state.event_counts.shot_fired_events =
                state.event_counts.shot_fired_events.saturating_add(inc);
            observe_shot_fired_for_recovery(&mut state, inc);
            should_record = true;
        } else if parsed.ev == "shot_hit" {
            let duration_hint = state.metrics.duration_secs;
            ensure_run_capture_started_locked(&mut state, duration_hint);
            let inc = finite_non_negative(parsed.delta)
                .map(|v| v.round().max(1.0) as u32)
                .unwrap_or(1);
            state.event_counts.shot_hit_events =
                state.event_counts.shot_hit_events.saturating_add(inc);
            observe_shot_hit_for_recovery(&mut state, inc);
            should_record = true;
        } else if parsed.ev == "kill" {
            let duration_hint = state.metrics.duration_secs;
            ensure_run_capture_started_locked(&mut state, duration_hint);
            let inc = finite_non_negative(parsed.delta)
                .map(|v| v.round().max(1.0) as u32)
                .unwrap_or(1);
            state.event_counts.kill_events = state.event_counts.kill_events.saturating_add(inc);
            should_record = true;
        }

        if let Some(total) = finite_non_negative(parsed.total) {
            match parsed.ev.as_str() {
                "shot_fired" => {
                    state.metrics.shots_fired = Some(total);
                    should_record = true;
                }
                "shot_hit" => {
                    state.metrics.shots_hit = Some(total);
                    should_record = true;
                }
                "kill" => {
                    state.metrics.kills = Some(total);
                    should_record = true;
                }
                _ => {}
            }
        }

        if let Some(value) = finite_non_negative(parsed.value) {
            match parsed.ev.as_str() {
                "pull_shots_fired_total" => {
                    state.metrics.shots_fired = Some(value);
                    should_record = true;
                }
                "pull_shots_hit_total" => {
                    state.metrics.shots_hit = Some(value);
                    should_record = true;
                }
                "pull_kills_total" => {
                    state.metrics.kills = Some(value);
                    should_record = true;
                }
                "pull_seconds_total" => {
                    if !state.duration_from_challenge_secs {
                        state.metrics.duration_secs = Some(value);
                        time_hint_secs = Some(value);
                    }
                    should_record = true;
                }
                "pull_challenge_seconds_total" => {
                    state.metrics.duration_secs = Some(value);
                    state.duration_from_challenge_secs = true;
                    time_hint_secs = Some(value);
                    should_record = true;
                }
                "pull_score_per_minute" => {
                    state.metrics.score_per_minute = Some(value);
                    state.peak_score_per_minute = Some(
                        state
                            .peak_score_per_minute
                            .map_or(value, |prev| prev.max(value)),
                    );
                    should_record = true;
                }
                "pull_kills_per_second" => {
                    state.metrics.kills_per_second = Some(value);
                    state.peak_kills_per_second = Some(
                        state
                            .peak_kills_per_second
                            .map_or(value, |prev| prev.max(value)),
                    );
                    should_record = true;
                }
                "pull_damage_done" => {
                    state.metrics.damage_done = Some(value);
                    should_record = true;
                }
                "pull_damage_possible" => {
                    state.metrics.damage_possible = Some(value);
                    should_record = true;
                }
                "pull_damage_efficiency" => {
                    state.metrics.damage_efficiency = Some(value);
                    should_record = true;
                }
                "pull_accuracy" => {
                    state.metrics.accuracy_pct = Some(value);
                    should_record = true;
                }
                "pull_score_total" => {
                    state.metrics.score_total = Some(value);
                    should_record = true;
                }
                "pull_score_total_derived" => {
                    state.metrics.score_total_derived = Some(value);
                    should_record = true;
                }
                _ => {}
            }
        }

        if should_record {
            record_run_timeline_point_locked(&mut state, time_hint_secs);
        }
    }

    fn replay_json_number(value: &serde_json::Value) -> Option<f64> {
        match value {
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::String(s) => s.parse::<f64>().ok(),
            _ => None,
        }
    }

    fn replay_json_u32(value: &serde_json::Value) -> Option<u32> {
        replay_json_number(value).and_then(|v| {
            if v.is_finite() && v >= 0.0 {
                Some(v.round() as u32)
            } else {
                None
            }
        })
    }

    fn replay_read_scalars_from_payload(
        scalars_obj: &serde_json::Map<String, serde_json::Value>,
        state: &mut RunCaptureState,
    ) -> Option<f64> {
        if let Some(v) = scalars_obj
            .get("score_metric_total")
            .and_then(replay_json_number)
        {
            if v.is_finite() && v >= 0.0 {
                state.metrics.score_total = Some(v);
            }
        }
        if let Some(v) = scalars_obj.get("score_total").and_then(replay_json_number) {
            if v.is_finite() && v >= 0.0 {
                state.metrics.score_total = Some(v);
            }
        }
        if let Some(v) = scalars_obj
            .get("score_total_derived")
            .and_then(replay_json_number)
        {
            if v.is_finite() && v >= 0.0 {
                state.metrics.score_total_derived = Some(v);
            }
        }
        if let Some(v) = scalars_obj
            .get("challenge_seconds_total")
            .and_then(replay_json_number)
        {
            if v.is_finite() && v >= 0.0 {
                state.metrics.duration_secs = Some(v);
                state.duration_from_challenge_secs = true;
            }
        }
        if let Some(v) = scalars_obj
            .get("session_seconds_total")
            .and_then(replay_json_number)
        {
            if v.is_finite() && v >= 0.0 && !state.duration_from_challenge_secs {
                state.metrics.duration_secs = Some(v);
            }
        }
        state.metrics.duration_secs
    }

    fn observe_replay_stream_raw(raw: &str) {
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(raw) else {
            return;
        };
        let Some(obj) = payload.as_object() else {
            return;
        };
        let Some(ev) = obj.get("ev").and_then(|v| v.as_str()) else {
            return;
        };
        if !matches!(
            ev,
            "replay_context" | "replay_tick_keyframe" | "replay_tick_delta" | "replay_tick_end"
        ) {
            return;
        }

        let Ok(mut state) = run_capture_state().lock() else {
            return;
        };

        match ev {
            "replay_context" => {
                if let Some(v) = obj.get("sample_hz").and_then(replay_json_u32) {
                    state.tick_stream_v1.sample_hz = Some(v);
                }
                if let Some(v) = obj.get("keyframe_interval_ms").and_then(replay_json_u32) {
                    state.tick_stream_v1.keyframe_interval_ms = Some(v);
                }
                if let Some(ctx) = obj.get("context") {
                    state.tick_stream_v1.context = Some(ctx.clone());
                } else {
                    state.tick_stream_v1.context = Some(payload.clone());
                }
            }
            "replay_tick_keyframe" => {
                if let Some(v) = obj.get("sample_hz").and_then(replay_json_u32) {
                    state.tick_stream_v1.sample_hz = Some(v);
                }
                if let Some(v) = obj.get("keyframe_interval_ms").and_then(replay_json_u32) {
                    state.tick_stream_v1.keyframe_interval_ms = Some(v);
                }
                state.tick_stream_v1.keyframes.push(payload.clone());
                if state.tick_stream_v1.keyframes.len() > MAX_TICK_STREAM_KEYFRAMES {
                    let trim = state.tick_stream_v1.keyframes.len() - MAX_TICK_STREAM_KEYFRAMES;
                    state.tick_stream_v1.keyframes.drain(0..trim);
                }

                if let Some(ctx) = obj.get("context") {
                    state.tick_stream_v1.context = Some(ctx.clone());
                }

                let mut time_hint = None;
                if let Some(scalars_obj) = obj.get("scalars").and_then(|v| v.as_object()) {
                    time_hint = replay_read_scalars_from_payload(scalars_obj, &mut state);
                }
                ensure_run_capture_started_locked(&mut state, time_hint);
                record_run_timeline_point_locked(&mut state, time_hint);
            }
            "replay_tick_delta" => {
                if let Some(v) = obj.get("sample_hz").and_then(replay_json_u32) {
                    state.tick_stream_v1.sample_hz = Some(v);
                }
                if let Some(v) = obj.get("keyframe_interval_ms").and_then(replay_json_u32) {
                    state.tick_stream_v1.keyframe_interval_ms = Some(v);
                }
                state.tick_stream_v1.deltas.push(payload.clone());
                if state.tick_stream_v1.deltas.len() > MAX_TICK_STREAM_DELTAS {
                    let trim = state.tick_stream_v1.deltas.len() - MAX_TICK_STREAM_DELTAS;
                    state.tick_stream_v1.deltas.drain(0..trim);
                }

                let mut time_hint = None;
                if let Some(scalars_obj) = obj.get("scalars").and_then(|v| v.as_object()) {
                    time_hint = replay_read_scalars_from_payload(scalars_obj, &mut state);
                }
                ensure_run_capture_started_locked(&mut state, time_hint);
                record_run_timeline_point_locked(&mut state, time_hint);
            }
            "replay_tick_end" => {
                if let Some(v) = obj.get("final_score_total").and_then(replay_json_number) {
                    if v.is_finite() && v >= 0.0 {
                        state.metrics.score_total = Some(v);
                    }
                }
                mark_run_capture_end(state.metrics.duration_secs);
            }
            _ => {}
        }
    }

    fn run_capture_duration_hint_locked(state: &RunCaptureState) -> Option<f64> {
        finite_non_negative(state.metrics.duration_secs)
            .or_else(|| state.timeline.last().map(|p| p.t_sec as f64))
    }

    fn mark_run_capture_end(time_hint_secs: Option<f64>) {
        if let Ok(mut state) = run_capture_state().lock() {
            if state.started_at.is_some() {
                let now_ms = unix_now_ms();
                let effective_hint = finite_non_negative(time_hint_secs)
                    .or_else(|| run_capture_duration_hint_locked(&state));
                let ended_ms = match (state.started_at_unix_ms, effective_hint) {
                    (Some(start_ms), Some(hint_secs)) => {
                        start_ms.saturating_add((hint_secs * 1000.0).round() as u64)
                    }
                    _ => now_ms,
                };
                state.ended_at_unix_ms = Some(ended_ms.min(now_ms));
            }
        }
    }

    fn run_capture_has_progress_for_end_guard() -> bool {
        let Ok(state) = run_capture_state().lock() else {
            return false;
        };
        state.event_counts.shot_fired_events > 0
            || state.event_counts.shot_hit_events > 0
            || state.event_counts.kill_events > 0
    }

    fn should_guard_early_session_end(reason: &str) -> bool {
        matches!(
            reason,
            "class_hook:IsInChallenge"
                | "bridge:session_end"
                | "bridge:challenge_end"
                | "bridge:challenge_complete"
                | "bridge:challenge_canceled"
        )
    }

    fn restart_session_tracking(app: &AppHandle, reason: &str, challenge_active: bool) {
        let run_time_hint = authoritative_run_time_hint();
        {
            let mut state = bridge_session_state().lock().unwrap();
            let now = Instant::now();
            state.session_active = true;
            if challenge_active {
                state.challenge_active = true;
            }
            state.session_started_at = Some(now);
            state.recovery_start_streak = 0;
            state.tracking_paused_by_idle = false;
            state.last_stats_flow_at = Some(now);
            state.last_pull_event_at = Some(now);
            state.last_state_resync_request_at = None;
            state.state_resync_pending = false;
        }
        reset_bridge_stats_snapshot();
        if let Ok(mut run_state) = run_capture_state().lock() {
            begin_run_capture_locked(&mut run_state, Instant::now(), run_time_hint);
        }
        if challenge_active {
            let _ = app.emit(super::EVENT_CHALLENGE_START, ());
        }
        let _ = app.emit(super::EVENT_SESSION_START, ());
        let session_start = crate::mouse_hook::start_session_tracking();
        crate::screen_recorder::start(session_start);
        log::info!("bridge: session tracking restarted ({reason})");
    }

    fn handle_session_end_signal(app: &AppHandle, reason: &str) {
        let challenge_active = bridge_session_state()
            .lock()
            .map(|state| state.challenge_active)
            .unwrap_or(false);
        if challenge_active {
            log::warn!("bridge: ignoring session_end while challenge is active ({reason})");
            return;
        }
        end_session_tracking(app, reason, false);
    }

    pub fn take_run_snapshot() -> Option<super::BridgeRunSnapshot> {
        let Ok(mut state) = run_capture_state().lock() else {
            return None;
        };

        if !run_capture_has_data(&state) {
            return None;
        }

        let duration_secs = finite_non_negative(state.metrics.duration_secs)
            .or_else(|| state.timeline.last().map(|p| p.t_sec as f64));

        let avg_fire_to_hit_ms = if state.shot_to_hit_latencies_ms.is_empty() {
            None
        } else {
            Some(
                state.shot_to_hit_latencies_ms.iter().sum::<f64>()
                    / state.shot_to_hit_latencies_ms.len() as f64,
            )
        };
        let p90_fire_to_hit_ms = if state.shot_to_hit_latencies_ms.is_empty() {
            None
        } else {
            let mut sorted = state.shot_to_hit_latencies_ms.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            percentile_from_sorted(&sorted, 90.0)
        };
        let avg_shots_to_hit = if state.paired_shot_hits > 0 {
            Some(state.total_shots_to_hit as f64 / state.paired_shot_hits as f64)
        } else {
            None
        };
        let corrective_shot_ratio = if state.paired_shot_hits > 0 {
            Some(state.corrective_hits as f64 / state.paired_shot_hits as f64)
        } else {
            None
        };

        let snapshot = super::BridgeRunSnapshot {
            duration_secs,
            score_total: state.metrics.score_total,
            score_total_derived: state.metrics.score_total_derived,
            score_per_minute: state.metrics.score_per_minute,
            shots_fired: state.metrics.shots_fired,
            shots_hit: state.metrics.shots_hit,
            kills: state.metrics.kills,
            kills_per_second: state.metrics.kills_per_second,
            damage_done: state.metrics.damage_done,
            damage_possible: state.metrics.damage_possible,
            damage_efficiency: state.metrics.damage_efficiency,
            accuracy_pct: state.metrics.accuracy_pct,
            peak_score_per_minute: state.peak_score_per_minute,
            peak_kills_per_second: state.peak_kills_per_second,
            paired_shot_hits: state.paired_shot_hits,
            avg_fire_to_hit_ms,
            p90_fire_to_hit_ms,
            avg_shots_to_hit,
            corrective_shot_ratio,
            started_at_unix_ms: state.started_at_unix_ms,
            ended_at_unix_ms: state.ended_at_unix_ms.or(Some(unix_now_ms())),
            event_counts: state.event_counts.clone(),
            timeline: state.timeline.clone(),
            tick_stream_v1: if state.tick_stream_v1.context.is_some()
                || !state.tick_stream_v1.keyframes.is_empty()
                || !state.tick_stream_v1.deltas.is_empty()
            {
                Some(state.tick_stream_v1.clone())
            } else {
                None
            },
        };

        *state = RunCaptureState::default();
        Some(snapshot)
    }

    fn bridge_compat_state() -> &'static Mutex<BridgeCompatState> {
        static STATE: OnceLock<Mutex<BridgeCompatState>> = OnceLock::new();
        STATE.get_or_init(|| {
            Mutex::new(BridgeCompatState {
                stats: BridgeStatsPanelEvent {
                    session_time_secs: None,
                    kills: None,
                    kps: None,
                    accuracy_hits: None,
                    accuracy_shots: None,
                    accuracy_pct: None,
                    damage_dealt: None,
                    damage_total: None,
                    spm: None,
                    ttk_secs: None,
                    challenge_seconds_total: None,
                    challenge_time_length: None,
                    challenge_tick_count_total: None,
                    challenge_average_fps: None,
                    random_sens_scale: None,
                    time_remaining: None,
                    queue_time_remaining: None,
                    is_in_challenge: None,
                    is_in_scenario: None,
                    is_in_scenario_editor: None,
                    is_in_trainer: None,
                    scenario_is_paused: None,
                    scenario_is_enabled: None,
                    scenario_play_type: None,
                    game_state_code: 0,
                    game_state: "menu".to_string(),
                    scenario_name: None,
                    scenario_type: "Unknown".to_string(),
                },
                last_nonzero_spm: None,
                last_nonzero_damage_done: None,
                last_nonzero_damage_total: None,
                last_nonzero_seconds: None,
                last_nonzero_score_total: None,
                score_metric_total: None,
                score_total_derived: None,
            })
        })
    }

    fn bridge_session_state() -> &'static Mutex<BridgeSessionState> {
        static STATE: OnceLock<Mutex<BridgeSessionState>> = OnceLock::new();
        STATE.get_or_init(|| Mutex::new(BridgeSessionState::default()))
    }

    fn challenge_hook_state() -> &'static Mutex<ChallengeHookState> {
        static STATE: OnceLock<Mutex<ChallengeHookState>> = OnceLock::new();
        STATE.get_or_init(|| Mutex::new(ChallengeHookState::default()))
    }

    fn reset_bridge_stats_snapshot() {
        if let Ok(mut state) = bridge_compat_state().lock() {
            state.stats = BridgeStatsPanelEvent {
                session_time_secs: None,
                kills: None,
                kps: None,
                accuracy_hits: None,
                accuracy_shots: None,
                accuracy_pct: None,
                damage_dealt: None,
                damage_total: None,
                spm: None,
                ttk_secs: None,
                challenge_seconds_total: None,
                challenge_time_length: None,
                challenge_tick_count_total: None,
                challenge_average_fps: None,
                random_sens_scale: None,
                time_remaining: None,
                queue_time_remaining: None,
                is_in_challenge: None,
                is_in_scenario: None,
                is_in_scenario_editor: None,
                is_in_trainer: None,
                scenario_is_paused: None,
                scenario_is_enabled: None,
                scenario_play_type: None,
                game_state_code: 0,
                game_state: "menu".to_string(),
                scenario_name: None,
                scenario_type: "Unknown".to_string(),
            };
            state.last_nonzero_spm = None;
            state.last_nonzero_damage_done = None;
            state.last_nonzero_damage_total = None;
            state.last_nonzero_seconds = None;
            state.last_nonzero_score_total = None;
            state.score_metric_total = None;
            state.score_total_derived = None;
        }
    }

    fn authoritative_run_time_hint_from_stats(stats: &BridgeStatsPanelEvent) -> Option<f64> {
        finite_non_negative(stats.challenge_seconds_total)
            .or_else(|| finite_non_negative(stats.session_time_secs))
    }

    fn authoritative_run_time_hint() -> Option<f64> {
        bridge_compat_state()
            .lock()
            .ok()
            .and_then(|state| authoritative_run_time_hint_from_stats(&state.stats))
    }

    fn begin_session_tracking(app: &AppHandle, reason: &str, challenge_active: bool) {
        let run_time_hint = authoritative_run_time_hint();
        let (emit_session, emit_challenge) = {
            let mut state = bridge_session_state().lock().unwrap();
            let now = Instant::now();
            let mut emit_session = false;
            let mut emit_challenge = false;
            state.last_stats_flow_at = Some(now);
            state.last_pull_event_at = Some(now);
            state.tracking_paused_by_idle = false;
            state.last_state_resync_request_at = None;
            state.state_resync_pending = false;
            if challenge_active && !state.challenge_active {
                state.challenge_active = true;
                emit_challenge = true;
            }
            if !state.session_active {
                state.session_active = true;
                state.session_started_at = Some(now);
                state.recovery_start_streak = 0;
                emit_session = true;
            }
            (emit_session, emit_challenge)
        };

        if emit_challenge {
            let _ = app.emit(super::EVENT_CHALLENGE_START, ());
            if reason != "bridge:challenge_start" {
                let synthetic = super::BridgeParsedEvent {
                    ev: "challenge_start".to_string(),
                    value: Some(1.0),
                    total: None,
                    delta: Some(1.0),
                    field: None,
                    source: Some(reason.to_string()),
                    method: Some("session_tracking".to_string()),
                    origin: Some("bridge_session_tracking".to_string()),
                    origin_flag: Some("compat".to_string()),
                    fn_name: None,
                    receiver: None,
                    raw: format!("{{\"ev\":\"challenge_start\",\"source\":\"{}\"}}", reason),
                };
                let _ = app.emit(super::BRIDGE_METRIC_EVENT, &synthetic);
            }
        }
        if emit_session {
            reset_bridge_stats_snapshot();
            if let Ok(mut run_state) = run_capture_state().lock() {
                begin_run_capture_locked(&mut run_state, Instant::now(), run_time_hint);
            }
            let _ = app.emit(super::EVENT_SESSION_START, ());
            let session_start = crate::mouse_hook::start_session_tracking();
            crate::screen_recorder::start(session_start);
            log::info!("bridge: session tracking started ({reason})");
        }
    }

    fn end_session_tracking(app: &AppHandle, reason: &str, challenge_active: bool) {
        let run_time_hint = authoritative_run_time_hint();
        let (should_debounce, elapsed_ms, has_progress) = {
            let state = bridge_session_state().lock().unwrap();
            let (elapsed_ms, has_progress, should_debounce) =
                if let Some(started_at) = state.session_started_at {
                    let elapsed = started_at.elapsed();
                    let elapsed_ms = elapsed.as_millis() as u64;
                    let has_progress = run_capture_has_progress_for_end_guard();
                    let should_debounce = state.session_active
                        && should_guard_early_session_end(reason)
                        && elapsed < EARLY_SESSION_END_GUARD
                        && !has_progress;
                    (elapsed_ms, has_progress, should_debounce)
                } else {
                    (0_u64, false, false)
                };
            (should_debounce, elapsed_ms, has_progress)
        };
        if should_debounce {
            log::warn!(
                "bridge: debounced early session end reason={} elapsed_ms={} has_progress={}",
                reason,
                elapsed_ms,
                has_progress
            );
            return;
        }

        let (emit_session, emit_challenge) = {
            let mut state = bridge_session_state().lock().unwrap();
            let mut emit_challenge = false;
            if challenge_active && state.challenge_active {
                emit_challenge = true;
            }
            state.challenge_active = false;
            let emit_session = state.session_active;
            state.session_active = false;
            state.session_started_at = None;
            state.recovery_start_streak = 0;
            state.tracking_paused_by_idle = false;
            state.last_stats_flow_at = None;
            state.last_pull_event_at = None;
            state.last_state_resync_request_at = None;
            state.state_resync_pending = false;
            (emit_session, emit_challenge)
        };

        if emit_challenge {
            let _ = app.emit(super::EVENT_CHALLENGE_END, ());
            let parsed_terminal_reason = reason == "bridge:challenge_end"
                || reason == "bridge:challenge_complete"
                || reason == "bridge:challenge_canceled";
            if !parsed_terminal_reason {
                let synthetic = super::BridgeParsedEvent {
                    ev: "challenge_end".to_string(),
                    value: Some(1.0),
                    total: None,
                    delta: Some(1.0),
                    field: None,
                    source: Some(reason.to_string()),
                    method: Some("session_tracking".to_string()),
                    origin: Some("bridge_session_tracking".to_string()),
                    origin_flag: Some("compat".to_string()),
                    fn_name: None,
                    receiver: None,
                    raw: format!("{{\"ev\":\"challenge_end\",\"source\":\"{}\"}}", reason),
                };
                let _ = app.emit(super::BRIDGE_METRIC_EVENT, &synthetic);
            }
        }
        if emit_session {
            let _ = app.emit(super::EVENT_SESSION_END, ());
            mark_run_capture_end(run_time_hint);
            crate::mouse_hook::stop_session_tracking();
            crate::screen_recorder::stop();
            log::info!("bridge: session tracking stopped ({reason})");
        }
    }

    fn mark_stats_flow_activity(source: &str, is_pull_metric: bool) {
        let should_resume = {
            let mut state = bridge_session_state().lock().unwrap();
            if !state.session_active {
                return;
            }
            let now = Instant::now();
            state.last_stats_flow_at = Some(now);
            if is_pull_metric {
                state.last_pull_event_at = Some(now);
            }
            if state.tracking_paused_by_idle {
                state.tracking_paused_by_idle = false;
                true
            } else {
                false
            }
        };

        if should_resume {
            crate::mouse_hook::resume_session_tracking();
            crate::screen_recorder::resume();
            log::info!("bridge: resumed tracking after stats flow resumed ({source})");
        }
    }

    include!("bridge/session_watchdog.rs");

    fn is_stats_flow_event(parsed: &super::BridgeParsedEvent) -> bool {
        if super::is_metric_event_name(&parsed.ev)
            || parsed.ev.starts_with("pull_")
            || parsed.value.is_some()
            || parsed.total.is_some()
            || parsed.delta.is_some()
        {
            return true;
        }

        matches!(
            parsed.ev.as_str(),
            "session_start"
                | "session_end"
                | "challenge_start"
                | "challenge_restart"
                | "challenge_end"
                | "challenge_complete"
                | "challenge_completed"
                | "challenge_canceled"
                | "challenge_quit"
                | "scenario_start"
                | "scenario_restart"
                | "scenario_restarted"
                | "scenario_end"
                | "shot_fired"
                | "shot_hit"
                | "kill"
                | "replay_context"
                | "replay_tick_keyframe"
                | "replay_tick_delta"
                | "replay_tick_end"
                | "class_hook_probe"
                | "script_hook_probe"
                | "hook_probe"
        )
    }

    fn parse_class_hook_from_raw(
        raw: &str,
    ) -> Option<(String, Option<u64>, Option<i64>, Option<f64>)> {
        let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
        let obj = parsed.as_object()?;
        if obj.get("ev")?.as_str()?.trim() != "class_hook_probe" {
            return None;
        }
        if obj
            .get("has_ret")
            .and_then(|v| v.as_u64())
            .map_or(false, |v| v == 0)
        {
            return None;
        }
        let fn_name = obj.get("fn")?.as_str()?.to_string();
        let ret_u32 = obj.get("ret_u32").and_then(|v| v.as_u64());
        let ret_i32 = obj.get("ret_i32").and_then(|v| v.as_i64());
        let ret_f32 = obj.get("ret_f32").and_then(|v| v.as_f64());
        Some((fn_name, ret_u32, ret_i32, ret_f32))
    }

    fn update_challenge_transition(sample: bool) -> ChallengeTransition {
        let mut state = challenge_hook_state().lock().unwrap();
        let prev = state.stable;
        match state.stable {
            None => {
                state.stable = Some(sample);
                state.candidate = None;
                state.candidate_count = 0;
                if sample {
                    ChallengeTransition::Entered
                } else {
                    ChallengeTransition::None
                }
            }
            Some(stable) if stable == sample => {
                state.candidate = None;
                state.candidate_count = 0;
                ChallengeTransition::None
            }
            Some(_) => {
                if state.candidate == Some(sample) {
                    state.candidate_count = state.candidate_count.saturating_add(1);
                } else {
                    state.candidate = Some(sample);
                    state.candidate_count = 1;
                }
                if state.candidate_count < 3 {
                    return ChallengeTransition::None;
                }
                state.stable = Some(sample);
                state.candidate = None;
                state.candidate_count = 0;
                if sample && prev != Some(true) {
                    ChallengeTransition::Entered
                } else if !sample && prev == Some(true) {
                    ChallengeTransition::Exited
                } else {
                    ChallengeTransition::None
                }
            }
        }
    }

    fn infer_scenario_type(stats: &BridgeStatsPanelEvent) -> &'static str {
        let kills = stats.kills.unwrap_or(0);
        let shots = stats.accuracy_shots.unwrap_or(0);
        let dmg_total = stats.damage_total.unwrap_or(0.0);
        if kills > 0 && dmg_total > 0.0 {
            return "MultiHitClicking";
        }
        if kills > 0 {
            return "OneShotClicking";
        }
        if shots > 0 && kills == 0 {
            return "AccuracyDrill";
        }
        "Unknown"
    }

    fn derive_game_state(stats: &BridgeStatsPanelEvent) -> (i32, &'static str) {
        if stats.is_in_scenario_editor == Some(true) {
            return (6, "editor");
        }
        if stats.scenario_is_paused == Some(true) {
            return (5, "paused");
        }
        let in_challenge = stats.is_in_challenge == Some(true);
        let in_scenario = stats.is_in_scenario == Some(true);
        let in_trainer = stats.is_in_trainer == Some(true);
        let has_queue_timer = stats.queue_time_remaining.map_or(false, |v| v > 0.0001);
        let has_challenge_timer = stats.time_remaining.map_or(false, |v| v > 0.0001);

        if in_challenge || has_challenge_timer {
            return (4, "challenge");
        }
        if in_scenario {
            if has_queue_timer {
                return (2, "queued");
            }
            return (3, "freeplay");
        }
        if in_trainer {
            if has_queue_timer {
                return (2, "queued");
            }
            return (1, "trainer_menu");
        }
        if has_queue_timer {
            return (2, "queued");
        }
        (0, "menu")
    }

    fn game_state_label_from_code(code: i32) -> &'static str {
        match code {
            1 => "trainer_menu",
            2 => "queued",
            3 => "freeplay",
            4 => "challenge",
            5 => "paused",
            6 => "editor",
            7 => "replay",
            _ => "menu",
        }
    }

    fn normalize_scenario_name(raw: &str) -> Option<String> {
        let trimmed = raw.trim();
        if trimmed.len() < 3 || trimmed.len() > 160 {
            return None;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower == "scenario" || lower == "scenariotitle" || lower == "none" {
            return None;
        }
        if !trimmed.chars().any(|c| c.is_ascii_alphanumeric()) {
            return None;
        }
        Some(trimmed.to_string())
    }

    fn derive_scenario_name_from_id(raw: &str) -> Option<String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }
        let leaf = trimmed.rsplit('/').next().unwrap_or(trimmed);
        let base = leaf.split('.').next().unwrap_or(leaf).trim();
        if base.is_empty() {
            return None;
        }
        normalize_scenario_name(base)
    }

    fn parse_state_manager_scenario_name_from_metadata(raw: &str) -> Option<String> {
        let payload: serde_json::Value = serde_json::from_str(raw).ok()?;
        let obj = payload.as_object()?;

        if let Some(name) = obj
            .get("scenario_name")
            .and_then(|v| v.as_str())
            .and_then(normalize_scenario_name)
        {
            return Some(name);
        }

        obj.get("scenario_id")
            .and_then(|v| v.as_str())
            .and_then(derive_scenario_name_from_id)
    }

    fn parse_state_manager_queue_time_remaining_from_metadata(raw: &str) -> Option<f64> {
        let payload: serde_json::Value = serde_json::from_str(raw).ok()?;
        let obj = payload.as_object()?;
        let value = match obj.get("queue_time_remaining") {
            Some(serde_json::Value::Number(n)) => n.as_f64(),
            Some(serde_json::Value::String(s)) => s.parse::<f64>().ok(),
            _ => None,
        }?;
        if value.is_finite() && value >= 0.0 {
            Some(value)
        } else {
            None
        }
    }

    fn parse_state_manager_bool_from_metadata(raw: &str, key: &str) -> Option<bool> {
        let payload: serde_json::Value = serde_json::from_str(raw).ok()?;
        let obj = payload.as_object()?;
        match obj.get(key) {
            Some(serde_json::Value::Bool(v)) => Some(*v),
            Some(serde_json::Value::Number(n)) => {
                if let Some(v) = n.as_i64() {
                    return match v {
                        0 => Some(false),
                        1 => Some(true),
                        _ => None,
                    };
                }
                n.as_f64().and_then(|v| {
                    if (v - 0.0).abs() <= 0.000001 {
                        Some(false)
                    } else if (v - 1.0).abs() <= 0.000001 {
                        Some(true)
                    } else {
                        None
                    }
                })
            }
            Some(serde_json::Value::String(s)) => {
                let normalized = s.trim().to_ascii_lowercase();
                if normalized == "1" || normalized == "true" {
                    Some(true)
                } else if normalized == "0" || normalized == "false" {
                    Some(false)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn apply_scenario_name_update(app: &AppHandle, name: String, source: &str, raw: &str) {
        let mut changed = false;
        if let Ok(mut state) = bridge_compat_state().lock() {
            if state.stats.scenario_name.as_deref() != Some(name.as_str()) {
                state.stats.scenario_name = Some(name.clone());
                changed = true;
                let _ = app.emit(super::EVENT_STATS_PANEL_UPDATE, &state.stats);
            }
        }
        if changed {
            log::info!(
                "bridge: scenario_name resolved source={} name={}",
                source,
                name
            );
            let synthetic = super::BridgeParsedEvent {
                ev: "scenario_name".to_string(),
                value: None,
                total: None,
                delta: None,
                field: Some(name),
                source: Some(source.to_string()),
                method: Some("state_manager_metadata".to_string()),
                origin: Some("scenario_metadata".to_string()),
                origin_flag: Some("state_manager".to_string()),
                fn_name: None,
                receiver: None,
                raw: raw.to_string(),
            };
            let _ = app.emit(super::BRIDGE_METRIC_EVENT, &synthetic);
        }
    }

    fn accept_float_with_zero_suppress(
        prev: Option<f64>,
        incoming: f64,
        now: Instant,
        last_nonzero: Option<Instant>,
        suppress_zeros_for: Duration,
        suppress_low_confidence_zero: bool,
    ) -> Option<Option<Instant>> {
        if !incoming.is_finite() || incoming < 0.0 {
            return None;
        }
        let mut next_last_nonzero = last_nonzero;
        if incoming > 0.0 {
            next_last_nonzero = Some(now);
        } else if suppress_low_confidence_zero && prev.map_or(false, |prev_val| prev_val > 0.0) {
            return None;
        } else if let (Some(prev_val), Some(last_nz)) = (prev, last_nonzero) {
            if prev_val > 0.0 && now.duration_since(last_nz) < suppress_zeros_for {
                return None;
            }
        }
        if prev.map_or(false, |prev_val| (prev_val - incoming).abs() <= 0.0001) {
            return None;
        }
        Some(next_last_nonzero)
    }

    fn emit_bridge_compat_events(app: &AppHandle, parsed: &super::BridgeParsedEvent) {
        if let Some((fn_name, ret_u32, ret_i32, ret_f32)) = parse_class_hook_from_raw(&parsed.raw) {
            let bool_sample = ret_u32
                .map(|v| (v & 1) == 1)
                .or_else(|| ret_i32.map(|v| (v & 1) != 0));
            let emit_class_bool_metric = |event_name: &str, sample: bool| {
                let synthetic = super::BridgeParsedEvent {
                    ev: event_name.to_string(),
                    value: Some(if sample { 1.0 } else { 0.0 }),
                    total: None,
                    delta: None,
                    field: None,
                    source: Some(fn_name.clone()),
                    method: Some("class_hook_ret_bool".to_string()),
                    origin: Some("class_hook_probe".to_string()),
                    origin_flag: Some("class_probe_hooks".to_string()),
                    fn_name: Some(fn_name.clone()),
                    receiver: None,
                    raw: parsed.raw.clone(),
                };
                let _ = app.emit(super::BRIDGE_METRIC_EVENT, &synthetic);
            };

            if fn_name.ends_with(":IsInChallenge") {
                if let Some(in_challenge) = bool_sample {
                    match update_challenge_transition(in_challenge) {
                        ChallengeTransition::Entered => {
                            begin_session_tracking(app, "class_hook:IsInChallenge", true);
                        }
                        // Avoid ending sessions directly from class-hook samples:
                        // explicit lifecycle events are less jitter-prone for terminal transitions.
                        ChallengeTransition::Exited => {}
                        ChallengeTransition::None => {}
                    }
                    emit_class_bool_metric("pull_is_in_challenge", in_challenge);
                }
            } else if fn_name.ends_with(":IsInScenario") {
                if let Some(in_scenario) = bool_sample {
                    emit_class_bool_metric("pull_is_in_scenario", in_scenario);
                }
            } else if fn_name.ends_with(":IsInScenarioEditor") {
                if let Some(in_editor) = bool_sample {
                    emit_class_bool_metric("pull_is_in_scenario_editor", in_editor);
                }
            }

            if fn_name.ends_with(":GetChallengeTimeRemaining") {
                if let Some(value) = ret_f32 {
                    if value.is_finite() && value >= 0.0 {
                        let synthetic = super::BridgeParsedEvent {
                            ev: "pull_time_remaining".to_string(),
                            value: Some(value),
                            total: None,
                            delta: None,
                            field: None,
                            source: Some(fn_name.clone()),
                            method: Some("class_hook_ret_f32".to_string()),
                            origin: Some("class_hook_probe".to_string()),
                            origin_flag: Some("class_probe_hooks".to_string()),
                            fn_name: Some(fn_name),
                            receiver: None,
                            raw: parsed.raw.clone(),
                        };
                        let _ = app.emit(super::BRIDGE_METRIC_EVENT, &synthetic);
                    }
                }
            } else if fn_name.ends_with(":GetChallengeQueueTimeRemaining") {
                if let Some(value) = ret_f32 {
                    if value.is_finite() && value >= 0.0 {
                        let synthetic = super::BridgeParsedEvent {
                            ev: "pull_queue_time_remaining".to_string(),
                            value: Some(value),
                            total: None,
                            delta: None,
                            field: None,
                            source: Some(fn_name.clone()),
                            method: Some("class_hook_ret_f32".to_string()),
                            origin: Some("class_hook_probe".to_string()),
                            origin_flag: Some("class_probe_hooks".to_string()),
                            fn_name: Some(fn_name),
                            receiver: None,
                            raw: parsed.raw.clone(),
                        };
                        let _ = app.emit(super::BRIDGE_METRIC_EVENT, &synthetic);
                    }
                }
            }
        }

        let mut challenge_transition_active: Option<bool> = None;
        match parsed.ev.as_str() {
            "session_start" => {
                begin_session_tracking(app, "bridge:session_start", false);
            }
            "session_end" => {
                handle_session_end_signal(app, "bridge:session_end");
            }
            "challenge_start" | "scenario_start" => {
                begin_session_tracking(app, "bridge:challenge_start", true);
                challenge_transition_active = Some(true);
            }
            "challenge_restart" | "scenario_restart" | "scenario_restarted" => {
                restart_session_tracking(app, "bridge:challenge_restart", true);
                challenge_transition_active = Some(true);
            }
            "challenge_end" | "scenario_end" => {
                end_session_tracking(app, "bridge:challenge_end", true);
                challenge_transition_active = Some(false);
            }
            "challenge_complete" | "challenge_completed" | "post_challenge_complete" => {
                end_session_tracking(app, "bridge:challenge_complete", true);
                challenge_transition_active = Some(false);
            }
            "challenge_canceled" | "challenge_quit" => {
                end_session_tracking(app, "bridge:challenge_canceled", true);
                challenge_transition_active = Some(false);
            }
            _ => {}
        }

        if let Some(active) = challenge_transition_active {
            let mut should_emit_stats = false;
            if let Ok(mut state) = bridge_compat_state().lock() {
                if state.stats.is_in_challenge != Some(active) {
                    state.stats.is_in_challenge = Some(active);
                    should_emit_stats = true;
                }
                if !active
                    && state
                        .stats
                        .queue_time_remaining
                        .map_or(false, |prev| prev.abs() > 0.0001)
                {
                    state.stats.queue_time_remaining = Some(0.0);
                    should_emit_stats = true;
                }
                let (next_game_state_code, next_game_state) = derive_game_state(&state.stats);
                if state.stats.game_state != next_game_state
                    || state.stats.game_state_code != next_game_state_code
                {
                    state.stats.game_state_code = next_game_state_code;
                    state.stats.game_state = next_game_state.to_string();
                    should_emit_stats = true;
                }
                if should_emit_stats {
                    let _ = app.emit(super::EVENT_STATS_PANEL_UPDATE, &state.stats);
                }
            }

            let ch_metric = super::BridgeParsedEvent {
                ev: "ch".to_string(),
                value: Some(if active { 1.0 } else { 0.0 }),
                total: None,
                delta: None,
                field: Some("is_in_challenge".to_string()),
                source: parsed.source.clone(),
                method: Some("challenge_transition".to_string()),
                origin: Some("bridge_session_tracking".to_string()),
                origin_flag: Some("compat".to_string()),
                fn_name: parsed.fn_name.clone(),
                receiver: parsed.receiver.clone(),
                raw: parsed.raw.clone(),
            };
            let _ = app.emit(super::BRIDGE_METRIC_EVENT, &ch_metric);

            if !active {
                let qrem_metric = super::BridgeParsedEvent {
                    ev: "qrem".to_string(),
                    value: Some(0.0),
                    total: None,
                    delta: None,
                    field: Some("queue_time_remaining".to_string()),
                    source: parsed.source.clone(),
                    method: Some("challenge_transition".to_string()),
                    origin: Some("bridge_session_tracking".to_string()),
                    origin_flag: Some("compat".to_string()),
                    fn_name: parsed.fn_name.clone(),
                    receiver: parsed.receiver.clone(),
                    raw: parsed.raw.clone(),
                };
                let _ = app.emit(super::BRIDGE_METRIC_EVENT, &qrem_metric);
            }
        }

        if parsed.ev == "scenario_metadata" {
            if let Some(name) = parse_state_manager_scenario_name_from_metadata(&parsed.raw) {
                apply_scenario_name_update(app, name, "state_manager", &parsed.raw);
            }
            let metadata_is_in_challenge =
                parse_state_manager_bool_from_metadata(&parsed.raw, "is_in_challenge");
            let metadata_is_in_scenario =
                parse_state_manager_bool_from_metadata(&parsed.raw, "is_in_scenario");
            let metadata_is_in_scenario_editor =
                parse_state_manager_bool_from_metadata(&parsed.raw, "is_in_scenario_editor");
            let metadata_is_in_trainer =
                parse_state_manager_bool_from_metadata(&parsed.raw, "is_in_trainer");
            let mut state_changed = false;
            if let Ok(mut state) = bridge_compat_state().lock() {
                if let Some(next) = metadata_is_in_challenge {
                    if state.stats.is_in_challenge != Some(next) {
                        state.stats.is_in_challenge = Some(next);
                        state_changed = true;
                    }
                }
                if let Some(next) = metadata_is_in_scenario {
                    if state.stats.is_in_scenario != Some(next) {
                        state.stats.is_in_scenario = Some(next);
                        state_changed = true;
                    }
                }
                if let Some(next) = metadata_is_in_scenario_editor {
                    if state.stats.is_in_scenario_editor != Some(next) {
                        state.stats.is_in_scenario_editor = Some(next);
                        state_changed = true;
                    }
                }
                if let Some(next) = metadata_is_in_trainer {
                    if state.stats.is_in_trainer != Some(next) {
                        state.stats.is_in_trainer = Some(next);
                        state_changed = true;
                    }
                }
                if state_changed {
                    let (next_game_state_code, next_game_state) = derive_game_state(&state.stats);
                    if state.stats.game_state != next_game_state
                        || state.stats.game_state_code != next_game_state_code
                    {
                        state.stats.game_state_code = next_game_state_code;
                        state.stats.game_state = next_game_state.to_string();
                    }
                    let _ = app.emit(super::EVENT_STATS_PANEL_UPDATE, &state.stats);
                }
            }
            let emit_state_manager_bool_metric = |ev: &str, value: bool| {
                let synthetic = super::BridgeParsedEvent {
                    ev: ev.to_string(),
                    value: Some(if value { 1.0 } else { 0.0 }),
                    total: None,
                    delta: None,
                    field: None,
                    source: Some("state_manager".to_string()),
                    method: Some("scenario_metadata".to_string()),
                    origin: Some("scenario_metadata".to_string()),
                    origin_flag: Some("state_manager".to_string()),
                    fn_name: None,
                    receiver: None,
                    raw: parsed.raw.clone(),
                };
                let _ = app.emit(super::BRIDGE_METRIC_EVENT, &synthetic);
            };
            if let Some(value) = metadata_is_in_challenge {
                emit_state_manager_bool_metric("pull_is_in_challenge", value);
            }
            if let Some(value) = metadata_is_in_scenario {
                emit_state_manager_bool_metric("pull_is_in_scenario", value);
            }
            if let Some(value) = metadata_is_in_scenario_editor {
                emit_state_manager_bool_metric("pull_is_in_scenario_editor", value);
            }
            if let Some(value) = metadata_is_in_trainer {
                emit_state_manager_bool_metric("pull_is_in_trainer", value);
            }
            if let Some(qrem) = parse_state_manager_queue_time_remaining_from_metadata(&parsed.raw)
            {
                let mut queue_changed = false;
                if let Ok(mut state) = bridge_compat_state().lock() {
                    if !state
                        .stats
                        .queue_time_remaining
                        .map_or(false, |prev| (prev - qrem).abs() <= 0.0001)
                    {
                        state.stats.queue_time_remaining = Some(qrem);
                        let (next_game_state_code, next_game_state) =
                            derive_game_state(&state.stats);
                        if state.stats.game_state != next_game_state
                            || state.stats.game_state_code != next_game_state_code
                        {
                            state.stats.game_state_code = next_game_state_code;
                            state.stats.game_state = next_game_state.to_string();
                        }
                        queue_changed = true;
                        let _ = app.emit(super::EVENT_STATS_PANEL_UPDATE, &state.stats);
                    }
                }
                if queue_changed {
                    let synthetic = super::BridgeParsedEvent {
                        ev: "pull_queue_time_remaining".to_string(),
                        value: Some(qrem),
                        total: None,
                        delta: None,
                        field: None,
                        source: Some("state_manager".to_string()),
                        method: Some("scenario_metadata".to_string()),
                        origin: Some("scenario_metadata".to_string()),
                        origin_flag: Some("state_manager".to_string()),
                        fn_name: None,
                        receiver: None,
                        raw: parsed.raw.clone(),
                    };
                    let _ = app.emit(super::BRIDGE_METRIC_EVENT, &synthetic);
                }
            }
            return;
        }

        if parsed.ev == "state_snapshot" {
            if let Ok(mut state) = bridge_session_state().lock() {
                state.state_resync_pending = false;
                state.last_state_resync_request_at = None;
                if state.session_active {
                    state.last_pull_event_at = Some(Instant::now());
                }
            }
            return;
        }

        if parsed.ev == "ui_scenario_name" {
            let source = parsed.source.as_deref().unwrap_or_default();
            let is_state_manager_source = source == "state_manager";
            if !is_state_manager_source {
                return;
            }
            if let Some(name) = parsed.field.as_deref().and_then(normalize_scenario_name) {
                apply_scenario_name_update(app, name, "state_manager", &parsed.raw);
            }
            return;
        }

        let is_compat_metric = parsed.ev.starts_with("pull_")
            || parsed.ev == "is_in_challenge"
            || parsed.ev == "queue_time_remaining"
            || parsed.ev == "challenge_queue_time_remaining"
            || parsed.ev == "qrem"
            || parsed.ev == "ch";
        if !is_compat_metric {
            return;
        }

        let has_none_marker = |s: &str| s.contains("None.None") || s.starts_with("Function None.");
        let stale_runtime_source = parsed.fn_name.as_deref().map_or(false, has_none_marker)
            || parsed.receiver.as_deref().map_or(false, has_none_marker)
            || parsed.source.as_deref().map_or(false, has_none_marker);
        if stale_runtime_source {
            return;
        }

        // Production path must be non-UI: ignore UI poll/counter-fallback metrics.
        let is_ui_origin = parsed.origin.as_deref() == Some("ui_poll")
            || parsed.origin_flag.as_deref() == Some("ui_counter_fallback")
            || parsed.method.as_deref() == Some("ui_poll");
        if is_ui_origin {
            return;
        }

        let Some(value) = parsed.value else {
            return;
        };
        if !value.is_finite() || value < 0.0 {
            return;
        }

        let low_confidence_zero = value.abs() <= 0.000001
            && parsed.origin.as_deref() == Some("direct_pull")
            && parsed.origin_flag.as_deref() == Some("non_ui_probe")
            && parsed.method.as_deref().map_or(true, |m| m == "unknown");

        let now = Instant::now();
        let mut should_emit_stats = false;
        let mut emit_alias_qrem: Option<f64> = None;
        let mut emit_alias_ch: Option<f64> = None;
        let mut recovery_signal: Option<(bool, bool)> = None;
        if let Ok(mut state) = bridge_compat_state().lock() {
            const ZERO_SUPPRESS: Duration = Duration::from_millis(1500);
            match parsed.ev.as_str() {
                "pull_is_in_scenario" => {
                    let next = value >= 0.5;
                    if state.stats.is_in_scenario != Some(next) {
                        state.stats.is_in_scenario = Some(next);
                        should_emit_stats = true;
                    }
                }
                "pull_is_in_challenge" | "is_in_challenge" => {
                    let next = value >= 0.5;
                    if state.stats.is_in_challenge != Some(next) {
                        state.stats.is_in_challenge = Some(next);
                        should_emit_stats = true;
                        emit_alias_ch = Some(if next { 1.0 } else { 0.0 });
                    }
                }
                "pull_is_in_scenario_editor" => {
                    let next = value >= 0.5;
                    if state.stats.is_in_scenario_editor != Some(next) {
                        state.stats.is_in_scenario_editor = Some(next);
                        should_emit_stats = true;
                    }
                }
                "pull_is_in_trainer" => {
                    let next = value >= 0.5;
                    if state.stats.is_in_trainer != Some(next) {
                        state.stats.is_in_trainer = Some(next);
                        should_emit_stats = true;
                    }
                }
                "pull_scenario_is_paused" => {
                    let next = value >= 0.5;
                    if state.stats.scenario_is_paused != Some(next) {
                        state.stats.scenario_is_paused = Some(next);
                        should_emit_stats = true;
                    }
                }
                "pull_scenario_is_enabled" => {
                    let next = value >= 0.5;
                    if state.stats.scenario_is_enabled != Some(next) {
                        state.stats.scenario_is_enabled = Some(next);
                        should_emit_stats = true;
                    }
                }
                "pull_scenario_play_type" => {
                    let next = value.round() as i32;
                    if state.stats.scenario_play_type != Some(next) {
                        state.stats.scenario_play_type = Some(next);
                        should_emit_stats = true;
                    }
                }
                "pull_shots_hit_total" => {
                    let next = value.max(0.0).round() as u32;
                    let suppress = low_confidence_zero
                        && next == 0
                        && state.stats.accuracy_hits.map_or(false, |prev| prev > 0);
                    if !suppress && state.stats.accuracy_hits != Some(next) {
                        state.stats.accuracy_hits = Some(next);
                        should_emit_stats = true;
                    }
                }
                "pull_shots_fired_total" => {
                    let next = value.max(0.0).round() as u32;
                    let suppress = low_confidence_zero
                        && next == 0
                        && state.stats.accuracy_shots.map_or(false, |prev| prev > 0);
                    if !suppress && state.stats.accuracy_shots != Some(next) {
                        state.stats.accuracy_shots = Some(next);
                        should_emit_stats = true;
                    }
                }
                "pull_kills_total" => {
                    let next = value.max(0.0).round() as u32;
                    let suppress = low_confidence_zero
                        && next == 0
                        && state.stats.kills.map_or(false, |prev| prev > 0);
                    if !suppress && state.stats.kills != Some(next) {
                        state.stats.kills = Some(next);
                        should_emit_stats = true;
                    }
                }
                "pull_kills_per_second" => {
                    let suppress = low_confidence_zero
                        && value <= 0.000001
                        && state.stats.kps.map_or(false, |prev| prev > 0.0);
                    if !suppress
                        && !state
                            .stats
                            .kps
                            .map_or(false, |prev| (prev - value).abs() <= 0.0001)
                    {
                        state.stats.kps = Some(value);
                        should_emit_stats = true;
                    }
                    if value > 0.000001 {
                        let ttk_secs = 1.0 / value;
                        if ttk_secs.is_finite()
                            && ttk_secs > 0.0
                            && ttk_secs < 120.0
                            && !state
                                .stats
                                .ttk_secs
                                .map_or(false, |prev| (prev - ttk_secs).abs() <= 0.0001)
                        {
                            state.stats.ttk_secs = Some(ttk_secs);
                            should_emit_stats = true;
                        }
                    }
                }
                "pull_score_per_minute" => {
                    if let Some(next_last_nonzero) = accept_float_with_zero_suppress(
                        state.stats.spm,
                        value,
                        now,
                        state.last_nonzero_spm,
                        ZERO_SUPPRESS,
                        low_confidence_zero,
                    ) {
                        state.last_nonzero_spm = next_last_nonzero;
                        state.stats.spm = Some(value);
                        should_emit_stats = true;
                    }
                }
                "pull_damage_done" => {
                    if let Some(next_last_nonzero) = accept_float_with_zero_suppress(
                        state.stats.damage_dealt,
                        value,
                        now,
                        state.last_nonzero_damage_done,
                        ZERO_SUPPRESS,
                        low_confidence_zero,
                    ) {
                        state.last_nonzero_damage_done = next_last_nonzero;
                        state.stats.damage_dealt = Some(value);
                        should_emit_stats = true;
                    }
                }
                "pull_damage_possible" => {
                    if let Some(next_last_nonzero) = accept_float_with_zero_suppress(
                        state.stats.damage_total,
                        value,
                        now,
                        state.last_nonzero_damage_total,
                        ZERO_SUPPRESS,
                        low_confidence_zero,
                    ) {
                        state.last_nonzero_damage_total = next_last_nonzero;
                        state.stats.damage_total = Some(value);
                        should_emit_stats = true;
                    }
                }
                "pull_seconds_total" => {
                    if let Some(next_last_nonzero) = accept_float_with_zero_suppress(
                        state.stats.session_time_secs,
                        value,
                        now,
                        state.last_nonzero_seconds,
                        ZERO_SUPPRESS,
                        low_confidence_zero,
                    ) {
                        state.last_nonzero_seconds = next_last_nonzero;
                        state.stats.session_time_secs = Some(value);
                        should_emit_stats = true;
                    }
                }
                "pull_challenge_seconds_total" => {
                    let suppress = low_confidence_zero
                        && value <= 0.000001
                        && state
                            .stats
                            .challenge_seconds_total
                            .map_or(false, |prev| prev > 0.0);
                    if !suppress
                        && !state
                            .stats
                            .challenge_seconds_total
                            .map_or(false, |prev| (prev - value).abs() <= 0.0001)
                    {
                        state.stats.challenge_seconds_total = Some(value);
                        should_emit_stats = true;
                    }
                }
                "pull_challenge_time_length" => {
                    let suppress = low_confidence_zero
                        && value <= 0.000001
                        && state
                            .stats
                            .challenge_time_length
                            .map_or(false, |prev| prev > 0.0);
                    if !suppress
                        && !state
                            .stats
                            .challenge_time_length
                            .map_or(false, |prev| (prev - value).abs() <= 0.0001)
                    {
                        state.stats.challenge_time_length = Some(value);
                        should_emit_stats = true;
                    }
                }
                "pull_challenge_average_fps" => {
                    let suppress = low_confidence_zero
                        && value <= 0.000001
                        && state
                            .stats
                            .challenge_average_fps
                            .map_or(false, |prev| prev > 0.0);
                    if !suppress
                        && !state
                            .stats
                            .challenge_average_fps
                            .map_or(false, |prev| (prev - value).abs() <= 0.0001)
                    {
                        state.stats.challenge_average_fps = Some(value);
                        should_emit_stats = true;
                    }
                }
                "pull_challenge_tick_count_total" => {
                    let next = value.max(0.0).round() as u32;
                    let suppress = low_confidence_zero
                        && next == 0
                        && state
                            .stats
                            .challenge_tick_count_total
                            .map_or(false, |prev| prev > 0);
                    if !suppress && state.stats.challenge_tick_count_total != Some(next) {
                        state.stats.challenge_tick_count_total = Some(next);
                        should_emit_stats = true;
                    }
                }
                "pull_random_sens_scale" => {
                    let suppress = low_confidence_zero
                        && value <= 0.000001
                        && state
                            .stats
                            .random_sens_scale
                            .map_or(false, |prev| prev > 0.0);
                    if !suppress
                        && !state
                            .stats
                            .random_sens_scale
                            .map_or(false, |prev| (prev - value).abs() <= 0.0001)
                    {
                        state.stats.random_sens_scale = Some(value);
                        should_emit_stats = true;
                    }
                }
                "pull_time_remaining" => {
                    let suppress = low_confidence_zero
                        && value <= 0.000001
                        && state.stats.time_remaining.map_or(false, |prev| prev > 0.0);
                    if !suppress
                        && !state
                            .stats
                            .time_remaining
                            .map_or(false, |prev| (prev - value).abs() <= 0.0001)
                    {
                        state.stats.time_remaining = Some(value);
                        should_emit_stats = true;
                    }
                }
                "pull_queue_time_remaining"
                | "challenge_queue_time_remaining"
                | "queue_time_remaining" => {
                    let suppress = low_confidence_zero
                        && value <= 0.000001
                        && state
                            .stats
                            .queue_time_remaining
                            .map_or(false, |prev| prev > 0.0);
                    if !suppress
                        && !state
                            .stats
                            .queue_time_remaining
                            .map_or(false, |prev| (prev - value).abs() <= 0.0001)
                    {
                        state.stats.queue_time_remaining = Some(value);
                        should_emit_stats = true;
                        emit_alias_qrem = Some(value);
                    }
                }
                "pull_score_total" => {
                    if let Some(next_last_nonzero) = accept_float_with_zero_suppress(
                        state.score_metric_total,
                        value,
                        now,
                        state.last_nonzero_score_total,
                        ZERO_SUPPRESS,
                        low_confidence_zero,
                    ) {
                        state.last_nonzero_score_total = next_last_nonzero;
                        state.score_metric_total = Some(value);
                    }
                }
                "pull_score_total_derived" => {
                    if value.is_finite() && value >= 0.0 {
                        state.score_total_derived = Some(value);
                    }
                }
                "pull_game_state_code" => {
                    let next_code = value.round() as i32;
                    if state.stats.game_state_code != next_code {
                        state.stats.game_state_code = next_code;
                        state.stats.game_state = game_state_label_from_code(next_code).to_string();
                        should_emit_stats = true;
                    }
                }
                "pull_game_state" => {
                    let next_code = value.round() as i32;
                    let next_label = parsed
                        .field
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| game_state_label_from_code(next_code));
                    if state.stats.game_state_code != next_code
                        || state.stats.game_state != next_label
                    {
                        state.stats.game_state_code = next_code;
                        state.stats.game_state = next_label.to_string();
                        should_emit_stats = true;
                    }
                }
                _ => {}
            }

            if let (Some(hits), Some(shots)) =
                (state.stats.accuracy_hits, state.stats.accuracy_shots)
            {
                let next_pct = if shots > 0 {
                    Some((hits as f64 / shots as f64) * 100.0)
                } else {
                    Some(0.0)
                };
                if state.stats.accuracy_pct.map_or(true, |prev| {
                    next_pct.map_or(true, |n| (prev - n).abs() > 0.0001)
                }) {
                    state.stats.accuracy_pct = next_pct;
                    should_emit_stats = true;
                }
            }

            let inferred = infer_scenario_type(&state.stats).to_string();
            if state.stats.scenario_type != inferred {
                state.stats.scenario_type = inferred;
                should_emit_stats = true;
            }

            let (next_game_state_code, next_game_state) = derive_game_state(&state.stats);
            if state.stats.game_state != next_game_state
                || state.stats.game_state_code != next_game_state_code
            {
                state.stats.game_state_code = next_game_state_code;
                state.stats.game_state = next_game_state.to_string();
                should_emit_stats = true;
            }

            if should_emit_stats {
                observe_run_stats_snapshot(&state.stats);
                let _ = app.emit(super::EVENT_STATS_PANEL_UPDATE, &state.stats);
            }

            let has_active_session_metrics = state.stats.is_in_challenge == Some(true)
                || state.stats.is_in_scenario == Some(true)
                || state
                    .stats
                    .challenge_seconds_total
                    .map_or(false, |v| v > 0.25)
                || state.stats.time_remaining.map_or(false, |v| v > 0.25)
                || state.stats.accuracy_shots.map_or(false, |v| v > 0)
                || state.stats.kills.map_or(false, |v| v > 0)
                || state.stats.damage_dealt.map_or(false, |v| v > 0.0)
                || state
                    .score_metric_total
                    .or(state.score_total_derived)
                    .map_or(false, |v| v > 0.0);
            let recovery_challenge_active = state.stats.is_in_challenge == Some(true)
                || state.stats.time_remaining.map_or(false, |v| v > 0.25)
                || state
                    .stats
                    .challenge_seconds_total
                    .map_or(false, |v| v > 0.25);
            recovery_signal = Some((has_active_session_metrics, recovery_challenge_active));
        }

        if let Some((has_active_metrics, challenge_active_hint)) = recovery_signal {
            let should_start_from_recovery = {
                let mut state = bridge_session_state().lock().unwrap();
                if state.session_active {
                    state.recovery_start_streak = 0;
                    false
                } else if has_active_metrics {
                    state.recovery_start_streak = state.recovery_start_streak.saturating_add(1);
                    if state.recovery_start_streak >= 2 {
                        state.recovery_start_streak = 0;
                        true
                    } else {
                        false
                    }
                } else {
                    state.recovery_start_streak = 0;
                    false
                }
            };
            if should_start_from_recovery {
                begin_session_tracking(app, "bridge:compat_recovery", challenge_active_hint);
            }
        }

        if let Some(ch) = emit_alias_ch {
            let synthetic = super::BridgeParsedEvent {
                ev: "ch".to_string(),
                value: Some(ch),
                total: None,
                delta: None,
                field: Some("is_in_challenge".to_string()),
                source: parsed.source.clone(),
                method: Some("compat_alias".to_string()),
                origin: Some("bridge_compat".to_string()),
                origin_flag: Some("bridge_compat".to_string()),
                fn_name: parsed.fn_name.clone(),
                receiver: parsed.receiver.clone(),
                raw: parsed.raw.clone(),
            };
            let _ = app.emit(super::BRIDGE_METRIC_EVENT, &synthetic);
        }

        if let Some(qrem) = emit_alias_qrem {
            let synthetic = super::BridgeParsedEvent {
                ev: "qrem".to_string(),
                value: Some(qrem),
                total: None,
                delta: None,
                field: Some("queue_time_remaining".to_string()),
                source: parsed.source.clone(),
                method: Some("compat_alias".to_string()),
                origin: Some("bridge_compat".to_string()),
                origin_flag: Some("bridge_compat".to_string()),
                fn_name: parsed.fn_name.clone(),
                receiver: parsed.receiver.clone(),
                raw: parsed.raw.clone(),
            };
            let _ = app.emit(super::BRIDGE_METRIC_EVENT, &synthetic);
        }
    }

    fn log_ring() -> &'static Mutex<VecDeque<String>> {
        static RING: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
        RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(LOG_RING_CAPACITY)))
    }

    fn push_log_line(line: String) {
        if let Ok(mut ring) = log_ring().lock() {
            ring.push_back(line);
            while ring.len() > LOG_RING_CAPACITY {
                let _ = ring.pop_front();
            }
        }
    }

    fn emit_ue4ss_log(app: &AppHandle, line: impl Into<String>) {
        let line = line.into();
        push_log_line(line.clone());
        let _ = app.emit(super::UE4SS_LOG_EVENT, line);
    }

    fn emit_bridge_log_line(line: impl Into<String>) {
        let line = line.into();
        if let Some(app) = LOG_APP_HANDLE.get() {
            emit_ue4ss_log(app, line);
        } else {
            push_log_line(line);
        }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    // ─── Pipe server ─────────────────────────────────────────────────────────

    pub fn start(app: AppHandle) {
        let _ = LOG_APP_HANDLE.set(app.clone());
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        start_session_idle_watchdog();
        if !COMMAND_PIPE_STARTED.swap(true, Ordering::SeqCst) {
            std::thread::Builder::new()
                .name("bridge-command-pipe".into())
                .spawn(command_pipe_loop)
                .ok();
        }
        std::thread::Builder::new()
            .name("bridge-pipe".into())
            .spawn(move || pipe_server_loop(app))
            .ok();
    }

    fn command_pipe_loop() {
        let name = to_wide(COMMAND_PIPE_NAME);
        // PIPE_ACCESS_OUTBOUND = 0x00000002
        let pipe = unsafe {
            CreateNamedPipeW(
                windows::core::PCWSTR(name.as_ptr()),
                windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0x00000002), // PIPE_ACCESS_OUTBOUND
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,     // max instances
                65536, // out buffer
                0,     // in buffer
                0,
                None,
            )
        };
        use windows::Win32::Foundation::INVALID_HANDLE_VALUE;
        if pipe == INVALID_HANDLE_VALUE {
            log::error!("bridge: CreateNamedPipe(command) failed");
            return;
        }

        loop {
            log::debug!("bridge: waiting for command pipe client");
            unsafe {
                let r = ConnectNamedPipe(pipe, None);
                if let Err(ref e) = r {
                    if e.code().0 != ERROR_PIPE_CONNECTED_HRESULT {
                        log::error!("bridge: command ConnectNamedPipe failed: {e}");
                        break;
                    }
                }
            }

            log::info!("bridge: command pipe connected");
            loop {
                let next_cmd = bridge_command_queue()
                    .lock()
                    .ok()
                    .and_then(|mut queue| queue.pop_front());

                let Some(command) = next_cmd else {
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                };

                let mut line = command;
                line.push('\n');
                let bytes = line.as_bytes();
                let mut written = 0u32;
                match unsafe { WriteFile(pipe, Some(bytes), Some(&mut written), None) } {
                    Ok(_) if written as usize == bytes.len() => {}
                    _ => {
                        log::warn!("bridge: command pipe write failed; awaiting reconnect");
                        break;
                    }
                }
            }

            unsafe {
                let _ = DisconnectNamedPipe(pipe);
            }
        }

        unsafe {
            let _ = CloseHandle(pipe);
        }
    }

    fn pipe_server_loop(app: AppHandle) {
        let name = to_wide("\\\\.\\pipe\\kovaaks-bridge");
        // PIPE_ACCESS_INBOUND = 0x00000001
        let pipe = unsafe {
            CreateNamedPipeW(
                windows::core::PCWSTR(name.as_ptr()),
                windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0x00000001), // PIPE_ACCESS_INBOUND
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,     // max instances
                0,     // out buffer (server only reads)
                65536, // in buffer
                0,     // default timeout
                None,  // default security
            )
        };
        use windows::Win32::Foundation::INVALID_HANDLE_VALUE;
        if pipe == INVALID_HANDLE_VALUE {
            log::error!("bridge: CreateNamedPipe failed");
            return;
        }

        mark_bridge_dll_connected(false);
        loop {
            log::debug!("bridge: waiting for DLL connection");
            unsafe {
                let r = ConnectNamedPipe(pipe, None);
                if let Err(ref e) = r {
                    // ERROR_PIPE_CONNECTED means the client connected before us — still good
                    if e.code().0 != ERROR_PIPE_CONNECTED_HRESULT {
                        log::error!("bridge: ConnectNamedPipe: {e}");
                        break;
                    }
                }
            }

            mark_bridge_dll_connected(true);
            log::info!("bridge: DLL connected — reading events");
            request_mod_state_sync("bridge_connected");
            read_events(pipe, &app);
            mark_bridge_dll_connected(false);
            log::info!("bridge: pipe disconnected — waiting for next connection");

            unsafe {
                let _ = DisconnectNamedPipe(pipe);
            }
        }

        unsafe {
            let _ = CloseHandle(pipe);
        }
    }

    fn read_events(pipe: HANDLE, app: &AppHandle) {
        let mut buf: Vec<u8> = Vec::with_capacity(4096);
        let mut tmp = [0u8; 512];
        loop {
            let mut nread: u32 = 0;
            match unsafe { ReadFile(pipe, Some(&mut tmp), Some(&mut nread), None) } {
                Ok(_) if nread > 0 => {
                    buf.extend_from_slice(&tmp[..nread as usize]);
                    // Drain all complete newline-terminated lines
                    while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
                        let chunk: Vec<u8> = buf.drain(..=nl).collect();
                        if let Ok(s) = std::str::from_utf8(&chunk[..chunk.len() - 1]) {
                            let processed =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    note_in_game_replay_event(s);
                                    observe_replay_stream_raw(s);
                                    let parsed_event = super::parse_bridge_payload(s);
                                    let is_noisy_bridge_event = |ev: &str| {
                                        matches!(
                                            ev,
                                            "process_event_activity"
                                                | "hook_probe"
                                                | "hook_focus_probe"
                                                | "hook_focus_probe_typed"
                                                | "class_hook_probe"
                                                | "script_hook_probe"
                                        )
                                    };
                                    let suppress_bridge_log_event = parsed_event
                                        .as_ref()
                                        .map_or(false, |parsed| is_noisy_bridge_event(&parsed.ev));
                                    if !suppress_bridge_log_event {
                                        log::info!("bridge event: {s}");
                                        emit_ue4ss_log(app, format!("[bridge] {s}"));
                                        let _ = app.emit(super::BRIDGE_EVENT, s.to_owned());
                                    }
                                    if let Some(parsed) = parsed_event {
                                        observe_run_metric_event(&parsed);
                                        // Always run compat handlers, even for noisy events
                                        // (e.g. class_hook_probe) because they can drive
                                        // lifecycle/state normalization.
                                        emit_bridge_compat_events(app, &parsed);
                                        if is_stats_flow_event(&parsed) {
                                            mark_stats_flow_activity(
                                                parsed.ev.as_str(),
                                                parsed.ev.starts_with("pull_"),
                                            );
                                        }
                                        if is_noisy_bridge_event(&parsed.ev) {
                                            return;
                                        }
                                        let _ = app.emit(super::BRIDGE_PARSED_EVENT, &parsed);
                                        if super::is_metric_event_name(&parsed.ev) {
                                            let _ = app.emit(super::BRIDGE_METRIC_EVENT, &parsed);
                                        }
                                    }
                                }));
                            if processed.is_err() {
                                log::error!(
                                    "bridge: panic while processing bridge event line; continuing"
                                );
                            }
                        }
                    }
                }
                // Pipe broken or zero bytes — client disconnected
                _ => break,
            }
        }
    }

    fn files_identical(a: &Path, b: &Path) -> Result<bool, String> {
        let ma =
            std::fs::metadata(a).map_err(|e| format!("Failed to stat {}: {}", a.display(), e))?;
        let mb =
            std::fs::metadata(b).map_err(|e| format!("Failed to stat {}: {}", b.display(), e))?;
        if ma.len() != mb.len() {
            return Ok(false);
        }
        let mut fa =
            std::fs::File::open(a).map_err(|e| format!("Failed to open {}: {}", a.display(), e))?;
        let mut fb =
            std::fs::File::open(b).map_err(|e| format!("Failed to open {}: {}", b.display(), e))?;
        let mut ba = [0u8; 64 * 1024];
        let mut bb = [0u8; 64 * 1024];
        loop {
            let na = fa
                .read(&mut ba)
                .map_err(|e| format!("Failed to read {}: {}", a.display(), e))?;
            let nb = fb
                .read(&mut bb)
                .map_err(|e| format!("Failed to read {}: {}", b.display(), e))?;
            if na != nb {
                return Ok(false);
            }
            if na == 0 {
                break;
            }
            if ba[..na] != bb[..na] {
                return Ok(false);
            }
        }
        Ok(true)
    }

    // ─── DLL injector ────────────────────────────────────────────────────────

    pub fn deploy_and_inject(resource_dir: &Path, stats_dir: &str) -> Result<(), String> {
        let payload_root = resource_dir.join("ue4ss");
        if !payload_root.is_dir() {
            return Err(format!(
                "UE4SS payload missing at {} (expected bundled resource folder `ue4ss`)",
                payload_root.display()
            ));
        }

        let game_bin_dir = resolve_game_bin_dir(stats_dir)?;
        let flags_before_sync = read_runtime_flags_for_dir(&game_bin_dir);
        log::info!(
            "bridge: runtime flags before sync profile={} enable_pe_hook={} disable_pe_hook={} discovery={} safe_mode={} no_rust={} log_all_events={} object_debug={} non_ui_probe={} hook_process_internal={} hook_process_local_script={} class_probe_hooks={}",
            flags_before_sync.profile,
            flags_before_sync.enable_pe_hook,
            flags_before_sync.disable_pe_hook,
            flags_before_sync.discovery,
            flags_before_sync.safe_mode,
            flags_before_sync.no_rust,
            flags_before_sync.log_all_events,
            flags_before_sync.object_debug,
            flags_before_sync.non_ui_probe,
            flags_before_sync.hook_process_internal,
            flags_before_sync.hook_process_local_script,
            flags_before_sync.class_probe_hooks
        );
        emit_bridge_log_line(format!(
            "[bridge] runtime flags before sync profile={} enable_pe_hook={} disable_pe_hook={} discovery={} safe_mode={} no_rust={} log_all_events={} object_debug={} non_ui_probe={} hook_process_internal={} hook_process_local_script={} class_probe_hooks={}",
            flags_before_sync.profile,
            flags_before_sync.enable_pe_hook,
            flags_before_sync.disable_pe_hook,
            flags_before_sync.discovery,
            flags_before_sync.safe_mode,
            flags_before_sync.no_rust,
            flags_before_sync.log_all_events,
            flags_before_sync.object_debug,
            flags_before_sync.non_ui_probe,
            flags_before_sync.hook_process_internal,
            flags_before_sync.hook_process_local_script,
            flags_before_sync.class_probe_hooks
        ));
        let pid = find_process(GAME_EXE);
        let already_loaded = pid
            .map(|p| find_loaded_module(p, UE4SS_DLL).is_some())
            .unwrap_or(false);
        sync_payload(&payload_root, &game_bin_dir, already_loaded)?;
        sync_in_game_overlay_bundle(resource_dir, &game_bin_dir, already_loaded)?;
        let managed_mod_dll = game_bin_dir
            .join("Mods")
            .join("KovaaksBridgeMod")
            .join("dlls")
            .join("main.dll");
        let managed_mod_enabled = game_bin_dir
            .join("Mods")
            .join("KovaaksBridgeMod")
            .join("enabled.txt");
        let managed_rust_core = game_bin_dir.join("kovaaks_rust_core.dll");
        if !managed_mod_dll.is_file() {
            return Err(format!(
                "Runtime DLL missing after sync: {}",
                managed_mod_dll.display()
            ));
        }
        if !managed_mod_enabled.is_file() {
            return Err(format!(
                "Runtime enabled marker missing after sync: {}",
                managed_mod_enabled.display()
            ));
        }
        if !managed_rust_core.is_file() {
            return Err(format!(
                "Rust bridge DLL missing after sync: {}",
                managed_rust_core.display()
            ));
        }
        emit_bridge_log_line(format!(
            "[bridge] runtime payload present: main.dll={} enabled.txt={} rust_core={}",
            managed_mod_dll.display(),
            managed_mod_enabled.display(),
            managed_rust_core.display()
        ));
        let payload_mod_dll = payload_root
            .join("Mods")
            .join("KovaaksBridgeMod")
            .join("dlls")
            .join("main.dll");
        let payload_rust_core = payload_root.join("kovaaks_rust_core.dll");
        if payload_mod_dll.is_file() {
            match files_identical(&payload_mod_dll, &managed_mod_dll) {
                Ok(true) => emit_bridge_log_line("[bridge] runtime DLL is up to date"),
                Ok(false) => {
                    log::warn!(
                        "bridge: runtime DLL differs from staged payload (likely locked while running): {}",
                        managed_mod_dll.display()
                    );
                    emit_bridge_log_line(format!(
                        "[bridge] warning: runtime DLL differs from staged payload; restart game to apply: {}",
                        managed_mod_dll.display()
                    ));
                }
                Err(e) => {
                    log::warn!("bridge: could not compare runtime DLLs: {e}");
                }
            }
        }
        if payload_rust_core.is_file() {
            match files_identical(&payload_rust_core, &managed_rust_core) {
                Ok(true) => emit_bridge_log_line("[bridge] rust core dll is up to date"),
                Ok(false) => {
                    log::warn!(
                        "bridge: rust core DLL differs from staged payload (likely locked while running): {}",
                        managed_rust_core.display()
                    );
                    emit_bridge_log_line(format!(
                        "[bridge] warning: rust core dll differs from staged payload; restart game to apply: {}",
                        managed_rust_core.display()
                    ));
                }
                Err(e) => {
                    log::warn!("bridge: could not compare rust core DLLs: {e}");
                }
            }
        }
        let flags_after_sync = read_runtime_flags_for_dir(&game_bin_dir);
        if flags_after_sync != flags_before_sync {
            log::warn!(
                "bridge: runtime flags changed by sync before={:?} after={:?}",
                flags_before_sync,
                flags_after_sync
            );
            emit_bridge_log_line(format!(
                "[bridge] runtime flags changed by sync before={:?} after={:?}",
                flags_before_sync, flags_after_sync
            ));
        } else {
            emit_bridge_log_line(format!(
                "[bridge] runtime flags unchanged after sync profile={} enable_pe_hook={} disable_pe_hook={} discovery={} safe_mode={} no_rust={} log_all_events={} object_debug={} non_ui_probe={} hook_process_internal={} hook_process_local_script={} class_probe_hooks={}",
                flags_after_sync.profile,
                flags_after_sync.enable_pe_hook,
                flags_after_sync.disable_pe_hook,
                flags_after_sync.discovery,
                flags_after_sync.safe_mode,
                flags_after_sync.no_rust,
                flags_after_sync.log_all_events,
                flags_after_sync.object_debug,
                flags_after_sync.non_ui_probe,
                flags_after_sync.hook_process_internal,
                flags_after_sync.hook_process_local_script,
                flags_after_sync.class_probe_hooks
            ));
        }
        log::info!(
            "bridge: UE4SS payload deployed to {}",
            game_bin_dir.display()
        );
        start_log_tailer_for_bin_dir(game_bin_dir.clone(), None);

        let ue4ss_path = game_bin_dir.join(UE4SS_DLL);
        if !ue4ss_path.is_file() {
            return Err(format!(
                "UE4SS runtime not found after deploy: {}",
                ue4ss_path.display()
            ));
        }

        let pid = match pid {
            Some(pid) => pid,
            None => return Err(format!("{GAME_EXE} is not running")),
        };

        if already_loaded {
            log::warn!(
                "bridge: UE4SS already loaded in pid {pid}; payload synced. \
                 Runtime/settings changes require game restart."
            );
            match trigger_hot_reload() {
                Ok(()) => {
                    log::info!("bridge: triggered UE4SS hot reload after payload sync");
                }
                Err(e) => {
                    log::warn!("bridge: UE4SS hot reload failed after payload sync: {e}");
                }
            }
            return Ok(());
        }

        inject(
            ue4ss_path
                .to_str()
                .ok_or_else(|| "UE4SS DLL path is not valid UTF-8".to_string())?,
        )
    }

    pub fn inject(dll_path: &str) -> Result<(), String> {
        log::info!("bridge: injecting {dll_path}");
        let pid = match find_process(GAME_EXE) {
            Some(pid) => pid,
            None => {
                log::error!("bridge: could not find process {GAME_EXE}");
                return Err(format!("{GAME_EXE} is not running"));
            }
        };

        if find_loaded_module(pid, UE4SS_DLL).is_some() {
            log::info!("bridge: UE4SS already loaded in pid {pid} — skipping injection");
            return Ok(());
        }

        if let Err(reason) = ensure_game_ready_for_injection(pid) {
            log::info!("bridge: deferring injection into pid {pid}: {reason}");
            return Err(reason);
        }

        match inject_dll(pid, dll_path) {
            Ok(()) => Ok(()),
            Err(e) => {
                log::error!("bridge: DLL injection failed: {e}");
                Err(e)
            }
        }
    }

    pub fn start_log_tailer(app: AppHandle, stats_dir: &str) -> Result<(), String> {
        let game_bin_dir = resolve_game_bin_dir(stats_dir)?;
        start_log_tailer_for_bin_dir(game_bin_dir, Some(app));
        Ok(())
    }

    fn start_log_tailer_for_bin_dir(game_bin_dir: PathBuf, app: Option<AppHandle>) {
        if let Some(ref app) = app {
            let _ = LOG_APP_HANDLE.set(app.clone());
        }
        if LOG_TAILER_STARTED.swap(true, Ordering::SeqCst) {
            return;
        }

        std::thread::Builder::new()
            .name("ue4ss-log-tail".into())
            .spawn(move || ue4ss_log_tail_loop(game_bin_dir, app))
            .ok();
    }

    pub fn recent_logs(limit: usize) -> Vec<String> {
        let cap = limit.clamp(1, LOG_RING_CAPACITY);
        if let Ok(ring) = log_ring().lock() {
            let len = ring.len();
            let start = len.saturating_sub(cap);
            return ring.iter().skip(start).cloned().collect();
        }
        Vec::new()
    }

    fn ue4ss_log_tail_loop(game_bin_dir: PathBuf, app: Option<AppHandle>) {
        struct TailState {
            path: PathBuf,
            tag: &'static str,
            offset: u64,
            carry: String,
            announced: bool,
        }

        let mut states = vec![
            TailState {
                path: game_bin_dir.join("UE4SS.log"),
                tag: "ue4ss",
                offset: 0,
                carry: String::new(),
                announced: false,
            },
            TailState {
                path: game_bin_dir.join("ue4ss.log"),
                tag: "ue4ss",
                offset: 0,
                carry: String::new(),
                announced: false,
            },
            TailState {
                path: game_bin_dir.join("UE4SS.log.txt"),
                tag: "ue4ss",
                offset: 0,
                carry: String::new(),
                announced: false,
            },
            TailState {
                path: game_bin_dir.join("UE4SS").join("UE4SS.log"),
                tag: "ue4ss",
                offset: 0,
                carry: String::new(),
                announced: false,
            },
            TailState {
                path: game_bin_dir.join("KovaaksBridgeMod.runtime.log"),
                tag: "kmod",
                offset: 0,
                carry: String::new(),
                announced: false,
            },
            TailState {
                path: game_bin_dir.join("KovaaksBridgeMod.trace.log"),
                tag: "kmod-trace",
                offset: 0,
                carry: String::new(),
                announced: false,
            },
            TailState {
                path: game_bin_dir.join("KovaaksBridgeMod.events.log"),
                tag: "kmod-events",
                offset: 0,
                carry: String::new(),
                announced: false,
            },
        ];

        loop {
            for state in &mut states {
                match std::fs::metadata(&state.path) {
                    Ok(meta) => {
                        if !state.announced {
                            state.offset = meta.len().saturating_sub(16 * 1024);
                            if let Some(ref app) = app {
                                emit_ue4ss_log(
                                    app,
                                    format!("[ue4ss-log] tailing {}", state.path.display()),
                                );
                            }
                            state.announced = true;
                        }

                        if meta.len() < state.offset {
                            state.offset = 0;
                            state.carry.clear();
                        }
                        if meta.len() <= state.offset {
                            continue;
                        }

                        match std::fs::File::open(&state.path) {
                            Ok(mut f) => {
                                if f.seek(SeekFrom::Start(state.offset)).is_err() {
                                    continue;
                                }
                                let mut bytes = Vec::new();
                                if f.read_to_end(&mut bytes).is_err() {
                                    continue;
                                }
                                state.offset = meta.len();
                                if bytes.is_empty() {
                                    continue;
                                }

                                let chunk = String::from_utf8_lossy(&bytes);
                                let text = if state.carry.is_empty() {
                                    chunk.into_owned()
                                } else {
                                    let mut merged = state.carry.clone();
                                    merged.push_str(&chunk);
                                    state.carry.clear();
                                    merged
                                };

                                let ended_with_newline = text.ends_with('\n');
                                let mut lines: Vec<&str> = text.lines().collect();
                                if !ended_with_newline {
                                    if let Some(last) = lines.pop() {
                                        state.carry = last.to_string();
                                    }
                                }

                                for line in lines {
                                    let line = line.trim_end_matches('\r').trim();
                                    if line.is_empty() {
                                        continue;
                                    }
                                    let out = format!("[{}] {}", state.tag, line);
                                    push_log_line(out.clone());
                                    if let Some(ref app) = app {
                                        let _ = app.emit(super::UE4SS_LOG_EVENT, out);
                                    }
                                }
                            }
                            Err(_) => {
                                state.offset = 0;
                                state.carry.clear();
                                state.announced = false;
                            }
                        }
                    }
                    Err(_) => {
                        state.offset = 0;
                        state.carry.clear();
                        state.announced = false;
                    }
                }
            }

            std::thread::sleep(Duration::from_millis(300));
        }
    }

    pub fn trigger_hot_reload() -> Result<(), String> {
        let pid = match find_process(GAME_EXE) {
            Some(pid) => pid,
            None => return Err(format!("{GAME_EXE} is not running")),
        };

        // Hot reload keybind is consumed by the game, so bring KovaaK's to foreground first.
        if let Some(hwnd) = find_main_window_for_pid(pid) {
            unsafe {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                let _ = SetForegroundWindow(hwnd);
            }
            std::thread::sleep(Duration::from_millis(40));
        } else {
            log::warn!("bridge: could not find KovaaK window for hot reload keybind");
        }

        if find_loaded_module(pid, UE4SS_DLL).is_none() {
            return Err("AimMod runtime is not loaded; launch AimMod first".to_string());
        }

        if find_process(GAME_EXE).is_none() {
            return Err(format!("{GAME_EXE} is not running"));
        }

        let ctrl = VK_CONTROL.0 as u16;
        let r = b'R' as u16;
        let inputs = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(ctrl),
                        wScan: 0,
                        dwFlags: KEYBD_EVENT_FLAGS(0),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(r),
                        wScan: 0,
                        dwFlags: KEYBD_EVENT_FLAGS(0),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(r),
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(ctrl),
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];

        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent == 0 {
            return Err("SendInput failed for Ctrl+R".to_string());
        }
        Ok(())
    }

    pub fn current_game_pid() -> Option<u32> {
        find_process(GAME_EXE)
    }

    pub fn is_ue4ss_loaded_for_pid(pid: u32) -> bool {
        find_loaded_module(pid, UE4SS_DLL).is_some()
    }

    pub fn get_runtime_flags(stats_dir: &str) -> Result<super::RuntimeFlagState, String> {
        let game_bin_dir = resolve_game_bin_dir(stats_dir)?;
        let state = read_runtime_flags_for_dir(&game_bin_dir);
        log::info!(
            "bridge: detected runtime flags profile={} enable_pe_hook={} disable_pe_hook={} discovery={} safe_mode={} no_rust={} log_all_events={} object_debug={} non_ui_probe={} hook_process_internal={} hook_process_local_script={} class_probe_hooks={} allow_unsafe_hooks={}",
            state.profile,
            state.enable_pe_hook,
            state.disable_pe_hook,
            state.discovery,
            state.safe_mode,
            state.no_rust,
            state.log_all_events,
            state.object_debug,
            state.non_ui_probe,
            state.hook_process_internal,
            state.hook_process_local_script,
            state.class_probe_hooks,
            state.allow_unsafe_hooks
        );
        emit_bridge_log_line(format!(
            "[bridge] runtime flags detected profile={} enable_pe_hook={} disable_pe_hook={} discovery={} safe_mode={} no_rust={} log_all_events={} object_debug={} non_ui_probe={} hook_process_internal={} hook_process_local_script={} class_probe_hooks={} allow_unsafe_hooks={}",
            state.profile,
            state.enable_pe_hook,
            state.disable_pe_hook,
            state.discovery,
            state.safe_mode,
            state.no_rust,
            state.log_all_events,
            state.object_debug,
            state.non_ui_probe,
            state.hook_process_internal,
            state.hook_process_local_script,
            state.class_probe_hooks,
            state.allow_unsafe_hooks
        ));
        Ok(state)
    }

    fn read_runtime_flags_for_dir(game_bin_dir: &Path) -> super::RuntimeFlagState {
        let profile = std::fs::read_to_string(game_bin_dir.join(PAYLOAD_PROFILE_FILE))
            .map(|s| s.trim().to_ascii_lowercase())
            .unwrap_or_else(|_| "unknown".to_string());
        let detour_callbacks = game_bin_dir
            .join("kovaaks_enable_detour_callbacks.flag")
            .is_file();
        let hook_process_event_legacy = game_bin_dir
            .join("kovaaks_hook_process_event.flag")
            .is_file();
        super::RuntimeFlagState {
            profile,
            enable_pe_hook: game_bin_dir.join("kovaaks_enable_pe_hook.flag").is_file(),
            disable_pe_hook: game_bin_dir.join("kovaaks_disable_pe_hook.flag").is_file(),
            discovery: game_bin_dir.join("kovaaks_discovery.flag").is_file(),
            safe_mode: game_bin_dir.join("kovaaks_safe_mode.flag").is_file(),
            no_rust: game_bin_dir.join("kovaaks_no_rust.flag").is_file(),
            log_all_events: game_bin_dir.join("kovaaks_log_all_events.flag").is_file(),
            object_debug: game_bin_dir.join("kovaaks_object_debug.flag").is_file(),
            non_ui_probe: game_bin_dir.join("kovaaks_non_ui_probe.flag").is_file(),
            ui_counter_fallback: game_bin_dir
                .join("kovaaks_ui_counter_fallback.flag")
                .is_file(),
            score_ui_fallback: game_bin_dir
                .join("kovaaks_score_ui_fallback.flag")
                .is_file(),
            hook_process_internal: game_bin_dir
                .join("kovaaks_hook_process_internal.flag")
                .is_file(),
            hook_process_local_script: game_bin_dir
                .join("kovaaks_hook_process_local_script.flag")
                .is_file(),
            class_probe_hooks: game_bin_dir
                .join("kovaaks_class_probe_hooks.flag")
                .is_file(),
            class_probe_scalar_reads: game_bin_dir
                .join("kovaaks_class_probe_scalar_reads.flag")
                .is_file(),
            class_probe_scan_all: game_bin_dir
                .join("kovaaks_class_probe_scan_all.flag")
                .is_file(),
            allow_unsafe_hooks: game_bin_dir
                .join("kovaaks_allow_unsafe_hooks.flag")
                .is_file(),
            native_hooks: game_bin_dir.join("kovaaks_native_hooks.flag").is_file(),
            hook_process_event: detour_callbacks || hook_process_event_legacy,
            detour_callbacks,
            direct_pull_invoke: game_bin_dir
                .join("kovaaks_enable_direct_pull_invoke.flag")
                .is_file(),
            experimental_runtime: game_bin_dir
                .join("kovaaks_enable_experimental_runtime.flag")
                .is_file(),
            ui_settext_hook: game_bin_dir.join("kovaaks_ui_settext_hook.flag").is_file(),
            ui_widget_probe: game_bin_dir.join("kovaaks_ui_widget_probe.flag").is_file(),
            in_game_overlay: game_bin_dir.join("kovaaks_in_game_overlay.flag").is_file(),
        }
    }

    pub fn set_runtime_flag(stats_dir: &str, key: &str, enabled: bool) -> Result<(), String> {
        let game_bin_dir = resolve_game_bin_dir(stats_dir)?;
        let files: Vec<&str> = match key {
            "enable_pe_hook" => vec!["kovaaks_enable_pe_hook.flag"],
            "disable_pe_hook" => vec!["kovaaks_disable_pe_hook.flag"],
            "discovery" => vec!["kovaaks_discovery.flag"],
            "safe_mode" => vec!["kovaaks_safe_mode.flag"],
            "no_rust" => vec!["kovaaks_no_rust.flag"],
            "log_all_events" => vec!["kovaaks_log_all_events.flag"],
            "object_debug" => vec!["kovaaks_object_debug.flag"],
            "non_ui_probe" => vec!["kovaaks_non_ui_probe.flag"],
            "ui_counter_fallback" => vec!["kovaaks_ui_counter_fallback.flag"],
            "score_ui_fallback" => vec!["kovaaks_score_ui_fallback.flag"],
            "hook_process_internal" => vec!["kovaaks_hook_process_internal.flag"],
            "hook_process_local_script" => vec!["kovaaks_hook_process_local_script.flag"],
            "class_probe_hooks" => vec!["kovaaks_class_probe_hooks.flag"],
            "class_probe_scalar_reads" => vec!["kovaaks_class_probe_scalar_reads.flag"],
            "class_probe_scan_all" => vec!["kovaaks_class_probe_scan_all.flag"],
            "allow_unsafe_hooks" => vec!["kovaaks_allow_unsafe_hooks.flag"],
            "native_hooks" => vec!["kovaaks_native_hooks.flag"],
            "hook_process_event" | "detour_callbacks" => vec![
                "kovaaks_enable_detour_callbacks.flag",
                "kovaaks_hook_process_event.flag",
            ],
            "direct_pull_invoke" => vec!["kovaaks_enable_direct_pull_invoke.flag"],
            "experimental_runtime" => vec!["kovaaks_enable_experimental_runtime.flag"],
            "ui_settext_hook" => vec!["kovaaks_ui_settext_hook.flag"],
            "ui_widget_probe" => vec!["kovaaks_ui_widget_probe.flag"],
            "in_game_overlay" => vec!["kovaaks_in_game_overlay.flag"],
            _ => return Err(format!("Unknown UE4SS runtime flag key: {key}")),
        };

        let mut touched_any = false;
        for file in files {
            let path = game_bin_dir.join(file);
            if enabled {
                std::fs::write(&path, b"1")
                    .map_err(|e| format!("Failed to create {}: {}", path.display(), e))?;
                touched_any = true;
            } else if path.exists() {
                std::fs::remove_file(&path)
                    .map_err(|e| format!("Failed to remove {}: {}", path.display(), e))?;
                touched_any = true;
            }
        }

        if touched_any {
            log::info!(
                "bridge: set runtime flag {}={} (updated)",
                key,
                if enabled { 1 } else { 0 }
            );
            emit_bridge_log_line(format!(
                "[bridge] runtime flag set {}={} (updated)",
                key,
                if enabled { 1 } else { 0 }
            ));
        } else {
            log::info!(
                "bridge: runtime flag {} already {}",
                key,
                if enabled { 1 } else { 0 }
            );
            emit_bridge_log_line(format!(
                "[bridge] runtime flag already {}={}",
                key,
                if enabled { 1 } else { 0 }
            ));
        }
        Ok(())
    }

    pub fn request_runtime_flag_reload(stats_dir: &str) -> Result<(), String> {
        let game_bin_dir = resolve_game_bin_dir(stats_dir)?;
        let path = game_bin_dir.join("kovaaks_reload_flags.flag");
        std::fs::write(&path, b"1")
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
        log::info!("bridge: requested runtime flag reload ({})", path.display());
        emit_bridge_log_line(format!(
            "[bridge] requested runtime flag reload ({})",
            path.display()
        ));
        Ok(())
    }

    fn find_main_window_for_pid(pid: u32) -> Option<HWND> {
        struct EnumCtx {
            pid: u32,
            hwnd: HWND,
        }

        unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let ctx = &mut *(lparam.0 as *mut EnumCtx);
            let mut win_pid = 0u32;
            let _ = GetWindowThreadProcessId(hwnd, Some(&mut win_pid));
            if win_pid != ctx.pid {
                return BOOL(1);
            }
            if !IsWindowVisible(hwnd).as_bool() {
                return BOOL(1);
            }
            let has_owner = match GetWindow(hwnd, GW_OWNER) {
                Ok(owner) => !owner.is_invalid(),
                Err(_) => false,
            };
            if has_owner {
                return BOOL(1);
            }
            ctx.hwnd = hwnd;
            BOOL(0)
        }

        let mut ctx = EnumCtx {
            pid,
            hwnd: HWND::default(),
        };
        unsafe {
            let _ = EnumWindows(
                Some(enum_windows_proc),
                LPARAM((&mut ctx as *mut EnumCtx) as isize),
            );
        }
        if ctx.hwnd.is_invalid() {
            None
        } else {
            Some(ctx.hwnd)
        }
    }

    /// Scan the module list of `pid` for a DLL whose name matches `dll_name` (case-insensitive).
    /// Returns the module base address if found.
    fn find_loaded_module(pid: u32, dll_name: &str) -> Option<*mut std::ffi::c_void> {
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid).ok()?;
            let mut entry = MODULEENTRY32W {
                dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
                ..Default::default()
            };
            if Module32FirstW(snap, &mut entry).is_ok() {
                loop {
                    let len = entry
                        .szModule
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szModule.len());
                    let name = String::from_utf16_lossy(&entry.szModule[..len]);
                    if name.eq_ignore_ascii_case(dll_name) {
                        let _ = CloseHandle(snap);
                        return Some(entry.modBaseAddr as *mut std::ffi::c_void);
                    }
                    if Module32NextW(snap, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
            None
        }
    }

    fn find_process(exe_name: &str) -> Option<u32> {
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut entry).is_ok() {
                loop {
                    let len = entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                    if name.eq_ignore_ascii_case(exe_name) {
                        let _ = CloseHandle(snap);
                        return Some(entry.th32ProcessID);
                    }
                    if Process32NextW(snap, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
            None
        }
    }

    fn inject_dll(pid: u32, dll_path: &str) -> Result<(), String> {
        let dll_wide = to_wide(dll_path);
        let dll_bytes = dll_wide.len() * std::mem::size_of::<u16>();

        unsafe {
            let proc = match OpenProcess(PROCESS_ALL_ACCESS, false, pid) {
                Ok(proc) => proc,
                Err(e) => {
                    log::error!("bridge: OpenProcess failed: {e}");
                    return Err(format!("OpenProcess: {e}"));
                }
            };

            let remote = VirtualAllocEx(
                proc,
                None,
                dll_bytes,
                MEM_COMMIT | MEM_RESERVE,
                PAGE_READWRITE,
            );
            if remote.is_null() {
                log::error!("bridge: VirtualAllocEx failed");
                let _ = CloseHandle(proc);
                return Err("VirtualAllocEx failed".into());
            }

            if let Err(e) =
                WriteProcessMemory(proc, remote, dll_wide.as_ptr().cast(), dll_bytes, None)
            {
                log::error!("bridge: WriteProcessMemory failed: {e}");
                let _ = VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
                let _ = CloseHandle(proc);
                return Err(format!("WriteProcessMemory: {e}"));
            }

            let k32 = match GetModuleHandleW(windows::core::w!("kernel32.dll")) {
                Ok(h) => h,
                Err(e) => {
                    log::error!("bridge: GetModuleHandleW failed: {e}");
                    let _ = VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
                    let _ = CloseHandle(proc);
                    return Err(format!("GetModuleHandleW: {e}"));
                }
            };
            let load_lib = match GetProcAddress(k32, PCSTR(b"LoadLibraryW\0".as_ptr())) {
                Some(addr) => addr,
                None => {
                    log::error!("bridge: GetProcAddress(LoadLibraryW) failed");
                    let _ = VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
                    let _ = CloseHandle(proc);
                    return Err("GetProcAddress(LoadLibraryW) failed".into());
                }
            };

            let thread = match CreateRemoteThread(
                proc,
                None,
                0,
                Some(std::mem::transmute(load_lib)),
                Some(remote.cast_const()),
                0u32, // flags
                None,
            ) {
                Ok(thread) => thread,
                Err(e) => {
                    log::error!("bridge: CreateRemoteThread failed: {e}");
                    let _ = VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
                    let _ = CloseHandle(proc);
                    return Err(format!("CreateRemoteThread: {e}"));
                }
            };

            // Wait up to 5 s for the DLL to load, then clean up
            WaitForSingleObject(thread, 5000);
            let _ = CloseHandle(thread);
            let _ = VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
            let _ = CloseHandle(proc);
        }

        log::info!("bridge: successfully injected into pid {pid}");
        Ok(())
    }

    fn resolve_game_bin_dir(stats_dir: &str) -> Result<PathBuf, String> {
        let stats = PathBuf::from(stats_dir);
        let game_root = stats
            .parent()
            .ok_or_else(|| format!("Invalid stats dir: {}", stats.display()))?;
        let bin_dir = game_root.join("Binaries").join("Win64");
        if !bin_dir.exists() {
            return Err(format!(
                "KovaaK's Binaries/Win64 not found at {} (from stats_dir={})",
                bin_dir.display(),
                stats_dir
            ));
        }
        Ok(bin_dir)
    }

    fn to_file_url(path: &Path) -> String {
        let mut normalized = path.to_string_lossy().replace('\\', "/");
        if !normalized.starts_with('/') {
            normalized.insert(0, '/');
        }
        let encoded = normalized.replace(' ', "%20");
        format!("file://{encoded}")
    }

    fn write_in_game_overlay_url(
        game_bin_dir: &Path,
        overlay_index: &Path,
    ) -> Result<String, String> {
        if !overlay_index.is_file() {
            return Err(format!(
                "In-game browser index file not found: {}",
                overlay_index.display()
            ));
        }

        let overlay_url = to_file_url(overlay_index);
        let overlay_url_path = game_bin_dir.join(IN_GAME_OVERLAY_URL_FILE);
        std::fs::write(&overlay_url_path, format!("{}\n", overlay_url)).map_err(|e| {
            format!(
                "Failed to write in-game overlay URL file {}: {}",
                overlay_url_path.display(),
                e
            )
        })?;

        emit_bridge_log_line(format!(
            "[bridge] in-game browser URL file written path={} url={}",
            overlay_url_path.display(),
            overlay_url
        ));

        Ok(overlay_url)
    }

    fn resolve_in_game_overlay_dist_source(resource_dir: &Path) -> Option<PathBuf> {
        let primary = resource_dir.join(IN_GAME_OVERLAY_DIST_DIR);
        if primary.is_dir() {
            return Some(primary);
        }

        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                for ancestor in exe_dir.ancestors().take(10) {
                    let candidate = ancestor.join(IN_GAME_OVERLAY_DIST_DIR);
                    if candidate.is_dir() {
                        return Some(candidate);
                    }
                }
            }
        }

        if let Some(manifest_dir) = option_env!("CARGO_MANIFEST_DIR") {
            let manifest_path = Path::new(manifest_dir);
            if let Some(repo_root) = manifest_path.parent() {
                let candidate = repo_root.join(IN_GAME_OVERLAY_DIST_DIR);
                if candidate.is_dir() {
                    return Some(candidate);
                }
            }
        }

        None
    }

    fn sync_in_game_overlay_bundle(
        resource_dir: &Path,
        game_bin_dir: &Path,
        tolerate_locked_files: bool,
    ) -> Result<(), String> {
        let dist_src = resolve_in_game_overlay_dist_source(resource_dir);
        if dist_src.is_none() {
            let existing_index = game_bin_dir
                .join(IN_GAME_OVERLAY_TARGET_DIR)
                .join(IN_GAME_OVERLAY_INDEX_FILE);
            if existing_index.is_file() {
                let overlay_url = write_in_game_overlay_url(game_bin_dir, &existing_index)?;
                log::info!(
                    "bridge: reusing existing in-game browser bundle index={} url={}",
                    existing_index.display(),
                    overlay_url
                );
                return Ok(());
            }

            log::warn!(
                "bridge: bundled frontend dist not found at {}; skipping in-game browser payload sync",
                resource_dir.join(IN_GAME_OVERLAY_DIST_DIR).display()
            );
            emit_bridge_log_line(format!(
                "[bridge] in-game browser bundle missing at {} (skipped)",
                resource_dir.join(IN_GAME_OVERLAY_DIST_DIR).display()
            ));
            return Ok(());
        }
        let dist_src = dist_src.expect("checked is_some");

        let dist_dst = game_bin_dir.join(IN_GAME_OVERLAY_TARGET_DIR);
        if dist_dst.exists() {
            if let Err(e) = std::fs::remove_dir_all(&dist_dst) {
                if tolerate_locked_files && is_permission_denied(&e) {
                    log::warn!(
                        "bridge: could not replace in-game browser bundle (in use): {} ({})",
                        dist_dst.display(),
                        e
                    );
                } else {
                    return Err(format!(
                        "Failed to replace in-game browser bundle {}: {}",
                        dist_dst.display(),
                        e
                    ));
                }
            }
        }

        let mut copied_paths = Vec::new();
        let copied = copy_dir_recursive(
            &dist_src,
            &dist_dst,
            &dist_src,
            "full",
            tolerate_locked_files,
            &mut copied_paths,
        )?;

        let overlay_index = dist_dst.join(IN_GAME_OVERLAY_INDEX_FILE);
        if !overlay_index.is_file() {
            log::warn!(
                "bridge: in-game browser bundle missing index file after sync: {}",
                overlay_index.display()
            );
            emit_bridge_log_line(format!(
                "[bridge] in-game browser bundle missing {} (copied files={})",
                overlay_index.display(),
                copied
            ));
            return Ok(());
        }

        let overlay_url = write_in_game_overlay_url(game_bin_dir, &overlay_index)?;

        log::info!(
            "bridge: synced in-game browser bundle files={} src={} dst={} url={}",
            copied,
            dist_src.display(),
            dist_dst.display(),
            overlay_url
        );
        let overlay_url_path = game_bin_dir.join(IN_GAME_OVERLAY_URL_FILE);
        emit_bridge_log_line(format!(
            "[bridge] in-game browser bundle synced files={} url_file={} url={}",
            copied,
            overlay_url_path.display(),
            overlay_url
        ));
        Ok(())
    }

    fn sync_payload(
        src_root: &Path,
        dst_root: &Path,
        tolerate_locked_files: bool,
    ) -> Result<(), String> {
        let profile = read_payload_profile(src_root);
        let desired_files = collect_payload_files(src_root, &profile)?;

        cleanup_legacy_ue4ss_files(dst_root, tolerate_locked_files)?;
        cleanup_payload_from_manifest(dst_root, tolerate_locked_files, &desired_files)?;

        let engine_override = read_engine_override(src_root);
        log::info!(
            "bridge: syncing UE4SS payload profile={} from {}",
            profile,
            src_root.display()
        );
        if let Some((major, minor)) = engine_override {
            log::info!(
                "bridge: payload UE4SS settings EngineVersionOverride={}.{}",
                major,
                minor
            );
        }

        // Replace our mod directory atomically-ish so stale files from older builds
        // never linger across updates.
        let managed_mod_rel = Path::new("Mods").join("KovaaksBridgeMod");
        let src_mod_dir = src_root.join(&managed_mod_rel);
        let dst_mod_dir = dst_root.join(&managed_mod_rel);
        if src_mod_dir.is_dir() && dst_mod_dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&dst_mod_dir) {
                if tolerate_locked_files && is_permission_denied(&e) {
                    log::warn!(
                        "bridge: could not replace runtime directory (in use): {} ({})",
                        dst_mod_dir.display(),
                        e
                    );
                } else {
                    return Err(format!(
                        "Failed to replace runtime directory {}: {}",
                        dst_mod_dir.display(),
                        e
                    ));
                }
            }
        }

        let mut copied_paths = Vec::new();
        let copied = copy_dir_recursive(
            src_root,
            dst_root,
            src_root,
            &profile,
            tolerate_locked_files,
            &mut copied_paths,
        )?;
        write_payload_manifest(dst_root, &copied_paths)?;
        if let Err(e) =
            write_payload_deploy_info(dst_root, src_root, &profile, engine_override, copied)
        {
            log::warn!("bridge: failed to write payload deploy marker: {e}");
        }
        log::info!(
            "bridge: synced {} UE4SS payload file(s) from {} to {}",
            copied,
            src_root.display(),
            dst_root.display()
        );
        Ok(())
    }

    fn read_payload_profile(src_root: &Path) -> String {
        let marker = src_root.join(PAYLOAD_PROFILE_FILE);
        match std::fs::read_to_string(&marker) {
            Ok(content) => {
                let raw = content.trim().to_ascii_lowercase();
                if raw == "minimal" || raw == "full" {
                    raw
                } else {
                    "minimal".to_string()
                }
            }
            Err(_) => {
                // Safe default if marker is missing: minimal.
                "minimal".to_string()
            }
        }
    }

    fn read_engine_override(src_root: &Path) -> Option<(u32, u32)> {
        let ini_path = src_root.join("UE4SS-settings.ini");
        let content = std::fs::read_to_string(ini_path).ok()?;
        let mut major: Option<u32> = None;
        let mut minor: Option<u32> = None;
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(v) = trimmed.strip_prefix("MajorVersion") {
                let val = v.split('=').nth(1)?.trim().parse::<u32>().ok()?;
                major = Some(val);
                continue;
            }
            if let Some(v) = trimmed.strip_prefix("MinorVersion") {
                let val = v.split('=').nth(1)?.trim().parse::<u32>().ok()?;
                minor = Some(val);
                continue;
            }
        }
        Some((major?, minor?))
    }

    fn cleanup_legacy_ue4ss_files(
        dst_root: &Path,
        tolerate_locked_files: bool,
    ) -> Result<(), String> {
        // Prevent auto-load of UE4SS via proxy DLL when overlay is not running.
        let _ = remove_path_if_exists(&dst_root.join("dwmapi.dll"), tolerate_locked_files)?;

        let legacy_files = [
            "UE4SS.pdb",
            "API.txt",
            "Changelog.md",
            "README.md",
            "README.txt",
            "Readme.md",
            "Readme.txt",
        ];
        for rel in legacy_files {
            let _ = remove_path_if_exists(&dst_root.join(rel), tolerate_locked_files)?;
        }

        // Remove known upstream sample/config folders from older full payloads.
        let legacy_dirs = [
            "CustomGameConfigs",
            "MapGenBP",
            "Atomic Heart",
            "Borderlands 3",
            "Final Fantasy 7 Remake",
            "Fuser",
            "Ghost Wire Tokyo",
            "Kingdom Hearts 3",
            "Like a Dragon Ishin!",
            "Returnal",
            "SCP 5K",
            "Satisfactory",
            "Star Wars Jedi Fallen Order",
            "Star Wars Jedi Survivor",
            "The Outer Worlds",
            "Walking Dead Saints & Sinners",
        ];
        for rel in legacy_dirs {
            let _ = remove_path_if_exists(&dst_root.join(rel), tolerate_locked_files)?;
        }
        let _ = remove_path_if_exists(
            &dst_root.join("Content").join("MapGen"),
            tolerate_locked_files,
        )?;

        // Remove known built-in UE4SS sample mods from older payloads.
        let legacy_mods = [
            "ActorDumperMod",
            "BPML_GenericFunctions",
            "BPModLoaderMod",
            "CheatManagerEnablerMod",
            "ConsoleCommandsMod",
            "ConsoleEnablerMod",
            "Keybinds",
            "LineTraceMod",
            "SplitScreenMod",
            "jsbLuaProfilerMod",
            "shared",
        ];
        let mods_root = dst_root.join("Mods");
        for name in legacy_mods {
            let _ = remove_path_if_exists(&mods_root.join(name), tolerate_locked_files)?;
        }
        // Remove duplicate copies of the runtime package left behind under alternate
        // folder names by older experiments.
        if let Ok(entries) = std::fs::read_dir(&mods_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if name.eq_ignore_ascii_case("KovaaksBridgeMod") {
                    continue;
                }
                let mod_json = path.join("mod.json");
                if !mod_json.is_file() {
                    continue;
                }
                let Ok(content) = std::fs::read_to_string(&mod_json) else {
                    continue;
                };
                if content.contains("\"mod_name\"") && content.contains("KovaaksBridgeMod") {
                    let _ = remove_path_if_exists(&path, tolerate_locked_files)?;
                    log::warn!(
                        "bridge: removed duplicate runtime directory {}",
                        path.display()
                    );
                }
            }
        }
        Ok(())
    }

    fn payload_manifest_path(dst_root: &Path) -> PathBuf {
        dst_root.join(PAYLOAD_MANIFEST_FILE)
    }

    fn cleanup_payload_from_manifest(
        dst_root: &Path,
        tolerate_locked_files: bool,
        desired_files: &HashSet<String>,
    ) -> Result<(), String> {
        let manifest_path = payload_manifest_path(dst_root);
        if !manifest_path.is_file() {
            return Ok(());
        }

        let manifest = std::fs::read_to_string(&manifest_path).map_err(|e| {
            format!(
                "Failed to read payload manifest {}: {}",
                manifest_path.display(),
                e
            )
        })?;

        let mut removed = 0usize;
        let mut skipped_locked = 0usize;
        for rel in manifest
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if desired_files.contains(rel) {
                // Still part of current payload; prefer overwrite-in-place over delete-first.
                continue;
            }
            let rel_path = Path::new(rel);
            if rel_path.is_absolute() {
                continue;
            }
            let abs_path = dst_root.join(rel_path);
            if !abs_path.exists() {
                continue;
            }
            if remove_path_if_exists(&abs_path, tolerate_locked_files)? {
                prune_empty_parent_dirs(abs_path.parent(), dst_root);
                removed += 1;
            } else if abs_path.exists() {
                skipped_locked += 1;
            }
        }

        if skipped_locked == 0 {
            let _ = remove_path_if_exists(&manifest_path, tolerate_locked_files)?;
        } else {
            log::warn!(
                "bridge: skipped {} locked file(s) from previous payload manifest; keeping manifest for next restart",
                skipped_locked
            );
        }
        if removed > 0 {
            log::info!(
                "bridge: removed {} file(s) from previous payload manifest",
                removed
            );
        }
        Ok(())
    }

    fn collect_payload_files(src_root: &Path, profile: &str) -> Result<HashSet<String>, String> {
        let mut out = HashSet::new();
        collect_payload_files_recursive(src_root, src_root, profile, &mut out)?;
        Ok(out)
    }

    fn collect_payload_files_recursive(
        root: &Path,
        current: &Path,
        profile: &str,
        out: &mut HashSet<String>,
    ) -> Result<(), String> {
        let entries = std::fs::read_dir(current)
            .map_err(|e| format!("Failed to enumerate {}: {}", current.display(), e))?;

        for entry in entries {
            let entry = entry
                .map_err(|e| format!("Failed to read dir entry in {}: {}", current.display(), e))?;
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str == ".gitkeep" || name_str.ends_with(".md") {
                continue;
            }

            let ty = entry
                .file_type()
                .map_err(|e| format!("Failed to get file type for {}: {}", path.display(), e))?;
            let rel = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| String::new());

            if profile == "minimal" && !is_allowed_minimal_path(&rel, ty.is_dir()) {
                continue;
            }

            if ty.is_dir() {
                collect_payload_files_recursive(root, &path, profile, out)?;
                continue;
            }
            if !ty.is_file() {
                continue;
            }

            let rel = rel.trim_start_matches('/').to_string();
            if !rel.is_empty() {
                out.insert(rel);
            }
        }

        Ok(())
    }

    fn write_payload_manifest(dst_root: &Path, copied_paths: &[String]) -> Result<(), String> {
        let mut entries: Vec<String> = copied_paths.to_vec();
        entries.sort();
        entries.dedup();

        let mut body = String::new();
        for rel in entries {
            body.push_str(&rel);
            body.push('\n');
        }

        let path = payload_manifest_path(dst_root);
        std::fs::write(&path, body)
            .map_err(|e| format!("Failed to write payload manifest {}: {}", path.display(), e))
    }

    fn write_payload_deploy_info(
        dst_root: &Path,
        src_root: &Path,
        profile: &str,
        engine_override: Option<(u32, u32)>,
        copied_count: usize,
    ) -> Result<(), String> {
        let mut body = String::new();
        body.push_str(&format!("profile={profile}\n"));
        if let Some((major, minor)) = engine_override {
            body.push_str(&format!("engine_override={major}.{minor}\n"));
        } else {
            body.push_str("engine_override=unknown\n");
        }
        body.push_str(&format!("copied_files={copied_count}\n"));
        body.push_str(&format!("source={}\n", src_root.display()));
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        body.push_str(&format!("deployed_unix={ts}\n"));

        let path = dst_root.join(PAYLOAD_DEPLOY_INFO_FILE);
        std::fs::write(&path, body)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
    }

    fn remove_path_if_exists(path: &Path, tolerate_locked_files: bool) -> Result<bool, String> {
        if !path.exists() {
            return Ok(false);
        }
        if path.is_dir() {
            match std::fs::remove_dir_all(path) {
                Ok(_) => Ok(true),
                Err(e) if tolerate_locked_files && is_permission_denied(&e) => {
                    log::warn!(
                        "bridge: skipping locked directory during sync: {} ({})",
                        path.display(),
                        e
                    );
                    Ok(false)
                }
                Err(e) => Err(format!(
                    "Failed to remove legacy directory {}: {}",
                    path.display(),
                    e
                )),
            }
        } else {
            match std::fs::remove_file(path) {
                Ok(_) => Ok(true),
                Err(e) if tolerate_locked_files && is_permission_denied(&e) => {
                    log::warn!(
                        "bridge: skipping locked file during sync: {} ({})",
                        path.display(),
                        e
                    );
                    Ok(false)
                }
                Err(e) => Err(format!(
                    "Failed to remove legacy file {}: {}",
                    path.display(),
                    e
                )),
            }
        }
    }

    fn prune_empty_parent_dirs(start: Option<&Path>, stop_at: &Path) {
        let mut current = start;
        while let Some(dir) = current {
            if dir == stop_at {
                break;
            }
            match std::fs::read_dir(dir) {
                Ok(mut entries) => {
                    if entries.next().is_some() {
                        break;
                    }
                    let _ = std::fs::remove_dir(dir);
                    current = dir.parent();
                }
                Err(_) => break,
            }
        }
    }

    fn copy_dir_recursive(
        src: &Path,
        dst: &Path,
        src_root: &Path,
        profile: &str,
        tolerate_locked_files: bool,
        copied_paths: &mut Vec<String>,
    ) -> Result<usize, String> {
        if !src.is_dir() {
            return Err(format!(
                "Payload source is not a directory: {}",
                src.display()
            ));
        }
        std::fs::create_dir_all(dst)
            .map_err(|e| format!("Failed to create {}: {}", dst.display(), e))?;

        let mut copied = 0usize;
        let entries = std::fs::read_dir(src)
            .map_err(|e| format!("Failed to enumerate {}: {}", src.display(), e))?;

        for entry in entries {
            let entry = entry
                .map_err(|e| format!("Failed to read dir entry in {}: {}", src.display(), e))?;
            let src_path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str == ".gitkeep" || name_str.ends_with(".md") {
                continue;
            }
            let rel = src_path
                .strip_prefix(src_root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| String::new());
            let dst_path = dst.join(name);
            let ty = entry.file_type().map_err(|e| {
                format!("Failed to get file type for {}: {}", src_path.display(), e)
            })?;

            if profile == "minimal" && !is_allowed_minimal_path(&rel, ty.is_dir()) {
                continue;
            }

            if ty.is_dir() {
                copied += copy_dir_recursive(
                    &src_path,
                    &dst_path,
                    src_root,
                    profile,
                    tolerate_locked_files,
                    copied_paths,
                )?;
                continue;
            }
            if !ty.is_file() {
                continue;
            }

            if let Some(parent) = dst_path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    if tolerate_locked_files && is_permission_denied(&e) {
                        log::warn!(
                            "bridge: skipping locked parent dir during sync: {} ({})",
                            parent.display(),
                            e
                        );
                        continue;
                    }
                    return Err(format!(
                        "Failed to create parent {}: {}",
                        parent.display(),
                        e
                    ));
                }
            }
            if let Err(e) = std::fs::copy(&src_path, &dst_path) {
                if tolerate_locked_files && is_permission_denied(&e) {
                    log::warn!(
                        "bridge: skipping locked file copy during sync: {} -> {} ({})",
                        src_path.display(),
                        dst_path.display(),
                        e
                    );
                    // Keep tracked in manifest for next restart cleanup/update.
                    if let Ok(rel) = src_path.strip_prefix(src_root) {
                        let rel = rel
                            .to_string_lossy()
                            .replace('\\', "/")
                            .trim_start_matches('/')
                            .to_string();
                        if !rel.is_empty() {
                            copied_paths.push(rel);
                        }
                    }
                    continue;
                }
                return Err(format!(
                    "Failed to copy {} -> {}: {}",
                    src_path.display(),
                    dst_path.display(),
                    e
                ));
            }

            if let Ok(rel) = src_path.strip_prefix(src_root) {
                let rel = rel
                    .to_string_lossy()
                    .replace('\\', "/")
                    .trim_start_matches('/')
                    .to_string();
                if !rel.is_empty() {
                    copied_paths.push(rel);
                }
            }
            copied += 1;
        }

        Ok(copied)
    }

    fn is_permission_denied(e: &std::io::Error) -> bool {
        e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(5)
    }

    fn is_allowed_minimal_path(rel: &str, is_dir: bool) -> bool {
        if rel.is_empty() {
            return true;
        }
        // Top-level required runtime pieces.
        if rel == "UE4SS.dll"
            || rel == "UE4SS-settings.ini"
            || rel == "kovaaks_rust_core.dll"
            || rel == PAYLOAD_PROFILE_FILE
        {
            return true;
        }

        // Root dirs we intentionally keep for signatures/layout templates.
        if rel == "UE4SS_Signatures"
            || rel.starts_with("UE4SS_Signatures/")
            || rel == "VTableLayoutTemplates"
            || rel.starts_with("VTableLayoutTemplates/")
            || rel == "MemberVarLayoutTemplates"
            || rel.starts_with("MemberVarLayoutTemplates/")
        {
            return true;
        }

        // Runtime package + manifest only.
        if rel == "Mods" && is_dir {
            return true;
        }
        if rel == "Mods/mods.txt" {
            return true;
        }
        if rel == "Mods/KovaaksBridgeMod" || rel.starts_with("Mods/KovaaksBridgeMod/") {
            return true;
        }

        false
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub fn start(app: tauri::AppHandle) {
    imp::start(app);
}

#[cfg(not(target_os = "windows"))]
pub fn start(_app: tauri::AppHandle) {}

#[cfg(target_os = "windows")]
pub fn inject(dll_path: &str) -> Result<(), String> {
    imp::inject(dll_path)
}

pub fn is_injection_deferred_error(err: &str) -> bool {
    err.starts_with(INJECTION_DEFERRED_ERROR_PREFIX)
}

#[cfg(not(target_os = "windows"))]
pub fn inject(_dll_path: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn deploy_and_inject(resource_dir: &std::path::Path, stats_dir: &str) -> Result<(), String> {
    imp::deploy_and_inject(resource_dir, stats_dir)
}

#[cfg(not(target_os = "windows"))]
pub fn deploy_and_inject(_resource_dir: &std::path::Path, _stats_dir: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn start_log_tailer(app: tauri::AppHandle, stats_dir: &str) -> Result<(), String> {
    imp::start_log_tailer(app, stats_dir)
}

#[cfg(not(target_os = "windows"))]
pub fn start_log_tailer(_app: tauri::AppHandle, _stats_dir: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn recent_logs(limit: usize) -> Vec<String> {
    imp::recent_logs(limit)
}

#[cfg(not(target_os = "windows"))]
pub fn recent_logs(_limit: usize) -> Vec<String> {
    Vec::new()
}

#[cfg(target_os = "windows")]
pub fn take_run_snapshot() -> Option<BridgeRunSnapshot> {
    imp::take_run_snapshot()
}

#[cfg(not(target_os = "windows"))]
pub fn take_run_snapshot() -> Option<BridgeRunSnapshot> {
    None
}

#[cfg(target_os = "windows")]
pub fn start_in_game_replay_stream(
    session_id: &str,
    stream: BridgeTickStreamV1,
    speed: f64,
) -> Result<(), String> {
    imp::start_in_game_replay_stream(session_id, stream, speed)
}

#[cfg(not(target_os = "windows"))]
pub fn start_in_game_replay_stream(
    _session_id: &str,
    _stream: BridgeTickStreamV1,
    _speed: f64,
) -> Result<(), String> {
    Err("in-game replay is only available on Windows runtime".to_string())
}

#[cfg(target_os = "windows")]
pub fn stop_in_game_replay_stream() -> Result<(), String> {
    imp::stop_in_game_replay_stream()
}

#[cfg(not(target_os = "windows"))]
pub fn stop_in_game_replay_stream() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn trigger_hot_reload() -> Result<(), String> {
    imp::trigger_hot_reload()
}

#[cfg(not(target_os = "windows"))]
pub fn trigger_hot_reload() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn current_game_pid() -> Option<u32> {
    imp::current_game_pid()
}

#[cfg(not(target_os = "windows"))]
pub fn current_game_pid() -> Option<u32> {
    None
}

#[cfg(target_os = "windows")]
pub fn is_ue4ss_loaded_for_pid(pid: u32) -> bool {
    imp::is_ue4ss_loaded_for_pid(pid)
}

#[cfg(not(target_os = "windows"))]
pub fn is_ue4ss_loaded_for_pid(_pid: u32) -> bool {
    false
}

#[cfg(target_os = "windows")]
pub fn get_runtime_flags(stats_dir: &str) -> Result<RuntimeFlagState, String> {
    imp::get_runtime_flags(stats_dir)
}

#[cfg(not(target_os = "windows"))]
pub fn get_runtime_flags(_stats_dir: &str) -> Result<RuntimeFlagState, String> {
    Ok(RuntimeFlagState {
        profile: "unsupported".to_string(),
        enable_pe_hook: false,
        disable_pe_hook: false,
        discovery: false,
        safe_mode: false,
        no_rust: false,
        log_all_events: false,
        object_debug: false,
        non_ui_probe: false,
        ui_counter_fallback: false,
        score_ui_fallback: false,
        hook_process_internal: false,
        hook_process_local_script: false,
        class_probe_hooks: false,
        class_probe_scalar_reads: false,
        class_probe_scan_all: false,
        allow_unsafe_hooks: false,
        native_hooks: false,
        hook_process_event: false,
        detour_callbacks: false,
        direct_pull_invoke: false,
        experimental_runtime: false,
        ui_settext_hook: false,
        ui_widget_probe: false,
        in_game_overlay: false,
    })
}

#[cfg(target_os = "windows")]
pub fn set_runtime_flag(stats_dir: &str, key: &str, enabled: bool) -> Result<(), String> {
    imp::set_runtime_flag(stats_dir, key, enabled)
}

#[cfg(not(target_os = "windows"))]
pub fn set_runtime_flag(_stats_dir: &str, _key: &str, _enabled: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn request_runtime_flag_reload(stats_dir: &str) -> Result<(), String> {
    imp::request_runtime_flag_reload(stats_dir)
}

#[cfg(not(target_os = "windows"))]
pub fn request_runtime_flag_reload(_stats_dir: &str) -> Result<(), String> {
    Ok(())
}
