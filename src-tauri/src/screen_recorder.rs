use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

use crate::settings::RegionRect;

#[cfg(target_os = "windows")]
use dxgi_capture_rs::{CaptureError as DxgiCaptureError, DXGIManager};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, LPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, DXGI_OUTPUT_DESC, IDXGIAdapter1, IDXGIFactory1,
};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GA_ROOT, GW_OWNER, GetAncestor, GetClientRect, GetWindow,
    GetWindowThreadProcessId, IsWindowVisible,
};
#[cfg(target_os = "windows")]
use windows::core::BOOL;

/// Screen recorder: captures a low-resolution image snapshot of the game's
/// centre region during active sessions for post-session replay underlay.
///
/// Capture backend: Windows Graphics Capture only. The previous GDI/PrintWindow
/// path has been removed.

// ─── Types ─────────────────────────────────────────────────────────────────────

/// A single captured video frame for post-session mouse-path underlay.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScreenFrame {
    /// Milliseconds since session start.
    pub timestamp_ms: u64,
    /// JPEG-encoded frame, base64-encoded for Tauri IPC transport.
    pub jpeg_b64: String,
}

#[derive(Debug, Clone)]
struct CompletedFrameCapture {
    started_at_unix_ms: Option<u64>,
    ended_at_unix_ms: Option<u64>,
    frames: Vec<ScreenFrame>,
}

#[derive(Debug)]
struct PendingFrame {
    timestamp_ms: u64,
    bgra: Vec<u8>,
    width: u32,
    height: u32,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
struct CaptureTargetGeometry {
    monitor_rect: RegionRect,
    game_rect: RegionRect,
}

// ─── Config ─────────────────────────────────────────────────────────────────────

/// Keep up to 3 minutes of frames at the user-configured capture rate.
const MAX_CAPTURE_BUFFER_SECS: usize = 180;
/// Keep a short queue of completed session frame buffers so a fast restart does
/// not erase frames before the file-watcher persists the previous run.
const MAX_COMPLETED_SESSIONS: usize = 8;
/// Keep the encoder queue tiny so capture never builds an unbounded backlog.
const MAX_PENDING_ENCODE_FRAMES: usize = 2;
/// Output width after downscaling; height is preserved from the source aspect ratio.
const OUT_W: u32 = 480;
/// JPEG quality (0–100).
const JPEG_QUALITY: u8 = 65;

// ─── State ─────────────────────────────────────────────────────────────────────

static RECORDING: AtomicBool = AtomicBool::new(false);
static PAUSED: AtomicBool = AtomicBool::new(false);
static GENERATION: AtomicU64 = AtomicU64::new(0);
static REPLAY_CAPTURE_FPS: AtomicU64 =
    AtomicU64::new(crate::settings::DEFAULT_REPLAY_CAPTURE_FPS as u64);
static FRAMES: Lazy<Mutex<Vec<ScreenFrame>>> = Lazy::new(|| Mutex::new(Vec::new()));
static COMPLETED_FRAMES: Lazy<Mutex<VecDeque<CompletedFrameCapture>>> =
    Lazy::new(|| Mutex::new(VecDeque::new()));
static SESSION_START: Lazy<Mutex<Option<Instant>>> = Lazy::new(|| Mutex::new(None));
static SESSION_START_UNIX_MS: Lazy<Mutex<Option<u64>>> = Lazy::new(|| Mutex::new(None));
static LAST_CAPTURE_RECT: Lazy<Mutex<Option<RegionRect>>> = Lazy::new(|| Mutex::new(None));
static ENCODER_TX: Lazy<Mutex<Option<mpsc::SyncSender<PendingFrame>>>> =
    Lazy::new(|| Mutex::new(None));
static ENCODER_WORKER: Lazy<Mutex<Option<std::thread::JoinHandle<()>>>> =
    Lazy::new(|| Mutex::new(None));
#[cfg(target_os = "windows")]
static CAPTURE_TARGET_GEOMETRY: Lazy<Mutex<Option<CaptureTargetGeometry>>> =
    Lazy::new(|| Mutex::new(None));
#[cfg(target_os = "windows")]
static CAPTURE_WORKER: Lazy<Mutex<Option<std::thread::JoinHandle<()>>>> =
    Lazy::new(|| Mutex::new(None));

// ─── Public API ────────────────────────────────────────────────────────────────

/// The recorder derives its crop from the live KovaaK client area, not the
/// selected overlay monitor. This hook remains so monitor changes can clear the
/// last logged rect and force a fresh capture-rect log on the next session.
pub fn update_monitor_rect(_monitor: &RegionRect) {
    *LAST_CAPTURE_RECT.lock().unwrap() = None;
}

pub fn set_replay_capture_fps(fps: u32) {
    let clamped = fps.clamp(6, 60).max(1);
    REPLAY_CAPTURE_FPS.store(clamped as u64, Ordering::SeqCst);
}

pub fn replay_capture_fps() -> u32 {
    REPLAY_CAPTURE_FPS.load(Ordering::SeqCst).max(1) as u32
}

fn current_session_elapsed_ms() -> u64 {
    SESSION_START
        .lock()
        .unwrap()
        .map_or(0, |t| t.elapsed().as_millis() as u64)
}

/// Start frame capture for a new session, sharing the caller's `session_start`
/// instant so screen-frame timestamps are on the exact same clock as the mouse
/// position timestamps produced by `mouse_hook::start_session_tracking()`.
pub fn start(session_start: Instant) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    stop_capture_backend();
    finish_encoder_worker();

