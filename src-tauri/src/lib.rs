mod file_watcher;
mod screen_recorder;
mod kovaaks_api;
mod logger;
mod mouse_hook;
mod ocr;
mod sapi;
mod scenario_index;
mod session_store;
mod settings;
mod stats_ocr;
mod steam_api;
mod steam_integration;
mod window_tracker;

use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};

pub use settings::{AppSettings, FriendProfile};

/// Global app state accessible from Tauri commands.
pub struct AppState {
    pub settings: Arc<Mutex<AppSettings>>,
}

// ─── Auto-setup state ─────────────────────────────────────────────────────────

static AUTO_SETUP_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

const EVENT_AUTO_SETUP_PROGRESS: &str = "auto-setup-progress";
const EVENT_AUTO_SETUP_COMPLETE: &str = "auto-setup-complete";

#[derive(serde::Serialize, Clone)]
struct AutoSetupProgress {
    confirmed: Vec<String>,
    total: usize,
}

#[derive(serde::Serialize, Clone)]
struct AutoSetupComplete {
    regions: settings::StatsFieldRegions,
    confirmed_count: usize,
}

// ─── Monitor helpers ──────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
}

/// Physical screen origin + scale factor of the overlay window.
/// Used by the RegionPicker frontend to convert CSS coords → absolute screen pixels.
#[derive(serde::Serialize, Clone)]
pub struct OverlayOrigin {
    pub x: i32,
    pub y: i32,
    pub scale_factor: f64,
}

#[tauri::command]
fn get_overlay_origin(app: AppHandle) -> OverlayOrigin {
    let win = app.get_webview_window("overlay");
    let (x, y) = win
        .as_ref()
        .and_then(|w| w.outer_position().ok())
        .map(|p| (p.x, p.y))
        .unwrap_or((0, 0));
    let scale_factor = win
        .as_ref()
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    log::debug!("get_overlay_origin: ({x},{y}) scale={scale_factor}");
    OverlayOrigin { x, y, scale_factor }
}

/// Reposition the overlay window to cover the monitor at `index`.
///
/// Fullscreen bypasses DWM's invisible resize borders entirely, which
/// eliminates the pixel gap on the left side of borderless windows.
/// We exit fullscreen first so the OS accepts the new position, then
/// re-enter fullscreen on the target monitor.
pub fn apply_monitor(app: &AppHandle, index: usize) {
    let Some(win) = app.get_webview_window("overlay") else { return };
    let monitors = win.available_monitors().unwrap_or_default();
    let monitor = monitors.get(index).or_else(|| monitors.first());
    let Some(m) = monitor else { return };

    let pos  = m.position();
    let size = m.size();
    let sf   = m.scale_factor();
    let logical_pos = pos.to_logical::<f64>(sf);

    let _ = win.set_fullscreen(false);
    let _ = win.set_position(tauri::LogicalPosition::new(logical_pos.x, logical_pos.y));
    let _ = win.set_fullscreen(true);

    // Keep the screen recorder capture rect in sync with whichever monitor the
    // overlay is on.  Uses physical pixel coordinates to match GDI capture.
    let monitor_rect = settings::RegionRect {
        x: pos.x, y: pos.y,
        width: size.width, height: size.height,
    };
    screen_recorder::update_monitor_rect(&monitor_rect);
}

// ─── Tauri Commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn open_speech_settings() {
    // Opens Windows Speech settings (Time & Language > Speech) where the user
    // can install additional high-quality Neural / Natural voices.
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "ms-settings:speech"])
        .spawn();
}

#[tauri::command]
fn open_natural_voices_store() {
    // Opens Windows Accessibility > Narrator settings where the user can click
    // "Add more voices" to install the free Microsoft Neural voices (Aria, Jenny,
    // Guy, …) that are bundled with Windows but not installed by default.
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "ms-settings:easeofaccess-narrator"])
        .spawn();
}

/// Return display names of every TTS voice installed on this machine.
/// Reads both the legacy SAPI5 registry hive and the newer OneCore hive
/// (neural / Narrator voices) so all installed voices are returned.
#[tauri::command]
fn list_sapi_voices() -> Vec<String> {
    sapi::list_voices()
}

/// Speak `text` using the named voice (or the system default when `None`).
/// Kills any currently-playing speech first, then spawns a background
/// PowerShell process so the command returns immediately.
#[tauri::command]
fn speak_with_sapi(text: String, voice_name: Option<String>) {
    sapi::speak(&text, voice_name.as_deref());
}

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Result<AppSettings, String> {
    let s = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(s.clone())
}

#[tauri::command]
fn save_settings(
    new_settings: AppSettings,
    state: tauri::State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    *s = new_settings.clone();
    settings::persist(&app, &new_settings).map_err(|e| e.to_string())?;
    file_watcher::restart(&app, &new_settings.stats_dir);
    ocr::update_region(&app, new_settings.region);
    ocr::update_scenario_region(new_settings.scenario_region);
    ocr::update_poll_ms(new_settings.ocr_poll_ms);
    mouse_hook::set_dpi(new_settings.mouse_dpi);
    mouse_hook::set_feedback_enabled(new_settings.live_feedback_enabled);
    mouse_hook::set_feedback_verbosity(new_settings.live_feedback_verbosity);
    stats_ocr::update_field_regions(new_settings.stats_field_regions);
    Ok(())
}

#[tauri::command]
fn set_region(
    region: settings::RegionRect,
    state: tauri::State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    s.region = Some(region);
    let cloned = s.clone();
    drop(s);
    settings::persist(&app, &cloned).map_err(|e| e.to_string())?;
    ocr::update_region(&app, cloned.region);
    Ok(())
}

#[tauri::command]
fn set_scenario_region(
    region: settings::RegionRect,
    state: tauri::State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    s.scenario_region = Some(region);
    let cloned = s.clone();
    drop(s);
    settings::persist(&app, &cloned).map_err(|e| e.to_string())?;
    ocr::update_scenario_region(cloned.scenario_region);
    Ok(())
}

