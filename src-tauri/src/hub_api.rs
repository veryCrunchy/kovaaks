use std::collections::HashMap;
use std::time::Duration;

use anyhow::Context;
use once_cell::sync::Lazy;
use reqwest::Client;
use serde::{Deserialize, Deserializer, Serialize, de::DeserializeOwned};
use tauri::AppHandle;

static HUB_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .http1_only()
        .build()
        .expect("failed to build AimMod Hub API client")
});

const CONNECT_PROTOCOL_VERSION: &str = "1";
const GET_OVERVIEW_PATH: &str = "/aimmod.hub.v1.HubService/GetOverview";
const SEARCH_PATH: &str = "/aimmod.hub.v1.HubService/Search";
const LIST_REPLAYS_PATH: &str = "/aimmod.hub.v1.HubService/ListReplays";
const GET_PROFILE_PATH: &str = "/aimmod.hub.v1.HubService/GetProfile";
const GET_SCENARIO_PATH: &str = "/aimmod.hub.v1.HubService/GetScenarioPage";
const GET_BENCHMARK_PAGE_PATH: &str = "/aimmod.hub.v1.HubService/GetBenchmarkPage";
const GET_RUN_PATH: &str = "/aimmod.hub.v1.HubService/GetRun";
const GET_AIM_PROFILE_PATH: &str = "/aimmod.hub.v1.HubService/GetAimProfile";
const GET_AIM_FINGERPRINT_PATH: &str = "/aimmod.hub.v1.HubService/GetAimFingerprint";
const GET_PLAYER_SCENARIO_HISTORY_PATH: &str = "/aimmod.hub.v1.HubService/GetPlayerScenarioHistory";

fn de_u64ish<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| serde::de::Error::custom("expected unsigned integer")),
        serde_json::Value::String(text) => text
            .parse::<u64>()
            .map_err(|_| serde::de::Error::custom("expected unsigned integer string")),
        _ => Err(serde::de::Error::custom("expected unsigned integer")),
    }
}

fn de_u64ish_default<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(de_u64ish(deserializer).unwrap_or(0))
}

