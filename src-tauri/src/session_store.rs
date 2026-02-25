/// Persistent session history store.
///
/// Each completed KovaaK's session is appended here with score, accuracy and a
/// smoothness snapshot averaged across the session. Stored in `sessions.json`
/// via tauri-plugin-store (same mechanism as settings.json).
///
/// Max 2000 sessions are kept; oldest are pruned automatically.
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const STORE_PATH: &str = "sessions.json";
const STORE_KEY: &str = "history";
const MAX_SESSIONS: usize = 2000;

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
    /// Raw timestamp string from the CSV filename (YYYY.MM.DD-HH.mm.ss)
    pub timestamp: String,
    /// Session-averaged smoothness metrics (None if mouse hook had no data)
    pub smoothness: Option<SmoothnessSnapshot>,
}

// ─── Public API ────────────────────────────────────────────────────────────────

pub fn add_session(app: &AppHandle, record: SessionRecord) {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(STORE_PATH) else {
        log::warn!("session_store: could not open {STORE_PATH}");
        return;
    };

    let mut sessions: Vec<SessionRecord> = store
        .get(STORE_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    sessions.push(record);

    // Prune oldest entries beyond the cap
    if sessions.len() > MAX_SESSIONS {
        sessions.drain(0..sessions.len() - MAX_SESSIONS);
    }

    store.set(
        STORE_KEY.to_string(),
        serde_json::to_value(&sessions).unwrap_or_default(),
    );
    if let Err(e) = store.save() {
        log::warn!("session_store: save error: {e}");
    }
}

pub fn get_all_sessions(app: &AppHandle) -> Vec<SessionRecord> {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(STORE_PATH) else {
        return vec![];
    };
    store
        .get(STORE_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn clear_sessions(app: &AppHandle) {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(STORE_PATH) else { return };
    store.set(STORE_KEY.to_string(), serde_json::Value::Array(vec![]));
    let _ = store.save();
}
