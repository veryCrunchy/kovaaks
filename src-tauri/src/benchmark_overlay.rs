use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use tauri::AppHandle;

use crate::{FriendProfile, hub_api, settings::AppSettings};

static CACHE: Lazy<std::sync::Mutex<BenchmarkOverlayCache>> =
    Lazy::new(|| std::sync::Mutex::new(BenchmarkOverlayCache::default()));

/// How long fetched pages are considered fresh before a background re-fetch is triggered.
const PAGES_CACHE_TTL: Duration = Duration::from_secs(300);
/// How many times to retry a failed benchmark page request.
const FETCH_RETRIES: u32 = 3;
/// Base delay (ms) between retries; doubles each attempt (600 → 1200 → 2400 ms).
const RETRY_BASE_MS: u64 = 600;

// ── Public types ─────────────────────────────────────────────────────────────

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
    /// Set only when pages are completely unavailable (no stale data to fall back on).
    pub last_error: Option<String>,
    pub selected_benchmark_ids: Vec<u32>,
    pub primary_benchmark_id: Option<u32>,
    pub scenario_name: Option<String>,
    pub player_steam_id: Option<String>,
    pub pages: Vec<hub_api::HubExternalBenchmarkPageResponse>,
    pub matching_pages: Vec<hub_api::HubExternalBenchmarkPageResponse>,
    pub current_scenario_matches: Vec<OverlayBenchmarkScenarioMatch>,
}

// ── Internal cache ────────────────────────────────────────────────────────────
//
// The pages key is intentionally *scenario-independent*: benchmark pages don't
// change when the active scenario changes, so a scenario switch can immediately
// recompute `matching_pages` / `current_scenario_matches` from the warm cache
// without triggering a new network request.

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct PagesKey {
    hub_base_url: String,
    selected_benchmark_ids: Vec<u32>,
    primary_benchmark_id: Option<u32>,
    steam_id: String,
}

#[derive(Debug, Default)]
struct BenchmarkOverlayCache {
    pages_key: Option<PagesKey>,
    pages: Vec<hub_api::HubExternalBenchmarkPageResponse>,
    /// Soft error message, only present when all fetches failed with no stale fallback.
    pages_error: Option<String>,
    pages_refreshing: bool,
    pages_updated_at: Option<Instant>,
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn invalidate() {
    if let Ok(mut cache) = CACHE.lock() {
        cache.pages_refreshing = false;
        cache.pages_updated_at = None;
    }
}

pub fn snapshot(
    app: &AppHandle,
    settings: &AppSettings,
    current_user: Option<&FriendProfile>,
    scenario_name: Option<&str>,
) -> OverlayBenchmarkState {
    let scenario_slug = normalize_scenario_slug(scenario_name.unwrap_or_default());
    let pages_key = PagesKey {
        hub_base_url: crate::hub_sync::normalize_base_url(&settings.hub_api_base_url),
        selected_benchmark_ids: settings.overlay_selected_benchmark_ids.clone(),
        primary_benchmark_id: settings.overlay_primary_benchmark_id,
        steam_id: current_user
            .map(|u| u.steam_id.trim().to_string())
            .unwrap_or_default(),
    };

    let mut cache = match CACHE.lock() {
        Ok(g) => g,
        Err(_) => return OverlayBenchmarkState::default(),
    };

    let pages_stale = cache.pages_key.as_ref() != Some(&pages_key)
        || cache
            .pages_updated_at
            .map_or(true, |t| t.elapsed() >= PAGES_CACHE_TTL);

    if pages_stale && !cache.pages_refreshing {
        // When the pages key changes (different benchmarks / account), clear
        // pages that belong to a completely different context.
        if cache.pages_key.as_ref() != Some(&pages_key) {
            cache.pages.clear();
            cache.pages_error = None;
        }
        cache.pages_key = Some(pages_key.clone());
        cache.pages_refreshing = true;
        spawn_refresh(app.clone(), pages_key.clone());
    }

    let should_fetch = should_fetch(&pages_key);
    // Show loading only when actively fetching AND we have nothing to show yet.
    let loading = cache.pages_refreshing && cache.pages.is_empty() && should_fetch;

    let (matching_pages, current_scenario_matches) = if !scenario_slug.is_empty() {
        let matching = cache
            .pages
            .iter()
            .filter(|p| page_contains_scenario(p, &scenario_slug))
            .cloned()
            .collect();
        let matches = build_matches(&cache.pages, &scenario_slug);
        (matching, matches)
    } else {
        (Vec::new(), Vec::new())
    };

    OverlayBenchmarkState {
        loading,
        // Only surface an error when we have nothing else to show.
        last_error: if cache.pages.is_empty() {
            cache.pages_error.clone()
        } else {
            None
        },
        selected_benchmark_ids: pages_key.selected_benchmark_ids.clone(),
        primary_benchmark_id: pages_key.primary_benchmark_id,
        scenario_name: scenario_name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned),
        player_steam_id: nonempty_string(&pages_key.steam_id),
        pages: cache.pages.clone(),
        matching_pages,
        current_scenario_matches,
    }
}

