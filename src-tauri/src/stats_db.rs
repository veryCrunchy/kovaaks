use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const DB_FILE_NAME: &str = "stats.sqlite3";
const SCHEMA_VERSION: i32 = 7;

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
    let updated_at_unix_ms = current_unix_ms();

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

pub fn upsert_replay_payload(
    app: &AppHandle,
    session_id: &str,
    replay: &crate::replay_store::ReplayData,
) -> Result<()> {
    let mut conn = connect(app)?;
    let tx = conn.transaction()?;

    tx.execute(
        "DELETE FROM session_replay_positions WHERE session_id = ?1",
        params![session_id],
    )?;
    tx.execute(
        "DELETE FROM session_replay_metrics WHERE session_id = ?1",
        params![session_id],
    )?;
    tx.execute(
        "DELETE FROM session_replay_frames WHERE session_id = ?1",
        params![session_id],
    )?;

    {
        let mut insert = tx.prepare(
            "
            INSERT INTO session_replay_positions (
                session_id,
                seq_idx,
                x,
                y,
                timestamp_ms,
                is_click
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ",
        )?;
        for (index, point) in replay.positions.iter().enumerate() {
            insert.execute(params![
                session_id,
                index as i64,
                point.x,
                point.y,
                point.timestamp_ms as i64,
                if point.is_click { 1i64 } else { 0i64 },
            ])?;
        }
    }

    {
        let mut insert = tx.prepare(
            "
            INSERT INTO session_replay_metrics (
                session_id,
                seq_idx,
                timestamp_ms,
                smoothness,
                jitter,
                overshoot_rate,
                velocity_std,
                avg_speed,
                path_efficiency,
                click_timing_cv,
                correction_ratio,
                directional_bias,
                avg_hold_ms
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ",
        )?;
        for (index, point) in replay.metrics.iter().enumerate() {
            insert.execute(params![
                session_id,
                index as i64,
                point.timestamp_ms as i64,
                point.metrics.smoothness,
                point.metrics.jitter,
                point.metrics.overshoot_rate,
                point.metrics.velocity_std,
                point.metrics.avg_speed,
                point.metrics.path_efficiency,
                point.metrics.click_timing_cv,
                point.metrics.correction_ratio,
                point.metrics.directional_bias,
                point.metrics.avg_hold_ms,
            ])?;
        }
    }

    {
        let mut insert = tx.prepare(
            "
            INSERT INTO session_replay_frames (
                session_id,
                seq_idx,
                timestamp_ms,
                jpeg_b64
            )
            VALUES (?1, ?2, ?3, ?4)
            ",
        )?;
        for (index, frame) in replay.frames.iter().enumerate() {
            insert.execute(params![
                session_id,
                index as i64,
                frame.timestamp_ms as i64,
                frame.jpeg_b64,
            ])?;
        }
    }

    tx.execute(
        "DELETE FROM session_replay_payloads WHERE session_id = ?1",
        params![session_id],
    )?;

    tx.commit()?;

    Ok(())
}

pub fn get_replay_data(
    app: &AppHandle,
    session_id: &str,
) -> Result<Option<crate::replay_store::ReplayData>> {
    let conn = connect(app)?;
    let has_replay_asset = conn
        .query_row(
            "
            SELECT 1
            FROM replay_assets
            WHERE session_id = ?1
            ",
            params![session_id],
            |_| Ok(()),
        )
        .optional()
        .context("could not load replay asset marker")?
        .is_some();

    let positions = query_replay_positions(&conn, session_id)?;
    let metrics = query_replay_metrics(&conn, session_id)?;
    let frames = query_replay_frames(&conn, session_id)?;
    let mut run_snapshot = get_run_summary(app, session_id)?;
    if let Some(snapshot) = run_snapshot.as_mut() {
        snapshot.shot_telemetry = query_shot_telemetry(&conn, session_id)?;
    }

    if !has_replay_asset
        && positions.is_empty()
        && metrics.is_empty()
        && frames.is_empty()
        && run_snapshot.is_none()
    {
        return Ok(None);
    }

    Ok(Some(crate::replay_store::ReplayData {
        positions,
        metrics,
        frames,
        run_snapshot,
    }))
}

pub fn get_legacy_replay_blob(
    app: &AppHandle,
    session_id: &str,
) -> Result<Option<crate::replay_store::ReplayData>> {
    let conn = connect(app)?;
    let replay_json = conn
        .query_row(
            "
            SELECT replay_json
            FROM session_replay_payloads
            WHERE session_id = ?1
            ",
            params![session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .context("could not load legacy replay payload")?;

    replay_json
        .map(|json| {
            serde_json::from_str::<crate::replay_store::ReplayData>(&json)
                .context("could not parse legacy replay payload")
        })
        .transpose()
}

pub fn delete_legacy_replay_blob(app: &AppHandle, session_id: &str) -> Result<()> {
    let conn = connect(app)?;
    conn.execute(
        "DELETE FROM session_replay_payloads WHERE session_id = ?1",
        params![session_id],
    )?;
    Ok(())
}

fn db_path(app: &AppHandle) -> Result<PathBuf> {
    let data_dir = app
        .path()
        .app_data_dir()
        .context("could not resolve app data directory for stats database")?;
    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("could not create app data directory {}", data_dir.display()))?;
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

fn current_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
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

    if user_version < 3 {
        conn.execute_batch(
            "
            BEGIN;
            CREATE TABLE IF NOT EXISTS session_replay_payloads (
                session_id TEXT PRIMARY KEY,
                replay_json TEXT NOT NULL,
                updated_at_unix_ms INTEGER NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_replay_payloads_updated_at ON session_replay_payloads(updated_at_unix_ms);

            PRAGMA user_version = 3;
            COMMIT;
            ",
        )?;
    }

    if user_version < 4 {
        conn.execute_batch(
            "
            BEGIN;
            CREATE TABLE IF NOT EXISTS session_smoothness (
                session_id TEXT PRIMARY KEY,
                composite REAL NOT NULL,
                jitter REAL NOT NULL,
                overshoot_rate REAL NOT NULL,
                velocity_std REAL NOT NULL,
                path_efficiency REAL NOT NULL,
                avg_speed REAL NOT NULL,
                click_timing_cv REAL NOT NULL,
                correction_ratio REAL NOT NULL,
                directional_bias REAL NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS session_stats_panels (
                session_id TEXT PRIMARY KEY,
                scenario_type TEXT NOT NULL,
                kills INTEGER,
                avg_kps REAL,
                accuracy_pct REAL,
                total_damage REAL,
                avg_ttk_ms REAL,
                best_ttk_ms REAL,
                ttk_std_ms REAL,
                accuracy_trend REAL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS session_shot_timings (
                session_id TEXT PRIMARY KEY,
                paired_shot_hits INTEGER NOT NULL DEFAULT 0,
                avg_fire_to_hit_ms REAL,
                p90_fire_to_hit_ms REAL,
                avg_shots_to_hit REAL,
                corrective_shot_ratio REAL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS session_replay_positions (
                session_id TEXT NOT NULL,
                seq_idx INTEGER NOT NULL,
                x REAL NOT NULL,
                y REAL NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                is_click INTEGER NOT NULL DEFAULT 0 CHECK (is_click IN (0, 1)),
                PRIMARY KEY(session_id, seq_idx),
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_replay_positions_session ON session_replay_positions(session_id, seq_idx);

            CREATE TABLE IF NOT EXISTS session_replay_metrics (
                session_id TEXT NOT NULL,
                seq_idx INTEGER NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                smoothness REAL NOT NULL,
                jitter REAL NOT NULL,
                overshoot_rate REAL NOT NULL,
                velocity_std REAL NOT NULL,
                avg_speed REAL NOT NULL,
                path_efficiency REAL NOT NULL,
                click_timing_cv REAL NOT NULL,
                correction_ratio REAL NOT NULL,
                directional_bias REAL NOT NULL,
                avg_hold_ms REAL NOT NULL,
                PRIMARY KEY(session_id, seq_idx),
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_replay_metrics_session ON session_replay_metrics(session_id, seq_idx);

            CREATE TABLE IF NOT EXISTS session_replay_frames (
                session_id TEXT NOT NULL,
                seq_idx INTEGER NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                jpeg_b64 TEXT NOT NULL,
                PRIMARY KEY(session_id, seq_idx),
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_replay_frames_session ON session_replay_frames(session_id, seq_idx);

            PRAGMA user_version = 4;
            COMMIT;
            ",
        )?;
    }

    if user_version < 5 {
        conn.execute_batch(
            "
            BEGIN;
            CREATE TABLE IF NOT EXISTS session_shot_events (
                session_id TEXT NOT NULL,
                shot_seq_idx INTEGER NOT NULL,
                event_kind TEXT NOT NULL,
                ts_ms INTEGER NOT NULL,
                count INTEGER,
                total INTEGER,
                run_id INTEGER,
                sample_seq INTEGER,
                sample_count INTEGER,
                source TEXT,
                method TEXT,
                origin_flag TEXT,
                player_entity_id TEXT,
                player_profile TEXT,
                player_is_player INTEGER,
                player_is_bot INTEGER,
                player_x REAL,
                player_y REAL,
                player_z REAL,
                player_pitch REAL,
                player_yaw REAL,
                player_roll REAL,
                player_vx REAL,
                player_vy REAL,
                player_vz REAL,
                PRIMARY KEY(session_id, shot_seq_idx),
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_shot_events_session_ts
                ON session_shot_events(session_id, ts_ms, shot_seq_idx);

            CREATE TABLE IF NOT EXISTS session_shot_targets (
                session_id TEXT NOT NULL,
                shot_seq_idx INTEGER NOT NULL,
                target_idx INTEGER NOT NULL,
                entity_id TEXT NOT NULL,
                profile TEXT NOT NULL,
                is_player INTEGER NOT NULL DEFAULT 0 CHECK (is_player IN (0, 1)),
                is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
                x REAL NOT NULL,
                y REAL NOT NULL,
                z REAL NOT NULL,
                pitch REAL NOT NULL,
                yaw REAL NOT NULL,
                roll REAL NOT NULL,
                vx REAL NOT NULL,
                vy REAL NOT NULL,
                vz REAL NOT NULL,
                distance_2d REAL,
                distance_3d REAL,
                yaw_error_deg REAL,
                pitch_error_deg REAL,
                is_nearest INTEGER NOT NULL DEFAULT 0 CHECK (is_nearest IN (0, 1)),
                PRIMARY KEY(session_id, shot_seq_idx, target_idx),
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_shot_targets_session_seq
                ON session_shot_targets(session_id, shot_seq_idx, target_idx);

            PRAGMA user_version = 5;
            COMMIT;
            ",
        )?;
    }

    if user_version < 6 {
        conn.execute_batch(
            "
            BEGIN;
            ALTER TABLE session_stats_panels ADD COLUMN scenario_subtype TEXT;
            PRAGMA user_version = 6;
            COMMIT;
            ",
        )?;
    }

    if user_version < 7 {
        conn.execute_batch(
            "
            BEGIN;
            ALTER TABLE session_shot_events ADD COLUMN count INTEGER;
            PRAGMA user_version = 7;
            COMMIT;
            ",
        )
        .or_else(|_| {
            conn.execute_batch(
                "
                BEGIN;
                PRAGMA user_version = 7;
                COMMIT;
                ",
            )
        })?;
    }

    Ok(())
}

fn query_replay_positions(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<crate::mouse_hook::RawPositionPoint>> {
    let mut stmt = conn.prepare(
        "
        SELECT x, y, timestamp_ms, is_click
        FROM session_replay_positions
        WHERE session_id = ?1
        ORDER BY seq_idx ASC
        ",
    )?;
    let rows = stmt.query_map(params![session_id], |row| {
        Ok(crate::mouse_hook::RawPositionPoint {
            x: row.get(0)?,
            y: row.get(1)?,
            timestamp_ms: row.get::<_, i64>(2)? as u64,
            is_click: row.get::<_, i64>(3)? != 0,
        })
    })?;

    let mut positions = Vec::new();
    for row in rows {
        positions.push(row?);
    }
    Ok(positions)
}

fn query_replay_metrics(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<crate::mouse_hook::MetricPoint>> {
    let mut stmt = conn.prepare(
        "
        SELECT
            timestamp_ms,
            smoothness,
            jitter,
            overshoot_rate,
            velocity_std,
            avg_speed,
            path_efficiency,
            click_timing_cv,
            correction_ratio,
            directional_bias,
            avg_hold_ms
        FROM session_replay_metrics
        WHERE session_id = ?1
        ORDER BY seq_idx ASC
        ",
    )?;
    let rows = stmt.query_map(params![session_id], |row| {
        Ok(crate::mouse_hook::MetricPoint {
            timestamp_ms: row.get::<_, i64>(0)? as u64,
            metrics: crate::mouse_hook::MouseMetrics {
                smoothness: row.get(1)?,
                jitter: row.get(2)?,
                overshoot_rate: row.get(3)?,
                velocity_std: row.get(4)?,
                avg_speed: row.get(5)?,
                path_efficiency: row.get(6)?,
                click_timing_cv: row.get(7)?,
                correction_ratio: row.get(8)?,
                directional_bias: row.get(9)?,
                avg_hold_ms: row.get(10)?,
            },
        })
    })?;

    let mut metrics = Vec::new();
    for row in rows {
        metrics.push(row?);
    }
    Ok(metrics)
}

fn query_replay_frames(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<crate::screen_recorder::ScreenFrame>> {
    let mut stmt = conn.prepare(
        "
        SELECT timestamp_ms, jpeg_b64
        FROM session_replay_frames
        WHERE session_id = ?1
        ORDER BY seq_idx ASC
        ",
    )?;
    let rows = stmt.query_map(params![session_id], |row| {
        Ok(crate::screen_recorder::ScreenFrame {
            timestamp_ms: row.get::<_, i64>(0)? as u64,
            jpeg_b64: row.get(1)?,
        })
    })?;

    let mut frames = Vec::new();
    for row in rows {
        frames.push(row?);
    }
    Ok(frames)
}

fn query_shot_telemetry(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<crate::bridge::BridgeShotTelemetryEvent>> {
    let mut stmt = conn.prepare(
        "
        SELECT
            e.shot_seq_idx AS shot_seq_idx,
            e.event_kind AS event_kind,
            e.ts_ms AS ts_ms,
            e.count AS count,
            e.total AS total,
            e.run_id AS run_id,
            e.sample_seq AS sample_seq,
            e.sample_count AS sample_count,
            e.source AS source,
            e.method AS method,
            e.origin_flag AS origin_flag,
            e.player_entity_id AS player_entity_id,
            e.player_profile AS player_profile,
            e.player_is_player AS player_is_player,
            e.player_is_bot AS player_is_bot,
            e.player_x AS player_x,
            e.player_y AS player_y,
            e.player_z AS player_z,
            e.player_pitch AS player_pitch,
            e.player_yaw AS player_yaw,
            e.player_roll AS player_roll,
            e.player_vx AS player_vx,
            e.player_vy AS player_vy,
            e.player_vz AS player_vz,
            t.target_idx AS target_idx,
            t.entity_id AS target_entity_id,
            t.profile AS target_profile,
            t.is_player AS target_is_player,
            t.is_bot AS target_is_bot,
            t.x AS target_x,
            t.y AS target_y,
            t.z AS target_z,
            t.pitch AS target_pitch,
            t.yaw AS target_yaw,
            t.roll AS target_roll,
            t.vx AS target_vx,
            t.vy AS target_vy,
            t.vz AS target_vz,
            t.distance_2d AS target_distance_2d,
            t.distance_3d AS target_distance_3d,
            t.yaw_error_deg AS target_yaw_error_deg,
            t.pitch_error_deg AS target_pitch_error_deg,
            t.is_nearest AS target_is_nearest
        FROM session_shot_events e
        LEFT JOIN session_shot_targets t
            ON t.session_id = e.session_id
           AND t.shot_seq_idx = e.shot_seq_idx
        WHERE e.session_id = ?1
        ORDER BY e.shot_seq_idx ASC, t.target_idx ASC
        ",
    )?;

    let mut rows = stmt.query(params![session_id])?;
    let mut events = Vec::new();
    let mut current_seq_idx: Option<i64> = None;
    let mut current_event: Option<crate::bridge::BridgeShotTelemetryEvent> = None;

    while let Some(row) = rows.next()? {
        let shot_seq_idx = row.get::<_, i64>("shot_seq_idx")?;
        if current_seq_idx != Some(shot_seq_idx) {
            if let Some(event) = current_event.take() {
                events.push(event);
            }

            let player_entity_id = row.get::<_, Option<String>>("player_entity_id")?;
            let player = if let Some(entity_id) = player_entity_id {
                Some(crate::bridge::BridgeShotTelemetryEntity {
                    entity_id,
                    profile: row
                        .get::<_, Option<String>>("player_profile")?
                        .unwrap_or_default(),
                    is_player: row
                        .get::<_, Option<i64>>("player_is_player")?
                        .unwrap_or_default()
                        != 0,
                    is_bot: row
                        .get::<_, Option<i64>>("player_is_bot")?
                        .unwrap_or_default()
                        != 0,
                    x: row.get::<_, Option<f64>>("player_x")?.unwrap_or_default(),
                    y: row.get::<_, Option<f64>>("player_y")?.unwrap_or_default(),
                    z: row.get::<_, Option<f64>>("player_z")?.unwrap_or_default(),
                    pitch: row
                        .get::<_, Option<f64>>("player_pitch")?
                        .unwrap_or_default(),
                    yaw: row.get::<_, Option<f64>>("player_yaw")?.unwrap_or_default(),
                    roll: row
                        .get::<_, Option<f64>>("player_roll")?
                        .unwrap_or_default(),
                    vx: row.get::<_, Option<f64>>("player_vx")?.unwrap_or_default(),
                    vy: row.get::<_, Option<f64>>("player_vy")?.unwrap_or_default(),
                    vz: row.get::<_, Option<f64>>("player_vz")?.unwrap_or_default(),
                })
            } else {
                None
            };
            current_event = Some(crate::bridge::BridgeShotTelemetryEvent {
                event: row.get::<_, String>("event_kind")?,
                ts_ms: row.get::<_, i64>("ts_ms")? as u64,
                count: row
                    .get::<_, Option<i64>>("count")?
                    .map(|value| value as u32),
                total: row
                    .get::<_, Option<i64>>("total")?
                    .map(|value| value as u32),
                run_id: row
                    .get::<_, Option<i64>>("run_id")?
                    .map(|value| value as u64),
                sample_seq: row
                    .get::<_, Option<i64>>("sample_seq")?
                    .map(|value| value as u64),
                sample_count: row
                    .get::<_, Option<i64>>("sample_count")?
                    .map(|value| value as u64),
                source: row.get("source")?,
                method: row.get("method")?,
                origin_flag: row.get("origin_flag")?,
                player,
                targets: Vec::new(),
            });
            current_seq_idx = Some(shot_seq_idx);
        }

        let target_entity_id = row.get::<_, Option<String>>("target_entity_id")?;
        if let (Some(event), Some(entity_id)) = (current_event.as_mut(), target_entity_id) {
            event
                .targets
                .push(crate::bridge::BridgeShotTelemetryTarget {
                    entity_id,
                    profile: row.get::<_, String>("target_profile")?,
                    is_player: row.get::<_, i64>("target_is_player")? != 0,
                    is_bot: row.get::<_, i64>("target_is_bot")? != 0,
                    x: row.get("target_x")?,
                    y: row.get("target_y")?,
                    z: row.get("target_z")?,
                    pitch: row.get("target_pitch")?,
                    yaw: row.get("target_yaw")?,
                    roll: row.get("target_roll")?,
                    vx: row.get("target_vx")?,
                    vy: row.get("target_vy")?,
                    vz: row.get("target_vz")?,
                    distance_2d: row.get("target_distance_2d")?,
                    distance_3d: row.get("target_distance_3d")?,
                    yaw_error_deg: row.get("target_yaw_error_deg")?,
                    pitch_error_deg: row.get("target_pitch_error_deg")?,
                    is_nearest: row.get::<_, i64>("target_is_nearest")? != 0,
                });
        }
    }

    if let Some(event) = current_event {
        events.push(event);
    }

    Ok(events)
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

    let mut conn = connect(app)?;
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM session_shot_targets WHERE session_id = ?1",
        params![session_id],
    )?;
    tx.execute(
        "DELETE FROM session_shot_events WHERE session_id = ?1",
        params![session_id],
    )?;

    {
        let mut insert_event = tx.prepare(
            "
            INSERT INTO session_shot_events (
                session_id,
                shot_seq_idx,
                event_kind,
                ts_ms,
                count,
                total,
                run_id,
                sample_seq,
                sample_count,
                source,
                method,
                origin_flag,
                player_entity_id,
                player_profile,
                player_is_player,
                player_is_bot,
                player_x,
                player_y,
                player_z,
                player_pitch,
                player_yaw,
                player_roll,
                player_vx,
                player_vy,
                player_vz
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)
            ",
        )?;
        let mut insert_target = tx.prepare(
            "
            INSERT INTO session_shot_targets (
                session_id,
                shot_seq_idx,
                target_idx,
                entity_id,
                profile,
                is_player,
                is_bot,
                x,
                y,
                z,
                pitch,
                yaw,
                roll,
                vx,
                vy,
                vz,
                distance_2d,
                distance_3d,
                yaw_error_deg,
                pitch_error_deg,
                is_nearest
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
            ",
        )?;

        for (event_index, event) in snapshot.shot_telemetry.iter().enumerate() {
            let player = event.player.as_ref();
            insert_event.execute(params![
                session_id,
                event_index as i64,
                &event.event,
                event.ts_ms as i64,
                event.count.map(|value| value as i64),
                event.total.map(|value| value as i64),
                event.run_id.map(|value| value as i64),
                event.sample_seq.map(|value| value as i64),
                event.sample_count.map(|value| value as i64),
                event.source.as_deref(),
                event.method.as_deref(),
                event.origin_flag.as_deref(),
                player.map(|value| value.entity_id.as_str()),
                player.map(|value| value.profile.as_str()),
                player.map(|value| if value.is_player { 1i64 } else { 0i64 }),
                player.map(|value| if value.is_bot { 1i64 } else { 0i64 }),
                player.map(|value| value.x),
                player.map(|value| value.y),
                player.map(|value| value.z),
                player.map(|value| value.pitch),
                player.map(|value| value.yaw),
                player.map(|value| value.roll),
                player.map(|value| value.vx),
                player.map(|value| value.vy),
                player.map(|value| value.vz),
            ])?;

            for (target_index, target) in event.targets.iter().enumerate() {
                insert_target.execute(params![
                    session_id,
                    event_index as i64,
                    target_index as i64,
                    &target.entity_id,
                    &target.profile,
                    if target.is_player { 1i64 } else { 0i64 },
                    if target.is_bot { 1i64 } else { 0i64 },
                    target.x,
                    target.y,
                    target.z,
                    target.pitch,
                    target.yaw,
                    target.roll,
                    target.vx,
                    target.vy,
                    target.vz,
                    target.distance_2d,
                    target.distance_3d,
                    target.yaw_error_deg,
                    target.pitch_error_deg,
                    if target.is_nearest { 1i64 } else { 0i64 },
                ])?;
            }
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
                shot_telemetry: vec![],
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

pub fn get_shot_telemetry(
    app: &AppHandle,
    session_id: &str,
) -> Result<Vec<crate::bridge::BridgeShotTelemetryEvent>> {
    let conn = connect(app)?;
    query_shot_telemetry(&conn, session_id)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionSqlAudit {
    pub session_id: String,
    pub session_exists: bool,
    pub replay_asset_exists: bool,
    pub replay_asset_has_run_snapshot: bool,
    pub replay_positions_rows: usize,
    pub replay_metrics_rows: usize,
    pub replay_frames_rows: usize,
    pub run_summary_rows: usize,
    pub run_timeline_rows: usize,
    pub shot_event_rows: usize,
    pub shot_target_rows: usize,
    pub summary_shots_fired: Option<f64>,
    pub summary_shots_hit: Option<f64>,
    pub issues: Vec<String>,
}

impl SessionSqlAudit {
    pub fn has_issues(&self) -> bool {
        !self.issues.is_empty()
    }
}

pub fn audit_session_sql(app: &AppHandle, session_id: &str) -> Result<SessionSqlAudit> {
    let conn = connect(app)?;
    let mut audit = conn.query_row(
        "
        SELECT
            EXISTS(SELECT 1 FROM sessions WHERE id = ?1) AS session_exists,
            EXISTS(SELECT 1 FROM replay_assets WHERE session_id = ?1) AS replay_asset_exists,
            COALESCE((SELECT has_run_snapshot FROM replay_assets WHERE session_id = ?1), 0) AS replay_asset_has_run_snapshot,
            (SELECT COUNT(*) FROM session_replay_positions WHERE session_id = ?1) AS replay_positions_rows,
            (SELECT COUNT(*) FROM session_replay_metrics WHERE session_id = ?1) AS replay_metrics_rows,
            (SELECT COUNT(*) FROM session_replay_frames WHERE session_id = ?1) AS replay_frames_rows,
            (SELECT COUNT(*) FROM session_run_summaries WHERE session_id = ?1) AS run_summary_rows,
            (SELECT COUNT(*) FROM session_run_timelines WHERE session_id = ?1) AS run_timeline_rows,
            (SELECT COUNT(*) FROM session_shot_events WHERE session_id = ?1) AS shot_event_rows,
            (SELECT COUNT(*) FROM session_shot_targets WHERE session_id = ?1) AS shot_target_rows,
            (SELECT shots_fired FROM session_run_summaries WHERE session_id = ?1) AS summary_shots_fired,
            (SELECT shots_hit FROM session_run_summaries WHERE session_id = ?1) AS summary_shots_hit
        ",
        params![session_id],
        |row| {
            Ok(SessionSqlAudit {
                session_id: session_id.to_string(),
                session_exists: row.get::<_, i64>(0)? != 0,
                replay_asset_exists: row.get::<_, i64>(1)? != 0,
                replay_asset_has_run_snapshot: row.get::<_, i64>(2)? != 0,
                replay_positions_rows: row.get::<_, i64>(3)? as usize,
                replay_metrics_rows: row.get::<_, i64>(4)? as usize,
                replay_frames_rows: row.get::<_, i64>(5)? as usize,
                run_summary_rows: row.get::<_, i64>(6)? as usize,
                run_timeline_rows: row.get::<_, i64>(7)? as usize,
                shot_event_rows: row.get::<_, i64>(8)? as usize,
                shot_target_rows: row.get::<_, i64>(9)? as usize,
                summary_shots_fired: row.get(10)?,
                summary_shots_hit: row.get(11)?,
                issues: Vec::new(),
            })
        },
    )?;

    if !audit.session_exists {
        audit.issues.push("missing sessions row".to_string());
    }
    if audit.replay_asset_exists
        && audit.replay_positions_rows == 0
        && audit.replay_metrics_rows == 0
        && audit.replay_frames_rows == 0
    {
        audit
            .issues
            .push("replay asset exists but replay payload tables are empty".to_string());
    }
    if audit.replay_asset_has_run_snapshot && audit.run_summary_rows == 0 {
        audit
            .issues
            .push("replay asset expects run snapshot but session_run_summaries is empty".to_string());
    }
    if audit.run_summary_rows > 0 && audit.run_timeline_rows == 0 {
        audit
            .issues
            .push("run summary exists but session_run_timelines is empty".to_string());
    }
    let expects_shot_rows = audit.summary_shots_fired.unwrap_or(0.0) > 0.0
        || audit.summary_shots_hit.unwrap_or(0.0) > 0.0;
    if expects_shot_rows && audit.shot_event_rows == 0 {
        audit
            .issues
            .push("run summary has shots but session_shot_events is empty".to_string());
    }
    if audit.shot_event_rows > 0 && audit.shot_target_rows == 0 {
        audit
            .issues
            .push("session_shot_events exists but session_shot_targets is empty".to_string());
    }

    Ok(audit)
}

pub fn backfill_session_classifications(app: &AppHandle) -> Result<usize> {
    #[derive(Clone)]
    struct ClassificationRow {
        session_id: String,
        stats_panel: crate::session_store::StatsPanelSnapshot,
        run_summary: Option<crate::bridge::BridgeRunSnapshot>,
    }

    let mut conn = connect(app)?;
    let rows = {
        let mut stmt = conn.prepare(
            "
            SELECT
                sp.session_id,
                sp.scenario_type,
                sp.scenario_subtype,
                sp.kills,
                sp.avg_kps,
                sp.accuracy_pct,
                sp.total_damage,
                sp.avg_ttk_ms,
                sp.best_ttk_ms,
                sp.ttk_std_ms,
                sp.accuracy_trend,
                rs.shots_fired,
                rs.shots_hit,
                rs.kills,
                rs.kills_per_second,
                rs.damage_done,
                rs.damage_possible
            FROM session_stats_panels sp
            LEFT JOIN session_run_summaries rs ON rs.session_id = sp.session_id
            ",
        )?;
        stmt.query_map([], |row| {
            let shots_fired = row.get::<_, Option<f64>>(11)?;
            let shots_hit = row.get::<_, Option<f64>>(12)?;
            let kills = row.get::<_, Option<f64>>(13)?;
            let kills_per_second = row.get::<_, Option<f64>>(14)?;
            let damage_done = row.get::<_, Option<f64>>(15)?;
            let damage_possible = row.get::<_, Option<f64>>(16)?;
            let has_run_summary = shots_fired.is_some()
                || shots_hit.is_some()
                || kills.is_some()
                || kills_per_second.is_some()
                || damage_done.is_some()
                || damage_possible.is_some();

            Ok(ClassificationRow {
                session_id: row.get(0)?,
                stats_panel: crate::session_store::StatsPanelSnapshot {
                    scenario_type: row.get(1)?,
                    scenario_subtype: row.get(2)?,
                    kills: row.get::<_, Option<i64>>(3)?.map(|value| value as u32),
                    avg_kps: row.get(4)?,
                    accuracy_pct: row.get(5)?,
                    total_damage: row.get(6)?,
                    avg_ttk_ms: row.get(7)?,
                    best_ttk_ms: row.get(8)?,
                    ttk_std_ms: row.get(9)?,
                    accuracy_trend: row.get(10)?,
                },
                run_summary: has_run_summary.then(|| crate::bridge::BridgeRunSnapshot {
                    duration_secs: None,
                    score_total: None,
                    score_total_derived: None,
                    score_per_minute: None,
                    shots_fired,
                    shots_hit,
                    kills,
                    kills_per_second,
                    damage_done,
                    damage_possible,
                    damage_efficiency: None,
                    accuracy_pct: None,
                    peak_score_per_minute: None,
                    peak_kills_per_second: None,
                    paired_shot_hits: 0,
                    avg_fire_to_hit_ms: None,
                    p90_fire_to_hit_ms: None,
                    avg_shots_to_hit: None,
                    corrective_shot_ratio: None,
                    started_at_unix_ms: None,
                    ended_at_unix_ms: None,
                    event_counts: crate::bridge::BridgeRunEventCounts::default(),
                    timeline: vec![],
                    shot_telemetry: vec![],
                    tick_stream_v1: None,
                }),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    };

    let mut updates = Vec::new();
    for row in rows {
        let shot_telemetry = query_shot_telemetry(&conn, &row.session_id)?;
        let classification = crate::bridge::classify_persisted_session(
            &row.stats_panel,
            row.run_summary.as_ref(),
            &shot_telemetry,
        );
        if classification.family == "Unknown" {
            continue;
        }
        if classification.family == row.stats_panel.scenario_type
            && classification.subtype == row.stats_panel.scenario_subtype
        {
            continue;
        }
        updates.push((row.session_id, classification));
    }

    if updates.is_empty() {
        return Ok(0);
    }

    let tx = conn.transaction()?;
    for (session_id, classification) in &updates {
        tx.execute(
            "
            UPDATE session_stats_panels
            SET scenario_type = ?2,
                scenario_subtype = ?3
            WHERE session_id = ?1
            ",
            params![session_id, &classification.family, &classification.subtype],
        )?;
    }
    tx.commit()?;

    Ok(updates.len())
}
