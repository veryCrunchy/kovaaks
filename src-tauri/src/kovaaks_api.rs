/// KovaaK's public REST API client (no auth required for read-only endpoints).
///
/// Base URL: https://kovaaks.com
/// Relevant endpoints:
///   GET /webapp-backend/user/scenario/last-scores/by-name  → recent scores for a scenario/user
///   GET /webapp-backend/user/search                        → search users by username
///   GET /webapp-backend/user/scenario/total-play           → most-played scenarios for a user
///   GET /webapp-backend/scenario/popular                   → search scenarios by name (scenarioNameSearch param)
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use strsim;

const BASE_URL: &str = "https://kovaaks.com";

// ─── Validation cache ─────────────────────────────────────────────────────────
// Maps ocr_normalize(query) → Option<canonical_name>.
// None = confirmed garbage (rejected by API); Some(name) = known good.
// Persisted to `validation_cache.json` in the app data directory.

static CACHE: Lazy<Mutex<HashMap<String, Option<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static CACHE_PATH: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

/// Load the persisted cache from disk.  Should be called once at startup.
/// Subsequent calls replace the in-memory cache with the file contents.
pub fn load_cache(path: &Path) {
    *CACHE_PATH.lock() = Some(path.to_owned());
    match std::fs::read_to_string(path) {
        Ok(json) => match serde_json::from_str::<HashMap<String, Option<String>>>(&json) {
            Ok(map) => {
                let count = map.len();
                *CACHE.lock() = map;
                log::info!("validation_cache: loaded {} entries from {:?}", count, path);
            }
            Err(e) => log::warn!("validation_cache: parse error ({e}) — starting fresh"),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log::info!("validation_cache: no file yet at {:?}", path);
        }
        Err(e) => log::warn!("validation_cache: read error ({e})"),
    }
}

/// Persist the current in-memory cache to the file set by `load_cache`.
fn save_cache(cache: &HashMap<String, Option<String>>) {
    let path_guard = CACHE_PATH.lock();
    let Some(path) = path_guard.as_deref() else {
        return;
    };
    match serde_json::to_string(cache) {
        Ok(json) => {
            if let Err(e) = std::fs::write(path, &json) {
                log::warn!("validation_cache: write error ({e})");
            }
        }
        Err(e) => log::warn!("validation_cache: serialise error ({e})"),
    }
}

// ─── Shared HTTP client ────────────────────────────────────────────────────────

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent("aimmod/1.0")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("failed to build reqwest client")
});

// ─── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ScoreData {
    pub score: f64,
}

/// Full user profile returned by the search endpoint.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    pub username: Option<String>,
    pub steam_id: Option<String>,
    pub steam_account_name: Option<String>,
    pub steam_account_avatar: Option<String>,
    pub country: Option<String>,
    pub kovaaks_plus_active: Option<bool>,
}

/// Rich user profile exposed to Tauri commands and persisted in settings.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct UserProfile {
    pub username: String,
    pub steam_id: String,
    pub steam_account_name: String,
    pub avatar_url: String,
    pub country: String,
    pub kovaaks_plus: bool,
}

/// One entry from the total-play endpoint.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MostPlayedEntry {
    pub scenario_name: String,
    pub score: f64,
    pub rank: Option<u64>,
    pub counts: MostPlayedCounts,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct MostPlayedCounts {
    pub plays: u32,
}

#[derive(Debug, Deserialize)]
struct TotalPlayResponse {
    pub data: Vec<MostPlayedEntry>,
}

// ─── Public API ────────────────────────────────────────────────────────────────

/// Fetch the best (highest) score a user has ever recorded for a specific scenario.
///
/// Uses `last-scores/by-name` which returns all recent score entries for that user+scenario.
/// We return the maximum across all entries.  Returns `None` if the user has never played that scenario.
pub async fn fetch_best_score(username: &str, scenario_name: &str) -> anyhow::Result<Option<f64>> {
    let response = CLIENT
        .get(format!(
            "{}/webapp-backend/user/scenario/last-scores/by-name",
            BASE_URL
        ))
        .query(&[("username", username), ("scenarioName", scenario_name)])
        .header("Accept", "application/json")
        .send()
        .await?;

    // 404 means the user hasn't played this scenario (or was not found)
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }

    if !response.status().is_success() {
        anyhow::bail!("API error {}: {}", response.status(), scenario_name);
    }

    let scores: Vec<ScoreData> = response.json().await?;
    let best = scores.into_iter().map(|s| s.score).reduce(f64::max);
    Ok(best)
}

