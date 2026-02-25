/// Stats-panel OCR module.
///
/// Reads the KovaaK's in-game stats panel (Kill Count, KPS, Accuracy,
/// Damage, SPM, Avg TTK) on every poll tick.  Delta-detects shot events
/// (hits and misses), infers scenario type from which fields are populated,
/// and emits scenario-type-aware live coaching feedback.
///
/// Emits:
///   `stats-panel-update`  — full StatsPanelReading every tick (throttled when unchanged)
///   `shot-event`          — on each detected shot (hit or miss)
///   `live-feedback`       — coaching notifications (uses same event as mouse_hook)
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};

use crate::settings::{RegionRect, StatsFieldRegions};

// ─── Types ─────────────────────────────────────────────────────────────────────

/// One parsed reading of the stats panel.  All fields are Option because not
/// every scenario type populates every field.  The presence pattern is used to
/// infer ScenarioType (see below).
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct StatsPanelReading {
    /// Session elapsed time in seconds.
    pub session_time_secs: Option<u32>,
    /// Total kills this session.
    pub kills: Option<u32>,
    /// Kills per second (rolling window, shown by KovaaK's).
    pub kps: Option<f32>,
    /// Shots that hit a target.
    pub accuracy_hits: Option<u32>,
    /// Total shots fired.
    pub accuracy_shots: Option<u32>,
    /// Accuracy as a percentage (0–100).
    pub accuracy_pct: Option<f32>,
    /// Damage dealt to targets.
    pub damage_dealt: Option<f64>,
    /// Total possible damage (target HP × targets).
    pub damage_total: Option<f64>,
    /// Score per minute.
    pub spm: Option<u32>,
    /// Average time-to-kill in seconds.  None if no kills yet or "--" shown.
    pub ttk_secs: Option<f32>,
    /// Inferred scenario type as a string (Unknown / Tracking / OneShotClicking /
    /// MultiHitClicking / ReactiveClicking / AccuracyDrill).
    pub scenario_type: String,
}

/// A detected shot event (single hit or miss), correlated with the concurrent
/// mouse movement metrics.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ShotEvent {
    /// True = target was hit; False = shot missed.
    pub hit: bool,
    /// True if this shot resulted in a kill.
    pub kill: bool,
    /// Milliseconds since session start.
    pub timestamp_ms: u64,
    /// TTK for this kill in milliseconds, if kills incremented.
    pub ttk_ms: Option<f32>,
    /// Scenario type at time of event.
    pub scenario_type: String,
    /// Mouse overshoot rate at time of shot (from last metric tick).
    pub mouse_overshoot: f32,
    /// Fraction of time in Fitts' correction phase at time of shot.
    pub mouse_correction_ratio: f32,
    /// Lateral jitter at time of shot.
    pub mouse_jitter: f32,
}

/// Scenario type inferred from populated field patterns.
#[derive(Debug, Clone, PartialEq)]
enum ScenarioType {
    /// Not enough readings to determine yet.
    Unknown,
    /// SPM increments but kills never appear → continuous tracking.
    PureTracking,
    /// Kills + KPS present, damage always "--" → targets die in one shot.
    OneShotClicking,
    /// Kills + damage present → targets take multiple hits.
    MultiHitClicking,
    /// TTK < 0.18s consistently → near-instant reactive spawns.
    ReactiveClicking,
    /// Accuracy fields present but no kills → pure accuracy/flicking drill.
    AccuracyDrill,
}

impl ScenarioType {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Unknown           => "Unknown",
            Self::PureTracking      => "Tracking",
            Self::OneShotClicking   => "OneShotClicking",
            Self::MultiHitClicking  => "MultiHitClicking",
            Self::ReactiveClicking  => "ReactiveClicking",
            Self::AccuracyDrill     => "AccuracyDrill",
        }
    }
}

// ─── Module state ──────────────────────────────────────────────────────────────

static RUNNING: AtomicBool = AtomicBool::new(false);
static ACTIVE: AtomicBool = AtomicBool::new(false);  // mirrors session active
static FIELD_REGIONS: Lazy<Mutex<StatsFieldRegions>> = Lazy::new(|| Mutex::new(StatsFieldRegions::default()));
static POLL_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(100);

struct StatsState {
    prev: Option<StatsPanelReading>,
    ttk_history: VecDeque<(f32, Instant)>, // (ttk_secs, captured_at)
    accuracy_history: VecDeque<(f32, Instant)>, // (pct, at) for trend
    session_start: Instant,
    scenario_type: ScenarioType,
    /// How many readings had SPM > 0.  Used to gate the snapshot export.
    active_readings: u32,
    /// Rolling window of per-tick scenario-type votes (last 20 ticks ≈ 2 s at 100 ms poll).
    /// The plurality winner is the live `scenario_type`.
    type_vote_window: VecDeque<ScenarioType>,
    // Feedback streak / cooldown counters (key → remaining ticks)
    cooldowns: std::collections::HashMap<&'static str, u32>,
    streaks: std::collections::HashMap<&'static str, u32>,
}

static STATE: Lazy<Mutex<StatsState>> = Lazy::new(|| {
    Mutex::new(StatsState {
        prev: None,
        ttk_history: VecDeque::with_capacity(200),
        accuracy_history: VecDeque::with_capacity(600),
        session_start: Instant::now(),
        scenario_type: ScenarioType::Unknown,
        active_readings: 0,
        type_vote_window: VecDeque::with_capacity(20),
        cooldowns: Default::default(),
        streaks: Default::default(),
    })
});

pub const EVENT_STATS_PANEL: &str = "stats-panel-update";
pub const EVENT_SHOT: &str = "shot-event";

// ─── Public API ────────────────────────────────────────────────────────────────

pub fn update_field_regions(regions: StatsFieldRegions) {
    *FIELD_REGIONS.lock().unwrap() = regions;
}

pub fn set_active(active: bool) {
    ACTIVE.store(active, Ordering::Relaxed);
    if active {
        // Reset all session state on new session
        let mut s = STATE.lock().unwrap();
        s.prev = None;
        s.ttk_history.clear();
        s.accuracy_history.clear();
        s.session_start = Instant::now();
        s.scenario_type = ScenarioType::Unknown;
        s.active_readings = 0;
        s.type_vote_window.clear();
        s.cooldowns.clear();
        s.streaks.clear();
    }
}

pub fn start(app: AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) { return; }
    std::thread::Builder::new()
        .name("stats-ocr".into())
        .spawn(move || {
            log::info!("Stats-panel OCR thread started");
            poll_loop(app);
            log::info!("Stats-panel OCR thread stopped");
        })
        .expect("failed to spawn stats-ocr thread");
}

