/// Screen recorder: captures a low-resolution JPEG snapshot of the game's centre
/// region at 5 fps during active sessions, for post-session mouse-path underlay.
///
/// Only performs actual capture with the `ocr` feature on Windows (shares GDI
/// infrastructure with `ocr.rs`).  On other platforms all functions are no-ops
/// that return empty Vecs so the frontend degrades gracefully.
///
/// Storage: 15 fps × 640×(aspect) px × JPEG quality 65 ≈ 15–25 KB/frame.
/// A 60-second session produces ~900 frames ≈ 15–22 MB in RAM — kept only until
/// the frontend fetches and drains the buffer after the session ends.
///
/// Capture region: 50% of the game monitor's width and height centred on the
/// screen.  This keeps targets in frame without capturing large static borders.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

use crate::settings::RegionRect;

// ─── Types ─────────────────────────────────────────────────────────────────────

/// A single captured video frame for post-session mouse-path underlay.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScreenFrame {
    /// Milliseconds since session start.
    pub timestamp_ms: u64,
    /// JPEG-encoded frame, base64-encoded for Tauri IPC transport.
    /// ≤ 320 × proportional px, quality 20.
    pub jpeg_b64: String,
}

// ─── Config ─────────────────────────────────────────────────────────────────────

const FPS: u64 = 15;
/// Cap at 2 700 frames ≈ 3-minute session at 15 fps.
const MAX_FRAMES: usize = 2_700;
/// Output width after downscaling; height is preserved from the source aspect ratio.
const OUT_W: u32 = 640;
/// JPEG quality (0–100).
const JPEG_QUALITY: u8 = 65;

// ─── State ─────────────────────────────────────────────────────────────────────

static RECORDING:      AtomicBool                      = AtomicBool::new(false);
/// Incremented on every `start()` call.  Each spawned thread captures its own
/// generation ID and exits as soon as it sees a newer generation — guaranteeing
/// that only one recording thread is ever active at a time.
static GENERATION:     AtomicU64                       = AtomicU64::new(0);
static CAPTURE_RECT:   Lazy<Mutex<Option<RegionRect>>> = Lazy::new(|| Mutex::new(None));
static FRAMES:         Lazy<Mutex<Vec<ScreenFrame>>>   = Lazy::new(|| Mutex::new(Vec::new()));
static SESSION_START:  Lazy<Mutex<Option<Instant>>>    = Lazy::new(|| Mutex::new(None));

// ─── Public API ────────────────────────────────────────────────────────────────

/// Compute and store the centre-crop capture rect for the given monitor rect.
///
/// Captures 50% of the monitor's width and height centred on the screen — large
/// enough to show where targets are appearing while avoiding static UI chrome at
/// the edges.  Call this whenever the user changes monitor in Settings.
pub fn update_monitor_rect(monitor: &RegionRect) {
    let cap_w = (monitor.width  / 2).max(320);
    let cap_h = (monitor.height / 2).max(180);
    let cap_x = monitor.x + (monitor.width  as i32 - cap_w as i32) / 2;
    let cap_y = monitor.y + (monitor.height as i32 - cap_h as i32) / 2;
    let rect  = RegionRect { x: cap_x, y: cap_y, width: cap_w, height: cap_h };
    log::info!(
        "screen_recorder: capture rect ({},{}) {}×{}",
        rect.x, rect.y, rect.width, rect.height,
    );
    *CAPTURE_RECT.lock().unwrap() = Some(rect);
}

/// Start frame capture for a new session.  Always restarts fresh — clears any
/// previously recorded frames and resets the session clock.  If a recording
/// thread is already running (e.g. scenario restart mid-session) it will detect
/// the bumped generation and exit cleanly on its next iteration.
/// Start frame capture for a new session, sharing the caller's `session_start`
/// instant so screen-frame timestamps are on the exact same clock as the mouse
/// position timestamps produced by `mouse_hook::start_session_tracking()`.
/// Always restarts fresh — clears any previously recorded frames and resets the
/// session clock.  If a recording thread is already running it will detect the
/// bumped generation and exit cleanly on its next iteration.
pub fn start(session_start: Instant) {
    // Bump generation first so any running thread exits on its next loop check.
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    {
        FRAMES.lock().unwrap().clear();
        *SESSION_START.lock().unwrap() = Some(session_start);
    }
    RECORDING.store(true, Ordering::SeqCst);
    std::thread::Builder::new()
        .name(format!("screen-recorder-{generation}"))
        .spawn(move || record_loop(generation))
        .expect("failed to spawn screen-recorder thread");
    log::info!("Screen recorder started (gen {generation})");
}