/// Fetch the best score for a user identified by their Steam64 ID (no KovaaK's account required).
///
/// Uses the `steamId` query param variant of `last-scores/by-name`, which works for any player
/// who has linked their Steam account to KovaaK's in-game, even without a webapp account.
/// Returns `None` if they have never played the scenario or their scores are not public.
pub async fn fetch_best_score_by_steam_id(
    steam_id: &str,
    scenario_name: &str,
) -> anyhow::Result<Option<f64>> {
    let response = CLIENT
        .get(format!(
            "{}/webapp-backend/user/scenario/last-scores/by-name",
            BASE_URL
        ))
        .query(&[("steamId", steam_id), ("scenarioName", scenario_name)])
        .header("Accept", "application/json")
        .send()
        .await?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }

    if !response.status().is_success() {
        anyhow::bail!("API error {} (steamId={})", response.status(), steam_id);
    }

    let scores: Vec<ScoreData> = response.json().await?;
    let best = scores.into_iter().map(|s| s.score).reduce(f64::max);
    Ok(best)
}

/// Fetch the full user profile for a KovaaK's webapp username.
///
/// Returns `None` if no user with that username exists.
pub async fn fetch_user_profile(username: &str) -> anyhow::Result<Option<UserProfile>> {
    let response = CLIENT
        .get(format!("{}/webapp-backend/user/search", BASE_URL))
        .query(&[("username", username)])
        .header("Accept", "application/json")
        .send()
        .await?;

    if !response.status().is_success() {
        return Ok(None);
    }

    let results: Vec<SearchResult> = response.json().await?;
    let found = results.into_iter().find(|r| {
        r.username
            .as_deref()
            .map(|u| u.eq_ignore_ascii_case(username))
            .unwrap_or(false)
    });

    Ok(found.map(search_result_to_profile))
}

/// Helper: convert a SearchResult into a UserProfile.
fn search_result_to_profile(r: SearchResult) -> UserProfile {
    UserProfile {
        username: r.username.unwrap_or_default(),
        steam_id: r.steam_id.unwrap_or_default(),
        steam_account_name: r.steam_account_name.unwrap_or_default(),
        avatar_url: r.steam_account_avatar.unwrap_or_default(),
        country: r.country.unwrap_or_default(),
        kovaaks_plus: r.kovaaks_plus_active.unwrap_or(false),
    }
}

/// Find a KovaaK's user profile by cross-referencing their Steam64 ID against
/// KovaaK's search results.
///
/// The KovaaK's `/user/search` endpoint only accepts a `username` query, but each
/// result includes the linked `steamId`.  This function searches with `display_name`
/// (the Steam display name obtained from the Steam API) and checks if any result's
/// `steamId` matches.  Falls back to searching with just the first token of
/// `display_name` in case the KovaaK's username is only a partial match.
///
/// Returns `None` if no KovaaK's account is linked to that Steam ID.
pub async fn find_user_by_steam_id(
    steam_id: &str,
    display_name: &str,
) -> anyhow::Result<Option<UserProfile>> {
    // Primary attempt: search by full display name and check steamId in results.
    if let Some(profile) = search_by_query_match_steam_id(display_name, steam_id).await? {
        return Ok(Some(profile));
    }
    // Fallback: first token only (in case KovaaK's username is an abbreviation).
    let first = display_name
        .split_whitespace()
        .next()
        .unwrap_or(display_name);
    if first != display_name {
        return search_by_query_match_steam_id(first, steam_id).await;
    }
    Ok(None)
}

/// Search the KovaaK's `/user/search` endpoint with `query` and return the first
/// result whose `steamId` field equals `steam_id`.
async fn search_by_query_match_steam_id(
    query: &str,
    steam_id: &str,
) -> anyhow::Result<Option<UserProfile>> {
    let response = CLIENT
        .get(format!("{}/webapp-backend/user/search", BASE_URL))
        .query(&[("username", query)])
        .header("Accept", "application/json")
        .send()
        .await?;

    if !response.status().is_success() {
        return Ok(None);
    }

    let results: Vec<SearchResult> = response.json().await.unwrap_or_default();
    let found = results.into_iter().find(|r| {
        r.steam_id
            .as_deref()
            .map(|s| s == steam_id)
            .unwrap_or(false)
    });
    Ok(found.map(search_result_to_profile))
}