#[allow(dead_code)]
pub fn stop() {
    RUNNING.store(false, Ordering::SeqCst);
}

/// Return the current inferred scenario type as a string (used by mouse_hook for feedback gating).
pub fn get_scenario_type() -> String {
    STATE.lock()
        .map(|s| s.scenario_type.as_str().to_string())
        .unwrap_or_else(|_| "Unknown".to_string())
}

/// Return the most recent stats reading (used by session_store at session end).
pub fn get_snapshot() -> Option<crate::session_store::StatsPanelSnapshot> {
    let s = STATE.lock().ok()?;
    let prev = s.prev.as_ref()?;
    if s.active_readings == 0 { return None; }

    let (ttk_avg, ttk_std, ttk_best) = ttk_stats(&s.ttk_history);
    let accuracy_trend = accuracy_trend_value(&s.accuracy_history);

    Some(crate::session_store::StatsPanelSnapshot {
        scenario_type: s.scenario_type.as_str().to_string(),
        kills: prev.kills,
        avg_kps: prev.kps,
        accuracy_pct: prev.accuracy_pct,
        total_damage: prev.damage_dealt.map(|d| d as f32),
        avg_ttk_ms: ttk_avg.map(|t| t * 1000.0),
        best_ttk_ms: ttk_best.map(|t| t * 1000.0),
        ttk_std_ms: ttk_std.map(|t| t * 1000.0),
        accuracy_trend,
    })
}

// ─── Poll loop ─────────────────────────────────────────────────────────────────

fn poll_loop(app: AppHandle) {
    let mut last_emitted: Option<StatsPanelReading> = None;

    // Idle / pause detection state.
    //
    // Two independent signals cause us to pause mid-session mouse tracking:
    //   1. OCR capture keeps failing (capture error or empty text) — player is
    //      likely at the main menu, loading screen, or the region is wrong.
    //   2. All key stats fields are unchanged for many consecutive ticks —
    //      player paused the game or is sitting at a between-round results screen.
    //
    // Either counter reaching its threshold calls mouse_hook::pause_session_tracking.
    // Any tick where real stats change resets both counters and resumes tracking.
    //
    // Thresholds are expressed in ticks (≈ POLL_MS each):
    //   FAIL_PAUSE  = 20 ticks ≈ 2 s — fast because OCR failure is unambiguous
    //   IDLE_PAUSE  = 30 ticks ≈ 3 s — longer; brief freezes between targets are normal
    let mut ocr_fail_ticks: u32 = 0;
    let mut idle_ticks: u32 = 0;
    let mut mid_session_paused = false;
    const FAIL_PAUSE: u32 = 20;
    const IDLE_PAUSE: u32 = 30;

    while RUNNING.load(Ordering::SeqCst) {
        let poll = POLL_MS.load(Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(poll));

        // Decrement cooldowns
        {
            if let Ok(mut s) = STATE.lock() {
                for v in s.cooldowns.values_mut() { *v = v.saturating_sub(1); }
            }
        }

        if !ACTIVE.load(Ordering::Relaxed) || !crate::window_tracker::is_game_focused() {
            // Session ended or game lost focus — reset idle counters and any
            // mid-session pause (the real stop/resume is handled at session level).
            ocr_fail_ticks = 0;
            idle_ticks = 0;
            mid_session_paused = false;
            continue;
        }

        let field_regions = FIELD_REGIONS.lock().unwrap().clone();

        // If no field regions configured, still emit SPM-only updates so the
        // StatsHUD shows live SPM even before the user maps the other fields.
        if !field_regions.has_any() {
            if let Some(spm) = crate::ocr::get_current_spm() {
                let mut reading = StatsPanelReading::default();
                reading.spm = Some(spm);
                // SPM-only path — no idle state here, never suppress
                process_reading(&app, reading, &mut last_emitted, false);
            }
            continue;
        }

        // OCR each configured field individually — one small region per stat.
        let mut reading = StatsPanelReading::default();
        let mut any_ok = false;
        let mut all_failed = true;
        let mut debug_parts: Vec<String> = Vec::new();

        // Helper: OCR one rect, run a parser, log.
        // Returns true if capture succeeded (even if parse returned None).
        macro_rules! capture_field {
            ($rect_opt:expr, $name:literal) => {{
                match $rect_opt {
                    Some(rect) => match crate::ocr::capture_text(rect) {
                        Ok(text) => {
                            any_ok = true;
                            all_failed = false;
                            debug_parts.push(format!("{}={:?}", $name, text.trim()));
                            Some(text)
                        }
                        Err(e) => {
                            log::debug!("stats-ocr {} capture error: {e}", $name);
                            None
                        }
                    },
                    None => { all_failed = false; None }
                }
            }};
        }

        if let Some(text) = capture_field!(field_regions.kills, "kills") {
            reading.kills = parse_kills_field(&text);
        }
        if let Some(text) = capture_field!(field_regions.kps, "kps") {
            reading.kps = parse_kps_field(&text);
        }
        if let Some(text) = capture_field!(field_regions.accuracy, "accuracy") {
            let (hits, shots, pct) = parse_accuracy_field(&text);
            reading.accuracy_hits  = hits;
            reading.accuracy_shots = shots;
            reading.accuracy_pct   = pct;
        }
        if let Some(text) = capture_field!(field_regions.damage, "damage") {
            reading.damage_dealt = parse_damage_field(&text);
        }
        if let Some(text) = capture_field!(field_regions.ttk, "ttk") {
            reading.ttk_secs = parse_ttk_field(&text);
        }

        // Inject live SPM from the score OCR — it already reads the SPM counter
        // at high frequency so we don't need a dedicated region for it.
        let live_spm = crate::ocr::get_current_spm();
        reading.spm = live_spm;

        // If every individual capture returned an Err AND we have no SPM, the
        // game is probably not showing stats — pause mouse tracking.
        if all_failed && live_spm.is_none() {
            ocr_fail_ticks += 1;
            if ocr_fail_ticks >= FAIL_PAUSE && !mid_session_paused {
                log::info!("[stats-ocr] all field OCR failing for {} ticks — pausing mouse tracking", ocr_fail_ticks);
                mid_session_paused = true;
                crate::mouse_hook::pause_session_tracking();
            }
            continue;
        }
        // Nothing useful captured at all (no captures succeeded, no SPM) — skip tick.
        if !any_ok && live_spm.is_none() { continue; }

        // Emit debug summary
        let debug_text = debug_parts.join(" | ");
        let _ = app.emit("stats-ocr-raw", &debug_text);
        log::debug!("[stats-ocr] fields: {}", debug_text);

        // Snapshot the last_emitted fingerprint before processing so we can
        // tell whether something genuinely changed this tick.
        let fp_before = last_emitted.as_ref().map(|r| {
            (r.kills, r.accuracy_shots, r.spm, r.damage_dealt.map(|d| d as u64), r.ttk_secs.map(|t| (t * 1000.0) as u32))
        });

        // Update state and compute deltas.
        // Suppress coaching/shot feedback while mid-session is paused (idle) so
        // history-based alerts don't fire on stale frozen data.
        process_reading(&app, reading.clone(), &mut last_emitted, mid_session_paused);

        let fp_after = last_emitted.as_ref().map(|r| {
            (r.kills, r.accuracy_shots, r.spm, r.damage_dealt.map(|d| d as u64), r.ttk_secs.map(|t| (t * 1000.0) as u32))
        });

        // Did any key field change this tick?
        let stats_advanced = fp_after.is_some() && fp_before != fp_after;

        if stats_advanced {
            // Real progress — reset all idle counters and resume if paused.
            ocr_fail_ticks = 0;
            idle_ticks = 0;
            if mid_session_paused {
                mid_session_paused = false;
                crate::mouse_hook::resume_session_tracking();
            }
        } else {
            // No change — advance the frozen-stats counter.
            // Also reset the OCR failure counter since the capture itself worked.
            ocr_fail_ticks = 0;
            idle_ticks += 1;
            if idle_ticks >= IDLE_PAUSE && !mid_session_paused {
                log::info!("[stats-ocr] stats frozen for {} ticks — pausing mouse tracking", idle_ticks);
                mid_session_paused = true;
                crate::mouse_hook::pause_session_tracking();
            }
        }
    }
}

