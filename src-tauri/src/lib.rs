// ─── UE4SS deploy + injection command ───────────────────────────────────────

#[tauri::command]
fn inject_bridge(app: AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    let stats_dir = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        s.stats_dir.clone()
    };
    let _ = bridge::start_log_tailer(app.clone(), &stats_dir);
    deploy_and_inject_ue4ss(&app, &stats_dir)
}

#[tauri::command]
fn ue4ss_get_recent_logs(limit: Option<usize>) -> Vec<String> {
    bridge::recent_logs(limit.unwrap_or(400))
}

#[tauri::command]
fn ue4ss_trigger_hot_reload() -> Result<(), String> {
    bridge::trigger_hot_reload()
}

#[derive(serde::Serialize)]
struct Ue4ssRuntimeFlags {
    profile: String,
    enable_pe_hook: bool,
    disable_pe_hook: bool,
    discovery: bool,
    safe_mode: bool,
    no_rust: bool,
    log_all_events: bool,
    object_debug: bool,
    non_ui_probe: bool,
    ui_counter_fallback: bool,
    score_ui_fallback: bool,
    hook_process_internal: bool,
    hook_process_local_script: bool,
    class_probe_hooks: bool,
    class_probe_scalar_reads: bool,
    class_probe_scan_all: bool,
    allow_unsafe_hooks: bool,
    native_hooks: bool,
    hook_process_event: bool,
    detour_callbacks: bool,
    direct_pull_invoke: bool,
    experimental_runtime: bool,
    ui_settext_hook: bool,
    ui_widget_probe: bool,
    in_game_overlay: bool,
}

#[tauri::command]
fn ue4ss_get_runtime_flags(state: tauri::State<AppState>) -> Result<Ue4ssRuntimeFlags, String> {
    let stats_dir = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        s.stats_dir.clone()
    };
    let raw = bridge::get_runtime_flags(&stats_dir)?;
    Ok(Ue4ssRuntimeFlags {
        profile: raw.profile,
        enable_pe_hook: raw.enable_pe_hook,
        disable_pe_hook: raw.disable_pe_hook,
        discovery: raw.discovery,
        safe_mode: raw.safe_mode,
        no_rust: raw.no_rust,
        log_all_events: raw.log_all_events,
        object_debug: raw.object_debug,
        non_ui_probe: raw.non_ui_probe,
        ui_counter_fallback: raw.ui_counter_fallback,
        score_ui_fallback: raw.score_ui_fallback,
        hook_process_internal: raw.hook_process_internal,
        hook_process_local_script: raw.hook_process_local_script,
        class_probe_hooks: raw.class_probe_hooks,
        class_probe_scalar_reads: raw.class_probe_scalar_reads,
        class_probe_scan_all: raw.class_probe_scan_all,
        allow_unsafe_hooks: raw.allow_unsafe_hooks,
        native_hooks: raw.native_hooks,
        hook_process_event: raw.hook_process_event,
        detour_callbacks: raw.detour_callbacks,
        direct_pull_invoke: raw.direct_pull_invoke,
        experimental_runtime: raw.experimental_runtime,
        ui_settext_hook: raw.ui_settext_hook,
        ui_widget_probe: raw.ui_widget_probe,
        in_game_overlay: raw.in_game_overlay,
    })
}

#[tauri::command]
fn ue4ss_set_runtime_flag(
    key: String,
    enabled: bool,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let stats_dir = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        s.stats_dir.clone()
    };
    bridge::set_runtime_flag(&stats_dir, &key, enabled)
}

#[tauri::command]
fn ue4ss_reload_runtime_flags(state: tauri::State<AppState>) -> Result<(), String> {
    let stats_dir = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        s.stats_dir.clone()
    };
    bridge::request_runtime_flag_reload(&stats_dir)
}

fn deploy_and_inject_ue4ss(app: &AppHandle, stats_dir: &str) -> Result<(), String> {
    // UE4SS payload is shipped as a Tauri resource folder (see bundle.resources).
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|_| "Could not get resource directory")?;
    bridge::deploy_and_inject(resource_dir.as_path(), stats_dir)
}

