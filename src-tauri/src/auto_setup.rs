//! Background auto-setup loop and full-screen OCR region detection.
//!
//! This module owns:
//! - The polling loop that continuously scans the screen for KovaaK's stats
//!   panel text (`auto_setup_loop`), emitting progress/complete events.
//! - Per-field OCR label/value detection (`detect_field_regions_from_words`).
//! - Scenario name detection via fuzzy match against the local index
//!   (`detect_scenario_region_from_words`).
//! - The Tauri commands that start/stop the loop and allow user confirmation
//!   or rejection of individual detected regions.

use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

use crate::{ocr, scenario_index, settings};

// ─── Global auto-setup state ──────────────────────────────────────────────────

pub static AUTO_SETUP_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Queued user-driven force-confirms: field keys pushed from the UI.
static FORCE_CONFIRM: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Queued user-driven force-rejects: field keys pushed from the UI.
static FORCE_REJECT: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub const EVENT_AUTO_SETUP_PROGRESS: &str = "auto-setup-progress";
pub const EVENT_AUTO_SETUP_COMPLETE: &str = "auto-setup-complete";

// ─── Event payloads ───────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct AutoSetupProgress {
    pub confirmed:  Vec<String>,
    pub candidates: std::collections::HashMap<String, settings::RegionRect>,
    pub total:      usize,
}

#[derive(serde::Serialize, Clone)]
pub struct AutoSetupComplete {
    pub regions:         settings::StatsFieldRegions,
    pub scenario_region: Option<settings::RegionRect>,
    pub confirmed_count: usize,
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Start the background auto-setup loop.
#[tauri::command]
pub fn start_auto_setup(
    state: tauri::State<crate::AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if AUTO_SETUP_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(()); // already running
    }
    let monitor_index = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        s.monitor_index
    };
    let monitor_rect = resolve_monitor_rect(&app, monitor_index)?;
    let app_clone = app.clone();
    std::thread::Builder::new()
        .name("auto-setup".into())
        .spawn(move || auto_setup_loop(app_clone, monitor_rect))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Stop the background auto-setup loop.
#[tauri::command]
pub fn stop_auto_setup() {
    AUTO_SETUP_RUNNING.store(false, Ordering::SeqCst);
}

/// Immediately promote a candidate field to "confirmed".
#[tauri::command]
pub fn force_confirm_field(field: String) {
    if let Ok(mut q) = FORCE_CONFIRM.lock() {
        q.push(field);
    }
}

/// Clear the candidate for a field so detection restarts fresh.
#[tauri::command]
pub fn force_reject_field(field: String) {
    if let Ok(mut q) = FORCE_REJECT.lock() {
        q.push(field);
    }
}

/// One-shot detection: capture the monitor and return whatever field regions
/// can be found in the current frame.
#[tauri::command]
pub fn auto_detect_stats_regions(
    state: tauri::State<crate::AppState>,
    app: AppHandle,
) -> Result<settings::StatsFieldRegions, String> {
    let monitor_index = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        s.monitor_index
    };
    let monitor_rect = resolve_monitor_rect(&app, monitor_index)?;
    log::info!(
        "auto_detect: capturing monitor {} at ({},{}) {}×{}",
        monitor_index, monitor_rect.x, monitor_rect.y,
        monitor_rect.width, monitor_rect.height,
    );
    let words = ocr::capture_screen_words(&monitor_rect).map_err(|e| e.to_string())?;
    log::info!("auto_detect: OCR returned {} words", words.len());
    Ok(detect_field_regions_from_words(&words, &monitor_rect))
}

// ─── Background loop ──────────────────────────────────────────────────────────