    let start_unix_ms = unix_now_ms();
    let _ = queue_completed_frames(start_unix_ms, "restart");
    FRAMES.lock().unwrap().clear();
    *SESSION_START.lock().unwrap() = Some(session_start);
    *SESSION_START_UNIX_MS.lock().unwrap() = Some(start_unix_ms);
    start_encoder_worker(generation);
    PAUSED.store(false, Ordering::SeqCst);
    RECORDING.store(true, Ordering::SeqCst);

    #[cfg(target_os = "windows")]
    start_capture_backend(generation);
}

/// Stop frame capture.
pub fn stop() {
    PAUSED.store(false, Ordering::SeqCst);
    if RECORDING.swap(false, Ordering::SeqCst) {
        stop_capture_backend();
        finish_encoder_worker();
        let captured_frames = queue_completed_frames(unix_now_ms(), "stop");
        let queued_sessions = COMPLETED_FRAMES.lock().unwrap().len();
        log::info!(
            "Screen recorder stopped (frames={}, queued_sessions={})",
            captured_frames,
            queued_sessions
        );
    }
}

/// Drain all recorded frames and clear the internal buffer.
pub fn drain_frames() -> Vec<ScreenFrame> {
    if let Some(capture) = COMPLETED_FRAMES.lock().unwrap().pop_front() {
        return capture.frames;
    }
    std::mem::take(&mut *FRAMES.lock().unwrap())
}

/// Return all recorded frames without removing them.
/// The buffer is cleared automatically when the next session starts.
pub fn get_frames() -> Vec<ScreenFrame> {
    let live = FRAMES.lock().unwrap().clone();
    if !live.is_empty() {
        return live;
    }
    COMPLETED_FRAMES
        .lock()
        .unwrap()
        .back()
        .map(|capture| capture.frames.clone())
        .unwrap_or_default()
}

/// Drain frames and return a replay-quality subset for persistent storage.
pub fn drain_frames_for_replay() -> Vec<ScreenFrame> {
    drain_frames()
}

