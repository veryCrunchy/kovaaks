use std::collections::VecDeque;
use std::sync::Mutex;
/// Screen recorder: captures a low-resolution JPEG snapshot of the game's centre
/// region at 5 fps during active sessions, for post-session mouse-path underlay.
///
/// Performs capture on Windows using GDI/PrintWindow.
///
/// Storage: 15 fps × 640×(aspect) px × JPEG quality 65 ≈ 15–25 KB/frame.
/// A 60-second session produces ~900 frames ≈ 15–22 MB in RAM — kept only until
/// the frontend fetches and drains the buffer after the session ends.
///
/// Capture region: 50% of the game monitor's width and height centred on the
/// screen.  This keeps targets in frame without capturing large static borders.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
/// Keep a short queue of completed session frame buffers so a fast restart does
/// not erase frames before the file-watcher persists the previous run.
const MAX_COMPLETED_SESSIONS: usize = 8;
/// Output width after downscaling; height is preserved from the source aspect ratio.
/// 480 px is the replay target size, so we encode at that width directly during
/// recording — this eliminates the decode→resize→re-encode pass in
/// drain_frames_for_replay() that previously ran on the file-watcher thread.
const OUT_W: u32 = 480;
/// JPEG quality (0–100).
const JPEG_QUALITY: u8 = 65;

// ─── State ─────────────────────────────────────────────────────────────────────

static RECORDING: AtomicBool = AtomicBool::new(false);
static PAUSED: AtomicBool = AtomicBool::new(false);
/// Incremented on every `start()` call.  Each spawned thread captures its own
/// generation ID and exits as soon as it sees a newer generation — guaranteeing
/// that only one recording thread is ever active at a time.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static CAPTURE_RECT: Lazy<Mutex<Option<RegionRect>>> = Lazy::new(|| Mutex::new(None));
static FRAMES: Lazy<Mutex<Vec<ScreenFrame>>> = Lazy::new(|| Mutex::new(Vec::new()));
static COMPLETED_FRAMES: Lazy<Mutex<VecDeque<Vec<ScreenFrame>>>> =
    Lazy::new(|| Mutex::new(VecDeque::new()));
static SESSION_START: Lazy<Mutex<Option<Instant>>> = Lazy::new(|| Mutex::new(None));

// ─── Public API ────────────────────────────────────────────────────────────────

