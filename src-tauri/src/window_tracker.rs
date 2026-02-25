/// Window tracker: follows the KovaaK's game window and shows/hides the overlay
/// accordingly.  No DLL injection — uses the same approach as Discord's non-injected
/// overlay mode (polling every 250 ms).
///
/// Detection strategy — applied to the foreground window each tick:
///   1. Fast path: window title contains "FPSAimTrainer"
///   2. Slow path: query the foreground window's process executable name for
///      "FPSAimTrainer" (covers UE4 window recreations where title briefly changes)
///   The found HWND is cached so the rect can be used for overlay positioning even
///   when the title / process check isn't re-run every tick.
///
/// Showing / hiding:
///   `SetWindowPos(HWND_TOPMOST, SWP_SHOWWINDOW)` is used instead of the Tauri
///   `win.show()` helper so the z-order is re-asserted every time and a fullscreen
///   game can never push the overlay out of the TOPMOST layer.
///
/// Rect clamping:
///   UE4 borderless fullscreen uses a window that extends 8 px outside the screen
///   (e.g. -8,-8 → 1936×1096 on a 1080p display).  We clamp to the monitor rect
///   so the WebView content is never positioned off-screen.
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager};

static TRACKING_RUNNING: AtomicBool = AtomicBool::new(false);

/// When true the overlay is kept visible regardless of which window has focus
/// (e.g. settings panel is open, region picker is active).
static FORCE_SHOW: AtomicBool = AtomicBool::new(false);

/// True while KovaaK's is the foreground window.  Read by the OCR thread to skip
/// captures when the user is not in-game (prevents OCR on unrelated windows).
static GAME_FOCUSED: AtomicBool = AtomicBool::new(false);

/// Last known KovaaK's HWND stored as a raw pointer so focus can be restored.
static GAME_HWND_PTR: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Returns true if KovaaK's is currently the foreground window.
pub fn is_game_focused() -> bool {
    GAME_FOCUSED.load(Ordering::Relaxed)
}

/// Return the cached KovaaK's HWND, if we have seen it at least once.
#[cfg(all(target_os = "windows", feature = "ocr"))]
pub fn get_game_hwnd() -> Option<windows::Win32::Foundation::HWND> {
    let ptr = GAME_HWND_PTR.load(Ordering::Relaxed);
    if ptr == 0 {
        None
    } else {
        Some(windows::Win32::Foundation::HWND(ptr as _))
    }
}

pub fn start(app: AppHandle) {
    if TRACKING_RUNNING.swap(true, Ordering::SeqCst) {
        return; // already running
    }
    std::thread::spawn(move || tracker_loop(app));
}

#[allow(dead_code)]
pub fn stop() {
    TRACKING_RUNNING.store(false, Ordering::SeqCst);
}

/// Call this whenever the overlay enters or leaves "settings / region-picker" mode
/// so the tracker keeps it visible even if KovaaK's loses focus.
pub fn set_force_show(val: bool) {
    FORCE_SHOW.store(val, Ordering::Relaxed);
}

// ─── Platform implementation ─────────────────────────────────────────────────

