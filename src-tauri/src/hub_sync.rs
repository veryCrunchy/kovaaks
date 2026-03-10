use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::Context;
use chrono::{Local, NaiveDateTime, TimeZone, Utc};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::bridge::{BridgeRunSnapshot, BridgeRunTimelinePoint};
use crate::file_watcher::SessionResult;
use crate::session_store::{ShotTimingSnapshot, SmoothnessSnapshot, StatsPanelSnapshot};

pub const HUB_SCHEMA_VERSION: u32 = 2;
const CONNECT_PROTOCOL_VERSION: &str = "1";
const INGEST_PATH: &str = "/aimmod.hub.v1.HubService/IngestSession";
const BATCH_INGEST_PATH: &str = "/ingest/batch";
const BATCH_SYNC_CHUNK_SIZE: usize = 25;

static CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .http1_only()
        .build()
        .expect("failed to build AimMod Hub client")
});
static PENDING_SYNC_RUNNING: AtomicBool = AtomicBool::new(false);
static SYNC_STATUS: Lazy<Mutex<HubSyncStatus>> = Lazy::new(|| {
    Mutex::new(HubSyncStatus {
        sync_in_progress: false,
        pending_count: 0,
        last_success_at_unix_ms: None,
        last_error: None,
        last_error_at_unix_ms: None,
        last_uploaded_session_id: None,
    })
});

