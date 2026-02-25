/// OCR module: captures a screen region and reads the SPM (Score Per Minute) number.
///
/// Uses a background thread polling every `poll_ms` milliseconds.
/// On Windows with the `ocr` feature, uses DXGI screen capture + ocrs ML OCR.
/// Falls back to a stub that emits mock data for development on other platforms.
///
/// Emits `session-start` the first time a valid number is read after a reset,
/// which gates smoothness tracking to actual KovaaK's sessions.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};

use crate::settings::RegionRect;

// ─── State ─────────────────────────────────────────────────────────────────────

static OCR_RUNNING: AtomicBool = AtomicBool::new(false);
/// Becomes true when we first get a valid reading; reset by reset_session().
static SESSION_STARTED: AtomicBool = AtomicBool::new(false);
static CURRENT_REGION: Lazy<Mutex<Option<RegionRect>>> = Lazy::new(|| Mutex::new(None));
static POLL_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(100);
/// Save one debug BMP on first capture so the user can verify the region is correct.
static DEBUG_SAVED: AtomicBool = AtomicBool::new(false);
/// Last emitted SPM value — used to detect mid-session restarts (SPM crashes to ~0).
/// Stored as fixed-point ×100 so we can use an atomic (e.g. 3000 SPM → 300000).
static LAST_SPM_X100: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
/// Optional region for one-shot scenario-name OCR at session start.
static SCENARIO_REGION: Lazy<Mutex<Option<RegionRect>>> = Lazy::new(|| Mutex::new(None));
/// Last scenario name emitted, used to suppress duplicate events.
static LAST_SCENARIO_NAME: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));
/// Time of the most recent reset_session() call (None = no reset yet this run).
/// The OCR loop will not emit a new session-start for at least RESET_QUIET_MS
/// after this instant, preventing the results screen's lingering SPM from
/// triggering a false start immediately after a session ends.
static RESET_AT: Lazy<Mutex<Option<Instant>>> = Lazy::new(|| Mutex::new(None));
const RESET_QUIET_MS: u128 = 3_000;

pub const EVENT_LIVE_SCORE: &str = "live-score";
pub const EVENT_SESSION_START: &str = "session-start";
pub const EVENT_SCENARIO_DETECTED: &str = "scenario-detected";

/// Most-recently captured BGRA frame + dimensions, for the preview command.
static LAST_CAPTURE: Lazy<Mutex<Option<(Vec<u8>, u32, u32)>>> = Lazy::new(|| Mutex::new(None));

#[derive(serde::Serialize, Clone)]
pub struct LiveScorePayload {
    /// The SPM (Score Per Minute) read from the screen, or final score post-session.
    pub score: u64,
    pub raw_text: String,
}

