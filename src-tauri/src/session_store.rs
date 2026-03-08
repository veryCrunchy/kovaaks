/// Persistent session history store.
///
/// Each completed KovaaK's session is appended here with score, accuracy and a
/// smoothness snapshot averaged across the session. Stored in the local SQLite
/// stats database, with one-time legacy import from `sessions.json`.
use anyhow::Context;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const LEGACY_STORE_PATH: &str = "sessions.json";
const LEGACY_STORE_KEY: &str = "history";

// ─── Types ─────────────────────────────────────────────────────────────────────

/// Session-averaged smoothness snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmoothnessSnapshot {
    /// 0–100 composite score
    pub composite: f32,
    /// Lateral RMS jitter (lower = better)
    pub jitter: f32,
    /// Overshoot / direction-reversal rate
    pub overshoot_rate: f32,
    /// Speed consistency (coefficient of variation; lower = better)
    pub velocity_std: f32,
    /// Path straightness (0–1; higher = better)
    pub path_efficiency: f32,
    /// DPI-normalised average speed (px/s at 800 DPI baseline)
    pub avg_speed: f32,
    /// Inter-click interval coefficient of variation (lower = more rhythmic).
    #[serde(default)]
    pub click_timing_cv: f32,
    /// Fraction of time in Fitts' correction phase (lower = more decisive).
    #[serde(default)]
    pub correction_ratio: f32,
    /// Systematic overshoot direction bias (0=balanced, 1=always same direction).
    #[serde(default)]
    pub directional_bias: f32,
}

/// Per-session stats-panel snapshot (fields are Option because not all scenarios
/// populate every field — the presence pattern is used to infer scenario type).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StatsPanelSnapshot {
    /// Scenario type inferred from populated fields.
    pub scenario_type: String,
    /// Final kill count (None for pure tracking).
    #[serde(default)]
    pub kills: Option<u32>,
    /// Average kills per second over session.
    #[serde(default)]
    pub avg_kps: Option<f32>,
    /// Final accuracy % (shots hit / shots fired).
    #[serde(default)]
    pub accuracy_pct: Option<f32>,
    /// Total damage dealt (None for one-shot scenarios).
    #[serde(default)]
    pub total_damage: Option<f32>,
    /// Average time-to-kill in milliseconds.
    #[serde(default)]
    pub avg_ttk_ms: Option<f32>,
    /// Best (minimum) TTK recorded during the session.
    #[serde(default)]
    pub best_ttk_ms: Option<f32>,
    /// TTK standard deviation — consistency of kill speed.
    #[serde(default)]
    pub ttk_std_ms: Option<f32>,
    /// Accuracy trend: final accuracy minus accuracy at session midpoint.
    /// Positive = improving, negative = fatiguing.
    #[serde(default)]
    pub accuracy_trend: Option<f32>,
}

/// Per-session shot recovery snapshot derived from bridge shot_fired/shot_hit events.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShotTimingSnapshot {
    /// Number of hits paired to a preceding shot.
    #[serde(default)]
    pub paired_shot_hits: u32,
    /// Average time from shot fired to corresponding hit event.
    #[serde(default)]
    pub avg_fire_to_hit_ms: Option<f32>,
    /// 90th percentile fired->hit latency (tail of correction delays).
    #[serde(default)]
    pub p90_fire_to_hit_ms: Option<f32>,
    /// Average number of shots needed per hit (1.0 ideal for one-shot).
    #[serde(default)]
    pub avg_shots_to_hit: Option<f32>,
    /// Fraction of hits that required >1 shot before landing.
    #[serde(default)]
    pub corrective_shot_ratio: Option<f32>,
}

