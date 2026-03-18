use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use tauri::AppHandle;

use crate::{FriendProfile, hub_api, settings::AppSettings};

static CACHE: Lazy<std::sync::Mutex<BenchmarkOverlayCache>> =
    Lazy::new(|| std::sync::Mutex::new(BenchmarkOverlayCache::default()));
const CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct OverlayBenchmarkScenarioMatch {
    pub benchmark_id: u32,
    pub benchmark_name: String,
    pub benchmark_icon_url: String,
    pub category_name: String,
    pub scenario_name: String,
    pub score: f64,
    pub leaderboard_rank: u32,
    pub rank_index: u32,
    pub rank_name: String,
    pub rank_icon_url: String,
    pub rank_color: String,
    pub next_threshold_name: Option<String>,
    pub next_threshold_score: Option<f64>,
    pub progress_pct: Option<f64>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct OverlayBenchmarkState {
    pub loading: bool,
    pub last_error: Option<String>,
    pub selected_benchmark_ids: Vec<u32>,
    pub primary_benchmark_id: Option<u32>,
    pub scenario_name: Option<String>,
    pub player_steam_id: Option<String>,
    pub pages: Vec<hub_api::HubExternalBenchmarkPageResponse>,
    pub matching_pages: Vec<hub_api::HubExternalBenchmarkPageResponse>,
    pub current_scenario_matches: Vec<OverlayBenchmarkScenarioMatch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct CacheKey {
    hub_base_url: String,
    selected_benchmark_ids: Vec<u32>,
    primary_benchmark_id: Option<u32>,
    scenario_slug: String,
    steam_id: String,
}

#[derive(Debug, Default)]
struct BenchmarkOverlayCache {
    key: Option<CacheKey>,
    snapshot: OverlayBenchmarkState,
    refreshing: bool,
    updated_at: Option<Instant>,
}

pub fn snapshot(
    app: &AppHandle,
    settings: &AppSettings,
    current_user: Option<&FriendProfile>,
    scenario_name: Option<&str>,
) -> OverlayBenchmarkState {
    let key = CacheKey {
        hub_base_url: crate::hub_sync::normalize_base_url(&settings.hub_api_base_url),
        selected_benchmark_ids: settings.overlay_selected_benchmark_ids.clone(),
        primary_benchmark_id: settings.overlay_primary_benchmark_id,
        scenario_slug: normalize_scenario_slug(scenario_name.unwrap_or_default()),
        steam_id: current_user
            .map(|user| user.steam_id.trim().to_string())
            .unwrap_or_default(),
    };

    let mut cache = match CACHE.lock() {
        Ok(guard) => guard,
        Err(_) => return OverlayBenchmarkState::default(),
    };

    let needs_refresh = cache.key.as_ref() != Some(&key)
        || match cache.updated_at {
            None => true,
            Some(updated_at) => updated_at.elapsed() >= CACHE_TTL,
        };

    if needs_refresh && !cache.refreshing {
        cache.refreshing = true;
        cache.key = Some(key.clone());
        cache.snapshot = OverlayBenchmarkState {
            loading: should_fetch(&key),
            last_error: None,
            selected_benchmark_ids: key.selected_benchmark_ids.clone(),
            primary_benchmark_id: key.primary_benchmark_id,
            scenario_name: scenario_name
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
            player_steam_id: nonempty_string(&key.steam_id),
            pages: Vec::new(),
            matching_pages: Vec::new(),
            current_scenario_matches: Vec::new(),
        };
        spawn_refresh(
            app.clone(),
            key,
            scenario_name.unwrap_or_default().to_string(),
        );
    }

    cache.snapshot.clone()
}

fn should_fetch(key: &CacheKey) -> bool {
    !key.hub_base_url.is_empty()
        && !key.steam_id.is_empty()
        && !key.selected_benchmark_ids.is_empty()
}

fn spawn_refresh(app: AppHandle, key: CacheKey, scenario_name: String) {
    tauri::async_runtime::spawn(async move {
        let mut snapshot = OverlayBenchmarkState {
            loading: false,
            last_error: None,
            selected_benchmark_ids: key.selected_benchmark_ids.clone(),
            primary_benchmark_id: key.primary_benchmark_id,
            scenario_name: nonempty_string(&scenario_name),
            player_steam_id: nonempty_string(&key.steam_id),
            pages: Vec::new(),
            matching_pages: Vec::new(),
            current_scenario_matches: Vec::new(),
        };

        if should_fetch(&key) {
            let mut errors = Vec::new();
            for benchmark_id in &key.selected_benchmark_ids {
                match hub_api::get_external_benchmark_page(
                    &app,
                    key.steam_id.clone(),
                    *benchmark_id,
                )
                .await
                {
                    Ok(page) => snapshot.pages.push(page),
                    Err(error) => errors.push(format!("{benchmark_id}: {error}")),
                }
            }

            if !key.scenario_slug.is_empty() {
                snapshot.matching_pages = snapshot
                    .pages
                    .iter()
                    .filter(|page| page_contains_scenario(page, &key.scenario_slug))
                    .cloned()
                    .collect();
                snapshot.current_scenario_matches =
                    build_matches(&snapshot.pages, &key.scenario_slug);
            }

            if !errors.is_empty() {
                snapshot.last_error = Some(errors.join(" | "));
            }
        }

        if let Ok(mut cache) = CACHE.lock() {
            if cache.key.as_ref() == Some(&key) {
                cache.snapshot = snapshot;
                cache.refreshing = false;
                cache.updated_at = Some(Instant::now());
            }
        }
    });
}

fn build_matches(
    pages: &[hub_api::HubExternalBenchmarkPageResponse],
    wanted_slug: &str,
) -> Vec<OverlayBenchmarkScenarioMatch> {
    let mut out = Vec::new();
    for page in pages {
        for category in &page.categories {
            for scenario in &category.scenarios {
                if normalize_scenario_slug(&scenario.scenario_name) != wanted_slug {
                    continue;
                }

                let next_threshold = scenario
                    .thresholds
                    .iter()
                    .filter(|threshold| threshold.score > scenario.score)
                    .min_by(|left, right| left.score.total_cmp(&right.score));
                let progress_pct = next_threshold.map(|threshold| {
                    if threshold.score <= 0.0 {
                        0.0
                    } else {
                        (scenario.score / threshold.score * 100.0).clamp(0.0, 100.0)
                    }
                });

                out.push(OverlayBenchmarkScenarioMatch {
                    benchmark_id: page.benchmark_id,
                    benchmark_name: page.benchmark_name.clone(),
                    benchmark_icon_url: page.benchmark_icon_url.clone(),
                    category_name: category.category_name.clone(),
                    scenario_name: scenario.scenario_name.clone(),
                    score: scenario.score,
                    leaderboard_rank: scenario.leaderboard_rank,
                    rank_index: scenario.rank_index,
                    rank_name: scenario.rank_name.clone(),
                    rank_icon_url: scenario.rank_icon_url.clone(),
                    rank_color: scenario.rank_color.clone(),
                    next_threshold_name: next_threshold
                        .map(|threshold| threshold.rank_name.clone()),
                    next_threshold_score: next_threshold.map(|threshold| threshold.score),
                    progress_pct,
                });
            }
        }
    }
    out.sort_by(|left, right| right.rank_index.cmp(&left.rank_index));
    out
}

fn page_contains_scenario(
    page: &hub_api::HubExternalBenchmarkPageResponse,
    wanted_slug: &str,
) -> bool {
    page.categories.iter().any(|category| {
        category
            .scenarios
            .iter()
            .any(|scenario| normalize_scenario_slug(&scenario.scenario_name) == wanted_slug)
    })
}

fn normalize_scenario_slug(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn nonempty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