/// A single word returned by Windows.Media.Ocr with its bounding box.
/// Coordinates are in pixels relative to the captured region (0,0 = top-left of capture).
#[derive(Debug, Clone, serde::Serialize)]
pub struct OcrWordResult {
    pub text: String,
    /// Left edge of the word bounding box.
    pub x: i32,
    /// Top edge of the word bounding box.
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

// ─── Public API ────────────────────────────────────────────────────────────────

/// Update the region used by the running OCR thread.
pub fn update_region(app: &AppHandle, region: Option<RegionRect>) {
    if let Ok(mut r) = CURRENT_REGION.lock() {
        *r = region;
    }
    // Reset debug flag so the next capture saves a fresh BMP at the new region.
    DEBUG_SAVED.store(false, Ordering::SeqCst);
    match region {
        Some(r) => log::info!("OCR region updated: ({},{}) {}x{}", r.x, r.y, r.width, r.height),
        None    => log::info!("OCR region cleared — no scores will be read"),
    }
    let _ = app;
}

/// Update the optional scenario-name OCR region.
pub fn update_scenario_region(region: Option<RegionRect>) {
    if let Ok(mut r) = SCENARIO_REGION.lock() {
        *r = region;
    }
    match region {
        Some(r) => log::info!("Scenario OCR region updated: ({},{}) {}x{}", r.x, r.y, r.width, r.height),
        None    => log::info!("Scenario OCR region cleared"),
    }
}

/// Update the OCR poll rate (milliseconds between captures).
pub fn update_poll_ms(ms: u64) {
    POLL_MS.store(ms.max(16), Ordering::Relaxed);
}

/// Start the OCR background thread.
pub fn start(app: AppHandle, region: Option<RegionRect>, poll_ms: u64) {
    if OCR_RUNNING.swap(true, Ordering::SeqCst) {
        return; // Already running
    }

    POLL_MS.store(poll_ms.max(16), Ordering::Relaxed);

    {
        let mut r = CURRENT_REGION.lock().unwrap();
        *r = region;
    }

    match region {
        Some(r) => log::info!("OCR starting — region ({},{}) {}x{}, poll {}ms", r.x, r.y, r.width, r.height, poll_ms),
        None    => log::info!("OCR starting — no region configured yet; go to Settings → General → Pick Region"),
    }

    std::thread::Builder::new()
        .name("ocr-loop".into())
        .spawn(move || {
            log::info!("OCR thread started");
            ocr_loop(app);
        })
        .expect("failed to spawn OCR thread");
}

/// Signal the OCR thread to stop.
pub fn stop() {
    OCR_RUNNING.store(false, Ordering::SeqCst);
    log::info!("OCR thread stop requested");
}

/// Returns the most recent screen capture as a PNG byte buffer.
/// Returns `None` if no capture has been taken yet (region not configured).
pub fn get_capture_png() -> Option<Vec<u8>> {
    #[cfg(all(target_os = "windows", feature = "ocr"))]
    {
        let guard = LAST_CAPTURE.lock().ok()?;
        let (bgra, w, h) = guard.as_ref()?;
        // GDI gives us BGRA; the `image` crate wants RGBA.
        let mut rgba = Vec::with_capacity(bgra.len());
        for chunk in bgra.chunks_exact(4) {
            rgba.push(chunk[2]); // R  (was B)
            rgba.push(chunk[1]); // G
            rgba.push(chunk[0]); // B  (was R)
            rgba.push(chunk[3]); // A
        }
        let img = image::ImageBuffer::<image::Rgba<u8>, Vec<u8>>::from_raw(*w, *h, rgba)?;
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .ok()?;
        return Some(cursor.into_inner());
    }
    #[allow(unreachable_code)]
    None
}

/// Reset session state so the next valid reading triggers a new session-start.
/// Called by file_watcher when a session completes.
pub fn reset_session() {
    SESSION_STARTED.store(false, Ordering::SeqCst);
    LAST_SPM_X100.store(0, Ordering::SeqCst);
    // Record the reset time so the loop ignores residual results-screen OCR.
    if let Ok(mut t) = RESET_AT.lock() {
        *t = Some(Instant::now());
    }
    // Clear cached scenario name so the next session always re-emits scenario-detected
    if let Ok(mut name) = LAST_SCENARIO_NAME.lock() {
        name.clear();
    }
}

/// Returns the most recent SPM reading from the live score OCR, or `None` if
/// no session is active / no value has been captured yet.
pub fn get_current_spm() -> Option<u32> {
    let v = LAST_SPM_X100.load(std::sync::atomic::Ordering::Relaxed);
    if v == 0 { None } else { Some((v / 100) as u32) }
}

/// Capture a screen region and return the raw OCR text.
/// Used by `stats_ocr` module to read the stats panel.
/// Returns empty string when OCR is not available (non-Windows / no feature flag).
pub(crate) fn capture_text(rect: crate::settings::RegionRect) -> anyhow::Result<String> {
    #[cfg(all(target_os = "windows", feature = "ocr"))]
    {
        let (pixels, w, h) = capture_region_gdi(&rect)?;
        // Per-field regions are small (the user draws a tight box around one value).
        // Windows.Media.Ocr needs ~20+ px font height; upscale so the region is
        // at least 64 px tall — same logic as capture_and_ocr for the SPM counter.
        let scale = {
            let target_h: u32 = 64;
            (target_h / h.max(1)).clamp(2, 6)
        };
        let (ocr_pixels, ocr_w, ocr_h) = upscale_nearest(&pixels, w, h, scale);
        return run_windows_ocr(ocr_pixels, ocr_w, ocr_h);
    }
    #[allow(unreachable_code)]
    { let _ = rect; Ok(String::new()) }
}

/// Capture a screen region and return every recognised word with its bounding box.
///
/// This is used by `auto_detect_stats_regions` to locate the KovaaK's stats panel
/// labels without any upscaling — the stats panel text is typically large enough
/// (≥ 20 px) for Windows.Media.Ocr at native resolution.
///
/// Returned coordinates are relative to the captured region (0,0 = top-left of `rect`).
/// On non-Windows / without the `ocr` feature this always returns an empty Vec.
#[cfg(all(target_os = "windows", feature = "ocr"))]
pub fn capture_screen_words(rect: &RegionRect) -> anyhow::Result<Vec<OcrWordResult>> {
    let (pixels, w, h) = capture_region_gdi(rect)?;
    run_windows_ocr_words(pixels, w, h)
}

#[cfg(not(all(target_os = "windows", feature = "ocr")))]
pub fn capture_screen_words(_rect: &RegionRect) -> anyhow::Result<Vec<OcrWordResult>> {
    Ok(Vec::new())
}

// ─── OCR Loop ─────────────────────────────────────────────────────────────────

fn ocr_loop(app: AppHandle) {
    // Scenario re-check: time-based so it's independent of POLL_MS.
    // Subtract more than the interval so first check fires on the first loop iteration.
    let mut last_scenario_check = std::time::Instant::now()
        .checked_sub(Duration::from_secs(60))
        .unwrap_or_else(std::time::Instant::now);
    const SCENARIO_CHECK_INTERVAL: Duration = Duration::from_secs(5);
    // Candidate for next scenario name — must be seen on 2 consecutive checks to emit.
    let mut pending_scenario: Option<String> = None;
    // Only emit live-score (and log) when the value actually changes AND the
    // player is not in a confirmed rolling-window decay state.
    //
    // Mathematical basis: KovaaK's SPM is a rolling average over window W.
    // While the player is actively scoring, hits arrive stochastically so SPM
    // fluctuates both up and down.  Once the player stops completely, SPM decays
    // as old hits leave the window: SPM(t+k) = SPM₀ · (W−k)/W — strictly
    // monotonic.  Therefore, N consecutive strictly-decreasing readings prove
    // (with probability 1 − 0.4^N of being correct) that the rolling window is
    // shedding old hits with no new ones.
    //
    // At POLL_MS ≈ 100 ms and N = 4 this gives:
    //   • Detection latency ≤ 400 ms after the player stops.
    //   • False-positive rate ≈ 0.4^4 ≈ 2.6 % (brief active dip suppressed).
    //
    // When suppressed the frontend's 1.2 s SPM-stale guard takes over and
    // stops score accumulation, which is exactly the desired behaviour.
    let mut last_emitted_spm: u64 = u64::MAX;
    let mut consecutive_decreases: u32 = 0;
    const DECAY_THRESHOLD: u32 = 4;

    while OCR_RUNNING.load(Ordering::SeqCst) {
        // Only capture when KovaaK's is the foreground window.
        // Skipping here prevents OCR from reading unrelated windows (terminals,
        // browsers, etc.) when the user has alt-tabbed out of the game.
        if !crate::window_tracker::is_game_focused() {
            std::thread::sleep(Duration::from_millis(POLL_MS.load(Ordering::Relaxed)));
            continue;
        }

        let region = CURRENT_REGION.lock().unwrap().clone();

        if let Some(rect) = region {
            match capture_and_ocr(rect) {
                // Discard readings whose SPM exceeds any plausible KovaaK's value.
                // World-record tracking SPM is ~12 000–15 000; 30 000 gives ample
                // headroom while filtering noise like "113,204" or "32,170" that
                // arise when the score region is captured mid-transition and the
                // digit separator is mis-read as part of the integer.
                Ok(Some(ref payload)) if payload.score > 30_000 => {
                    log::debug!("SPM {} implausible (>30 000), discarding OCR reading", payload.score);
                }
                Ok(Some(payload)) => {
                    let spm = payload.score;
                    let prev_spm_x100 = LAST_SPM_X100.load(Ordering::Relaxed);
                    let prev_spm = prev_spm_x100 / 100;

                    // Restart detection: if SPM was high (>500) and has now crashed
                    // to less than 10% of that value, the user restarted the scenario.
                    // Re-emit session-start so the frontend resets its clock.
                    let is_restart = prev_spm > 500 && spm < prev_spm / 10;

                    if is_restart {
                        log::info!("Restart detected: SPM dropped from {} → {}; re-starting session", prev_spm, spm);
                        SESSION_STARTED.store(false, Ordering::SeqCst);
                        let ss = crate::mouse_hook::start_session_tracking();
                        crate::screen_recorder::start(ss);
                        crate::stats_ocr::set_active(true);
                        // Reset decay counter — a restart is a legitimate SPM drop,
                        // not a rolling-window decay, so we must not suppress events.
                        consecutive_decreases = 0;
                        // Force immediate scenario re-check on restart
                        last_scenario_check = last_scenario_check
                            .checked_sub(SCENARIO_CHECK_INTERVAL)
                            .unwrap_or(last_scenario_check);
                    }

                    LAST_SPM_X100.store(spm * 100, Ordering::Relaxed);

                    // Track consecutive strictly-decreasing readings to identify
                    // rolling-window decay (player has stopped scoring).
                    // Any non-decrease (new hit landed) resets the counter.
                    if !is_restart {
                        if spm < prev_spm {
                            consecutive_decreases += 1;
                        } else {
                            consecutive_decreases = 0;
                        }
                    }
                    let is_decaying = consecutive_decreases >= DECAY_THRESHOLD;

                    // First valid reading since last reset → new session starting.
                    // Guard with a quiet period so the results-screen residue
                    // (high SPM still visible for ~1 s after round ends) cannot
                    // trigger a false start before the dedup window in
                    // file_watcher has had time to mark the session as complete.
                    // Instant is Copy so we can move the Option<Instant> out of the guard.
                    let in_quiet = RESET_AT.lock().ok()
                        .and_then(|g| *g)
                        .map_or(false, |t| t.elapsed().as_millis() < RESET_QUIET_MS);
                    if !SESSION_STARTED.swap(true, Ordering::SeqCst) {
                        if in_quiet {
                            // Reschedule: undo the swap so the check fires again
                            // once we are outside the quiet window.
                            SESSION_STARTED.store(false, Ordering::SeqCst);
                            log::debug!("[ocr] suppressing session-start during post-reset quiet window");
                        } else {
                            log::info!("Session start detected via OCR");
                            let _ = app.emit(EVENT_SESSION_START, ());
                            let ss = crate::mouse_hook::start_session_tracking();
                            crate::screen_recorder::start(ss);
                            crate::stats_ocr::set_active(true);
                        }
                    }

                    // Only emit when value changed AND not in confirmed decay state.
                    // Suppressing during decay means the TS 1.2 s SPM-stale guard
                    // fires and stops score accumulation — exactly the right outcome
                    // since no new hits are being registered in-game either.
                    if spm != last_emitted_spm && !is_decaying {
                        log::info!("SPM: {} (raw: {:?})", spm, payload.raw_text);
                        last_emitted_spm = spm;
                        let _ = app.emit(EVENT_LIVE_SCORE, &payload);
                    } else if is_decaying && spm != last_emitted_spm {
                        log::debug!("SPM decay suppressed ({} consecutive decreases): {} → {}", consecutive_decreases, prev_spm, spm);
                    }
                }
                Ok(None) => {} // No number in region — between rounds / paused
                Err(e) => {
                    log::debug!("OCR error: {e}");
                }
            }
        }

        std::thread::sleep(Duration::from_millis(POLL_MS.load(Ordering::Relaxed)));

        // Periodic scenario name check (every 5s, time-based).
        // Fires immediately on first loop iteration (pre-subtracted above).
        // Also fires immediately on restart (last_scenario_check shifted above).
        if last_scenario_check.elapsed() >= SCENARIO_CHECK_INTERVAL {
            last_scenario_check = std::time::Instant::now();
            let srect = SCENARIO_REGION.lock().ok().and_then(|g| *g);
            if let Some(r) = srect {
                match capture_scenario_name(r) {
                    Ok(name) if !name.is_empty() => {
                        let mut last = LAST_SCENARIO_NAME.lock().unwrap();
                        if *last != name {
                            // Require the new name to appear on 2 consecutive checks
                            // before emitting — filters out single-tick OCR noise
                            // (e.g. a UI label bleeding into the scenario region).
                            if pending_scenario.as_deref() == Some(&name) {
                                log::info!("Scenario name changed: {:?} → {:?}", *last, name);
                                *last = name.clone();
                                drop(last);
                                pending_scenario = None;
                                let _ = app.emit(EVENT_SCENARIO_DETECTED, &name);
                            } else {
                                log::debug!("Scenario name candidate (1/2): {:?}", name);
                                pending_scenario = Some(name);
                            }
                        } else {
                            // Reverted to last known good name — discard any pending candidate.
                            pending_scenario = None;
                        }
                    }
                    Ok(_) => {}
                    Err(e) => log::debug!("Periodic scenario OCR failed: {e}"),
                }
            }
        }
    }

    log::info!("OCR thread stopped");
}

// ─── Platform implementations ─────────────────────────────────────────────────

/// Windows path: GDI BitBlt screen capture + Windows.Media.Ocr (built-in Win10+ engine).
/// No model files, no ML dependencies, ~5 ms per recognition.
#[cfg(all(target_os = "windows", feature = "ocr"))]
fn capture_and_ocr(rect: RegionRect) -> anyhow::Result<Option<LiveScorePayload>> {
    let (pixels, w, h) = capture_region_gdi(&rect)?;

    // Store original (un-scaled) pixels for the live preview so the user sees
    // the exact region they selected, not the inflated OCR input.
    if let Ok(mut c) = LAST_CAPTURE.lock() {
        *c = Some((pixels.clone(), w, h));
    }

    // Upscale before OCR — Windows.Media.Ocr needs ~20+ px font height to be
    // reliable.  Small KovaaK's SPM digits (often 12–18 px) fail without this.
    // 4× nearest-neighbour keeps digits sharp; no blurry interpolation artefacts.
    let scale = {
        // Choose scale so the region is at least 64 px tall after scaling.
        // Minimum 2×, maximum 6× to avoid burning unnecessary CPU.
        let target_h: u32 = 64;
        (target_h / h.max(1)).clamp(2, 6)
    };
    let (ocr_pixels, ocr_w, ocr_h) = upscale_nearest(&pixels, w, h, scale);

    // Save one debug BMP of the UPSCALED image so the user can verify OCR input
    if !DEBUG_SAVED.swap(true, Ordering::SeqCst) {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let path = dir.join("ocr_debug.bmp");
                match save_debug_bmp(&ocr_pixels, ocr_w, ocr_h, &path) {
                    Ok(_)  => log::info!("OCR debug image saved ({}×): {}", scale, path.display()),
                    Err(e) => log::warn!("Could not save OCR debug image: {e}"),
                }
            }
        }
    }

    let text = run_windows_ocr(ocr_pixels, ocr_w, ocr_h)?;
    let score = parse_score(&text);
    Ok(score.map(|s| LiveScorePayload { score: s, raw_text: text }))
}

