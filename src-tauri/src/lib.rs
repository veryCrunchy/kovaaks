mod file_watcher;
mod friend_scores; // kept as empty stub — friend data is now in settings.friends
mod kovaaks_api;
mod logger;
mod mouse_hook;
mod ocr;
mod scenario_index;
mod session_store;
mod settings;
mod window_tracker;

use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Runtime,
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

/// Reposition and resize the overlay window to cover the monitor at `index`.
pub fn apply_monitor(app: &AppHandle, index: usize) {
    let Some(win) = app.get_webview_window("overlay") else { return };
    let monitors = win.available_monitors().unwrap_or_default();
    let monitor = monitors.get(index).or_else(|| monitors.first());
    let Some(m) = monitor else { return };

    let pos = m.position();
    let size = m.size();

    let _ = win.set_position(PhysicalPosition::new(pos.x, pos.y));
    let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: size.width,
        height: size.height,
    }));
}

// ─── Tauri Commands ────────────────────────────────────────────────────────────

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

/// Look up a KovaaK's webapp username, fetch their full profile, then persist as a friend.
#[tauri::command]
async fn add_friend(
    username: String,
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<FriendProfile, String> {
    let profile = kovaaks_api::fetch_user_profile(&username)
        .await
        .map_err(|e| e.to_string())?;
    let profile = profile.ok_or_else(|| format!("No KovaaK's account found for '{}'", username))?;
    let friend = FriendProfile {
        username: profile.username.clone(),
        steam_id: profile.steam_id.clone(),
        steam_account_name: profile.steam_account_name.clone(),
        avatar_url: profile.avatar_url.clone(),
        country: profile.country.clone(),
        kovaaks_plus: profile.kovaaks_plus,
    };
    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    if !s.friends.iter().any(|f| f.username.eq_ignore_ascii_case(&username)) {
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
/// Returns `null` if the user has never played that scenario.
#[tauri::command]
async fn fetch_friend_score(
    username: String,
    scenario_name: String,
) -> Result<Option<f64>, String> {
    kovaaks_api::fetch_best_score(&username, &scenario_name)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch a user's most-played scenarios (up to 10) sorted by play count.
#[tauri::command]
async fn fetch_friend_most_played(
    username: String,
) -> Result<Vec<kovaaks_api::MostPlayedEntry>, String> {
    kovaaks_api::fetch_most_played(&username, 10)
        .await
        .map_err(|e| e.to_string())
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
    let (region, scenario_region, poll_ms, stats_dir) = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        (s.region, s.scenario_region, s.ocr_poll_ms, s.stats_dir.clone())
    };
    // Rebuild the local scenario index from CSV filenames in the stats dir.
    // This is the primary source for fast, offline OCR correction.
    let stats_path = std::path::Path::new(&stats_dir);
    if stats_path.exists() {
        scenario_index::rebuild(stats_path);
    }
    ocr::update_scenario_region(scenario_region);
    ocr::start(app, region, poll_ms);
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
    mouse_hook::drain_session_buffer()
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

// ─── App Entry Point ───────────────────────────────────────────────────────────

pub fn run() {
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
            get_friends,
            add_friend,
            remove_friend,
            set_selected_friend,
            fetch_friend_score,
            fetch_friend_most_played,
            validate_username,
            validate_scenario,
            start_ocr,
            stop_ocr,
            start_mouse_hook,
            stop_mouse_hook,
            get_session_mouse_data,
            toggle_settings,
            toggle_overlay,
            set_mouse_passthrough,
            get_monitors,
            set_overlay_monitor,
            get_capture_preview,
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
            log::info!("KovaaK's Overlay starting up — log file: {}", logger::log_file_path().display());

            // Start file watcher
            file_watcher::start(app.handle().clone(), &loaded.stats_dir);

            // Start mouse hook (captures events; metrics only emitted during sessions)
            let _ = mouse_hook::start(app.handle().clone());

            // Start OCR (begins reading SPM once a region is configured)
            ocr::update_scenario_region(loaded.scenario_region);
            ocr::start(app.handle().clone(), loaded.region, loaded.ocr_poll_ms);

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

    let _tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("KovaaK's Overlay")
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