pub fn take_frames_for_run(
    run_snapshot: Option<&crate::bridge::BridgeRunSnapshot>,
) -> Vec<ScreenFrame> {
    let mut completed = COMPLETED_FRAMES.lock().unwrap();
    if completed.is_empty() {
        drop(completed);
        return drain_frames_for_replay();
    }

    if let Some(snapshot) = run_snapshot {
        let (matched, remaining) =
            partition_matching_frame_captures(std::mem::take(&mut *completed), snapshot);
        *completed = remaining;
        if !matched.is_empty() {
            drop(completed);
            return merge_frame_captures(matched, snapshot);
        }
    }

    let fallback = completed.pop_back();
    drop(completed);
    fallback.map(|capture| capture.frames).unwrap_or_default()
}

// ─── Backend lifecycle ─────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn start_capture_backend(generation: u64) {
    let handle = std::thread::Builder::new()
        .name(format!("screen-recorder-dxgi-{generation}"))
        .spawn(move || {
            let mut logged_missing_hwnd = false;
            while RECORDING.load(Ordering::Relaxed)
                && GENERATION.load(Ordering::Relaxed) == generation
            {
                let hwnd = match resolve_capture_window_hwnd() {
                    Some(hwnd) => hwnd,
                    None => {
                        if !logged_missing_hwnd {
                            log::warn!("screen_recorder: game window handle is unavailable");
                            logged_missing_hwnd = true;
                        }
                        std::thread::sleep(Duration::from_millis(350));
                        continue;
                    }
                };
                logged_missing_hwnd = false;

                let mut geometry = match capture_target_geometry(hwnd) {
                    Ok(geometry) => geometry,
                    Err(error) => {
                        log::warn!(
                            "screen_recorder: failed to resolve game capture geometry: {error}"
                        );
                        std::thread::sleep(Duration::from_millis(350));
                        continue;
                    }
                };
                *CAPTURE_TARGET_GEOMETRY.lock().unwrap() = Some(geometry);

                let source_index = match dxgi_source_index_for_monitor(geometry.monitor_rect) {
                    Ok(index) => index,
                    Err(error) => {
                        log::warn!("screen_recorder: failed to map monitor to DXGI output: {error}");
                        std::thread::sleep(Duration::from_millis(500));
                        continue;
                    }
                };

                let mut manager = match DXGIManager::new(250) {
                    Ok(manager) => manager,
                    Err(error) => {
                        log::warn!("screen_recorder: failed to initialize DXGI capture: {error}");
                        std::thread::sleep(Duration::from_millis(500));
                        continue;
                    }
                };
                manager.set_timeout_ms(250);
                if source_index != 0 {
                    manager.set_capture_source_index(source_index);
                }

                log::info!(
                    "Screen recorder started (gen {generation}, dxgi_source={source_index})"
                );

                let mut last_frame_ts_ms = 0u64;
                let mut next_geometry_refresh_at = Instant::now();
                loop {
                    if !RECORDING.load(Ordering::Relaxed)
                        || GENERATION.load(Ordering::Relaxed) != generation
                    {
                        return;
                    }
                    if PAUSED.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(20));
                        continue;
                    }

                    let min_interval_ms = (1000 / replay_capture_fps() as u64).max(1);
                    if last_frame_ts_ms != 0 {
                        let ts_ms = current_session_elapsed_ms();
                        let next_due_ms = last_frame_ts_ms.saturating_add(min_interval_ms);
                        if ts_ms < next_due_ms {
                            std::thread::sleep(Duration::from_millis(
                                (next_due_ms - ts_ms).min(10),
                            ));
                            continue;
                        }
                    }

                    if Instant::now() >= next_geometry_refresh_at {
                        next_geometry_refresh_at = Instant::now() + Duration::from_millis(250);
                        if let Ok(updated_geometry) = capture_target_geometry(hwnd) {
                            if updated_geometry.monitor_rect != geometry.monitor_rect {
                                *CAPTURE_TARGET_GEOMETRY.lock().unwrap() = Some(updated_geometry);
                                break;
                            }
                            geometry = updated_geometry;
                            *CAPTURE_TARGET_GEOMETRY.lock().unwrap() = Some(geometry);
                        }
                    }

                    match manager.capture_frame_fast() {
                        Ok((pixels, (width, height))) => {
                            let ts_ms = current_session_elapsed_ms();
                            last_frame_ts_ms = ts_ms;
                            if let Err(error) = queue_dxgi_frame(
                                pixels,
                                width as u32,
                                height as u32,
                                ts_ms,
                                geometry,
                            ) {
                                log::warn!("screen_recorder: failed to process captured frame: {error}");
                            }
                        }
                        Err(DxgiCaptureError::Timeout) => {}
                        Err(DxgiCaptureError::AccessLost | DxgiCaptureError::RefreshFailure) => {
                            log::warn!(
                                "screen_recorder: DXGI capture source changed; recreating capture session"
                            );
                            break;
                        }
                        Err(error) => {
                            log::warn!("screen_recorder: DXGI capture error: {error}");
                            break;
                        }
                    }
                }

                std::thread::sleep(Duration::from_millis(200));
            }
        })
        .expect("failed to spawn screen-recorder capture thread");
    *CAPTURE_WORKER.lock().unwrap() = Some(handle);
}