/// Nearest-neighbour upscale of a BGRA pixel buffer.
/// Keeps digit edges sharp — no blur artefacts that would confuse the OCR engine.
#[cfg(all(target_os = "windows", feature = "ocr"))]
fn upscale_nearest(bgra: &[u8], w: u32, h: u32, scale: u32) -> (Vec<u8>, u32, u32) {
    let nw = w * scale;
    let nh = h * scale;
    let mut out = vec![0u8; (nw * nh * 4) as usize];
    for sy in 0..h {
        for sx in 0..w {
            let src_i = ((sy * w + sx) * 4) as usize;
            let pixel = &bgra[src_i..src_i + 4];
            for dy in 0..scale {
                for dx in 0..scale {
                    let dst_i = (((sy * scale + dy) * nw + (sx * scale + dx)) * 4) as usize;
                    out[dst_i..dst_i + 4].copy_from_slice(pixel);
                }
            }
        }
    }
    (out, nw, nh)
}

/// Write a 32-bpp BMP file from a BGRA pixel buffer (no extra dependencies).
#[cfg(all(target_os = "windows", feature = "ocr"))]
fn save_debug_bmp(bgra: &[u8], width: u32, height: u32, path: &std::path::Path) -> anyhow::Result<()> {
    use std::io::Write;
    let pixel_data_offset: u32 = 14 + 40; // file header + DIB header
    let file_size: u32 = pixel_data_offset + bgra.len() as u32;
    let w = width as i32;
    let h = -(height as i32); // negative = top-down
    let mut f = std::fs::File::create(path)?;
    // File header (14 bytes)
    f.write_all(b"BM")?;
    f.write_all(&file_size.to_le_bytes())?;
    f.write_all(&0u32.to_le_bytes())?;           // reserved
    f.write_all(&pixel_data_offset.to_le_bytes())?;
    // DIB header BITMAPINFOHEADER (40 bytes)
    f.write_all(&40u32.to_le_bytes())?;          // header size
    f.write_all(&w.to_le_bytes())?;              // width
    f.write_all(&h.to_le_bytes())?;              // height (negative = top-down)
    f.write_all(&1u16.to_le_bytes())?;           // planes
    f.write_all(&32u16.to_le_bytes())?;          // bits per pixel
    f.write_all(&0u32.to_le_bytes())?;           // compression (BI_RGB)
    f.write_all(&(bgra.len() as u32).to_le_bytes())?; // image size
    f.write_all(&0i32.to_le_bytes())?;           // x pixels per metre
    f.write_all(&0i32.to_le_bytes())?;           // y pixels per metre
    f.write_all(&0u32.to_le_bytes())?;           // colours in table
    f.write_all(&0u32.to_le_bytes())?;           // important colours
    f.write_all(bgra)?;
    Ok(())
}