#[cfg(target_os = "windows")]
fn start_ue4ss_reinject_monitor(app: AppHandle, stats_dir: String) {
    std::thread::Builder::new()
        .name("ue4ss-reinject-monitor".into())
        .spawn(move || {
            let poll_interval = std::time::Duration::from_secs(2);
            let reinject_cooldown = std::time::Duration::from_secs(8);
            let mut last_pid: Option<u32> = None;
            let mut last_attempt: Option<(u32, std::time::Instant)> = None;

            loop {
                let current_pid = bridge::current_game_pid();

                if current_pid != last_pid {
                    match (last_pid, current_pid) {
                        (None, Some(pid)) => {
                            log::info!("Detected {pid} for KovaaK process; monitoring UE4SS load state");
                        }
                        (Some(old), Some(new)) if old != new => {
                            log::warn!(
                                "Detected KovaaK restart (pid {old} -> {new}); scheduling UE4SS reinjection"
                            );
                        }
                        (Some(old), None) => {
                            log::info!("KovaaK process exited (pid {old})");
                        }
                        _ => {}
                    }
                    last_pid = current_pid;
                }

                match current_pid {
                    Some(pid) => {
                        if bridge::is_ue4ss_loaded_for_pid(pid) {
                            last_attempt = None;
                        } else {
                            let can_attempt = match last_attempt {
                                Some((attempt_pid, at)) if attempt_pid == pid => {
                                    at.elapsed() >= reinject_cooldown
                                }
                                _ => true,
                            };

                            if can_attempt {
                                log::warn!(
                                    "UE4SS not loaded for KovaaK pid {pid}; attempting deploy/inject"
                                );
                                match deploy_and_inject_ue4ss(&app, &stats_dir) {
                                    Ok(()) => {
                                        log::info!(
                                            "UE4SS deploy/inject attempt finished for KovaaK pid {pid}"
                                        );
                                    }
                                    Err(e) => {
                                        if bridge::is_injection_deferred_error(&e) {
                                            log::info!(
                                                "UE4SS deploy/inject deferred for KovaaK pid {pid}: {e}"
                                            );
                                        } else {
                                            log::warn!(
                                                "UE4SS deploy/inject attempt failed for KovaaK pid {pid}: {e}"
                                            );
                                        }
                                    }
                                }
                                last_attempt = Some((pid, std::time::Instant::now()));
                            }
                        }
                    }
                    None => {
                        last_attempt = None;
                    }
                }

                std::thread::sleep(poll_interval);
            }
        })
        .ok();
}

#[cfg(not(target_os = "windows"))]
fn start_ue4ss_reinject_monitor(_app: AppHandle, _stats_dir: String) {}

mod bridge;
mod file_watcher;
mod kovaaks_api;
mod logger;
mod mouse_hook;
mod replay_store;
mod sapi;
mod scenario_index;
mod screen_recorder;
mod session_store;
mod settings;
mod stats_db;
mod steam_api;
mod steam_integration;
mod window_tracker;

use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, Emitter, Manager, Runtime,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

pub use settings::{AppSettings, FriendProfile};

/// Global app state accessible from Tauri commands.
pub struct AppState {
    pub settings: Arc<Mutex<AppSettings>>,
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
/// Used by frontend overlays to convert CSS coords → absolute screen pixels.
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
    let Some(win) = app.get_webview_window("overlay") else {
        return;
    };
    let monitors = win.available_monitors().unwrap_or_default();
    let monitor = monitors.get(index).or_else(|| monitors.first());
    let Some(m) = monitor else { return };

    let pos = m.position();
    let size = m.size();
    let sf = m.scale_factor();
    let logical_pos = pos.to_logical::<f64>(sf);

    let _ = win.set_fullscreen(false);
    let _ = win.set_position(tauri::LogicalPosition::new(logical_pos.x, logical_pos.y));
    let _ = win.set_fullscreen(true);