#[cfg(all(target_os = "windows", feature = "ocr"))]
fn tracker_loop(app: AppHandle) {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowRect, SetWindowPos, HWND_TOPMOST,
        SWP_HIDEWINDOW, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    };
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };

    const POLL_MS: u64 = 250;

    let mut overlay_visible = true;
    let mut last_rect: Option<(i32, i32, u32, u32)> = None;
    // Cached game HWND. Cleared when the process is no longer found.
    let mut game_hwnd: Option<HWND> = None;

    log::info!("Window tracker started — polling for FPSAimTrainer");

    while TRACKING_RUNNING.load(Ordering::SeqCst) {
        let fg = unsafe { GetForegroundWindow() };

        // ── 1. Determine if KovaaK's is the active window ──────────────────────
        let is_kovaaks = if fg.0.is_null() {
            false
        } else if game_hwnd.map_or(false, |gh| fg == gh) {
            // Cached match — fast path
            true
        } else {
            // Check title first (fast), fall back to process name (reliable)
            let found = is_kovaaks_window(fg);
            if found {
                game_hwnd = Some(fg);
                GAME_HWND_PTR.store(fg.0 as usize, Ordering::Relaxed);
            } else if game_hwnd.is_none() {
                // Also periodically do a fresh title check to handle late-start
            }
            found
        };

        // Invalidate cache if game window disappeared (different process is fg for
        // several polls in a row — handled simply by re-checking fg each tick above)

        // Update the game-focus flag read by the OCR thread.
        GAME_FOCUSED.store(is_kovaaks, Ordering::Relaxed);

        // ── 2. Overlay HWND for the "settings open" check ─────────────────────
        let overlay_hwnd: Option<HWND> = app
            .get_webview_window("overlay")
            .and_then(|w| w.hwnd().ok())
            .map(|h| HWND(h.0 as _));

        let our_window_active = overlay_hwnd.map_or(false, |oh| fg == oh);
        let should_show = is_kovaaks || our_window_active || FORCE_SHOW.load(Ordering::Relaxed);

        // ── 3. Reposition overlay over game window (clamped to monitor) ────────
        if is_kovaaks {
            let target_hwnd = game_hwnd.unwrap_or(fg);
            let mut raw = RECT::default();
            if unsafe { GetWindowRect(target_hwnd, &mut raw) }.is_ok() {
                // Clamp to the monitor that contains most of the game window
                let monitor = unsafe { MonitorFromWindow(target_hwnd, MONITOR_DEFAULTTONEAREST) };
                let mut mi = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                let clamped = if unsafe { GetMonitorInfoW(monitor, &mut mi) }.as_bool() {
                    let mr = mi.rcMonitor;
                    (
                        mr.left,
                        mr.top,
                        (mr.right - mr.left) as u32,
                        (mr.bottom - mr.top) as u32,
                    )
                } else {
                    // Fallback: use raw rect (may include negative coords)
                    (
                        raw.left.max(0),
                        raw.top.max(0),
                        (raw.right - raw.left) as u32,
                        (raw.bottom - raw.top) as u32,
                    )
                };

                if last_rect != Some(clamped) {
                    let (x, y, w, h) = clamped;
                    if let Some(win) = app.get_webview_window("overlay") {
                        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                        let _ =
                            win.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: w, height: h }));
                    }
                    last_rect = Some(clamped);
                    log::info!("Overlay repositioned: ({x},{y}) {w}×{h}");
                }
            }
        }

        // ── 4. Show / hide via SetWindowPos (re-asserts TOPMOST) ──────────────
        if let Some(oh) = overlay_hwnd {
            if should_show {
                // Always re-assert whether state changed or not — game may have
                // briefly captured the TOPMOST layer during a mode switch.
                unsafe {
                    let _ = SetWindowPos(oh, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                }
                if !overlay_visible {
                    let _ = app.emit("kovaaks-focused", true);
                    log::info!("Overlay shown (KovaaK's active)");
                    overlay_visible = true;
                }
            } else if overlay_visible {
                unsafe {
                    let _ = SetWindowPos(oh, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_HIDEWINDOW);
                }
                GAME_FOCUSED.store(false, Ordering::Relaxed);
                let _ = app.emit("kovaaks-focused", false);
                log::info!("Overlay hidden (alt-tabbed)");
                overlay_visible = false;
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
    }

    log::info!("Window tracker stopped");
}

/// Returns true if `hwnd` belongs to the KovaaK's game process.
/// Checks window title first (fast), then process exe name (reliable after mode switch).
#[cfg(all(target_os = "windows", feature = "ocr"))]
fn is_kovaaks_window(hwnd: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextW, GetWindowThreadProcessId};

    // Fast path: window title
    let mut title_buf = [0u16; 512];
    let title_len = unsafe { GetWindowTextW(hwnd, &mut title_buf) };
    if title_len > 0 {
        let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);
        if title.contains("FPSAimTrainer") || title.contains("FPS Aim Trainer") {
            return true;
        }
    }

    // Slow path: process executable name
    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return false;
    }

    let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return false;
    };

    let mut exe_buf = [0u16; 1024];
    let mut exe_len = exe_buf.len() as u32;
    if unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(exe_buf.as_mut_ptr()),
            &mut exe_len,
        )
    }
    .is_ok()
    {
        let path = String::from_utf16_lossy(&exe_buf[..exe_len as usize]);
        if path.contains("FPSAimTrainer") {
            return true;
        }
    }

    false
}

#[cfg(not(all(target_os = "windows", feature = "ocr")))]
fn tracker_loop(_app: AppHandle) {
    // No-op stub for non-Windows / dev builds.
    // The overlay remains always visible on those platforms.
}