/// Capture a screen region into a BGRA byte buffer using GDI BitBlt.
/// Works for any window type including borderless/windowed games.
#[cfg(all(target_os = "windows", feature = "ocr"))]
pub(crate) fn capture_region_gdi(rect: &RegionRect) -> anyhow::Result<(Vec<u8>, u32, u32)> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
        GetDC, GetDIBits, ReleaseDC, SelectObject,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ, SRCCOPY,
    };

    let w = rect.width as i32;
    let h = rect.height as i32;

    unsafe {
        let screen_dc = GetDC(None);
        anyhow::ensure!(!screen_dc.is_invalid(), "GetDC(NULL) failed");

        // Some(hdc) = duplicate existing DC; None = create a compatible screen DC
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        anyhow::ensure!(!mem_dc.is_invalid(), "CreateCompatibleDC failed");

        let bmp = CreateCompatibleBitmap(screen_dc, w, h);
        anyhow::ensure!(!bmp.is_invalid(), "CreateCompatibleBitmap failed");

        // SelectObject/DeleteObject require HGDIOBJ; cast from HBITMAP via the
        // underlying pointer (both types are newtype wrappers over *mut c_void).
        let old = SelectObject(mem_dc, HGDIOBJ(bmp.0));

        let blit_ok = BitBlt(mem_dc, 0, 0, w, h, Some(screen_dc), rect.x, rect.y, SRCCOPY);

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // negative = top-down; positive would flip vertically
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: (w * h * 4) as u32,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut pixels = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(
            mem_dc,
            bmp,
            0,
            h as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // Cleanup before returning errors
        let _ = SelectObject(mem_dc, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);

        blit_ok.map_err(|e| anyhow::anyhow!("BitBlt failed: {e}"))?;
        anyhow::ensure!(lines != 0, "GetDIBits returned 0 scan lines");

        Ok((pixels, rect.width, rect.height)) // BGRA pixel order
    }
}

