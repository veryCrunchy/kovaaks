/// File watcher module: watches the KovaaK's stats directory for new CSV files.
///
/// When a new file is detected, it's parsed and a `session-complete` event is emitted.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const EVENT_SESSION_COMPLETE: &str = "session-complete";

// ─── Session result ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResult {
    pub scenario: String,
    pub score: f64,
    pub accuracy: f64,
    pub kills: u32,
    pub deaths: u32,
    pub duration_secs: f64,
    pub avg_ttk: f64,
    pub damage_done: f64,
    pub timestamp: String,
    pub csv_path: String,
}

// ─── Watcher state ─────────────────────────────────────────────────────────────

static WATCHER: Lazy<Mutex<Option<RecommendedWatcher>>> = Lazy::new(|| Mutex::new(None));
/// Tracks the last time each stats CSV path was fully processed so duplicate
/// fs-events (Create then Modify for the same file) are silently ignored.
/// The same file must not be reprocessed within 10 seconds.
static PROCESSED: Lazy<Mutex<HashMap<PathBuf, Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const DEDUP_WINDOW: Duration = Duration::from_secs(10);
// ─── Public API ────────────────────────────────────────────────────────────────

pub fn start(app: AppHandle, stats_dir: &str) {
    let path = PathBuf::from(stats_dir);
    if !path.exists() {
        log::warn!("Stats dir does not exist: {stats_dir}");
        // Still set up the watcher — it will log errors until the dir exists
    }

    let watcher = build_watcher(app, path.clone());
    match watcher {
        Ok(w) => {
            let mut guard = WATCHER.lock().unwrap();
            *guard = Some(w);
            log::info!("File watcher started on: {stats_dir}");
        }
        Err(e) => {
            log::error!("Failed to start file watcher: {e}");
        }
    }
}

pub fn restart(app: &AppHandle, stats_dir: &str) {
    // Drop old watcher
    {
        let mut guard = WATCHER.lock().unwrap();
        *guard = None;
    }
    start(app.clone(), stats_dir);
}

// ─── Watcher setup ─────────────────────────────────────────────────────────────

fn build_watcher(app: AppHandle, path: PathBuf) -> notify::Result<RecommendedWatcher> {
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<Event>| {
            if let Ok(event) = result {
                handle_fs_event(&app, &event);
            }
        },
        Config::default().with_poll_interval(Duration::from_secs(1)),
    )?;

    // Watch even if dir doesn't exist yet — it will become active when created
    if path.exists() {
        watcher.watch(&path, RecursiveMode::NonRecursive)?;
    }

    Ok(watcher)
}