    // Keep the screen recorder capture rect in sync with whichever monitor the
    // overlay is on.  Uses physical pixel coordinates to match GDI capture.
    let monitor_rect = settings::RegionRect {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
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
    mouse_hook::set_dpi(new_settings.mouse_dpi);
    mouse_hook::set_feedback_enabled(new_settings.live_feedback_enabled);
    mouse_hook::set_feedback_verbosity(new_settings.live_feedback_verbosity);
    let _ = app.emit("settings-changed", ());
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
/// their Steam64 ID as `username`; scores are still fetched using the steamId
/// query param so VS-mode comparison works for them too.
#[tauri::command]
async fn add_friend(
    username: String,
    search_type: Option<String>,
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<FriendProfile, String> {
    let trimmed = username.trim().to_string();

    let looks_like_steam =
        steam_api::is_steam64_id(&trimmed) || trimmed.contains("steamcommunity.com");

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
        Some("kovaaks") => kovaaks_api::fetch_user_profile(&trimmed)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("No KovaaK's account found for '{}'", trimmed))?,
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
        s.friends
            .iter()
            .any(|f| f.username.eq_ignore_ascii_case(&friend.username))
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
    s.friends
        .retain(|f| !f.username.eq_ignore_ascii_case(&username));
    let cloned = s.clone();
    drop(s);
    settings::persist(&app, &cloned).map_err(|e| e.to_string())
}

/// Fetch a friend's best score for a specific scenario from the KovaaK's API.
/// Works for both KovaaK's-account holders (lookup by username) and Steam-only
/// players (lookup by Steam64 ID via the `steamId` query param).
#[tauri::command]
async fn fetch_friend_score(
    username: String,
    scenario_name: String,
) -> Result<Option<f64>, String> {
    // If Steam-only user, use leaderboard search fallback
    if steam_api::is_steam64_id(&username) {
        // 1. Search for scenario to get leaderboard ID
        let scenario_page = kovaaks_api::search_scenarios(&scenario_name, 0, 20)
            .await
            .map_err(|e| format!("Failed to search scenario: {e}"))?;
        let scenario = scenario_page
            .data
            .iter()
            .find(|s| s.scenario_name.eq_ignore_ascii_case(&scenario_name));
        let leaderboard_id = if let Some(s) = scenario {
            s.leaderboard_id
        } else {
            return Ok(None);
        };

        // 2. Search leaderboard pages for the steam_id
        let max_pages = 5;
        let page_size = 100;
        for page in 0..max_pages {
            let lb = kovaaks_api::get_leaderboard_page(leaderboard_id, page, page_size)
                .await
                .map_err(|e| format!("Failed to fetch leaderboard: {e}"))?;
            if let Some(entry) = lb.data.iter().find(|e| e.steam_id == username) {
                return Ok(Some(entry.score));
            }
            if lb.data.is_empty() {
                break;
            }
        }
        return Ok(None);
    }
    // Normal KovaaK's username path
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
            let kovaaks =
                match kovaaks_api::find_user_by_steam_id(&steam.steam_id, &steam.display_name)
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
                s.friends
                    .iter()
                    .any(|x| x.username.eq_ignore_ascii_case(&f.username))
            };
            if !dupe {
                s.friends.push(f.clone());
            }
        }
        let cloned = s.clone();
        drop(s);
        settings::persist(&app, &cloned).map_err(|e| e.to_string())?;
    }

    log::info!(
        "import_steam_friends: imported {} friends",
        new_friends.len()
    );
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
            log::info!(
                "validate_scenario: local match {:?} → {:?}",
                scenario_name,
                canonical
            );
            return Some(canonical);
        }
    }
    // 2. Fall back to the KovaaK's API for scenarios not yet in the local index.
    let result = kovaaks_api::validate_scenario_name(&scenario_name).await;
    log::info!(
        "validate_scenario: API result for {:?} = {:?}",
        scenario_name,
        result
    );
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
fn load_session_replay(app: AppHandle, session_id: String) -> Option<replay_store::ReplayData> {
    replay_store::load_replay(&app, &session_id)
}