/// One completed session record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    /// Unique identifier: `{scenario_slug}-{timestamp}`
    pub id: String,
    pub scenario: String,
    pub score: f64,
    pub accuracy: f64,
    pub kills: u32,
    pub deaths: u32,
    pub duration_secs: f64,
    pub avg_ttk: f64,
    pub damage_done: f64,
    /// Raw timestamp string from the CSV filename (YYYY.MM.DD-HH.mm.ss)
    pub timestamp: String,
    /// Session-averaged smoothness metrics (None if mouse hook had no data)
    pub smoothness: Option<SmoothnessSnapshot>,
    /// Session stats panel snapshot (None if stats-panel OCR not configured)
    #[serde(default)]
    pub stats_panel: Option<StatsPanelSnapshot>,
    /// Shot recovery quality snapshot from bridge fired->hit timing.
    #[serde(default)]
    pub shot_timing: Option<ShotTimingSnapshot>,
    /// True if a replay file (mouse path + per-second metrics) was saved.
    #[serde(default)]
    pub has_replay: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct SessionMergeResult {
    pub imported: usize,
    pub skipped_existing: usize,
    pub total_after: usize,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct SessionStoreInitReport {
    pub imported_legacy: usize,
    pub skipped_legacy_existing: usize,
    pub total_after: usize,
}

// ─── Public API ────────────────────────────────────────────────────────────────

pub fn initialize(app: &AppHandle) {
    match try_initialize(app) {
        Ok(report) => {
            log::info!(
                "session_store: stats db ready (legacy imported={}, skipped_existing={}, total={})",
                report.imported_legacy,
                report.skipped_legacy_existing,
                report.total_after,
            );
        }
        Err(error) => {
            log::error!("session_store: failed to initialize stats db: {error:?}");
        }
    }
}

pub fn add_session(app: &AppHandle, record: SessionRecord) {
    let _ = merge_sessions(app, vec![record]);
}

pub fn merge_sessions<I>(app: &AppHandle, records: I) -> SessionMergeResult
where
    I: IntoIterator<Item = SessionRecord>,
{
    match try_merge_sessions(app, records) {
        Ok(result) => result,
        Err(error) => {
            log::warn!("session_store: merge error: {error:?}");
            SessionMergeResult::default()
        }
    }
}

pub fn get_all_sessions(app: &AppHandle) -> Vec<SessionRecord> {
    match try_get_all_sessions(app) {
        Ok(records) => records,
        Err(error) => {
            log::warn!("session_store: read error: {error:?}");
            vec![]
        }
    }
}

pub fn clear_sessions(app: &AppHandle) {
    if let Err(error) = try_clear_sessions(app) {
        log::warn!("session_store: clear error: {error:?}");
    }
}

fn try_initialize(app: &AppHandle) -> anyhow::Result<SessionStoreInitReport> {
    let db_path = crate::stats_db::initialize(app)?;
    let merge = load_legacy_sessions(app)
        .map(|records| try_merge_sessions(app, records))
        .transpose()?
        .unwrap_or_default();
    try_migrate_session_names(app)?;
    log::info!("session_store: using stats db at {}", db_path.display());
    Ok(SessionStoreInitReport {
        imported_legacy: merge.imported,
        skipped_legacy_existing: merge.skipped_existing,
        total_after: merge.total_after,
    })
}

fn try_merge_sessions<I>(app: &AppHandle, records: I) -> anyhow::Result<SessionMergeResult>
where
    I: IntoIterator<Item = SessionRecord>,
{
    let mut conn = crate::stats_db::connect(app)?;
    let tx = conn.transaction()?;
    let mut result = SessionMergeResult::default();

    {
        let mut insert = tx.prepare(
            "
            INSERT INTO sessions (
                id,
                scenario,
                score,
                accuracy,
                kills,
                deaths,
                duration_secs,
                avg_ttk,
                damage_done,
                timestamp,
                smoothness_json,
                stats_panel_json,
                shot_timing_json,
                has_replay
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            ON CONFLICT(id) DO NOTHING
            ",
        )?;

        for record in records {
            let inserted = insert.execute(params![
                record.id,
                record.scenario,
                record.score,
                record.accuracy,
                record.kills as i64,
                record.deaths as i64,
                record.duration_secs,
                record.avg_ttk,
                record.damage_done,
                record.timestamp,
                serialize_optional_json(record.smoothness.as_ref())?,
                serialize_optional_json(record.stats_panel.as_ref())?,
                serialize_optional_json(record.shot_timing.as_ref())?,
                if record.has_replay { 1i64 } else { 0i64 },
            ])?;
            if inserted > 0 {
                result.imported += 1;
            } else {
                result.skipped_existing += 1;
            }
        }
    }

    result.total_after = tx.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?;
    tx.commit()?;
    Ok(result)
}

fn try_get_all_sessions(app: &AppHandle) -> anyhow::Result<Vec<SessionRecord>> {
    let conn = crate::stats_db::connect(app)?;
    let mut stmt = conn.prepare(
        "
        SELECT
            id,
            scenario,
            score,
            accuracy,
            kills,
            deaths,
            duration_secs,
            avg_ttk,
            damage_done,
            timestamp,
            smoothness_json,
            stats_panel_json,
            shot_timing_json,
            has_replay
        FROM sessions
        ORDER BY timestamp ASC, id ASC
        ",
    )?;
    let rows = stmt.query_map([], row_to_session_record)?;
    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(row?);
    }
    Ok(sessions)
}

fn try_clear_sessions(app: &AppHandle) -> anyhow::Result<()> {
    let conn = crate::stats_db::connect(app)?;
    conn.execute("DELETE FROM replay_assets", [])?;
    conn.execute("DELETE FROM sessions", [])?;
    Ok(())
}

fn try_migrate_session_names(app: &AppHandle) -> anyhow::Result<()> {
    let conn = crate::stats_db::connect(app)?;
    let mut stmt = conn.prepare("SELECT id, scenario FROM sessions ORDER BY timestamp ASC, id ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut changed = 0usize;
    for row in rows {
        let (id, scenario) = row?;
        let stripped = crate::file_watcher::strip_challenge_suffix(&scenario);
        if stripped != scenario {
            log::info!("session migration: {:?} → {:?}", scenario, stripped);
            conn.execute(
                "UPDATE sessions SET scenario = ?1 WHERE id = ?2",
                params![stripped, id],
            )?;
            changed += 1;
        }
    }

    if changed > 0 {
        log::info!("session migration: updated {} record(s)", changed);
    }
    Ok(())
}

fn load_legacy_sessions(app: &AppHandle) -> Option<Vec<SessionRecord>> {
    use tauri_plugin_store::StoreExt;

    let store = app.store(LEGACY_STORE_PATH).ok()?;
    let value = store.get(LEGACY_STORE_KEY)?;
    match serde_json::from_value::<Vec<SessionRecord>>(value.clone()) {
        Ok(records) if !records.is_empty() => Some(records),
        Ok(_) => None,
        Err(error) => {
            log::warn!("session_store: could not parse legacy sessions.json: {error}");
            None
        }
    }
}

fn row_to_session_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRecord> {
    let id = row.get::<_, String>(0)?;
    let smoothness_json = row.get::<_, Option<String>>(10)?;
    let stats_panel_json = row.get::<_, Option<String>>(11)?;
    let shot_timing_json = row.get::<_, Option<String>>(12)?;
    let has_replay = row.get::<_, i64>(13)? != 0;

    Ok(SessionRecord {
        id: id.clone(),
        scenario: row.get(1)?,
        score: row.get(2)?,
        accuracy: row.get(3)?,
        kills: row.get::<_, i64>(4)? as u32,
        deaths: row.get::<_, i64>(5)? as u32,
        duration_secs: row.get(6)?,
        avg_ttk: row.get(7)?,
        damage_done: row.get(8)?,
        timestamp: row.get(9)?,
        smoothness: deserialize_optional_json(&id, "smoothness_json", smoothness_json),
        stats_panel: deserialize_optional_json(&id, "stats_panel_json", stats_panel_json),
        shot_timing: deserialize_optional_json(&id, "shot_timing_json", shot_timing_json),
        has_replay,
    })
}

fn serialize_optional_json<T: Serialize>(value: Option<&T>) -> anyhow::Result<Option<String>> {
    value
        .map(|item| serde_json::to_string(item).context("could not serialize session field"))
        .transpose()
}

fn deserialize_optional_json<T>(
    session_id: &str,
    field_name: &str,
    value: Option<String>,
) -> Option<T>
where
    T: for<'de> Deserialize<'de>,
{
    let json = value?;
    match serde_json::from_str::<T>(&json) {
        Ok(parsed) => Some(parsed),
        Err(error) => {
            log::warn!(
                "session_store: could not decode {} for {}: {}",
                field_name,
                session_id,
                error
            );
            None
        }
    }
}