fn should_fetch(key: &PagesKey) -> bool {
    !key.hub_base_url.is_empty()
        && !key.steam_id.is_empty()
        && !key.selected_benchmark_ids.is_empty()
}

fn spawn_refresh(app: AppHandle, pages_key: PagesKey) {
    tauri::async_runtime::spawn(async move {
        if !should_fetch(&pages_key) {
            if let Ok(mut cache) = CACHE.lock() {
                if cache.pages_key.as_ref() == Some(&pages_key) {
                    cache.pages_refreshing = false;
                    cache.pages_updated_at = Some(Instant::now());
                }
            }
            crate::overlay_service::notify_state_changed();
            return;
        }

        let mut new_pages = Vec::new();
        let mut failed_ids: Vec<u32> = Vec::new();

        for &benchmark_id in &pages_key.selected_benchmark_ids {
            let mut succeeded = false;
            for attempt in 0..FETCH_RETRIES {
                match hub_api::get_external_benchmark_page(
                    &app,
                    pages_key.steam_id.clone(),
                    benchmark_id,
                )
                .await
                {
                    Ok(page) => {
                        new_pages.push(page);
                        succeeded = true;
                        break;
                    }
                    Err(_) => {
                        if attempt + 1 < FETCH_RETRIES {
                            tokio::time::sleep(Duration::from_millis(
                                RETRY_BASE_MS * (1 << attempt),
                            ))
                            .await;
                        }
                    }
                }
            }
            if !succeeded {
                failed_ids.push(benchmark_id);
            }
        }

        if let Ok(mut cache) = CACHE.lock() {
            if cache.pages_key.as_ref() == Some(&pages_key) {
                if new_pages.is_empty() && !cache.pages.is_empty() {
                    // All retries failed but we have stale pages — keep showing
                    // them and set a soft error that is hidden from the widget body.
                    cache.pages_error = Some(format!("Sync issue ({} failed)", failed_ids.len()));
                } else {
                    // At least some pages fetched successfully — use the new data.
                    cache.pages = new_pages;
                    cache.pages_error = if failed_ids.is_empty() {
                        None
                    } else {
                        Some(format!(
                            "{} benchmark(s) failed to update",
                            failed_ids.len()
                        ))
                    };
                }
                cache.pages_refreshing = false;
                cache.pages_updated_at = Some(Instant::now());
            }
        }

        crate::overlay_service::notify_state_changed();
    });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

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
                    .filter(|t| t.score > scenario.score)
                    .min_by(|a, b| a.score.total_cmp(&b.score));
                let progress_pct = next_threshold.map(|t| {
                    if t.score <= 0.0 {
                        0.0
                    } else {
                        (scenario.score / t.score * 100.0).clamp(0.0, 100.0)
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
                    next_threshold_name: next_threshold.map(|t| t.rank_name.clone()),
                    next_threshold_score: next_threshold.map(|t| t.score),
                    progress_pct,
                });
            }
        }
    }
    out.sort_by(|a, b| b.rank_index.cmp(&a.rank_index));
    out
}

fn page_contains_scenario(page: &hub_api::HubExternalBenchmarkPageResponse, slug: &str) -> bool {
    page.categories.iter().any(|cat| {
        cat.scenarios
            .iter()
            .any(|s| normalize_scenario_slug(&s.scenario_name) == slug)
    })
}

fn normalize_scenario_slug(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
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