#[tauri::command]
fn replay_play_in_game(
    app: AppHandle,
    session_id: String,
    speed: Option<f64>,
) -> Result<(), String> {
    let replay = replay_store::load_replay(&app, &session_id)
        .ok_or_else(|| format!("replay not found: {session_id}"))?;
    let run_snapshot = replay
        .run_snapshot
        .ok_or_else(|| "replay has no run snapshot".to_string())?;
    let tick_stream = run_snapshot
        .tick_stream_v1
        .ok_or_else(|| "replay has no tick_stream_v1 payload".to_string())?;
    bridge::start_in_game_replay_stream(&session_id, tick_stream, speed.unwrap_or(1.0))
}

#[tauri::command]
fn replay_stop_in_game() -> Result<(), String> {
    bridge::stop_in_game_replay_stream()
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
                name: m
                    .name()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("Monitor {}", i + 1)),
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
fn import_session_csv_history(
    app: AppHandle,
    state: tauri::State<AppState>,
) -> Result<file_watcher::CsvImportSummary, String> {
    let stats_dir = {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings.stats_dir.clone()
    };
    file_watcher::import_csv_history(&app, &stats_dir)
}

#[tauri::command]
fn get_log_buffer() -> Vec<logger::LogEntry> {
    logger::get_buffer()
}

#[tauri::command]
fn clear_log_buffer() {
    logger::clear_buffer();
}