fn auto_setup_loop(app: AppHandle, monitor_rect: settings::RegionRect) {
    use std::collections::HashMap;
    use std::time::Duration;

    const POLL_INTERVAL:      Duration = Duration::from_millis(1500);
    const CONFIRM_THRESHOLD:  u32      = 3;
    // Tolerance for bounding-box stability check.  25 px handles minor
    // frame-to-frame jitter from anti-aliasing / sub-pixel text rendering
    // while still rejecting a genuinely different detection position.
    const TOLERANCE:          i32      = 25;
    const TOTAL:              usize    = 7;
    // Only stats fields are *required* for completion; scenario is tracked
    // and shown in the UI but does not block the loop from finishing.
    const REQUIRED_FIELDS: &[&str] = &["kills", "kps", "accuracy", "damage", "ttk", "spm"];

    struct Candidate {
        rect:        settings::RegionRect,
        consecutive: u32,
    }

    let field_keys: [&str; TOTAL] = ["kills", "kps", "accuracy", "damage", "ttk", "spm", "scenario"];
    let mut candidates:       HashMap<&str, Candidate>              = HashMap::new();
    let mut confirmed_set:    std::collections::HashSet<&str>       = std::collections::HashSet::new();
    let mut confirmed_regions = settings::StatsFieldRegions::default();
    let mut confirmed_scenario: Option<settings::RegionRect>        = None;

    log::info!(
        "auto-setup: started — monitor ({},{}) {}×{}",
        monitor_rect.x, monitor_rect.y, monitor_rect.width, monitor_rect.height,
    );

    while AUTO_SETUP_RUNNING.load(Ordering::SeqCst) {
        std::thread::sleep(POLL_INTERVAL);
        if !AUTO_SETUP_RUNNING.load(Ordering::SeqCst) { break; }

        // ── Drain user confirm / reject actions ───────────────────────────────
        let to_confirm = FORCE_CONFIRM.lock()
            .map(|mut q| std::mem::take(&mut *q)).unwrap_or_default();
        let to_reject = FORCE_REJECT.lock()
            .map(|mut q| std::mem::take(&mut *q)).unwrap_or_default();

        for field_str in &to_confirm {
            let key = field_keys.iter().copied().find(|&k| k == field_str.as_str());
            if let Some(key) = key {
                if !confirmed_set.contains(key) {
                    if let Some(cand) = candidates.get(key) {
                        let r = cand.rect;
                        log::info!(
                            "auto-setup: force-confirmed '{}' by user ({},{}) {}×{}",
                            key, r.x, r.y, r.width, r.height,
                        );
                        confirmed_set.insert(key);
                        apply_confirmed_field(
                            key, r,
                            &mut confirmed_regions,
                            &mut confirmed_scenario,
                        );
                    }
                }
            }
        }
        for field_str in &to_reject {
            let key = field_keys.iter().copied().find(|&k| k == field_str.as_str());
            if let Some(key) = key {
                if !confirmed_set.contains(key) {
                    log::info!("auto-setup: user rejected '{}' — resetting candidate", key);
                    candidates.remove(key);
                }
            }
        }

        // ── OCR + detection ───────────────────────────────────────────────────
        let words = ocr::capture_screen_words(&monitor_rect).unwrap_or_else(|e| {
            log::debug!("auto-setup: capture failed: {e}");
            vec![]
        });
        log::debug!("auto-setup: OCR returned {} words", words.len());
        if log::log_enabled!(log::Level::Trace) {
            for w in words.iter().take(40) {
                log::trace!("auto-setup: word {:?} at ({},{}) {}×{}", w.text, w.x, w.y, w.width, w.height);
            }
        }

        let detected          = detect_field_regions_from_words(&words, &monitor_rect);
        let detected_scenario = detect_scenario_region_from_words(&words, &monitor_rect);

        let detected_per: [(&str, Option<settings::RegionRect>); TOTAL] = [
            ("kills",    detected.kills),
            ("kps",      detected.kps),
            ("accuracy", detected.accuracy),
            ("damage",   detected.damage),
            ("ttk",      detected.ttk),
            ("spm",      detected.spm),
            ("scenario", detected_scenario),
        ];

        for (field, maybe_rect) in detected_per {
            if confirmed_set.contains(field) { continue; }
            if let Some(rect) = maybe_rect {
                let newly_confirmed = match candidates.get(field) {
                    None => {
                        candidates.insert(field, Candidate { rect, consecutive: 1 });
                        false
                    }
                    Some(c) if rects_close(&c.rect, &rect, TOLERANCE) => {
                        let n = c.consecutive + 1;
                        candidates.insert(field, Candidate { rect: c.rect, consecutive: n });
                        n >= CONFIRM_THRESHOLD
                    }
                    _ => {
                        candidates.insert(field, Candidate { rect, consecutive: 1 });
                        false
                    }
                };
                if newly_confirmed {
                    let r = candidates[field].rect;
                    log::info!("auto-setup: confirmed {} ({},{}) {}×{}", field, r.x, r.y, r.width, r.height);
                    confirmed_set.insert(field);
                    apply_confirmed_field(
                        field, r,
                        &mut confirmed_regions,
                        &mut confirmed_scenario,
                    );
                }
            }
        }

        // ── Emit progress ─────────────────────────────────────────────────────
        let confirmed_list: Vec<String> =
            field_keys.iter().filter(|&&k| confirmed_set.contains(k)).map(|s| s.to_string()).collect();
        let candidates_snapshot: std::collections::HashMap<String, settings::RegionRect> =
            candidates.iter()
                .filter(|&(k, _)| !confirmed_set.contains(k))
                .map(|(&k, v)| (k.to_string(), v.rect))
                .collect();
        let _ = app.emit(EVENT_AUTO_SETUP_PROGRESS, AutoSetupProgress {
            confirmed:  confirmed_list,
            candidates: candidates_snapshot,
            // Use the required count as total so the frontend progress bar
            // fills to 100% when all required fields are confirmed (scenario
            // is a bonus tracked separately).
            total: REQUIRED_FIELDS.len(),
        });

        if REQUIRED_FIELDS.iter().all(|&f| confirmed_set.contains(f)) {
            log::info!("auto-setup: all required fields confirmed — saving");
            AUTO_SETUP_RUNNING.store(false, Ordering::SeqCst);
            let _ = app.emit(EVENT_AUTO_SETUP_COMPLETE, AutoSetupComplete {
                regions:         confirmed_regions,
                scenario_region: confirmed_scenario,
                confirmed_count: confirmed_set.len(),
            });
            break;
        }
    }
    log::info!("auto-setup: stopped ({}/{} confirmed)", confirmed_set.len(), TOTAL);
}

