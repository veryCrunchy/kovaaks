/// Mouse hook module: captures global OS mouse events, computes smoothness metrics.
///
/// Uses the `rdev` crate which calls SetWindowsHookEx on Windows (OS-level, no game injection).
/// Metrics are emitted every second via Tauri event `mouse-metrics`, but ONLY while a
/// session is active (between `start_session_tracking` and `stop_session_tracking`).
///
/// Hotkeys (F8+ are free; below F8 used by KovaaK's):
///   F8  → toggle-settings        (open/close settings panel)
///   F9  → open-region-picker     (jump straight to region selection)
///   F10 → toggle-layout-huds     (enter/exit HUD drag-to-reposition mode)
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use rdev::{listen, Event, EventType, Key};
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
}

/// A single timestamped metric snapshot for session replay/graphing.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MetricPoint {
    pub timestamp_ms: u64,
    pub metrics: MouseMetrics,
}

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

/// Stored handle so the rdev callback (static fn) can emit hotkey events.
static APP_HANDLE: Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));

struct SharedState {
    events: Vec<RawMouseEvent>,
    session_metrics: Vec<MetricPoint>,
    session_start: Instant,
}

static STATE: Lazy<Mutex<SharedState>> = Lazy::new(|| {
    Mutex::new(SharedState {
        events: Vec::with_capacity(10_000),
        session_metrics: Vec::with_capacity(3_600),
        session_start: Instant::now(),
    })
});

pub const EVENT_MOUSE_METRICS: &str = "mouse-metrics";

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
pub fn start_session_tracking() {
    {
        let mut s = STATE.lock().unwrap();
        s.events.clear();
        s.session_metrics.clear();
        s.session_start = Instant::now();
    }
    TRACKING_ACTIVE.store(true, Ordering::SeqCst);
    log::info!("Smoothness tracking started");
}

/// Stop recording metrics (session ended). Data is retained for post-session report.
pub fn stop_session_tracking() {
    TRACKING_ACTIVE.store(false, Ordering::SeqCst);
    log::info!("Smoothness tracking stopped");
}

/// Drain session metric buffer for post-session analysis.
pub fn drain_session_buffer() -> Vec<MetricPoint> {
    let mut s = STATE.lock().unwrap();
    std::mem::take(&mut s.session_metrics)
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
        composite:     avg(|p| p.metrics.smoothness),
        jitter:        avg(|p| p.metrics.jitter),
        overshoot_rate: avg(|p| p.metrics.overshoot_rate),
        velocity_std:  avg(|p| p.metrics.velocity_std),
        path_efficiency: avg(|p| p.metrics.path_efficiency),
        avg_speed:     avg(|p| p.metrics.avg_speed),
    })
}

/// Update the user's mouse DPI/CPI so metrics are normalised correctly.
pub fn set_dpi(dpi: u32) {
    let clamped = dpi.max(100).min(32_000);
    MOUSE_DPI.store(clamped, Ordering::Relaxed);
    log::info!("Mouse DPI set to {clamped}");
}

// ─── rdev callback ────────────────────────────────────────────────────────────