/// Fetch the most-played scenarios for a user (sorted by play count, descending).
/// Returns up to `max` entries.
pub async fn fetch_most_played(username: &str, max: u32) -> anyhow::Result<Vec<MostPlayedEntry>> {
    let response = CLIENT
        .get(format!(
            "{}/webapp-backend/user/scenario/total-play",
            BASE_URL
        ))
        .query(&[
            ("username", username),
            ("page", "1"),
            ("max", &max.to_string()),
            ("sort_param[]", "count"),
        ])
        .header("Accept", "application/json")
        .send()
        .await?;

    if !response.status().is_success() {
        return Ok(vec![]);
    }

    let body: TotalPlayResponse = response.json().await?;
    Ok(body.data)
}

/// Check whether a scenario name is real by searching the KovaaK's scenario catalogue.
/// Uses `GET /webapp-backend/scenario/popular?scenarioNameSearch=…`.
///
/// Returns `Some(canonical_name)` on success — the canonical spelling comes from the
/// API row, so even if OCR misread "V1" as "Vl" the *corrected* name is returned.
/// Returns `None` if the name is obvious garbage or no API match found.
/// Fails open on network/parse errors (returns `Some(trimmed)`) so a transient
/// connectivity hiccup doesn't silently suppress valid sessions.
pub async fn validate_scenario_name(name: &str) -> Option<String> {
    use crate::scenario_index::ocr_normalize;

    // Quick local sanity checks — skip the API call for obvious garbage.
    let trimmed = name.trim();
    if trimmed.len() < 4 {
        log::info!("Scenario validation SKIP (too short): {:?}", trimmed);
        return None;
    }
    // Pure-numeric OCR noise (e.g. "1234") is never a real scenario name.
    if trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || c == '.' || c == ',')
    {
        log::info!("Scenario validation SKIP (numeric only): {:?}", trimmed);
        return None;
    }

    // Cache lookup — keyed by normalized form so all confusable variants share an entry.
    let cache_key = ocr_normalize(&trimmed.to_lowercase());
    {
        let cache = CACHE.lock();
        if let Some(cached) = cache.get(&cache_key) {
            log::info!("validation_cache: HIT {:?} → {:?}", trimmed, cached);
            return cached.clone();
        }
    }

    log::info!("Scenario validation API call: {:?}", trimmed);

    // Search the API with the raw OCR text first.  If that returns 0 results
    // (common when a confusable mid-word char makes the query unrecognisable,
    // e.g. "VT lw4ts" → no match), retry with the first longer token so we at
    // least get a pool of candidates to Jaro-Winkler against.
    let rows = api_search(trimmed, 20).await;

    match rows {
        Err(e) => {
            // Network error — fail-open, but do NOT cache (transient failure).
            log::warn!(
                "Scenario validation network error for {:?}: {e} — accepting anyway",
                trimmed
            );
            Some(trimmed.to_string())
        }
        Ok(mut pool) => {
            // If the full query returned nothing, widen the search to the first
            // word that is longer than 2 chars (skips common short prefixes like
            // "VT", "CE") — gives the Jaro-Winkler ranker something to work with.
            if pool.is_empty() {
                let first_long = trimmed
                    .split_whitespace()
                    .find(|w| w.len() > 2)
                    .unwrap_or(trimmed);
                log::info!(
                    "Scenario validation: 0 results for {:?}, retrying with prefix {:?}",
                    trimmed,
                    first_long
                );
                if let Ok(extra) = api_search(first_long, 20).await {
                    pool = extra;
                }
            }

            if pool.is_empty() {
                log::info!(
                    "Scenario validation REJECTED: {:?} (0 results after fallback)",
                    trimmed
                );
                let mut cache = CACHE.lock();
                cache.insert(cache_key, None);
                save_cache(&cache);
                return None;
            }

            let lower = trimmed.to_lowercase();
            let lower_norm = ocr_normalize(&lower);

            // Score every candidate with Jaro-Winkler on the normalised strings
            // and pick the best one above the acceptance threshold.
            let best = pool
                .iter()
                .map(|row| {
                    let rn = ocr_normalize(&row.to_lowercase());
                    let score = strsim::jaro_winkler(&lower_norm, &rn);
                    (row, score)
                })
                .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

            // Exact / prefix match still accepted without threshold.
            let exact = pool.iter().find(|row| {
                let rl = row.to_lowercase();
                let rn = ocr_normalize(&rl);
                rl == lower
                    || rl.starts_with(&format!("{lower} "))
                    || rn == lower_norm
                    || rn.starts_with(&format!("{lower_norm} "))
            });

            const JW_THRESHOLD: f64 = 0.88;
            let result = exact.map(|r| r.clone()).or_else(|| {
                best.and_then(|(r, s)| {
                    if s >= JW_THRESHOLD {
                        Some(r.clone())
                    } else {
                        None
                    }
                })
            });

            if let Some(ref canonical) = result {
                log::info!(
                    "Scenario validation OK: {:?} → {:?} ({} candidates)",
                    trimmed,
                    canonical,
                    pool.len()
                );
            } else {
                log::info!(
                    "Scenario validation REJECTED: {:?} (best JW={:.3}, {} candidates)",
                    trimmed,
                    best.map(|(_, s)| s).unwrap_or(0.0),
                    pool.len()
                );
            }

            // Persist (including rejections).
            {
                let mut cache = CACHE.lock();
                cache.insert(cache_key, result.clone());
                save_cache(&cache);
            }
            result
        }
    }
}