#[cfg(target_os = "windows")]
fn resolve_capture_window_hwnd() -> Option<HWND> {
    if let Some(pid) = crate::bridge::current_game_pid() {
        if let Some(main_hwnd) = find_main_window_for_pid(pid) {
            let root = unsafe { GetAncestor(main_hwnd, GA_ROOT) };
            if !root.is_invalid() {
                return Some(root);
            }
            return Some(main_hwnd);
        }
    }

    let cached = crate::window_tracker::get_game_hwnd()?;
    let root = unsafe { GetAncestor(cached, GA_ROOT) };
    if !root.is_invalid() {
        return Some(root);
    }

    let mut pid = 0u32;
    unsafe {
        let _ = GetWindowThreadProcessId(cached, Some(&mut pid));
    }
    if pid == 0 {
        return Some(cached);
    }

    find_main_window_for_pid(pid).or(Some(cached))
}

#[cfg(target_os = "windows")]
fn capture_target_geometry(hwnd: HWND) -> anyhow::Result<CaptureTargetGeometry> {
    use windows::Win32::Foundation::{POINT, RECT};

    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        anyhow::ensure!(!monitor.is_invalid(), "game monitor is unavailable");

        let mut monitor_info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        anyhow::ensure!(
            GetMonitorInfoW(monitor, &mut monitor_info).as_bool(),
            "GetMonitorInfoW failed"
        );
        let monitor_rect = RegionRect {
            x: monitor_info.rcMonitor.left,
            y: monitor_info.rcMonitor.top,
            width: (monitor_info.rcMonitor.right - monitor_info.rcMonitor.left).max(0) as u32,
            height: (monitor_info.rcMonitor.bottom - monitor_info.rcMonitor.top).max(0) as u32,
        };

        let mut client_rect = RECT::default();
        GetClientRect(hwnd, &mut client_rect).map_err(|e| anyhow::anyhow!("GetClientRect: {e}"))?;
        let width = (client_rect.right - client_rect.left).max(0) as u32;
        let height = (client_rect.bottom - client_rect.top).max(0) as u32;
        anyhow::ensure!(width > 0 && height > 0, "game client area is empty");

        let mut origin = POINT { x: 0, y: 0 };
        let _ = ClientToScreen(hwnd, &mut origin);
        let game_rect = RegionRect {
            x: origin.x,
            y: origin.y,
            width,
            height,
        };

        Ok(CaptureTargetGeometry {
            monitor_rect,
            game_rect,
        })
    }
}

