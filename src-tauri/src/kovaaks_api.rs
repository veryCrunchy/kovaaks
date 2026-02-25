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
    let Some(path) = path_guard.as_deref() else { return };
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
        .user_agent("kovaaks-overlay/0.1")
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
pub async fn fetch_best_score(
    username: &str,
    scenario_name: &str,
) -> anyhow::Result<Option<f64>> {
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

    Ok(found.map(|r| UserProfile {
        username: r.username.unwrap_or_default(),
        steam_id: r.steam_id.unwrap_or_default(),
        steam_account_name: r.steam_account_name.unwrap_or_default(),
        avatar_url: r.steam_account_avatar.unwrap_or_default(),
        country: r.country.unwrap_or_default(),
        kovaaks_plus: r.kovaaks_plus_active.unwrap_or(false),
    }))
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
    if trimmed.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',') {
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
            log::warn!("Scenario validation network error for {:?}: {e} — accepting anyway", trimmed);
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
                log::info!("Scenario validation: 0 results for {:?}, retrying with prefix {:?}", trimmed, first_long);
                if let Ok(extra) = api_search(first_long, 20).await {
                    pool = extra;
                }
            }

            if pool.is_empty() {
                log::info!("Scenario validation REJECTED: {:?} (0 results after fallback)", trimmed);
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
            let result = exact
                .map(|r| r.clone())
                .or_else(|| best.and_then(|(r, s)| if s >= JW_THRESHOLD { Some(r.clone()) } else { None }));

            if let Some(ref canonical) = result {
                log::info!(
                    "Scenario validation OK: {:?} → {:?} ({} candidates)",
                    trimmed, canonical, pool.len()
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

/// Fetch up to `max` scenario names from the popular endpoint for a given query string.
async fn api_search(query: &str, max: usize) -> anyhow::Result<Vec<String>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row { scenario_name: String }
    #[derive(Deserialize)]
    struct Resp { data: Vec<Row> }

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