#[tauri::command]
fn set_stats_field_regions(
    regions: settings::StatsFieldRegions,
    state: tauri::State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    s.stats_field_regions = regions;
    let cloned = s.clone();
    drop(s);
    settings::persist(&app, &cloned).map_err(|e| e.to_string())?;
    stats_ocr::update_field_regions(cloned.stats_field_regions);
    Ok(())
}

// ─── Friend / API commands ─────────────────────────────────────────────────────

/// Persist the username of the friend chosen as battle opponent (pass None to clear).
#[tauri::command]
fn set_selected_friend(
    username: Option<String>,
    state: tauri::State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    s.selected_friend = username.clone();
    let cloned = s.clone();
    drop(s);
    settings::persist(&app, &cloned).map_err(|e| e.to_string())?;
    // Notify the overlay so VSMode refreshes without requiring an app restart.
    let _ = app.emit("selected-friend-changed", &username);
    Ok(())
}

/// Return the list of friend profiles stored in settings.
#[tauri::command]
fn get_friends(state: tauri::State<AppState>) -> Result<Vec<FriendProfile>, String> {
    let s = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(s.friends.clone())
}

/// Look up a user and persist them as a friend.
///
/// `search_type` controls the lookup strategy:
///   - `"kovaaks"`  → exact KovaaK's webapp username match
///   - `"steam"`    → resolve via Steam community XML (no API key needed),
///                    then cross-reference KovaaK's by steamId
///   - `None` / auto → Steam64 IDs / steamcommunity.com URLs go straight to steam path;
///                     everything else tries KovaaK's username first, then falls back to
///                     Steam (so vanity URLs like "aimicantaim" also work)
///
/// Friends resolved via Steam with no linked KovaaK's account are stored with
/// their Steam64 ID as `username`; VS-mode comparison is unavailable for them.
#[tauri::command]
async fn add_friend(
    username: String,
    search_type: Option<String>,
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<FriendProfile, String> {
    let trimmed = username.trim().to_string();

    let looks_like_steam = steam_api::is_steam64_id(&trimmed)
        || trimmed.contains("steamcommunity.com");

    /// Resolve via Steam community XML then cross-reference KovaaK's.
    /// Returns a UserProfile with a real KovaaK's username when one is linked,
    /// or using the Steam64 ID as the username when no KovaaK's account is found.
    async fn resolve_via_steam(input: &str) -> Result<kovaaks_api::UserProfile, String> {
        let steam = steam_api::resolve_steam_user(input)
            .await
            .map_err(|e| e.to_string())?;

        let kovaaks = kovaaks_api::find_user_by_steam_id(&steam.steam_id, &steam.display_name)
            .await
            .unwrap_or(None);

        Ok(match kovaaks {
            Some(p) => p,
            None => kovaaks_api::UserProfile {
                username: steam.steam_id.clone(),
                steam_id: steam.steam_id,
                steam_account_name: steam.display_name,
                avatar_url: steam.avatar_url,
                country: String::new(),
                kovaaks_plus: false,
            },
        })
    }

    let profile = match search_type.as_deref() {
        Some("steam") => resolve_via_steam(&trimmed).await?,
        Some("kovaaks") => {
            kovaaks_api::fetch_user_profile(&trimmed)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("No KovaaK's account found for '{}'", trimmed))?
        }
        _ => {
            // Auto: if input is an obvious Steam ID/URL go straight to Steam path.
            // Otherwise try KovaaK's username first, then fall back to Steam so that
            // vanity URLs (e.g. "aimicantaim") and other Steam inputs also work.
            if looks_like_steam {
                resolve_via_steam(&trimmed).await?
            } else {
                match kovaaks_api::fetch_user_profile(&trimmed).await {
                    Ok(Some(p)) => p,
                    _ => resolve_via_steam(&trimmed).await?,
                }
            }
        }
    };

    let friend = FriendProfile {
        username: profile.username.clone(),
        steam_id: profile.steam_id.clone(),
        steam_account_name: profile.steam_account_name.clone(),
        avatar_url: profile.avatar_url.clone(),
        country: profile.country.clone(),
        kovaaks_plus: profile.kovaaks_plus,
    };
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    // Deduplicate by steam_id (if available) or username.
    let already_exists = if !friend.steam_id.is_empty() {
        s.friends.iter().any(|f| f.steam_id == friend.steam_id)
    } else {
        s.friends.iter().any(|f| f.username.eq_ignore_ascii_case(&friend.username))
    };
    if !already_exists {
        s.friends.push(friend.clone());
    }
    let cloned = s.clone();
    drop(s);
    settings::persist(&app, &cloned).map_err(|e| e.to_string())?;
    Ok(friend)
}


/// Remove a friend by username and persist.
#[tauri::command]
fn remove_friend(
    username: String,
    state: tauri::State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    s.friends.retain(|f| !f.username.eq_ignore_ascii_case(&username));
    let cloned = s.clone();
    drop(s);
    settings::persist(&app, &cloned).map_err(|e| e.to_string())
}

