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
