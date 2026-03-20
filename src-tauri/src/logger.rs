/// Custom logger that:
/// 1. Writes to a log file next to the executable (always, from startup)
/// 2. Writes to stderr for console visibility
/// 3. Stores entries in a ring buffer (2000 cap)
/// 4. Emits `log-entry` Tauri events once the AppHandle is registered
///
/// Call `logger::init()` before `tauri::Builder`, then
/// `logger::register_app(app.handle().clone())` in `.setup()`.
use log::{Level, Log, Metadata, Record};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

// ─── Public event name ─────────────────────────────────────────────────────────
pub const EVENT_LOG_ENTRY: &str = "log-entry";

// ─── Payload sent to the frontend ─────────────────────────────────────────────
#[derive(Serialize, Clone, Debug)]
pub struct LogEntry {
    pub ts: u64,       // ms since UNIX epoch
    pub level: String, // "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE"
    pub target: String,
    pub message: String,
}

// ─── Global state ──────────────────────────────────────────────────────────────
const RING_CAP: usize = 2000;

struct State {
    buffer: Vec<LogEntry>,
    app: Option<AppHandle>,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| {
    Mutex::new(State {
        buffer: Vec::with_capacity(RING_CAP),
        app: None,
    })
});

/// File writer — opened once in `init()`, appended to on every log call.
static LOG_FILE: Lazy<Mutex<Option<std::fs::File>>> = Lazy::new(|| Mutex::new(None));

/// Returns the path used for the log file (next to the exe, or temp dir as fallback).
pub fn log_file_path() -> std::path::PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            return dir.join("aimmod.log");
        }
    }
    std::env::temp_dir().join("aimmod.log")
}

// ─── Logger implementation ─────────────────────────────────────────────────────
struct TauriLogger;

impl Log for TauriLogger {
    fn enabled(&self, meta: &Metadata<'_>) -> bool {
        // Filter noisy crates down to WARN; everything else at DEBUG
        if meta.target().starts_with("tao")
            || meta.target().starts_with("wry")
            || meta.target().starts_with("tauri")
            || meta.target().starts_with("reqwest")
            || meta.target().starts_with("hyper")
            || meta.target().starts_with("h2")
            || meta.target().starts_with("rustls")
            || meta.target().starts_with("tokio")
        {
            meta.level() <= Level::Warn
        } else {
            meta.level() <= Level::Debug
        }
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let ts_ms = now.as_millis() as u64;

        // Format a single line for the file / stderr
        let line = format!(
            "{}.{:03} [{:<5}] {} — {}\n",
            now.as_secs(),
            now.subsec_millis(),
            record.level(),
            record.target(),
            record.args()
        );

        // Write to file (best-effort, never panic).
        // Flush is handled by the background flush thread — not per line.
        if let Some(f) = LOG_FILE.lock().as_mut() {
            let _ = f.write_all(line.as_bytes());
        }

        // Echo to stderr
        eprint!("{}", line);

        let entry = LogEntry {
            ts: ts_ms,
            level: record.level().to_string().to_uppercase(),
            target: record.target().to_string(),
            message: format!("{}", record.args()),
        };

        // Acquire lock only long enough to push the entry and clone the app handle.
        // We must NOT hold the lock while calling emit() — emit() can block on
        // windows that are loading, causing a deadlock with get_log_buffer callers.
        let app_handle = {
            let mut state = STATE.lock();
            if state.buffer.len() >= RING_CAP {
                state.buffer.remove(0);
            }
            state.buffer.push(entry.clone());
            state.app.clone()
        };

        // Emit outside the lock
        if let Some(app) = app_handle {
            let _ = app.emit(EVENT_LOG_ENTRY, &entry);
        }
    }

    fn flush(&self) {
        if let Some(f) = LOG_FILE.lock().as_mut() {
            let _ = f.flush();
        }
    }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/// Install as the global logger. Opens the log file and starts writing immediately.
/// Call once before `tauri::Builder::default()`.
pub fn init() -> Result<(), log::SetLoggerError> {
    // Open log file (truncate previous run so it stays small)
    let path = log_file_path();
    match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
    {
        Ok(f) => {
            *LOG_FILE.lock() = Some(f);
            eprintln!("Logging to file: {}", path.display());
        }
        Err(e) => {
            eprintln!("WARNING: could not open log file {}: {e}", path.display());
        }
    }

    static INSTANCE: TauriLogger = TauriLogger;
    log::set_logger(&INSTANCE)?;
    log::set_max_level(log::LevelFilter::Debug);

    // Flush the log file every 500 ms instead of after every line.
    // This reduces syscall pressure significantly while still keeping the file
    // reasonably up-to-date for crash analysis.
    std::thread::Builder::new()
        .name("log-flusher".into())
        .spawn(|| {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if let Some(f) = LOG_FILE.lock().as_mut() {
                    let _ = f.flush();
                }
            }
        })
        .ok();

    Ok(())
}

/// Register the AppHandle so live events start flowing. Call in `.setup()`.
pub fn register_app(app: AppHandle) {
    STATE.lock().app = Some(app);
}

/// Return all buffered entries (oldest → newest) for the initial page load.
pub fn get_buffer() -> Vec<LogEntry> {
    STATE.lock().buffer.clone()
}

/// Clear the buffer.
pub fn clear_buffer() {
    STATE.lock().buffer.clear();
}