/// Write a newly-confirmed field into the appropriate output slot.
fn apply_confirmed_field(
    field:      &str,
    rect:       settings::RegionRect,
    regions:    &mut settings::StatsFieldRegions,
    scenario:   &mut Option<settings::RegionRect>,
) {
    match field {
        "kills"    => regions.kills    = Some(rect),
        "kps"      => regions.kps      = Some(rect),
        "accuracy" => regions.accuracy = Some(rect),
        "damage"   => regions.damage   = Some(rect),
        "ttk"      => regions.ttk      = Some(rect),
        "spm"      => regions.spm      = Some(rect),
        "scenario" => *scenario        = Some(rect),
        _          => {}
    }
}

// ─── Monitor helpers ──────────────────────────────────────────────────────────

/// Returns the physical screen rectangle for the given monitor index.
pub fn resolve_monitor_rect(app: &AppHandle, monitor_index: usize) -> Result<settings::RegionRect, String> {
    let win = app
        .get_webview_window("overlay")
        .ok_or_else(|| "overlay window not found".to_string())?;
    let monitors = win.available_monitors().map_err(|e| e.to_string())?;
    let m = monitors
        .get(monitor_index)
        .or_else(|| monitors.first())
        .ok_or_else(|| "no monitors found".to_string())?;
    let pos  = m.position();
    let size = m.size();
    Ok(settings::RegionRect { x: pos.x, y: pos.y, width: size.width, height: size.height })
}

fn rects_close(a: &settings::RegionRect, b: &settings::RegionRect, tolerance: i32) -> bool {
    (a.x - b.x).abs()                          <= tolerance
        && (a.y - b.y).abs()                   <= tolerance
        && (a.width  as i32 - b.width  as i32).abs() <= tolerance
        && (a.height as i32 - b.height as i32).abs() <= tolerance
}

// ─── OCR helpers ──────────────────────────────────────────────────────────────

/// Axis-aligned bounding box in capture-image pixel coordinates.
#[derive(Clone, Debug)]
struct BBox {
    x:      i32,
    y:      i32,
    width:  u32,
    height: u32,
}

impl BBox {
    fn right(&self)    -> i32 { self.x + self.width  as i32 }
    fn centre_y(&self) -> i32 { self.y + self.height as i32 / 2 }

    fn union(&self, other: &BBox) -> BBox {
        let x1 = self.x.min(other.x);
        let y1 = self.y.min(other.y);
        let x2 = self.right().max(other.right());
        let y2 = (self.y + self.height as i32).max(other.y + other.height as i32);
        BBox { x: x1, y: y1, width: (x2 - x1) as u32, height: (y2 - y1) as u32 }
    }
}