// ─── Per-field parsers ─────────────────────────────────────────────────────────
//
// Each parser takes the raw OCR text from a small single-stat region and
// returns the parsed value.  They are intentionally simple: one region = one
// number, no column alignment needed.

fn parse_kills_field(text: &str) -> Option<u32> {
    // Kill count is a plain integer, possibly thousands-formatted ("1,234").
    let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.parse::<u32>().ok()
}

fn parse_kps_field(text: &str) -> Option<f32> {
    // KPS is a decimal like "2.3" or "0.84".
    // Take the first whitespace token that parses as f32.
    let normalised = text.replace(',', ".");
    for tok in normalised.split_whitespace() {
        // Keep only digit/dot characters in case OCR adds stray letters.
        let clean: String = tok.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
        if let Ok(v) = clean.parse::<f32>() {
            return Some(v);
        }
    }
    None
}

/// Returns (hits, total_shots, accuracy_pct).
fn parse_accuracy_field(text: &str) -> (Option<u32>, Option<u32>, Option<f32>) {
    // Expected formats:
    //   "2,833/5,658 (50.1%)"   — KovaaK's default
    //   "2833/5658(50.1%)"      — compact (no spaces)
    //   "(50.1%)"               — pct only if user draws a tight box
    // Strategy: extract the fraction first, then the percentage.
    let mut hits: Option<u32> = None;
    let mut shots: Option<u32> = None;
    let mut pct: Option<f32> = None;

    // Try to find "NNN/NNN" where N may include commas.
    let clean = text.replace(',', "");
    if let Some(slash_pos) = clean.find('/') {
        let lhs: String = clean[..slash_pos].chars().filter(|c| c.is_ascii_digit()).collect();
        let rhs: String = clean[slash_pos + 1..].chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        hits  = lhs.parse::<u32>().ok();
        shots = rhs.parse::<u32>().ok();
    }

    // Try to find "(NN.N%)" pattern for the percentage.
    if let Some(open) = text.find('(') {
        let after = &text[open + 1..];
        let num: String = after.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
        pct = num.parse::<f32>().ok();
    }

    // If we got a fraction but no bracket pct, compute it.
    if pct.is_none() {
        if let (Some(h), Some(s)) = (hits, shots) {
            if s > 0 { pct = Some(h as f32 / s as f32 * 100.0); }
        }
    }

    (hits, shots, pct)
}

fn parse_damage_field(text: &str) -> Option<f64> {
    // Damage is a plain number, possibly thousands-formatted ("8,836").
    let clean: String = text.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
    clean.parse::<f64>().ok()
}

fn parse_ttk_field(text: &str) -> Option<f32> {
    // TTK is shown as "0.243s" or "243ms" or "--" (no kills yet).
    // Strip non-numeric except '.' to get the float value in seconds.
    let lower = text.to_lowercase();
    if lower.contains("--") || lower.contains("n/a") {
        return None;
    }
    // Check for milliseconds suffix: convert to seconds.
    let is_ms = lower.contains("ms");
    let clean: String = lower.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
    let v = clean.parse::<f32>().ok()?;
    if is_ms { Some(v / 1000.0) } else { Some(v) }
}

// ─── Reading validation ────────────────────────────────────────────────────────

/// Nullify values that are physically impossible for any KovaaK's session.
///
/// The column-layout parser mis-assigns tokens when OCR reads a partial value
/// block (e.g. "1/2" landing in the Kill Count slot → digit-filter → 12, or a
/// thousands-formatted number in the KPS slot → 113.204).  Clamping to None
/// before anything else prevents these from entering type inference, histories,
/// and the delta pipeline.
fn sanitize_reading(r: &mut StatsPanelReading) {
    // Kill count: even marathon sessions rarely exceed a few hundred.
    // Anything above 2000 is an OCR parse artifact.
    if r.kills.map_or(false, |k| k > 2_000) {
        log::debug!("[stats-ocr] implausible kills={:?} → None", r.kills);
        r.kills = None;
    }
    // KPS above 20 is physically impossible; 113 arises from "113,204" misparse.
    if r.kps.map_or(false, |k| k > 20.0) {
        log::debug!("[stats-ocr] implausible kps={:?} → None", r.kps);
        r.kps = None;
    }
    // SPM above 30 000 is implausible (world-record tracking ≈ 12 000–15 000).
    // "50 025" or "113 204" signals a partial-column OCR mis-assignment.
    if r.spm.map_or(false, |s| s > 30_000) {
        log::debug!("[stats-ocr] implausible spm={:?} → None", r.spm);
        r.spm = None;
    }
    // Accuracy: hits cannot exceed total shots — if so both values are bogus.
    if let (Some(hits), Some(shots)) = (r.accuracy_hits, r.accuracy_shots) {
        if hits > shots {
            log::debug!("[stats-ocr] impossible accuracy {}/{} → None", hits, shots);
            r.accuracy_hits  = None;
            r.accuracy_shots = None;
            r.accuracy_pct   = None;
        }
    }
    // Accuracy percentage must be in [0, 100].
    if r.accuracy_pct.map_or(false, |p| !(0.0..=100.0).contains(&p)) {
        r.accuracy_pct = None;
    }
    // TTK must be positive and below 30 s.
    if r.ttk_secs.map_or(false, |t| t <= 0.0 || t > 30.0) {
        r.ttk_secs = None;
    }
}

