use crate::{
    FriendProfile, benchmark_overlay, bridge, current_overlay_runtime_notice, file_watcher,
    kovaaks_theme, mouse_hook, session_store,
};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const OVERLAY_PORT: u16 = 43115;
static STARTED: AtomicBool = AtomicBool::new(false);
static PALETTE_CACHE: OnceLock<Mutex<Option<CachedPalette>>> = OnceLock::new();

/// Incremented every time overlay state changes. SSE loops wait on this.
static STATE_VERSION: AtomicU64 = AtomicU64::new(0);

const PALETTE_CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
struct CachedPalette {
    path: String,
    loaded_at: Instant,
    palette: kovaaks_theme::KovaaksPalette,
}

fn state_notify() -> &'static (Mutex<u64>, Condvar) {
    static NOTIFY: OnceLock<(Mutex<u64>, Condvar)> = OnceLock::new();
    NOTIFY.get_or_init(|| (Mutex::new(0), Condvar::new()))
}

fn palette_cache() -> &'static Mutex<Option<CachedPalette>> {
    PALETTE_CACHE.get_or_init(|| Mutex::new(None))
}

/// Call this whenever overlay-relevant state changes. Wakes all SSE connections.
pub fn notify_state_changed() {
    let version = STATE_VERSION.fetch_add(1, Ordering::Relaxed) + 1;
    let (lock, cvar) = state_notify();
    if let Ok(mut guard) = lock.lock() {
        *guard = version;
        cvar.notify_all();
    }
}

#[derive(Debug, Clone, serde::Serialize)]
struct OverlayRuntimeHealth {
    game_running: bool,
    runtime_loaded: bool,
    bridge_connected: bool,
    has_recent_stats: bool,
    restart_required: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
struct OverlayStateEnvelope {
    generated_at_unix_ms: u64,
    active_overlay_preset_id: String,
    active_surface_assignments: crate::settings::OverlaySurfaceAssignments,
    overlay_presets: Vec<crate::settings::OverlayPreset>,
    friends: Vec<FriendProfile>,
    selected_friend: Option<String>,
    current_user: Option<FriendProfile>,
    stats_panel: crate::bridge::BridgeOverlayStatsSnapshot,
    mouse_metrics: Option<crate::mouse_hook::MouseMetrics>,
    session_result: Option<crate::file_watcher::SessionCompletePayload>,
    live_feedback: Option<crate::mouse_hook::LiveFeedback>,
    personal_best_score: Option<f64>,
    friend_scores: Option<crate::bridge::BridgeFriendScoresSnapshot>,
    benchmark_state: crate::benchmark_overlay::OverlayBenchmarkState,
    runtime_notice: super::OverlayRuntimeNotice,
    runtime_health: OverlayRuntimeHealth,
}

pub fn start(app: AppHandle, settings: Arc<std::sync::Mutex<crate::settings::AppSettings>>) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let _ = std::thread::Builder::new()
        .name("overlay-http".into())
        .spawn(move || server_loop(app, settings));
}

fn server_loop(app: AppHandle, settings: Arc<std::sync::Mutex<crate::settings::AppSettings>>) {
    let listener = match TcpListener::bind(("127.0.0.1", OVERLAY_PORT)) {
        Ok(listener) => listener,
        Err(error) => {
            log::warn!("overlay_service: failed to bind 127.0.0.1:{OVERLAY_PORT}: {error}");
            return;
        }
    };

    log::info!(
        "overlay_service: browser overlay available at http://127.0.0.1:{OVERLAY_PORT}/browser-overlay.html?surface=obs"
    );

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let app = app.clone();
                let settings = settings.clone();
                let _ = std::thread::Builder::new()
                    .name("overlay-http-client".into())
                    .spawn(move || {
                        if let Err(error) = handle_client(stream, &app, &settings) {
                            log::debug!("overlay_service: client ended: {error}");
                        }
                    });
            }
            Err(error) => {
                log::warn!("overlay_service: incoming connection failed: {error}");
                std::thread::sleep(Duration::from_millis(150));
            }
        }
    }
}

