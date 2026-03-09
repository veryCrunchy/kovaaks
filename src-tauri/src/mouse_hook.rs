/// Mouse hook module: captures global OS mouse events, computes smoothness metrics.
///
/// Uses the `rdev` crate which calls SetWindowsHookEx on Windows (OS-level, no game injection).
/// Metrics are emitted every second via Tauri event `mouse-metrics`, but ONLY while a
/// session is active (between `start_session_tracking` and `stop_session_tracking`).
///
/// Hotkeys (F8+ are free; below F8 used by KovaaK's):
///   F8  → toggle-settings        (open/close settings panel)
///   F9  → toggle-debug-state-overlay (show/hide bridge state debug HUD)
///   F10 → toggle-layout-huds     (enter/exit HUD drag-to-reposition mode)
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use rdev::{Event, EventType, Key, listen};
use tauri::{AppHandle, Emitter};

// ─── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MouseMetrics {
    /// 0–100 composite smoothness score
    pub smoothness: f32,
    /// Lateral RMS / mean-speed: deviation perpendicular to the primary axis of
    /// motion (lower = smoother). Dimensionless and DPI-independent. Handles
    /// continuous tracking — left-right oscillation is the primary axis, so only
    /// lateral wobble (up/down drift) counts as jitter.
    pub jitter: f32,
    /// Fraction of high-speed axial segments where the motion reverses direction
    /// sharply (both sides above threshold, no deceleration phase). Lower is better.
    pub overshoot_rate: f32,
    /// Coefficient of variation of speed (std/mean). Dimensionless and
    /// DPI-independent — measures speed consistency regardless of CPI setting.
    pub velocity_std: f32,
    /// Average speed normalised to an 800-DPI baseline (px/s ÷ dpi/800).
    /// Comparable across different DPI/sensitivity setups.
    pub avg_speed: f32,
    /// Path straightness: straight-line displacement ÷ total path length,
    /// averaged over sliding windows of raw position data.
    /// 1.0 = laser-straight; lower = the cursor curved/weaved on the way to
    /// the target.  Catches low-frequency S-curve wobble that jitter (which is
    /// velocity-perpendicular) can miss.
    pub path_efficiency: f32,
    /// Coefficient of variation of inter-click intervals (lower = more rhythmic).
    /// Based on Schmidt et al. (1979) click-timing research. 0 = perfect metronome.
    /// Only populated when ≥3 clicks occurred in the window; otherwise 0.
    pub click_timing_cv: f32,
    /// Fraction of movement time spent in the "correction phase" (speed < 40 % of
    /// mean speed). Fitts' Law: lower ratio = more decisive ballistic movements.
    pub correction_ratio: f32,
    /// Directional bias in overshoot events (0 = balanced, 1 = always one direction).
    /// >0.3 suggests a systematic aim-starting-position issue (Natapov et al. 2009).
    pub directional_bias: f32,
    /// Average left-button hold duration (ms) over the last 5 seconds.
    /// Near-zero = discrete taps (clicking scenario);
    /// high value = sustained presses (tracking / beam scenario).
    pub avg_hold_ms: f32,
}

/// A single timestamped metric snapshot for session replay/graphing.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MetricPoint {
    pub timestamp_ms: u64,
    pub metrics: MouseMetrics,
}

/// A single raw cursor position sample recorded during a session.
/// Downsampled to ≈30 fps; click events are inserted with `is_click = true`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RawPositionPoint {
    /// Integrated X position in mouse-delta space.  Starts at 0.0 at session
    /// start; each sample adds the raw screen-pixel delta from the previous
    /// sample.  This represents camera yaw movement, independent of where the
    /// OS cursor happens to be physically sitting on screen (FPS games keep the
    /// cursor locked to the centre, so absolute coords are meaningless).
    pub x: f64,
    /// Integrated Y position in mouse-delta space (camera pitch).
    pub y: f64,
    /// Milliseconds elapsed since the start of this session.
    pub timestamp_ms: u64,
    /// True when this point coincides with a left-button press event.
    pub is_click: bool,
}

#[derive(Debug, Clone)]
struct CompletedReplayCapture {
    started_at_unix_ms: Option<u64>,
    ended_at_unix_ms: Option<u64>,
    positions: Vec<RawPositionPoint>,
    metrics: Vec<MetricPoint>,
}

#[derive(Debug, Clone, Default)]
pub struct ReplayCaptureData {
    pub positions: Vec<RawPositionPoint>,
    pub metrics: Vec<MetricPoint>,
}

/// A live coaching notification emitted during an active session.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LiveFeedback {
    /// Human-readable coaching message.
    pub message: String,
    /// Severity: "positive" | "tip" | "warning"
    pub kind: String,
    /// Which metric triggered this notification.
    pub metric: String,
}

pub const EVENT_LIVE_FEEDBACK: &str = "live-feedback";

#[derive(Debug, Clone)]
struct RawMouseEvent {
    x: f64,
    y: f64,
    time: Instant,
}

// ─── State ─────────────────────────────────────────────────────────────────────

static HOOK_RUNNING: AtomicBool = AtomicBool::new(false);
/// True only while a KovaaK's scenario session is active.
static TRACKING_ACTIVE: AtomicBool = AtomicBool::new(false);
/// User's configured mouse DPI/CPI, used to normalise speed metrics.
static MOUSE_DPI: AtomicU32 = AtomicU32::new(800);
/// Whether to emit live-feedback coaching notifications.
static FEEDBACK_ENABLED: AtomicBool = AtomicBool::new(true);
/// Verbosity level: 0=minimal, 1=standard, 2=verbose.
static FEEDBACK_VERBOSITY: AtomicU8 = AtomicU8::new(1);

/// Stored handle so the rdev callback (static fn) can emit hotkey events.
static APP_HANDLE: Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));

struct SharedState {
    events: Vec<RawMouseEvent>,
    session_metrics: Vec<MetricPoint>,
    session_start: Instant,
    session_start_unix_ms: Option<u64>,
    /// Recent left-click timestamps for click_timing_cv computation.
    click_times: VecDeque<Instant>,
    /// Timestamp of the most recent LMB-down event (None if button is up).
    lmb_down_at: Option<Instant>,
    /// Completed LMB hold durations (ms) in chronological order.
    hold_durations: VecDeque<f32>,
    /// Downsampled raw cursor positions for post-session path visualisation.
    raw_positions: Vec<RawPositionPoint>,
    /// When the last raw-position sample was taken (used for rate-limiting).
    last_raw_sample: Option<Instant>,
    /// Integrated delta-space cursor position.  Starts at (0, 0) each session
    /// and accumulates raw dx/dy so the path represents actual camera movement.
    cursor_x: f64,
    cursor_y: f64,
}

static STATE: Lazy<Mutex<SharedState>> = Lazy::new(|| {
    Mutex::new(SharedState {
        events: Vec::with_capacity(10_000),
        session_metrics: Vec::with_capacity(3_600),
        session_start: Instant::now(),
        session_start_unix_ms: None,
        click_times: VecDeque::with_capacity(200),
        lmb_down_at: None,
        hold_durations: VecDeque::with_capacity(500),
        raw_positions: Vec::with_capacity(20_000),
        last_raw_sample: None,
        cursor_x: 0.0,
        cursor_y: 0.0,
    })
});
static COMPLETED_CAPTURES: Lazy<Mutex<VecDeque<CompletedReplayCapture>>> =
    Lazy::new(|| Mutex::new(VecDeque::new()));

pub const EVENT_MOUSE_METRICS: &str = "mouse-metrics";
const MAX_COMPLETED_CAPTURES: usize = 12;

// ─── Public API ────────────────────────────────────────────────────────────────