/// Enforce that session-cumulative counters only increase within a session.
///
/// Kills and shots fired are monotonically non-decreasing as shown by KovaaK's.
/// A lower value than the previous confirmed reading means OCR produced a
/// partial or mis-aligned column read.  Substituting the previous value keeps
/// the delta pipeline from emitting negative or oscillating events.
fn enforce_monotonic(reading: &mut StatsPanelReading, prev: &StatsPanelReading) {
    if let (Some(curr), Some(prev_val)) = (reading.kills, prev.kills) {
        if curr < prev_val {
            log::debug!(
                "[stats-ocr] kills {} → {} (OCR artifact), restoring {}",
                prev_val, curr, prev_val
            );
            reading.kills = Some(prev_val);
        }
    }
    if let (Some(curr_s), Some(prev_s)) = (reading.accuracy_shots, prev.accuracy_shots) {
        if curr_s < prev_s {
            log::debug!(
                "[stats-ocr] accuracy_shots {} → {} (OCR artifact), restoring {}",
                prev_s, curr_s, prev_s
            );
            reading.accuracy_shots = Some(prev_s);
            reading.accuracy_hits  = prev.accuracy_hits;
        }
    }
}

// ─── Delta processing ──────────────────────────────────────────────────────────

/// `suppress_feedback`: when true, shot events and live-feedback coaching
/// notifications are suppressed (idle / mid-session pause).  Internal state
/// (histories, `prev`, `last_emitted`, `stats-panel-update`) is always updated.
fn process_reading(app: &AppHandle, mut reading: StatsPanelReading, last_emitted: &mut Option<StatsPanelReading>, suppress_feedback: bool) {
    // Sanitize impossible values before anything else — prevents OCR artifacts
    // from contaminating type inference, histories, and the delta pipeline.
    sanitize_reading(&mut reading);

    let mut s = STATE.lock().unwrap();

    // Enforce monotonicity of cumulative counters against the last confirmed reading.
    if let Some(ref prev) = s.prev {
        enforce_monotonic(&mut reading, prev);
    }

    // Scenario type inference — refine as evidence accumulates
    update_scenario_type(&mut s, &reading);
    reading.scenario_type = s.scenario_type.as_str().to_string();

    let now = Instant::now();
    let ts_ms = s.session_start.elapsed().as_millis() as u64;

    // Track accuracy history for trend computation
    if let Some(pct) = reading.accuracy_pct {
        s.accuracy_history.push_back((pct, now));
        // Keep 10 minutes of history
        while s.accuracy_history.len() > 6000 { s.accuracy_history.pop_front(); }
    }

    // Track TTK history
    if let Some(ttk) = reading.ttk_secs {
        if s.prev.as_ref().and_then(|p| p.ttk_secs) != Some(ttk) {
            s.ttk_history.push_back((ttk, now));
            if s.ttk_history.len() > 500 { s.ttk_history.pop_front(); }
        }
    }

    // Delta detection — compare with previous reading
    let prev = s.prev.clone();
    if let Some(ref p) = prev {
        // ── Shot and kill event detection ───────────────────────────────────
        let mut new_shots = match (reading.accuracy_shots, p.accuracy_shots) {
            (Some(n), Some(prev_n)) if n > prev_n => n - prev_n,
            _ => 0,
        };
        let mut new_hits = match (reading.accuracy_hits, p.accuracy_hits) {
            (Some(n), Some(prev_n)) if n > prev_n => n - prev_n,
            _ => 0,
        };
        let mut new_kills = match (reading.kills, p.kills) {
            (Some(n), Some(prev_n)) if n > prev_n => n - prev_n,
            _ => 0,
        };

        // Per-tick plausibility caps — at ~100 ms poll, more than 5 new kills
        // or 10 new shots in one tick is physically impossible.  Residual OCR
        // oscillation that slips past sanitize/monotonic (e.g. kills 3 → bogus
        // 12 on one tick) would otherwise fire burst events.
        const MAX_KILLS_PER_TICK: u32 = 5;
        const MAX_SHOTS_PER_TICK: u32 = 10;
        if new_kills > MAX_KILLS_PER_TICK {
            log::debug!("[stats-ocr] kill delta {} exceeds plausible per-tick max, ignoring", new_kills);
            new_kills = 0;
        }
        if new_shots > MAX_SHOTS_PER_TICK {
            log::debug!("[stats-ocr] shot delta {} exceeds plausible per-tick max, ignoring", new_shots);
            new_shots = 0;
            new_hits  = 0;
        }

        // All shot and coaching feedback is gated on suppress_feedback.
        // (Histories and prev-state updates above always run — data quality
        // must be maintained even during idle so state is ready on resume.)
        if !suppress_feedback {
            if new_shots > 0 {
                // Correlate with current mouse metrics
                let mouse = crate::mouse_hook::get_latest_metrics();
                let (overshoot, correction, jitter) = mouse.as_ref().map(|m| {
                    (m.overshoot_rate, m.correction_ratio, m.jitter)
                }).unwrap_or((0.0, 0.0, 0.0));

                // Emit individual shot events (capped at 10 to avoid bursts after OCR lag)
                for i in 0..new_shots.min(10) {
                    let is_hit = i < new_hits;
                    let is_kill = i < new_kills;
                    let ttk_ms = if is_kill { reading.ttk_secs.map(|t| t * 1000.0) } else { None };
                    let evt = ShotEvent {
                        hit: is_hit,
                        kill: is_kill,
                        timestamp_ms: ts_ms,
                        ttk_ms,
                        scenario_type: s.scenario_type.as_str().to_string(),
                        mouse_overshoot: overshoot,
                        mouse_correction_ratio: correction,
                        mouse_jitter: jitter,
                    };
                    let _ = app.emit(EVENT_SHOT, &evt);
                }

                // Feedback: miss with high overshoot
                if new_hits < new_shots {
                    let miss_count = new_shots - new_hits;
                    if overshoot > 0.40 {
                        emit_feedback(app, "miss_overshoot",
                            &format!("{} miss{} — overshoot detected, try to decelerate before clicking",
                                miss_count, if miss_count > 1 { "es" } else { "" }),
                            "warning", &mut s.cooldowns, 8);
                    }
                }
            }

            // ── Accuracy trend feedback ─────────────────────────────────────
            if let Some(trend) = accuracy_trend_value(&s.accuracy_history) {
                // Sustained 10-point drop over the last 30 s
                if trend < -10.0 {
                    let pct = reading.accuracy_pct.unwrap_or(0.0);
                    let msg = match s.scenario_type {
                        ScenarioType::PureTracking | ScenarioType::Unknown =>
                            format!("Accuracy falling to {pct:.0}% — refocus on smooth cursor control"),
                        ScenarioType::ReactiveClicking =>
                            format!("Accuracy {pct:.0}% dropping — slow your reaction, wait for target focus"),
                        _ =>
                            format!("Accuracy falling to {pct:.0}% — reset tempo and pre-aim better"),
                    };
                    emit_feedback(app, "accuracy_drop", &msg, "warning", &mut s.cooldowns, 15);
                }
            }

            // ── KPS/TTK trend feedback ──────────────────────────────────────
            let (ttk_avg, ttk_std, _) = ttk_stats(&s.ttk_history);
            if let (Some(avg), Some(std)) = (ttk_avg, ttk_std) {
                // TTK standard deviation > 40 % of mean → inconsistent
                if std > avg * 0.40 && s.ttk_history.len() > 10 {
                    let streak = s.streaks.entry("ttk_inconsistent").or_insert(0);
                    *streak += 1;
                    if *streak >= 5 {
                        let avg_ms = (avg * 1000.0) as u32;
                        let std_ms = (std * 1000.0) as u32;
                        emit_feedback(app, "ttk_inconsistent",
                            &format!("Inconsistent TTK ({avg_ms}ms avg \u{b1}{std_ms}ms) — work on pre-aim consistency"),
                            "tip", &mut s.cooldowns, 20);
                        *s.streaks.entry("ttk_inconsistent").or_insert(0) = 0;
                    }
                } else {
                    *s.streaks.entry("ttk_inconsistent").or_insert(0) = 0;
                }
            }
        } // end !suppress_feedback
    }

    // ── Scenario-specific positive feedback ────────────────────────────────
    if !suppress_feedback {
        scenario_positive_feedback(app, &reading, &mut *s);
    }

    // Emit stats-panel-update only when values changed (reduce frontend churn)
    let changed = last_emitted.as_ref().map_or(true, |prev| stats_changed(prev, &reading));
    if changed {
        let _ = app.emit(EVENT_STATS_PANEL, &reading);
        *last_emitted = Some(reading.clone());
    }

    s.prev = Some(reading);
}