#[cfg(target_os = "windows")]
fn dxgi_source_index_for_monitor(target_monitor_rect: RegionRect) -> anyhow::Result<usize> {
    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.map_err(|e| anyhow::anyhow!("CreateDXGIFactory1: {e}"))?;

    for adapter_index in 0.. {
        let adapter: IDXGIAdapter1 = match unsafe { factory.EnumAdapters1(adapter_index) } {
            Ok(adapter) => adapter,
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => return Err(anyhow::anyhow!("EnumAdapters1({adapter_index}): {error}")),
        };

        let mut output_match_index = 0usize;
        for output_index in 0.. {
            let output = match unsafe { adapter.EnumOutputs(output_index) } {
                Ok(output) => output,
                Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(error) => {
                    return Err(anyhow::anyhow!(
                        "EnumOutputs(adapter={adapter_index}, output={output_index}): {error}"
                    ));
                }
            };

            let desc: DXGI_OUTPUT_DESC = unsafe { output.GetDesc() }
                .map_err(|e| anyhow::anyhow!("IDXGIOutput::GetDesc: {e}"))?;
            if !desc.AttachedToDesktop.as_bool() {
                continue;
            }

            let rect = RegionRect {
                x: desc.DesktopCoordinates.left,
                y: desc.DesktopCoordinates.top,
                width: (desc.DesktopCoordinates.right - desc.DesktopCoordinates.left).max(0) as u32,
                height: (desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top).max(0)
                    as u32,
            };
            if rect == target_monitor_rect {
                return Ok(output_match_index);
            }
            output_match_index += 1;
        }
    }

    Err(anyhow::anyhow!(
        "no DXGI desktop output matched monitor rect ({}, {}) {}x{}",
        target_monitor_rect.x,
        target_monitor_rect.y,
        target_monitor_rect.width,
        target_monitor_rect.height
    ))
}

#[cfg(target_os = "windows")]
fn find_main_window_for_pid(pid: u32) -> Option<HWND> {
    struct EnumCtx {
        pid: u32,
        hwnd: HWND,
    }

    unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = unsafe { &mut *(lparam.0 as *mut EnumCtx) };
        let mut win_pid = 0u32;
        let _ = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut win_pid)) };
        if win_pid != ctx.pid {
            return BOOL(1);
        }
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return BOOL(1);
        }
        let has_owner = match unsafe { GetWindow(hwnd, GW_OWNER) } {
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

fn stop_capture_backend() {
    #[cfg(target_os = "windows")]
    if let Some(handle) = CAPTURE_WORKER.lock().unwrap().take() {
        let _ = handle.join();
    }
    #[cfg(target_os = "windows")]
    {
        *CAPTURE_TARGET_GEOMETRY.lock().unwrap() = None;
    }
}

#[cfg(target_os = "windows")]
fn queue_dxgi_frame(
    pixels: Vec<u8>,
    frame_width: u32,
    frame_height: u32,
    ts_ms: u64,
    geometry: CaptureTargetGeometry,
) -> anyhow::Result<()> {
    let bounds = RegionRect {
        x: 0,
        y: 0,
        width: frame_width,
        height: frame_height,
    };
    let game_bounds = RegionRect {
        x: (geometry.game_rect.x - geometry.monitor_rect.x).max(0),
        y: (geometry.game_rect.y - geometry.monitor_rect.y).max(0),
        width: geometry.game_rect.width.min(bounds.width),
        height: geometry.game_rect.height.min(bounds.height),
    };
    anyhow::ensure!(
        game_bounds.width > 0 && game_bounds.height > 0,
        "game bounds are empty"
    );

    let rect = compute_center_capture_rect(&game_bounds);
    {
        let mut last = LAST_CAPTURE_RECT.lock().unwrap();
        if *last != Some(rect) {
            log::info!(
                "screen_recorder: capture rect ({},{}) {}×{} within game {}×{}",
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                game_bounds.width,
                game_bounds.height,
            );
            *last = Some(rect);
        }
    }

    let start_x = rect.x.max(0) as usize;
    let start_y = rect.y.max(0) as usize;
    let end_x = start_x
        .saturating_add(rect.width as usize)
        .min(frame_width as usize);
    let end_y = start_y
        .saturating_add(rect.height as usize)
        .min(frame_height as usize);
    anyhow::ensure!(
        end_x > start_x && end_y > start_y,
        "capture crop is outside the frame"
    );

    let cropped_width = end_x - start_x;
    let cropped_height = end_y - start_y;
    let mut cropped = Vec::with_capacity(cropped_width * cropped_height * 4);
    let stride = frame_width as usize * 4;
    for y in start_y..end_y {
        let row_start = y * stride + start_x * 4;
        let row_end = row_start + cropped_width * 4;
        cropped.extend_from_slice(&pixels[row_start..row_end]);
    }

    if let Some(tx) = ENCODER_TX.lock().unwrap().as_ref().cloned() {
        let pending = PendingFrame {
            timestamp_ms: ts_ms,
            bgra: cropped,
            width: cropped_width as u32,
            height: cropped_height as u32,
        };
        match tx.try_send(pending) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(_)) => {}
            Err(mpsc::TrySendError::Disconnected(_)) => {}
        }
    }

    Ok(())
}