/// Run Windows.Media.Ocr on a BGRA pixel buffer and return every recognised word
/// together with its bounding box (in pixels, relative to the image top-left).
#[cfg(all(target_os = "windows", feature = "ocr"))]
fn run_windows_ocr_words(bgra_pixels: Vec<u8>, width: u32, height: u32) -> anyhow::Result<Vec<OcrWordResult>> {
    use windows::Graphics::Imaging::{BitmapBufferAccessMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Win32::System::WinRT::IMemoryBufferByteAccess;
    use windows::core::Interface;

    let bitmap = SoftwareBitmap::Create(BitmapPixelFormat::Bgra8, width as i32, height as i32)
        .map_err(|e| anyhow::anyhow!("SoftwareBitmap::Create failed: {e}"))?;
    {
        let locked = bitmap
            .LockBuffer(BitmapBufferAccessMode::Write)
            .map_err(|e| anyhow::anyhow!("LockBuffer failed: {e}"))?;
        let reference = locked
            .CreateReference()
            .map_err(|e| anyhow::anyhow!("CreateReference failed: {e}"))?;
        let byte_access: IMemoryBufferByteAccess = reference
            .cast()
            .map_err(|e| anyhow::anyhow!("cast to IMemoryBufferByteAccess failed: {e}"))?;
        unsafe {
            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut capacity: u32 = 0;
            byte_access.GetBuffer(&mut data_ptr, &mut capacity)
                .map_err(|e| anyhow::anyhow!("GetBuffer failed: {e}"))?;
            let len = bgra_pixels.len().min(capacity as usize);
            std::ptr::copy_nonoverlapping(bgra_pixels.as_ptr(), data_ptr, len);
        }
    }

    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|e| anyhow::anyhow!("OcrEngine init failed: {e}"))?;
    let operation = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| anyhow::anyhow!("RecognizeAsync call failed: {e}"))?;

    loop {
        let status = operation.Status()
            .map_err(|e| anyhow::anyhow!("OCR Status() failed: {e}"))?;
        let val = status.0;
        if val == 1 { break; }
        if val >= 2 { anyhow::bail!("OCR async operation failed (status={})", val); }
        std::thread::sleep(Duration::from_millis(1));
    }
    let ocr_result = operation
        .GetResults()
        .map_err(|e| anyhow::anyhow!("OCR GetResults failed: {e}"))?;

    let lines = ocr_result.Lines()
        .map_err(|e| anyhow::anyhow!("OcrResult.Lines() failed: {e}"))?;
    let line_count = lines.Size().unwrap_or(0);
    let mut words: Vec<OcrWordResult> = Vec::new();

    for i in 0..line_count {
        let line = match lines.GetAt(i) {
            Ok(l) => l,
            Err(_) => continue,
        };
        let wds = match line.Words() {
            Ok(w) => w,
            Err(_) => continue,
        };
        let word_count = wds.Size().unwrap_or(0);
        for j in 0..word_count {
            let wd = match wds.GetAt(j) {
                Ok(w) => w,
                Err(_) => continue,
            };
            let text = match wd.Text() {
                Ok(t) => t.to_string(),
                Err(_) => continue,
            };
            let bbox = match wd.BoundingRect() {
                Ok(r) => r,
                Err(_) => continue,
            };
            words.push(OcrWordResult {
                text,
                x: bbox.X as i32,
                y: bbox.Y as i32,
                width: bbox.Width as u32,
                height: bbox.Height as u32,
            });
        }
    }

    Ok(words)
}