// ─── Scenario type inference ───────────────────────────────────────────────────

/// Refines `s.scenario_type` based on accumulated evidence.
/// Called once per reading after the first few active ticks.
/// Classify a single tick's observations into a scenario-type vote.
///
/// Signals used (in priority order):
/// 1. `dmg_per_hit < 0.5`  → beam / continuous-fire weapon → Tracking
/// 2. `avg_hold_ms > 200`  → user holding LMB              → Tracking
/// 3. kills present + `avg_ttk < 0.18 s` (with history)    → ReactiveClicking
/// 4. kills present + `dmg_per_hit > 1.5`                   → MultiHitClicking
/// 5. kills present                                          → OneShotClicking
/// 6. accuracy only, no kills                               → AccuracyDrill
/// 7. otherwise                                             → Unknown (abstain)
fn cast_type_vote(
    r: &StatsPanelReading,
    avg_hold_ms: f32,
    avg_ttk: Option<f32>,
    ttk_len: usize,
) -> ScenarioType {
    let dmg_per_hit = match (r.damage_dealt, r.accuracy_hits) {
        (Some(dmg), Some(hits)) if hits > 0 => Some(dmg / hits as f64),
        _ => None,
    };

    let is_beam     = dmg_per_hit.map_or(false, |d| d < 0.5);
    let is_holding  = avg_hold_ms > 200.0;
    let has_kills   = r.kills.map_or(false, |k| k > 0);
    let has_acc     = r.accuracy_shots.is_some();

    if is_beam || is_holding {
        ScenarioType::PureTracking
    } else if has_kills {
        if avg_ttk.map_or(false, |t| t < 0.18) && ttk_len > 10 {
            ScenarioType::ReactiveClicking
        } else if dmg_per_hit.map_or(false, |d| d > 1.5) {
            ScenarioType::MultiHitClicking
        } else {
            ScenarioType::OneShotClicking
        }
    } else if has_acc {
        ScenarioType::AccuracyDrill
    } else {
        ScenarioType::Unknown
    }
}

/// Return the plurality winner from the vote window, ignoring `Unknown` abstentions.
/// Returns `Unknown` if fewer than 5 meaningful votes have been cast yet.
fn vote_plurality(window: &VecDeque<ScenarioType>) -> ScenarioType {
    let mut counts = [0u32; 6]; // 0=Unknown 1=Tracking 2=OneShot 3=MultiHit 4=Reactive 5=Accuracy
    let idx = |t: &ScenarioType| -> usize {
        match t {
            ScenarioType::Unknown         => 0,
            ScenarioType::PureTracking    => 1,
            ScenarioType::OneShotClicking => 2,
            ScenarioType::MultiHitClicking=> 3,
            ScenarioType::ReactiveClicking=> 4,
            ScenarioType::AccuracyDrill   => 5,
        }
    };
    for v in window {
        counts[idx(v)] += 1;
    }
    let total: u32 = counts[1..].iter().sum();
    if total < 5 { return ScenarioType::Unknown; }

    let (best, _) = counts[1..].iter().enumerate()
        .max_by_key(|(_, c)| *c)
        .unwrap();
    match best + 1 {
        1 => ScenarioType::PureTracking,
        2 => ScenarioType::OneShotClicking,
        3 => ScenarioType::MultiHitClicking,
        4 => ScenarioType::ReactiveClicking,
        5 => ScenarioType::AccuracyDrill,
        _ => ScenarioType::Unknown,
    }
}

/// Update `s.scenario_type` from aggregated per-tick votes.
///
/// Called once per OCR poll tick.  Casts one vote based on the current reading
/// and mouse-button behaviour, then picks the plurality winner from the last 20
/// votes so the type tracks live when a scenario alternates between target kinds.
fn update_scenario_type(s: &mut StatsState, r: &StatsPanelReading) {
    if r.spm.unwrap_or(0) > 0 {
        s.active_readings += 1;
    }

    let avg_hold_ms = crate::mouse_hook::get_latest_metrics()
        .map_or(0.0, |m| m.avg_hold_ms);
    let (avg_ttk, _, _) = ttk_stats(&s.ttk_history);
    let ttk_len = s.ttk_history.len();

    let vote = cast_type_vote(r, avg_hold_ms, avg_ttk, ttk_len);
    s.type_vote_window.push_back(vote);
    if s.type_vote_window.len() > 20 { s.type_vote_window.pop_front(); }

    s.scenario_type = vote_plurality(&s.type_vote_window);
}

