use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const STORE_PATH: &str = "settings.json";
const STORE_KEY: &str = "app_settings";

/// A rectangle defining an on-screen region.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct RegionRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Rich friend profile persisted in settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendProfile {
    pub username: String,
    pub steam_id: String,
    pub steam_account_name: String,
    pub avatar_url: String,
    pub country: String,
    pub kovaaks_plus: bool,
}

/// Persistent application settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// Path to KovaaK's stats directory.
    #[serde(default = "default_stats_dir")]
    pub stats_dir: String,
    /// Whether the overlay is currently visible.
    #[serde(default = "default_true")]
    pub overlay_visible: bool,
    /// The user's KovaaK's webapp username (used for VS Mode comparison and display).
    #[serde(default)]
    pub username: String,
    /// Which monitor index to show the overlay on (0 = primary).
    #[serde(default)]
    pub monitor_index: usize,
    /// Friends to compare scores against (rich profiles from KovaaK's API).
    #[serde(default)]
    pub friends: Vec<FriendProfile>,
    /// Mouse DPI/CPI used to normalise smoothness metrics so they are comparable
    /// across different sensitivity setups. Defaults to 800.
    #[serde(default = "default_mouse_dpi")]
    pub mouse_dpi: u32,
    /// The username of the friend chosen as battle opponent in VS Mode.
    #[serde(default)]
    pub selected_friend: Option<String>,
    /// Whether live coaching notifications are enabled.
    #[serde(default = "default_true")]
    pub live_feedback_enabled: bool,
    /// Live feedback verbosity: 0=minimal, 1=standard, 2=verbose.
    #[serde(default = "default_feedback_verbosity")]
    pub live_feedback_verbosity: u8,
    /// Whether text-to-speech is used to read live coaching notifications aloud.
    #[serde(default)]
    pub live_feedback_tts_enabled: bool,
    /// Name of the selected TTS voice (matches SpeechSynthesisVoice.name in the browser).
    /// None means use the auto-selected best voice.
    #[serde(default)]
    pub live_feedback_tts_voice: Option<String>,
    /// Per-HUD visibility toggles.
    #[serde(default = "default_true")]
    pub hud_vsmode_visible: bool,
    #[serde(default = "default_true")]
    pub hud_smoothness_visible: bool,
    #[serde(default = "default_true")]
    pub hud_stats_visible: bool,
    #[serde(default = "default_true")]
    pub hud_feedback_visible: bool,
    /// Whether the post-session overview card is shown after each run.
    #[serde(default = "default_true")]
    pub hud_post_session_visible: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            stats_dir: default_stats_dir(),
            overlay_visible: true,
            username: String::new(),
            monitor_index: 0,
            friends: Vec::new(),
            mouse_dpi: default_mouse_dpi(),
            selected_friend: None,
            live_feedback_enabled: true,
            live_feedback_verbosity: 1,
            live_feedback_tts_enabled: false,
            live_feedback_tts_voice: None,
            hud_vsmode_visible: true,
            hud_smoothness_visible: true,
            hud_stats_visible: true,
            hud_feedback_visible: true,
            hud_post_session_visible: true,
        }
    }
}

pub fn load_default() -> AppSettings {
    AppSettings::default()
}

pub fn load(app: &AppHandle) -> anyhow::Result<AppSettings> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(STORE_PATH)?;
    if let Some(val) = store.get(STORE_KEY) {
        match serde_json::from_value::<AppSettings>(val.clone()) {
            Ok(settings) => return Ok(settings),
            Err(e) => {
                log::error!("Failed to deserialize settings: {e}");
                log::error!(
                    "Raw settings JSON: {}",
                    serde_json::to_string_pretty(&val)
                        .unwrap_or_else(|_| "<unserializable>".into())
                );
                log::warn!("Falling back to default settings");
                return Ok(AppSettings::default());
            }
        }
    }
    Ok(AppSettings::default())
}

pub fn persist(app: &AppHandle, settings: &AppSettings) -> anyhow::Result<()> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(STORE_PATH)?;
    store.set(STORE_KEY.to_string(), serde_json::to_value(settings)?);
    store.save()?;
    Ok(())
}

fn default_mouse_dpi() -> u32 {
    800
}
fn default_true() -> bool {
    true
}
fn default_feedback_verbosity() -> u8 {
    1
}

const KOVAAKS_STATS_SUFFIX: &str = r"steamapps\common\FPSAimTrainer\FPSAimTrainer\stats";

fn default_stats_dir() -> String {
    #[cfg(target_os = "windows")]
    {
        if let Some(dir) = detect_kovaaks_stats_dir() {
            log::info!("Auto-detected KovaaK's stats dir: {dir}");
            return dir;
        }
        // Hard-coded fallback (default Steam location on C:)
        log::warn!("Could not auto-detect KovaaK's install; using default path");
        format!(r"C:\Program Files (x86)\Steam\{KOVAAKS_STATS_SUFFIX}")
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").unwrap_or_default() + "/kovaaks-stats"
    }
}

/// Walk all Steam library folders (via registry + libraryfolders.vdf) and return
/// the first path that contains FPSAimTrainer/stats, or None.
#[cfg(target_os = "windows")]
fn detect_kovaaks_stats_dir() -> Option<String> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    // Try both registry locations Steam uses
    let steam_path = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Valve\Steam")
        .and_then(|k| k.get_value::<String, _>("SteamPath"))
        .or_else(|_| {
            RegKey::predef(HKEY_LOCAL_MACHINE)
                .open_subkey(r"SOFTWARE\WOW6432Node\Valve\Steam")
                .and_then(|k| k.get_value::<String, _>("InstallPath"))
        })
        .ok()?;

    // Collect all Steam library roots from libraryfolders.vdf
    let vdf_path = std::path::Path::new(&steam_path).join(r"steamapps\libraryfolders.vdf");
    let mut libraries: Vec<String> = vec![steam_path.replace('/', r"\")];

    if let Ok(vdf) = std::fs::read_to_string(&vdf_path) {
        // Parse lines like:   "path"    "D:\\SteamLibrary"
        for line in vdf.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with(r#""path""#) {
                // Extract the value between the second pair of quotes
                let _parts: Vec<&str> = trimmed.splitn(3, '"').collect();
                // parts: ["", "path", "    \"D:\\SteamLibrary\""]
                // Better: split on all quotes and take 4th token
                let tokens: Vec<&str> = trimmed
                    .split('"')
                    .filter(|s| !s.trim().is_empty())
                    .collect();
                // tokens[0]="path", tokens[1]="D:\\SteamLibrary"
                if let Some(path) = tokens.get(1) {
                    // Unescape double-backslashes from VDF
                    let normalized = path.replace(r"\\", r"\");
                    libraries.push(normalized);
                }
            }
        }
    }

    // Check each library root for FPSAimTrainer stats
    for lib in &libraries {
        let candidate = std::path::Path::new(lib).join(KOVAAKS_STATS_SUFFIX);
        if candidate.exists() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }

    None
}
