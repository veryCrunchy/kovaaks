use anyhow::{Context, Result};
use rusqlite::{Connection, params};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const DB_FILE_NAME: &str = "stats.sqlite3";
const SCHEMA_VERSION: i32 = 1;

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

    Ok(())
}