/// Run Windows.Media.Ocr on a BGRA pixel buffer and return the recognised text.
#[cfg(all(target_os = "windows", feature = "ocr"))]
fn run_windows_ocr(bgra_pixels: Vec<u8>, width: u32, height: u32) -> anyhow::Result<String> {
    use windows::Graphics::Imaging::{BitmapBufferAccessMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Win32::System::WinRT::IMemoryBufferByteAccess;
    use windows::core::Interface;

    // Create an empty SoftwareBitmap and write our BGRA pixels directly into
    // its locked buffer — avoids the removed CreateCopyFromBuffer API.
    let bitmap = SoftwareBitmap::Create(BitmapPixelFormat::Bgra8, width as i32, height as i32)
        .map_err(|e| anyhow::anyhow!("SoftwareBitmap::Create failed: {e}"))?;
    {
        let locked = bitmap
            .LockBuffer(BitmapBufferAccessMode::Write)
            .map_err(|e| anyhow::anyhow!("LockBuffer failed: {e}"))?;
        let reference = locked
            .CreateReference()
            .map_err(|e| anyhow::anyhow!("CreateReference failed: {e}"))?;
        let byte_access: IMemoryBufferByteAccess = reference
            .cast()
            .map_err(|e| anyhow::anyhow!("cast to IMemoryBufferByteAccess failed: {e}"))?;
        unsafe {
            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut capacity: u32 = 0;
            byte_access
                .GetBuffer(&mut data_ptr, &mut capacity)
                .map_err(|e| anyhow::anyhow!("GetBuffer failed: {e}"))?;
            let len = bgra_pixels.len().min(capacity as usize);
            std::ptr::copy_nonoverlapping(bgra_pixels.as_ptr(), data_ptr, len);
        }
    }

    // TryCreateFromUserProfileLanguages picks the system language (English on most setups).
    // In windows-rs 0.61+ this returns Result<OcrEngine> directly with no Option wrapper.
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|e| anyhow::anyhow!("OcrEngine init failed: {e}"))?;

    let operation = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| anyhow::anyhow!("RecognizeAsync call failed: {e}"))?;

    // Spin until the WinRT async operation completes (typically < 10 ms for small regions).
    // Use u8 comparison to avoid needing the Foundation_AsyncStatus feature.
    loop {
        let status = operation.Status()
            .map_err(|e| anyhow::anyhow!("OCR Status() failed: {e}"))?;
        let val = status.0;
        // 0 = Started, 1 = Completed, 2 = Canceled, 3 = Error
        if val == 1 { break; }
        if val >= 2 { anyhow::bail!("OCR async operation failed (status={})", val); }
        std::thread::sleep(Duration::from_millis(1));
    }
    let ocr_result = operation
        .GetResults()
        .map_err(|e| anyhow::anyhow!("OCR GetResults failed: {e}"))?;

    Ok(ocr_result
        .Text()
        .map_err(|e| anyhow::anyhow!("OcrResult.Text() failed: {e}"))?
        .to_string())
}