fn handle_client(
    mut stream: TcpStream,
    app: &AppHandle,
    settings: &Arc<std::sync::Mutex<crate::settings::AppSettings>>,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    if request_line.trim().is_empty() {
        return Ok(());
    }
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .split('?')
        .next()
        .unwrap_or("/");

    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        if header == "\r\n" || header.is_empty() {
            break;
        }
    }

    match path {
        "/" => redirect(&mut stream, "/browser-overlay.html?surface=obs"),
        "/obs-overlay.html" | "/browser-overlay.html" => {
            serve_static_file(&mut stream, app, "browser-overlay.html")
        }
        "/api/streamer-overlay/state" => serve_json(&mut stream, &build_state(app, settings)),
        "/api/streamer-overlay/events" => serve_sse(stream, app, settings),
        "/api/streamer-overlay/mouse-path" => serve_mouse_path(&mut stream),
        asset_path => {
            let relative = asset_path.trim_start_matches('/');
            serve_static_file(&mut stream, app, relative)
        }
    }
}

fn redirect(stream: &mut TcpStream, location: &str) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
}

fn serve_mouse_path(stream: &mut TcpStream) -> std::io::Result<()> {
    let positions = crate::mouse_hook::get_raw_positions();
    let recent: Vec<_> = if positions.is_empty() {
        vec![]
    } else {
        let latest_ts = positions.last().unwrap().timestamp_ms;
        let cutoff = latest_ts.saturating_sub(3000);
        positions
            .into_iter()
            .filter(|p| p.timestamp_ms >= cutoff)
            .collect()
    };
    let body = serde_json::to_vec(&recent).unwrap_or_else(|_| b"[]".to_vec());
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(&body)
}

fn serve_json<T: serde::Serialize>(stream: &mut TcpStream, value: &T) -> std::io::Result<()> {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(&body)
}

fn serve_sse(
    mut stream: TcpStream,
    app: &AppHandle,
    settings: &Arc<std::sync::Mutex<crate::settings::AppSettings>>,
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
    )?;

    let mut last_payload = String::new();
    let mut last_version = STATE_VERSION.load(Ordering::Relaxed);
    let (lock, cvar) = state_notify();
    loop {
        // Wait until state_version changes or 500ms elapses (fallback for health/mouse metrics).
        if let Ok(guard) = lock.lock() {
            let _ =
                cvar.wait_timeout_while(guard, Duration::from_millis(500), |v| *v == last_version);
        }
        last_version = STATE_VERSION.load(Ordering::Relaxed);

        let payload =
            serde_json::to_string(&build_state(app, settings)).unwrap_or_else(|_| "{}".to_string());
        if payload != last_payload {
            stream.write_all(format!("data: {payload}\n\n").as_bytes())?;
            stream.flush()?;
            last_payload = payload;
        }
    }
}

fn serve_static_file(
    stream: &mut TcpStream,
    app: &AppHandle,
    relative_path: &str,
) -> std::io::Result<()> {
    let safe_relative = relative_path.replace('\\', "/");
    if safe_relative.contains("..") {
        return not_found(stream);
    }

    let Some(root) = resolve_frontend_dist_dir(app) else {
        return not_found(stream);
    };
    let path = root.join(&safe_relative);
    let canonical_root = root.canonicalize().ok();
    let canonical_path = path.canonicalize().ok();
    if canonical_root.is_some()
        && canonical_path.is_some()
        && !canonical_path
            .as_ref()
            .unwrap()
            .starts_with(canonical_root.as_ref().unwrap())
    {
        return not_found(stream);
    }

    let mut bytes = Vec::new();
    match std::fs::File::open(&path).and_then(|mut file| file.read_to_end(&mut bytes)) {
        Ok(_) => {
            let content_type = content_type_for_path(&path);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            )?;
            stream.write_all(&bytes)
        }
        Err(_) => not_found(stream),
    }
}

fn not_found(stream: &mut TcpStream) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found"
    )
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
    {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn resolve_frontend_dist_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("dist");
        if candidate.is_dir() {
            return Some(candidate);
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let candidate = cwd.join("dist");
        if candidate.is_dir() {
            return Some(candidate);
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            for ancestor in exe_dir.ancestors().take(8) {
                let candidate = ancestor.join("dist");
                if candidate.is_dir() {
                    return Some(candidate);
                }
            }
        }
    }

    if let Some(manifest_dir) = option_env!("CARGO_MANIFEST_DIR") {
        let candidate = Path::new(manifest_dir).join("../dist");
        if candidate.is_dir() {
            return Some(candidate);
        }
    }

    None
}

fn normalize_scenario_name(value: &str) -> String {
    let trimmed = value.trim().to_ascii_lowercase();
    trimmed
        .strip_suffix(" - challenge start")
        .or_else(|| trimmed.strip_suffix(" - challenge"))
        .unwrap_or(&trimmed)
        .trim()
        .to_string()
}