#[derive(Clone)]
pub struct SessionUploadInput {
    pub session_id: String,
    pub result: SessionResult,
    pub smoothness: Option<SmoothnessSnapshot>,
    pub stats_panel: Option<StatsPanelSnapshot>,
    pub shot_timing: Option<ShotTimingSnapshot>,
    pub run_snapshot: Option<BridgeRunSnapshot>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubSyncStatus {
    pub sync_in_progress: bool,
    pub pending_count: usize,
    pub last_success_at_unix_ms: Option<u64>,
    pub last_error: Option<String>,
    pub last_error_at_unix_ms: Option<u64>,
    pub last_uploaded_session_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubSyncOverview {
    pub configured: bool,
    pub enabled: bool,
    pub account_label: Option<String>,
    pub status: HubSyncStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceLinkStartResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: String,
    expires_in: i64,
    interval: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceLinkPollResponse {
    status: String,
    user: Option<DeviceLinkUser>,
    upload_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceLinkUser {
    username: String,
    display_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubDeviceLinkSession {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in_secs: u64,
    pub interval_secs: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubDeviceLinkPollStatus {
    pub status: String,
    pub account_label: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceLinkStartRequest {
    label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceLinkPollRequest {
    device_code: String,
}

fn now_unix_ms() -> u64 {
    Utc::now().timestamp_millis().max(0) as u64
}

fn set_sync_in_progress(value: bool) {
    SYNC_STATUS.lock().sync_in_progress = value;
}

fn record_sync_success(session_id: Option<&str>) {
    let mut status = SYNC_STATUS.lock();
    status.sync_in_progress = false;
    status.last_success_at_unix_ms = Some(now_unix_ms());
    status.last_error = None;
    status.last_error_at_unix_ms = None;
    status.last_uploaded_session_id = session_id.map(ToOwned::to_owned);
}

fn record_sync_error(message: impl Into<String>) {
    let mut status = SYNC_STATUS.lock();
    status.sync_in_progress = false;
    status.last_error = Some(message.into());
    status.last_error_at_unix_ms = Some(now_unix_ms());
}

fn record_pending_upload_failure(app: &AppHandle, session_id: &str, message: &str) {
    crate::session_store::mark_session_hub_upload_failed(app, session_id, message);
}

fn refresh_pending_count(app: &AppHandle) {
    let pending_count = crate::session_store::get_pending_hub_upload_page(app, 0, 1).total;
    SYNC_STATUS.lock().pending_count = pending_count;
}

pub fn get_sync_overview(app: &AppHandle) -> anyhow::Result<HubSyncOverview> {
    let settings = crate::settings::load(app)?;
    refresh_pending_count(app);
    let status = SYNC_STATUS.lock().clone();
    let account_label = if settings.hub_account_label.trim().is_empty() {
        None
    } else {
        Some(settings.hub_account_label.trim().to_string())
    };
    Ok(HubSyncOverview {
        configured: !normalize_base_url(&settings.hub_api_base_url).is_empty()
            && !settings.hub_upload_token.trim().is_empty(),
        enabled: settings.hub_sync_enabled,
        account_label,
        status,
    })
}

fn open_external_url(url: &str) -> anyhow::Result<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn()?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(url).spawn()?;
        return Ok(());
    }
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        all(unix, not(target_os = "macos"))
    )))]
    {
        anyhow::bail!("opening a browser is not supported on this platform")
    }
}

pub async fn start_device_link(
    app: &AppHandle,
    base_url: Option<String>,
) -> anyhow::Result<HubDeviceLinkSession> {
    let settings = crate::settings::load(app)?;
    let base_url = normalize_base_url(base_url.as_deref().unwrap_or(&settings.hub_api_base_url));
    if base_url.is_empty() {
        anyhow::bail!("AimMod Hub API base URL is required");
    }

    let response = CLIENT
        .post(format!("{base_url}/auth/device/start"))
        .header("Content-Type", "application/json")
        .json(&DeviceLinkStartRequest {
            label: "AimMod desktop".to_string(),
        })
        .send()
        .await
        .with_context(|| format!("error sending request for url ({base_url}/auth/device/start)"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("hub device start returned {status}: {body}");
    }

    let payload = response.json::<DeviceLinkStartResponse>().await?;
    open_external_url(&payload.verification_uri_complete)?;

    Ok(HubDeviceLinkSession {
        device_code: payload.device_code,
        user_code: payload.user_code,
        verification_uri: payload.verification_uri,
        verification_uri_complete: payload.verification_uri_complete,
        expires_in_secs: payload.expires_in.max(0) as u64,
        interval_secs: payload.interval.max(1) as u64,
    })
}

pub async fn poll_device_link(
    app: &AppHandle,
    base_url: Option<String>,
    device_code: String,
) -> anyhow::Result<HubDeviceLinkPollStatus> {
    let settings = crate::settings::load(app)?;
    let base_url = normalize_base_url(base_url.as_deref().unwrap_or(&settings.hub_api_base_url));
    if base_url.is_empty() {
        anyhow::bail!("AimMod Hub API base URL is required");
    }

    let response = CLIENT
        .post(format!("{base_url}/auth/device/poll"))
        .header("Content-Type", "application/json")
        .json(&DeviceLinkPollRequest { device_code })
        .send()
        .await
        .with_context(|| format!("error sending request for url ({base_url}/auth/device/poll)"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("hub device poll returned {status}: {body}");
    }

    let payload = response.json::<DeviceLinkPollResponse>().await?;
    if payload.status == "approved"
        && payload
            .upload_token
            .as_deref()
            .is_some_and(|token| !token.trim().is_empty())
    {
        let mut next_settings = settings.clone();
        next_settings.hub_api_base_url = base_url;
        next_settings.hub_upload_token = payload.upload_token.clone().unwrap_or_default();
        next_settings.hub_sync_enabled = true;
        next_settings.hub_account_label = payload
            .user
            .as_ref()
            .map(|user| {
                let display = user.display_name.trim();
                if !display.is_empty() {
                    display.to_string()
                } else {
                    user.username.trim().to_string()
                }
            })
            .unwrap_or_default();
        crate::settings::persist(app, &next_settings)?;
        if let Ok(mut locked) = app.state::<crate::AppState>().settings.lock() {
            *locked = next_settings;
        }
        queue_pending_session_sync(app);
    }

    Ok(HubDeviceLinkPollStatus {
        status: payload.status,
        account_label: payload.user.map(|user| {
            let display = user.display_name.trim();
            if !display.is_empty() {
                display.to_string()
            } else {
                user.username
            }
        }),
    })
}

pub fn clear_linked_account(app: &AppHandle) -> anyhow::Result<()> {
    let mut settings = crate::settings::load(app)?;
    settings.hub_upload_token.clear();
    settings.hub_account_label.clear();
    settings.hub_sync_enabled = false;
    crate::settings::persist(app, &settings)?;
    if let Ok(mut locked) = app.state::<crate::AppState>().settings.lock() {
        *locked = settings;
    }
    refresh_pending_count(app);
    Ok(())
}

pub fn force_full_resync(app: &AppHandle) -> anyhow::Result<()> {
    match crate::stats_db::backfill_session_classifications(app) {
        Ok(updated) if updated > 0 => {
            log::info!(
                "hub_sync: backfilled stored scenario classification for {} session(s) before full resync",
                updated
            );
        }
        Ok(_) => {}
        Err(error) => {
            log::warn!(
                "hub_sync: stored scenario classification backfill failed before full resync: {error}"
            );
        }
    }
    crate::session_store::reset_all_hub_upload_marks(app);
    refresh_pending_count(app);
    queue_pending_session_sync(app);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IngestSessionRequest {
    app_version: String,
    schema_version: u32,
    user_external_id: String,
    session_id: String,
    scenario_name: String,
    scenario_type: String,
    score: f64,
    accuracy: f64,
    duration_ms: u64,
    played_at_iso: String,
    summary: HashMap<String, SessionSummaryValue>,
    feature_set: HashMap<String, SessionSummaryValue>,
    timeline_seconds: Vec<TimelineSecondPayload>,
    context_windows: Vec<ContextWindowPayload>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IngestBatchRequest {
    sessions: Vec<IngestSessionRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IngestBatchResponse {
    #[serde(default)]
    uploaded_session_ids: Vec<String>,
    #[serde(default)]
    failures: Vec<IngestBatchFailure>,
    #[serde(default)]
    uploaded_count: usize,
    #[serde(default)]
    failed_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IngestBatchFailure {
    session_id: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummaryValue {
    #[serde(skip_serializing_if = "Option::is_none")]
    string_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    number_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bool_value: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TimelineSecondPayload {
    t_sec: u32,
    score: f64,
    accuracy: f64,
    damage_eff: f64,
    spm: f64,
    shots: u32,
    hits: u32,
    kills: u32,
    paused: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextWindowPayload {
    start_ms: u64,
    end_ms: u64,
    window_type: String,
    label: String,
    feature_summary: HashMap<String, SessionSummaryValue>,
    coaching_tags: Vec<String>,
}

pub fn queue_session_upload(app: &AppHandle, input: SessionUploadInput) {
    set_sync_in_progress(true);
    let session_id = input.session_id.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = upload_session(&app, input).await {
            record_pending_upload_failure(&app, &session_id, &error.to_string());
            record_sync_error(error.to_string());
            log::warn!("hub_sync: upload failed: {error}");
        }
        refresh_pending_count(&app);
    });
}

pub fn queue_pending_session_sync(app: &AppHandle) {
    let settings = match crate::settings::load(app) {
        Ok(settings) => settings,
        Err(error) => {
            log::warn!("hub_sync: could not load settings for pending sync check: {error}");
            return;
        }
    };

    if !settings.hub_sync_enabled {
        return;
    }

    if normalize_base_url(&settings.hub_api_base_url).is_empty()
        || settings.hub_upload_token.trim().is_empty()
    {
        return;
    }

    if PENDING_SYNC_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    set_sync_in_progress(true);
    refresh_pending_count(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = sync_pending_sessions(&app).await;
        PENDING_SYNC_RUNNING.store(false, Ordering::SeqCst);
        if let Err(error) = result {
            record_sync_error(error.to_string());
            log::warn!("hub_sync: pending sync failed: {error}");
        }
        refresh_pending_count(&app);
    });
}

async fn upload_session(app: &AppHandle, input: SessionUploadInput) -> anyhow::Result<()> {
    let settings = crate::settings::load(app)?;
    if !settings.hub_sync_enabled {
        record_sync_success(None);
        return Ok(());
    }

    let base_url = normalize_base_url(&settings.hub_api_base_url);
    let upload_token = settings.hub_upload_token.trim();
    if base_url.is_empty() || upload_token.is_empty() {
        log::info!(
            "hub_sync: skipping upload for {} because hub sync is not fully configured",
            input.session_id
        );
        record_sync_success(None);
        return Ok(());
    }

    let persisted_run = crate::stats_db::get_run_summary(app, &input.session_id)
        .ok()
        .flatten()
        .or(input.run_snapshot.clone());
    let persisted_timeline = crate::stats_db::get_run_timeline(app, &input.session_id)
        .unwrap_or_else(|_| {
            persisted_run
                .as_ref()
                .map(|run| run.timeline.clone())
                .unwrap_or_default()
        });
    let context_windows =
        crate::stats_db::get_replay_context_windows(app, &input.session_id).unwrap_or_default();
    let shot_telemetry =
        crate::stats_db::get_shot_telemetry(app, &input.session_id).unwrap_or_default();
    let classification_stats = input.stats_panel.clone().unwrap_or_else(|| {
        // Fall back to CSV data so the classifier has kills/damage/TTK even
        // for historical sessions that were never seen by the stats panel hook.
        crate::session_store::StatsPanelSnapshot {
            kills: Some(input.result.kills),
            total_damage: (input.result.damage_done > 0.0).then(|| input.result.damage_done as f32),
            avg_ttk_ms: (input.result.avg_ttk > 0.0)
                .then(|| (input.result.avg_ttk * 1000.0) as f32), // avg_ttk from CSV is in seconds
            ..Default::default()
        }
    });
    let inferred_classification = crate::bridge::classify_persisted_session(
        &classification_stats,
        persisted_run.as_ref(),
        &shot_telemetry,
    );

    let scenario_type = input
        .stats_panel
        .as_ref()
        .map(|stats| stats.scenario_type.trim())
        .filter(|value| !value.is_empty() && *value != "Unknown")
        .map(str::to_string)
        .or_else(|| {
            let family = inferred_classification.family.trim();
            (!family.is_empty() && family != "Unknown").then(|| family.to_string())
        })
        .unwrap_or_else(|| "Unknown".to_string());

    let score = resolve_upload_score(&input.result, persisted_run.as_ref(), &persisted_timeline);
    let accuracy = persisted_run
        .as_ref()
        .and_then(|run| run.accuracy_pct)
        .or_else(|| {
            input
                .stats_panel
                .as_ref()
                .and_then(|stats| stats.accuracy_pct.map(f64::from))
        })
        .unwrap_or(input.result.accuracy);
    let duration_ms = persisted_run
        .as_ref()
        .and_then(|run| run.duration_secs)
        .map(secs_to_ms)
        .unwrap_or_else(|| secs_to_ms(input.result.duration_secs));

    let payload = build_ingest_payload(
        &input,
        persisted_run.as_ref(),
        &persisted_timeline,
        &context_windows,
        scenario_type,
        score,
        accuracy,
        duration_ms,
    );

    let url = format!("{base_url}{INGEST_PATH}");
    let response = CLIENT
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", CONNECT_PROTOCOL_VERSION)
        .header("Authorization", format!("Bearer {upload_token}"))
        .header(
            reqwest::header::USER_AGENT,
            format!("AimMod/{}", crate::app_version::raw_version()),
        )
        .json(&payload)
        .send()
        .await
        .with_context(|| format!("error sending request for url ({})", url))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("hub ingest returned {status}: {body}");
    }

    crate::session_store::mark_session_hub_uploaded(app, &input.session_id);
    record_sync_success(Some(&input.session_id));
    refresh_pending_count(app);
    log::info!("hub_sync: uploaded session {}", input.session_id);
    Ok(())
}

async fn sync_pending_sessions(app: &AppHandle) -> anyhow::Result<()> {
    let settings = crate::settings::load(app)?;
    if !settings.hub_sync_enabled
        || normalize_base_url(&settings.hub_api_base_url).is_empty()
        || settings.hub_upload_token.trim().is_empty()
    {
        record_sync_success(None);
        return Ok(());
    }

    let overview = crate::session_store::get_pending_hub_upload_page(app, 0, 1);
    if overview.total == 0 {
        record_sync_success(None);
        return Ok(());
    }

    let mut uploaded = 0usize;
    let mut failed = 0usize;
    let limit = 200usize;

    log::info!(
        "hub_sync: starting pending sync for {} local session(s)",
        overview.total
    );

    loop {
        let page = crate::session_store::get_pending_hub_upload_page(app, 0, limit);
        if page.records.is_empty() {
            break;
        }

        for chunk in page.records.chunks(BATCH_SYNC_CHUNK_SIZE) {
            match upload_session_batch(app, chunk).await {
                Ok(batch_result) => {
                    uploaded += batch_result.uploaded_count;
                    failed += batch_result.failed_count;
                    for failure in batch_result.failures {
                        record_pending_upload_failure(app, &failure.session_id, &failure.message);
                        log::warn!(
                            "hub_sync: could not upload pending session {}: {}",
                            failure.session_id,
                            failure.message
                        );
                    }
                }
                Err(error) => {
                    failed += chunk.len();
                    for record in chunk {
                        record_pending_upload_failure(app, &record.id, &error.to_string());
                        log::warn!(
                            "hub_sync: could not upload pending session {}: {error}",
                            record.id
                        );
                    }
                }
            }
        }

        if !page.has_more {
            break;
        }
    }

    log::info!(
        "hub_sync: pending sync complete (uploaded {}, failed {})",
        uploaded,
        failed
    );
    if failed == 0 {
        record_sync_success(None);
    } else {
        record_sync_error(format!("{} pending upload(s) failed", failed));
    }
    refresh_pending_count(app);
    Ok(())
}

fn build_ingest_payload(
    input: &SessionUploadInput,
    persisted_run: Option<&BridgeRunSnapshot>,
    persisted_timeline: &[BridgeRunTimelinePoint],
    context_windows: &[crate::stats_db::SessionReplayContextWindow],
    scenario_type: String,
    score: f64,
    accuracy: f64,
    duration_ms: u64,
) -> IngestSessionRequest {
    IngestSessionRequest {
        app_version: crate::app_version::raw_version().to_string(),
        schema_version: HUB_SCHEMA_VERSION,
        user_external_id: String::new(),
        session_id: input.session_id.clone(),
        scenario_name: input.result.scenario.clone(),
        scenario_type: scenario_type.clone(),
        score,
        accuracy,
        duration_ms,
        played_at_iso: played_at_iso(&input.result.timestamp),
        summary: build_summary_map(input, persisted_run, context_windows.len(), &scenario_type),
        feature_set: build_feature_map(input),
        timeline_seconds: build_timeline_payload(persisted_timeline),
        context_windows: build_context_windows_payload(
            context_windows,
            persisted_run.and_then(|r| r.score_per_minute),
            persisted_run.and_then(|r| r.accuracy_pct),
            persisted_run.and_then(|r| r.kills_per_second),
        ),
    }
}

async fn upload_session_batch(
    app: &AppHandle,
    records: &[crate::session_store::SessionRecord],
) -> anyhow::Result<IngestBatchResponse> {
    let settings = crate::settings::load(app)?;
    let base_url = normalize_base_url(&settings.hub_api_base_url);
    let upload_token = settings.hub_upload_token.trim();
    if !settings.hub_sync_enabled || base_url.is_empty() || upload_token.is_empty() {
        anyhow::bail!("hub sync is not fully configured");
    }

    let mut sessions = Vec::with_capacity(records.len());
    let mut local_session_ids = Vec::with_capacity(records.len());
    for record in records {
        let input = SessionUploadInput {
            session_id: record.id.clone(),
            result: SessionResult {
                scenario: record.scenario.clone(),
                score: record.score,
                accuracy: record.accuracy,
                kills: record.kills,
                deaths: record.deaths,
                duration_secs: record.duration_secs,
                avg_ttk: record.avg_ttk,
                damage_done: record.damage_done,
                timestamp: record.timestamp.clone(),
                csv_path: String::new(),
            },
            smoothness: record.smoothness.clone(),
            stats_panel: record.stats_panel.clone(),
            shot_timing: record.shot_timing.clone(),
            run_snapshot: None,
        };

        let persisted_run = crate::stats_db::get_run_summary(app, &input.session_id)
            .ok()
            .flatten()
            .or(input.run_snapshot.clone());
        let persisted_timeline = crate::stats_db::get_run_timeline(app, &input.session_id)
            .unwrap_or_else(|_| {
                persisted_run
                    .as_ref()
                    .map(|run| run.timeline.clone())
                    .unwrap_or_default()
            });
        let context_windows =
            crate::stats_db::get_replay_context_windows(app, &input.session_id).unwrap_or_default();
        let shot_telemetry =
            crate::stats_db::get_shot_telemetry(app, &input.session_id).unwrap_or_default();
        let classification_stats = input.stats_panel.clone().unwrap_or_else(|| {
            crate::session_store::StatsPanelSnapshot {
                kills: Some(input.result.kills),
                total_damage: (input.result.damage_done > 0.0)
                    .then(|| input.result.damage_done as f32),
                avg_ttk_ms: (input.result.avg_ttk > 0.0)
                    .then(|| (input.result.avg_ttk * 1000.0) as f32), // avg_ttk from CSV is in seconds
                ..Default::default()
            }
        });
        let inferred_classification = crate::bridge::classify_persisted_session(
            &classification_stats,
            persisted_run.as_ref(),
            &shot_telemetry,
        );
        let scenario_type = input
            .stats_panel
            .as_ref()
            .map(|stats| stats.scenario_type.trim())
            .filter(|value| !value.is_empty() && *value != "Unknown")
            .map(str::to_string)
            .or_else(|| {
                let family = inferred_classification.family.trim();
                (!family.is_empty() && family != "Unknown").then(|| family.to_string())
            })
            .unwrap_or_else(|| "Unknown".to_string());
        let score =
            resolve_upload_score(&input.result, persisted_run.as_ref(), &persisted_timeline);
        let accuracy = persisted_run
            .as_ref()
            .and_then(|run| run.accuracy_pct)
            .or_else(|| {
                input
                    .stats_panel
                    .as_ref()
                    .and_then(|stats| stats.accuracy_pct.map(f64::from))
            })
            .unwrap_or(input.result.accuracy);
        let duration_ms = persisted_run
            .as_ref()
            .and_then(|run| run.duration_secs)
            .map(secs_to_ms)
            .unwrap_or_else(|| secs_to_ms(input.result.duration_secs));

        local_session_ids.push(record.id.clone());
        sessions.push(build_ingest_payload(
            &input,
            persisted_run.as_ref(),
            &persisted_timeline,
            &context_windows,
            scenario_type,
            score,
            accuracy,
            duration_ms,
        ));
    }

    let response = CLIENT
        .post(format!("{base_url}{BATCH_INGEST_PATH}"))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {upload_token}"))
        .header(
            reqwest::header::USER_AGENT,
            format!("AimMod/{}", crate::app_version::raw_version()),
        )
        .json(&IngestBatchRequest { sessions })
        .send()
        .await
        .with_context(|| {
            format!("error sending request for url ({base_url}{BATCH_INGEST_PATH})")
        })?;

    let status = response.status();
    let mut payload = response.json::<IngestBatchResponse>().await?;
    if payload.uploaded_session_ids.is_empty()
        && payload.failures.is_empty()
        && !status.is_success()
    {
        anyhow::bail!("hub batch ingest returned {status} with an empty result body");
    }

    let mut next_fallback_index = 0usize;
    for failure in &mut payload.failures {
        if !failure.session_id.trim().is_empty() {
            if let Some(index) = local_session_ids
                .iter()
                .position(|local_id| local_id == &failure.session_id)
            {
                next_fallback_index = next_fallback_index.max(index + 1);
            }
            continue;
        }

        while next_fallback_index < local_session_ids.len()
            && payload
                .uploaded_session_ids
                .iter()
                .any(|uploaded_id| uploaded_id == &local_session_ids[next_fallback_index])
        {
            next_fallback_index += 1;
        }

        if let Some(local_id) = local_session_ids.get(next_fallback_index) {
            failure.session_id = local_id.clone();
            next_fallback_index += 1;
        }
    }

    for session_id in &payload.uploaded_session_ids {
        crate::session_store::mark_session_hub_uploaded(app, session_id);
    }
    if let Some(last) = payload.uploaded_session_ids.last() {
        record_sync_success(Some(last));
    }
    refresh_pending_count(app);
    Ok(payload)
}

fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn played_at_iso(timestamp: &str) -> String {
    NaiveDateTime::parse_from_str(timestamp, "%Y.%m.%d-%H.%M.%S")
        .ok()
        .and_then(|naive| {
            Local
                .from_local_datetime(&naive)
                .single()
                .or_else(|| Local.from_local_datetime(&naive).earliest())
                .or_else(|| Local.from_local_datetime(&naive).latest())
        })
        .map(|local| local.with_timezone(&Utc).to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339())
}

fn secs_to_ms(value: f64) -> u64 {
    (value.max(0.0) * 1000.0).round() as u64
}

fn first_meaningful_number(values: impl IntoIterator<Item = Option<f64>>) -> Option<f64> {
    let mut first_finite = None;
    for value in values {
        let Some(value) = value.filter(|value| value.is_finite()) else {
            continue;
        };
        if first_finite.is_none() {
            first_finite = Some(value);
        }
        if value > 0.0 {
            return Some(value);
        }
    }
    first_finite
}

fn resolve_upload_score(
    result: &SessionResult,
    persisted_run: Option<&BridgeRunSnapshot>,
    persisted_timeline: &[BridgeRunTimelinePoint],
) -> f64 {
    let timeline_peak = persisted_timeline.iter().fold(None, |best, point| {
        let candidate = first_meaningful_number([point.score_total, point.score_total_derived]);
        match (best, candidate) {
            (Some(current), Some(next)) if next > current => Some(next),
            (None, Some(next)) => Some(next),
            (current, _) => current,
        }
    });

    first_meaningful_number([
        persisted_run.and_then(|run| run.score_total),
        persisted_run.and_then(|run| run.score_total_derived),
        timeline_peak,
        Some(result.score),
    ])
    .unwrap_or(0.0)
}

fn summary_number(map: &mut HashMap<String, SessionSummaryValue>, key: &str, value: Option<f64>) {
    if let Some(value) = value {
        map.insert(key.to_string(), SessionSummaryValue::number(value));
    }
}

fn summary_string(
    map: &mut HashMap<String, SessionSummaryValue>,
    key: &str,
    value: Option<String>,
) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        map.insert(key.to_string(), SessionSummaryValue::string(value));
    }
}

fn summary_bool(map: &mut HashMap<String, SessionSummaryValue>, key: &str, value: Option<bool>) {
    if let Some(value) = value {
        map.insert(key.to_string(), SessionSummaryValue::boolean(value));
    }
}

fn build_summary_map(
    input: &SessionUploadInput,
    run: Option<&BridgeRunSnapshot>,
    context_window_count: usize,
    scenario_type: &str,
) -> HashMap<String, SessionSummaryValue> {
    let mut summary = HashMap::new();

    summary_string(
        &mut summary,
        "appVersion",
        Some(crate::app_version::raw_version().to_string()),
    );
    summary_string(
        &mut summary,
        "platformOs",
        Some(std::env::consts::OS.to_string()),
    );
    summary_string(
        &mut summary,
        "platformArch",
        Some(std::env::consts::ARCH.to_string()),
    );
    summary_string(
        &mut summary,
        "buildProfile",
        Some(if cfg!(debug_assertions) { "debug" } else { "release" }.to_string()),
    );
    summary_bool(&mut summary, "hasBridgeRunSnapshot", Some(run.is_some()));
    summary_bool(
        &mut summary,
        "hasSmoothnessSnapshot",
        Some(input.smoothness.is_some()),
    );
    summary_bool(
        &mut summary,
        "hasShotTimingSnapshot",
        Some(input.shot_timing.is_some()),
    );
    summary_bool(
        &mut summary,
        "hasStatsPanelSnapshot",
        Some(input.stats_panel.is_some()),
    );

    summary_number(&mut summary, "csvScore", Some(input.result.score));
    summary_number(&mut summary, "csvAccuracy", Some(input.result.accuracy));
    summary_number(&mut summary, "csvKills", Some(input.result.kills as f64));
    summary_number(&mut summary, "csvDeaths", Some(input.result.deaths as f64));
    summary_number(
        &mut summary,
        "csvDurationSecs",
        Some(input.result.duration_secs),
    );
    summary_number(&mut summary, "csvAvgTtk", Some(input.result.avg_ttk));
    summary_number(
        &mut summary,
        "csvDamageDone",
        Some(input.result.damage_done),
    );
    summary_number(
        &mut summary,
        "contextWindowCount",
        Some(context_window_count as f64),
    );
    summary_string(
        &mut summary,
        "scenarioType",
        Some(scenario_type.to_string()),
    );

    if let Some(stats_panel) = input.stats_panel.as_ref() {
        summary_string(
            &mut summary,
            "scenarioSubtype",
            stats_panel.scenario_subtype.clone(),
        );
        summary_number(
            &mut summary,
            "panelKills",
            stats_panel.kills.map(|value| value as f64),
        );
        summary_number(
            &mut summary,
            "panelAvgKps",
            stats_panel.avg_kps.map(f64::from),
        );
        summary_number(
            &mut summary,
            "panelAccuracyPct",
            stats_panel.accuracy_pct.map(f64::from),
        );
        summary_number(
            &mut summary,
            "panelTotalDamage",
            stats_panel.total_damage.map(f64::from),
        );
        summary_number(
            &mut summary,
            "panelAvgTtkMs",
            stats_panel.avg_ttk_ms.map(f64::from),
        );
        summary_number(
            &mut summary,
            "panelBestTtkMs",
            stats_panel.best_ttk_ms.map(f64::from),
        );
        summary_number(
            &mut summary,
            "panelTtkStdMs",
            stats_panel.ttk_std_ms.map(f64::from),
        );
        summary_number(
            &mut summary,
            "panelAccuracyTrend",
            stats_panel.accuracy_trend.map(f64::from),
        );
    }

    if let Some(shot_timing) = input.shot_timing.as_ref() {
        summary_number(
            &mut summary,
            "pairedShotHits",
            Some(shot_timing.paired_shot_hits as f64),
        );
        summary_number(
            &mut summary,
            "avgFireToHitMs",
            shot_timing.avg_fire_to_hit_ms.map(f64::from),
        );
        summary_number(
            &mut summary,
            "p90FireToHitMs",
            shot_timing.p90_fire_to_hit_ms.map(f64::from),
        );
        summary_number(
            &mut summary,
            "avgShotsToHit",
            shot_timing.avg_shots_to_hit.map(f64::from),
        );
        summary_number(
            &mut summary,
            "correctiveShotRatio",
            shot_timing.corrective_shot_ratio.map(f64::from),
        );
    }

    if let Some(run) = run {
        summary_number(&mut summary, "scoreTotal", run.score_total);
        summary_number(&mut summary, "scoreTotalDerived", run.score_total_derived);
        summary_number(&mut summary, "scorePerMinute", run.score_per_minute);
        summary_number(&mut summary, "shotsFired", run.shots_fired);
        summary_number(&mut summary, "shotsHit", run.shots_hit);
        summary_number(&mut summary, "kills", run.kills);
        summary_number(&mut summary, "killsPerSecond", run.kills_per_second);
        summary_number(&mut summary, "damageDone", run.damage_done);
        summary_number(&mut summary, "damagePossible", run.damage_possible);
        summary_number(&mut summary, "damageEfficiency", run.damage_efficiency);
        summary_number(&mut summary, "accuracyPct", run.accuracy_pct);
        summary_number(
            &mut summary,
            "peakScorePerMinute",
            run.peak_score_per_minute,
        );
        summary_number(
            &mut summary,
            "peakKillsPerSecond",
            run.peak_kills_per_second,
        );
        summary_number(
            &mut summary,
            "eventShotFired",
            Some(run.event_counts.shot_fired_events as f64),
        );
        summary_number(
            &mut summary,
            "eventShotHit",
            Some(run.event_counts.shot_hit_events as f64),
        );
        summary_number(
            &mut summary,
            "eventKills",
            Some(run.event_counts.kill_events as f64),
        );
        summary_number(
            &mut summary,
            "pauseWindowCount",
            Some(run.pause_windows.len() as f64),
        );
        summary_bool(
            &mut summary,
            "hasTickStream",
            Some(run.tick_stream_v1.is_some()),
        );
    }

    summary
}

fn build_feature_map(input: &SessionUploadInput) -> HashMap<String, SessionSummaryValue> {
    let mut feature_set = HashMap::new();

    if let Some(smoothness) = input.smoothness.as_ref() {
        summary_number(
            &mut feature_set,
            "smoothnessComposite",
            Some(f64::from(smoothness.composite)),
        );
        summary_number(
            &mut feature_set,
            "smoothnessJitter",
            Some(f64::from(smoothness.jitter)),
        );
        summary_number(
            &mut feature_set,
            "smoothnessOvershootRate",
            Some(f64::from(smoothness.overshoot_rate)),
        );
        summary_number(
            &mut feature_set,
            "smoothnessVelocityStd",
            Some(f64::from(smoothness.velocity_std)),
        );
        summary_number(
            &mut feature_set,
            "smoothnessPathEfficiency",
            Some(f64::from(smoothness.path_efficiency)),
        );
        summary_number(
            &mut feature_set,
            "smoothnessAvgSpeed",
            Some(f64::from(smoothness.avg_speed)),
        );
        summary_number(
            &mut feature_set,
            "smoothnessClickTimingCv",
            Some(f64::from(smoothness.click_timing_cv)),
        );
        summary_number(
            &mut feature_set,
            "smoothnessCorrectionRatio",
            Some(f64::from(smoothness.correction_ratio)),
        );
        summary_number(
            &mut feature_set,
            "smoothnessDirectionalBias",
            Some(f64::from(smoothness.directional_bias)),
        );
    }

    if let Some(shot_timing) = input.shot_timing.as_ref() {
        summary_number(
            &mut feature_set,
            "shotTimingAvgFireToHitMs",
            shot_timing.avg_fire_to_hit_ms.map(f64::from),
        );
        summary_number(
            &mut feature_set,
            "shotTimingP90FireToHitMs",
            shot_timing.p90_fire_to_hit_ms.map(f64::from),
        );
        summary_number(
            &mut feature_set,
            "shotTimingAvgShotsToHit",
            shot_timing.avg_shots_to_hit.map(f64::from),
        );
        summary_number(
            &mut feature_set,
            "shotTimingCorrectiveShotRatio",
            shot_timing.corrective_shot_ratio.map(f64::from),
        );
    }

    feature_set
}

fn build_timeline_payload(timeline: &[BridgeRunTimelinePoint]) -> Vec<TimelineSecondPayload> {
    timeline
        .iter()
        .map(|point| TimelineSecondPayload {
            t_sec: point.t_sec,
            score: point
                .score_total
                .or(point.score_total_derived)
                .unwrap_or_default(),
            accuracy: point.accuracy_pct.unwrap_or_default(),
            damage_eff: point.damage_efficiency.unwrap_or_default(),
            spm: point.score_per_minute.unwrap_or_default(),
            shots: point.shots_fired.unwrap_or_default().max(0.0).round() as u32,
            hits: point.shots_hit.unwrap_or_default().max(0.0).round() as u32,
            kills: point.kills.unwrap_or_default().max(0.0).round() as u32,
            paused: false,
        })
        .collect()
}

fn build_context_windows_payload(
    windows: &[crate::stats_db::SessionReplayContextWindow],
    session_spm: Option<f64>,
    session_accuracy: Option<f64>,
    session_kps: Option<f64>,
) -> Vec<ContextWindowPayload> {
    windows
        .iter()
        .map(|window| {
            let mut feature_summary = HashMap::new();
            summary_number(
                &mut feature_summary,
                "shotEventCount",
                Some(window.shot_event_count as f64),
            );
            summary_number(
                &mut feature_summary,
                "firedCount",
                Some(window.fired_count as f64),
            );
            summary_number(
                &mut feature_summary,
                "hitCount",
                Some(window.hit_count as f64),
            );
            summary_number(&mut feature_summary, "accuracyPct", window.accuracy_pct);
            summary_number(&mut feature_summary, "avgBotCount", window.avg_bot_count);
            summary_number(
                &mut feature_summary,
                "primaryTargetShare",
                window.primary_target_share,
            );
            summary_number(
                &mut feature_summary,
                "avgNearestDistance",
                window.avg_nearest_distance,
            );
            summary_number(
                &mut feature_summary,
                "avgNearestYawErrorDeg",
                window.avg_nearest_yaw_error_deg,
            );
            summary_number(
                &mut feature_summary,
                "avgNearestPitchErrorDeg",
                window.avg_nearest_pitch_error_deg,
            );
            summary_number(
                &mut feature_summary,
                "avgScorePerMinute",
                window.avg_score_per_minute,
            );
            summary_number(
                &mut feature_summary,
                "avgKillsPerSecond",
                window.avg_kills_per_second,
            );
            summary_number(
                &mut feature_summary,
                "avgTimelineAccuracyPct",
                window.avg_timeline_accuracy_pct,
            );
            summary_number(
                &mut feature_summary,
                "avgDamageEfficiency",
                window.avg_damage_efficiency,
            );
            summary_string(&mut feature_summary, "phase", window.phase.clone());
            summary_string(
                &mut feature_summary,
                "primaryTargetLabel",
                window.primary_target_label.clone(),
            );
            summary_string(
                &mut feature_summary,
                "primaryTargetProfile",
                window.primary_target_profile.clone(),
            );
            summary_string(
                &mut feature_summary,
                "primaryTargetEntityId",
                window.primary_target_entity_id.clone(),
            );

            let mut coaching_tags = Vec::new();

            // Phase tag (opening / mid / closing)
            if let Some(phase) = window.phase.clone().filter(|v| !v.trim().is_empty()) {
                coaching_tags.push(phase);
            }

            // SPM-based pace signals: compare window average to session average
            let win_spm = window.avg_score_per_minute;
            if let (Some(win), Some(ses)) = (win_spm, session_spm) {
                if ses > 0.0 {
                    let ratio = win / ses;
                    if ratio < 0.88 {
                        coaching_tags.push("pace_fade".to_string());
                    } else if ratio > 1.12 {
                        coaching_tags.push("pace_peak".to_string());
                    }
                }
            }

            // Accuracy signals: compare window accuracy to session accuracy
            let win_acc = window.avg_timeline_accuracy_pct.or(window.accuracy_pct);
            if let (Some(win), Some(ses)) = (win_acc, session_accuracy) {
                let diff = win - ses;
                if diff > 5.0 {
                    coaching_tags.push("accuracy_build".to_string());
                } else if diff < -5.0 {
                    coaching_tags.push("accuracy_drop".to_string());
                }
            }

            // KPS pace signals for kill-based scenarios
            if let (Some(win), Some(ses)) = (window.avg_kills_per_second, session_kps) {
                if ses > 0.0 && win / ses > 1.15 {
                    coaching_tags.push("peak_tempo".to_string());
                }
            }

            // Context kind tag when it carries meaning beyond phase
            if window.context_kind == "metric_shift" {
                coaching_tags.push("pace_shift".to_string());
            }

            ContextWindowPayload {
                start_ms: window.start_ms,
                end_ms: window.end_ms,
                window_type: window.context_kind.clone(),
                label: window.label.clone(),
                feature_summary,
                coaching_tags,
            }
        })
        .collect()
}

impl SessionSummaryValue {
    fn string(value: impl Into<String>) -> Self {
        Self {
            string_value: Some(value.into()),
            number_value: None,
            bool_value: None,
        }
    }

    fn number(value: f64) -> Self {
        Self {
            string_value: None,
            number_value: Some(value),
            bool_value: None,
        }
    }

    fn boolean(value: bool) -> Self {
        Self {
            string_value: None,
            number_value: None,
            bool_value: Some(value),
        }
    }
}