/// Start the mouse hook listener and metric-emitter threads.
pub fn start(app: AppHandle) -> anyhow::Result<()> {
    if HOOK_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(()); // Already running
    }

    // Store handle for hotkey use in the static callback
    {
        let mut h = APP_HANDLE.lock().unwrap();
        *h = Some(app.clone());
    }

    // On Windows, start a Raw Input listener alongside rdev.
    // Raw input gives us hardware mouse deltas (lLastX/lLastY) which are NOT
    // clamped by monitor boundaries or affected by SetCursorPos recentering that
    // FPS games perform every frame.  This thread owns cursor_x/cursor_y and the
    // raw_positions buffer.  The rdev thread below continues for hotkeys, click
    // detection, and the per-second smoothness metrics engine.
    #[cfg(target_os = "windows")]
    start_raw_input_thread();

    // Spawn the rdev listener thread (blocks, so must be its own thread)
    std::thread::Builder::new()
        .name("mouse-hook".into())
        .spawn(move || {
            log::info!("Mouse hook thread started");

            let app_clone = app.clone();
            let _emitter = std::thread::Builder::new()
                .name("metric-emitter".into())
                .spawn(move || metric_emitter_loop(app_clone))
                .expect("failed to spawn metric emitter");

            if let Err(e) = listen(mouse_event_callback) {
                log::error!("rdev listen error: {e:?}");
            }

            HOOK_RUNNING.store(false, Ordering::SeqCst);
            log::info!("Mouse hook thread stopped");
        })?;

    Ok(())
}

/// Signal the hook to stop.
pub fn stop() {
    HOOK_RUNNING.store(false, Ordering::SeqCst);
}

/// Begin recording smoothness metrics for a new session. Clears previous session data.
/// Begin recording smoothness metrics for a new session.  Returns the `Instant`
/// used as the session clock so callers can pass it to other subsystems (e.g.
/// `screen_recorder`) that need to share the exact same time base.
pub fn start_session_tracking() -> Instant {
    let session_start = Instant::now();
    let start_unix_ms = unix_now_ms();
    {
        let mut s = STATE.lock().unwrap();
        if TRACKING_ACTIVE.load(Ordering::Relaxed) {
            recycle_live_capture_locked(&mut s, start_unix_ms, "restart");
        }
        s.events.clear();
        s.session_metrics.clear();
        s.session_start = session_start;
        s.session_start_unix_ms = Some(start_unix_ms);
        s.click_times.clear();
        s.raw_positions.clear();
        s.last_raw_sample = None;
        s.cursor_x = 0.0;
        s.cursor_y = 0.0;
    }
    TRACKING_ACTIVE.store(true, Ordering::SeqCst);
    log::info!("Smoothness tracking started");
    session_start
}

/// Stop recording metrics (session ended). Data is retained for post-session report.
pub fn stop_session_tracking() {
    if TRACKING_ACTIVE.swap(false, Ordering::SeqCst) {
        if let Ok(mut s) = STATE.lock() {
            queue_completed_capture_locked(&mut s, unix_now_ms(), "stop");
        }
        log::info!("Smoothness tracking stopped");
    }
}

/// Drain session metric buffer for post-session analysis.
pub fn drain_session_buffer() -> Vec<MetricPoint> {
    let mut s = STATE.lock().unwrap();
    std::mem::take(&mut s.session_metrics)
}

/// Return metric points for the last session without removing them.
/// The buffer is cleared automatically when the next session starts.
pub fn get_session_buffer() -> Vec<MetricPoint> {
    let s = STATE.lock().unwrap();
    s.session_metrics.clone()
}

/// Drain the raw-position buffer for post-session path visualisation.
/// Returns all cursor samples recorded during the last session and clears the buffer.
pub fn drain_raw_positions() -> Vec<RawPositionPoint> {
    let mut s = STATE.lock().unwrap();
    std::mem::take(&mut s.raw_positions)
}

pub fn take_replay_capture_for_run(
    run_snapshot: Option<&crate::bridge::BridgeRunSnapshot>,
) -> ReplayCaptureData {
    let mut completed = COMPLETED_CAPTURES.lock().unwrap();
    if completed.is_empty() {
        drop(completed);
        return ReplayCaptureData {
            positions: drain_raw_positions(),
            metrics: drain_session_buffer(),
        };
    }

    if let Some(snapshot) = run_snapshot {
        let (matched, remaining) = partition_matching_captures(
            std::mem::take(&mut *completed),
            snapshot,
        );
        *completed = remaining;
        if !matched.is_empty() {
            drop(completed);
            return merge_replay_captures(matched, snapshot);
        }
    }

    let fallback = completed.pop_back();
    drop(completed);
    fallback
        .map(|capture| ReplayCaptureData {
            positions: capture.positions,
            metrics: capture.metrics,
        })
        .unwrap_or_default()
}