fn word_to_bbox(w: &ocr::OcrWordResult) -> BBox {
    BBox { x: w.x, y: w.y, width: w.width, height: w.height }
}

fn strip_label_punctuation(s: &str) -> &str {
    s.trim_end_matches(|c: char| !c.is_alphanumeric())
}

fn find_label_in_words(words: &[ocr::OcrWordResult], tokens: &[&str]) -> Option<BBox> {
    if tokens.is_empty() || words.is_empty() { return None; }
    'outer: for start in 0..words.len() {
        if !strip_label_punctuation(&words[start].text).eq_ignore_ascii_case(tokens[0]) {
            continue;
        }
        let mut bbox = word_to_bbox(&words[start]);
        let row_cy   = bbox.centre_y();
        for (ti, &tok) in tokens.iter().enumerate().skip(1) {
            let mut found = false;
            let end = (start + ti + 5).min(words.len());
            for wi in (start + ti)..end {
                let cand = &words[wi];
                if strip_label_punctuation(&cand.text).eq_ignore_ascii_case(tok)
                    && (word_to_bbox(cand).centre_y() - row_cy).abs() < 20
                {
                    bbox = bbox.union(&word_to_bbox(cand));
                    found = true;
                    break;
                }
            }
            if !found { continue 'outer; }
        }
        return Some(bbox);
    }
    None
}

fn find_value_box(words: &[ocr::OcrWordResult], label_box: &BBox) -> Option<BBox> {
    let row_cy        = label_box.centre_y();
    let row_tolerance = (label_box.height as i32).max(14);
    let max_right_x   = label_box.right() + 200;

    let mut result: Option<BBox> = None;
    for w in words {
        let wb = word_to_bbox(w);
        if wb.x < label_box.right() - 4 { continue; }
        if wb.x > max_right_x           { continue; }
        if (wb.centre_y() - row_cy).abs() > row_tolerance { continue; }
        if !w.text.chars().any(|c| c.is_ascii_digit()) { continue; }
        result = Some(match result { Some(acc) => acc.union(&wb), None => wb });
    }
    result
}

// ─── Scene detection ──────────────────────────────────────────────────────────

/// Detect the scenario name region by fuzzy-matching groups of consecutive OCR
/// words against the local scenario index.
///
/// Scenario names have no fixed on-screen label — they can appear anywhere.
/// We try every 2–5 consecutive word N-gram on the same row and accept the first
/// phrase that `scenario_index::fuzzy_match` recognises.
fn detect_scenario_region_from_words(
    words:        &[ocr::OcrWordResult],
    capture_rect: &settings::RegionRect,
) -> Option<settings::RegionRect> {
    if scenario_index::len() == 0 {
        log::debug!("auto_detect: scenario_index empty — skipping scenario detection");
        return None;
    }

    let mut sorted: Vec<&ocr::OcrWordResult> = words.iter().collect();
    sorted.sort_by_key(|w| (w.y, w.x));

    const PAD:       i32   = 4;
    const MAX_WORDS: usize = 5;
    let n = sorted.len();

    for start in 0..n {
        let base_cy   = sorted[start].y + sorted[start].height as i32 / 2;
        let mut phrase      = String::new();
        let mut phrase_bbox: Option<BBox> = None;

        for end in start..n.min(start + MAX_WORDS) {
            let w  = sorted[end];
            let cy = w.y + w.height as i32 / 2;
            if (cy - base_cy).abs() > 14 { break; }

            if !phrase.is_empty() { phrase.push(' '); }
            phrase.push_str(&w.text);
            let wb = word_to_bbox(w);
            phrase_bbox = Some(match phrase_bbox {
                Some(acc) => acc.union(&wb),
                None      => wb,
            });

            if end == start { continue; } // skip 1-grams

            if scenario_index::fuzzy_match(&phrase).is_some() {
                let bb = phrase_bbox.unwrap();
                log::info!(
                    "auto_detect: scenario {:?} → ({},{}) {}×{}",
                    phrase, bb.x, bb.y, bb.width, bb.height,
                );
                return Some(settings::RegionRect {
                    x:      capture_rect.x + (bb.x - PAD).max(0),
                    y:      capture_rect.y + (bb.y - PAD).max(0),
                    width:  (bb.width  as i32 + PAD * 2) as u32,
                    height: (bb.height as i32 + PAD * 2) as u32,
                });
            }
        }
    }
    None
}

