/// Replay store: persists per-session mouse-path and per-second metric snapshots.
///
/// Replay payloads now live in SQLite so frontend reads do not depend on sidecar
/// JSON files. Legacy sidecars are still imported on demand for older sessions.
/// Positions are downsampled (every Nth point) to reduce file size.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::mouse_hook::{MetricPoint, RawPositionPoint};

// ─── Config ───────────────────────────────────────────────────────────────────

/// Keep every 3rd raw position sample (30fps → ~10fps, ~600 pts/min).
const DOWNSAMPLE_FACTOR: usize = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayData {
    pub positions: Vec<RawPositionPoint>,
    pub metrics: Vec<MetricPoint>,
    /// Screen frames captured at 5 fps, 320 px wide, JPEG quality 50.
    /// Absent in replays saved before this field was added.
    #[serde(default)]
    pub frames: Vec<crate::screen_recorder::ScreenFrame>,
    /// Bridge-derived run snapshot with timeline and event counts.
    /// Absent in replays saved before this field was added.
    #[serde(default)]
    pub run_snapshot: Option<crate::bridge::BridgeRunSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayPayloadData {
    pub positions: Vec<RawPositionPoint>,
    pub metrics: Vec<MetricPoint>,
    #[serde(default)]
    pub frames: Vec<crate::screen_recorder::ScreenFrame>,
}

impl From<&ReplayData> for ReplayPayloadData {
    fn from(value: &ReplayData) -> Self {
        Self {
            positions: value.positions.clone(),
            metrics: value.metrics.clone(),
            frames: value.frames.clone(),
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn replay_dir(app: &AppHandle) -> Option<PathBuf> {
    let data_dir = app.path().app_data_dir().ok()?;
    let dir = data_dir.join("replays");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn sqlite_replay_path(session_id: &str) -> PathBuf {
    PathBuf::from(format!("sqlite://session_replay_payloads/{session_id}"))
}

fn backfill_sqlite_replay(app: &AppHandle, session_id: &str, replay: &ReplayData) -> bool {
    if let Err(error) = crate::stats_db::upsert_replay_payload(app, session_id, replay) {
        log::warn!(
            "replay_store: could not persist replay payload for {}: {error}",
            session_id
        );
        return false;
    }

    if let Some(snapshot) = replay.run_snapshot.as_ref() {
        if let Err(error) = crate::stats_db::upsert_run_capture(app, session_id, snapshot) {
            log::warn!(
                "replay_store: could not persist run capture for {}: {error}",
                session_id
            );
        }
    }

    let virtual_path = sqlite_replay_path(session_id);
    if let Err(error) = crate::stats_db::upsert_replay_asset(
        app,
        &crate::stats_db::ReplayAssetRecord {
            session_id,
            file_path: &virtual_path,
            positions_count: replay.positions.len(),
            metrics_count: replay.metrics.len(),
            frames_count: replay.frames.len(),
            has_run_snapshot: replay.run_snapshot.is_some(),
        },
    ) {
        log::warn!(
            "replay_store: could not register replay metadata for {}: {error}",
            session_id
        );
    }

    true
}

fn import_legacy_replay(app: &AppHandle, session_id: &str) -> Option<ReplayData> {
    let dir = replay_dir(app)?;
    let path = dir.join(format!("{}.json", session_id));
    let json = std::fs::read_to_string(&path).ok()?;
    let replay = match serde_json::from_str::<ReplayData>(&json) {
        Ok(replay) => replay,
        Err(error) => {
            log::warn!("replay_store: parse error for {session_id}: {error}");
            return None;
        }
    };

    let _ = backfill_sqlite_replay(app, session_id, &replay);
    Some(replay)
}

fn repair_run_capture_if_needed(app: &AppHandle, session_id: &str, replay: &ReplayData) {
    if replay.run_snapshot.is_none() {
        return;
    }
    let has_summary = crate::stats_db::get_run_summary(app, session_id)
        .ok()
        .flatten()
        .is_some();
    if !has_summary {
        let _ = backfill_sqlite_replay(app, session_id, replay);
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// Persist `data` for `session_id`.  Positions are downsampled before writing.
/// Returns `true` if the replay payload was written successfully.
pub fn save_replay(app: &AppHandle, session_id: &str, data: ReplayData) -> bool {
    // Downsample positions: keep every DOWNSAMPLE_FACTOR-th point.
    // Click events are never dropped so they remain visible in the canvas.
    let downsampled_positions: Vec<RawPositionPoint> = data
        .positions
        .iter()
        .enumerate()
        .filter(|(i, p)| *i % DOWNSAMPLE_FACTOR == 0 || p.is_click)
        .map(|(_, p)| p.clone())
        .collect();

    let stored = ReplayData {
        positions: downsampled_positions,
        metrics: data.metrics,
        frames: data.frames,
        run_snapshot: data.run_snapshot,
    };

    if !backfill_sqlite_replay(app, session_id, &stored) {
        return false;
    }
    log::info!(
        "replay_store: saved {} ({} positions, {} metrics, {} frames, run_snapshot={})",
        session_id,
        stored.positions.len(),
        stored.metrics.len(),
        stored.frames.len(),
        stored.run_snapshot.is_some(),
    );
    true
}

/// Load a previously saved replay. Returns `None` if the file does not exist or
/// cannot be parsed.
pub fn load_replay(app: &AppHandle, session_id: &str) -> Option<ReplayData> {
    match crate::stats_db::get_replay_data(app, session_id) {
        Ok(Some(replay)) => {
            repair_run_capture_if_needed(app, session_id, &replay);
            Some(replay)
        }
        Ok(None) => import_legacy_replay(app, session_id),
        Err(error) => {
            log::warn!(
                "replay_store: could not load sqlite replay payload for {}: {error}",
                session_id
            );
            import_legacy_replay(app, session_id)
        }
    }
}

pub fn load_replay_payload(app: &AppHandle, session_id: &str) -> Option<ReplayPayloadData> {
    load_replay(app, session_id).map(|replay| ReplayPayloadData::from(&replay))
}