/// Fetch a friend's best score for a specific scenario from the KovaaK's API.
/// Returns `null` if the user has never played that scenario, or if the friend
/// has no linked KovaaK's account (username is their Steam64 ID).
#[tauri::command]
async fn fetch_friend_score(
    username: String,
    scenario_name: String,
) -> Result<Option<f64>, String> {
    // Friends without a KovaaK's account are stored with their Steam64 ID as
    // username. The score endpoint requires a real username — return None early.
    if steam_api::is_steam64_id(&username) {
        return Ok(None);
    }
    kovaaks_api::fetch_best_score(&username, &scenario_name)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch a user's most-played scenarios (up to 10) sorted by play count.
/// Returns empty for friends with no linked KovaaK's account (steam64 username).
#[tauri::command]
async fn fetch_friend_most_played(
    username: String,
) -> Result<Vec<kovaaks_api::MostPlayedEntry>, String> {
    if steam_api::is_steam64_id(&username) {
        return Ok(vec![]);
    }
    kovaaks_api::fetch_most_played(&username, 10)
        .await
        .map_err(|e| e.to_string())
}

/// Detect the currently logged-in Steam user and cross-reference their KovaaK's account.
///
/// Returns a `FriendProfile` for the active Steam user:
/// - `username` is their KovaaK's username if they have a linked account, otherwise their Steam64 ID.
/// - All other fields are populated from Steam + KovaaK's as available.
///
/// Intended to auto-populate the "your username" settings field without any manual entry.
#[tauri::command]
async fn detect_current_user() -> Result<FriendProfile, String> {
    let steam_id = steam_integration::get_active_steam_id()
        .ok_or_else(|| "Steam is not running or active user could not be detected".to_string())?;

    let steam = steam_api::resolve_steam_user(&steam_id)
        .await
        .map_err(|e| e.to_string())?;

    let kovaaks = kovaaks_api::find_user_by_steam_id(&steam.steam_id, &steam.display_name)
        .await
        .unwrap_or(None);

    Ok(match kovaaks {
        Some(p) => FriendProfile {
            username: p.username,
            steam_id: p.steam_id,
            steam_account_name: p.steam_account_name,
            avatar_url: p.avatar_url,
            country: p.country,
            kovaaks_plus: p.kovaaks_plus,
        },
        None => FriendProfile {
            username: steam.steam_id.clone(),
            steam_id: steam.steam_id.clone(),
            steam_account_name: steam.display_name.clone(),
            avatar_url: steam.avatar_url.clone(),
            country: String::new(),
            kovaaks_plus: false,
        },
    })
}

/// Returns the Steam 64-bit ID and display name of the currently logged-in Steam user.
/// Reads the Windows registry — instant, no network, no API key.
/// Returns `null` when Steam is not running or the platform is not Windows.
#[derive(serde::Serialize)]
pub struct ActiveSteamUser {
    pub steam_id: String,
    pub display_name: String,
    pub avatar_url: String,
}

#[tauri::command]
async fn get_active_steam_user() -> Option<ActiveSteamUser> {
    let steam_id = steam_integration::get_active_steam_id()?;
    // Resolve the full profile (display name + avatar) from the community XML.
    match steam_api::resolve_steam_user(&steam_id).await {
        Ok(p) => Some(ActiveSteamUser {
            steam_id: p.steam_id,
            display_name: p.display_name,
            avatar_url: p.avatar_url,
        }),
        Err(e) => {
            log::warn!("get_active_steam_user: profile fetch failed: {e}");
            // Return with just the ID and no display info rather than failing.
            Some(ActiveSteamUser {
                steam_id: steam_id.clone(),
                display_name: steam_id,
                avatar_url: String::new(),
            })
        }
    }
}

/// Import all Steam friends as FriendProfiles.
///
/// Priority order:
///   1. Read `localconfig.vdf` from the local Steam install — works even for private lists.
///   2. Fall back to the public Steam community XML if the VDF is unavailable.
///
/// Resolves all IDs concurrently (12 at a time) so 150 friends imports in ~10 s
/// instead of several minutes.  Emits `steam-import-progress` events as friends
/// resolve so the frontend can show a live counter.
///
/// Already-added friends (matched by steam_id) are skipped.
/// Returns the newly added FriendProfiles.
#[tauri::command]
async fn import_steam_friends(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<Vec<FriendProfile>, String> {
    use std::sync::Arc;
    use tokio::sync::Semaphore;

    let active_steam_id = steam_integration::get_active_steam_id()
        .ok_or_else(|| "Steam is not running or active user could not be detected".to_string())?;

    let friend_ids = steam_integration::get_friend_ids(&active_steam_id).await;
    if friend_ids.is_empty() {
        return Ok(vec![]);
    }

    // Filter out already-added friends.
    let existing_steam_ids: Vec<String> = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        s.friends.iter().map(|f| f.steam_id.clone()).collect()
    };
    let new_ids: Vec<String> = friend_ids
        .into_iter()
        .filter(|id| !existing_steam_ids.contains(id))
        .collect();

    if new_ids.is_empty() {
        return Ok(vec![]);
    }

    let total = new_ids.len();
    log::info!("import_steam_friends: resolving {} new friend IDs", total);

    // Resolve concurrently — 12 in-flight at a time to avoid hammering the APIs.
    let sem = Arc::new(Semaphore::new(12));
    let mut handles = Vec::with_capacity(total);

    for steam_id in new_ids {
        let permit = sem.clone().acquire_owned().await.unwrap();
        let app_handle = app.clone();
        let handle = tokio::spawn(async move {
            let _permit = permit; // released when task finishes

            // 1. Resolve Steam profile (display name + avatar).
            let steam = match steam_api::resolve_steam_user(&steam_id).await {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("import_steam_friends: skip {steam_id}: {e}");
                    let _ = app_handle.emit("steam-import-progress", ());
                    return None;
                }
            };

            // 2. Cross-reference with KovaaK's — skip if they don't play KovaaK's.
            let kovaaks = match kovaaks_api::find_user_by_steam_id(&steam.steam_id, &steam.display_name)
                .await
                .unwrap_or(None)
            {
                Some(p) => p,
                None => {
                    let _ = app_handle.emit("steam-import-progress", ());
                    return None; // not a KovaaK's player — skip
                }
            };

            let friend = FriendProfile {
                username: kovaaks.username,
                steam_id: kovaaks.steam_id,
                steam_account_name: kovaaks.steam_account_name,
                avatar_url: kovaaks.avatar_url,
                country: kovaaks.country,
                kovaaks_plus: kovaaks.kovaaks_plus,
            };

            let _ = app_handle.emit("steam-import-progress", ());
            Some(friend)
        });
        handles.push(handle);
    }

    // Collect results.
    let mut new_friends: Vec<FriendProfile> = Vec::new();
    for handle in handles {
        if let Ok(Some(f)) = handle.await {
            new_friends.push(f);
        }
    }

    // Persist.
    {
        let mut s = state.settings.lock().map_err(|e| e.to_string())?;
        for f in &new_friends {
            let dupe = if !f.steam_id.is_empty() {
                s.friends.iter().any(|x| x.steam_id == f.steam_id)
            } else {
                s.friends.iter().any(|x| x.username.eq_ignore_ascii_case(&f.username))
            };
            if !dupe { s.friends.push(f.clone()); }
        }
        let cloned = s.clone();
        drop(s);
        settings::persist(&app, &cloned).map_err(|e| e.to_string())?;
    }

    log::info!("import_steam_friends: imported {} friends", new_friends.len());
    Ok(new_friends)
}