// ─── Positive / streak feedback ────────────────────────────────────────────────

fn scenario_positive_feedback(
    app: &AppHandle,
    r: &StatsPanelReading,
    state: &mut StatsState,
) {
    let stype     = &state.scenario_type;
    let ttk_history = &state.ttk_history;
    let cooldowns = &mut state.cooldowns;
    let streaks   = &mut state.streaks;
    match stype {
        ScenarioType::PureTracking => {
            // High SPM streak for tracking
            if r.spm.unwrap_or(0) > 4000 {
                let s = streaks.entry("high_spm").or_insert(0);
                *s += 1;
                if *s >= 10 {
                    emit_feedback(app, "high_spm", "Excellent tracking — SPM consistently high", "positive", cooldowns, 20);
                    *s = 0;
                }
            } else {
                *streaks.entry("high_spm").or_insert(0) = 0;
            }
        }
        ScenarioType::OneShotClicking | ScenarioType::ReactiveClicking | ScenarioType::MultiHitClicking => {
            // Improving TTK trend
            let (avg, _, best) = ttk_stats(ttk_history);
            if let (Some(avg_ms), Some(best_ms)) = (avg.map(|t| t*1000.0), best.map(|t| t*1000.0)) {
                let s = streaks.entry("ttk_improving").or_insert(0);
                // Best TTK within 10% of average → very consistent
                if best_ms > avg_ms * 0.90 {
                    *s += 1;
                    if *s >= 5 {
                        emit_feedback(app, "ttk_improving",
                            &format!("Consistent TTK! Averaging {avg_ms:.0}ms — excellent aim control"),
                            "positive", cooldowns, 25);
                        *s = 0;
                    }
                } else {
                    *s = 0;
                }
            }

            // High accuracy streak
            if r.accuracy_pct.map_or(false, |p| p >= 75.0) {
                let s = streaks.entry("high_accuracy").or_insert(0);
                *s += 1;
                if *s >= 8 {
                    emit_feedback(app, "high_accuracy",
                        &format!("Accuracy above 75% — great shot selection"),
                        "positive", cooldowns, 30);
                    *s = 0;
                }
            } else {
                *streaks.entry("high_accuracy").or_insert(0) = 0;
            }
        }
        _ => {}
    }
}

// ─── Statistics helpers ────────────────────────────────────────────────────────