/// Capture a region and return OCR text (used for scenario name detection).
/// No upscaling — scenario title text is already large enough for Windows.Media.Ocr.
#[cfg(all(target_os = "windows", feature = "ocr"))]
fn capture_scenario_name(rect: RegionRect) -> anyhow::Result<String> {
    let (pixels, w, h) = capture_region_gdi(&rect)?;
    let text = run_windows_ocr(pixels, w, h)?;
    // Collapse whitespace so multi-line OCR output becomes a single name string
    let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
    Ok(normalise_scenario_name(&cleaned))
}

#[cfg(not(all(target_os = "windows", feature = "ocr")))]
fn capture_scenario_name(_rect: RegionRect) -> anyhow::Result<String> {
    Ok(String::new())
}

/// Normalise a raw OCR scenario name string:
///
/// 1. In every whitespace-delimited token that contains at least one ASCII digit,
///    replace digit-confusable letters (`l`, `I` → `1`, `O` → `0`).  This fixes
///    intermittent misreads like "lw4ts" ↔ "1w4ts".
///
/// 2. Strip leading/trailing KovaaK's UI noise tokens that leak into the scenario
///    name region depending on the visibility badge state:
///    "Friends Only", "Public", "Private", "Friends", "Only"
///    Also strips trailing season/badge suffixes like "S1"–"S9".
fn normalise_scenario_name(raw: &str) -> String {
    // Step 1 — per-token digit-confusable fix.
    let normalised: Vec<&str> = raw.split_whitespace().collect();
    let fixed: Vec<String> = normalised.iter().map(|tok| {
        if tok.chars().any(|c| c.is_ascii_digit()) {
            tok.chars().map(|c| match c {
                'l' | 'I' => '1',
                'O' => '0',
                _ => c,
            }).collect()
        } else {
            tok.to_string()
        }
    }).collect();

    // Step 2 — strip known UI-badge noise tokens from front and back.
    const NOISE_FRONT: &[&str] = &["Friends Only", "Public", "Private", "Friends", "Only"];
    const NOISE_BACK_PAT: fn(&str) -> bool = |tok: &str| {
        // Strip trailing tokens that look like a season badge: "S" followed by 1–2 digits.
        tok.starts_with('S') && tok.len() <= 3 && tok[1..].chars().all(|c| c.is_ascii_digit())
    };

    let mut joined = fixed.join(" ");

    // Remove noise prefixes (longest first so "Friends Only" beats "Friends")
    let best_noise_front = NOISE_FRONT
        .iter()
        .filter(|&&n| joined.starts_with(n))
        .max_by_key(|n| n.len());
    if let Some(prefix) = best_noise_front {
        joined = joined[prefix.len()..].trim_start().to_string();
    }
    // Remove trailing season badge token if present
    let mut words: Vec<&str> = joined.split_whitespace().collect();
    if words.last().map_or(false, |w| NOISE_BACK_PAT(w)) {
        words.pop();
    }

    words.join(" ")
}