fn strip_null_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for entry in map.values_mut() {
                strip_null_fields(entry);
            }
            map.retain(|_, entry| !entry.is_null());
        }
        serde_json::Value::Array(items) => {
            for entry in items {
                strip_null_fields(entry);
            }
        }
        _ => {}
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubRunPreview {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub scenario_name: String,
    #[serde(default)]
    pub scenario_type: String,
    #[serde(default)]
    pub played_at_iso: String,
    pub score: f64,
    pub accuracy: f64,
    #[serde(default, deserialize_with = "de_u64ish_default")]
    pub duration_ms: u64,
    #[serde(default)]
    pub user_handle: String,
    #[serde(default)]
    pub user_display_name: String,
    #[serde(default)]
    pub run_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubTopScenario {
    #[serde(default)]
    pub scenario_name: String,
    #[serde(default)]
    pub scenario_slug: String,
    #[serde(default)]
    pub scenario_type: String,
    pub run_count: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubBenchmarkRankVisual {
    #[serde(default)]
    pub rank_index: u32,
    #[serde(default)]
    pub rank_name: String,
    #[serde(default)]
    pub icon_url: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub frame_url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubBenchmarkSummary {
    #[serde(default)]
    pub benchmark_id: u32,
    #[serde(default)]
    pub benchmark_name: String,
    #[serde(default)]
    pub benchmark_icon_url: String,
    #[serde(default)]
    pub benchmark_author: String,
    #[serde(default)]
    pub benchmark_type: String,
    pub overall_rank: Option<HubBenchmarkRankVisual>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubScenarioBenchmarkRank {
    #[serde(default)]
    pub benchmark_id: u32,
    #[serde(default)]
    pub benchmark_name: String,
    #[serde(default)]
    pub benchmark_icon_url: String,
    #[serde(default)]
    pub category_name: String,
    pub scenario_score: f64,
    #[serde(default)]
    pub leaderboard_rank: u32,
    #[serde(default)]
    pub leaderboard_id: u32,
    pub scenario_rank: Option<HubBenchmarkRankVisual>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubBenchmarkThreshold {
    #[serde(default)]
    pub rank_index: u32,
    #[serde(default)]
    pub rank_name: String,
    pub score: f64,
    #[serde(default)]
    pub icon_url: String,
    #[serde(default)]
    pub color: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubBenchmarkScenarioEntry {
    #[serde(default)]
    pub scenario_name: String,
    #[serde(default)]
    pub scenario_slug: String,
    pub score: f64,
    #[serde(default)]
    pub leaderboard_rank: u32,
    pub scenario_rank: Option<HubBenchmarkRankVisual>,
    #[serde(default)]
    pub thresholds: Vec<HubBenchmarkThreshold>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubBenchmarkCategoryPage {
    #[serde(default)]
    pub category_name: String,
    #[serde(default)]
    pub scenarios: Vec<HubBenchmarkScenarioEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubBenchmarkPageResponse {
    #[serde(default)]
    pub user_handle: String,
    #[serde(default)]
    pub user_display_name: String,
    #[serde(default)]
    pub benchmark_id: u32,
    #[serde(default)]
    pub benchmark_name: String,
    #[serde(default)]
    pub benchmark_author: String,
    #[serde(default)]
    pub benchmark_type: String,
    #[serde(default)]
    pub benchmark_icon_url: String,
    pub overall_rank: Option<HubBenchmarkRankVisual>,
    #[serde(default)]
    pub categories: Vec<HubBenchmarkCategoryPage>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubCommunityProfilePreview {
    #[serde(default)]
    pub user_handle: String,
    #[serde(default)]
    pub user_display_name: String,
    #[serde(default)]
    pub avatar_url: String,
    pub run_count: u32,
    pub scenario_count: u32,
    #[serde(default)]
    pub primary_scenario_type: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubOverviewResponse {
    pub total_runs: u32,
    pub total_scenarios: u32,
    pub total_players: u32,
    pub recent_runs: Vec<HubRunPreview>,
    pub top_scenarios: Vec<HubTopScenario>,
    pub active_profiles: Vec<HubCommunityProfilePreview>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubSearchScenarioResult {
    #[serde(default)]
    pub scenario_name: String,
    #[serde(default)]
    pub scenario_slug: String,
    #[serde(default)]
    pub scenario_type: String,
    pub run_count: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubSearchProfileResult {
    #[serde(default)]
    pub user_handle: String,
    #[serde(default)]
    pub user_display_name: String,
    #[serde(default)]
    pub avatar_url: String,
    pub run_count: u32,
    pub scenario_count: u32,
    #[serde(default)]
    pub primary_scenario_type: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubReplayPreview {
    #[serde(default)]
    pub public_run_id: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub scenario_slug: String,
    #[serde(default)]
    pub scenario_name: String,
    #[serde(default)]
    pub scenario_type: String,
    #[serde(default)]
    pub played_at_iso: String,
    pub score: f64,
    pub accuracy: f64,
    #[serde(default, deserialize_with = "de_u64ish_default")]
    pub duration_ms: u64,
    #[serde(default)]
    pub user_handle: String,
    #[serde(default)]
    pub user_display_name: String,
    pub has_video: bool,
    pub has_mouse_path: bool,
    #[serde(default)]
    pub replay_quality: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubSearchResponse {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub scenarios: Vec<HubSearchScenarioResult>,
    #[serde(default)]
    pub profiles: Vec<HubSearchProfileResult>,
    #[serde(default)]
    pub runs: Vec<HubReplayPreview>,
    #[serde(default)]
    pub replays: Vec<HubReplayPreview>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubReplayListResponse {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub scenario_name: String,
    #[serde(default)]
    pub user_handle: String,
    #[serde(default)]
    pub items: Vec<HubReplayPreview>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubScoreBin {
    pub lo: f64,
    pub hi: f64,
    pub count: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubScenarioPageResponse {
    #[serde(default)]
    pub scenario_name: String,
    #[serde(default)]
    pub scenario_slug: String,
    #[serde(default)]
    pub scenario_type: String,
    pub run_count: u32,
    pub best_score: f64,
    pub average_score: f64,
    pub average_accuracy: f64,
    #[serde(default, deserialize_with = "de_u64ish_default")]
    pub average_duration_ms: u64,
    #[serde(default)]
    pub recent_runs: Vec<HubRunPreview>,
    #[serde(default)]
    pub top_runs: Vec<HubRunPreview>,
    #[serde(default)]
    pub score_distribution: Vec<HubScoreBin>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubProfileResponse {
    #[serde(default)]
    pub user_external_id: String,
    #[serde(default)]
    pub user_handle: String,
    #[serde(default)]
    pub user_display_name: String,
    #[serde(default)]
    pub avatar_url: String,
    pub run_count: u32,
    pub scenario_count: u32,
    #[serde(default)]
    pub primary_scenario_type: String,
    pub average_score: f64,
    pub average_accuracy: f64,
    #[serde(default)]
    pub top_scenarios: Vec<HubTopScenario>,
    #[serde(default)]
    pub recent_runs: Vec<HubRunPreview>,
    #[serde(default)]
    pub personal_bests: Vec<HubRunPreview>,
    #[serde(default)]
    pub benchmarks: Vec<HubBenchmarkSummary>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubSummaryValueKind {
    #[serde(default)]
    pub string_value: Option<String>,
    #[serde(default)]
    pub number_value: Option<f64>,
    #[serde(default)]
    pub bool_value: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubSummaryValue {
    #[serde(flatten)]
    pub kind: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubTimelineSecond {
    pub t_sec: u32,
    pub score: f64,
    pub accuracy: f64,
    pub damage_eff: f64,
    pub spm: f64,
    pub shots: u32,
    pub hits: u32,
    pub kills: u32,
    pub paused: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubContextWindow {
    #[serde(default, deserialize_with = "de_u64ish_default")]
    pub start_ms: u64,
    #[serde(default, deserialize_with = "de_u64ish_default")]
    pub end_ms: u64,
    #[serde(default)]
    pub window_type: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub feature_summary: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub coaching_tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubRunResponse {
    pub session_id: String,
    pub scenario_name: String,
    pub scenario_type: String,
    pub played_at_iso: String,
    pub score: f64,
    pub accuracy: f64,
    #[serde(default, deserialize_with = "de_u64ish_default")]
    pub duration_ms: u64,
    pub user_handle: String,
    pub user_display_name: String,
    #[serde(default)]
    pub summary: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub feature_set: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub timeline_seconds: Vec<HubTimelineSecond>,
    #[serde(default)]
    pub context_windows: Vec<HubContextWindow>,
    pub run_id: String,
    #[serde(default)]
    pub scenario_runs: Vec<HubRunPreview>,
    #[serde(default)]
    pub benchmark_ranks: Vec<HubScenarioBenchmarkRank>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubPlayerScenarioHistoryResponse {
    #[serde(default)]
    pub scenario_name: String,
    #[serde(default)]
    pub scenario_slug: String,
    #[serde(default)]
    pub scenario_type: String,
    #[serde(default)]
    pub runs: Vec<HubRunPreview>,
    pub best_score: f64,
    pub average_score: f64,
    pub best_accuracy: f64,
    pub average_accuracy: f64,
    pub run_count: i32,
    #[serde(default)]
    pub benchmark_ranks: Vec<HubScenarioBenchmarkRank>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubTypeProfileBand {
    pub scenario_type: String,
    pub run_count: i32,
    pub avg_accuracy: f64,
    pub avg_score: f64,
    pub best_score: f64,
    pub community_avg_accuracy: f64,
    pub community_avg_score: f64,
    pub accuracy_percentile: f64,
    pub avg_smoothness: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubAimProfileResponse {
    pub user_handle: String,
    pub user_display_name: String,
    pub type_bands: Vec<HubTypeProfileBand>,
    pub overall_accuracy: f64,
    pub overall_accuracy_percentile: f64,
    pub total_run_count: i32,
    pub strongest_type: String,
    pub most_practiced_type: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubAimFingerprintAxis {
    pub key: String,
    pub label: String,
    pub value: i32,
    pub volatility: i32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubAimFingerprint {
    pub precision: i32,
    pub speed: i32,
    pub control: i32,
    pub consistency: i32,
    pub decisiveness: i32,
    pub rhythm: i32,
    pub rhythm_label: String,
    pub session_count: i32,
    pub axes: Vec<HubAimFingerprintAxis>,
    pub style_name: String,
    pub style_tagline: String,
    pub style_color: String,
    pub style_description: String,
    pub style_focus: String,
    pub dominant_scenario_type: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HubAimFingerprintResponse {
    pub overall: Option<HubAimFingerprint>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchRequestPayload {
    query: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListReplaysRequestPayload {
    query: String,
    scenario_name: String,
    handle: String,
    limit: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HandleRequestPayload {
    handle: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlugRequestPayload {
    slug: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkPageRequestPayload {
    handle: String,
    benchmark_id: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerScenarioHistoryRequestPayload {
    handle: String,
    scenario_slug: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunRequestPayload {
    run_id: String,
}

fn hub_base_url(app: &AppHandle) -> anyhow::Result<String> {
    let settings = crate::settings::load(app)?;
    let base_url = crate::hub_sync::normalize_base_url(&settings.hub_api_base_url);
    if base_url.is_empty() {
        anyhow::bail!("AimMod Hub API base URL is required");
    }
    Ok(base_url)
}

async fn post_connect_json<TReq: Serialize, TResp: DeserializeOwned>(
    app: &AppHandle,
    path: &str,
    payload: &TReq,
) -> anyhow::Result<TResp> {
    let base_url = hub_base_url(app)?;
    let response = HUB_CLIENT
        .post(format!("{base_url}{path}"))
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", CONNECT_PROTOCOL_VERSION)
        .json(payload)
        .send()
        .await
        .with_context(|| format!("error sending request for url ({base_url}{path})"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("hub request returned {status}: {body}");
    }

    let body = response
        .text()
        .await
        .context("error reading response body")?;
    let mut value: serde_json::Value = serde_json::from_str(&body)
        .with_context(|| format!("error decoding response body: {body}"))?;
    strip_null_fields(&mut value);
    serde_json::from_value::<TResp>(value).context("error decoding response body")
}

pub async fn get_overview(app: &AppHandle) -> anyhow::Result<HubOverviewResponse> {
    post_connect_json(app, GET_OVERVIEW_PATH, &serde_json::json!({})).await
}

pub async fn search(app: &AppHandle, query: String) -> anyhow::Result<HubSearchResponse> {
    post_connect_json(app, SEARCH_PATH, &SearchRequestPayload { query }).await
}

pub async fn list_replays(
    app: &AppHandle,
    query: Option<String>,
    scenario_name: Option<String>,
    handle: Option<String>,
    limit: Option<u32>,
) -> anyhow::Result<HubReplayListResponse> {
    post_connect_json(
        app,
        LIST_REPLAYS_PATH,
        &ListReplaysRequestPayload {
            query: query.unwrap_or_default(),
            scenario_name: scenario_name.unwrap_or_default(),
            handle: handle.unwrap_or_default(),
            limit: limit.unwrap_or(50),
        },
    )
    .await
}

pub async fn get_profile(app: &AppHandle, handle: String) -> anyhow::Result<HubProfileResponse> {
    post_connect_json(app, GET_PROFILE_PATH, &HandleRequestPayload { handle }).await
}

pub async fn get_scenario(
    app: &AppHandle,
    slug: String,
) -> anyhow::Result<HubScenarioPageResponse> {
    post_connect_json(app, GET_SCENARIO_PATH, &SlugRequestPayload { slug }).await
}

pub async fn get_benchmark_page(
    app: &AppHandle,
    handle: String,
    benchmark_id: u32,
) -> anyhow::Result<HubBenchmarkPageResponse> {
    post_connect_json(
        app,
        GET_BENCHMARK_PAGE_PATH,
        &BenchmarkPageRequestPayload {
            handle,
            benchmark_id,
        },
    )
    .await
}

pub async fn get_run(app: &AppHandle, run_id: String) -> anyhow::Result<HubRunResponse> {
    post_connect_json(app, GET_RUN_PATH, &RunRequestPayload { run_id }).await
}

pub async fn get_player_scenario_history(
    app: &AppHandle,
    handle: String,
    scenario_slug: String,
) -> anyhow::Result<HubPlayerScenarioHistoryResponse> {
    post_connect_json(
        app,
        GET_PLAYER_SCENARIO_HISTORY_PATH,
        &PlayerScenarioHistoryRequestPayload {
            handle,
            scenario_slug,
        },
    )
    .await
}

pub async fn get_aim_profile(
    app: &AppHandle,
    handle: String,
) -> anyhow::Result<HubAimProfileResponse> {
    post_connect_json(app, GET_AIM_PROFILE_PATH, &HandleRequestPayload { handle }).await
}

pub async fn get_aim_fingerprint(
    app: &AppHandle,
    handle: String,
) -> anyhow::Result<HubAimFingerprintResponse> {
    post_connect_json(
        app,
        GET_AIM_FINGERPRINT_PATH,
        &HandleRequestPayload { handle },
    )
    .await
}