fn current_overlay_user() -> Option<FriendProfile> {
    bridge::current_kovaaks_user()
        .as_ref()
        .and_then(crate::friend_profile_from_bridge_user)
}

fn normalized_hex(value: Option<&String>) -> Option<String> {
    let trimmed = value?.trim().trim_start_matches('#');
    if trimmed.len() < 6 || !trimmed.chars().take(6).all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{}", &trimmed[..6]))
}

fn resolved_palette_path(settings: &crate::settings::AppSettings) -> String {
    if settings.kovaaks_palette_path.trim().is_empty() {
        kovaaks_theme::default_palette_path()
    } else {
        settings.kovaaks_palette_path.trim().to_string()
    }
}

fn load_palette_cached(path: &str) -> kovaaks_theme::KovaaksPalette {
    if path.trim().is_empty() {
        return kovaaks_theme::KovaaksPalette::default();
    }

    if let Ok(cache) = palette_cache().lock() {
        if let Some(entry) = cache.as_ref() {
            if entry.path == path && entry.loaded_at.elapsed() < PALETTE_CACHE_TTL {
                return entry.palette.clone();
            }
        }
    }

    let palette = kovaaks_theme::read_palette(path);
    if let Ok(mut cache) = palette_cache().lock() {
        *cache = Some(CachedPalette {
            path: path.to_string(),
            loaded_at: Instant::now(),
            palette: palette.clone(),
        });
    }
    palette
}

fn apply_palette_override(theme: &mut crate::settings::OverlayTheme, key: &str, value: &str) {
    match key {
        "Primary" => {
            theme.primary_color = value.to_string();
            theme.border_color = value.to_string();
            theme.glow_color = value.to_string();
        }
        "Secondary" => theme.surface_color = value.to_string(),
        "Background" => theme.background_color = value.to_string(),
        "SpecialCallToAction" => theme.accent_color = value.to_string(),
        "SpecialText" => theme.muted_text_color = value.to_string(),
        "HudBackground" => theme.background_gradient_start = value.to_string(),
        "HudBarBackground" => {
            theme.background_gradient_end = value.to_string();
            theme.surface_color = value.to_string();
        }
        "HudEnemyHealthBar" => theme.danger_color = value.to_string(),
        "HudJetPackBar" => theme.warning_color = value.to_string(),
        "HudWeaponAmmoBar" => theme.accent_color = value.to_string(),
        "HudWeaponChangeBar" => theme.accent_color = value.to_string(),
        "InfoDodge" => theme.info_color = value.to_string(),
        "InfoWeapon" => theme.info_color = value.to_string(),
        "ChallengeGraph" => theme.info_color = value.to_string(),
        _ => {}
    }
}

fn resolve_theme_with_app_colors(
    mut theme: crate::settings::OverlayTheme,
    settings: &crate::settings::AppSettings,
    palette: Option<&kovaaks_theme::KovaaksPalette>,
) -> crate::settings::OverlayTheme {
    let default_accent = "#00f5a0".to_string();
    match settings.color_mode.trim() {
        "default" => {
            theme.primary_color = default_accent.clone();
            theme.border_color = default_accent.clone();
            theme.glow_color = default_accent;
        }
        "custom" => {
            let custom = settings.custom_accent_color.trim();
            let accent = if custom.len() == 7 && custom.starts_with('#') {
                custom.to_string()
            } else {
                default_accent
            };
            theme.primary_color = accent.clone();
            theme.border_color = accent.clone();
            theme.glow_color = accent;
        }
        _ => {
            if let Some(palette) = palette {
                if let Some(value) = normalized_hex(palette.primary_hex.as_ref()) {
                    theme.primary_color = value.clone();
                    theme.border_color = value.clone();
                    theme.glow_color = value;
                }
                if let Some(value) = normalized_hex(
                    palette
                        .hud_weapon_change_bar_hex
                        .as_ref()
                        .or(palette.hud_weapon_ammo_bar_hex.as_ref())
                        .or(palette.secondary_hex.as_ref())
                        .or(palette.special_call_to_action_hex.as_ref()),
                ) {
                    theme.accent_color = value;
                }
                if let Some(value) = normalized_hex(palette.hud_enemy_health_bar_hex.as_ref()) {
                    theme.danger_color = value;
                }
                if let Some(value) = normalized_hex(
                    palette
                        .hud_jet_pack_bar_hex
                        .as_ref()
                        .or(palette.hud_countdown_timer_hex.as_ref()),
                ) {
                    theme.warning_color = value;
                }
                if let Some(value) = normalized_hex(
                    palette
                        .info_dodge_hex
                        .as_ref()
                        .or(palette.info_weapon_hex.as_ref())
                        .or(palette.challenge_graph_hex.as_ref()),
                ) {
                    theme.info_color = value;
                }
                if let Some(value) = normalized_hex(palette.special_text_hex.as_ref()) {
                    theme.muted_text_color = value;
                }
                if let Some(value) = normalized_hex(palette.background_hex.as_ref()) {
                    theme.background_color = value;
                }
                if let Some(value) = normalized_hex(
                    palette
                        .hud_background_hex
                        .as_ref()
                        .or(palette.background_hex.as_ref()),
                ) {
                    theme.background_gradient_start = value;
                }
                if let Some(value) = normalized_hex(
                    palette
                        .hud_bar_background_hex
                        .as_ref()
                        .or(palette.secondary_hex.as_ref())
                        .or(palette.background_hex.as_ref()),
                ) {
                    theme.background_gradient_end = value.clone();
                    theme.surface_color = value;
                } else if let Some(value) = normalized_hex(palette.secondary_hex.as_ref()) {
                    theme.surface_color = value;
                }
            }

            for (key, value) in &settings.palette_color_overrides {
                let valid = value.starts_with('#')
                    && value.len() >= 7
                    && value
                        .chars()
                        .skip(1)
                        .take(6)
                        .all(|ch| ch.is_ascii_hexdigit());
                if valid {
                    apply_palette_override(&mut theme, key, &value[..7]);
                }
            }
        }
    }

    theme
}