// ─── Recording pipeline ────────────────────────────────────────────────────────

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn start_encoder_worker(generation: u64) {
    let (tx, rx) = mpsc::sync_channel::<PendingFrame>(MAX_PENDING_ENCODE_FRAMES);
    *ENCODER_TX.lock().unwrap() = Some(tx);
    let handle = std::thread::Builder::new()
        .name(format!("screen-encoder-{generation}"))
        .spawn(move || {
            while let Ok(frame) = rx.recv() {
                if let Some(encoded) = encode_pending_frame(frame) {
                    let mut frames = FRAMES.lock().unwrap();
                    if frames.len() < max_frames() {
                        frames.push(encoded);
                    }
                }
            }
        })
        .expect("failed to spawn screen-encoder thread");
    *ENCODER_WORKER.lock().unwrap() = Some(handle);
}

fn finish_encoder_worker() {
    ENCODER_TX.lock().unwrap().take();
    if let Some(handle) = ENCODER_WORKER.lock().unwrap().take() {
        let _ = handle.join();
    }
}

fn queue_completed_frames(ended_at_unix_ms: u64, reason: &str) -> usize {
    let frames = std::mem::take(&mut *FRAMES.lock().unwrap());
    let frame_count = frames.len();
    let started_at_unix_ms = SESSION_START_UNIX_MS.lock().unwrap().take();
    if frames.is_empty() {
        return 0;
    }

    let capture = CompletedFrameCapture {
        started_at_unix_ms,
        ended_at_unix_ms: Some(ended_at_unix_ms),
        frames,
    };
    let mut completed = COMPLETED_FRAMES.lock().unwrap();
    completed.push_back(capture);
    while completed.len() > MAX_COMPLETED_SESSIONS {
        let _ = completed.pop_front();
    }
    log::info!(
        "screen_recorder: queued replay frames ({reason}) frames={} queued_sessions={}",
        frame_count,
        completed.len()
    );
    frame_count
}

fn max_frames() -> usize {
    (replay_capture_fps() as usize).saturating_mul(MAX_CAPTURE_BUFFER_SECS)
}

// ─── Replay merge helpers ──────────────────────────────────────────────────────

fn partition_matching_frame_captures(
    mut captures: VecDeque<CompletedFrameCapture>,
    snapshot: &crate::bridge::BridgeRunSnapshot,
) -> (Vec<CompletedFrameCapture>, VecDeque<CompletedFrameCapture>) {
    let mut matched = Vec::new();
    let mut remaining = VecDeque::new();
    while let Some(capture) = captures.pop_front() {
        if frame_capture_matches_run(&capture, snapshot) {
            matched.push(capture);
        } else {
            remaining.push_back(capture);
        }
    }
    (matched, remaining)
}