fn handle_fs_event(app: &AppHandle, event: &Event) {
    match &event.kind {
        EventKind::Create(_) | EventKind::Modify(_) => {
            for path in &event.paths {
                if path.extension().and_then(|e| e.to_str()) == Some("csv") {
                    // ── Deduplication ─────────────────────────────────────────
                    // notify fires both Create and Modify (and sometimes two
                    // Modify events) for the same file within milliseconds.
                    // Only the first event within DEDUP_WINDOW is processed.
                    let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
                    {
                        let mut seen = PROCESSED.lock().unwrap();
                        // Evict stale entries to keep the map small.
                        seen.retain(|_, t| t.elapsed() < DEDUP_WINDOW);
                        if let Some(prev) = seen.get(&canonical) {
                            if prev.elapsed() < DEDUP_WINDOW {
                                log::debug!("Skipping duplicate fs-event for {}", path.display());
                                continue;
                            }
                        }
                        seen.insert(canonical, Instant::now());
                    }
                    log::info!("New stats file detected: {}", path.display());
                    // Small delay to ensure the game has finished writing
                    std::thread::sleep(Duration::from_millis(500));
                    match parse_csv(path) {
                        Ok(result) => {
                            log::info!("Session complete: {} score={}", result.scenario, result.score);
                            // Capture smoothness summary BEFORE stopping tracking (clears buffer)
                            let smoothness = crate::mouse_hook::session_summary();
                            // Capture stats-panel snapshot before deactivating
                            let stats_panel = crate::stats_ocr::get_snapshot();
                            // Stop smoothness tracking and reset OCR session state
                            crate::mouse_hook::stop_session_tracking();
                            crate::stats_ocr::set_active(false);
                            crate::ocr::reset_session();
                            // Persist to session history
                            let record = crate::session_store::SessionRecord {
                                id: format!(
                                    "{}-{}",
                                    result.scenario.to_lowercase().replace(' ', "_"),
                                    result.timestamp
                                ),
                                scenario: result.scenario.clone(),
                                score: result.score,
                                accuracy: result.accuracy,
                                kills: result.kills,
                                deaths: result.deaths,
                                duration_secs: result.duration_secs,
                                avg_ttk: result.avg_ttk,
                                damage_done: result.damage_done,
                                timestamp: result.timestamp.clone(),
                                smoothness,
                                stats_panel,
                            };
                            crate::session_store::add_session(app, record);
                            let _ = app.emit(EVENT_SESSION_COMPLETE, &result);
                        }
                        Err(e) => {
                            log::warn!("Failed to parse stats CSV {}: {e}", path.display());
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

// ─── CSV parsing ───────────────────────────────────────────────────────────────
//
// KovaaK's CSV format has a header section and a "Score" row.
// Example filename: "Gridshot Ultimate - Challenge Start - 2024.01.15-12.30.45.csv"
// The file contains rows like: Timestamp,Value1,Value2,...
// A summary row at the end contains key=value pairs.

fn parse_csv(path: &Path) -> anyhow::Result<SessionResult> {
    // Extract scenario name and timestamp from filename
    let filename = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown");

    let (scenario, timestamp) = parse_filename(filename);

    let content = std::fs::read_to_string(path)?;
    let mut score = 0.0f64;
    let mut kills = 0u32;
    let mut deaths = 0u32;
    let mut hit_count = 0u32;
    let mut miss_count = 0u32;
    let mut avg_ttk = 0.0f64;
    let mut damage_done = 0.0f64;
    let mut challenge_start = String::new();

    // KovaaK's stats CSVs use a "Key:,Value" summary section.
    // Real field names (from actual CSV inspection):
    //   Score:,672.0  Kills:,71  Deaths:,0  Hit Count:,71  Miss Count:,19
    //   Avg TTK:,0.844892  Damage Done:,71.0  Challenge Start:,05:55:57.528
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some((key, val)) = trimmed.split_once(':') {
            let key = key.trim().to_lowercase();
            // val portion may start with "," (CSV column), strip it
            let val = val.trim().trim_start_matches(',').trim();
            match key.as_str() {
                "score" => score = val.parse().unwrap_or(0.0),
                "kills" => kills = val.parse().unwrap_or(0),
                "deaths" => deaths = val.parse().unwrap_or(0),
                "hit count" => hit_count = val.parse().unwrap_or(0),
                "miss count" => miss_count = val.parse().unwrap_or(0),
                "avg ttk" => {
                    // Value is in seconds, no "s" suffix in summary row
                    avg_ttk = val.trim_end_matches('s').parse().unwrap_or(0.0);
                }
                "damage done" => damage_done = val.parse().unwrap_or(0.0),
                "challenge start" => {
                    // split_once(':') splits on the FIRST colon (after "Challenge Start").
                    // val is then ",05:55:57.528" → after strip comma → "05:55:57.528".
                    challenge_start = val.to_string();
                }
                _ => {}
            }
        }
    }

    // Compute accuracy from shot counts (0.0 if no shots recorded)
    let accuracy = if hit_count + miss_count > 0 {
        hit_count as f64 / (hit_count + miss_count) as f64
    } else {
        0.0
    };

    // Compute duration from filename end-timestamp minus Challenge Start.
    // Filename timestamp format: "YYYY.MM.DD-HH.mm.ss"  (e.g. "2026.02.03-05.56.57")
    // The time portion is after the last '-': "05.56.57" → seconds.
    // Challenge Start is "HH:MM:SS.mmm" → seconds.
    let duration_secs = compute_duration(&timestamp, &challenge_start);

    Ok(SessionResult {
        scenario,
        score,
        accuracy,
        kills,
        deaths,
        duration_secs,
        avg_ttk,
        damage_done,
        timestamp,
        csv_path: path.to_string_lossy().into_owned(),
    })
}

/// Compute challenge duration (seconds) from the filename end-timestamp and
/// the in-file Challenge Start time.
///
/// * `end_ts`   – filename timestamp like `"2026.02.03-05.56.57"`
/// * `start_ts` – Challenge Start field value like `"05:55:57.528"`
fn compute_duration(end_ts: &str, start_ts: &str) -> f64 {
    // Extract time portion from end timestamp: everything after the '-'
    let end_time = end_ts.splitn(2, '-').nth(1).unwrap_or("");
    // end_time is "05.56.57" — dots as separators
    let end_secs = time_str_to_secs(end_time);
    let start_secs = time_str_to_secs(start_ts);
    match (end_secs, start_secs) {
        (Some(e), Some(s)) => {
            let diff = e - s;
            // Handle midnight rollover (e.g. challenge starts at 23:59 ends at 00:01)
            if diff < 0.0 { diff + 86400.0 } else { diff }
        }
        _ => 0.0,
    }
}

/// Parse a time string to seconds since midnight.
/// Accepts separators `:` or `.` for hours, minutes, seconds.
/// Handles optional fractional seconds: "HH:MM:SS", "HH:MM:SS.mmm", "HH.MM.SS".
fn time_str_to_secs(s: &str) -> Option<f64> {
    let s = s.trim();
    // Split on the first two separators (either ':' or '.')
    // Strategy: replace '.' with ':' only if there are no ':' present already
    let normalized: String = if s.contains(':') {
        s.to_string()
    } else {
        // "05.56.57" → "05:56:57"
        let mut iter = s.splitn(3, '.');
        match (iter.next(), iter.next(), iter.next()) {
            (Some(h), Some(m), Some(sec)) => format!("{}:{}:{}", h, m, sec),
            _ => return None,
        }
    };
    // Now parse "HH:MM:SS" or "HH:MM:SS.mmm"
    let mut parts = normalized.splitn(3, ':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let sec: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// Parse KovaaK's filename format.
///
/// KovaaK's writes several variants, all of which embed a timestamp:
///   `{Scenario} - Challenge Start - {YYYY.MM.DD-HH.mm.ss}`
///   `{Scenario} - Challenge - {YYYY.MM.DD-HH.mm.ss} Stats`
///
/// Strategy: locate the timestamp by its fixed numeric pattern, then strip
/// the ` - <label> - ` separator that precedes it.
fn parse_filename(stem: &str) -> (String, String) {
    if let Some(ts_start) = find_timestamp(stem) {
        let timestamp = stem[ts_start..ts_start + 19].to_string();
        // Everything before the timestamp, then rfind the last " - " separator.
        let prefix = &stem[..ts_start];
        let scenario = match prefix.rfind(" - ") {
            Some(sep) => stem[..sep].to_string(),
            None => prefix.trim_end_matches([' ', '-']).to_string(),
        };
        (scenario, timestamp)
    } else {
        // No timestamp found — return the whole stem unchanged.
        (stem.to_string(), String::new())
    }
}

/// Return the byte offset of the first `YYYY.MM.DD-HH.mm.ss` substring, or
/// `None` if the string contains no such pattern.
fn find_timestamp(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    for i in 0..=b.len() - 19 {
        if b[i + 4] == b'.'
            && b[i + 7] == b'.'
            && b[i + 10] == b'-'
            && b[i + 13] == b'.'
            && b[i + 16] == b'.'
            && b[i..i + 4].iter().all(|c| c.is_ascii_digit())
            && b[i + 5..i + 7].iter().all(|c| c.is_ascii_digit())
            && b[i + 8..i + 10].iter().all(|c| c.is_ascii_digit())
            && b[i + 11..i + 13].iter().all(|c| c.is_ascii_digit())
            && b[i + 14..i + 16].iter().all(|c| c.is_ascii_digit())
            && b[i + 17..i + 19].iter().all(|c| c.is_ascii_digit())
        {
            return Some(i);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_filename_challenge_start() {
        let (scenario, ts) =
            parse_filename("Gridshot Ultimate - Challenge Start - 2024.01.15-12.30.45");
        assert_eq!(scenario, "Gridshot Ultimate");
        assert_eq!(ts, "2024.01.15-12.30.45");
    }

    #[test]
    fn parse_filename_challenge_stats_suffix() {
        // Variant emitted by newer KovaaK's builds
        let (scenario, ts) = parse_filename(
            "VT Aether Novice S5 - Challenge - 2026.02.25-12.10.59 Stats",
        );
        assert_eq!(scenario, "VT Aether Novice S5");
        assert_eq!(ts, "2026.02.25-12.10.59");
    }

    #[test]
    fn parse_filename_no_timestamp() {
        let (scenario, ts) = parse_filename("SomeOtherFile");
        assert_eq!(scenario, "SomeOtherFile");
        assert!(ts.is_empty());
    }

    #[test]
    fn time_str_to_secs_colon_separated() {
        // "05:55:57.528" → 5*3600 + 55*60 + 57.528 = 21357.528
        let secs = time_str_to_secs("05:55:57.528").unwrap();
        assert!((secs - 21357.528).abs() < 0.001);
    }

    #[test]
    fn time_str_to_secs_dot_separated() {
        // "05.56.57" → 5*3600 + 56*60 + 57 = 21417
        let secs = time_str_to_secs("05.56.57").unwrap();
        assert!((secs - 21417.0).abs() < 0.001);
    }

    #[test]
    fn compute_duration_sixty_seconds() {
        // Filename end: "2026.02.03-05.56.57" → end time "05.56.57" → 21417s
        // Challenge Start: "05:55:57.528" → 21357.528s
        // Duration ≈ 59.472s
        let dur = compute_duration("2026.02.03-05.56.57", "05:55:57.528");
        assert!((dur - 59.472).abs() < 0.1, "got {dur}");
    }
}