fn mouse_event_callback(event: Event) {
    if !HOOK_RUNNING.load(Ordering::Relaxed) {
        return;
    }

    match event.event_type {
        EventType::MouseMove { x, y } => {
            // Only buffer events during an active session
            if TRACKING_ACTIVE.load(Ordering::Relaxed) {
                let now = Instant::now();
                if let Ok(mut s) = STATE.lock() {
                    s.events.push(RawMouseEvent { x, y, time: now });
                    // Keep only last 5 seconds of raw events to bound memory
                    if s.events.len() > 50_000 {
                        s.events.drain(..10_000);
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
            // Open region picker directly — no need to open settings first
            if let Ok(guard) = APP_HANDLE.lock() {
                if let Some(app) = guard.as_ref() {
                    let _ = app.emit("open-region-picker", ());
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

    while HOOK_RUNNING.load(Ordering::Relaxed) {
        std::thread::sleep(tick);

        // Only compute and emit when a session is active
        if !TRACKING_ACTIVE.load(Ordering::Relaxed) {
            continue;
        }

        let metrics = {
            let s = STATE.lock().unwrap();
            let cutoff = Instant::now() - window;
            let recent: Vec<&RawMouseEvent> =
                s.events.iter().filter(|e| e.time >= cutoff).collect();
            let dpi = MOUSE_DPI.load(Ordering::Relaxed);
            compute_metrics(&recent, dpi)
        };

        let point = MetricPoint {
            timestamp_ms: {
                let s = STATE.lock().unwrap();
                s.session_start.elapsed().as_millis() as u64
            },
            metrics: metrics.clone(),
        };

        {
            let mut s = STATE.lock().unwrap();
            s.session_metrics.push(point);
        }

        let _ = app.emit(EVENT_MOUSE_METRICS, &metrics);
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
    let cxx = velocities.iter().map(|(vx, _)| (vx - mx).powi(2)).sum::<f64>() / n;
    let cyy = velocities.iter().map(|(_, vy)| (vy - my).powi(2)).sum::<f64>() / n;
    let cxy = velocities.iter().map(|(vx, vy)| (vx - mx) * (vy - my)).sum::<f64>() / n;

    // Eigenvector for the larger eigenvalue of [[cxx, cxy], [cxy, cyy]].
    // The closed-form solution for a 2×2 symmetric matrix:
    //   λ₁ = ((cxx+cyy) + √((cxx-cyy)²+4cxy²)) / 2
    //   eigenvector ∝ (cxx - λ₂, cxy) = (diff + disc, 2·cxy)  (where diff = cxx-cyy)
    let diff = cxx - cyy;
    let disc = (diff * diff + 4.0 * cxy * cxy).sqrt();
    let ex = diff + disc;
    let ey = 2.0 * cxy;
    let mag = (ex * ex + ey * ey).sqrt();
    if mag < 1e-9 { (1.0, 0.0) } else { (ex / mag, ey / mag) }
}

/// Compute smoothness metrics from a set of recent raw mouse events.
///
/// # DPI normalisation
/// `dpi` is the user's configured mouse CPI.  All pixel-speed outputs are
/// divided by `dpi / 800` so that numbers are comparable regardless of
/// sensitivity setup.  Direction/ratio metrics (jitter, overshoot, velocity_std)
/// are already dimensionless and therefore inherently DPI-independent.
///
/// # Tracking awareness
/// Jitter is computed using **local sliding-window PCA** (window = 10 velocity
/// samples, 50 % overlap).  Each window uses its own dominant axis so that
/// intentional direction changes between windows (e.g. moving to a new target
/// in a different direction) are never counted as lateral noise.  A global PCA
/// axis is still used for overshoot detection on the dominant motion axis.
///
/// * **Jitter** = mean of per-window (lateral RMS / mean speed).
/// * **Overshoot** = sharp axial sign-flips on the global axis (both sides
///   above 25 % of mean speed) — catches aggressive corrections without
///   penalising smooth reversals that decelerate through zero.
/// * **Consistency** = CV of speed *above* a 0.4 natural-movement baseline,
///   so normal Fitts's-law acceleration arcs don't lose points.
fn compute_metrics(events: &[&RawMouseEvent], dpi: u32) -> MouseMetrics {
    let blank = MouseMetrics {
        smoothness: 100.0,
        jitter: 0.0,
        overshoot_rate: 0.0,
        velocity_std: 0.0,
        avg_speed: 0.0,
        path_efficiency: 1.0,
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
            let lat_rms_sq = chunk.iter()
                .map(|(vx, vy)| { let l = vx * clx + vy * cly; l * l })
                .sum::<f64>() / chunk.len() as f64;
            let chunk_mean = chunk.iter()
                .map(|(vx, vy)| (vx * vx + vy * vy).sqrt())
                .sum::<f64>() / chunk.len() as f64;
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
            let sum_sq: f64 = velocities.iter()
                .map(|(vx, vy)| { let l = vx * glx + vy * gly; l * l })
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
    let speed_variance = speeds
        .iter()
        .map(|s| (s - mean_speed).powi(2))
        .sum::<f64>()
        / speeds.len() as f64;
    let raw_cv = speed_variance.sqrt() / mean_speed.max(1.0);
    let velocity_cv = ((raw_cv - CV_NATURAL_BASELINE).max(0.0)
        / (1.0 - CV_NATURAL_BASELINE))
        .min(1.0) as f32;

    // ── Overshoot: sharp axial reversals ────────────────────────────────────
    // A "sharp" reversal is one where the axial speed stays above the threshold
    // on *both* sides of the sign flip, meaning there was no smooth deceleration
    // through zero.  This correctly ignores smooth target-following reversals
    // (which decelerate naturally) while catching overcorrections.
    let axial_threshold = mean_speed * 0.25;
    let mut sharp_reversals = 0usize;
    let mut qualified_segments = 0usize;
    for i in 0..axial.len().saturating_sub(1) {
        let a0 = axial[i];
        let a1 = axial[i + 1];
        if a0.abs() > axial_threshold {
            qualified_segments += 1;
            if a0 * a1 < 0.0 && a1.abs() > axial_threshold {
                sharp_reversals += 1;
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
            let path_len: f64 = win.windows(2).map(|w| {
                let dx = w[1].x - w[0].x;
                let dy = w[1].y - w[0].y;
                (dx * dx + dy * dy).sqrt()
            }).sum();
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

    // ── Composite score ──────────────────────────────────────────────────────
    // Weights: jitter 30 %, path efficiency 15 %, consistency 25 %, overshoot 30 %
    let jitter_score     = (1.0 - (jitter as f64).min(1.0)) * 30.0;
    let path_score       = path_efficiency as f64 * 15.0;
    let consistency_score = (1.0 - (velocity_cv as f64).min(1.0)) * 25.0;
    let overshoot_score  = (1.0 - overshoot_rate as f64) * 30.0;
    let smoothness = (jitter_score + path_score + consistency_score + overshoot_score)
        .clamp(0.0, 100.0) as f32;

    MouseMetrics {
        smoothness,
        jitter,
        overshoot_rate,
        velocity_std: velocity_cv,
        avg_speed,
        path_efficiency,
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
        let m = compute_metrics(&refs, 800);
        assert!(m.smoothness > 90.0, "expected high smoothness, got {}", m.smoothness);
        assert!(m.jitter < 0.05, "expected near-zero jitter, got {}", m.jitter);
        assert!(m.overshoot_rate < 0.05, "expected near-zero overshoot, got {}", m.overshoot_rate);
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
        let m = compute_metrics(&refs, 800);
        assert!(
            m.smoothness > 75.0,
            "smooth tracking should score high, got {}",
            m.smoothness
        );
        assert!(m.jitter < 0.1, "no lateral wobble expected, got {}", m.jitter);
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

        let m800 = compute_metrics(&refs800, 800);
        let m1600 = compute_metrics(&refs1600, 1600);

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
        let m = compute_metrics(&refs, 800);
        // Sharp back-and-forth reversals → high overshoot
        assert!(
            m.overshoot_rate > 0.5,
            "expected high overshoot for zigzag, got {}",
            m.overshoot_rate
        );
        // Overall score should be dragged down
        assert!(m.smoothness < 85.0, "erratic movement should not score high, got {}", m.smoothness);
    }
}
