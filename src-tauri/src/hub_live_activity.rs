use std::sync::{Arc, Mutex, OnceLock};
use std::thread::sleep;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use reqwest::Client;
use tauri::AppHandle;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket, connect};

static HUB_LIVE_ACTIVITY_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(10))
        .http1_only()
        .build()
        .expect("failed to build hub live activity client")
});

static STARTED: OnceLock<()> = OnceLock::new();

const POLL_INTERVAL: Duration = Duration::from_secs(1);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HubLiveActivityPayload {
    game_state_code: i32,
    game_state: String,
    paused: bool,
    scenario_name: Option<String>,
    scenario_type: Option<String>,
    scenario_subtype: Option<String>,
    score: Option<f64>,
    score_per_minute: Option<f64>,
    accuracy_pct: Option<f64>,
    kills: Option<u32>,
    elapsed_secs: Option<f64>,
    time_remaining_secs: Option<f64>,
    queue_time_remaining_secs: Option<f64>,
    runtime_loaded: bool,
    bridge_connected: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum HubLiveActivitySocketMessage<'a> {
    Update { payload: &'a HubLiveActivityPayload },
    Clear,
}

fn clean_text(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn current_live_activity_payload() -> Option<HubLiveActivityPayload> {
    let pid = crate::bridge::current_game_pid()?;
    let runtime_loaded = crate::bridge::is_ue4ss_loaded_for_pid(pid);
    let bridge_connected = crate::bridge::is_bridge_dll_connected();
    let stats = crate::bridge::current_overlay_stats_snapshot();
    let paused = stats.scenario_is_paused.unwrap_or(false);

    let scenario_type = match stats.scenario_type.trim() {
        "" | "Unknown" => None,
        other => Some(other.to_string()),
    };
    let game_state = clean_text(stats.game_state.clone()).unwrap_or_else(|| {
        if runtime_loaded && !bridge_connected {
            "Bridge Reconnecting".to_string()
        } else if runtime_loaded {
            "Idling".to_string()
        } else {
            "Launching".to_string()
        }
    });

    Some(HubLiveActivityPayload {
        game_state_code: stats.game_state_code.unwrap_or_default(),
        game_state,
        paused,
        scenario_name: clean_text(stats.scenario_name),
        scenario_type,
        scenario_subtype: clean_text(stats.scenario_subtype),
        score: stats.score_total.or(stats.score_total_derived),
        score_per_minute: stats.spm,
        accuracy_pct: stats.accuracy_pct,
        kills: stats.kills,
        elapsed_secs: stats.challenge_seconds_total.or(stats.session_time_secs),
        time_remaining_secs: stats.time_remaining,
        queue_time_remaining_secs: stats.queue_time_remaining,
        runtime_loaded,
        bridge_connected,
    })
}

fn payload_signature(payload: &HubLiveActivityPayload) -> String {
    serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_string())
}

fn websocket_endpoint(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("https://") {
        return Some(format!("wss://{rest}/activity/live/ws"));
    }
    if let Some(rest) = trimmed.strip_prefix("http://") {
        return Some(format!("ws://{rest}/activity/live/ws"));
    }
    if trimmed.is_empty() {
        None
    } else {
        Some(format!("wss://{trimmed}/activity/live/ws"))
    }
}

fn connect_live_socket(
    base_url: &str,
    upload_token: &str,
) -> Option<WebSocket<MaybeTlsStream<std::net::TcpStream>>> {
    let endpoint = websocket_endpoint(base_url)?;
    let mut request = endpoint.into_client_request().ok()?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {upload_token}").parse().ok()?,
    );
    match connect(request) {
        Ok((socket, _)) => Some(socket),
        Err(error) => {
            log::debug!("hub_live_activity: websocket connect failed: {error}");
            None
        }
    }
}

fn send_socket_message(
    socket: &mut WebSocket<MaybeTlsStream<std::net::TcpStream>>,
    message: &HubLiveActivitySocketMessage<'_>,
) -> bool {
    let payload = match serde_json::to_string(message) {
        Ok(payload) => payload,
        Err(error) => {
            log::debug!("hub_live_activity: websocket encode failed: {error}");
            return false;
        }
    };
    match socket.send(Message::Text(payload.into())) {
        Ok(_) => true,
        Err(error) => {
            log::debug!("hub_live_activity: websocket send failed: {error}");
            false
        }
    }
}