/// Validate an OCR-read scenario name and return the canonical spelling, or null if
/// the name is unrecognisable garbage.
///
/// Resolution order:
///   1. Local index (instant, offline) — fuzzy-matched against all CSV filenames the
///      user has produced so far.  Covers all the scenarios they actually play.
///   2. KovaaK's public API — broader catalogue, handles scenarios never played before.
///
/// Returning the canonical name (not just true/false) means OCR confusables like
/// "Vl Bot" are corrected to "V1 Bot" before the name is stored in the frontend.
#[tauri::command]
async fn validate_scenario(scenario_name: String) -> Option<String> {
    // 1. Try the local index first — fast, no network.
    if scenario_index::len() > 0 {
        if let Some(canonical) = scenario_index::fuzzy_match(&scenario_name) {
            log::info!("validate_scenario: local match {:?} → {:?}", scenario_name, canonical);
            return Some(canonical);
        }
    }
    // 2. Fall back to the KovaaK's API for scenarios not yet in the local index.
    let result = kovaaks_api::validate_scenario_name(&scenario_name).await;
    log::info!("validate_scenario: API result for {:?} = {:?}", scenario_name, result);
    result
}

#[tauri::command]
async fn validate_username(username: String) -> Result<Option<FriendProfile>, String> {
    let profile = kovaaks_api::fetch_user_profile(&username)
        .await
        .map_err(|e| e.to_string())?;
    Ok(profile.map(|p| FriendProfile {
        username: p.username,
        steam_id: p.steam_id,
        steam_account_name: p.steam_account_name,
        avatar_url: p.avatar_url,
        country: p.country,
        kovaaks_plus: p.kovaaks_plus,
    }))
}

#[tauri::command]
fn start_ocr(app: AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    let (spm_region, scenario_region, poll_ms, stats_dir) = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        (s.stats_field_regions.spm, s.scenario_region, s.ocr_poll_ms, s.stats_dir.clone())
    };
    // Rebuild the local scenario index from CSV filenames in the stats dir.
    // This is the primary source for fast, offline OCR correction.
    let stats_path = std::path::Path::new(&stats_dir);
    if stats_path.exists() {
        scenario_index::rebuild(stats_path);
    }
    ocr::update_scenario_region(scenario_region);
    ocr::start(app, spm_region, poll_ms);
    Ok(())
}

#[tauri::command]
fn stop_ocr() {
    ocr::stop();
}

#[tauri::command]
fn start_mouse_hook(app: AppHandle) -> Result<(), String> {
    mouse_hook::start(app).map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_mouse_hook() {
    mouse_hook::stop();
}

#[tauri::command]
fn get_session_mouse_data() -> Vec<mouse_hook::MetricPoint> {
    mouse_hook::get_session_buffer()
}

#[tauri::command]
fn get_session_raw_positions() -> Vec<mouse_hook::RawPositionPoint> {
    mouse_hook::get_raw_positions()
}

#[tauri::command]
fn get_session_screen_frames() -> Vec<screen_recorder::ScreenFrame> {
    screen_recorder::get_frames()
}

#[tauri::command]
fn get_monitors(app: AppHandle) -> Vec<MonitorInfo> {
    let Some(win) = app.get_webview_window("overlay") else {
        return vec![];
    };
    win.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(i, m)| {
            let pos = m.position();
            let size = m.size();
            MonitorInfo {
                index: i,
                name: m.name().map(|s| s.to_string()).unwrap_or_else(|| format!("Monitor {}", i + 1)),
                width: size.width,
                height: size.height,
                x: pos.x,
                y: pos.y,
            }
        })
        .collect()
}

#[tauri::command]
fn set_overlay_monitor(
    index: usize,
    state: tauri::State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    {
        let mut s = state.settings.lock().map_err(|e| e.to_string())?;
        s.monitor_index = index;
        let cloned = s.clone();
        drop(s);
        settings::persist(&app, &cloned).map_err(|e| e.to_string())?;
    }
    apply_monitor(&app, index);
    Ok(())
}

/// Emit toggle-settings event to the overlay window (called from tray or frontend).
#[tauri::command]
fn toggle_settings(app: AppHandle) -> Result<(), String> {
    app.emit("toggle-settings", ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        if win.is_visible().unwrap_or(false) {
            win.hide().map_err(|e| e.to_string())?;
        } else {
            win.show().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn open_logs_window(app: AppHandle) -> Result<(), String> {
    // The logs window is pre-created at startup (hidden) so we just show it.
    // Avoids any dynamic window creation which can deadlock from a command handler.
    if let Some(win) = app.get_webview_window("logs") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
    } else {
        log::error!("logs window not found — check tauri.conf.json");
    }
    Ok(())
}

#[tauri::command]
fn open_stats_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("stats") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
    } else {
        log::error!("stats window not found — check tauri.conf.json");
    }
    Ok(())
}