fn frame_capture_matches_run(
    capture: &CompletedFrameCapture,
    snapshot: &crate::bridge::BridgeRunSnapshot,
) -> bool {
    let capture_duration_ms = capture.frames.last().map(|f| f.timestamp_ms).unwrap_or(0);
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
                abs_ms
                    .min(window.ended_at_unix_ms)
                    .saturating_sub(window.started_at_unix_ms)
            }
        })
        .sum()
}

fn merge_frame_captures(
    mut captures: Vec<CompletedFrameCapture>,
    snapshot: &crate::bridge::BridgeRunSnapshot,
) -> Vec<ScreenFrame> {
    captures.sort_by_key(|capture| capture.started_at_unix_ms.unwrap_or(u64::MAX));
    let capture_count = captures.len();
    let base_start_ms = snapshot
        .started_at_unix_ms
        .or_else(|| captures.iter().filter_map(|c| c.started_at_unix_ms).min())
        .unwrap_or(0);
    let run_duration_ms = snapshot
        .duration_secs
        .map(|secs| (secs.max(0.0) * 1000.0).round() as u64);

    let mut frames = Vec::new();
    for capture in captures {
        if let Some(capture_start_ms) = capture.started_at_unix_ms {
            frames.extend(capture.frames.into_iter().filter_map(|mut frame| {
                let abs_ms = capture_start_ms.saturating_add(frame.timestamp_ms);
                if abs_ms < base_start_ms {
                    return None;
                }
                if pause_contains_abs_ms(&snapshot.pause_windows, abs_ms) {
                    return None;
                }
                let paused_before = paused_duration_before_abs_ms(&snapshot.pause_windows, abs_ms);
                frame.timestamp_ms = abs_ms
                    .saturating_sub(base_start_ms)
                    .saturating_sub(paused_before);
                Some(frame)
            }));
        } else {
            frames.extend(capture.frames);
        }
    }

    frames.sort_by_key(|frame| frame.timestamp_ms);
    if let Some(limit_ms) = run_duration_ms.map(|ms| ms.saturating_add(1_500)) {
        frames.retain(|frame| frame.timestamp_ms <= limit_ms);
    }
    log::info!(
        "screen_recorder: merged replay frame segments={} frames={}",
        capture_count,
        frames.len()
    );
    frames
}

// ─── Encoding ──────────────────────────────────────────────────────────────────

fn encode_pending_frame(frame: PendingFrame) -> Option<ScreenFrame> {
    use image::codecs::jpeg::JpegEncoder;

    let mut rgb = Vec::with_capacity((frame.width * frame.height * 3) as usize);
    for px in frame.bgra.chunks_exact(4) {
        rgb.push(px[2]);
        rgb.push(px[1]);
        rgb.push(px[0]);
    }

    let img =
        image::ImageBuffer::<image::Rgb<u8>, Vec<u8>>::from_raw(frame.width, frame.height, rgb)?;

    let out_h = ((frame.height as f32 / frame.width as f32) * OUT_W as f32).round() as u32;
    let resized = image::imageops::resize(
        &img,
        OUT_W,
        out_h.max(1),
        image::imageops::FilterType::Nearest,
    );

    let mut buf = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY)
        .encode_image(&image::DynamicImage::ImageRgb8(resized))
        .ok()?;

    Some(ScreenFrame {
        timestamp_ms: frame.timestamp_ms,
        jpeg_b64: base64_encode(&buf),
    })
}

fn compute_center_capture_rect(bounds: &RegionRect) -> RegionRect {
    let cap_w = (bounds.width / 2).max(320).min(bounds.width);
    let cap_h = (bounds.height / 2).max(180).min(bounds.height);
    let cap_x = bounds.x + (bounds.width as i32 - cap_w as i32) / 2;
    let cap_y = bounds.y + (bounds.height as i32 - cap_h as i32) / 2;
    RegionRect {
        x: cap_x,
        y: cap_y,
        width: cap_w,
        height: cap_h,
    }
}

/// RFC 4648 standard base64 encoder — avoids adding a dependency.
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