// ─── Leaderboard / scenario browser types ─────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct ScenarioSearchResult {
    pub leaderboard_id: u64,
    pub scenario_name: String,
    pub aim_type: Option<String>,
    pub description: Option<String>,
    pub play_count: u64,
    pub entry_count: u64,
    pub top_score: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ScenarioPage {
    pub total: u64,
    pub page: u64,
    pub data: Vec<ScenarioSearchResult>,
}

#[derive(Debug, Serialize, Clone)]
pub struct LeaderboardEntry {
    pub rank: u64,
    pub steam_id: String,
    pub steam_account_name: String,
    pub webapp_username: Option<String>,
    pub score: f64,
    pub country: Option<String>,
    pub kovaaks_plus: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct LeaderboardPage {
    pub total: u64,
    pub page: u64,
    pub data: Vec<LeaderboardEntry>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ScenarioDetails {
    pub scenario_name: String,
    pub aim_type: Option<String>,
    pub play_count: u64,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub created: Option<String>,
    pub author_steam_account_name: Option<String>,
}

// ─── Leaderboard / scenario browser API ───────────────────────────────────────

/// Search scenarios by name using the popular endpoint (max 100 per page).
pub async fn search_scenarios(query: &str, page: u64, max: u64) -> anyhow::Result<ScenarioPage> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ScenarioCounts {
        plays: u64,
        entries: u64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ScenarioInner {
        aim_type: Option<String>,
        description: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TopScore {
        score: f64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        leaderboard_id: u64,
        scenario_name: String,
        scenario: ScenarioInner,
        counts: ScenarioCounts,
        top_score: TopScore,
    }
    #[derive(Deserialize)]
    struct Resp {
        total: u64,
        page: u64,
        data: Vec<Row>,
    }

    let capped = max.min(100);
    let resp: Resp = CLIENT
        .get(format!("{}/webapp-backend/scenario/popular", BASE_URL))
        .query(&[
            ("page", page.to_string()),
            ("max", capped.to_string()),
            ("scenarioNameSearch", query.to_string()),
        ])
        .header("Accept", "application/json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    Ok(ScenarioPage {
        total: resp.total,
        page: resp.page,
        data: resp
            .data
            .into_iter()
            .map(|r| ScenarioSearchResult {
                leaderboard_id: r.leaderboard_id,
                scenario_name: r.scenario_name,
                aim_type: r.scenario.aim_type,
                description: r.scenario.description,
                play_count: r.counts.plays,
                entry_count: r.counts.entries,
                top_score: r.top_score.score,
            })
            .collect(),
    })
}

/// Fetch one page of global leaderboard scores for a given leaderboard ID (max 100).
pub async fn get_leaderboard_page(
    leaderboard_id: u64,
    page: u64,
    max: u64,
) -> anyhow::Result<LeaderboardPage> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        rank: u64,
        steam_id: String,
        steam_account_name: String,
        webapp_username: Option<String>,
        score: f64,
        country: Option<String>,
        kovaaks_plus_active: Option<bool>,
    }
    #[derive(Deserialize)]
    struct Resp {
        total: u64,
        page: u64,
        data: Vec<Row>,
    }