#[tauri::command]
fn get_session_history(app: AppHandle) -> Vec<session_store::SessionRecord> {
    session_store::get_all_sessions(&app)
}

#[tauri::command]
fn clear_session_history(app: AppHandle) {
    session_store::clear_sessions(&app);
}

#[tauri::command]
fn get_log_buffer() -> Vec<logger::LogEntry> {
    logger::get_buffer()
}

#[tauri::command]
fn clear_log_buffer() {
    logger::clear_buffer();
}

#[derive(serde::Serialize)]
struct CursorPos { x: i32, y: i32 }

/// Return the current cursor position in physical screen coordinates.
/// Used by the frontend to implement cursor-proximity passthrough toggling.
#[tauri::command]
fn get_cursor_pos() -> CursorPos {
    #[cfg(all(target_os = "windows", feature = "ocr"))]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut pt = POINT { x: 0, y: 0 };
        unsafe { let _ = GetCursorPos(&mut pt); }
        return CursorPos { x: pt.x, y: pt.y };
    }
    #[allow(unreachable_code)]
    CursorPos { x: 0, y: 0 }
}

#[tauri::command]
fn get_capture_preview() -> Option<Vec<u8>> {
    ocr::get_capture_png()
}

#[tauri::command]
fn set_mouse_passthrough(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        win.set_ignore_cursor_events(enabled)
            .map_err(|e| e.to_string())?;
    }
    // When passthrough is OFF (settings/picker open), keep overlay visible
    // even if KovaaK's isn't the foreground window.
    window_tracker::set_force_show(!enabled);
    Ok(())
}

/// Start the background auto-setup loop which continuously captures the screen
/// and automatically detects KovaaK's stats panel field regions.
/// Emits `auto-setup-progress` periodically and `auto-setup-complete` when all
/// 5 fields are confirmed (3 consistent detections each).
#[tauri::command]
fn start_auto_setup(
    state: tauri::State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if AUTO_SETUP_RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Ok(()); // already running
    }
    let monitor_index = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        s.monitor_index
    };
    let monitor_rect = resolve_monitor_rect(&app, monitor_index)?;
    let app_clone = app.clone();
    std::thread::Builder::new()
        .name("auto-setup".into())
        .spawn(move || auto_setup_loop(app_clone, monitor_rect))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Stop the background auto-setup loop started by `start_auto_setup`.
#[tauri::command]
fn stop_auto_setup() {
    AUTO_SETUP_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Background loop for timed auto-setup.
///
/// Polls at POLL_INTERVAL, runs full-screen OCR word detection, and accumulates
/// per-field results across frames.  A field is "confirmed" after CONFIRM_THRESHOLD
/// consecutive detections that agree within TOLERANCE pixels.  Once all 5 fields
/// are confirmed (or the loop is stopped), emits `auto-setup-complete`.
fn auto_setup_loop(app: AppHandle, monitor_rect: settings::RegionRect) {
    use std::collections::HashMap;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    const POLL_INTERVAL: Duration = Duration::from_millis(1500);
    const CONFIRM_THRESHOLD: u32 = 3;
    const TOLERANCE: i32 = 12;
    const TOTAL: usize = 5;

    struct Candidate {
        rect: settings::RegionRect,
        consecutive: u32,
    }

    let field_keys: [&str; TOTAL] = ["kills", "kps", "accuracy", "damage", "ttk"];
    let mut candidates: HashMap<&str, Candidate> = HashMap::new();
    let mut confirmed_set: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut confirmed_regions = settings::StatsFieldRegions::default();

    log::info!(
        "auto-setup: started — monitor ({},{}) {}×{}",
        monitor_rect.x, monitor_rect.y, monitor_rect.width, monitor_rect.height,
    );

    while AUTO_SETUP_RUNNING.load(Ordering::SeqCst) {
        std::thread::sleep(POLL_INTERVAL);
        if !AUTO_SETUP_RUNNING.load(Ordering::SeqCst) { break; }

        let words = match ocr::capture_screen_words(&monitor_rect) {
            Ok(w) => w,
            Err(e) => { log::debug!("auto-setup: capture failed: {e}"); continue; }
        };
        log::debug!("auto-setup: OCR returned {} words", words.len());
        if log::log_enabled!(log::Level::Trace) {
            for w in words.iter().take(40) {
                log::trace!("auto-setup: word {:?} at ({},{}) {}×{}", w.text, w.x, w.y, w.width, w.height);
            }
        }

        let detected = detect_field_regions_from_words(&words, &monitor_rect);
        let detected_per_field: [(&str, Option<settings::RegionRect>); TOTAL] = [
            ("kills",    detected.kills),
            ("kps",      detected.kps),
            ("accuracy", detected.accuracy),
            ("damage",   detected.damage),
            ("ttk",      detected.ttk),
        ];

        for (field, maybe_rect) in detected_per_field {
            if confirmed_set.contains(field) { continue; }
            if let Some(rect) = maybe_rect {
                let newly_confirmed = match candidates.get(field) {
                    None => {
                        candidates.insert(field, Candidate { rect, consecutive: 1 });
                        false
                    }
                    Some(c) if rects_close(&c.rect, &rect, TOLERANCE) => {
                        let n = c.consecutive + 1;
                        candidates.insert(field, Candidate { rect: c.rect, consecutive: n });
                        n >= CONFIRM_THRESHOLD
                    }
                    _ => {
                        candidates.insert(field, Candidate { rect, consecutive: 1 });
                        false
                    }
                };
                if newly_confirmed {
                    let r = candidates[field].rect;
                    log::info!("auto-setup: confirmed {} ({},{}) {}×{}", field, r.x, r.y, r.width, r.height);
                    confirmed_set.insert(field);
                    match field {
                        "kills"    => confirmed_regions.kills    = Some(r),
                        "kps"      => confirmed_regions.kps      = Some(r),
                        "accuracy" => confirmed_regions.accuracy = Some(r),
                        "damage"   => confirmed_regions.damage   = Some(r),
                        "ttk"      => confirmed_regions.ttk      = Some(r),
                        _ => {}
                    }
                }
            }
        }

        let confirmed_list: Vec<String> =
            field_keys.iter().filter(|&&k| confirmed_set.contains(k)).map(|s| s.to_string()).collect();
        let _ = app.emit(EVENT_AUTO_SETUP_PROGRESS, AutoSetupProgress {
            confirmed: confirmed_list,
            total: TOTAL,
        });

        if confirmed_set.len() == TOTAL {
            log::info!("auto-setup: all {} fields confirmed — saving", TOTAL);
            AUTO_SETUP_RUNNING.store(false, Ordering::SeqCst);
            let _ = app.emit(EVENT_AUTO_SETUP_COMPLETE, AutoSetupComplete {
                regions: confirmed_regions,
                confirmed_count: TOTAL,
            });
            break;
        }
    }
    log::info!("auto-setup: stopped ({}/{} confirmed)", confirmed_set.len(), TOTAL);
}

/// Automatically detect KovaaK's stats panel field regions by capturing the
/// monitor and matching known label strings in the full-screen OCR word list.
///
/// Returns a `StatsFieldRegions` with every field that could be located.
/// Fields that are not found are returned as `None` so the caller can decide
/// whether to keep existing manual regions for those fields.
#[tauri::command]
fn auto_detect_stats_regions(
    state: tauri::State<AppState>,
    app: AppHandle,
) -> Result<settings::StatsFieldRegions, String> {
    let monitor_index = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        s.monitor_index
    };
    let monitor_rect = resolve_monitor_rect(&app, monitor_index)?;
    log::info!(
        "auto_detect: capturing monitor {} at ({},{}) {}×{}",
        monitor_index, monitor_rect.x, monitor_rect.y,
        monitor_rect.width, monitor_rect.height,
    );

    let words = ocr::capture_screen_words(&monitor_rect).map_err(|e| e.to_string())?;
    log::info!("auto_detect: OCR returned {} words", words.len());

    Ok(detect_field_regions_from_words(&words, &monitor_rect))
}