/// Detect and parse the two-column Windows OCR layout where all field labels
/// appear first ("Kill Count: KPS: Accuracy: … Avg TTK:") followed by all
/// values in the same order ("7 0.7 7/9 (77.8%) 7/9 (77.8%) 355 1.489s").
///
/// Detection: after the last `Label:` token the very next non-whitespace
/// character is an ASCII digit — there are no per-row values interspersed.
fn parse_column_layout(raw: &str) -> Option<StatsPanelReading> {
    // Known labels; longer/more-specific strings first to avoid partial matches.
    const LABELS: &[&str] = &["Kill Count", "Avg TTK", "Accuracy", "Damage", "KPS", "SPM"];

    // Collect (label, start_pos) for labels present in the text.
    let mut by_pos: Vec<(&str, usize)> = LABELS.iter()
        .filter_map(|&label| raw.find(label).map(|pos| (label, pos)))
        .collect();

    if by_pos.len() < 2 { return None; }

    // Sort by text position → preserves left-to-right display order.
    by_pos.sort_by_key(|&(_, pos)| pos);

    // Find the rightmost label end (just past the colon after the last label).
    let last_end = by_pos.iter()
        .map(|&(label, pos)| {
            let end = pos + label.len();
            // Skip optional trailing ':'
            if raw[end..].starts_with(':') { end + 1 } else { end }
        })
        .max()?;

    // Trim leading whitespace to reach the first value token.
    let value_section = raw[last_end..].trim_start();

    // Column layout: value block must begin with a digit or '-'.
    if !value_section.starts_with(|c: char| c.is_ascii_digit() || c == '-') {
        return None;
    }

    let tokens: Vec<&str> = value_section.split_whitespace().collect();
    let mut idx = 0;

    let mut kills: Option<u32> = None;
    let mut kps: Option<f32> = None;
    let mut acc_hits: Option<u32> = None;
    let mut acc_shots: Option<u32> = None;
    let mut acc_pct: Option<f32> = None;
    let mut dmg_dealt: Option<f64> = None;
    let mut dmg_total: Option<f64> = None;
    let mut spm: Option<u32> = None;
    let mut ttk: Option<f32> = None;

    for (label, _) in &by_pos {
        if idx >= tokens.len() { break; }
        let tok = tokens[idx];
        match *label {
            "Kill Count" => {
                // Kill count is a plain non-negative integer.
                // Valid tokens start with an ASCII digit and contain no '/' (that's
                // an Accuracy/Damage fraction) and no trailing 's' (that's TTK).
                // When KovaaK's shows "--" the OCR emits nothing, so we must NOT
                // consume the next field's token — just leave idx unchanged.
                if tok.starts_with(|c: char| c.is_ascii_digit())
                    && !tok.contains('/')
                    && !tok.ends_with('s')
                {
                    let n = normalise_ocr_digits(tok);
                    kills = n.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse().ok();
                    idx += 1;
                }
                // else: token belongs to a later field — do not advance idx.
            }
            "KPS" => {
                // KPS is a small float in [0, 20].
                // Reject fraction tokens (X/Y) and TTK tokens (ends with 's').
                if tok.starts_with(|c: char| c.is_ascii_digit())
                    && !tok.contains('/')
                    && !tok.ends_with('s')
                {
                    let v: Option<f32> = normalise_ocr_digits(tok).parse().ok();
                    // Only accept if in plausible KPS range; large integers here
                    // are SPM values that drifted up due to a missing kill count.
                    if v.map_or(false, |f| f <= 20.0) {
                        kps = v;
                    }
                    idx += 1;
                }
                // else: not a KPS token — leave idx unchanged.
            }
            "Accuracy" => {
                if let Some(slash) = tok.find('/') {
                    // Normal "X/Y" hits-over-shots token.
                    // Use digit-filter extraction so thousands-formatted values
                    // like "2,847" parse correctly (normalise turns , → . which
                    // would break direct .parse::<u32>()).
                    let hits_str = normalise_ocr_digits(&tok[..slash]);
                    let shots_str = normalise_ocr_digits(&tok[slash + 1..]);
                    acc_hits  = hits_str.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse().ok();
                    acc_shots = shots_str.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse().ok();
                    idx += 1;
                    // Optional "(nn.n%)" or "(nn.n" partial next token
                    if tokens.get(idx).map_or(false, |t| t.starts_with('(')) {
                        let pct_s: String = tokens[idx].chars()
                            .filter(|c| c.is_ascii_digit() || *c == '.').collect();
                        acc_pct = pct_s.parse().ok();
                        idx += 1;
                    }
                } else if tok.starts_with('(') {
                    // Standalone "(nn.n%)" — OCR missed the X/Y part
                    let pct_s: String = tok.chars()
                        .filter(|c| c.is_ascii_digit() || *c == '.').collect();
                    acc_pct = pct_s.parse().ok();
                    idx += 1;
                } else if tok.starts_with('-') {
                    idx += 1; // explicit "--" dash token
                }
                // else: unrecognised token — leave idx unchanged.
            }
            "Damage" => {
                if tok.starts_with('-') {
                    idx += 1;
                    // Skip a following "(--%)"-style token if present
                    if tokens.get(idx).map_or(false, |t| t.starts_with('(')) { idx += 1; }
                } else if let Some(slash) = tok.find('/') {
                    let dealt_str = normalise_ocr_digits(&tok[..slash]);
                    let total_str = normalise_ocr_digits(&tok[slash + 1..]);
                    dmg_dealt = dealt_str.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect::<String>().parse().ok();
                    dmg_total = total_str.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect::<String>().parse().ok();
                    idx += 1;
                    if tokens.get(idx).map_or(false, |t| t.starts_with('(')) { idx += 1; }
                } else if tok.starts_with('(') {
                    // Standalone percentage — already captured by Accuracy above usually,
                    // but consume it so SPM can get the right token next.
                    idx += 1;
                } else if tok.starts_with(|c: char| c.is_ascii_digit()) && !tok.ends_with('s') {
                    // Plain damage float (e.g. "71.0").
                    // Guard: after normalisation the value must be <= 100_000 to
                    // distinguish from a mis-aligned SPM integer (3 000–15 000).
                    // Note: normalise_ocr_digits turns ',' → '.' so "8,836" → 8.836 (fine),
                    // but a bare "8836" (no comma) → 8836 which we clamp out here.
                    let v: Option<f64> = normalise_ocr_digits(tok).parse().ok();
                    // Only treat as damage if it doesn't look like a plausible SPM
                    // (i.e. a comma-less integer >= 1000 is almost certainly mis-placed SPM).
                    let raw_digits_only = !tok.contains(',') && !tok.contains('.');
                    let big_int = raw_digits_only && v.map_or(false, |f| f >= 1_000.0);
                    if !big_int {
                        dmg_dealt = v;
                    }
                    idx += 1;
                }
                // else: ends with 's' (TTK token) — leave idx unchanged.
            }
            "SPM" => {
                // SPM is a large plain integer. Reject fraction tokens and TTK's 's' suffix.
                if tok.starts_with(|c: char| c.is_ascii_digit())
                    && !tok.contains('/')
                    && !tok.ends_with('s')
                {
                    let n = normalise_ocr_digits(tok);
                    // Extract only digits (comma was already converted to dot, throwaway dot):
                    spm = n.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse().ok();
                    idx += 1;
                }
                // else: leave idx unchanged.
            }
            "Avg TTK" => {
                // TTK ends with 's' (e.g. "1.489s") or is a plain float.
                // Reject fraction tokens.
                if !tok.contains('/') {
                    let n = normalise_ocr_digits(tok);
                    if !n.starts_with('-') {
                        ttk = n.trim_end_matches('s').parse().ok();
                    }
                    idx += 1;
                }
                // else: leave idx unchanged.
            }
            _ => {}
        }
    }

    Some(StatsPanelReading {
        session_time_secs: None, // filled in by caller
        kills,
        kps,
        accuracy_hits: acc_hits,
        accuracy_shots: acc_shots,
        accuracy_pct: acc_pct,
        damage_dealt: dmg_dealt,
        damage_total: dmg_total,
        spm,
        ttk_secs: ttk,
        scenario_type: String::new(),
    })
}

/// Replace common OCR confusables in a **value** token only.
fn normalise_ocr_digits(s: &str) -> String {
    s.replace('O', "0").replace('o', "0").replace(['l', 'I'], "1").replace(',', ".")
}

/// Core value-extraction helper.
///
/// Finds `label` in the raw text, skips any `:` separator, then scans forward
/// (up to 8 whitespace tokens or 120 chars) looking for the first token that
/// looks like a number.  Stops early at the next field label (i.e. any token
/// that ends with `:`).
///
/// This handles both row-by-row OCR output ("Kill Count: 29\n") and
/// column-layout output where labels and values are in separate blocks.
/// In column-layout mode the scan will cross lines searching for the value,
/// but stops when it reaches the next `Word:` token.
fn find_value_after_label<'a>(raw: &'a str, label: &str) -> Option<&'a str> {
    let pos = raw.find(label)?;
    let rest = &raw[pos + label.len()..];
    // Strip the colon separator and any leading whitespace
    let rest = rest.trim_start_matches(|c: char| c == ':' || c.is_whitespace());
    Some(rest)
}

/// Walk tokens from `rest`, stopping at the next "Label:" token.
/// Returns (first_numeric_token, is_placeholder) where is_placeholder means "--".
fn first_numeric_or_placeholder(rest: &str) -> Option<Result<String, ()>> {
    for tok in rest.split_whitespace().take(8) {
        // Stop when we hit the next field label ("SPM:", "KPS:", …)
        if tok.ends_with(':') && tok.len() > 1 { return None; }
        // Placeholder → explicit None-signal
        if tok.starts_with("--") { return Some(Err(())); }
        let norm = normalise_ocr_digits(tok);
        let fc = norm.chars().next()?;
        if fc.is_ascii_digit() || fc == '.' {
            return Some(Ok(norm));
        }
    }
    None
}

fn parse_uint_after(raw: &str, labels: &[&str]) -> Option<u32> {
    for &label in labels {
        let rest = find_value_after_label(raw, label)?;
        match first_numeric_or_placeholder(rest)? {
            Err(_) => return None, // "--" → None
            Ok(tok) => {
                let digits: String = tok.chars().filter(|c| c.is_ascii_digit()).collect();
                if let Ok(v) = digits.parse::<u32>() { return Some(v); }
            }
        }
    }
    None
}