async fn publish_payload(
    base_url: &str,
    upload_token: &str,
    payload: &HubLiveActivityPayload,
) -> bool {
    let endpoint = format!("{base_url}/activity/live");
    let request = HUB_LIVE_ACTIVITY_CLIENT
        .post(endpoint)
        .header("Authorization", format!("Bearer {upload_token}"))
        .json(payload);

    match request.send().await {
        Ok(response) if response.status().is_success() => true,
        Ok(response) => {
            log::debug!(
                "hub_live_activity: publish failed with status {}",
                response.status()
            );
            false
        }
        Err(error) => {
            log::debug!("hub_live_activity: publish failed: {error}");
            false
        }
    }
}

async fn clear_payload(base_url: &str, upload_token: &str) -> bool {
    let endpoint = format!("{base_url}/activity/live");
    let request = HUB_LIVE_ACTIVITY_CLIENT
        .delete(endpoint)
        .header("Authorization", format!("Bearer {upload_token}"));

    match request.send().await {
        Ok(response) if response.status().is_success() => true,
        Ok(response) => {
            log::debug!(
                "hub_live_activity: clear failed with status {}",
                response.status()
            );
            false
        }
        Err(error) => {
            log::debug!("hub_live_activity: clear failed: {error}");
            false
        }
    }
}

pub fn start(_app: AppHandle, settings: Arc<Mutex<crate::settings::AppSettings>>) {
    if STARTED.set(()).is_err() {
        return;
    }

    let _ = std::thread::Builder::new()
        .name("hub-live-activity".into())
        .spawn(move || {
            let mut last_signature: Option<String> = None;
            let mut last_publish_at: Option<Instant> = None;
            let mut published = false;
            let mut socket: Option<WebSocket<MaybeTlsStream<std::net::TcpStream>>> = None;
            let mut socket_key: Option<(String, String)> = None;

            loop {
                let (hub_sync_enabled, base_url, upload_token) = {
                    let guard = settings.lock().ok();
                    let loaded = guard.as_deref();
                    let hub_sync_enabled = loaded.map(|s| s.hub_sync_enabled).unwrap_or(false);
                    let base_url = loaded
                        .map(|s| crate::hub_sync::normalize_base_url(&s.hub_api_base_url))
                        .unwrap_or_default();
                    let upload_token = loaded
                        .map(|s| s.hub_upload_token.trim().to_string())
                        .unwrap_or_default();
                    (hub_sync_enabled, base_url, upload_token)
                };

                let configured =
                    hub_sync_enabled && !base_url.is_empty() && !upload_token.is_empty();
                if !configured {
                    if published && !base_url.is_empty() && !upload_token.is_empty() {
                        tauri::async_runtime::block_on(clear_payload(&base_url, &upload_token));
                    }
                    socket = None;
                    socket_key = None;
                    published = false;
                    last_signature = None;
                    last_publish_at = None;
                    sleep(POLL_INTERVAL);
                    continue;
                }

                let desired_socket_key = (base_url.clone(), upload_token.clone());
                if socket_key.as_ref() != Some(&desired_socket_key) {
                    socket = None;
                    socket_key = None;
                }
                if socket.is_none() {
                    socket = connect_live_socket(&base_url, &upload_token);
                    if socket.is_some() {
                        socket_key = Some(desired_socket_key.clone());
                    }
                }

                let payload = current_live_activity_payload();
                match payload {
                    Some(payload) => {
                        let signature = payload_signature(&payload);
                        let should_publish = last_signature.as_deref() != Some(signature.as_str())
                            || last_publish_at
                                .map(|at| at.elapsed() >= HEARTBEAT_INTERVAL)
                                .unwrap_or(true);

                        if should_publish {
                            let published_now = if let Some(active_socket) = socket.as_mut() {
                                let sent = send_socket_message(
                                    active_socket,
                                    &HubLiveActivitySocketMessage::Update { payload: &payload },
                                );
                                if !sent {
                                    socket = None;
                                    socket_key = None;
                                }
                                sent
                            } else {
                                false
                            } || tauri::async_runtime::block_on(
                                publish_payload(&base_url, &upload_token, &payload),
                            );
                            if published_now {
                                last_signature = Some(signature);
                                last_publish_at = Some(Instant::now());
                                published = true;
                            }
                        }
                    }
                    None => {
                        if published {
                            let cleared_now = if let Some(active_socket) = socket.as_mut() {
                                let sent = send_socket_message(
                                    active_socket,
                                    &HubLiveActivitySocketMessage::Clear,
                                );
                                if !sent {
                                    socket = None;
                                    socket_key = None;
                                }
                                sent
                            } else {
                                false
                            } || tauri::async_runtime::block_on(clear_payload(
                                &base_url,
                                &upload_token,
                            ));
                            if cleared_now {
                                published = false;
                                last_signature = None;
                                last_publish_at = None;
                            }
                        }
                    }
                }

                sleep(POLL_INTERVAL);
            }
        });
}