/// Stop frame capture.
pub fn stop() {
    if RECORDING.swap(false, Ordering::SeqCst) {
        log::info!("Screen recorder stopped");
    }
}

/// Drain all recorded frames and clear the internal buffer.
pub fn drain_frames() -> Vec<ScreenFrame> {
    std::mem::take(&mut *FRAMES.lock().unwrap())
}

/// Return all recorded frames without removing them.
/// The buffer is cleared automatically when the next session starts.
pub fn get_frames() -> Vec<ScreenFrame> {
    FRAMES.lock().unwrap().clone()
}

// ─── Recording loop ───────────────────────────────────────────────────────────

fn record_loop(my_gen: u64) {
    let interval = Duration::from_millis(1000 / FPS);
    // Exit if recording was stopped *or* a newer generation has been started
    // (i.e. a new session/scenario started while we were still running).
    while RECORDING.load(Ordering::Relaxed)
        && GENERATION.load(Ordering::Relaxed) == my_gen
    {
        let t0 = Instant::now();

        #[cfg(all(target_os = "windows", feature = "ocr"))]
        capture_one_frame();

        let elapsed = t0.elapsed();
        if elapsed < interval {
            std::thread::sleep(interval - elapsed);
        }
    }
    log::debug!("Screen recorder thread exited (gen {my_gen})");
}

#[cfg(all(target_os = "windows", feature = "ocr"))]
fn capture_one_frame() {
    // Only capture while KovaaKs is the foreground window.  If the user has
    // alt-tabbed or another window is on top, skip this frame entirely — the
    // session clock keeps running so sync with mouse data is preserved, and no
    // non-game footage ends up in the replay.
    if !crate::window_tracker::is_game_focused() {
        return;
    }
    let rect = match *CAPTURE_RECT.lock().unwrap() {
        Some(r) => r,
        None    => return,
    };
    match capture_and_encode(&rect) {
        Ok(jpeg_b64) => {
            let ts_ms = SESSION_START
                .lock().unwrap()
                .map_or(0, |t| t.elapsed().as_millis() as u64);
            let mut frames = FRAMES.lock().unwrap();
            if frames.len() < MAX_FRAMES {
                frames.push(ScreenFrame { timestamp_ms: ts_ms, jpeg_b64 });
            }
        }
        Err(e) => log::trace!("screen_recorder: capture error: {e}"),
    }
}

// ─── Capture + encode ─────────────────────────────────────────────────────────

#[cfg(all(target_os = "windows", feature = "ocr"))]
fn capture_and_encode(rect: &RegionRect) -> anyhow::Result<String> {
    use image::codecs::jpeg::JpegEncoder;

    let (bgra, w, h) = crate::ocr::capture_region_gdi(rect)?;

    // BGRA → RGB (GDI gives BGRA; image::Rgb expects RGB)
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for px in bgra.chunks_exact(4) {
        rgb.push(px[2]); // R
        rgb.push(px[1]); // G
        rgb.push(px[0]); // B
    }

    let img = image::ImageBuffer::<image::Rgb<u8>, Vec<u8>>::from_raw(w, h, rgb)
        .ok_or_else(|| anyhow::anyhow!("invalid image buffer dimensions"))?;

    // Downscale to OUT_W, preserving aspect ratio
    let out_h = ((h as f32 / w as f32) * OUT_W as f32).round() as u32;
    let resized = image::imageops::resize(
        &img,
        OUT_W,
        out_h.max(1),
        image::imageops::FilterType::Nearest,
    );

    // JPEG encode at low quality
    let mut buf = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY)
        .encode_image(&image::DynamicImage::ImageRgb8(resized))?;

    Ok(base64_encode(&buf))
}

/// RFC 4648 standard base64 encoder — avoids adding a dependency.
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n  = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[( n       & 63) as usize] as char } else { '=' });
    }
    out
}