/// Fallback for non-Windows / non-ocr builds: emits a mock rising SPM for UI development.
/// Simulates 2-minute active scenarios with 30-second breaks between them so the
/// session-active / session-idle states behave realistically in the overlay.
#[cfg(not(target_os = "windows"))]
fn capture_and_ocr(_rect: RegionRect) -> anyhow::Result<Option<LiveScorePayload>> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // 150-second cycle: 120 s active, 30 s gap (simulates between-scenario lobby)
    let cycle = secs % 150;
    if cycle >= 120 {
        return Ok(None); // No score visible → inactivity timer fires → HUD hides
    }
    let spm = (cycle * 25).min(3000);
    Ok(Some(LiveScorePayload {
        score: spm,
        raw_text: spm.to_string(),
    }))
}

/// On Windows without the ocr feature, do nothing — no fake data should appear.
#[cfg(all(target_os = "windows", not(feature = "ocr")))]
fn capture_and_ocr(_rect: RegionRect) -> anyhow::Result<Option<LiveScorePayload>> {
    Ok(None)
}

// ─── Score parsing ─────────────────────────────────────────────────────────────

/// Extract the largest integer from OCR text, handling common OCR noise (commas, etc.).
#[cfg(all(target_os = "windows", feature = "ocr"))]
fn parse_score(text: &str) -> Option<u64> {
    let mut best: Option<u64> = None;
    let mut current = String::new();

    for c in text.chars() {
        if c.is_ascii_digit() {
            current.push(c);
        } else if c == ',' {
            // skip comma separators
        } else {
            if let Ok(n) = current.parse::<u64>() {
                if best.map_or(true, |b: u64| n > b) {
                    best = Some(n);
                }
            }
            current.clear();
        }
    }
    if let Ok(n) = current.parse::<u64>() {
        if best.map_or(true, |b: u64| n > b) {
            best = Some(n);
        }
    }

    best
}

#[cfg(test)]
mod tests {
    #[cfg(all(target_os = "windows", feature = "ocr"))]
    use super::*;

    #[cfg(all(target_os = "windows", feature = "ocr"))]
    #[test]
    fn parse_score_basic() {
        assert_eq!(parse_score("123456"), Some(123456));
        assert_eq!(parse_score("Score: 123,456 pts"), Some(123456));
        assert_eq!(parse_score("no numbers"), None);
        assert_eq!(parse_score("1 2 300"), Some(300));
    }
}