// ─── Auto-detect helpers ───────────────────────────────────────────────────────

/// Returns the physical screen rectangle for the given monitor index.
/// Falls back to the first monitor if the index is out of range.
fn resolve_monitor_rect(app: &AppHandle, monitor_index: usize) -> Result<settings::RegionRect, String> {
    let win = app
        .get_webview_window("overlay")
        .ok_or_else(|| "overlay window not found".to_string())?;
    let monitors = win.available_monitors().map_err(|e| e.to_string())?;
    let m = monitors
        .get(monitor_index)
        .or_else(|| monitors.first())
        .ok_or_else(|| "no monitors found".to_string())?;
    let pos = m.position();
    let size = m.size();
    Ok(settings::RegionRect { x: pos.x, y: pos.y, width: size.width, height: size.height })
}

/// Check whether two `RegionRect`s are within `tolerance` pixels on all four edges.
fn rects_close(a: &settings::RegionRect, b: &settings::RegionRect, tolerance: i32) -> bool {
    (a.x - b.x).abs() <= tolerance
        && (a.y - b.y).abs() <= tolerance
        && (a.width as i32 - b.width as i32).abs() <= tolerance
        && (a.height as i32 - b.height as i32).abs() <= tolerance
}

/// Axis-aligned bounding box (capture-image pixel coordinates).
#[derive(Clone, Debug)]
struct BBox {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl BBox {
    fn right(&self) -> i32 { self.x + self.width as i32 }
    fn bottom(&self) -> i32 { self.y + self.height as i32 }
    fn centre_y(&self) -> i32 { self.y + self.height as i32 / 2 }

    /// Smallest box containing both `self` and `other`.
    fn union(&self, other: &BBox) -> BBox {
        let x1 = self.x.min(other.x);
        let y1 = self.y.min(other.y);
        let x2 = self.right().max(other.right());
        let y2 = self.bottom().max(other.bottom());
        BBox { x: x1, y: y1, width: (x2 - x1) as u32, height: (y2 - y1) as u32 }
    }
}

fn word_to_bbox(w: &ocr::OcrWordResult) -> BBox {
    BBox { x: w.x, y: w.y, width: w.width, height: w.height }
}

/// Search `words` for a label composed of one or more tokens (case-insensitive).
/// For multi-word labels (e.g. `["Kill", "Count"]`) we verify that the later tokens
/// appear within 5 positions of the first and on the same row (centre_y within 20 px).
/// Returns the union bounding box of all matched label words.
fn find_label_in_words(words: &[ocr::OcrWordResult], tokens: &[&str]) -> Option<BBox> {
    if tokens.is_empty() || words.is_empty() {
        return None;
    }
    'outer: for start in 0..words.len() {
        if !words[start].text.eq_ignore_ascii_case(tokens[0]) {
            continue;
        }
        let mut bbox = word_to_bbox(&words[start]);
        let row_cy = bbox.centre_y();
        for (ti, &tok) in tokens.iter().enumerate().skip(1) {
            let mut found = false;
            let end = (start + ti + 5).min(words.len());
            for wi in (start + ti)..end {
                let cand = &words[wi];
                if cand.text.eq_ignore_ascii_case(tok)
                    && (word_to_bbox(cand).centre_y() - row_cy).abs() < 20
                {
                    bbox = bbox.union(&word_to_bbox(cand));
                    found = true;
                    break;
                }
            }
            if !found {
                continue 'outer;
            }
        }
        return Some(bbox);
    }
    None
}