fn parse_float_after(raw: &str, labels: &[&str]) -> Option<f32> {
    for &label in labels {
        let rest = find_value_after_label(raw, label)?;
        match first_numeric_or_placeholder(rest)? {
            Err(_) => return None,
            Ok(tok) => {
                if let Ok(v) = tok.parse::<f32>() { return Some(v); }
            }
        }
    }
    None
}

/// Parse "HH:MM:SS" or "MM:SS" session timer → total seconds.
fn parse_session_time(raw: &str) -> Option<u32> {
    for word in raw.split_whitespace() {
        let parts: Vec<&str> = word.split(':').collect();
        match parts.as_slice() {
            [m, s] => {
                if let (Ok(mm), Ok(ss)) = (m.parse::<u32>(), s.parse::<u32>()) {
                    return Some(mm * 60 + ss);
                }
            }
            [h, m, s] => {
                if let (Ok(hh), Ok(mm), Ok(ss)) = (h.parse::<u32>(), m.parse::<u32>(), s.parse::<u32>()) {
                    return Some(hh * 3600 + mm * 60 + ss);
                }
            }
            _ => {}
        }
    }
    None
}

/// Parse "Accuracy:  289/435 (66.4%)" → hits (289)
fn parse_accuracy_hits(raw: &str) -> Option<u32> {
    let pos = raw.find("Accuracy")?;
    let after = &raw[pos..];
    let slash_pos = after.find('/')?;
    let before = &after[..slash_pos];
    let tok = before.split_whitespace().last()?;
    let norm = normalise_ocr_digits(tok);
    let digits: String = norm.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() { None } else { digits.parse().ok() }
}

/// Parse "Accuracy:  289/435 (66.4%)" → shots (435)
fn parse_accuracy_shots(raw: &str) -> Option<u32> {
    let pos = raw.find("Accuracy")?;
    let after = &raw[pos..];
    let slash_pos = after.find('/')?;
    let rest = &after[slash_pos + 1..];
    let digits: String = normalise_ocr_digits(rest)
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() { None } else { digits.parse().ok() }
}

/// Parse accuracy percentage from "(66.4%)"
fn parse_accuracy_pct(raw: &str) -> Option<f32> {
    let pos = raw.find("Accuracy")?;
    let after = &raw[pos..];
    let paren = after.find('(')?;
    let rest = &after[paren + 1..];
    let norm = normalise_ocr_digits(rest);
    let pct_str: String = norm.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    if pct_str.is_empty() { None } else { pct_str.parse().ok() }
}

/// Parse damage dealt — handles both "1234/5000" and "29 / 37 (78.4%)" formats
fn parse_damage_dealt(raw: &str) -> Option<f64> {
    let pos = raw.find("Damage")?;
    let after = &raw[pos + 6..];
    // Find the slash
    let slash = after.find('/')?;
    let before = &after[..slash];
    let tok = before.split_whitespace().last()?;
    if tok.starts_with('-') { return None; }
    let norm = normalise_ocr_digits(tok);
    let digits: String = norm.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    if digits.is_empty() { None } else { digits.parse().ok() }
}

/// Parse damage total (denominator)
fn parse_damage_total(raw: &str) -> Option<f64> {
    let pos = raw.find("Damage")?;
    let after = &raw[pos + 6..];
    let slash = after.find('/')?;
    let rest = &after[slash + 1..];
    let norm = normalise_ocr_digits(rest);
    let digits: String = norm.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    if digits.is_empty() { None } else { digits.parse().ok() }
}

/// Parse "Avg TTK:  0.218s" or "Avg TTK  0.218s" → seconds
fn parse_ttk(raw: &str) -> Option<f32> {
    let pos = raw.find("TTK")?;
    let rest = &raw[pos + 3..];
    // Strip colon and leading whitespace
    let rest = rest.trim_start_matches(|c: char| c == ':' || c.is_whitespace());
    let tok = rest.split_whitespace().next()?;
    if tok.starts_with('-') { return None; }
    let norm = normalise_ocr_digits(tok);
    norm.trim_end_matches('s').parse().ok()
}

// ─── Statistics helpers ────────────────────────────────────────────────────────

fn ttk_stats(history: &VecDeque<(f32, Instant)>) -> (Option<f32>, Option<f32>, Option<f32>) {
    if history.is_empty() { return (None, None, None); }
    let values: Vec<f32> = history.iter().map(|(t, _)| *t).collect();
    let n = values.len() as f32;
    let mean = values.iter().sum::<f32>() / n;
    let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / n;
    let std = variance.sqrt();
    let best = values.iter().cloned().fold(f32::MAX, f32::min);
    (Some(mean), Some(std), Some(best))
}

/// Returns accuracy% change: recent(last 30s) minus earlier(30–60s ago).
/// Positive = improving, negative = declining.
fn accuracy_trend_value(history: &VecDeque<(f32, Instant)>) -> Option<f32> {
    if history.len() < 60 { return None; }
    let now = Instant::now();
    let window = Duration::from_secs(30);

    let recent: Vec<f32> = history.iter()
        .filter(|(_, t)| now.duration_since(*t) < window)
        .map(|(p, _)| *p).collect();
    let earlier: Vec<f32> = history.iter()
        .filter(|(_, t)| {
            let age = now.duration_since(*t);
            age >= window && age < window * 2
        })
        .map(|(p, _)| *p).collect();

    if recent.is_empty() || earlier.is_empty() { return None; }
    let avg = |v: &[f32]| v.iter().sum::<f32>() / v.len() as f32;
    Some(avg(&recent) - avg(&earlier))
}

// ─── Stats-changed check ───────────────────────────────────────────────────────

fn stats_changed(prev: &StatsPanelReading, curr: &StatsPanelReading) -> bool {
    prev.kills != curr.kills
        || prev.accuracy_shots != curr.accuracy_shots
        || prev.spm != curr.spm
        || prev.ttk_secs != curr.ttk_secs
        || prev.kps != curr.kps
        || prev.session_time_secs != curr.session_time_secs
}

// ─── Feedback helper ───────────────────────────────────────────────────────────

fn emit_feedback(
    app: &AppHandle,
    key: &'static str,
    msg: &str,
    kind: &str,
    cooldowns: &mut std::collections::HashMap<&'static str, u32>,
    cooldown_secs: u32,
) {
    if *cooldowns.get(key).unwrap_or(&0) > 0 { return; }
    let _ = app.emit(crate::mouse_hook::EVENT_LIVE_FEEDBACK, crate::mouse_hook::LiveFeedback {
        message: msg.to_string(),
        kind: kind.to_string(),
        metric: key.to_string(),
    });
    // Approximate: each tick = POLL_MS ≈ 100ms, so multiply seconds by 10
    cooldowns.insert(key, cooldown_secs * 10);
}