#[tauri::command]
async fn search_scenarios(
    query: String,
    page: u64,
    max: u64,
) -> Result<kovaaks_api::ScenarioPage, String> {
    kovaaks_api::search_scenarios(&query, page, max)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_leaderboard_page(
    leaderboard_id: u64,
    page: u64,
    max: u64,
) -> Result<kovaaks_api::LeaderboardPage, String> {
    kovaaks_api::get_leaderboard_page(leaderboard_id, page, max)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_scenario_details(leaderboard_id: u64) -> Result<kovaaks_api::ScenarioDetails, String> {
    kovaaks_api::get_scenario_details(leaderboard_id)
        .await
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct CursorPos {
    x: i32,
    y: i32,
}

/// Return the current cursor position in physical screen coordinates.
/// Used by the frontend to implement cursor-proximity passthrough toggling.
#[tauri::command]
fn get_cursor_pos() -> CursorPos {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut pt = POINT { x: 0, y: 0 };
        unsafe {
            let _ = GetCursorPos(&mut pt);
        }
        return CursorPos { x: pt.x, y: pt.y };
    }
    #[allow(unreachable_code)]
    CursorPos { x: 0, y: 0 }
}

#[tauri::command]
fn set_mouse_passthrough(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        win.set_ignore_cursor_events(enabled)
            .map_err(|e| e.to_string())?;
    }
    // When passthrough is OFF (settings open), keep overlay visible
    // even if KovaaK's isn't the foreground window.
    window_tracker::set_force_show(!enabled);
    Ok(())
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
        // Resolve just the file name of our own executable (e.g. "aimmod.exe").
        let exe_name = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_default();

        if exe_name.is_empty() {
            return;
        }

        // Ask Windows for every running process whose image name matches ours.
        let result = std::process::Command::new("tasklist")
            .args([
                "/FI",
                &format!("IMAGENAME eq {exe_name}"),
                "/FO",
                "CSV",
                "/NH",
            ])
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
            .and_then(|p| p.parent().map(|d| d.join("aimmod.pid")))
            .unwrap_or_else(|| std::env::temp_dir().join("aimmod.pid"));

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
            import_session_csv_history,
            get_overlay_origin,
            get_log_buffer,
            clear_log_buffer,
            get_settings,
            save_settings,
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
            start_mouse_hook,
            stop_mouse_hook,
            get_session_mouse_data,
            get_session_raw_positions,
            get_session_screen_frames,
            load_session_replay,
            replay_play_in_game,
            replay_stop_in_game,
            toggle_settings,
            toggle_overlay,
            set_mouse_passthrough,
            get_monitors,
            set_overlay_monitor,
            get_cursor_pos,
            open_speech_settings,
            open_natural_voices_store,
            search_scenarios,
            get_leaderboard_page,
            get_scenario_details,
            inject_bridge,
            ue4ss_get_recent_logs,
            ue4ss_trigger_hot_reload,
            ue4ss_get_runtime_flags,
            ue4ss_set_runtime_flag,
            ue4ss_reload_runtime_flags,
            // list_sapi_voices and speak_with_sapi are preserved in lib.rs + sapi.rs
            // for future use but not registered until a working voice backend is confirmed.
        ])
        .setup(|app| {
            // Load persisted settings
            let loaded = settings::load(app.handle()).unwrap_or_default();

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
            log::info!(
                "AimMod starting up — log file: {}",
                logger::log_file_path().display()
            );

            session_store::initialize(app.handle());

            // Start file watcher
            file_watcher::start(app.handle().clone(), &loaded.stats_dir);

            // Start mouse hook (captures events; metrics only emitted during sessions)
            let _ = mouse_hook::start(app.handle().clone());
            mouse_hook::set_dpi(loaded.mouse_dpi);
            mouse_hook::set_feedback_enabled(loaded.live_feedback_enabled);
            mouse_hook::set_feedback_verbosity(loaded.live_feedback_verbosity);

            // Start pipe server before injection so early UE4SS events are not lost.
            bridge::start(app.handle().clone());
            if let Err(e) = bridge::start_log_tailer(app.handle().clone(), &loaded.stats_dir) {
                log::warn!("Failed to start UE4SS log tailer: {e}");
            }
            // Deploy UE4SS runtime/mod payload and manually inject UE4SS.dll.
            if let Err(e) = deploy_and_inject_ue4ss(app.handle(), &loaded.stats_dir) {
                if bridge::is_injection_deferred_error(&e) {
                    log::info!("Deferred UE4SS injection: {e}");
                } else {
                    log::error!("Failed to deploy/inject UE4SS runtime: {e}");
                }
            }
            start_ue4ss_reinject_monitor(app.handle().clone(), loaded.stats_dir.clone());

            // Build system tray (Windows only)
            #[cfg(not(target_os = "linux"))]
            setup_tray(app)?;

            // Configure desktop overlay window and start focus tracking.
            if let Some(win) = app.get_webview_window("overlay") {
                let _ = win.set_ignore_cursor_events(true);
                // Force the window background to fully transparent so the DWM
                // compositor does not tint or dim the game colours underneath.
                let _ = win.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                let _ = win.show();
            }
            // Ensure monitor placement + screen recorder capture rect are initialized
            // on startup from persisted settings (without requiring manual monitor re-select).
            apply_monitor(app.handle(), loaded.monitor_index);
            window_tracker::set_force_show(false);
            window_tracker::start(app.handle().clone());
            let initial_game_focus = window_tracker::is_game_focused();
            log::info!("Window tracker started (initial game focus={initial_game_focus})");

            // Keep the stats window alive when the user clicks X so that its
            // session-complete listener remains registered.  Closing hides
            // instead of destroying; the window is shown again on the next
            // session-complete event or via the tray menu.
            if let Some(stats_win) = app.get_webview_window("stats") {
                let w = stats_win.clone();
                stats_win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        w.hide().ok();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_tray<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let open_settings =
        MenuItem::with_id(app, "open_settings", "Settings  (F8)", true, None::<&str>)?;
    let toggle_debug_state_hud = MenuItem::with_id(
        app,
        "toggle_debug_state_hud",
        "Toggle Debug State HUD  (F9)",
        true,
        None::<&str>,
    )?;
    let open_stats = MenuItem::with_id(app, "open_stats", "Session Stats", true, None::<&str>)?;
    let toggle_overlay =
        MenuItem::with_id(app, "toggle_overlay", "Toggle AimMod", true, None::<&str>)?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open_settings,
            &toggle_debug_state_hud,
            &open_stats,
            &toggle_overlay,
            &separator,
            &quit,
        ],
    )?;

    let mut tray_builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("AimMod");
    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }
    let _tray = tray_builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open_settings" => {
                let _ = app.emit("toggle-settings", ());
            }
            "toggle_debug_state_hud" => {
                let _ = app.emit("toggle-debug-state-overlay", ());
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
            {}
        })
        .build(app)?;

    Ok(())
}