// ─── Stats panel field detection ──────────────────────────────────────────────

/// Match OCR words against all known KovaaK's stats panel labels and return
/// absolute `RegionRect`s for each found field.
pub fn detect_field_regions_from_words(
    words:        &[ocr::OcrWordResult],
    capture_rect: &settings::RegionRect,
) -> settings::StatsFieldRegions {
    const LABELS: &[(&str, &[&[&str]])] = &[
        ("kills",    &[&["Kill", "Count"], &["Kills"], &["Kill"]]),
        ("kps",      &[&["KPS"], &["K/s"], &["Kills/s"], &["k/s"]]),
        ("accuracy", &[&["Accuracy"], &["Acc"]]),
        ("damage",   &[&["Damage"], &["Damage", "Dealt"], &["Dmg"]]),
        ("ttk",      &[&["Avg", "TTK"], &["TTK"], &["Avg", "Time"]]),
        ("spm",      &[&["SPM"], &["Score/Min"], &["Score/min"]]),
    ];

    if log::log_enabled!(log::Level::Debug) && !words.is_empty() {
        let sample: Vec<&str> = words.iter().take(30).map(|w| w.text.as_str()).collect();
        log::debug!("auto_detect: {} words, first 30: {:?}", words.len(), sample);
    } else if words.is_empty() {
        log::debug!("auto_detect: OCR returned 0 words — is KovaaK's visible and running?");
    }

    let mut out = settings::StatsFieldRegions::default();
    const PAD:        i32 = 4;
    const EXTRA_LEFT: i32 = 30;
    const MIN_VAL_W:  i32 = 72;

    let mut field_candidates: Vec<(&str, BBox)> = Vec::new();

    for &(field, alternatives) in LABELS {
        let mut found_label: Option<BBox> = None;
        for &tokens in alternatives {
            if let Some(lb) = find_label_in_words(words, tokens) {
                found_label = Some(lb);
                break;
            }
        }
        let Some(label_box) = found_label else {
            log::debug!("auto_detect: label for '{}' not found", field);
            continue;
        };
        let Some(val_box) = find_value_box(words, &label_box) else {
            log::debug!("auto_detect: value for '{}' not found", field);
            continue;
        };
        field_candidates.push((field, val_box));
    }

    // Same-row filter: drop values whose centre_y is far from the consensus row.
    if field_candidates.len() >= 3 {
        let mut cys: Vec<i32> = field_candidates.iter().map(|(_, vb)| vb.centre_y()).collect();
        cys.sort_unstable();
        let median_cy = cys[cys.len() / 2];
        let before    = field_candidates.len();
        field_candidates.retain(|(field, vb)| {
            let ok = (vb.centre_y() - median_cy).abs() <= 40;
            if !ok {
                log::debug!(
                    "auto_detect: dropping '{}' — value cy={} too far from median={}",
                    field, vb.centre_y(), median_cy,
                );
            }
            ok
        });
        if field_candidates.len() < before {
            log::info!(
                "auto_detect: same-row filter dropped {} suspect field(s)",
                before - field_candidates.len()
            );
        }
    }

    for (field, val_box) in field_candidates {
        let w       = (val_box.width as i32 + EXTRA_LEFT).max(MIN_VAL_W);
        let h       = val_box.height as i32 + PAD * 2;
        // Anchor at the right edge; extra width extends left (values are right-aligned).
        let right_px = val_box.x + val_box.width as i32 + PAD;
        let left_px  = (right_px - w - PAD).max(0);

        let r = settings::RegionRect {
            x:      capture_rect.x + left_px,
            y:      capture_rect.y + (val_box.y - PAD).max(0),
            width:  (right_px - left_px) as u32,
            height: h as u32,
        };
        log::info!("auto_detect: {} → ({},{}) {}×{}", field, r.x, r.y, r.width, r.height);
        match field {
            "kills"    => out.kills    = Some(r),
            "kps"      => out.kps      = Some(r),
            "accuracy" => out.accuracy = Some(r),
            "damage"   => out.damage   = Some(r),
            "ttk"      => out.ttk      = Some(r),
            "spm"      => out.spm      = Some(r),
            _          => {}
        }
    }
    out
}