/// Find the value region for a detected label box.
///
/// Strategy: scan all OCR words that are
///   • on the same horizontal row as the label (centre_y within `label.height` pixels), and
///   • to the right of the label's right edge, and
///   • contain at least one ASCII digit (the value itself).
///
/// Returns the union of all matching words, or `None` if no digit word is found.
fn find_value_box(words: &[ocr::OcrWordResult], label_box: &BBox) -> Option<BBox> {
    let row_cy = label_box.centre_y();
    let row_tolerance = (label_box.height as i32).max(12);

    let mut combined: Option<BBox> = None;
    for w in words {
        let wb = word_to_bbox(w);
        // Right of the label
        if wb.x < label_box.right() - 4 {
            continue;
        }
        // Same row
        if (wb.centre_y() - row_cy).abs() > row_tolerance {
            continue;
        }
        // Must contain at least one digit
        if !w.text.chars().any(|c| c.is_ascii_digit()) {
            continue;
        }
        combined = Some(match combined {
            Some(acc) => acc.union(&wb),
            None => wb,
        });
    }
    combined
}

/// Match OCR words against all known KovaaK's stats panel labels and assemble
/// absolute `RegionRect`s (screen coordinates) for each found field.
///
/// Each field has a primary label and zero or more fallback alternatives; the
/// first matching alternative wins.  This handles variations in how KovaaK's
/// renders the stats panel text (e.g. "Kills" vs "Kill Count", "K/s" vs "KPS").
fn detect_field_regions_from_words(
    words: &[ocr::OcrWordResult],
    capture_rect: &settings::RegionRect,
) -> settings::StatsFieldRegions {
    // Each entry: (field_name, list-of-alternative-token-sequences)
    const LABELS: &[(&str, &[&[&str]])] = &[
        ("kills",    &[&["Kill", "Count"], &["Kills"], &["Kill"]]),
        ("kps",      &[&["KPS"], &["K/s"], &["Kills/s"], &["k/s"]]),
        ("accuracy", &[&["Accuracy"], &["Acc"]]),
        ("damage",   &[&["Damage"], &["Damage", "Dealt"], &["Dmg"]]),
        ("ttk",      &[&["Avg", "TTK"], &["TTK"], &["Avg", "Time"]]),
    ];

    if log::log_enabled!(log::Level::Debug) && !words.is_empty() {
        let sample: Vec<&str> = words.iter().take(30).map(|w| w.text.as_str()).collect();
        log::debug!("auto_detect: {} words, first 30: {:?}", words.len(), sample);
    } else if words.is_empty() {
        log::debug!("auto_detect: OCR returned 0 words — is KovaaK's visible and running?");
    }

    let mut out = settings::StatsFieldRegions::default();
    const PAD: i32 = 6; // padding added on every side (physical pixels)

    for &(field, alternatives) in LABELS {
        let mut found_label: Option<BBox> = None;
        for &tokens in alternatives {
            if let Some(lb) = find_label_in_words(words, tokens) {
                found_label = Some(lb);
                break;
            }
        }
        let Some(label_box) = found_label else {
            log::debug!("auto_detect: label for '{}' not found (tried all alternatives)", field);
            continue;
        };
        let Some(val_box) = find_value_box(words, &label_box) else {
            log::debug!("auto_detect: value for '{}' not found", field);
            continue;
        };

        let r = settings::RegionRect {
            x: capture_rect.x + (val_box.x - PAD).max(0),
            y: capture_rect.y + (val_box.y - PAD).max(0),
            width: (val_box.width as i32 + PAD * 2) as u32,
            height: (val_box.height as i32 + PAD * 2) as u32,
        };
        log::info!(
            "auto_detect: {} → ({},{}) {}×{}",
            field, r.x, r.y, r.width, r.height,
        );
        match field {
            "kills"    => out.kills    = Some(r),
            "kps"      => out.kps      = Some(r),
            "accuracy" => out.accuracy = Some(r),
            "damage"   => out.damage   = Some(r),
            "ttk"      => out.ttk      = Some(r),
            _ => {}
        }
    }
    out
}

// ─── Single-instance helper ────────────────────────────────────────────────────

/// Kills any previously running instance of the overlay.
///
/// On Windows we query `tasklist` by executable name so we never accidentally
/// kill an unrelated process that happens to have reused an old PID (a known
/// hazard of the naive PID-file approach).
///
/// On other platforms we fall back to a PID file.
fn kill_existing_instance() {
    let our_pid = std::process::id();

    #[cfg(target_os = "windows")]
    {
        // Resolve just the file name of our own executable (e.g. "kovaaks-overlay.exe").
        let exe_name = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_default();

        if exe_name.is_empty() {
            return;
        }

        // Ask Windows for every running process whose image name matches ours.
        let result = std::process::Command::new("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {exe_name}"), "/FO", "CSV", "/NH"])
            .output();

        if let Ok(output) = result {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut killed_any = false;

            for line in stdout.lines() {
                // CSV columns: "ImageName","PID","SessionName","Session#","MemUsage"
                let mut parts = line.splitn(3, ',');
                let _name = parts.next();
                if let Some(pid_field) = parts.next() {
                    let pid_str = pid_field.trim().trim_matches('"');
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        if pid != our_pid {
                            eprintln!("[single-instance] killing old instance (PID {pid})");
                            let _ = std::process::Command::new("taskkill")
                                .args(["/PID", &pid.to_string(), "/F"])
                                .output();
                            killed_any = true;
                        }
                    }
                }
            }

            if killed_any {
                // Give the old process a moment to release file handles etc.
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let pid_path = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("kovaaks-overlay.pid")))
            .unwrap_or_else(|| std::env::temp_dir().join("kovaaks-overlay.pid"));

        if let Ok(contents) = std::fs::read_to_string(&pid_path) {
            if let Ok(old_pid) = contents.trim().parse::<u32>() {
                if old_pid != our_pid {
                    eprintln!("[single-instance] killing old instance (PID {old_pid})");
                    let _ = std::process::Command::new("kill")
                        .args(["-15", &old_pid.to_string()])
                        .output();
                    std::thread::sleep(std::time::Duration::from_millis(400));
                }
            }
        }

        let _ = std::fs::write(&pid_path, our_pid.to_string());
    }
}