fn resolved_overlay_presets(
    settings: &crate::settings::AppSettings,
) -> Vec<crate::settings::OverlayPreset> {
    let wants_app_colors = settings
        .overlay_presets
        .iter()
        .any(|preset| preset.theme.color_sync_mode.trim() == "app");
    let palette = if wants_app_colors && settings.color_mode.trim() == "kovaaks" {
        Some(load_palette_cached(&resolved_palette_path(settings)))
    } else {
        None
    };

    settings
        .overlay_presets
        .iter()
        .cloned()
        .map(|mut preset| {
            if preset.theme.color_sync_mode.trim() == "app" {
                preset.theme =
                    resolve_theme_with_app_colors(preset.theme.clone(), settings, palette.as_ref());
            }
            preset
        })
        .collect()
}

fn build_state(
    app: &AppHandle,
    settings: &Arc<std::sync::Mutex<crate::settings::AppSettings>>,
) -> OverlayStateEnvelope {
    let settings = settings
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    let current_user = current_overlay_user();
    let stats_panel = bridge::current_overlay_stats_snapshot();
    let session_result = file_watcher::last_session_complete_payload();
    let scenario_name = stats_panel.scenario_name.clone().or_else(|| {
        session_result
            .as_ref()
            .map(|payload| payload.result.scenario.clone())
    });
    let personal_best_score = scenario_name
        .as_deref()
        .map(normalize_scenario_name)
        .and_then(|name| session_store::get_personal_best_for_scenario(app, &name))
        .map(|value| value as f64);
    let runtime_loaded = bridge::current_game_pid()
        .map(bridge::is_ue4ss_loaded_for_pid)
        .unwrap_or(false);

    OverlayStateEnvelope {
        generated_at_unix_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
        active_overlay_preset_id: settings.active_overlay_preset_id.clone(),
        active_surface_assignments: settings.active_surface_assignments.clone(),
        overlay_presets: resolved_overlay_presets(&settings),
        friends: settings.friends.clone(),
        selected_friend: settings.selected_friend.clone(),
        current_user: current_user.clone(),
        stats_panel,
        mouse_metrics: mouse_hook::get_latest_metrics(),
        session_result,
        live_feedback: mouse_hook::get_latest_live_feedback(),
        personal_best_score,
        friend_scores: bridge::current_kovaaks_friend_scores(),
        benchmark_state: benchmark_overlay::snapshot(
            app,
            &settings,
            current_user.as_ref(),
            scenario_name.as_deref(),
        ),
        runtime_notice: current_overlay_runtime_notice(),
        runtime_health: OverlayRuntimeHealth {
            game_running: bridge::current_game_pid().is_some(),
            runtime_loaded,
            bridge_connected: bridge::is_bridge_dll_connected(),
            has_recent_stats: bridge::has_recent_bridge_stats_flow(),
            restart_required: bridge::is_runtime_restart_required(),
        },
    }
}