/// Compute and store the centre-crop capture rect for the given monitor rect.
///
/// Captures 50% of the monitor's width and height centred on the screen — large
/// enough to show where targets are appearing while avoiding static UI chrome at
/// the edges.  Call this whenever the user changes monitor in Settings.
pub fn update_monitor_rect(monitor: &RegionRect) {
    let cap_w = (monitor.width / 2).max(320);
    let cap_h = (monitor.height / 2).max(180);
    let cap_x = monitor.x + (monitor.width as i32 - cap_w as i32) / 2;
    let cap_y = monitor.y + (monitor.height as i32 - cap_h as i32) / 2;
    let rect = RegionRect {
        x: cap_x,
        y: cap_y,
        width: cap_w,
        height: cap_h,
    };
    log::info!(
        "screen_recorder: capture rect ({},{}) {}×{}",
        rect.x,
        rect.y,
        rect.width,
        rect.height,
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
    PAUSED.store(false, Ordering::SeqCst);
    RECORDING.store(true, Ordering::SeqCst);
    std::thread::Builder::new()
        .name(format!("screen-recorder-{generation}"))
        .spawn(move || record_loop(generation))
        .expect("failed to spawn screen-recorder thread");
    log::info!("Screen recorder started (gen {generation})");
}

/// Stop frame capture.
pub fn stop() {
    PAUSED.store(false, Ordering::SeqCst);
    if RECORDING.swap(false, Ordering::SeqCst) {
        let drained = std::mem::take(&mut *FRAMES.lock().unwrap());
        let captured_frames = drained.len();
        let mut queued_sessions = 0usize;
        if !drained.is_empty() {
            let mut completed = COMPLETED_FRAMES.lock().unwrap();
            completed.push_back(drained);
            while completed.len() > MAX_COMPLETED_SESSIONS {
                let _ = completed.pop_front();
            }
            queued_sessions = completed.len();
        }
        log::info!(
            "Screen recorder stopped (frames={}, queued_sessions={})",
            captured_frames,
            queued_sessions
        );
    }
}

/// Drain all recorded frames and clear the internal buffer.
pub fn drain_frames() -> Vec<ScreenFrame> {
    if let Some(frames) = COMPLETED_FRAMES.lock().unwrap().pop_front() {
        return frames;
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
        .cloned()
        .unwrap_or_default()
}

/// Drain frames and return a replay-quality subset for persistent storage.
///
/// Drains the frame buffer and returns every 3rd frame (15 fps → 5 fps) for
/// replay storage.  Frames are already encoded at OUT_W (480 px) and
/// JPEG_QUALITY during recording, so no re-encoding is required here.
/// A typical 60-second session produces ~300 frames ≈ 3 MB on disk.
pub fn drain_frames_for_replay() -> Vec<ScreenFrame> {
    drain_frames()
        .into_iter()
        .enumerate()
        .filter(|(i, _)| i % 3 == 0)
        .map(|(_, f)| f)
        .collect()
}

/// Re-encode a frame at a lower resolution and JPEG quality.
/// Falls back to the original frame on any error.
fn reencode_frame(frame: ScreenFrame, out_w: u32, quality: u8) -> ScreenFrame {
    use image::codecs::jpeg::JpegEncoder;
    let try_it = || -> anyhow::Result<ScreenFrame> {
        let jpeg_bytes = base64_decode(&frame.jpeg_b64);
        let img = image::load_from_memory(&jpeg_bytes)?;
        let out_h = ((img.height() as f64 / img.width() as f64) * out_w as f64).round() as u32;
        let resized = image::imageops::resize(
            &img.to_rgb8(),
            out_w,
            out_h.max(1),
            image::imageops::FilterType::Triangle,
        );
        let mut buf = Vec::new();
        JpegEncoder::new_with_quality(&mut buf, quality)
            .encode_image(&image::DynamicImage::ImageRgb8(resized))?;
        Ok(ScreenFrame {
            timestamp_ms: frame.timestamp_ms,
            jpeg_b64: base64_encode(&buf),
        })
    };
    try_it().unwrap_or(frame)
}

/// RFC 4648 standard base64 decoder matching `base64_encode`.
fn base64_decode(s: &str) -> Vec<u8> {
    let mut rev = [64u8; 256];
    for (i, &b) in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        .iter()
        .enumerate()
    {
        rev[b as usize] = i as u8;
    }
    let s = s.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(s.len() * 3 / 4 + 1);
    let mut i = 0;
    while i + 3 < s.len() {
        let (a, b, c, d) = (
            rev[s[i] as usize],
            rev[s[i + 1] as usize],
            rev[s[i + 2] as usize],
            rev[s[i + 3] as usize],
        );
        out.push((a << 2) | (b >> 4));
        out.push((b << 4) | (c >> 2));
        out.push((c << 6) | d);
        i += 4;
    }
    match s.len() - i {
        2 => {
            let (a, b) = (rev[s[i] as usize], rev[s[i + 1] as usize]);
            out.push((a << 2) | (b >> 4));
        }
        3 => {
            let (a, b, c) = (
                rev[s[i] as usize],
                rev[s[i + 1] as usize],
                rev[s[i + 2] as usize],
            );
            out.push((a << 2) | (b >> 4));
            out.push((b << 4) | (c >> 2));
        }
        _ => {}
    }
    out
}

// ─── Recording loop ───────────────────────────────────────────────────────────

fn record_loop(my_gen: u64) {
    let interval = Duration::from_millis(1000 / FPS);
    // Exit if recording was stopped *or* a newer generation has been started
    // (i.e. a new session/scenario started while we were still running).
    while RECORDING.load(Ordering::Relaxed) && GENERATION.load(Ordering::Relaxed) == my_gen {
        if PAUSED.load(Ordering::Relaxed) {
            std::thread::sleep(interval);
            continue;
        }
        let t0 = Instant::now();

        #[cfg(target_os = "windows")]
        capture_one_frame();

        let elapsed = t0.elapsed();
        if elapsed < interval {
            std::thread::sleep(interval - elapsed);
        }
    }
    log::debug!("Screen recorder thread exited (gen {my_gen})");
}

#[cfg(target_os = "windows")]
fn capture_one_frame() {
    let rect = match *CAPTURE_RECT.lock().unwrap() {
        Some(r) => r,
        None => return,
    };
    match capture_and_encode(&rect) {
        Ok(jpeg_b64) => {
            let ts_ms = SESSION_START
                .lock()
                .unwrap()
                .map_or(0, |t| t.elapsed().as_millis() as u64);
            let mut frames = FRAMES.lock().unwrap();
            if frames.len() < MAX_FRAMES {
                frames.push(ScreenFrame {
                    timestamp_ms: ts_ms,
                    jpeg_b64,
                });
            }
        }
        Err(e) => log::trace!("screen_recorder: capture error: {e}"),
    }
}

// ─── Capture + encode ─────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn capture_and_encode(rect: &RegionRect) -> anyhow::Result<String> {
    use image::codecs::jpeg::JpegEncoder;

    // Use PrintWindow on the game HWND so the capture contains only game pixels.
    // The DWM compositor is bypassed — our overlay and any other on-top windows
    // are absent.  External tools (OBS, streaming) are unaffected.
    // If the HWND isn't known yet, return Err so capture_one_frame skips this
    // frame silently rather than recording composited screen content.
    let hwnd = crate::window_tracker::get_game_hwnd()
        .ok_or_else(|| anyhow::anyhow!("game HWND not yet detected — skipping frame"))?;
    let (bgra, w, h) = capture_game_window_region(hwnd, rect)?;

    // BGRA → RGB (PrintWindow gives BGRA; image::Rgb expects RGB)
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

    // JPEG encode
    let mut buf = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY)
        .encode_image(&image::DynamicImage::ImageRgb8(resized))?;

    Ok(base64_encode(&buf))
}

