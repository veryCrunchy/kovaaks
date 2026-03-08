/// Replay store: persists per-session mouse-path and per-second metric snapshots.
///
/// Each replay is saved as a JSON file in `{app_data_dir}/replays/{session_id}.json`.
/// Positions are downsampled (every Nth point) to reduce file size.
/// At most MAX_REPLAYS files are kept; the oldest are pruned on overflow.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::mouse_hook::{MetricPoint, RawPositionPoint};

// ─── Config ───────────────────────────────────────────────────────────────────

/// Keep every 3rd raw position sample (30fps → ~10fps, ~600 pts/min).
const DOWNSAMPLE_FACTOR: usize = 3;
/// Maximum number of replay files to keep on disk (video frames make these larger).
const MAX_REPLAYS: usize = 10;

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn replay_dir(app: &AppHandle) -> Option<PathBuf> {
    let data_dir = app.path().app_data_dir().ok()?;
    let dir = data_dir.join("replays");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn prune_old_replays(replay_dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(replay_dir) else {
        return;
    };

    let mut files: Vec<(PathBuf, std::time::SystemTime)> = entries
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| {
            let mtime = e.metadata().ok()?.modified().ok()?;
            Some((e.path(), mtime))
        })
        .collect();

    if files.len() <= keep {
        return;
    }

    // Sort oldest-first, remove the excess
    files.sort_by_key(|(_, mtime)| *mtime);
    let to_delete = files.len() - keep;
    for (path, _) in files.iter().take(to_delete) {
        let _ = std::fs::remove_file(path);
        log::debug!("replay_store: pruned {}", path.display());
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// Persist `data` for `session_id`.  Positions are downsampled before writing.
/// Returns `true` if the file was written successfully.
pub fn save_replay(app: &AppHandle, session_id: &str, data: ReplayData) -> bool {
    let Some(dir) = replay_dir(app) else {
        log::warn!("replay_store: could not resolve app data dir");
        return false;
    };

    // Make room for the new file first
    prune_old_replays(&dir, MAX_REPLAYS - 1);

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

    let path = dir.join(format!("{}.json", session_id));
    match serde_json::to_string(&stored) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                log::warn!("replay_store: write error for {}: {e}", path.display());
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
            if let Err(error) = crate::stats_db::upsert_replay_asset(
                app,
                &crate::stats_db::ReplayAssetRecord {
                    session_id,
                    file_path: &path,
                    positions_count: stored.positions.len(),
                    metrics_count: stored.metrics.len(),
                    frames_count: stored.frames.len(),
                    has_run_snapshot: stored.run_snapshot.is_some(),
                },
            ) {
                log::warn!(
                    "replay_store: could not register replay metadata for {}: {error}",
                    session_id
                );
            }
            true
        }
        Err(e) => {
            log::warn!("replay_store: serialize error for {session_id}: {e}");
            false
        }
    }
}

/// Load a previously saved replay. Returns `None` if the file does not exist or
/// cannot be parsed.
pub fn load_replay(app: &AppHandle, session_id: &str) -> Option<ReplayData> {
    let dir = replay_dir(app)?;
    let path = dir.join(format!("{}.json", session_id));
    let json = std::fs::read_to_string(&path).ok()?;
    match serde_json::from_str(&json) {
        Ok(data) => Some(data),
        Err(e) => {
            log::warn!("replay_store: parse error for {session_id}: {e}");
            None
        }
    }
}