    let capped = max.min(100);
    let resp: Resp = CLIENT
        .get(format!(
            "{}/webapp-backend/leaderboard/scores/global",
            BASE_URL
        ))
        .query(&[
            ("leaderboardId", leaderboard_id.to_string()),
            ("page", page.to_string()),
            ("max", capped.to_string()),
        ])
        .header("Accept", "application/json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    Ok(LeaderboardPage {
        total: resp.total,
        page: resp.page,
        data: resp
            .data
            .into_iter()
            .map(|r| LeaderboardEntry {
                rank: r.rank,
                steam_id: r.steam_id,
                steam_account_name: r.steam_account_name,
                webapp_username: r.webapp_username,
                score: r.score,
                country: r.country,
                kovaaks_plus: r.kovaaks_plus_active.unwrap_or(false),
            })
            .collect(),
    })
}

/// Fetch metadata for a single scenario by leaderboard ID.
pub async fn get_scenario_details(leaderboard_id: u64) -> anyhow::Result<ScenarioDetails> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Resp {
        scenario_name: String,
        aim_type: Option<String>,
        play_count: u64,
        steam_account_name: Option<String>,
        description: Option<String>,
        tags: Option<Vec<String>>,
        created: Option<String>,
    }

    let resp: Resp = CLIENT
        .get(format!("{}/webapp-backend/scenario/details", BASE_URL))
        .query(&[("leaderboardId", leaderboard_id.to_string())])
        .header("Accept", "application/json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    Ok(ScenarioDetails {
        scenario_name: resp.scenario_name,
        aim_type: resp.aim_type,
        play_count: resp.play_count,
        description: resp.description,
        tags: resp
            .tags
            .unwrap_or_default()
            .into_iter()
            .filter(|t| !t.is_empty())
            .collect(),
        created: resp.created,
        author_steam_account_name: resp.steam_account_name,
    })
}

/// Look up the KovaaK's `aimType` field for a scenario by name.
/// Returns `None` if no matching scenario is found or the field is absent.
/// The returned value is one of: "Clicking", "Tracking", "Switching", "Other" (or None).
pub async fn get_aim_type_for_scenario(canonical_name: &str) -> Option<String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ScenarioInner {
        aim_type: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        scenario_name: String,
        scenario: ScenarioInner,
    }
    #[derive(Deserialize)]
    struct Resp {
        data: Vec<Row>,
    }

    let resp = CLIENT
        .get(format!("{}/webapp-backend/scenario/popular", BASE_URL))
        .query(&[
            ("page", "0"),
            ("max", "10"),
            ("scenarioNameSearch", canonical_name),
        ])
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Resp = resp.json().await.ok()?;
    // Find the exact name match (case-insensitive).
    body.data
        .into_iter()
        .find(|r| r.scenario_name.eq_ignore_ascii_case(canonical_name))
        .and_then(|r| r.scenario.aim_type)
        .filter(|t| !t.is_empty())
}

/// Fetch up to `max` scenario names from the popular endpoint for a given query string.
async fn api_search(query: &str, max: usize) -> anyhow::Result<Vec<String>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        scenario_name: String,
    }
    #[derive(Deserialize)]
    struct Resp {
        data: Vec<Row>,
    }

    let url = format!("{}/webapp-backend/scenario/popular", BASE_URL);
    let r = CLIENT
        .get(&url)
        .query(&[
            ("page", "0"),
            ("max", &max.to_string()),
            ("scenarioNameSearch", query),
        ])
        .header("Accept", "application/json")
        .send()
        .await?;

    if !r.status().is_success() {
        anyhow::bail!("HTTP {}", r.status());
    }
    let body: Resp = r.json().await?;
    Ok(body.data.into_iter().map(|r| r.scenario_name).collect())
}
