use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const DB_FILE_NAME: &str = "stats.sqlite3";
const SCHEMA_VERSION: i32 = 2;

pub struct ReplayAssetRecord<'a> {
    pub session_id: &'a str,
    pub file_path: &'a Path,
    pub positions_count: usize,
    pub metrics_count: usize,
    pub frames_count: usize,
    pub has_run_snapshot: bool,
}

pub fn initialize(app: &AppHandle) -> Result<PathBuf> {
    let path = db_path(app)?;
    let conn = open_connection(&path)?;
    configure_connection(&conn)?;
    migrate_schema(&conn)?;
    Ok(path)
}

pub fn connect(app: &AppHandle) -> Result<Connection> {
    let path = db_path(app)?;
    let conn = open_connection(&path)?;
    configure_connection(&conn)?;
    migrate_schema(&conn)?;
    Ok(conn)
}

pub fn upsert_replay_asset(app: &AppHandle, record: &ReplayAssetRecord<'_>) -> Result<()> {
    let conn = connect(app)?;
    let updated_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    conn.execute(
        "
        INSERT INTO replay_assets (
            session_id,
            file_path,
            positions_count,
            metrics_count,
            frames_count,
            has_run_snapshot,
            updated_at_unix_ms
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(session_id) DO UPDATE SET
            file_path = excluded.file_path,
            positions_count = excluded.positions_count,
            metrics_count = excluded.metrics_count,
            frames_count = excluded.frames_count,
            has_run_snapshot = excluded.has_run_snapshot,
            updated_at_unix_ms = excluded.updated_at_unix_ms
        ",
        params![
            record.session_id,
            record.file_path.to_string_lossy().into_owned(),
            record.positions_count as i64,
            record.metrics_count as i64,
            record.frames_count as i64,
            if record.has_run_snapshot { 1i64 } else { 0i64 },
            updated_at_unix_ms,
        ],
    )?;

    Ok(())
}

fn db_path(app: &AppHandle) -> Result<PathBuf> {
    let data_dir = app
        .path()
        .app_data_dir()
        .context("could not resolve app data directory for stats database")?;
    std::fs::create_dir_all(&data_dir).with_context(|| {
        format!("could not create app data directory {}", data_dir.display())
    })?;
    Ok(data_dir.join(DB_FILE_NAME))
}

fn open_connection(path: &Path) -> Result<Connection> {
    Connection::open(path)
        .with_context(|| format!("could not open stats database {}", path.display()))
}

fn configure_connection(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", 1i64)?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    Ok(())
}

fn migrate_schema(conn: &Connection) -> Result<()> {
    let user_version = conn.pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))?;
    if user_version >= SCHEMA_VERSION {
        return Ok(());
    }

    if user_version < 1 {
        conn.execute_batch(
            "
            BEGIN;
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                scenario TEXT NOT NULL,
                score REAL NOT NULL,
                accuracy REAL NOT NULL,
                kills INTEGER NOT NULL,
                deaths INTEGER NOT NULL,
                duration_secs REAL NOT NULL,
                avg_ttk REAL NOT NULL,
                damage_done REAL NOT NULL,
                timestamp TEXT NOT NULL,
                smoothness_json TEXT,
                stats_panel_json TEXT,
                shot_timing_json TEXT,
                has_replay INTEGER NOT NULL DEFAULT 0 CHECK (has_replay IN (0, 1))
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_timestamp ON sessions(timestamp);
            CREATE INDEX IF NOT EXISTS idx_sessions_scenario_timestamp ON sessions(scenario, timestamp);

            CREATE TABLE IF NOT EXISTS replay_assets (
                session_id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                positions_count INTEGER NOT NULL DEFAULT 0,
                metrics_count INTEGER NOT NULL DEFAULT 0,
                frames_count INTEGER NOT NULL DEFAULT 0,
                has_run_snapshot INTEGER NOT NULL DEFAULT 0 CHECK (has_run_snapshot IN (0, 1)),
                updated_at_unix_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_replay_assets_updated_at ON replay_assets(updated_at_unix_ms);

            PRAGMA user_version = 1;
            COMMIT;
            ",
        )?;
    }

    if user_version < 2 {
        conn.execute_batch(
            "
            BEGIN;
            CREATE TABLE IF NOT EXISTS session_run_summaries (
                session_id TEXT PRIMARY KEY,
                duration_secs REAL,
                score_total REAL,
                score_total_derived REAL,
                score_per_minute REAL,
                shots_fired REAL,
                shots_hit REAL,
                kills REAL,
                kills_per_second REAL,
                damage_done REAL,
                damage_possible REAL,
                damage_efficiency REAL,
                accuracy_pct REAL,
                peak_score_per_minute REAL,
                peak_kills_per_second REAL,
                paired_shot_hits INTEGER NOT NULL DEFAULT 0,
                avg_fire_to_hit_ms REAL,
                p90_fire_to_hit_ms REAL,
                avg_shots_to_hit REAL,
                corrective_shot_ratio REAL,
                started_at_unix_ms INTEGER,
                ended_at_unix_ms INTEGER,
                shot_fired_events INTEGER NOT NULL DEFAULT 0,
                shot_hit_events INTEGER NOT NULL DEFAULT 0,
                kill_events INTEGER NOT NULL DEFAULT 0,
                challenge_queued_events INTEGER NOT NULL DEFAULT 0,
                challenge_start_events INTEGER NOT NULL DEFAULT 0,
                challenge_end_events INTEGER NOT NULL DEFAULT 0,
                challenge_complete_events INTEGER NOT NULL DEFAULT 0,
                challenge_canceled_events INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_run_summaries_peak_spm ON session_run_summaries(peak_score_per_minute DESC);
            CREATE INDEX IF NOT EXISTS idx_run_summaries_peak_kps ON session_run_summaries(peak_kills_per_second DESC);

            CREATE TABLE IF NOT EXISTS session_run_timelines (
                session_id TEXT NOT NULL,
                t_sec INTEGER NOT NULL,
                score_per_minute REAL,
                kills_per_second REAL,
                accuracy_pct REAL,
                damage_efficiency REAL,
                score_total REAL,
                score_total_derived REAL,
                kills REAL,
                shots_fired REAL,
                shots_hit REAL,
                PRIMARY KEY(session_id, t_sec),
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_run_timelines_session ON session_run_timelines(session_id, t_sec);

            PRAGMA user_version = 2;
            COMMIT;
            ",
        )?;
    }

    Ok(())
}

pub fn upsert_run_capture(
    app: &AppHandle,
    session_id: &str,
    snapshot: &crate::bridge::BridgeRunSnapshot,
) -> Result<()> {
    let mut conn = connect(app)?;
    let tx = conn.transaction()?;

    tx.execute(
        "
        INSERT INTO session_run_summaries (
            session_id,
            duration_secs,
            score_total,
            score_total_derived,
            score_per_minute,
            shots_fired,
            shots_hit,
            kills,
            kills_per_second,
            damage_done,
            damage_possible,
            damage_efficiency,
            accuracy_pct,
            peak_score_per_minute,
            peak_kills_per_second,
            paired_shot_hits,
            avg_fire_to_hit_ms,
            p90_fire_to_hit_ms,
            avg_shots_to_hit,
            corrective_shot_ratio,
            started_at_unix_ms,
            ended_at_unix_ms,
            shot_fired_events,
            shot_hit_events,
            kill_events,
            challenge_queued_events,
            challenge_start_events,
            challenge_end_events,
            challenge_complete_events,
            challenge_canceled_events
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30)
        ON CONFLICT(session_id) DO UPDATE SET
            duration_secs = excluded.duration_secs,
            score_total = excluded.score_total,
            score_total_derived = excluded.score_total_derived,
            score_per_minute = excluded.score_per_minute,
            shots_fired = excluded.shots_fired,
            shots_hit = excluded.shots_hit,
            kills = excluded.kills,
            kills_per_second = excluded.kills_per_second,
            damage_done = excluded.damage_done,
            damage_possible = excluded.damage_possible,
            damage_efficiency = excluded.damage_efficiency,
            accuracy_pct = excluded.accuracy_pct,
            peak_score_per_minute = excluded.peak_score_per_minute,
            peak_kills_per_second = excluded.peak_kills_per_second,
            paired_shot_hits = excluded.paired_shot_hits,
            avg_fire_to_hit_ms = excluded.avg_fire_to_hit_ms,
            p90_fire_to_hit_ms = excluded.p90_fire_to_hit_ms,
            avg_shots_to_hit = excluded.avg_shots_to_hit,
            corrective_shot_ratio = excluded.corrective_shot_ratio,
            started_at_unix_ms = excluded.started_at_unix_ms,
            ended_at_unix_ms = excluded.ended_at_unix_ms,
            shot_fired_events = excluded.shot_fired_events,
            shot_hit_events = excluded.shot_hit_events,
            kill_events = excluded.kill_events,
            challenge_queued_events = excluded.challenge_queued_events,
            challenge_start_events = excluded.challenge_start_events,
            challenge_end_events = excluded.challenge_end_events,
            challenge_complete_events = excluded.challenge_complete_events,
            challenge_canceled_events = excluded.challenge_canceled_events
        ",
        params![
            session_id,
            snapshot.duration_secs,
            snapshot.score_total,
            snapshot.score_total_derived,
            snapshot.score_per_minute,
            snapshot.shots_fired,
            snapshot.shots_hit,
            snapshot.kills,
            snapshot.kills_per_second,
            snapshot.damage_done,
            snapshot.damage_possible,
            snapshot.damage_efficiency,
            snapshot.accuracy_pct,
            snapshot.peak_score_per_minute,
            snapshot.peak_kills_per_second,
            snapshot.paired_shot_hits as i64,
            snapshot.avg_fire_to_hit_ms,
            snapshot.p90_fire_to_hit_ms,
            snapshot.avg_shots_to_hit,
            snapshot.corrective_shot_ratio,
            snapshot.started_at_unix_ms.map(|value| value as i64),
            snapshot.ended_at_unix_ms.map(|value| value as i64),
            snapshot.event_counts.shot_fired_events as i64,
            snapshot.event_counts.shot_hit_events as i64,
            snapshot.event_counts.kill_events as i64,
            snapshot.event_counts.challenge_queued_events as i64,
            snapshot.event_counts.challenge_start_events as i64,
            snapshot.event_counts.challenge_end_events as i64,
            snapshot.event_counts.challenge_complete_events as i64,
            snapshot.event_counts.challenge_canceled_events as i64,
        ],
    )?;

    tx.execute(
        "DELETE FROM session_run_timelines WHERE session_id = ?1",
        params![session_id],
    )?;

    {
        let mut insert = tx.prepare(
            "
            INSERT INTO session_run_timelines (
                session_id,
                t_sec,
                score_per_minute,
                kills_per_second,
                accuracy_pct,
                damage_efficiency,
                score_total,
                score_total_derived,
                kills,
                shots_fired,
                shots_hit
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ",
        )?;

        for point in &snapshot.timeline {
            insert.execute(params![
                session_id,
                point.t_sec as i64,
                point.score_per_minute,
                point.kills_per_second,
                point.accuracy_pct,
                point.damage_efficiency,
                point.score_total,
                point.score_total_derived,
                point.kills,
                point.shots_fired,
                point.shots_hit,
            ])?;
        }
    }

    tx.commit()?;
    Ok(())
}

pub fn get_run_summary(
    app: &AppHandle,
    session_id: &str,
) -> Result<Option<crate::bridge::BridgeRunSnapshot>> {
    let conn = connect(app)?;
    conn.query_row(
        "
        SELECT
            duration_secs,
            score_total,
            score_total_derived,
            score_per_minute,
            shots_fired,
            shots_hit,
            kills,
            kills_per_second,
            damage_done,
            damage_possible,
            damage_efficiency,
            accuracy_pct,
            peak_score_per_minute,
            peak_kills_per_second,
            paired_shot_hits,
            avg_fire_to_hit_ms,
            p90_fire_to_hit_ms,
            avg_shots_to_hit,
            corrective_shot_ratio,
            started_at_unix_ms,
            ended_at_unix_ms,
            shot_fired_events,
            shot_hit_events,
            kill_events,
            challenge_queued_events,
            challenge_start_events,
            challenge_end_events,
            challenge_complete_events,
            challenge_canceled_events
        FROM session_run_summaries
        WHERE session_id = ?1
        ",
        params![session_id],
        |row| {
            Ok(crate::bridge::BridgeRunSnapshot {
                duration_secs: row.get(0)?,
                score_total: row.get(1)?,
                score_total_derived: row.get(2)?,
                score_per_minute: row.get(3)?,
                shots_fired: row.get(4)?,
                shots_hit: row.get(5)?,
                kills: row.get(6)?,
                kills_per_second: row.get(7)?,
                damage_done: row.get(8)?,
                damage_possible: row.get(9)?,
                damage_efficiency: row.get(10)?,
                accuracy_pct: row.get(11)?,
                peak_score_per_minute: row.get(12)?,
                peak_kills_per_second: row.get(13)?,
                paired_shot_hits: row.get::<_, i64>(14)? as u32,
                avg_fire_to_hit_ms: row.get(15)?,
                p90_fire_to_hit_ms: row.get(16)?,
                avg_shots_to_hit: row.get(17)?,
                corrective_shot_ratio: row.get(18)?,
                started_at_unix_ms: row.get::<_, Option<i64>>(19)?.map(|value| value as u64),
                ended_at_unix_ms: row.get::<_, Option<i64>>(20)?.map(|value| value as u64),
                event_counts: crate::bridge::BridgeRunEventCounts {
                    shot_fired_events: row.get::<_, i64>(21)? as u32,
                    shot_hit_events: row.get::<_, i64>(22)? as u32,
                    kill_events: row.get::<_, i64>(23)? as u32,
                    challenge_queued_events: row.get::<_, i64>(24)? as u32,
                    challenge_start_events: row.get::<_, i64>(25)? as u32,
                    challenge_end_events: row.get::<_, i64>(26)? as u32,
                    challenge_complete_events: row.get::<_, i64>(27)? as u32,
                    challenge_canceled_events: row.get::<_, i64>(28)? as u32,
                },
                timeline: vec![],
                tick_stream_v1: None,
            })
        },
    )
    .optional()
    .context("could not load run summary")
}

pub fn get_run_timeline(
    app: &AppHandle,
    session_id: &str,
) -> Result<Vec<crate::bridge::BridgeRunTimelinePoint>> {
    let conn = connect(app)?;
    let mut stmt = conn.prepare(
        "
        SELECT
            t_sec,
            score_per_minute,
            kills_per_second,
            accuracy_pct,
            damage_efficiency,
            score_total,
            score_total_derived,
            kills,
            shots_fired,
            shots_hit
        FROM session_run_timelines
        WHERE session_id = ?1
        ORDER BY t_sec ASC
        ",
    )?;
    let rows = stmt.query_map(params![session_id], |row| {
        Ok(crate::bridge::BridgeRunTimelinePoint {
            t_sec: row.get::<_, i64>(0)? as u32,
            score_per_minute: row.get(1)?,
            kills_per_second: row.get(2)?,
            accuracy_pct: row.get(3)?,
            damage_efficiency: row.get(4)?,
            score_total: row.get(5)?,
            score_total_derived: row.get(6)?,
            kills: row.get(7)?,
            shots_fired: row.get(8)?,
            shots_hit: row.get(9)?,
        })
    })?;

    let mut timeline = Vec::new();
    for row in rows {
        timeline.push(row?);
    }
    Ok(timeline)
}