/// Capture a subregion of the game window using PrintWindow.
///
/// PrintWindow renders the HWND directly into a memory DC, bypassing the DWM
/// compositor — layered/transparent windows on top (our overlay, etc.) are
/// never included.  `screen_rect` is in screen coordinates; we translate to
/// client coordinates so the crop is correct for non-(0,0) game windows too.
#[cfg(target_os = "windows")]
fn capture_game_window_region(
    hwnd: windows::Win32::Foundation::HWND,
    screen_rect: &RegionRect,
) -> anyhow::Result<(Vec<u8>, u32, u32)> {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, ClientToScreen, CreateCompatibleBitmap,
        CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, HDC, HGDIOBJ,
        ReleaseDC, SRCCOPY, SelectObject,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

    // PrintWindow is not re-exported by the windows crate under the feature
    // flags we use, so bind it directly from user32.dll.
    // Must be declared at item scope (not inside an unsafe block).
    #[link(name = "user32")]
    unsafe extern "system" {
        fn PrintWindow(hwnd: windows::Win32::Foundation::HWND, hdcBlt: HDC, nFlags: u32) -> i32;
    }
    const PW_RENDERFULLCONTENT: u32 = 0x0000_0002;

    unsafe {
        let mut client_rect = RECT::default();
        GetClientRect(hwnd, &mut client_rect).map_err(|e| anyhow::anyhow!("GetClientRect: {e}"))?;
        let cw = client_rect.right - client_rect.left;
        let ch = client_rect.bottom - client_rect.top;
        anyhow::ensure!(cw > 0 && ch > 0, "game window has zero client area");

        let mut origin = POINT { x: 0, y: 0 };
        // ClientToScreen only fails with an invalid HWND, which GetClientRect
        // already proved is valid above.
        let _ = ClientToScreen(hwnd, &mut origin);

        // Translate screen_rect into client coordinates and clamp to window.
        let crop_x = (screen_rect.x - origin.x).clamp(0, cw - 1);
        let crop_y = (screen_rect.y - origin.y).clamp(0, ch - 1);
        let crop_w = (screen_rect.width as i32).min(cw - crop_x);
        let crop_h = (screen_rect.height as i32).min(ch - crop_y);
        anyhow::ensure!(
            crop_w > 0 && crop_h > 0,
            "crop region is outside game window"
        );

        // Render the full game client area into a memory DC via PrintWindow,
        // then BitBlt the desired subregion into a second DC for pixel readback.
        let screen_dc = GetDC(None);
        anyhow::ensure!(!screen_dc.is_invalid(), "GetDC(NULL) failed");
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        let full_bmp = CreateCompatibleBitmap(screen_dc, cw, ch);
        let old_full = SelectObject(mem_dc, HGDIOBJ(full_bmp.0));
        let _ = PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT);

        let crop_dc = CreateCompatibleDC(Some(screen_dc));
        let crop_bmp = CreateCompatibleBitmap(screen_dc, crop_w, crop_h);
        let old_crop = SelectObject(crop_dc, HGDIOBJ(crop_bmp.0));
        let _ = BitBlt(
            crop_dc,
            0,
            0,
            crop_w,
            crop_h,
            Some(mem_dc),
            crop_x,
            crop_y,
            SRCCOPY,
        );

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: crop_w,
                biHeight: -crop_h, // negative = top-down scan order
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: (crop_w * crop_h * 4) as u32,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (crop_w * crop_h * 4) as usize];
        let lines = GetDIBits(
            crop_dc,
            crop_bmp,
            0,
            crop_h as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        let _ = SelectObject(crop_dc, old_crop);
        let _ = DeleteObject(HGDIOBJ(crop_bmp.0));
        let _ = DeleteDC(crop_dc);
        let _ = SelectObject(mem_dc, old_full);
        let _ = DeleteObject(HGDIOBJ(full_bmp.0));
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);

        anyhow::ensure!(lines != 0, "GetDIBits returned 0 scan lines");
        Ok((pixels, crop_w as u32, crop_h as u32))
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