/// Return raw cursor positions for the last session without removing them.
/// The buffer is cleared automatically when the next session starts.
pub fn get_raw_positions() -> Vec<RawPositionPoint> {
    let s = STATE.lock().unwrap();
    s.raw_positions.clone()
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn recycle_live_capture_locked(state: &mut SharedState, ended_at_unix_ms: u64, reason: &str) {
    if state.raw_positions.is_empty() && state.session_metrics.is_empty() {
        return;
    }
    queue_completed_capture_locked(state, ended_at_unix_ms, reason);
}

fn queue_completed_capture_locked(state: &mut SharedState, ended_at_unix_ms: u64, reason: &str) {
    if state.raw_positions.is_empty() && state.session_metrics.is_empty() {
        state.session_start_unix_ms = None;
        return;
    }

    let positions = std::mem::take(&mut state.raw_positions);
    let metrics = std::mem::take(&mut state.session_metrics);
    let started_at_unix_ms = state.session_start_unix_ms.take();

    let pos_count = positions.len();
    let metric_count = metrics.len();

    let capture = CompletedReplayCapture {
        started_at_unix_ms,
        ended_at_unix_ms: Some(ended_at_unix_ms),
        positions,
        metrics,
    };

    let mut completed = COMPLETED_CAPTURES.lock().unwrap();
    completed.push_back(capture);
    while completed.len() > MAX_COMPLETED_CAPTURES {
        let _ = completed.pop_front();
    }
    log::info!(
        "mouse_hook: queued replay capture ({reason}) positions={} metrics={} queued_sessions={}",
        pos_count,
        metric_count,
        completed.len()
    );
}

fn partition_matching_captures(
    mut captures: VecDeque<CompletedReplayCapture>,
    snapshot: &crate::bridge::BridgeRunSnapshot,
) -> (Vec<CompletedReplayCapture>, VecDeque<CompletedReplayCapture>) {
    let mut matched = Vec::new();
    let mut remaining = VecDeque::new();
    while let Some(capture) = captures.pop_front() {
        if capture_matches_run(&capture, snapshot) {
            matched.push(capture);
        } else {
            remaining.push_back(capture);
        }
    }
    (matched, remaining)
}

fn capture_matches_run(
    capture: &CompletedReplayCapture,
    snapshot: &crate::bridge::BridgeRunSnapshot,
) -> bool {
    let capture_duration_ms = capture
        .positions
        .last()
        .map(|p| p.timestamp_ms)
        .or_else(|| capture.metrics.last().map(|p| p.timestamp_ms))
        .unwrap_or(0);
    let run_duration_ms = snapshot
        .duration_secs
        .map(|secs| (secs.max(0.0) * 1000.0).round() as u64)
        .unwrap_or(0);

    match (
        capture.started_at_unix_ms,
        capture.ended_at_unix_ms,
        snapshot.started_at_unix_ms,
        snapshot.ended_at_unix_ms,
    ) {
        (Some(c_start), Some(c_end), Some(r_start), Some(r_end)) => {
            let overlap_start = c_start.max(r_start);
            let overlap_end = c_end.min(r_end);
            overlap_end > overlap_start
                || c_start.abs_diff(r_start) <= 2_500
                || c_end.abs_diff(r_end) <= 2_500
        }
        _ if run_duration_ms > 0 && capture_duration_ms > 0 => {
            capture_duration_ms.abs_diff(run_duration_ms) <= 5_000
        }
        _ => false,
    }
}

fn pause_contains_abs_ms(
    pause_windows: &[crate::bridge::BridgeRunPauseWindow],
    abs_ms: u64,
) -> bool {
    pause_windows
        .iter()
        .any(|window| abs_ms >= window.started_at_unix_ms && abs_ms < window.ended_at_unix_ms)
}

fn paused_duration_before_abs_ms(
    pause_windows: &[crate::bridge::BridgeRunPauseWindow],
    abs_ms: u64,
) -> u64 {
    pause_windows
        .iter()
        .map(|window| {
            if abs_ms <= window.started_at_unix_ms {
                0
            } else {
                abs_ms.min(window.ended_at_unix_ms)
                    .saturating_sub(window.started_at_unix_ms)
            }
        })
        .sum()
}

fn merge_replay_captures(
    mut captures: Vec<CompletedReplayCapture>,
    snapshot: &crate::bridge::BridgeRunSnapshot,
) -> ReplayCaptureData {
    captures.sort_by_key(|capture| capture.started_at_unix_ms.unwrap_or(u64::MAX));
    let capture_count = captures.len();
    let base_start_ms = snapshot
        .started_at_unix_ms
        .or_else(|| captures.iter().filter_map(|c| c.started_at_unix_ms).min())
        .unwrap_or(0);
    let run_duration_ms = snapshot
        .duration_secs
        .map(|secs| (secs.max(0.0) * 1000.0).round() as u64);

    let mut positions = Vec::new();
    let mut metrics = Vec::new();

    for capture in captures {
        if let Some(capture_start_ms) = capture.started_at_unix_ms {
            positions.extend(capture.positions.into_iter().filter_map(|mut point| {
                let abs_ms = capture_start_ms.saturating_add(point.timestamp_ms);
                if pause_contains_abs_ms(&snapshot.pause_windows, abs_ms) {
                    return None;
                }
                let paused_before = paused_duration_before_abs_ms(&snapshot.pause_windows, abs_ms);
                point.timestamp_ms = abs_ms
                    .saturating_sub(base_start_ms)
                    .saturating_sub(paused_before);
                Some(point)
            }));
            metrics.extend(capture.metrics.into_iter().filter_map(|mut point| {
                let abs_ms = capture_start_ms.saturating_add(point.timestamp_ms);
                if pause_contains_abs_ms(&snapshot.pause_windows, abs_ms) {
                    return None;
                }
                let paused_before = paused_duration_before_abs_ms(&snapshot.pause_windows, abs_ms);
                point.timestamp_ms = abs_ms
                    .saturating_sub(base_start_ms)
                    .saturating_sub(paused_before);
                Some(point)
            }));
        } else {
            let offset_ms = 0;
            positions.extend(capture.positions.into_iter().map(|mut point| {
                point.timestamp_ms = point.timestamp_ms.saturating_add(offset_ms);
                point
            }));
            metrics.extend(capture.metrics.into_iter().map(|mut point| {
                point.timestamp_ms = point.timestamp_ms.saturating_add(offset_ms);
                point
            }));
        }
    }

    positions.sort_by_key(|point| point.timestamp_ms);
    metrics.sort_by_key(|point| point.timestamp_ms);

    if let Some(limit_ms) = run_duration_ms.map(|ms| ms.saturating_add(1_500)) {
        positions.retain(|point| point.timestamp_ms <= limit_ms);
        metrics.retain(|point| point.timestamp_ms <= limit_ms);
    }

    log::info!(
        "mouse_hook: merged replay capture segments={} positions={} metrics={}",
        capture_count,
        positions.len(),
        metrics.len()
    );

    ReplayCaptureData { positions, metrics }
}

/// Return the most-recent metric snapshot without consuming the buffer.
/// Used by stats_ocr for shot-event correlation.
pub fn get_latest_metrics() -> Option<MouseMetrics> {
    let s = STATE.lock().ok()?;
    s.session_metrics.last().map(|p| p.metrics.clone())
}

/// Compute a session-averaged smoothness snapshot from all per-second MetricPoints
/// collected during the session.  Returns None if no data was recorded.
pub fn session_summary() -> Option<crate::session_store::SmoothnessSnapshot> {
    let s = STATE.lock().ok()?;
    if s.session_metrics.is_empty() {
        return None;
    }
    let n = s.session_metrics.len() as f32;
    let avg = |f: fn(&MetricPoint) -> f32| -> f32 {
        s.session_metrics.iter().map(|p| f(p)).sum::<f32>() / n
    };
    Some(crate::session_store::SmoothnessSnapshot {
        composite: avg(|p| p.metrics.smoothness),
        jitter: avg(|p| p.metrics.jitter),
        overshoot_rate: avg(|p| p.metrics.overshoot_rate),
        velocity_std: avg(|p| p.metrics.velocity_std),
        path_efficiency: avg(|p| p.metrics.path_efficiency),
        avg_speed: avg(|p| p.metrics.avg_speed),
        click_timing_cv: avg(|p| p.metrics.click_timing_cv),
        correction_ratio: avg(|p| p.metrics.correction_ratio),
        directional_bias: avg(|p| p.metrics.directional_bias),
    })
}

/// Update the user's mouse DPI/CPI so metrics are normalised correctly.
pub fn set_dpi(dpi: u32) {
    let clamped = dpi.max(100).min(32_000);
    MOUSE_DPI.store(clamped, Ordering::Relaxed);
    log::info!("Mouse DPI set to {clamped}");
}

/// Enable or disable live coaching feedback notifications.
pub fn set_feedback_enabled(enabled: bool) {
    FEEDBACK_ENABLED.store(enabled, Ordering::Relaxed);
}

/// Set feedback verbosity: 0 = minimal, 1 = standard, 2 = verbose.
pub fn set_feedback_verbosity(level: u8) {
    FEEDBACK_VERBOSITY.store(level.min(2), Ordering::Relaxed);
}

// ─── Windows Raw Input thread ─────────────────────────────────────────────────
//
// WH_MOUSE_LL (used by rdev) reports *absolute* OS cursor coordinates which are
// hard-clamped to the monitor rectangle by the OS.  In a 3-D FPS the game also
// calls SetCursorPos to re-centre the cursor after each frame, producing an
// equal-and-opposite delta that cancels the real movement.  Both effects make
// cursor_x/cursor_y useless for path replay.
//
// WM_INPUT delivers lLastX/lLastY straight from the mouse sensor hardware — the
// same source the game uses — completely unaffected by cursor clamping or
// recentering.  We use it exclusively to track cursor_x/cursor_y and build the
// raw_positions buffer.  rdev continues for hotkeys, click detection and metrics.

#[cfg(target_os = "windows")]
fn start_raw_input_thread() {
    std::thread::Builder::new()
        .name("raw-input-mouse".into())
        .spawn(raw_input_loop)
        .expect("failed to spawn raw input thread");
}

#[cfg(target_os = "windows")]
fn raw_input_loop() {
    use std::mem::size_of;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::{RAWINPUTDEVICE, RIDEV_INPUTSINK, RegisterRawInputDevices};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, HWND_MESSAGE, MSG, RegisterClassW,
        TranslateMessage, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASS_STYLES, WNDCLASSW,
    };
    use windows::core::PCWSTR;

    unsafe {
        let hinstance = GetModuleHandleW(PCWSTR::null()).unwrap_or_default();

        let class_name: Vec<u16> = "KovaaksRawMouse\0".encode_utf16().collect();

        let wc = WNDCLASSW {
            style: WNDCLASS_STYLES(0),
            lpfnWndProc: Some(raw_input_wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: windows::Win32::Foundation::HINSTANCE(hinstance.0),
            hIcon: Default::default(),
            hCursor: Default::default(),
            hbrBackground: Default::default(),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
        };
        RegisterClassW(&wc);

        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(windows::Win32::Foundation::HINSTANCE(hinstance.0)),
            None,
        ) {
            Ok(h) => h,
            Err(e) => {
                log::error!("raw input: CreateWindowExW: {e}");
                return;
            }
        };

        let dev = RAWINPUTDEVICE {
            usUsagePage: 0x01, // HID_USAGE_PAGE_GENERIC
            usUsage: 0x02,     // HID_USAGE_GENERIC_MOUSE
            dwFlags: RIDEV_INPUTSINK,
            hwndTarget: hwnd,
        };
        if let Err(e) = RegisterRawInputDevices(&[dev], size_of::<RAWINPUTDEVICE>() as u32) {
            log::error!("raw input: RegisterRawInputDevices: {e}");
            return;
        }

        log::info!("Raw input mouse listener started");
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn raw_input_wnd_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use std::mem::size_of;
    use windows::Win32::UI::Input::{
        GetRawInputData, HRAWINPUT, RAWINPUT, RAWINPUTHEADER, RID_INPUT,
    };
    use windows::Win32::UI::WindowsAndMessaging::DefWindowProcW;

    const WM_INPUT: u32 = 0x00FF;
    const RIM_TYPEMOUSE: u32 = 0;
    const MOUSE_MOVE_ABSOLUTE: u16 = 0x01; // usFlags bit — clear = relative

    if msg == WM_INPUT {
        let handle = HRAWINPUT(lparam.0 as *mut std::ffi::c_void);
        let header_sz = size_of::<RAWINPUTHEADER>() as u32;
        let mut needed: u32 = 0;
        unsafe { GetRawInputData(handle, RID_INPUT, None, &mut needed, header_sz) };

        if needed > 0 && (needed as usize) <= size_of::<RAWINPUT>() {
            // Stack-allocate: RAWINPUT for mouse is ~40 bytes — well within limits.
            let mut raw = std::mem::MaybeUninit::<RAWINPUT>::zeroed();
            let written = unsafe {
                GetRawInputData(
                    handle,
                    RID_INPUT,
                    Some(raw.as_mut_ptr() as *mut _),
                    &mut needed,
                    header_sz,
                )
            };
            if written == needed {
                let raw = unsafe { raw.assume_init() };
                if raw.header.dwType == RIM_TYPEMOUSE {
                    let mouse = unsafe { &raw.data.mouse };
                    // Ignore absolute-mode reports (pen tablets, digitisers).
                    if mouse.usFlags.0 & MOUSE_MOVE_ABSOLUTE == 0 {
                        let dx = mouse.lLastX as f64;
                        let dy = mouse.lLastY as f64;
                        if (dx != 0.0 || dy != 0.0) && TRACKING_ACTIVE.load(Ordering::Relaxed) {
                            let now = Instant::now();
                            if let Ok(mut s) = STATE.lock() {
                                s.cursor_x += dx;
                                s.cursor_y += dy;
                                // Feed the metrics engine with delta-space coords so jitter/
                                // velocity/overshoot calculations are immune to edge clamping.
                                let (evx, evy) = (s.cursor_x, s.cursor_y);
                                s.events.push(RawMouseEvent {
                                    x: evx,
                                    y: evy,
                                    time: now,
                                });
                                if s.events.len() > 50_000 {
                                    s.events.drain(..10_000);
                                }
                                let sample = match s.last_raw_sample {
                                    None => true,
                                    Some(last) => {
                                        now.duration_since(last) >= Duration::from_millis(16)
                                    }
                                };
                                if sample {
                                    let ts_ms =
                                        now.saturating_duration_since(s.session_start).as_millis()
                                            as u64;
                                    let (cx, cy) = (s.cursor_x, s.cursor_y);
                                    s.raw_positions.push(RawPositionPoint {
                                        x: cx,
                                        y: cy,
                                        timestamp_ms: ts_ms,
                                        is_click: false,
                                    });
                                    s.last_raw_sample = Some(now);
                                    if s.raw_positions.len() > 30_000 {
                                        s.raw_positions.drain(..5_000);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

// ─── rdev callback ────────────────────────────────────────────────────────────

fn mouse_event_callback(event: Event) {
    if !HOOK_RUNNING.load(Ordering::Relaxed) {
        return;
    }

    match event.event_type {
        // On Windows the raw-input thread owns all mouse movement and
        // raw_positions; the rdev callback is only used for hotkeys and clicks.
        // Mouse movement is captured via WM_INPUT hardware deltas in the raw
        // input thread; ignore rdev absolute cursor moves to avoid edge clamp
        // and SetCursorPos recenter artifacts.
        EventType::MouseMove { .. } => {}
        EventType::ButtonPress(rdev::Button::Left) => {
            if TRACKING_ACTIVE.load(Ordering::Relaxed) {
                let now = Instant::now();
                if let Ok(mut s) = STATE.lock() {
                    s.click_times.push_back(now);
                    if s.click_times.len() > 500 {
                        s.click_times.pop_front();
                    }
                    s.lmb_down_at = Some(now);
                    // Record click position in the raw-positions buffer
                    let ts_ms = now.saturating_duration_since(s.session_start).as_millis() as u64;
                    let click_x = s.cursor_x;
                    let click_y = s.cursor_y;
                    s.raw_positions.push(RawPositionPoint {
                        x: click_x,
                        y: click_y,
                        timestamp_ms: ts_ms,
                        is_click: true,
                    });
                }
            }
        }
        EventType::ButtonRelease(rdev::Button::Left) => {
            if TRACKING_ACTIVE.load(Ordering::Relaxed) {
                if let Ok(mut s) = STATE.lock() {
                    if let Some(down) = s.lmb_down_at.take() {
                        let hold_ms = down.elapsed().as_secs_f32() * 1000.0;
                        s.hold_durations.push_back(hold_ms);
                        if s.hold_durations.len() > 500 {
                            s.hold_durations.pop_front();
                        }
                    }
                }
            }
        }
        EventType::KeyPress(Key::F8) => {
            if let Ok(guard) = APP_HANDLE.lock() {
                if let Some(app) = guard.as_ref() {
                    let _ = app.emit("toggle-settings", ());
                }
            }
        }
        EventType::KeyPress(Key::F9) => {
            if let Ok(guard) = APP_HANDLE.lock() {
                if let Some(app) = guard.as_ref() {
                    let _ = app.emit("toggle-debug-state-overlay", ());
                }
            }
        }
        EventType::KeyPress(Key::F10) => {
            // Toggle HUD drag-to-reposition mode
            if let Ok(guard) = APP_HANDLE.lock() {
                if let Some(app) = guard.as_ref() {
                    let _ = app.emit("toggle-layout-huds", ());
                }
            }
        }
        _ => {}
    }
}

// ─── Metric emitter ───────────────────────────────────────────────────────────

fn metric_emitter_loop(app: AppHandle) {
    let tick = Duration::from_secs(1);
    let window = Duration::from_secs(5);

    // Per-metric streak counters and cooldowns (in ticks).
    let mut streaks: HashMap<&'static str, u32> = HashMap::new();
    let mut cooldowns: HashMap<&'static str, u32> = HashMap::new();

    while HOOK_RUNNING.load(Ordering::Relaxed) {
        std::thread::sleep(tick);

        // Decrement all cooldowns
        for v in cooldowns.values_mut() {
            *v = v.saturating_sub(1);
        }

        // Only compute and emit when a session is active
        if !TRACKING_ACTIVE.load(Ordering::Relaxed) {
            // Reset streaks when not in session
            streaks.clear();
            continue;
        }

        // ── Snapshot raw data under a brief lock, then compute outside it ────────
        // Previously the full compute_metrics() call (5-10 ms of PCA, sliding-window
        // jitter, path-efficiency math) ran while STATE was locked.  Every incoming
        // mouse event had to spin-wait for the lock during that computation, adding
        // up to 10 ms of input latency once per second.
        // Fix: hold the lock only long enough to clone the small data slices needed,
        // then release it before doing any heavy work.
        let (metrics, timestamp_ms, scenario) = {
            let now = Instant::now();
            let cutoff = now - window;

            let (recent_owned, click_times_snap, hold_durations_snap, ts) = {
                let s = STATE.lock().unwrap(); // ← held for clone only (~μs)
                let recent_owned: Vec<RawMouseEvent> = s
                    .events
                    .iter()
                    .filter(|e| e.time >= cutoff)
                    .cloned()
                    .collect();
                let click_times_snap: Vec<Instant> = s
                    .click_times
                    .iter()
                    .filter(|&&t| t >= cutoff)
                    .copied()
                    .collect();
                let hold_durations_snap: Vec<f32> = s.hold_durations.iter().copied().collect();
                let ts = s.session_start.elapsed().as_millis() as u64;
                (recent_owned, click_times_snap, hold_durations_snap, ts)
            }; // ← lock released — everything below is lock-free ──────────────

            let click_intervals_ms: Vec<f64> = click_times_snap
                .windows(2)
                .map(|w| w[1].duration_since(w[0]).as_secs_f64() * 1000.0)
                .collect();

            let avg_hold_ms = if hold_durations_snap.is_empty() {
                0.0f32
            } else {
                hold_durations_snap.iter().sum::<f32>() / hold_durations_snap.len() as f32
            };

            let dpi = MOUSE_DPI.load(Ordering::Relaxed);

            let scenario = "Unknown".to_string();

            let recent_refs: Vec<&RawMouseEvent> = recent_owned.iter().collect();
            let mut m = compute_metrics(&recent_refs, dpi, &click_intervals_ms, &scenario);
            m.avg_hold_ms = avg_hold_ms;
            (m, ts, scenario)
        };

        let point = MetricPoint {
            timestamp_ms,
            metrics: metrics.clone(),
        };

        {
            let mut s = STATE.lock().unwrap();
            s.session_metrics.push(point);
        }

        let _ = app.emit(EVENT_MOUSE_METRICS, &metrics);

        // ── Live feedback ─────────────────────────────────────────────────────
        if FEEDBACK_ENABLED.load(Ordering::Relaxed) {
            let verbosity = FEEDBACK_VERBOSITY.load(Ordering::Relaxed);
            maybe_emit_feedback(
                &app,
                &metrics,
                &scenario,
                verbosity,
                &mut streaks,
                &mut cooldowns,
            );
        }
    }
}

// ─── Live feedback helper ─────────────────────────────────────────────────────

/// Increment streak counter if `cond` is true, else reset; returns new value.
#[inline]
fn streak_tick(streaks: &mut HashMap<&'static str, u32>, key: &'static str, cond: bool) -> u32 {
    let v = streaks.entry(key).or_insert(0);
    if cond {
        *v += 1
    } else {
        *v = 0
    }
    *v
}

/// Emit a live-feedback event unless the per-key cooldown is still active.
#[inline]
fn maybe_emit(
    app: &AppHandle,
    key: &'static str,
    msg: &str,
    kind: &str,
    cooldowns: &mut HashMap<&'static str, u32>,
) {
    if *cooldowns.get(key).unwrap_or(&0) > 0 {
        return;
    }
    let _ = app.emit(
        EVENT_LIVE_FEEDBACK,
        LiveFeedback {
            message: msg.to_string(),
            kind: kind.to_string(),
            metric: key.to_string(),
        },
    );
    cooldowns.insert(key, 12); // 12-second cooldown
}

/// Check metric values against thresholds, increment/reset streak counters,
/// and emit a `live-feedback` event when a streak crosses its trigger threshold
/// and the per-category cooldown has expired.
///
/// Only emits tips that make sense for the current scenario type:
/// - clicking scenarios → skip jitter/velocity_std (speed changes are intentional)
/// - tracking scenarios → skip click_timing (no meaningful click rhythm)
fn maybe_emit_feedback(
    app: &AppHandle,
    m: &MouseMetrics,
    scenario: &str,
    verbosity: u8,
    streaks: &mut HashMap<&'static str, u32>,
    cooldowns: &mut HashMap<&'static str, u32>,
) {
    let is_clicking = matches!(
        scenario,
        "OneShotClicking" | "MultiHitClicking" | "ReactiveClicking"
    );
    let is_tracking = matches!(scenario, "Tracking" | "PureTracking");
    let is_accuracy = scenario == "AccuracyDrill";

    // ── Always active (level 0+) ─────────────────────────────────────────────

    // High overshoot: 3 consecutive seconds above threshold
    // Threshold is tighter for clicking (you should land cleanly on each shot).
    let overshoot_thresh = if is_clicking { 0.35 } else { 0.45 };
    if streak_tick(streaks, "overshoot", m.overshoot_rate > overshoot_thresh) >= 3 {
        let msg = if is_tracking {
            "Overshooting — reduce speed slightly and let the cursor settle before correcting"
        } else if is_clicking {
            "Overshooting clicks — shorten the flick so you land on target instead of past it"
        } else {
            "Overshooting — slow down in the final stretch before the target"
        };
        maybe_emit(app, "overshoot", msg, "warning", cooldowns);
        streaks.insert("overshoot", 0);
    }

    // Smooth streak: 5 consecutive seconds >82 → positive reinforcement.
    // Threshold is higher for clicking (overshoot-heavy score) to stay meaningful.
    let smooth_thresh = if is_clicking { 88.0 } else { 82.0 };
    if streak_tick(streaks, "smooth_streak", m.smoothness > smooth_thresh) >= 5 {
        let msg = if is_clicking {
            "Precision streak! Flicks are landing clean"
        } else if is_tracking {
            "Smooth tracking — strong control, keep this rhythm"
        } else {
            "Smooth streak — aim is clean, keep it up"
        };
        maybe_emit(app, "smooth_streak", msg, "positive", cooldowns);
        streaks.insert("smooth_streak", 0);
    }

    if verbosity < 1 {
        return;
    }

    // ── Standard level (1+) ──────────────────────────────────────────────────

    // Inconsistent click timing: only meaningful for clicking scenarios
    if is_clicking
        && m.click_timing_cv > 0.0
        && streak_tick(streaks, "click_timing", m.click_timing_cv > 0.65) >= 2
    {
        maybe_emit(
            app,
            "click_timing",
            "Click timing is uneven — hold a steadier rhythm between shots",
            "tip",
            cooldowns,
        );
        streaks.insert("click_timing", 0);
    } else if !is_clicking {
        streaks.insert("click_timing", 0);
    }

    // Over-correcting: applies to all scenarios, message varies
    if streak_tick(streaks, "correction", m.correction_ratio > 0.55) >= 3 {
        let msg = if is_clicking {
            "Too many micro-corrections — trust your first flick and commit earlier"
        } else if is_tracking {
            "Over-steering on target — apply steadier pressure instead of chasing"
        } else {
            "Over-correcting — commit to your first move and reduce extra adjustments"
        };
        maybe_emit(app, "correction", msg, "tip", cooldowns);
        streaks.insert("correction", 0);
    }

    // Speed inconsistency: only tracked for tracking — clicking is naturally stop-and-go
    if is_tracking && streak_tick(streaks, "velocity_std", m.velocity_std > 0.65) >= 3 {
        maybe_emit(
            app,
            "velocity_std",
            "Speed is choppy — match target pace and keep a steadier flow",
            "warning",
            cooldowns,
        );
        streaks.insert("velocity_std", 0);
    } else if is_clicking {
        streaks.insert("velocity_std", 0);
    }

    // Path efficiency: direct flicks matter for accuracy drills and clicking
    if (is_accuracy || is_clicking)
        && streak_tick(streaks, "path_eff", m.path_efficiency < 0.72) >= 3
    {
        let msg = if is_clicking {
            "Curved flick paths — take a straighter line to target"
        } else {
            "Curved paths to targets — commit to a straighter snap line"
        };
        maybe_emit(app, "path_eff", msg, "tip", cooldowns);
        streaks.insert("path_eff", 0);
    } else if is_tracking {
        streaks.insert("path_eff", 0);
    }

    if verbosity < 2 {
        return;
    }

    // ── Verbose level (2) ────────────────────────────────────────────────────

    // Directional bias: applies to all
    if m.directional_bias > 0.0 && streak_tick(streaks, "bias", m.directional_bias > 0.55) >= 3 {
        let msg = if is_clicking {
            "Consistent one-side drift — re-center your arm and mouse position"
        } else {
            "Aim is drifting to one side — check mouse angle and re-center your arm"
        };
        maybe_emit(app, "bias", msg, "tip", cooldowns);
        streaks.insert("bias", 0);
    }

    // Jitter: only meaningful while actively tracking or unknown
    if (is_tracking || scenario == "Unknown")
        && streak_tick(streaks, "jitter", m.jitter > 0.25) >= 3
    {
        maybe_emit(
            app,
            "jitter",
            "Too much wobble — relax grip pressure and let your arm drive the motion",
            "tip",
            cooldowns,
        );
        streaks.insert("jitter", 0);
    } else if is_clicking {
        streaks.insert("jitter", 0);
    }

    // Low path efficiency in tracking: wandering while following target
    if is_tracking && streak_tick(streaks, "path_eff_track", m.path_efficiency < 0.60) >= 3 {
        maybe_emit(
            app,
            "path_eff_track",
            "Drifting off target — stay on the target path instead of chasing after it",
            "tip",
            cooldowns,
        );
        streaks.insert("path_eff_track", 0);
    }
}

// ─── Metric computation ───────────────────────────────────────────────────────

/// Determine the primary axis of motion from a set of velocity vectors using
/// 2-D PCA (eigenvector of the velocity covariance matrix with the largest
/// eigenvalue).  Returns a unit vector `(ax, ay)`.
///
/// This is the key enabler for tracking scenarios: when the user continuously
/// chases a left-right target, the primary axis is horizontal.  Jitter is then
/// measured *perpendicular* to that axis (vertical wobble), so intentional
/// directional changes along the tracking axis are never penalised.
fn primary_axis(velocities: &[(f64, f64)]) -> (f64, f64) {
    let n = velocities.len() as f64;
    let mx = velocities.iter().map(|(vx, _)| vx).sum::<f64>() / n;
    let my = velocities.iter().map(|(_, vy)| vy).sum::<f64>() / n;
    let cxx = velocities
        .iter()
        .map(|(vx, _)| (vx - mx).powi(2))
        .sum::<f64>()
        / n;
    let cyy = velocities
        .iter()
        .map(|(_, vy)| (vy - my).powi(2))
        .sum::<f64>()
        / n;
    let cxy = velocities
        .iter()
        .map(|(vx, vy)| (vx - mx) * (vy - my))
        .sum::<f64>()
        / n;

    // Eigenvector for the larger eigenvalue of [[cxx, cxy], [cxy, cyy]].
    // The closed-form solution for a 2×2 symmetric matrix:
    //   λ₁ = ((cxx+cyy) + √((cxx-cyy)²+4cxy²)) / 2
    //   eigenvector ∝ (cxx - λ₂, cxy) = (diff + disc, 2·cxy)  (where diff = cxx-cyy)
    let diff = cxx - cyy;
    let disc = (diff * diff + 4.0 * cxy * cxy).sqrt();
    let ex = diff + disc;
    let ey = 2.0 * cxy;
    let mag = (ex * ex + ey * ey).sqrt();
    if mag < 1e-9 {
        (1.0, 0.0)
    } else {
        (ex / mag, ey / mag)
    }
}

/// Compute smoothness metrics from a set of recent raw mouse events.
///
/// `click_intervals_ms`: inter-click intervals (ms) from the same time window,
/// used for click_timing_cv.  Pass an empty slice when no click data is available.
/// `scenario` is the string from `stats_ocr::get_scenario_type()` and controls
/// the composite-score weight profile (see inline comments).
fn compute_metrics(
    events: &[&RawMouseEvent],
    dpi: u32,
    click_intervals_ms: &[f64],
    scenario: &str,
) -> MouseMetrics {
    let blank = MouseMetrics {
        smoothness: 100.0,
        jitter: 0.0,
        overshoot_rate: 0.0,
        velocity_std: 0.0,
        avg_speed: 0.0,
        path_efficiency: 1.0,
        click_timing_cv: 0.0,
        avg_hold_ms: 0.0,
        correction_ratio: 0.0,
        directional_bias: 0.0,
    };

    if events.len() < 3 {
        return blank;
    }

    let dpi_factor = dpi as f64 / 800.0;
    // Minimum speed threshold scales with DPI so that quantisation noise from
    // high-CPI sensors is filtered the same as on a lower-CPI mouse.
    let min_speed = 8.0 * dpi_factor; // px/s at 800-DPI equivalent

    // ── Build velocity vectors ──────────────────────────────────────────────
    let mut velocities: Vec<(f64, f64)> = Vec::with_capacity(events.len());
    let mut speeds: Vec<f64> = Vec::with_capacity(events.len());

    for w in events.windows(2) {
        let dt = w[1].time.duration_since(w[0].time).as_secs_f64();
        if dt < 1e-4 {
            continue; // sub-millisecond duplicates
        }
        let vx = (w[1].x - w[0].x) / dt;
        let vy = (w[1].y - w[0].y) / dt;
        let speed = (vx * vx + vy * vy).sqrt();
        if speed < min_speed {
            continue; // near-stationary — don't pollute directional analysis
        }
        velocities.push((vx, vy));
        speeds.push(speed);
    }

    if velocities.len() < 2 {
        return blank;
    }

    let mean_speed = speeds.iter().sum::<f64>() / speeds.len() as f64;

    // ── Jitter: local sliding-window PCA ────────────────────────────────────
    // A single global PCA axis is wrong for multi-directional scenarios
    // (Gridshot, click training, etc.): every movement goes in a different
    // direction, so all segments appear falsely "lateral" against the averaged
    // axis → artificially high jitter for perfectly clean movement.
    // Fix: compute PCA on small overlapping windows so the reference axis
    // always reflects the *current* direction of intent.
    const JITTER_WIN: usize = 10;
    const JITTER_STEP: usize = JITTER_WIN / 2;
    let mut local_jitter_sum = 0.0f64;
    let mut local_jitter_count = 0usize;

    let n_vel = velocities.len();
    if n_vel >= JITTER_WIN {
        let mut chunk_start = 0usize;
        while chunk_start + JITTER_WIN <= n_vel {
            let chunk = &velocities[chunk_start..chunk_start + JITTER_WIN];
            let (cax, cay) = primary_axis(chunk);
            let (clx, cly) = (-cay, cax);
            let lat_rms_sq = chunk
                .iter()
                .map(|(vx, vy)| {
                    let l = vx * clx + vy * cly;
                    l * l
                })
                .sum::<f64>()
                / chunk.len() as f64;
            let chunk_mean = chunk
                .iter()
                .map(|(vx, vy)| (vx * vx + vy * vy).sqrt())
                .sum::<f64>()
                / chunk.len() as f64;
            local_jitter_sum += lat_rms_sq.sqrt() / chunk_mean.max(1.0);
            local_jitter_count += 1;
            chunk_start += JITTER_STEP;
        }
    }

    // ── Global PCA for overshoot (axial reversal detection) ─────────────────
    let (gax, gay) = primary_axis(&velocities);
    let (glx, gly) = (-gay, gax);
    let mut axial: Vec<f64> = Vec::with_capacity(velocities.len());
    for (vx, vy) in &velocities {
        axial.push(vx * gax + vy * gay);
    }

    let jitter = if local_jitter_count > 0 {
        (local_jitter_sum / local_jitter_count as f64) as f32
    } else {
        // Fewer samples than one window — fall back to global PCA.
        let lat_rms = {
            let sum_sq: f64 = velocities
                .iter()
                .map(|(vx, vy)| {
                    let l = vx * glx + vy * gly;
                    l * l
                })
                .sum();
            (sum_sq / velocities.len() as f64).sqrt()
        };
        (lat_rms / mean_speed.max(1.0)) as f32
    };

    // ── Consistency: coefficient of variation of speed ───────────────────────
    // std/mean is dimensionless → DPI-independent.
    //
    // Natural voluntary arm movement (Fitts's law bell-curve speed profile)
    // inherently produces a CV of ~0.3–0.5 even for perfectly smooth flicks.
    // Penalising CV from zero punishes all real movement.  Instead, only start
    // penalising once CV exceeds a natural-movement baseline of 0.4 so that
    // normal acceleration/deceleration arcs are not downgraded.
    const CV_NATURAL_BASELINE: f64 = 0.4;
    let speed_variance =
        speeds.iter().map(|s| (s - mean_speed).powi(2)).sum::<f64>() / speeds.len() as f64;
    let raw_cv = speed_variance.sqrt() / mean_speed.max(1.0);
    let velocity_cv =
        ((raw_cv - CV_NATURAL_BASELINE).max(0.0) / (1.0 - CV_NATURAL_BASELINE)).min(1.0) as f32;

    // ── Overshoot: sharp velocity reversals via direct angle test ────────────
    // The previous global-PCA approach projected all velocities onto one
    // averaged axis and counted sign-flips.  That breaks for any scenario
    // where movement is multi-directional (gridshot, reaction flicking,
    // circular tracking): the single "dominant" axis is meaningless, so every
    // legitimate change of direction between two targets registers as a false
    // overshoot.
    //
    // Fix: test each consecutive velocity pair directly.  A "sharp reversal"
    // is when the angle between v[i] and v[i+1] exceeds 120° (dot < -0.5)
    // while both are above the speed threshold — meaning there was no
    // deceleration through zero.  This matches detectOvershoots() in
    // MousePathViewer.tsx exactly, keeping backend numbers consistent with
    // what the path viewer displays.
    let axial_threshold = mean_speed * 0.25; // kept for directional-bias block below
    let speed_threshold = mean_speed * 0.25;
    let mut sharp_reversals = 0usize;
    let mut qualified_segments = 0usize;
    for i in 0..velocities.len().saturating_sub(1) {
        let (vx0, vy0) = velocities[i];
        let (vx1, vy1) = velocities[i + 1];
        let spd0 = (vx0 * vx0 + vy0 * vy0).sqrt();
        let spd1 = (vx1 * vx1 + vy1 * vy1).sqrt();
        if spd0 > speed_threshold {
            qualified_segments += 1;
            if spd1 > speed_threshold {
                let dot = (vx0 * vx1 + vy0 * vy1) / (spd0 * spd1);
                if dot < -0.5 {
                    // angle > 120°
                    sharp_reversals += 1;
                }
            }
        }
    }
    let overshoot_rate = if qualified_segments == 0 {
        0.0f32
    } else {
        (sharp_reversals as f64 / qualified_segments as f64) as f32
    };

    // ── DPI-normalised average speed for display ─────────────────────────────
    let avg_speed = (mean_speed / dpi_factor) as f32;

    // ── Path efficiency: displacement ÷ path-length per window ───────────────
    // Catches low-frequency S-curve wobble: the cursor wanders sideways while
    // broadly moving toward a target.  This is missed by velocity-based jitter
    // because the perpendicular velocity at any instant is small — it's the
    // cumulative curvature that exposes it.
    //
    // Window = 15 raw events (~250 ms at 60 Hz), 50 % overlap.  Only windows
    // where the cursor actually moved (path > 5 px) are counted.
    const PATH_WIN: usize = 15;
    const PATH_STEP: usize = PATH_WIN / 2;
    let min_path = 5.0 * dpi_factor;
    let mut path_eff_sum = 0.0f64;
    let mut path_eff_count = 0usize;

    let n_ev = events.len();
    if n_ev >= PATH_WIN {
        let mut ev_start = 0usize;
        while ev_start + PATH_WIN <= n_ev {
            let win = &events[ev_start..ev_start + PATH_WIN];
            let path_len: f64 = win
                .windows(2)
                .map(|w| {
                    let dx = w[1].x - w[0].x;
                    let dy = w[1].y - w[0].y;
                    (dx * dx + dy * dy).sqrt()
                })
                .sum();
            if path_len >= min_path {
                let dx = win.last().unwrap().x - win[0].x;
                let dy = win.last().unwrap().y - win[0].y;
                let displacement = (dx * dx + dy * dy).sqrt();
                path_eff_sum += (displacement / path_len).min(1.0);
                path_eff_count += 1;
            }
            ev_start += PATH_STEP;
        }
    }
    let path_efficiency = if path_eff_count > 0 {
        (path_eff_sum / path_eff_count as f64) as f32
    } else {
        1.0f32 // not enough data — don't penalise
    };

    // ── Click timing CV ──────────────────────────────────────────────────────
    // Schmidt et al. (1979): consistent inter-click intervals indicate good
    // motor rhythm. CV = std/mean over the measurement window's click intervals.
    let click_timing_cv = if click_intervals_ms.len() >= 3 {
        let n = click_intervals_ms.len() as f64;
        let mean = click_intervals_ms.iter().sum::<f64>() / n;
        let variance = click_intervals_ms
            .iter()
            .map(|x| (x - mean).powi(2))
            .sum::<f64>()
            / n;
        (variance.sqrt() / mean.max(1.0)) as f32
    } else {
        0.0f32
    };

    // ── Correction ratio ─────────────────────────────────────────────────────
    // Fitts' Law: expert aimers spend most of their movement time in the
    // ballistic (fast) phase; excessive correction-phase time signals hesitation.
    // Correction phase = speed < 40 % of mean speed.
    let correction_samples = speeds.iter().filter(|&&s| s < mean_speed * 0.40).count();
    let correction_ratio = (correction_samples as f32 / speeds.len().max(1) as f32).min(1.0);

    // ── Directional bias in overshoot events ─────────────────────────────────
    // Natapov et al. (2009): systematic bias (always overshooting same direction)
    // reveals a starting-position habit, not random error.
    // Measure sign of axial velocity just BEFORE each reversal.
    let mut pre_reversal_signs: Vec<f64> = Vec::new();
    for i in 0..axial.len().saturating_sub(1) {
        let a0 = axial[i];
        let a1 = axial[i + 1];
        if a0.abs() > axial_threshold && a1.abs() > axial_threshold && a0 * a1 < 0.0 {
            pre_reversal_signs.push(a0.signum());
        }
    }
    let directional_bias = if pre_reversal_signs.len() >= 3 {
        let mean_sign = pre_reversal_signs.iter().sum::<f64>() / pre_reversal_signs.len() as f64;
        mean_sign.abs() as f32 // 0=perfectly balanced, 1=always same direction
    } else {
        0.0f32
    };

    // ── Composite score ──────────────────────────────────────────────────────
    // Weight profiles are tuned per scenario type because the same raw metric
    // value means very different things depending on how the mouse is being used:
    //
    //  Tracking  — jitter & speed consistency are the dominant quality signals;
    //              overshoots happen naturally during direction changes so the
    //              overshoot weight is reduced.
    //
    //  Clicking  — landing cleanly on each target (overshoot) is the whole game;
    //              velocity is intentionally stop-and-go so consistency is low-
    //              weighted, and per-axis jitter between shots is not meaningful.
    //
    //  Accuracy  — straight direct flicks (path efficiency) matter most;
    //              overshoot is still important but secondary.
    //
    //  Unknown   — balanced baseline (original formula).
    let (w_jitter, w_path, w_consistency, w_overshoot): (f64, f64, f64, f64) = match scenario {
        "Tracking" | "PureTracking" => (35.0, 25.0, 30.0, 10.0),
        "OneShotClicking" | "MultiHitClicking" | "ReactiveClicking" => (5.0, 25.0, 10.0, 60.0),
        "AccuracyDrill" => (10.0, 40.0, 10.0, 40.0),
        _ =>
        // Unknown / default
        {
            (30.0, 15.0, 25.0, 30.0)
        }
    };
    let jitter_score = (1.0 - (jitter as f64).min(1.0)) * w_jitter;
    let path_score = path_efficiency as f64 * w_path;
    let consistency_score = (1.0 - (velocity_cv as f64).min(1.0)) * w_consistency;
    let overshoot_score = (1.0 - overshoot_rate as f64) * w_overshoot;
    let smoothness =
        (jitter_score + path_score + consistency_score + overshoot_score).clamp(0.0, 100.0) as f32;

    MouseMetrics {
        smoothness,
        jitter,
        overshoot_rate,
        velocity_std: velocity_cv,
        avg_speed,
        path_efficiency,
        click_timing_cv,
        correction_ratio,
        directional_bias,
        avg_hold_ms: 0.0, // populated by the metric loop, not here
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Perfectly straight horizontal line at constant speed → maximum smoothness.
    /// Primary axis = X.  No lateral deviation, no speed variance, no reversals.
    #[test]
    fn smooth_straight_line_scores_high() {
        let now = Instant::now();
        let events: Vec<RawMouseEvent> = (0..60)
            .map(|i| RawMouseEvent {
                x: i as f64 * 8.0,
                y: 100.0,
                time: now + Duration::from_millis(i * 16),
            })
            .collect();
        let refs: Vec<&RawMouseEvent> = events.iter().collect();
        let m = compute_metrics(&refs, 800, &[], "Unknown");
        assert!(
            m.smoothness > 90.0,
            "expected high smoothness, got {}",
            m.smoothness
        );
        assert!(
            m.jitter < 0.05,
            "expected near-zero jitter, got {}",
            m.jitter
        );
        assert!(
            m.overshoot_rate < 0.05,
            "expected near-zero overshoot, got {}",
            m.overshoot_rate
        );
    }

    /// Horizontal tracking that gradually reverses — smooth left-right continuous
    /// motion.  Primary axis = X, Y virtually constant.  Smooth deceleration
    /// through zero should NOT register as overshoot.
    #[test]
    fn smooth_left_right_tracking_scores_high() {
        let now = Instant::now();
        // Simulate half a sine wave: position = 300·sin(t), constant y=100.
        // The cursor moves left → right → left smoothly (decelerates through centre).
        let n = 120usize;
        let events: Vec<RawMouseEvent> = (0..n)
            .map(|i| {
                let t = i as f64 / n as f64 * std::f64::consts::PI; // 0..π
                RawMouseEvent {
                    x: 300.0 * t.sin(),
                    y: 100.0,
                    time: now + Duration::from_millis(i as u64 * 16),
                }
            })
            .collect();
        let refs: Vec<&RawMouseEvent> = events.iter().collect();
        let m = compute_metrics(&refs, 800, &[], "Tracking");
        assert!(
            m.smoothness > 75.0,
            "smooth tracking should score high, got {}",
            m.smoothness
        );
        assert!(
            m.jitter < 0.1,
            "no lateral wobble expected, got {}",
            m.jitter
        );
    }

    /// Continuous left-right tracking at various DPI settings should yield the
    /// same smoothness score since the metrics are DPI-normalised.
    #[test]
    fn dpi_invariant_smoothness() {
        let make_events = |dpi_scale: f64| {
            let now = Instant::now();
            (0..80usize)
                .map(|i| RawMouseEvent {
                    x: i as f64 * 8.0 * dpi_scale,
                    y: 100.0 * dpi_scale,
                    time: now + Duration::from_millis(i as u64 * 16),
                })
                .collect::<Vec<_>>()
        };

        let ev800 = make_events(1.0);
        let ev1600 = make_events(2.0);
        let refs800: Vec<&RawMouseEvent> = ev800.iter().collect();
        let refs1600: Vec<&RawMouseEvent> = ev1600.iter().collect();

        let m800 = compute_metrics(&refs800, 800, &[], "Unknown");
        let m1600 = compute_metrics(&refs1600, 1600, &[], "Unknown");

        let diff = (m800.smoothness - m1600.smoothness).abs();
        assert!(
            diff < 5.0,
            "smoothness should be DPI-invariant; 800={} 1600={} diff={}",
            m800.smoothness,
            m1600.smoothness,
            diff
        );
        // avg_speed should also be similar after DPI normalisation
        let speed_diff = (m800.avg_speed - m1600.avg_speed).abs();
        assert!(
            speed_diff < m800.avg_speed * 0.05,
            "avg_speed should be DPI-normalised; 800={} 1600={}",
            m800.avg_speed,
            m1600.avg_speed
        );
    }

    /// Erratic zigzag movement — sharp direction reversals in both axes.
    /// Overshoot rate and jitter should both be high.
    #[test]
    fn erratic_movement_scores_low() {
        let now = Instant::now();
        // Zigzag: alternates diagonally but also includes random lateral offsets
        // to ensure jitter is non-zero.
        let events: Vec<RawMouseEvent> = (0..60)
            .map(|i| RawMouseEvent {
                x: if i % 2 == 0 { 0.0 } else { 400.0 },
                y: if i % 2 == 0 { 0.0 } else { 50.0 }, // slight y offset → lateral jitter
                time: now + Duration::from_millis(i * 8),
            })
            .collect();
        let refs: Vec<&RawMouseEvent> = events.iter().collect();
        let m = compute_metrics(&refs, 800, &[], "Unknown");
        // Sharp back-and-forth reversals → high overshoot
        assert!(
            m.overshoot_rate > 0.5,
            "expected high overshoot for zigzag, got {}",
            m.overshoot_rate
        );
        // Overall score should be dragged down
        assert!(
            m.smoothness < 85.0,
            "erratic movement should not score high, got {}",
            m.smoothness
        );
    }
}
