/// File watcher module: watches the KovaaK's stats directory for new CSV files.
///
/// When a new file is detected, it's parsed and a `session-complete` event is emitted.
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

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
    pub timestamp: String,
    pub csv_path: String,
}

// ─── Watcher state ─────────────────────────────────────────────────────────────

static WATCHER: Lazy<Mutex<Option<RecommendedWatcher>>> = Lazy::new(|| Mutex::new(None));

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
                    log::info!("New stats file detected: {}", path.display());
                    // Small delay to ensure the game has finished writing
                    std::thread::sleep(Duration::from_millis(500));
                    match parse_csv(path) {
                        Ok(result) => {
                            log::info!("Session complete: {} score={}", result.scenario, result.score);
                            // Capture smoothness summary BEFORE stopping tracking (clears buffer)
                            let smoothness = crate::mouse_hook::session_summary();
                            // Stop smoothness tracking and reset OCR session state
                            crate::mouse_hook::stop_session_tracking();
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
                                timestamp: result.timestamp.clone(),
                                smoothness,
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

/// Public re-export for use by friend_scores::export
pub fn parse_csv_public(path: &Path) -> anyhow::Result<SessionResult> {
    parse_csv(path)
}

fn parse_csv(path: &Path) -> anyhow::Result<SessionResult> {
    // Extract scenario name and timestamp from filename
    let filename = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown");

    let (scenario, timestamp) = parse_filename(filename);

    let content = std::fs::read_to_string(path)?;
    let mut score = 0.0f64;
    let mut accuracy = 0.0f64;
    let mut kills = 0u32;
    let mut deaths = 0u32;
    let mut duration_secs = 0.0f64;

    // KovaaK's stats CSVs have a section at the bottom with summary stats
    // They look like lines: "Score:,12345.67"
    // Parse both the summary section and try the CSV records
    for line in content.lines() {
        let trimmed = line.trim();
        // Summary rows use "Key:,Value" format
        if let Some((key, val)) = trimmed.split_once(':') {
            let key = key.trim().to_lowercase();
            let val = val.trim().trim_start_matches(',').trim();
            match key.as_str() {
                "score" => score = val.parse().unwrap_or(0.0),
                "accuracy" => {
                    accuracy = val.trim_end_matches('%').parse().unwrap_or(0.0);
                    if accuracy > 1.0 {
                        accuracy /= 100.0; // normalize to 0..1
                    }
                }
                "kills" | "hits" => kills = val.parse().unwrap_or(0),
                "deaths" | "shots" => deaths = val.parse().unwrap_or(0),
                "challenge duration" | "time" => {
                    duration_secs = val.parse().unwrap_or(0.0);
                }
                _ => {}
            }
        }
    }

    Ok(SessionResult {
        scenario,
        score,
        accuracy,
        kills,
        deaths,
        duration_secs,
        timestamp,
        csv_path: path.to_string_lossy().into_owned(),
    })
}

/// Parse KovaaK's filename format: "{Scenario} - Challenge Start - {YYYY.MM.DD-HH.mm.ss}"
fn parse_filename(stem: &str) -> (String, String) {
    const MARKER: &str = " - Challenge Start - ";
    if let Some(idx) = stem.find(MARKER) {
        let scenario = stem[..idx].to_string();
        let ts_raw = &stem[idx + MARKER.len()..];
        let timestamp = ts_raw.to_string();
        (scenario, timestamp)
    } else {
        (stem.to_string(), String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_filename_standard() {
        let (scenario, _ts) =
            parse_filename("Gridshot Ultimate - Challenge Start - 2024.01.15-12.30.45");
        assert_eq!(scenario, "Gridshot Ultimate");
    }

    #[test]
    fn parse_filename_no_marker() {
        let (scenario, ts) = parse_filename("SomeOtherFile");
        assert_eq!(scenario, "SomeOtherFile");
        assert!(ts.is_empty());
    }
}