// ─── App Entry Point ───────────────────────────────────────────────────────────

pub fn run() {
    kill_existing_instance();

    // Our logger emits to stderr AND to the Tauri logs window
    logger::init().unwrap_or_else(|_| eprintln!("logger already set"));

    let initial_settings = settings::load_default();
    let app_state = AppState {
        settings: Arc::new(Mutex::new(initial_settings)),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            quit_app,
            open_logs_window,
            open_stats_window,
            get_session_history,
            clear_session_history,
            get_overlay_origin,
            get_log_buffer,
            clear_log_buffer,
            get_settings,
            save_settings,
            set_region,
            set_scenario_region,
            set_stats_field_regions,
            get_friends,
            add_friend,
            remove_friend,
            set_selected_friend,
            fetch_friend_score,
            fetch_friend_most_played,
            get_active_steam_user,
            import_steam_friends,
            detect_current_user,
            validate_username,
            validate_scenario,
            start_ocr,
            stop_ocr,
            start_mouse_hook,
            stop_mouse_hook,
            get_session_mouse_data,
            get_session_raw_positions,
            get_session_screen_frames,
            toggle_settings,
            toggle_overlay,
            set_mouse_passthrough,
            get_monitors,
            set_overlay_monitor,
            get_capture_preview,
            get_cursor_pos,
            open_speech_settings,
            open_natural_voices_store,
            auto_detect_stats_regions,
            start_auto_setup,
            stop_auto_setup,
            // list_sapi_voices and speak_with_sapi are preserved in lib.rs + sapi.rs
            // for future use but not registered until a working voice backend is confirmed.
        ])
        .setup(|app| {
            // Load persisted settings
            let mut loaded = settings::load(app.handle()).unwrap_or_default();

            // Migrate legacy `region` → `stats_field_regions.spm`.
            // The old setup wizard stored the SPM capture region in the top-level
            // `region` field.  After the per-stat refactor it lives in
            // `stats_field_regions.spm`.  Copy it once and persist so subsequent
            // startups don't need to do this.
            if let (Some(legacy), None) = (loaded.region, loaded.stats_field_regions.spm) {
                log::info!("Migrating legacy `region` → `stats_field_regions.spm`");
                loaded.stats_field_regions.spm = Some(legacy);
                // `region` is skip_serializing so it won't be written back.
                if let Err(e) = settings::persist(app.handle(), &loaded) {
                    log::warn!("Failed to persist region migration: {e}");
                }
            }

            {
                let state = app.state::<AppState>();
                let mut s = state.settings.lock().unwrap();
                *s = loaded.clone();
            }

            // Load the persistent scenario validation cache from the app data dir.
            if let Ok(data_dir) = app.path().app_data_dir() {
                kovaaks_api::load_cache(&data_dir.join("validation_cache.json"));
            }

            // Register the app handle so the logger can emit live events
            logger::register_app(app.handle().clone());
            log::info!("KovaaK's Overlay starting up — log file: {}", logger::log_file_path().display());

            // Migrate legacy session names: strip " - Challenge" / " - Challenge Start"
            // suffixes that were incorrectly included before parse_filename was fixed.
            // TODO(future): remove after a few releases (added 2026-02-25).
            session_store::migrate_session_names(app.handle());

            // Start file watcher
            file_watcher::start(app.handle().clone(), &loaded.stats_dir);

            // Start mouse hook (captures events; metrics only emitted during sessions)
            let _ = mouse_hook::start(app.handle().clone());
            mouse_hook::set_dpi(loaded.mouse_dpi);
            mouse_hook::set_feedback_enabled(loaded.live_feedback_enabled);
            mouse_hook::set_feedback_verbosity(loaded.live_feedback_verbosity);

            // Start OCR (begins reading SPM once a region is configured)
            ocr::update_scenario_region(loaded.scenario_region);
            ocr::start(app.handle().clone(), loaded.stats_field_regions.spm, loaded.ocr_poll_ms);

            // Start stats-panel OCR
            stats_ocr::update_field_regions(loaded.stats_field_regions);
            stats_ocr::start(app.handle().clone());

            // Start window tracker — shows/hides overlay based on KovaaK's focus
            window_tracker::start(app.handle().clone());

            // Build system tray (Windows only)
            #[cfg(not(target_os = "linux"))]
            setup_tray(app)?;

            // Position overlay on the saved monitor
            apply_monitor(app.handle(), loaded.monitor_index);

            // Overlay starts with mouse passthrough enabled
            if let Some(win) = app.get_webview_window("overlay") {
                let _ = win.set_ignore_cursor_events(true);
                // Force the window background to fully transparent so the DWM
                // compositor does not tint or dim the game colours underneath.
                let _ = win.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_tray<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let open_settings = MenuItem::with_id(app, "open_settings", "Settings  (F8)", true, None::<&str>)?;
    let open_stats = MenuItem::with_id(app, "open_stats", "Session Stats", true, None::<&str>)?;
    let toggle_overlay = MenuItem::with_id(app, "toggle_overlay", "Toggle Overlay", true, None::<&str>)?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open_settings, &open_stats, &toggle_overlay, &separator, &quit])?;

    let mut tray_builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("KovaaK's Overlay");
    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }
    let _tray = tray_builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open_settings" => {
                // Emit to the overlay window — same as pressing F8
                let _ = app.emit("toggle-settings", ());
            }
            "open_stats" => {
                if let Some(win) = app.get_webview_window("stats") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "toggle_overlay" => {
                if let Some(win) = app.get_webview_window("overlay") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                    }
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // Left click does nothing (menu is right-click only)
            }
        })
        .build(app)?;

    Ok(())
}
