use std::collections::{HashMap, HashSet};

use chrono::{Duration, Local, NaiveDateTime, TimeZone};
use tauri::AppHandle;

use crate::{
    replay_store, session_store,
    session_store::{SessionRecord, SmoothnessSnapshot, StatsPanelSnapshot},
    settings, stats_db,
};

const BLOCK_GAP_MS: i64 = 6 * 60 * 60 * 1000;
const PRACTICE_PROFILE_WINDOW_DAYS: i64 = 14;
const PRACTICE_PROFILE_MIN_RECENT_SESSIONS: usize = 12;
const PRACTICE_PROFILE_FALLBACK_RUNS: usize = 60;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoachingCardData {
    pub id: String,
    pub source: String,
    pub title: String,
    pub badge: String,
    pub badge_color: String,
    pub body: String,
    pub tip: String,
    pub drills: Vec<DrillRecommendation>,
    pub confidence: Option<f64>,
    pub signals: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillRecommendation {
    pub label: String,
    pub query: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeProfileSnapshot {
    pub session_count: u32,
    pub active_days: u32,
    pub span_days: u32,
    pub days_per_week: f64,
    pub sessions_per_active_day: f64,
    pub avg_block_runs: f64,
    pub avg_block_minutes: f64,
    pub max_block_minutes: f64,
    pub scenario_diversity: u32,
    pub dominant_scenario: String,
    pub dominant_scenario_share: f64,
    pub avg_unique_scenarios_per_block: f64,
    pub avg_scenario_switches_per_block: f64,
    pub switch_rate: f64,
    pub top_scenarios: Vec<TopScenario>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopScenario {
    pub scenario: String,
    pub share: f64,
    pub count: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalCoachingLearningState {
    pub sample_count: u32,
    pub settled_sample_count: u32,
    pub warmup_sample_count: u32,
    pub normalized_variance_pct: Option<f64>,
    pub warmup_tax_pct: Option<f64>,
    pub avg_block_fade_pct: Option<f64>,
    pub switch_penalty_pct: Option<f64>,
    pub momentum_delta_pct: Option<f64>,
    pub retention_after_gap_pct: Option<f64>,
    pub dominant_family: Option<String>,
    pub dominant_family_share_pct: Option<f64>,
    pub family_diversity: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorPatternFeatures {
    pub sample_count: u32,
    pub settled_sample_count: u32,
    pub warmup_consistency_pct: Option<f64>,
    pub readiness_pct: Option<f64>,
    pub adaptation_pct: Option<f64>,
    pub endurance_pct: Option<f64>,
    pub transfer_pct: Option<f64>,
    pub precision_pct: Option<f64>,
    pub control_pct: Option<f64>,
    pub consistency_pct: Option<f64>,
    pub learning_efficiency_pct: Option<f64>,
    pub tempo_pct: Option<f64>,
    pub switch_resilience_pct: Option<f64>,
    pub retained_form_pct: Option<f64>,
    pub fatigue_pressure_pct: Option<f64>,
    pub correction_load_pct: Option<f64>,
    pub hesitation_load_pct: Option<f64>,
    pub reaction_pct: Option<f64>,
    pub anticipation_pct: Option<f64>,
    pub stabilization_pct: Option<f64>,
    pub stable_response_pct: Option<f64>,
    pub volatility_pct: Option<f64>,
    pub momentum_pct: Option<f64>,
    pub precision_tempo_bias_pct: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerLearningAxis {
    pub key: String,
    pub label: String,
    pub value_pct: f64,
    pub detail: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerLearningSignal {
    pub key: String,
    pub label: String,
    pub detail: String,
    pub value_pct: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerLearningProfile {
    pub generated_at_ms: u64,
    pub sample_count: u32,
    pub settled_sample_count: u32,
    pub coverage_start_ms: Option<u64>,
    pub coverage_end_ms: Option<u64>,
    pub summary: String,
    pub focus_area_key: Option<String>,
    pub focus_area_label: Option<String>,
    pub dominant_constraint_key: Option<String>,
    pub strengths: Vec<PlayerLearningSignal>,
    pub constraints: Vec<PlayerLearningSignal>,
    pub axes: Vec<PlayerLearningAxis>,
    pub metrics: HashMap<String, Option<f64>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoachingPersistenceStatus {
    pub snapshot_updated_at_ms: Option<u64>,
    pub pending_count: u32,
    pub improved_count: u32,
    pub flat_count: u32,
    pub regressed_count: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalCoachingOverview {
    pub practice_profile: Option<PracticeProfileSnapshot>,
    pub warmup_ids: Vec<String>,
    pub learning_state: Option<GlobalCoachingLearningState>,
    pub behavior_features: Option<BehaviorPatternFeatures>,
    pub player_learning_profile: Option<PlayerLearningProfile>,
    pub global_cards: Vec<CoachingCardData>,
    pub coaching_persistence_status: Option<CoachingPersistenceStatus>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMomentInsight {
    pub id: String,
    pub level: String,
    pub title: String,
    pub detail: String,
    pub metric: String,
    pub start_sec: u32,
    pub end_sec: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRunCoachingAnalysis {
    pub key_moments: Vec<RunMomentInsight>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioWarmupStats {
    pub drop_pct: f64,
    pub avg_warmup_sessions: f64,
    pub block_count: u32,
    pub settle_in_label: String,
    pub action: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioCoachingOverview {
    pub scenario_type: String,
    pub score_cv_pct: Option<f64>,
    pub slope_pts_per_run: Option<f64>,
    pub avg_score: Option<f64>,
    pub is_plateau: bool,
    pub p10_score: Option<f64>,
    pub p50_score: Option<f64>,
    pub p90_score: Option<f64>,
    pub warmup_stats: Option<ScenarioWarmupStats>,
    pub coaching_cards: Vec<CoachingCardData>,
}

#[derive(Debug, Clone)]
struct AnalyticsRecord {
    record: SessionRecord,
    normalized_scenario: String,
    timestamp_ms: i64,
    is_reliable_for_analysis: bool,
}

#[derive(Debug, Clone)]
struct ScenarioScoreBaseline {
    median_score: f64,
    scenario_type: String,
}

#[derive(Debug, Clone)]
struct NormalizedSessionSignal {
    record: AnalyticsRecord,
    normalized_score: f64,
    baseline: ScenarioScoreBaseline,
}

#[derive(Debug, Clone)]
struct CoachingUserPreferences {
    focus_area: String,
    challenge_preference: String,
    time_preference: String,
}

#[derive(Debug, Clone)]
struct AimFingerprintMetrics {
    precision: f64,
    speed: f64,
    control: f64,
    consistency: f64,
    decisiveness: f64,
    rhythm: f64,
    control_volatility: f64,
    rhythm_volatility: f64,
    consistency_volatility: f64,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
struct TargetResponseAggregate {
    sample_count: u32,
    avg_reaction_time_ms: Option<f64>,
    avg_pre_slowdown_reaction_ms: Option<f64>,
    avg_recovery_time_ms: Option<f64>,
    avg_path_change_reaction_ms: Option<f64>,
    avg_target_switch_reaction_ms: Option<f64>,
    avg_trigger_magnitude_deg: Option<f64>,
    avg_peak_yaw_error_deg: Option<f64>,
    stable_response_ratio: Option<f64>,
    response_coverage_pct: Option<f64>,
    reaction_trend_delta_ms: Option<f64>,
    recovery_trend_delta_ms: Option<f64>,
    stable_response_trend_pct: Option<f64>,
}

fn parse_timestamp_ms(ts: &str) -> Option<i64> {
    let parsed = NaiveDateTime::parse_from_str(ts, "%Y.%m.%d-%H.%M.%S").ok()?;
    Local
        .from_local_datetime(&parsed)
        .single()
        .map(|value| value.timestamp_millis())
}

fn normalize_scenario_name(name: &str) -> String {
    let bytes = name.as_bytes();
    for start in 0..bytes.len().saturating_sub(18) {
        if start + 19 > bytes.len() {
            break;
        }
        let slice = &bytes[start..start + 19];
        let matches = slice[4] == b'.'
            && slice[7] == b'.'
            && slice[10] == b'-'
            && slice[13] == b'.'
            && slice[16] == b'.'
            && slice
                .iter()
                .enumerate()
                .all(|(idx, ch)| matches!(idx, 4 | 7 | 10 | 13 | 16) || ch.is_ascii_digit());
        if !matches {
            continue;
        }
        if start == 0 {
            return name.to_string();
        }
        let prefix = &name[..start];
        if let Some(sep) = prefix.rfind(" - ") {
            return prefix[..sep].to_string();
        }
        return name.to_string();
    }
    name.to_string()
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn mean_defined<I>(values: I) -> Option<f64>
where
    I: IntoIterator<Item = Option<f64>>,
{
    let filtered = values
        .into_iter()
        .flatten()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    (!filtered.is_empty()).then(|| mean(&filtered))
}

fn stddev(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let avg = mean(values);
    (values
        .iter()
        .map(|value| (value - avg).powi(2))
        .sum::<f64>()
        / values.len() as f64)
        .sqrt()
}

fn percentile_of(sorted_values: &[f64], p: f64) -> f64 {
    if sorted_values.is_empty() {
        return 0.0;
    }
    let idx = (((sorted_values.len() as f64) * p) / 100.0).ceil() as isize - 1;
    sorted_values[idx.clamp(0, sorted_values.len() as isize - 1) as usize]
}

fn percentile(values: &[f64], p: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(percentile_of(&sorted, p))
}

fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 0 {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    } else {
        sorted[mid]
    }
}

fn median_absolute_deviation(values: &[f64], center: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let deviations = values
        .iter()
        .map(|value| (value - center).abs())
        .collect::<Vec<_>>();
    median(&deviations)
}

fn clamp_number(value: f64, min: f64, max: f64) -> f64 {
    value.clamp(min, max)
}

fn linear_regression_slope(values: &[f64]) -> f64 {
    let n = values.len();
    if n < 2 {
        return 0.0;
    }
    let xs = (1..=n).map(|value| value as f64).collect::<Vec<_>>();
    let sx = xs.iter().sum::<f64>();
    let sy = values.iter().sum::<f64>();
    let sxy = xs
        .iter()
        .zip(values.iter())
        .map(|(x, y)| x * y)
        .sum::<f64>();
    let sxx = xs.iter().map(|value| value * value).sum::<f64>();
    let denominator = (n as f64 * sxx) - sx.powi(2);
    if denominator.abs() < 0.0001 {
        0.0
    } else {
        ((n as f64 * sxy) - (sx * sy)) / denominator
    }
}

fn scale_to_score(value: f64, min: f64, max: f64) -> f64 {
    if (max - min).abs() < 0.0001 {
        return 0.0;
    }
    clamp_number(((value - min) / (max - min)) * 100.0, 0.0, 100.0)
}

fn inverse_range_score(value: f64, good: f64, bad: f64) -> f64 {
    100.0 - scale_to_score(value, good, bad)
}

fn scale_to_volatility(iqr: f64, span: f64) -> f64 {
    if span.abs() < 0.0001 {
        return 0.0;
    }
    clamp_number((iqr / span) * 100.0, 0.0, 100.0)
}

fn weighted_axis_score(parts: &[(f64, f64)]) -> f64 {
    let total_weight = parts.iter().map(|(_, weight)| *weight).sum::<f64>();
    if total_weight <= 0.0 {
        return 0.0;
    }
    let weighted = parts
        .iter()
        .map(|(score, weight)| score * weight)
        .sum::<f64>()
        / total_weight;
    clamp_number(weighted.round(), 0.0, 100.0)
}

fn metric_distribution(values: &[f64]) -> Option<(f64, f64, f64)> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if sorted.is_empty() {
        return None;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some((
        percentile_of(&sorted, 50.0),
        percentile_of(&sorted, 25.0),
        percentile_of(&sorted, 75.0),
    ))
}

fn normalize_accuracy_pct(
    value: Option<f64>,
    shots_hit: Option<f64>,
    shots_fired: Option<f64>,
) -> Option<f64> {
    if let (Some(hit), Some(fired)) = (shots_hit, shots_fired) {
        if hit.is_finite()
            && fired.is_finite()
            && hit >= 0.0
            && fired > 0.0
            && hit <= fired + 0.0001
        {
            return Some(((hit / fired) * 100.0).clamp(0.0, 100.0));
        }
    }
    let direct = value.filter(|value| value.is_finite() && *value >= 0.0)?;
    if direct <= 1.0 {
        Some((direct * 100.0).clamp(0.0, 100.0))
    } else if direct <= 100.0 {
        Some(direct)
    } else {
        None
    }
}

fn start_of_local_day_ms(timestamp_ms: i64) -> i64 {
    let dt = Local
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .unwrap_or_else(Local::now);
    dt.date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|naive| Local.from_local_datetime(&naive).single())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(timestamp_ms)
}

fn build_analytics_records(records: Vec<SessionRecord>) -> Vec<AnalyticsRecord> {
    let mut durations_by_scenario = HashMap::<String, Vec<f64>>::new();
    for record in &records {
        let normalized_scenario = normalize_scenario_name(&record.scenario);
        if record.duration_secs.is_finite() && record.duration_secs > 0.0 {
            durations_by_scenario
                .entry(normalized_scenario)
                .or_default()
                .push(record.duration_secs);
        }
    }

    let mut duration_windows = HashMap::<String, (f64, f64)>::new();
    for (scenario, durations) in durations_by_scenario {
        if durations.is_empty() {
            continue;
        }
        let duration_median = median(&durations);
        let duration_mad = median_absolute_deviation(&durations, duration_median);
        let spread_floor = duration_median.max(1.0) * 0.3;
        let spread = spread_floor.max(8.0).max(duration_mad * 10.0);
        duration_windows.insert(
            scenario,
            (
                (duration_median - spread).max(5.0),
                (duration_median * 2.25).max(duration_median + spread),
            ),
        );
    }

    records
        .into_iter()
        .map(|record| {
            let normalized_scenario = normalize_scenario_name(&record.scenario);
            let timestamp_ms = parse_timestamp_ms(&record.timestamp).unwrap_or(0);
            let duration_window = duration_windows.get(&normalized_scenario).copied();
            let is_duration_outlier = duration_window
                .map(|(lower, upper)| record.duration_secs < lower || record.duration_secs > upper)
                .unwrap_or(false);
            let is_zero_signal =
                record.score <= 0.0 && record.kills == 0 && record.damage_done <= 0.0;
            let is_reliable_for_analysis = timestamp_ms > 0
                && record.score.is_finite()
                && record.duration_secs.is_finite()
                && record.duration_secs > 0.0
                && !is_duration_outlier
                && !is_zero_signal;

            AnalyticsRecord {
                record,
                normalized_scenario,
                timestamp_ms,
                is_reliable_for_analysis,
            }
        })
        .collect()
}

fn group_into_play_blocks(records: &[AnalyticsRecord]) -> Vec<Vec<AnalyticsRecord>> {
    if records.is_empty() {
        return vec![];
    }
    let mut blocks = Vec::<Vec<AnalyticsRecord>>::new();
    let mut current = vec![records[0].clone()];
    for pair in records.windows(2) {
        let gap = pair[1].timestamp_ms - pair[0].timestamp_ms;
        if gap > BLOCK_GAP_MS {
            blocks.push(current);
            current = vec![pair[1].clone()];
        } else {
            current.push(pair[1].clone());
        }
    }
    blocks.push(current);
    blocks
}

fn classify_warmup(records: &[AnalyticsRecord]) -> HashSet<String> {
    let reliable = records
        .iter()
        .filter(|record| record.is_reliable_for_analysis)
        .cloned()
        .collect::<Vec<_>>();
    if reliable.len() < 6 {
        return HashSet::new();
    }

    let scores = reliable
        .iter()
        .map(|record| record.record.score)
        .collect::<Vec<_>>();
    let baseline_median = median(&scores);
    let baseline_mad = median_absolute_deviation(&scores, baseline_median);
    let score_scale = (baseline_mad * 1.4826).max(baseline_median * 0.06).max(1.0);
    let mut warmup_ids = HashSet::new();

    for block in group_into_play_blocks(&reliable) {
        if block.len() < 3 {
            continue;
        }
        let z_scores = block
            .iter()
            .map(|session| (session.record.score - baseline_median) / score_scale)
            .collect::<Vec<_>>();
        let recovered_index = z_scores.iter().position(|z| *z >= -0.15);
        let block_peak = z_scores.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let Some(recovered_index) = recovered_index else {
            continue;
        };
        if recovered_index == 0 || block_peak < 0.0 {
            continue;
        }
        let recovered_z = z_scores[recovered_index];
        for (idx, z_score) in z_scores.iter().take(recovered_index).enumerate() {
            if *z_score <= -0.25 && recovered_z - *z_score >= 0.35 && block_peak - *z_score >= 0.5 {
                warmup_ids.insert(block[idx].record.id.clone());
            }
        }
    }

    warmup_ids
}

fn build_practice_profile(records: &[AnalyticsRecord]) -> Option<PracticeProfileSnapshot> {
    let reliable = records
        .iter()
        .filter(|record| record.is_reliable_for_analysis)
        .cloned()
        .collect::<Vec<_>>();
    if reliable.len() < 5 {
        return None;
    }

    let latest_timestamp_ms = reliable.last()?.timestamp_ms;
    let recent_window_start_ms =
        latest_timestamp_ms - Duration::days(PRACTICE_PROFILE_WINDOW_DAYS).num_milliseconds();
    let recent_window = reliable
        .iter()
        .filter(|record| record.timestamp_ms >= recent_window_start_ms)
        .cloned()
        .collect::<Vec<_>>();
    let recent = if recent_window.len() >= PRACTICE_PROFILE_MIN_RECENT_SESSIONS {
        recent_window
    } else {
        reliable[reliable
            .len()
            .saturating_sub(PRACTICE_PROFILE_FALLBACK_RUNS)..]
            .to_vec()
    };
    let active_days = recent
        .iter()
        .map(|record| start_of_local_day_ms(record.timestamp_ms))
        .collect::<HashSet<_>>()
        .len();
    let first_day_ms = start_of_local_day_ms(recent.first()?.timestamp_ms);
    let last_day_ms = start_of_local_day_ms(recent.last()?.timestamp_ms);
    let span_days = (((last_day_ms - first_day_ms) as f64)
        / Duration::days(1).num_milliseconds() as f64)
        .round()
        .max(0.0) as u32
        + 1;
    let days_per_week = (active_days as f64 / span_days.max(1) as f64) * 7.0;
    let sessions_per_active_day = recent.len() as f64 / active_days.max(1) as f64;
    let blocks = group_into_play_blocks(&recent);
    let block_minutes = blocks
        .iter()
        .map(|block| {
            block
                .iter()
                .map(|record| record.record.duration_secs.max(0.0))
                .sum::<f64>()
                / 60.0
        })
        .collect::<Vec<_>>();
    let avg_block_runs = mean(
        &blocks
            .iter()
            .map(|block| block.len() as f64)
            .collect::<Vec<_>>(),
    );
    let avg_block_minutes = mean(&block_minutes);
    let max_block_minutes = block_minutes.iter().copied().fold(0.0, f64::max);

    let mut scenario_counts = HashMap::<String, u32>::new();
    for session in &recent {
        *scenario_counts
            .entry(session.normalized_scenario.clone())
            .or_default() += 1;
    }
    let (dominant_scenario, dominant_count) = scenario_counts
        .iter()
        .max_by_key(|(scenario, count)| (**count, std::cmp::Reverse((*scenario).clone())))
        .map(|(scenario, count)| (scenario.clone(), *count))
        .unwrap_or_else(|| ("Unknown".to_string(), 0));

    let mut top_scenarios = scenario_counts
        .iter()
        .map(|(scenario, count)| TopScenario {
            scenario: scenario.clone(),
            count: *count,
            share: *count as f64 / recent.len() as f64,
        })
        .collect::<Vec<_>>();
    top_scenarios.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.scenario.cmp(&b.scenario))
    });
    top_scenarios.truncate(3);

    let block_unique_scenario_counts = blocks
        .iter()
        .map(|block| {
            block
                .iter()
                .map(|record| record.normalized_scenario.clone())
                .collect::<HashSet<_>>()
                .len() as f64
        })
        .collect::<Vec<_>>();
    let block_switch_counts = blocks
        .iter()
        .map(|block| {
            block
                .windows(2)
                .filter(|pair| pair[0].normalized_scenario != pair[1].normalized_scenario)
                .count() as f64
        })
        .collect::<Vec<_>>();
    let total_adjacent_pairs = blocks
        .iter()
        .map(|block| block.len().saturating_sub(1))
        .sum::<usize>();
    let total_switches = block_switch_counts.iter().sum::<f64>();

    Some(PracticeProfileSnapshot {
        session_count: recent.len() as u32,
        active_days: active_days as u32,
        span_days,
        days_per_week,
        sessions_per_active_day,
        avg_block_runs,
        avg_block_minutes,
        max_block_minutes,
        scenario_diversity: scenario_counts.len() as u32,
        dominant_scenario,
        dominant_scenario_share: dominant_count as f64 / recent.len() as f64,
        avg_unique_scenarios_per_block: mean(&block_unique_scenario_counts),
        avg_scenario_switches_per_block: mean(&block_switch_counts),
        switch_rate: if total_adjacent_pairs > 0 {
            total_switches / total_adjacent_pairs as f64
        } else {
            0.0
        },
        top_scenarios,
    })
}

fn scenario_type(stats_panel: &Option<StatsPanelSnapshot>) -> String {
    stats_panel
        .as_ref()
        .and_then(|panel| {
            let trimmed = panel.scenario_type.trim();
            (!trimmed.is_empty() && trimmed != "Unknown").then(|| trimmed.to_string())
        })
        .unwrap_or_else(|| "Unknown".to_string())
}

fn dominant_scenario_type(records: &[AnalyticsRecord]) -> String {
    let mut counts = HashMap::<String, u32>::new();
    for record in records
        .iter()
        .filter(|record| record.is_reliable_for_analysis)
    {
        let scenario_type = scenario_type(&record.record.stats_panel);
        if scenario_type != "Unknown" {
            *counts.entry(scenario_type).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .max_by(|left, right| left.1.cmp(&right.1).then_with(|| right.0.cmp(&left.0)))
        .map(|(scenario_type, _)| scenario_type)
        .unwrap_or_else(|| "Unknown".to_string())
}

fn is_tracking_scenario(scenario_type: &str) -> bool {
    scenario_type == "PureTracking" || scenario_type.contains("Tracking")
}

fn is_target_switching_scenario(scenario_type: &str) -> bool {
    scenario_type == "TargetSwitching" || scenario_type == "MultiHitClicking"
}

fn is_static_clicking_scenario(scenario_type: &str) -> bool {
    scenario_type == "StaticClicking" || scenario_type == "OneShotClicking"
}

fn is_dynamic_clicking_scenario(scenario_type: &str) -> bool {
    matches!(
        scenario_type,
        "DynamicClicking" | "MovingClicking" | "ReactiveClicking"
    )
}

fn is_accuracy_scenario(scenario_type: &str) -> bool {
    scenario_type == "AccuracyDrill"
}

fn describe_warmup_settle_in(avg_warmup_sessions: f64) -> String {
    if avg_warmup_sessions <= 0.75 {
        "the first run".to_string()
    } else if avg_warmup_sessions <= 1.5 {
        "about the first run".to_string()
    } else if avg_warmup_sessions <= 2.5 {
        "about the first 2 runs".to_string()
    } else {
        format!("about the first {} runs", avg_warmup_sessions.ceil() as u32)
    }
}

fn describe_warmup_action(avg_warmup_sessions: f64) -> String {
    if avg_warmup_sessions <= 1.0 {
        "A short 2-3 minute primer on an easy tracking or large-target clicking scenario should be enough before serious attempts.".to_string()
    } else if avg_warmup_sessions <= 2.0 {
        "Use a brief ramp before your main scenario: easy tracking, then medium flicks, then your main task once the cursor feels settled.".to_string()
    } else {
        "Your warm-up window is longer than ideal. Start each block with a deliberate 2-3 scenario ramp that climbs toward your main task instead of opening cold on score attempts.".to_string()
    }
}

fn slugify_key(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    slug.trim_matches('-').to_string()
}

fn drill_recommendations_for_card(title: &str, scenario_type: &str) -> Vec<DrillRecommendation> {
    let lower = title.to_ascii_lowercase();
    if lower.contains("warm-up") || lower.contains("warmup") {
        return vec![
            DrillRecommendation {
                label: "Smoothbot".to_string(),
                query: "Smoothbot".to_string(),
            },
            DrillRecommendation {
                label: "Wide Wall".to_string(),
                query: "Wide Wall".to_string(),
            },
            DrillRecommendation {
                label: "Centering".to_string(),
                query: "Centering".to_string(),
            },
        ];
    }
    if lower.contains("shot recovery") || lower.contains("recover") {
        return vec![
            DrillRecommendation {
                label: "Pasu".to_string(),
                query: "Pasu".to_string(),
            },
            DrillRecommendation {
                label: "1w4ts".to_string(),
                query: "1w4ts".to_string(),
            },
            DrillRecommendation {
                label: "Microshot".to_string(),
                query: "Microshot".to_string(),
            },
        ];
    }
    if lower.contains("click timing") || lower.contains("rhythm") {
        return vec![
            DrillRecommendation {
                label: "Microshot".to_string(),
                query: "Microshot".to_string(),
            },
            DrillRecommendation {
                label: "Tile Frenzy".to_string(),
                query: "Tile Frenzy".to_string(),
            },
            DrillRecommendation {
                label: "1wall 6targets".to_string(),
                query: "1wall 6targets".to_string(),
            },
        ];
    }
    if lower.contains("overshooting") || lower.contains("speed-accuracy") {
        return if is_tracking_scenario(scenario_type) {
            vec![
                DrillRecommendation {
                    label: "Smoothbot".to_string(),
                    query: "Smoothbot".to_string(),
                },
                DrillRecommendation {
                    label: "Air".to_string(),
                    query: "Air".to_string(),
                },
                DrillRecommendation {
                    label: "Centering".to_string(),
                    query: "Centering".to_string(),
                },
            ]
        } else {
            vec![
                DrillRecommendation {
                    label: "Pasu".to_string(),
                    query: "Pasu".to_string(),
                },
                DrillRecommendation {
                    label: "1w4ts".to_string(),
                    query: "1w4ts".to_string(),
                },
                DrillRecommendation {
                    label: "Floating Heads".to_string(),
                    query: "Floating Heads".to_string(),
                },
            ]
        };
    }
    if lower.contains("tracking") || is_tracking_scenario(scenario_type) {
        return vec![
            DrillRecommendation {
                label: "Smoothbot".to_string(),
                query: "Smoothbot".to_string(),
            },
            DrillRecommendation {
                label: "Air Angelic".to_string(),
                query: "Air Angelic".to_string(),
            },
            DrillRecommendation {
                label: "Centering".to_string(),
                query: "Centering".to_string(),
            },
        ];
    }
    vec![
        DrillRecommendation {
            label: "Pasu".to_string(),
            query: "Pasu".to_string(),
        },
        DrillRecommendation {
            label: "1w4ts".to_string(),
            query: "1w4ts".to_string(),
        },
        DrillRecommendation {
            label: "Microshot".to_string(),
            query: "Microshot".to_string(),
        },
    ]
}

fn build_scenario_warmup_stats(
    sorted: &[AnalyticsRecord],
    warmup_ids: &HashSet<String>,
) -> Option<ScenarioWarmupStats> {
    if sorted.is_empty() || warmup_ids.is_empty() {
        return None;
    }
    let warmup_sorted = sorted
        .iter()
        .filter(|record| warmup_ids.contains(&record.record.id))
        .collect::<Vec<_>>();
    let peak_sorted = sorted
        .iter()
        .filter(|record| !warmup_ids.contains(&record.record.id))
        .collect::<Vec<_>>();
    if warmup_sorted.is_empty() {
        return None;
    }
    let warmup_avg = mean(
        &warmup_sorted
            .iter()
            .map(|record| record.record.score)
            .collect::<Vec<_>>(),
    );
    let peak_avg = if peak_sorted.is_empty() {
        0.0
    } else {
        mean(
            &peak_sorted
                .iter()
                .map(|record| record.record.score)
                .collect::<Vec<_>>(),
        )
    };
    let drop_pct = if peak_avg > 0.0 {
        ((peak_avg - warmup_avg) / peak_avg).max(0.0) * 100.0
    } else {
        0.0
    };
    let blocks = group_into_play_blocks(sorted);
    let warmup_blocks = blocks
        .iter()
        .filter(|block| {
            block
                .iter()
                .any(|session| warmup_ids.contains(&session.record.id))
        })
        .collect::<Vec<_>>();
    let avg_warmup_sessions = if warmup_blocks.is_empty() {
        0.0
    } else {
        warmup_blocks
            .iter()
            .map(|block| {
                block
                    .iter()
                    .filter(|session| warmup_ids.contains(&session.record.id))
                    .count() as f64
            })
            .sum::<f64>()
            / warmup_blocks.len() as f64
    };
    Some(ScenarioWarmupStats {
        drop_pct,
        avg_warmup_sessions,
        block_count: warmup_blocks.len() as u32,
        settle_in_label: describe_warmup_settle_in(avg_warmup_sessions),
        action: describe_warmup_action(avg_warmup_sessions),
    })
}

fn build_scenario_score_baselines(
    records: &[AnalyticsRecord],
) -> HashMap<String, ScenarioScoreBaseline> {
    let mut grouped = HashMap::<String, (Vec<f64>, HashMap<String, u32>)>::new();
    for record in records
        .iter()
        .filter(|record| record.is_reliable_for_analysis)
    {
        if !record.record.score.is_finite() || record.record.score <= 0.0 {
            continue;
        }
        let entry = grouped
            .entry(record.normalized_scenario.clone())
            .or_insert_with(|| (Vec::new(), HashMap::new()));
        entry.0.push(record.record.score);
        let scenario_type = scenario_type(&record.record.stats_panel);
        if scenario_type != "Unknown" {
            *entry.1.entry(scenario_type).or_default() += 1;
        }
    }

    grouped
        .into_iter()
        .filter_map(|(scenario, (scores, scenario_type_counts))| {
            if scores.len() < 3 {
                return None;
            }
            let mut sorted_scores = scores;
            sorted_scores.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let scenario_type = scenario_type_counts
                .into_iter()
                .max_by(|left, right| left.1.cmp(&right.1).then_with(|| right.0.cmp(&left.0)))
                .map(|(scenario_type, _)| scenario_type)
                .unwrap_or_else(|| "Unknown".to_string());
            Some((
                scenario,
                ScenarioScoreBaseline {
                    median_score: percentile_of(&sorted_scores, 50.0),
                    scenario_type,
                },
            ))
        })
        .collect()
}

fn build_normalized_session_signals(records: &[AnalyticsRecord]) -> Vec<NormalizedSessionSignal> {
    let baselines = build_scenario_score_baselines(records);
    records
        .iter()
        .filter(|record| record.is_reliable_for_analysis)
        .filter_map(|record| {
            let baseline = baselines.get(&record.normalized_scenario)?;
            if baseline.median_score <= 0.0 {
                return None;
            }
            let normalized_score = record.record.score / baseline.median_score;
            (normalized_score.is_finite() && normalized_score > 0.0).then(|| {
                NormalizedSessionSignal {
                    record: record.clone(),
                    normalized_score: clamp_number(normalized_score, 0.2, 3.0),
                    baseline: baseline.clone(),
                }
            })
        })
        .collect()
}

fn build_aim_fingerprint(
    records: &[AnalyticsRecord],
    scenario_type: &str,
) -> Option<AimFingerprintMetrics> {
    let smoothness = records
        .iter()
        .filter_map(|record| record.record.smoothness.as_ref())
        .collect::<Vec<_>>();
    if smoothness.is_empty() {
        return None;
    }

    let dist = |pick: fn(&SmoothnessSnapshot) -> f32| {
        let values = smoothness
            .iter()
            .map(|snapshot| pick(snapshot) as f64)
            .collect::<Vec<_>>();
        metric_distribution(&values).unwrap_or((0.0, 0.0, 0.0))
    };

    let jitter = dist(|snapshot| snapshot.jitter);
    let overshoot = dist(|snapshot| snapshot.overshoot_rate);
    let vel_std = dist(|snapshot| snapshot.velocity_std);
    let avg_speed = dist(|snapshot| snapshot.avg_speed);
    let path_eff = dist(|snapshot| snapshot.path_efficiency);
    let correction = dist(|snapshot| snapshot.correction_ratio);
    let click_cv = dist(|snapshot| snapshot.click_timing_cv);
    let directional_bias = dist(|snapshot| snapshot.directional_bias);
    let tracking = is_tracking_scenario(scenario_type);

    let precision = weighted_axis_score(&[
        (scale_to_score(path_eff.0, 0.86, 0.985), 0.65),
        (inverse_range_score(jitter.2, 0.14, 0.45), 0.35),
    ]);
    let speed = scale_to_score(
        avg_speed.0,
        if tracking { 650.0 } else { 450.0 },
        if tracking { 2600.0 } else { 2300.0 },
    )
    .round();
    let control = weighted_axis_score(&[
        (
            inverse_range_score(overshoot.0.max(overshoot.2 * 0.75), 0.00005, 0.0045),
            0.4,
        ),
        (
            inverse_range_score(correction.0.max(correction.2 * 0.85), 0.10, 0.42),
            0.4,
        ),
        (scale_to_score(path_eff.0, 0.88, 0.98), 0.15),
        (
            inverse_range_score(directional_bias.0.max(directional_bias.2 * 0.8), 0.0, 0.08),
            0.05,
        ),
    ]);
    let consistency = weighted_axis_score(&[
        (
            inverse_range_score(vel_std.0.max(vel_std.2 * 0.85), 0.18, 0.9),
            0.8,
        ),
        (inverse_range_score(jitter.0, 0.12, 0.42), 0.2),
    ]);
    let decisiveness = weighted_axis_score(&[
        (
            inverse_range_score(correction.0.max(correction.2 * 0.8), 0.08, 0.38),
            0.85,
        ),
        (
            inverse_range_score(directional_bias.0.max(directional_bias.2), 0.0, 0.08),
            0.15,
        ),
    ]);
    let rhythm = if tracking {
        weighted_axis_score(&[
            (
                inverse_range_score(vel_std.0.max(vel_std.2), 0.18, 0.95),
                0.7,
            ),
            (inverse_range_score(jitter.0, 0.12, 0.42), 0.3),
        ])
    } else {
        weighted_axis_score(&[
            (
                inverse_range_score(click_cv.0.max(click_cv.2 * 0.9), 0.03, 0.28),
                0.8,
            ),
            (
                inverse_range_score(correction.0.max(correction.2 * 0.85), 0.08, 0.4),
                0.2,
            ),
        ])
    };

    Some(AimFingerprintMetrics {
        precision,
        speed,
        control,
        consistency,
        decisiveness,
        rhythm,
        control_volatility: (scale_to_volatility(overshoot.2 - overshoot.1, 0.0045)
            + scale_to_volatility(correction.2 - correction.1, 0.22)
            + scale_to_volatility(directional_bias.2 - directional_bias.1, 0.08))
            / 3.0,
        rhythm_volatility: if tracking {
            scale_to_volatility(vel_std.2 - vel_std.1, 0.24)
        } else {
            scale_to_volatility(click_cv.2 - click_cv.1, 0.3)
        },
        consistency_volatility: scale_to_volatility(vel_std.2 - vel_std.1, 0.24),
    })
}

fn build_target_response_aggregate(
    records: &[AnalyticsRecord],
    summaries_by_session: &HashMap<String, crate::target_response::TargetResponseSummaryRecord>,
) -> Option<TargetResponseAggregate> {
    let summaries = records
        .iter()
        .filter_map(|record| summaries_by_session.get(&record.record.id))
        .filter(|summary| summary.summary.episode_count > 0)
        .cloned()
        .collect::<Vec<_>>();
    if summaries.len() < 3 {
        return None;
    }

    let reaction_values = summaries
        .iter()
        .filter_map(|summary| summary.summary.avg_reaction_time_ms)
        .collect::<Vec<_>>();
    let recovery_values = summaries
        .iter()
        .filter_map(|summary| summary.summary.avg_recovery_time_ms)
        .collect::<Vec<_>>();
    let stable_values = summaries
        .iter()
        .filter_map(|summary| summary.summary.stable_response_ratio)
        .collect::<Vec<_>>();

    let trend_window = (summaries.len() / 3).max(3).min(8);
    let reaction_trend_delta_ms = if reaction_values.len() >= trend_window * 2 {
        let older = &reaction_values
            [reaction_values.len() - trend_window * 2..reaction_values.len() - trend_window];
        let recent = &reaction_values[reaction_values.len() - trend_window..];
        Some(mean(recent) - mean(older))
    } else {
        None
    };
    let recovery_trend_delta_ms = if recovery_values.len() >= trend_window * 2 {
        let older = &recovery_values
            [recovery_values.len() - trend_window * 2..recovery_values.len() - trend_window];
        let recent = &recovery_values[recovery_values.len() - trend_window..];
        Some(mean(recent) - mean(older))
    } else {
        None
    };
    let stable_response_trend_pct = if stable_values.len() >= trend_window * 2 {
        let older = &stable_values
            [stable_values.len() - trend_window * 2..stable_values.len() - trend_window];
        let recent = &stable_values[stable_values.len() - trend_window..];
        Some((mean(recent) - mean(older)) * 100.0)
    } else {
        None
    };

    Some(TargetResponseAggregate {
        sample_count: summaries.len() as u32,
        avg_reaction_time_ms: mean_defined(
            summaries
                .iter()
                .map(|summary| summary.summary.avg_reaction_time_ms),
        ),
        avg_pre_slowdown_reaction_ms: mean_defined(
            summaries
                .iter()
                .map(|summary| summary.summary.avg_pre_slowdown_reaction_ms),
        ),
        avg_recovery_time_ms: mean_defined(
            summaries
                .iter()
                .map(|summary| summary.summary.avg_recovery_time_ms),
        ),
        avg_path_change_reaction_ms: mean_defined(
            summaries
                .iter()
                .map(|summary| summary.summary.avg_path_change_reaction_ms),
        ),
        avg_target_switch_reaction_ms: mean_defined(
            summaries
                .iter()
                .map(|summary| summary.summary.avg_target_switch_reaction_ms),
        ),
        avg_trigger_magnitude_deg: mean_defined(
            summaries
                .iter()
                .map(|summary| summary.summary.avg_trigger_magnitude_deg),
        ),
        avg_peak_yaw_error_deg: mean_defined(
            summaries
                .iter()
                .map(|summary| summary.summary.avg_peak_yaw_error_deg),
        ),
        stable_response_ratio: mean_defined(
            summaries
                .iter()
                .map(|summary| summary.summary.stable_response_ratio),
        ),
        response_coverage_pct: mean_defined(
            summaries
                .iter()
                .map(|summary| summary.response_coverage_pct),
        ),
        reaction_trend_delta_ms,
        recovery_trend_delta_ms,
        stable_response_trend_pct,
    })
}

fn push_unique_scenario_card(
    cards: &mut Vec<CoachingCardData>,
    title: &str,
    badge: &str,
    badge_color: &str,
    body: String,
    tip: String,
) {
    let id = format!("scenario-{}", slugify_key(title));
    if cards.iter().any(|card| card.id == id) {
        return;
    }
    cards.push(CoachingCardData {
        id,
        source: "scenario".to_string(),
        title: title.to_string(),
        badge: badge.to_string(),
        badge_color: badge_color.to_string(),
        body,
        tip,
        drills: Vec::new(),
        confidence: None,
        signals: Vec::new(),
    });
}

fn build_scenario_coaching_cards(
    records: &[AnalyticsRecord],
    sorted: &[AnalyticsRecord],
    practice_profile: Option<&PracticeProfileSnapshot>,
    scenario_type: &str,
    fingerprint: Option<&AimFingerprintMetrics>,
    target_response: Option<&TargetResponseAggregate>,
    family_target_response: Option<&TargetResponseAggregate>,
    score_cv: f64,
    slope: f64,
    avg_score: f64,
    is_plateau: bool,
) -> Vec<CoachingCardData> {
    let mut cards = Vec::<CoachingCardData>::new();
    let panel_records = records
        .iter()
        .filter(|record| record.record.stats_panel.is_some())
        .collect::<Vec<_>>();
    let shot_timing_records = records
        .iter()
        .filter(|record| record.record.shot_timing.is_some())
        .collect::<Vec<_>>();
    let n = sorted.len();
    let is_tracking = is_tracking_scenario(scenario_type);

    let shot_avg_shots_to_hit = mean_defined(shot_timing_records.iter().map(|record| {
        record
            .record
            .shot_timing
            .as_ref()
            .and_then(|snapshot| snapshot.avg_shots_to_hit.map(|value| value as f64))
    }));
    let shot_avg_corrective = mean_defined(shot_timing_records.iter().map(|record| {
        record
            .record
            .shot_timing
            .as_ref()
            .and_then(|snapshot| snapshot.corrective_shot_ratio.map(|value| value as f64))
    }));
    let shot_avg_fire_to_hit = mean_defined(shot_timing_records.iter().map(|record| {
        record
            .record
            .shot_timing
            .as_ref()
            .and_then(|snapshot| snapshot.avg_fire_to_hit_ms.map(|value| value as f64))
    }));
    let has_shot_recovery_signal = !is_tracking
        && shot_timing_records.len() >= 3
        && (shot_avg_shots_to_hit.is_some()
            || shot_avg_corrective.is_some()
            || shot_avg_fire_to_hit.is_some());

    if is_plateau {
        push_unique_scenario_card(
            &mut cards,
            "Plateau Detected",
            "Motor Learning",
            "#ff9f43",
            format!(
                "Your last 7 sessions show minimal score movement (slope: {}{} pts/run, low recent variance). This is completely normal — your nervous system needs new stimuli to adapt further. Grinding the same scenario will not break a plateau.",
                if slope > 0.0 { "+" } else { "" },
                slope.round() as i64
            ),
            "Switch to a harder scenario variant or cross-train on a different aim type (e.g. tracking -> clicking) for 5-10 sessions, then return. Novel difficulty forces neural adaptation and produces fresh gains when you come back.".to_string(),
        );
    }

    if score_cv > 12.0 && n >= 5 {
        push_unique_scenario_card(
            &mut cards,
            "High Score Variance",
            "Consistency Science",
            "#ffd700",
            format!(
                "Your scores vary by {:.1}% around your average (ideal: <8%). High variance typically signals inconsistent warm-up, mental state differences between sessions, or changing grip/posture.",
                score_cv
            ),
            "Add 2-3 'warm-up only' runs before each real attempt. Research on motor skill shows consistent pre-performance routines reduce run-to-run variability by priming the correct movement patterns.".to_string(),
        );
    }

    let trend_values = panel_records
        .iter()
        .filter_map(|record| {
            record
                .record
                .stats_panel
                .as_ref()
                .and_then(|snapshot| snapshot.accuracy_trend.map(|value| value as f64))
        })
        .collect::<Vec<_>>();
    if trend_values.len() >= 3 {
        let avg_trend = mean(&trend_values);
        if avg_trend < -5.0 {
            push_unique_scenario_card(
                &mut cards,
                "Cognitive Fatigue Pattern",
                "Exercise Science",
                "#ff6b6b",
                format!(
                    "Your accuracy drops an average of {:.1}% from the first half to the second half of sessions. Aim skill is among the first to degrade under cognitive load — your fine motor control deteriorates before you notice it consciously.",
                    avg_trend.abs()
                ),
                "Cap continuous play at 45-60 minutes. Taking a 5-minute break every 20-25 minutes sustains performance longer than marathon sessions, and the break helps within-session consolidation.".to_string(),
            );
        } else if avg_trend > 5.0 {
            push_unique_scenario_card(
                &mut cards,
                "Extended Warm-up Pattern",
                "Motor Activation",
                "#00f5a0",
                format!(
                    "Your accuracy improves {:.1}% from session start to finish — your motor system takes time to fully activate. This means your early-session scores underrepresent your true skill level.",
                    avg_trend
                ),
                "Add a dedicated warm-up before your main scenario: 2-3 minutes of easy tracking or large relaxed flicks. This pre-activates the movement patterns used in aim and helps you peak sooner.".to_string(),
            );
        }
    }

    if let Some(practice_profile) = practice_profile {
        if practice_profile.session_count >= 5 {
            let days_per_week = practice_profile.days_per_week;
            let avg_block_minutes = practice_profile.avg_block_minutes;
            let massed_pattern = avg_block_minutes >= 45.0
                || (days_per_week < 2.5 && practice_profile.avg_block_runs >= 6.0);
            let distributed_pattern =
                days_per_week >= 3.5 && (12.0..=35.0).contains(&avg_block_minutes);
            if massed_pattern {
                push_unique_scenario_card(
                    &mut cards,
                    "Massed Practice Pattern",
                    "Spacing Science",
                    "#00b4ff",
                    format!(
                        "Your last {} reliable runs are clustered into {:.0}-minute play blocks across roughly {:.1} active days/week. Long grind blocks can feel productive in the moment, but they also stack warm-up gains and fatigue together, which makes true progress harder to read.",
                        practice_profile.session_count,
                        avg_block_minutes,
                        days_per_week
                    ),
                    "Keep the volume, split the block. Converting one long grind into two 20-35 minute blocks on separate parts of the day or on adjacent days usually preserves effort while improving what actually sticks.".to_string(),
                );
            } else if distributed_pattern {
                push_unique_scenario_card(
                    &mut cards,
                    "Well-Spaced Practice",
                    "Spacing Science",
                    "#00f5a0",
                    format!(
                        "Recent practice is spread across about {:.1} active days/week with blocks averaging {:.0} minutes. That is close to the range where the learning benefit of spacing shows up without paying too much warm-up or fatigue tax.",
                        days_per_week,
                        avg_block_minutes
                    ),
                    "This is a good base. Keep block length stable and judge progress with next-day quality and consistency, not only with whether the final run of a long session sets a PB.".to_string(),
                );
            } else {
                push_unique_scenario_card(
                    &mut cards,
                    "Practice Distribution Matters",
                    "Spacing Science",
                    "#00b4ff",
                    format!(
                        "Your recent schedule is mixed: about {:.1} active days/week and {:.0} minutes per play block. There is probably some easy progress left on the table just from making your schedule a little more repeatable.",
                        days_per_week,
                        avg_block_minutes
                    ),
                    "Nudge toward consistency before adding more volume. Aim for repeatable 20-35 minute blocks on 3-5 days/week, then compare your median score and variance after a week instead of chasing one-day highs.".to_string(),
                );
            }
        }
    }

    if has_shot_recovery_signal {
        let severe = shot_avg_shots_to_hit
            .map(|value| value > 1.75)
            .unwrap_or(false)
            || shot_avg_corrective
                .map(|value| value > 0.48)
                .unwrap_or(false)
            || shot_avg_fire_to_hit
                .map(|value| value > 320.0)
                .unwrap_or(false);
        let mild = shot_avg_shots_to_hit
            .map(|value| value > 1.35)
            .unwrap_or(false)
            || shot_avg_corrective
                .map(|value| value > 0.28)
                .unwrap_or(false)
            || shot_avg_fire_to_hit
                .map(|value| value > 220.0)
                .unwrap_or(false);
        if severe {
            push_unique_scenario_card(
                &mut cards,
                "Shot Recovery Bottleneck",
                "Shot Timing",
                "#00b4ff",
                format!(
                    "Your fired->hit data shows heavy recovery burden ({} shots/hit, {} corrective hits, {}ms fired->hit). This is consistent with overflick + micro-correction before final confirmation.",
                    shot_avg_shots_to_hit.map(|value| format!("{value:.2}")).unwrap_or_else(|| "—".to_string()),
                    shot_avg_corrective.map(|value| format!("{:.0}%", value * 100.0)).unwrap_or_else(|| "—".to_string()),
                    shot_avg_fire_to_hit.map(|value| format!("{value:.0}")).unwrap_or_else(|| "—".to_string())
                ),
                "Shift 10-15% focus from max flick speed to first-shot landing quality: brake earlier and fire once your crosshair settles. Track this over sessions until shots/hit moves toward 1.2 or lower.".to_string(),
            );
        } else if mild {
            push_unique_scenario_card(
                &mut cards,
                "Recoveries Still Costing Time",
                "Shot Timing",
                "#00b4ff",
                format!(
                    "Shot recovery is moderate ({} shots/hit, {} corrective hits). Small overshoots are forcing extra correction before secure hits.",
                    shot_avg_shots_to_hit.map(|value| format!("{value:.2}")).unwrap_or_else(|| "—".to_string()),
                    shot_avg_corrective.map(|value| format!("{:.0}%", value * 100.0)).unwrap_or_else(|| "—".to_string())
                ),
                "Use deceleration reps: finish flicks under control and prioritize first-shot confirmation, then add speed back gradually.".to_string(),
            );
        } else {
            push_unique_scenario_card(
                &mut cards,
                "Strong First-Shot Conversion",
                "Shot Timing",
                "#00f5a0",
                format!(
                    "You convert efficiently after firing ({} shots/hit, {} corrective hits, {}ms fired->hit).",
                    shot_avg_shots_to_hit.map(|value| format!("{value:.2}")).unwrap_or_else(|| "—".to_string()),
                    shot_avg_corrective.map(|value| format!("{:.0}%", value * 100.0)).unwrap_or_else(|| "—".to_string()),
                    shot_avg_fire_to_hit.map(|value| format!("{value:.0}")).unwrap_or_else(|| "—".to_string())
                ),
                "Keep this while increasing pace. Maintain control on shot entry so first-shot quality stays stable at higher speed.".to_string(),
            );
        }
    }

    if let Some(target_response) = target_response {
        let reaction_gap_vs_family = match (
            target_response.avg_reaction_time_ms,
            family_target_response.and_then(|baseline| baseline.avg_reaction_time_ms),
        ) {
            (Some(current), Some(baseline)) => Some(current - baseline),
            _ => None,
        };
        let recovery_gap_vs_family = match (
            target_response.avg_recovery_time_ms,
            family_target_response.and_then(|baseline| baseline.avg_recovery_time_ms),
        ) {
            (Some(current), Some(baseline)) => Some(current - baseline),
            _ => None,
        };
        let stable_gap_vs_family = match (
            target_response.stable_response_ratio,
            family_target_response.and_then(|baseline| baseline.stable_response_ratio),
        ) {
            (Some(current), Some(baseline)) => Some((current - baseline) * 100.0),
            _ => None,
        };

        if target_response.sample_count >= 4 {
            if target_response
                .avg_reaction_time_ms
                .is_some_and(|value| value >= 225.0)
                || reaction_gap_vs_family.is_some_and(|value| value >= 30.0)
            {
                push_unique_scenario_card(
                    &mut cards,
                    "Late Recognition On Target Changes",
                    "Target Response",
                    "#ffd700",
                    format!(
                        "Rust replay telemetry says this scenario is asking more recognition time than your usual baseline ({}ms avg reaction{}). The expensive part is noticing large path breaks or switches quickly enough to stay on the right line.",
                        target_response
                            .avg_reaction_time_ms
                            .map(|value| format!("{value:.0}"))
                            .unwrap_or_else(|| "—".to_string()),
                        reaction_gap_vs_family
                            .map(|value| format!(", about {value:.0}ms slower than your usual {} baseline", scenario_type))
                            .unwrap_or_default()
                    ),
                    "Use replay-guided reps here: watch only the first mouse response after a target change and force an earlier directional commit before worrying about final shot polish.".to_string(),
                );
            }

            if target_response
                .avg_pre_slowdown_reaction_ms
                .zip(target_response.avg_reaction_time_ms)
                .is_some_and(|(pre_slow, reaction)| pre_slow - reaction >= 55.0)
            {
                push_unique_scenario_card(
                    &mut cards,
                    "You See The Change But Brake Late",
                    "Target Response",
                    "#ff9f43",
                    format!(
                        "Pre-slowdown reaction trails first recognition by about {}ms in this scenario ({}ms reaction, {}ms first brake). You are seeing the break, but the deceleration cue starts late enough that recovery work stacks afterward.",
                        target_response
                            .avg_pre_slowdown_reaction_ms
                            .zip(target_response.avg_reaction_time_ms)
                            .map(|(pre_slow, reaction)| (pre_slow - reaction).round() as i64)
                            .unwrap_or(0),
                        target_response
                            .avg_reaction_time_ms
                            .map(|value| format!("{value:.0}"))
                            .unwrap_or_else(|| "—".to_string()),
                        target_response
                            .avg_pre_slowdown_reaction_ms
                            .map(|value| format!("{value:.0}"))
                            .unwrap_or_else(|| "—".to_string())
                    ),
                    "Practice one constraint block where you start braking as soon as the new target path is recognized, even if it feels slightly early. The goal is to arrive inside the target zone instead of correcting back into it.".to_string(),
                );
            }

            if target_response
                .avg_recovery_time_ms
                .is_some_and(|value| value >= 430.0)
                || recovery_gap_vs_family.is_some_and(|value| value >= 70.0)
                || target_response
                    .stable_response_ratio
                    .is_some_and(|value| value <= 0.42)
            {
                push_unique_scenario_card(
                    &mut cards,
                    "Recovery Loops Are The Bottleneck",
                    "Target Response",
                    "#00b4ff",
                    format!(
                        "After the first target change, this scenario is costing too much stabilization time ({}ms avg recovery, {} stable responses{}). The score loss is happening after recognition, during cleanup.",
                        target_response
                            .avg_recovery_time_ms
                            .map(|value| format!("{value:.0}"))
                            .unwrap_or_else(|| "—".to_string()),
                        target_response
                            .stable_response_ratio
                            .map(|value| format!("{:.0}%", value * 100.0))
                            .unwrap_or_else(|| "—".to_string()),
                        stable_gap_vs_family
                            .map(|value| format!(", {value:.0} pts vs your usual {} baseline", scenario_type))
                            .unwrap_or_default()
                    ),
                    "Lower the entry speed slightly and measure success by how quickly the crosshair settles after the first correction. Cleaner recovery usually adds more score here than pushing raw speed.".to_string(),
                );
            } else if target_response
                .stable_response_ratio
                .is_some_and(|value| value >= 0.62)
                && target_response
                    .avg_recovery_time_ms
                    .is_some_and(|value| value <= 300.0)
            {
                push_unique_scenario_card(
                    &mut cards,
                    "Strong Stabilization In This Scenario",
                    "Target Response",
                    "#00f5a0",
                    format!(
                        "You are handling target changes cleanly here ({} stable responses, {}ms avg recovery). The response chain is already efficient enough that you can safely pressure speed or difficulty.",
                        target_response
                            .stable_response_ratio
                            .map(|value| format!("{:.0}%", value * 100.0))
                            .unwrap_or_else(|| "—".to_string()),
                        target_response
                            .avg_recovery_time_ms
                            .map(|value| format!("{value:.0}"))
                            .unwrap_or_else(|| "—".to_string())
                    ),
                    "Keep the same recovery quality and raise only one demand next: smaller targets, faster paths, or a slightly more aggressive commit window.".to_string(),
                );
            }
        }
    }

    if !has_shot_recovery_signal
        && fingerprint
            .map(|value| value.control < 45.0)
            .unwrap_or(false)
        && n >= 5
    {
        if is_tracking {
            push_unique_scenario_card(
                &mut cards,
                "Overshooting Your Targets",
                "Tracking Control",
                "#00b4ff",
                format!(
                    "Your control score is {:.0}/100, indicating you frequently swing past or overshoot the target. In tracking, overshooting breaks continuous contact and forces a recovery — those recovery gaps are where you bleed score.",
                    fingerprint.map(|value| value.control).unwrap_or(0.0)
                ),
                "Try micro-pressure drills: maintain the lightest possible grip and focus on matching the target's speed exactly rather than chasing it. Think of it as escorting the target, not hunting it.".to_string(),
            );
        } else {
            push_unique_scenario_card(
                &mut cards,
                "Speed-Accuracy Tradeoff",
                "Biomechanics",
                "#00b4ff",
                format!(
                    "Your control score is {:.0}/100, indicating frequent overshoot. You are currently on the speed-dominant side of the speed-accuracy tradeoff.",
                    fingerprint.map(|value| value.control).unwrap_or(0.0)
                ),
                "Practice deceleration drills: flick toward a target but consciously brake 20-30% before the target. The cursor should arrive on the target, not blow past it.".to_string(),
            );
        }
    }

    if let Some(fingerprint) = fingerprint {
        if fingerprint.rhythm < 40.0 {
            if is_tracking {
                push_unique_scenario_card(
                    &mut cards,
                    "Choppy Tracking Speed",
                    "Flow Training",
                    "#a78bfa",
                    format!(
                        "Your flow score is {:.0}/100 — your cursor speed is uneven across the target's movement. Choppy speed means you're constantly accelerating and braking, which leads to brief off-target moments and reduces your score window.",
                        fingerprint.rhythm
                    ),
                    "Run a slow, large-target tracking scenario with no time pressure. Focus only on keeping your cursor speed constant and even across the full path.".to_string(),
                );
            } else {
                push_unique_scenario_card(
                    &mut cards,
                    "Inconsistent Click Timing",
                    "Rhythm Training",
                    "#a78bfa",
                    format!(
                        "Your rhythm score is {:.0}/100 — click timing varies significantly between shots. Timing variation often means hesitating before each shot, which adds avoidable latency.",
                        fingerprint.rhythm
                    ),
                    "Use click timing scenarios for a short block and build a consistent acquire -> commit -> click rhythm without a hesitation gap between commit and click.".to_string(),
                );
            }
        }

        if !is_tracking && fingerprint.control_volatility >= 42.0 {
            push_unique_scenario_card(
                &mut cards,
                "Overshoot Bursts, Not Constant Drift",
                "Volatility",
                "#ff9f43",
                format!(
                    "The bigger issue is volatility: control swings {:.0}/100 across recent sessions. Some runs are clean while others contain short overshoot bursts that erase otherwise good pacing.",
                    fingerprint.control_volatility
                ),
                "Use one repeatable entry cue for every serious run: same grip pressure, same pre-shot deceleration, same first target commitment.".to_string(),
            );
        }

        if !is_tracking && fingerprint.rhythm_volatility >= 44.0 {
            push_unique_scenario_card(
                &mut cards,
                "Hesitation Spikes Between Shots",
                "Commitment",
                "#ffd700",
                format!(
                    "Your click rhythm is swingy from run to run ({:.0}/100 volatility). That pattern usually means hesitation appears in pockets where target confirmation becomes uncertain.",
                    fingerprint.rhythm_volatility
                ),
                "Practice a fixed commit rule for one block: once the crosshair enters the acceptable target zone, fire immediately.".to_string(),
            );
        }

        if is_tracking && fingerprint.consistency_volatility >= 40.0 {
            push_unique_scenario_card(
                &mut cards,
                "Tracking Stability Swings",
                "Endurance",
                "#a78bfa",
                format!(
                    "Your tracking consistency changes sharply across recent sessions ({:.0}/100 volatility). Contact quality is good when fresh but degrades once reactivity or fatigue ramps up.",
                    fingerprint.consistency_volatility
                ),
                "Add one endurance rep at the end of each block where the goal is not score, but keeping cursor speed smooth for the full run.".to_string(),
            );
        }

        if is_tracking && n >= 5 && fingerprint.decisiveness < 50.0 {
            push_unique_scenario_card(
                &mut cards,
                "Reacting Instead of Predicting",
                "Tracking Skill",
                "#ff9f43",
                format!(
                    "Your decisiveness score ({:.0}/100) suggests you're chasing targets reactively — your cursor follows behind rather than leading.",
                    fingerprint.decisiveness
                ),
                "In your next session, consciously try to lead the target by a tiny amount. Start with scenarios using consistent target paths before applying it to erratic ones.".to_string(),
            );
        }

        if fingerprint.precision < 50.0 && n >= 3 {
            push_unique_scenario_card(
                &mut cards,
                "Wrist Stability & Path Efficiency",
                "Biomechanics",
                "#ff9f43",
                format!(
                    "Your precision score is {:.0}/100, suggesting curved or erratic cursor paths. This typically indicates forearm or wrist tension, a too-tight grip, or sensitivity that is high relative to your setup.",
                    fingerprint.precision
                ),
                "Try a loose-grip drill for a few minutes. This forces arm-driven movement instead of constant wrist micro-corrections and helps reduce micro-tremor.".to_string(),
            );
        }
    }

    if slope > avg_score * 0.005 && n >= 10 {
        let sessions_to_next = ((avg_score * 0.1) / slope).round() as i64;
        if sessions_to_next > 0 && sessions_to_next < 150 {
            push_unique_scenario_card(
                &mut cards,
                "Active Improvement Phase",
                "Motor Learning",
                "#00f5a0",
                format!(
                    "You're gaining about {} points per session. Improvement usually slows as skill rises, but right now you're still in a strong growth phase.",
                    slope.round() as i64
                ),
                format!(
                    "At this rate you'd reach about +10% of your current average in ~{} more sessions. To sustain the pace, incrementally increase scenario difficulty rather than grinding at the same challenge level.",
                    sessions_to_next
                ),
            );
        }
    }

    if let Some(practice_profile) = practice_profile {
        if practice_profile.session_count >= 8 && !is_plateau {
            let dominant_pct = practice_profile.dominant_scenario_share * 100.0;
            let blocked_pattern = practice_profile.dominant_scenario_share >= 0.72
                && practice_profile.avg_unique_scenarios_per_block < 2.0;
            let interleaved_pattern = practice_profile.avg_unique_scenarios_per_block >= 2.5
                && practice_profile.switch_rate >= 0.3;
            if blocked_pattern {
                push_unique_scenario_card(
                    &mut cards,
                    "Blocked Practice Bias",
                    "Skill Transfer",
                    "#a78bfa",
                    format!(
                        "{dominant_pct:.0}% of your last {} reliable runs were {}, and most practice blocks stay on about {:.1} scenario. That usually feels smooth in the moment, but mixing in a contrast scenario tends to build stronger carryover.",
                        practice_profile.session_count,
                        practice_profile.dominant_scenario,
                        practice_profile.avg_unique_scenarios_per_block
                    ),
                    if is_tracking {
                        "Keep your main tracking scenario, but after every 2-3 serious runs insert one contrasting clicking or precision scenario. Expect same-day scores to feel worse at first; the point is stronger retention when you come back.".to_string()
                    } else {
                        "Keep your main click scenario, but after every 2-3 serious runs insert one smooth tracking scenario. That extra retrieval cost is the part that improves transfer.".to_string()
                    },
                );
            } else if interleaved_pattern {
                push_unique_scenario_card(
                    &mut cards,
                    "Interleaving Is Working",
                    "Skill Transfer",
                    "#00f5a0",
                    format!(
                        "Your recent blocks average {:.1} scenarios, and you switch on about {}% of runs inside a block. That is enough variety to challenge you without turning practice into chaos.",
                        practice_profile.avg_unique_scenarios_per_block,
                        (practice_profile.switch_rate * 100.0).round()
                    ),
                    "Judge this by next-day quality and in-game carryover, not only by whether every switch gives you an instant PB. A little variety often feels harder in the moment, but pays off later.".to_string(),
                );
            } else {
                push_unique_scenario_card(
                    &mut cards,
                    "Add One Contrast Scenario",
                    "Skill Transfer",
                    "#a78bfa",
                    format!(
                        "You have some variety ({} scenarios across recent practice), but most blocks still revolve around one main task. That is a better base than pure grinding, yet probably not enough interference to maximize transfer.",
                        practice_profile.scenario_diversity
                    ),
                    if is_tracking {
                        "Upgrade one block each session into a simple triangle: tracking main set -> clicking contrast set -> tracking return set.".to_string()
                    } else {
                        "Upgrade one block each session into flicking main set -> tracking contrast set -> flicking return set.".to_string()
                    },
                );
            }
        }
    }

    for card in &mut cards {
        card.drills = drill_recommendations_for_card(&card.title, scenario_type);
    }
    cards.truncate(7);
    cards
}

fn family_balance_score(
    dominant_family_share_pct: Option<f64>,
    diversity: Option<f64>,
) -> Option<f64> {
    let share = dominant_family_share_pct?;
    let diversity_boost = diversity
        .map(|value| clamp_number((value - 2.0) * 8.0, 0.0, 20.0))
        .unwrap_or(0.0);
    Some(clamp_number(
        100.0 - (share - 35.0).max(0.0) * 1.4 + diversity_boost,
        0.0,
        100.0,
    ))
}

fn derive_global_coaching_learning_state(
    records: &[AnalyticsRecord],
    practice_profile: Option<&PracticeProfileSnapshot>,
    warmup_ids: &HashSet<String>,
) -> Option<GlobalCoachingLearningState> {
    let reliable_sorted = records
        .iter()
        .filter(|record| record.is_reliable_for_analysis)
        .cloned()
        .collect::<Vec<_>>();
    if reliable_sorted.len() < 6 {
        return None;
    }
    let normalized_signals = build_normalized_session_signals(&reliable_sorted);
    if normalized_signals.len() < 6 {
        return None;
    }
    let settled_signals = normalized_signals
        .iter()
        .filter(|entry| !warmup_ids.contains(&entry.record.record.id))
        .cloned()
        .collect::<Vec<_>>();
    let warmup_signals = normalized_signals
        .iter()
        .filter(|entry| warmup_ids.contains(&entry.record.record.id))
        .cloned()
        .collect::<Vec<_>>();

    let mut family_counts = HashMap::<String, u32>::new();
    for entry in &normalized_signals {
        if entry.baseline.scenario_type != "Unknown" {
            *family_counts
                .entry(entry.baseline.scenario_type.clone())
                .or_default() += 1;
        }
    }
    let mut family_entries = family_counts.into_iter().collect::<Vec<_>>();
    family_entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let total_family_runs = family_entries
        .iter()
        .map(|(_, count)| *count as f64)
        .sum::<f64>();
    let dominant_family = family_entries.first().map(|(family, _)| family.clone());
    let dominant_family_share_pct = dominant_family.as_ref().and_then(|_| {
        family_entries
            .first()
            .map(|(_, count)| (*count as f64 / total_family_runs) * 100.0)
    });

    let normalized_values = settled_signals
        .iter()
        .map(|entry| entry.normalized_score)
        .collect::<Vec<_>>();
    let normalized_variance_pct = if normalized_values.len() >= 2 {
        Some((stddev(&normalized_values) / mean(&normalized_values).max(0.0001)) * 100.0)
    } else {
        None
    };

    let warmup_tax_pct = if warmup_signals.len() >= 3 && settled_signals.len() >= 5 {
        let settled_avg = mean(
            &settled_signals
                .iter()
                .map(|entry| entry.normalized_score)
                .collect::<Vec<_>>(),
        );
        let warmup_avg = mean(
            &warmup_signals
                .iter()
                .map(|entry| entry.normalized_score)
                .collect::<Vec<_>>(),
        );
        Some(((settled_avg - warmup_avg) / settled_avg.max(0.0001)) * 100.0)
    } else {
        None
    };

    #[derive(Clone)]
    struct NormalizedBlockRecord {
        record: AnalyticsRecord,
        normalized_score: f64,
    }
    let normalized_block_records = settled_signals
        .iter()
        .map(|entry| NormalizedBlockRecord {
            record: entry.record.clone(),
            normalized_score: entry.normalized_score,
        })
        .collect::<Vec<_>>();
    let mut blocks = Vec::<Vec<NormalizedBlockRecord>>::new();
    if let Some(first) = normalized_block_records.first() {
        let mut current = vec![first.clone()];
        for pair in normalized_block_records.windows(2) {
            let gap = pair[1].record.timestamp_ms - pair[0].record.timestamp_ms;
            if gap > BLOCK_GAP_MS {
                blocks.push(current);
                current = vec![pair[1].clone()];
            } else {
                current.push(pair[1].clone());
            }
        }
        blocks.push(current);
    }

    let mut block_fade_pcts = Vec::new();
    let mut switched_scores = Vec::new();
    let mut repeated_scores = Vec::new();
    let mut retention_scores = Vec::new();
    for (block_index, block) in blocks.iter().enumerate() {
        let block_minutes = block
            .iter()
            .map(|session| session.record.record.duration_secs.max(0.0))
            .sum::<f64>()
            / 60.0;
        if block.len() >= 4 && block_minutes >= 12.0 {
            let early_avg = mean(
                &block
                    .iter()
                    .take(block.len().min(2))
                    .map(|session| session.normalized_score)
                    .collect::<Vec<_>>(),
            );
            let late_avg = mean(
                &block
                    .iter()
                    .rev()
                    .take(block.len().min(2))
                    .map(|session| session.normalized_score)
                    .collect::<Vec<_>>(),
            );
            if early_avg > 0.0 {
                block_fade_pcts.push(((early_avg - late_avg) / early_avg) * 100.0);
            }
        }
        for pair in block.windows(2) {
            if pair[0].record.normalized_scenario != pair[1].record.normalized_scenario {
                switched_scores.push(pair[1].normalized_score);
            } else {
                repeated_scores.push(pair[1].normalized_score);
            }
        }
        if block_index > 0 {
            let previous_block = &blocks[block_index - 1];
            let gap_before_ms = block
                .first()
                .map(|entry| entry.record.timestamp_ms)
                .unwrap_or(0)
                - previous_block
                    .last()
                    .map(|entry| entry.record.timestamp_ms)
                    .unwrap_or(0);
            if gap_before_ms >= 12 * 60 * 60 * 1000 {
                let previous_avg = mean(
                    &previous_block
                        .iter()
                        .rev()
                        .take(previous_block.len().min(2))
                        .map(|session| session.normalized_score)
                        .collect::<Vec<_>>(),
                );
                let next_avg = mean(
                    &block
                        .iter()
                        .take(block.len().min(2))
                        .map(|session| session.normalized_score)
                        .collect::<Vec<_>>(),
                );
                if previous_avg > 0.0 {
                    retention_scores.push((next_avg / previous_avg) * 100.0);
                }
            }
        }
    }

    let switch_penalty_pct = if switched_scores.len() >= 6 && repeated_scores.len() >= 6 {
        Some(
            ((mean(&repeated_scores) - mean(&switched_scores))
                / mean(&repeated_scores).max(0.0001))
                * 100.0,
        )
    } else {
        None
    };
    let avg_block_fade_pct = (block_fade_pcts.len() >= 2).then(|| mean(&block_fade_pcts));
    let retention_after_gap_pct = (retention_scores.len() >= 2).then(|| mean(&retention_scores));
    let settled_values = settled_signals
        .iter()
        .map(|entry| entry.normalized_score)
        .collect::<Vec<_>>();
    let momentum_delta_pct = if settled_values.len() >= 8 {
        let window = (settled_values.len() / 3).max(4).min(8);
        let recent = settled_values[settled_values.len() - window..].to_vec();
        let older = settled_values
            [settled_values.len().saturating_sub(window * 2)..settled_values.len() - window]
            .to_vec();
        (older.len() == window && recent.len() == window)
            .then(|| ((mean(&recent) - mean(&older)) / mean(&older).max(0.0001)) * 100.0)
    } else {
        None
    };

    Some(GlobalCoachingLearningState {
        sample_count: normalized_signals.len() as u32,
        settled_sample_count: settled_signals.len() as u32,
        warmup_sample_count: warmup_signals.len() as u32,
        normalized_variance_pct,
        warmup_tax_pct,
        avg_block_fade_pct,
        switch_penalty_pct,
        momentum_delta_pct,
        retention_after_gap_pct,
        dominant_family,
        dominant_family_share_pct,
        family_diversity: practice_profile
            .map(|profile| profile.scenario_diversity)
            .unwrap_or_else(|| family_entries.len() as u32),
    })
}

fn derive_behavior_pattern_features(
    records: &[AnalyticsRecord],
    practice_profile: Option<&PracticeProfileSnapshot>,
    warmup_ids: &HashSet<String>,
    target_response_summaries: &HashMap<
        String,
        crate::target_response::TargetResponseSummaryRecord,
    >,
) -> Option<BehaviorPatternFeatures> {
    let learning_state =
        derive_global_coaching_learning_state(records, practice_profile, warmup_ids)?;
    let reliable_sorted = records
        .iter()
        .filter(|record| record.is_reliable_for_analysis)
        .cloned()
        .collect::<Vec<_>>();
    if reliable_sorted.len() < 6 {
        return None;
    }
    let recent = reliable_sorted[reliable_sorted.len().saturating_sub(36)..].to_vec();
    let warmup_signals = build_normalized_session_signals(&reliable_sorted)
        .into_iter()
        .filter(|entry| warmup_ids.contains(&entry.record.record.id))
        .map(|entry| entry.normalized_score)
        .collect::<Vec<_>>();
    let warmup_consistency_pct = if warmup_signals.len() >= 3 {
        Some(clamp_number(
            100.0 - (stddev(&warmup_signals) / mean(&warmup_signals).max(0.0001)) * 100.0,
            0.0,
            100.0,
        ))
    } else {
        None
    };

    let correction_load_pct = mean_defined(recent.iter().map(|record| {
        record
            .record
            .shot_timing
            .as_ref()
            .and_then(|timing| timing.avg_shots_to_hit.map(|value| value as f64))
    }))
    .map(|avg| clamp_number((avg - 1.0).max(0.0) * 100.0, 0.0, 100.0));

    let hesitation_load_pct = mean_defined(recent.iter().map(|record| {
        record
            .record
            .shot_timing
            .as_ref()
            .and_then(|timing| timing.avg_fire_to_hit_ms.map(|value| value as f64))
    }))
    .map(|avg| clamp_number(((avg - 120.0) / 420.0) * 100.0, 0.0, 100.0));

    let smooth_records = recent
        .iter()
        .filter(|record| record.record.smoothness.is_some())
        .collect::<Vec<_>>();
    let control_pct = if smooth_records.len() >= 4 {
        let composite = mean_defined(smooth_records.iter().map(|record| {
            record
                .record
                .smoothness
                .as_ref()
                .map(|value| value.composite as f64)
        }))
        .unwrap_or(50.0);
        let path_eff = mean_defined(smooth_records.iter().map(|record| {
            record
                .record
                .smoothness
                .as_ref()
                .map(|value| value.path_efficiency as f64 * 100.0)
        }))
        .unwrap_or(50.0);
        let correction_penalty = mean_defined(smooth_records.iter().map(|record| {
            record
                .record
                .smoothness
                .as_ref()
                .map(|value| value.correction_ratio as f64 * 100.0)
        }))
        .unwrap_or(30.0);
        let jitter_penalty = clamp_number(
            mean_defined(smooth_records.iter().map(|record| {
                record
                    .record
                    .smoothness
                    .as_ref()
                    .map(|value| value.jitter as f64)
            }))
            .unwrap_or(0.15)
                * 180.0,
            0.0,
            100.0,
        );
        Some(clamp_number(
            composite * 0.45
                + path_eff * 0.3
                + (100.0 - correction_penalty) * 0.15
                + (100.0 - jitter_penalty) * 0.1,
            0.0,
            100.0,
        ))
    } else {
        None
    };

    let precision_pct = {
        let accuracy_mean = mean_defined(recent.iter().map(|record| {
            normalize_accuracy_pct(
                record
                    .record
                    .stats_panel
                    .as_ref()
                    .and_then(|panel| panel.accuracy_pct.map(|value| value as f64))
                    .or(Some(record.record.accuracy)),
                None,
                None,
            )
        }));
        let conversion_pct =
            correction_load_pct.map(|value| clamp_number(100.0 - value, 0.0, 100.0));
        match (accuracy_mean, conversion_pct) {
            (None, None) => None,
            _ => Some(clamp_number(
                accuracy_mean.unwrap_or(82.0) * 0.65 + conversion_pct.unwrap_or(55.0) * 0.35,
                0.0,
                100.0,
            )),
        }
    };

    let settled_signals = build_normalized_session_signals(&reliable_sorted)
        .into_iter()
        .filter(|entry| !warmup_ids.contains(&entry.record.record.id))
        .collect::<Vec<_>>();
    let tempo_pct = if settled_signals.len() >= 5 {
        let tail = settled_signals[settled_signals.len().saturating_sub(12)..]
            .iter()
            .map(|entry| entry.normalized_score)
            .collect::<Vec<_>>();
        Some(clamp_number(50.0 + (mean(&tail) - 1.0) * 80.0, 0.0, 100.0))
    } else {
        None
    };

    let readiness_pct = {
        let warmup_penalty = learning_state
            .warmup_tax_pct
            .map(|value| clamp_number(100.0 - value * 9.0, 0.0, 100.0));
        match (warmup_penalty, warmup_consistency_pct) {
            (None, None) => None,
            _ => Some(clamp_number(
                warmup_penalty.unwrap_or(55.0) * 0.7 + warmup_consistency_pct.unwrap_or(55.0) * 0.3,
                0.0,
                100.0,
            )),
        }
    };
    let switch_resilience_pct = learning_state
        .switch_penalty_pct
        .map(|value| clamp_number(100.0 - value * 10.0, 0.0, 100.0));
    let retained_form_pct = learning_state
        .retention_after_gap_pct
        .map(|value| clamp_number(value, 0.0, 100.0));
    let fatigue_pressure_pct = {
        let fade_pressure = learning_state.avg_block_fade_pct.map(|value| value * 12.0);
        let block_pressure = practice_profile
            .map(|profile| (profile.avg_block_minutes - 32.0).max(0.0) * 1.2)
            .unwrap_or(0.0);
        match (fade_pressure, block_pressure > 0.0) {
            (None, false) => None,
            _ => Some(clamp_number(
                fade_pressure.unwrap_or(0.0) + block_pressure,
                0.0,
                100.0,
            )),
        }
    };
    let endurance_pct = fatigue_pressure_pct.map(|value| clamp_number(100.0 - value, 0.0, 100.0));
    let consistency_pct = learning_state
        .normalized_variance_pct
        .map(|value| clamp_number(100.0 - value * 5.0, 0.0, 100.0));
    let target_response = build_target_response_aggregate(&recent, target_response_summaries);
    let reaction_pct = target_response
        .as_ref()
        .and_then(|aggregate| aggregate.avg_reaction_time_ms)
        .map(|value| inverse_range_score(value, 95.0, 320.0));
    let anticipation_pct = target_response
        .as_ref()
        .and_then(|aggregate| aggregate.avg_pre_slowdown_reaction_ms)
        .map(|value| inverse_range_score(value, 85.0, 260.0));
    let stable_response_pct = target_response
        .as_ref()
        .and_then(|aggregate| aggregate.stable_response_ratio)
        .map(|value| clamp_number(value * 100.0, 0.0, 100.0));
    let stabilization_pct = match (
        target_response
            .as_ref()
            .and_then(|aggregate| aggregate.avg_recovery_time_ms)
            .map(|value| inverse_range_score(value, 170.0, 760.0)),
        stable_response_pct,
    ) {
        (None, None) => None,
        _ => Some(clamp_number(
            target_response
                .as_ref()
                .and_then(|aggregate| aggregate.avg_recovery_time_ms)
                .map(|value| inverse_range_score(value, 170.0, 760.0))
                .unwrap_or(50.0)
                * 0.7
                + stable_response_pct.unwrap_or(50.0) * 0.3,
            0.0,
            100.0,
        )),
    };
    let transfer_pct = {
        let family_balance_pct = family_balance_score(
            learning_state.dominant_family_share_pct,
            Some(learning_state.family_diversity as f64),
        );
        match (family_balance_pct, switch_resilience_pct, retained_form_pct) {
            (None, None, None) => None,
            _ => Some(clamp_number(
                family_balance_pct.unwrap_or(50.0) * 0.35
                    + switch_resilience_pct.unwrap_or(50.0) * 0.35
                    + retained_form_pct.unwrap_or(50.0) * 0.3,
                0.0,
                100.0,
            )),
        }
    };
    let adaptation_pct = match (readiness_pct, switch_resilience_pct, retained_form_pct) {
        (None, None, None) => None,
        _ => Some(clamp_number(
            readiness_pct.unwrap_or(50.0) * 0.35
                + switch_resilience_pct.unwrap_or(50.0) * 0.45
                + retained_form_pct.unwrap_or(50.0) * 0.2,
            0.0,
            100.0,
        )),
    };
    let learning_efficiency_pct = Some(clamp_number(
        50.0 + learning_state.momentum_delta_pct.unwrap_or(0.0) * 6.0
            + (retained_form_pct.unwrap_or(95.0) - 95.0) * 1.8
            - practice_profile
                .map(|profile| (profile.avg_block_minutes - 35.0).max(0.0) * 0.8)
                .unwrap_or(0.0),
        0.0,
        100.0,
    ));

    Some(BehaviorPatternFeatures {
        sample_count: learning_state.sample_count,
        settled_sample_count: learning_state.settled_sample_count,
        warmup_consistency_pct,
        readiness_pct,
        adaptation_pct,
        endurance_pct,
        transfer_pct,
        precision_pct,
        control_pct,
        consistency_pct,
        learning_efficiency_pct,
        tempo_pct,
        switch_resilience_pct,
        retained_form_pct,
        fatigue_pressure_pct,
        correction_load_pct,
        hesitation_load_pct,
        reaction_pct,
        anticipation_pct,
        stabilization_pct,
        stable_response_pct,
        volatility_pct: learning_state.normalized_variance_pct,
        momentum_pct: learning_state.momentum_delta_pct,
        precision_tempo_bias_pct: match (precision_pct, tempo_pct) {
            (Some(precision), Some(tempo)) => Some(clamp_number(precision - tempo, -100.0, 100.0)),
            _ => None,
        },
    })
}

fn describe_axis(key: &str, value_pct: f64) -> String {
    match key {
        "readiness" => {
            if value_pct >= 60.0 {
                "You settle into useful reps quickly instead of donating many runs to warm-up."
                    .to_string()
            } else {
                "Opening runs are still paying a noticeable readiness tax before quality stabilizes.".to_string()
            }
        }
        "adaptation" => {
            if value_pct >= 60.0 {
                "Your form travels reasonably well when the task changes.".to_string()
            } else {
                "Context changes are still expensive and cost you quality after switches."
                    .to_string()
            }
        }
        "endurance" => {
            if value_pct >= 60.0 {
                "You hold useful quality deep enough into blocks to train with intent.".to_string()
            } else {
                "Late-block quality is fading before the work is really finished.".to_string()
            }
        }
        "transfer" => {
            if value_pct >= 60.0 {
                "Recent practice is giving you carryover beyond one favorite scenario.".to_string()
            } else {
                "Practice is still a bit too narrow or too reset-heavy to maximize carryover."
                    .to_string()
            }
        }
        "precision" => {
            if value_pct >= 60.0 {
                "Hit quality and shot conversion are a reliable asset.".to_string()
            } else {
                "Accuracy and shot conversion are leaking too much value.".to_string()
            }
        }
        "recognition" => {
            if value_pct >= 60.0 {
                "You recognize target-path changes quickly enough to stay proactive.".to_string()
            } else {
                "Large target changes are still being recognized a little too late.".to_string()
            }
        }
        "stabilization" => {
            if value_pct >= 60.0 {
                "After a change, you usually settle back onto the correct line efficiently."
                    .to_string()
            } else {
                "Recovery after the first correction is still costing more time than it should."
                    .to_string()
            }
        }
        "control" => {
            if value_pct >= 60.0 {
                "Your movement foundation is supporting cleaner reps.".to_string()
            } else {
                "Cursor control and correction load are still asking for cleanup.".to_string()
            }
        }
        "consistency" => {
            if value_pct >= 60.0 {
                "Execution is fairly stable once a block settles.".to_string()
            } else {
                "Performance swings are still wider than your underlying skill should require."
                    .to_string()
            }
        }
        "learning" => {
            if value_pct >= 60.0 {
                "Recent practice is converting into sticky, reusable progress.".to_string()
            } else {
                "Volume is not yet turning into retained progress efficiently enough.".to_string()
            }
        }
        _ => {
            if value_pct >= 60.0 {
                "This is currently helping your overall progress.".to_string()
            } else {
                "This is currently limiting your overall progress.".to_string()
            }
        }
    }
}

fn build_player_learning_profile(
    records: &[AnalyticsRecord],
    practice_profile: Option<&PracticeProfileSnapshot>,
    warmup_ids: &HashSet<String>,
    target_response_summaries: &HashMap<
        String,
        crate::target_response::TargetResponseSummaryRecord,
    >,
    generated_at_ms: u64,
) -> Option<PlayerLearningProfile> {
    let features = derive_behavior_pattern_features(
        records,
        practice_profile,
        warmup_ids,
        target_response_summaries,
    )?;
    let reliable_sorted = records
        .iter()
        .filter(|record| record.is_reliable_for_analysis)
        .cloned()
        .collect::<Vec<_>>();
    if reliable_sorted.len() < 6 {
        return None;
    }

    let mut axes = vec![
        (
            "readiness",
            "Readiness",
            features.readiness_pct.unwrap_or(50.0),
        ),
        (
            "adaptation",
            "Adaptation",
            features.adaptation_pct.unwrap_or(50.0),
        ),
        (
            "endurance",
            "Endurance",
            features.endurance_pct.unwrap_or(50.0),
        ),
        (
            "transfer",
            "Transfer",
            features.transfer_pct.unwrap_or(50.0),
        ),
        (
            "precision",
            "Precision",
            features.precision_pct.unwrap_or(50.0),
        ),
        (
            "recognition",
            "Recognition",
            match (features.reaction_pct, features.anticipation_pct) {
                (None, None) => 50.0,
                _ => {
                    features.reaction_pct.unwrap_or(50.0) * 0.55
                        + features.anticipation_pct.unwrap_or(50.0) * 0.45
                }
            },
        ),
        (
            "stabilization",
            "Stabilization",
            features.stabilization_pct.unwrap_or(50.0),
        ),
        ("control", "Control", features.control_pct.unwrap_or(50.0)),
        (
            "consistency",
            "Consistency",
            features.consistency_pct.unwrap_or(50.0),
        ),
        (
            "learning",
            "Learning",
            features.learning_efficiency_pct.unwrap_or(50.0),
        ),
    ]
    .into_iter()
    .map(|(key, label, value_pct)| PlayerLearningAxis {
        key: key.to_string(),
        label: label.to_string(),
        value_pct,
        detail: describe_axis(key, value_pct),
    })
    .collect::<Vec<_>>();
    axes.sort_by(|a, b| {
        b.value_pct
            .partial_cmp(&a.value_pct)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let strengths = axes
        .iter()
        .filter(|axis| axis.value_pct >= 58.0)
        .take(3)
        .map(|axis| PlayerLearningSignal {
            key: axis.key.clone(),
            label: axis.label.clone(),
            detail: axis.detail.clone(),
            value_pct: Some(axis.value_pct),
        })
        .collect::<Vec<_>>();
    let constraints = axes
        .iter()
        .rev()
        .filter(|axis| axis.value_pct <= 52.0)
        .take(3)
        .map(|axis| PlayerLearningSignal {
            key: axis.key.clone(),
            label: axis.label.clone(),
            detail: axis.detail.clone(),
            value_pct: Some(axis.value_pct),
        })
        .collect::<Vec<_>>();
    let focus_area = constraints.first().cloned().or_else(|| {
        axes.iter()
            .min_by(|a, b| a.value_pct.partial_cmp(&b.value_pct).unwrap())
            .map(|axis| PlayerLearningSignal {
                key: axis.key.clone(),
                label: axis.label.clone(),
                detail: axis.detail.clone(),
                value_pct: Some(axis.value_pct),
            })
    });
    let top_strength = strengths.first().cloned().or_else(|| {
        axes.first().map(|axis| PlayerLearningSignal {
            key: axis.key.clone(),
            label: axis.label.clone(),
            detail: axis.detail.clone(),
            value_pct: Some(axis.value_pct),
        })
    });
    let summary = if let (Some(top_strength), Some(focus_area)) =
        (top_strength.as_ref(), focus_area.as_ref())
    {
        format!(
            "{} is currently your steadiest global asset, while {} is the cleanest bottleneck to attack next.",
            top_strength.label, focus_area.label
        )
    } else {
        "The current coaching model has enough data to describe broad learning tendencies, but not enough contrast yet for a sharp next target.".to_string()
    };

    let mut metrics = HashMap::new();
    metrics.insert("readinessPct".to_string(), features.readiness_pct);
    metrics.insert("adaptationPct".to_string(), features.adaptation_pct);
    metrics.insert("endurancePct".to_string(), features.endurance_pct);
    metrics.insert("transferPct".to_string(), features.transfer_pct);
    metrics.insert("precisionPct".to_string(), features.precision_pct);
    metrics.insert("reactionPct".to_string(), features.reaction_pct);
    metrics.insert("anticipationPct".to_string(), features.anticipation_pct);
    metrics.insert("stabilizationPct".to_string(), features.stabilization_pct);
    metrics.insert(
        "stableResponsePct".to_string(),
        features.stable_response_pct,
    );
    metrics.insert("controlPct".to_string(), features.control_pct);
    metrics.insert("consistencyPct".to_string(), features.consistency_pct);
    metrics.insert(
        "learningEfficiencyPct".to_string(),
        features.learning_efficiency_pct,
    );
    metrics.insert("tempoPct".to_string(), features.tempo_pct);
    metrics.insert(
        "switchResiliencePct".to_string(),
        features.switch_resilience_pct,
    );
    metrics.insert("retainedFormPct".to_string(), features.retained_form_pct);
    metrics.insert(
        "fatiguePressurePct".to_string(),
        features.fatigue_pressure_pct,
    );
    metrics.insert(
        "correctionLoadPct".to_string(),
        features.correction_load_pct,
    );
    metrics.insert(
        "hesitationLoadPct".to_string(),
        features.hesitation_load_pct,
    );
    metrics.insert("volatilityPct".to_string(), features.volatility_pct);
    metrics.insert("momentumPct".to_string(), features.momentum_pct);
    metrics.insert(
        "warmupConsistencyPct".to_string(),
        features.warmup_consistency_pct,
    );
    metrics.insert(
        "precisionTempoBiasPct".to_string(),
        features.precision_tempo_bias_pct,
    );

    Some(PlayerLearningProfile {
        generated_at_ms,
        sample_count: features.sample_count,
        settled_sample_count: features.settled_sample_count,
        coverage_start_ms: reliable_sorted
            .first()
            .map(|record| record.timestamp_ms.max(0) as u64),
        coverage_end_ms: reliable_sorted
            .last()
            .map(|record| record.timestamp_ms.max(0) as u64),
        summary,
        focus_area_key: focus_area.as_ref().map(|signal| signal.key.clone()),
        focus_area_label: focus_area.as_ref().map(|signal| signal.label.clone()),
        dominant_constraint_key: focus_area.as_ref().map(|signal| signal.key.clone()),
        strengths,
        constraints,
        axes,
        metrics,
    })
}

fn contrast_plan_for_scenario_family(scenario_type: &str) -> Vec<DrillRecommendation> {
    let list = if scenario_type == "PureTracking" || scenario_type.contains("Tracking") {
        vec![
            ("Pasu", "Pasu"),
            ("1w4ts", "1w4ts"),
            ("Floating Heads", "Floating Heads"),
        ]
    } else if matches!(
        scenario_type,
        "StaticClicking"
            | "OneShotClicking"
            | "DynamicClicking"
            | "MovingClicking"
            | "ReactiveClicking"
            | "TargetSwitching"
            | "MultiHitClicking"
    ) {
        vec![
            ("Smoothbot", "Smoothbot"),
            ("Air", "Air"),
            ("Centering", "Centering"),
        ]
    } else if scenario_type == "AccuracyDrill" {
        vec![
            ("Microshot", "Microshot"),
            ("Tile Frenzy", "Tile Frenzy"),
            ("1wall 6targets", "1wall 6targets"),
        ]
    } else {
        vec![
            ("Smoothbot", "Smoothbot"),
            ("Pasu", "Pasu"),
            ("Microshot", "Microshot"),
        ]
    };
    list.into_iter()
        .map(|(label, query)| DrillRecommendation {
            label: label.to_string(),
            query: query.to_string(),
        })
        .collect()
}

fn preferences_from_settings(app: &AppHandle) -> CoachingUserPreferences {
    let settings = settings::load(app).unwrap_or_else(|_| settings::load_default());
    CoachingUserPreferences {
        focus_area: settings.coaching_focus_area,
        challenge_preference: settings.coaching_challenge_preference,
        time_preference: settings.coaching_time_preference,
    }
}

fn card_has_any_signal(card: &CoachingCardData, candidates: &[&str]) -> bool {
    candidates
        .iter()
        .any(|candidate| card.signals.iter().any(|signal| signal == candidate))
}

fn preference_weight(card: &CoachingCardData, preferences: &CoachingUserPreferences) -> i32 {
    let mut weight = 0;
    match preferences.focus_area.as_str() {
        "precision"
            if card_has_any_signal(
                card,
                &["correction_load", "precision_balance", "hesitation_load"],
            ) =>
        {
            weight += 4
        }
        "speed"
            if card_has_any_signal(
                card,
                &[
                    "hesitation_load",
                    "momentum",
                    "cross_scenario_transfer",
                    "precision_balance",
                    "reaction_latency",
                    "anticipation_latency",
                ],
            ) =>
        {
            weight += 4
        }
        "control"
            if card_has_any_signal(
                card,
                &[
                    "control_foundation",
                    "correction_load",
                    "execution_consistency",
                    "recovery_time",
                    "stabilization",
                ],
            ) =>
        {
            weight += 4
        }
        "consistency"
            if card_has_any_signal(
                card,
                &[
                    "normalized_variance",
                    "warmup_tax",
                    "practice_spacing",
                    "block_fade",
                ],
            ) =>
        {
            weight += 4
        }
        "endurance"
            if card_has_any_signal(
                card,
                &[
                    "block_fade",
                    "fatigue_pattern",
                    "practice_spacing",
                    "endurance_strength",
                ],
            ) =>
        {
            weight += 4
        }
        "transfer"
            if card_has_any_signal(
                card,
                &[
                    "family_balance",
                    "switch_penalty",
                    "retention_after_gap",
                    "cross_scenario_transfer",
                ],
            ) =>
        {
            weight += 4
        }
        _ => {}
    }
    match preferences.challenge_preference.as_str() {
        "steady" => {
            if card_has_any_signal(
                card,
                &[
                    "warmup_tax",
                    "correction_load",
                    "normalized_variance",
                    "practice_spacing",
                ],
            ) {
                weight += 2;
            }
            if card_has_any_signal(card, &["momentum", "cross_scenario_transfer"])
                && !card_has_any_signal(card, &["global_form_drop"])
            {
                weight -= 1;
            }
        }
        "aggressive" => {
            if card_has_any_signal(
                card,
                &[
                    "momentum",
                    "cross_scenario_transfer",
                    "precision_balance",
                    "context_adaptation",
                ],
            ) {
                weight += 2;
            }
            if card_has_any_signal(card, &["practice_spacing", "warmup_tax"]) {
                weight -= 1;
            }
        }
        _ => {}
    }
    match preferences.time_preference.as_str() {
        "next_session"
            if card_has_any_signal(
                card,
                &[
                    "warmup_tax",
                    "correction_load",
                    "hesitation_load",
                    "switch_penalty",
                ],
            ) =>
        {
            weight += 2
        }
        "long_term"
            if card_has_any_signal(
                card,
                &[
                    "retention_after_gap",
                    "family_balance",
                    "practice_spacing",
                    "cross_scenario_transfer",
                ],
            ) =>
        {
            weight += 2
        }
        _ if card_has_any_signal(card, &["block_fade", "momentum", "practice_spacing"]) => {
            weight += 1
        }
        _ => {}
    }
    weight
}

fn feedback_weight(
    card: &CoachingCardData,
    feedback_rows: &[stats_db::CoachingUserFeedbackRecord],
    snapshot_kind: &str,
) -> i32 {
    let mut weight = 0;
    let signals = card.signals.iter().collect::<HashSet<_>>();
    for row in feedback_rows
        .iter()
        .filter(|row| row.snapshot_kind == snapshot_kind)
    {
        let same_recommendation = row.recommendation_id == card.id;
        let same_signal = row
            .signal_key
            .as_ref()
            .map(|signal| signals.contains(&signal))
            .unwrap_or(false);
        if !same_recommendation && !same_signal {
            continue;
        }
        match row.feedback.as_str() {
            "helpful" => weight += if same_recommendation { -1 } else { 2 },
            "trying" => weight += if same_recommendation { 4 } else { 1 },
            "not_now" => weight += if same_recommendation { -3 } else { -1 },
            "not_for_me" => weight += if same_recommendation { -10 } else { -5 },
            _ => {}
        }
    }
    weight
}

fn push_unique(cards: &mut Vec<CoachingCardData>, card: CoachingCardData) {
    if cards.iter().any(|existing| existing.id == card.id) {
        return;
    }
    cards.push(card);
}

fn build_global_coaching_cards(
    records: &[AnalyticsRecord],
    practice_profile: Option<&PracticeProfileSnapshot>,
    warmup_ids: &HashSet<String>,
    target_response_summaries: &HashMap<
        String,
        crate::target_response::TargetResponseSummaryRecord,
    >,
    preferences: &CoachingUserPreferences,
    feedback_rows: &[stats_db::CoachingUserFeedbackRecord],
) -> Vec<CoachingCardData> {
    let learning_state =
        match derive_global_coaching_learning_state(records, practice_profile, warmup_ids) {
            Some(state) => state,
            None => return vec![],
        };
    let behavior_features = derive_behavior_pattern_features(
        records,
        practice_profile,
        warmup_ids,
        target_response_summaries,
    );
    let learning_profile = build_player_learning_profile(
        records,
        practice_profile,
        warmup_ids,
        target_response_summaries,
        now_ms(),
    );
    let recent_records = records[records.len().saturating_sub(36)..].to_vec();
    let target_response =
        build_target_response_aggregate(&recent_records, target_response_summaries);
    let mut cards = Vec::<CoachingCardData>::new();

    if let Some(warmup_tax_pct) = learning_state.warmup_tax_pct {
        if warmup_tax_pct >= 6.0 {
            push_unique(&mut cards, CoachingCardData {
                id: "global-warmup-tax".to_string(),
                source: "global".to_string(),
                title: "Warm-up Tax Across Scenarios".to_string(),
                badge: "Readiness".to_string(),
                badge_color: "#ffb400".to_string(),
                body: format!("Across recent scenarios, your opening runs land about {}% below your own settled-in level once each run is normalized against that scenario's usual score band. The issue is global readiness, not one bad scenario.", warmup_tax_pct.round()),
                tip: "Protect score attempts with a short 2–3 run ramp: easy tracking or wide targets, then medium-speed confirms, then serious attempts once the cursor feels settled.".to_string(),
                drills: vec![],
                confidence: Some(0.84),
                signals: vec!["warmup_tax".to_string(), "cross_scenario_normalization".to_string()],
            });
        } else if warmup_tax_pct <= 1.5 {
            push_unique(&mut cards, CoachingCardData {
                id: "global-quick-ramp".to_string(),
                source: "global".to_string(),
                title: "You Ramp Quickly".to_string(),
                badge: "Readiness".to_string(),
                badge_color: "#00f5a0".to_string(),
                body: "Your opening runs are already close to your own settled standard across different scenarios. That is a strong sign that your setup and pre-run routine are doing their job.".to_string(),
                tip: "Keep the routine stable. If you want more progress, spend the saved warm-up time on one focused mechanic block instead of adding random extra attempts.".to_string(),
                drills: vec![],
                confidence: Some(0.74),
                signals: vec!["warmup_efficiency".to_string()],
            });
        }
    }

    if let Some(features) = behavior_features.as_ref() {
        if let Some(target_response) = target_response.as_ref() {
            if target_response
                .avg_reaction_time_ms
                .is_some_and(|value| value >= 215.0)
            {
                push_unique(&mut cards, CoachingCardData {
                    id: "global-reaction-late".to_string(),
                    source: "global".to_string(),
                    title: "Large Target Changes Are Recognized Late".to_string(),
                    badge: "Recognition".to_string(),
                    badge_color: "#ffd700".to_string(),
                    body: format!(
                        "Across recent replay-instrumented runs, your first response to big path breaks or switches averages about {}ms. The issue is not only where the cursor lands; the response chain is starting later than it could.",
                        target_response
                            .avg_reaction_time_ms
                            .map(|value| format!("{value:.0}"))
                            .unwrap_or_else(|| "—".to_string())
                    ),
                    tip: "Use short replay-focused blocks where you judge only the first directional response after a target change. We want earlier recognition before we chase higher speed.".to_string(),
                    drills: vec![],
                    confidence: Some(0.79),
                    signals: vec!["reaction_latency".to_string(), "recognition".to_string()],
                });
            }

            if target_response
                .avg_pre_slowdown_reaction_ms
                .zip(target_response.avg_reaction_time_ms)
                .is_some_and(|(pre_slow, reaction)| pre_slow - reaction >= 55.0)
            {
                push_unique(&mut cards, CoachingCardData {
                    id: "global-braking-late".to_string(),
                    source: "global".to_string(),
                    title: "You See Changes Before You Brake For Them".to_string(),
                    badge: "Anticipation".to_string(),
                    badge_color: "#ff9f43".to_string(),
                    body: format!(
                        "The telemetry says recognition usually comes before deceleration by about {}ms ({}ms reaction, {}ms first slowdown). That gap is where overshoot and recovery work start stacking up.",
                        target_response
                            .avg_pre_slowdown_reaction_ms
                            .zip(target_response.avg_reaction_time_ms)
                            .map(|(pre_slow, reaction)| (pre_slow - reaction).round() as i64)
                            .unwrap_or(0),
                        target_response
                            .avg_reaction_time_ms
                            .map(|value| format!("{value:.0}"))
                            .unwrap_or_else(|| "—".to_string()),
                        target_response
                            .avg_pre_slowdown_reaction_ms
                            .map(|value| format!("{value:.0}"))
                            .unwrap_or_else(|| "—".to_string())
                    ),
                    tip: "Run one constraint block where the only goal is to start braking as soon as the new path is recognized. Earlier slowdown usually reduces both correction load and hesitation.".to_string(),
                    drills: vec![],
                    confidence: Some(0.74),
                    signals: vec!["anticipation_latency".to_string(), "recognition".to_string()],
                });
            }

            if target_response
                .avg_recovery_time_ms
                .is_some_and(|value| value >= 420.0)
                || target_response
                    .stable_response_ratio
                    .is_some_and(|value| value <= 0.45)
            {
                push_unique(&mut cards, CoachingCardData {
                    id: "global-recovery-bottleneck".to_string(),
                    source: "global".to_string(),
                    title: "Recovery After The First Correction Is Too Expensive".to_string(),
                    badge: "Stabilization".to_string(),
                    badge_color: "#00b4ff".to_string(),
                    body: format!(
                        "Recent target-response episodes average {}ms to settle after a change, with only {} ending in a stable response. The leak is happening after the first recognition, during the cleanup phase.",
                        target_response
                            .avg_recovery_time_ms
                            .map(|value| format!("{value:.0}"))
                            .unwrap_or_else(|| "—".to_string()),
                        target_response
                            .stable_response_ratio
                            .map(|value| format!("{:.0}%", value * 100.0))
                            .unwrap_or_else(|| "—".to_string())
                    ),
                    tip: "Spend a block on controlled entries instead of max-speed commits. Cleaner stabilization after a target change usually lifts score faster than forcing more aggression.".to_string(),
                    drills: vec![],
                    confidence: Some(0.82),
                    signals: vec!["recovery_time".to_string(), "stabilization".to_string()],
                });
            } else if target_response
                .stable_response_ratio
                .is_some_and(|value| value >= 0.62)
                && target_response
                    .avg_recovery_time_ms
                    .is_some_and(|value| value <= 300.0)
            {
                push_unique(&mut cards, CoachingCardData {
                    id: "global-stable-response-strong".to_string(),
                    source: "global".to_string(),
                    title: "Your Stabilization Foundation Is Strong".to_string(),
                    badge: "Stabilization".to_string(),
                    badge_color: "#00f5a0".to_string(),
                    body: "Across recent replay-instrumented runs, you usually settle cleanly after target changes. That means the target-response chain is no longer the main global bottleneck.".to_string(),
                    tip: "Use that headroom to push either recognition speed or raw tempo, but keep checking that stable responses stay high as difficulty rises.".to_string(),
                    drills: vec![],
                    confidence: Some(0.67),
                    signals: vec!["stable_response".to_string(), "stabilization".to_string()],
                });
            }
        }

        if let Some(correction_load_pct) = features.correction_load_pct {
            if correction_load_pct >= 28.0 {
                push_unique(&mut cards, CoachingCardData {
                    id: "global-correction-load".to_string(),
                    source: "global".to_string(),
                    title: "You Are Spending Too Many Extra Shots".to_string(),
                    badge: "Conversion".to_string(),
                    badge_color: "#ff6b6b".to_string(),
                    body: format!("Across recent instrumented runs, your correction load sits around {}%. The misses are not only accuracy misses; they are repeated micro-corrections that slow the whole chain down.", correction_load_pct.round()),
                    tip: "Use lower-speed confirmation reps for 5–8 minutes and judge success by first-shot quality, not raw score. Cleaner conversion will usually lift both precision and tempo.".to_string(),
                    drills: vec![],
                    confidence: Some(0.77),
                    signals: vec!["correction_load".to_string(), "precision_balance".to_string()],
                });
            }
        }
        if let Some(hesitation_load_pct) = features.hesitation_load_pct {
            if hesitation_load_pct >= 42.0 {
                push_unique(&mut cards, CoachingCardData {
                    id: "global-hesitation-load".to_string(),
                    source: "global".to_string(),
                    title: "Hesitation Is Capping Tempo".to_string(),
                    badge: "Tempo".to_string(),
                    badge_color: "#ffd700".to_string(),
                    body: format!("Your recent fire-to-hit timings suggest a noticeable hesitation load around {}%. The bottleneck looks less like pure aim error and more like delayed commit timing.", hesitation_load_pct.round()),
                    tip: "Run short commit drills where you accept slightly lower accuracy but forbid double-checking. We want cleaner decisions first, then polish the aim around them.".to_string(),
                    drills: vec![],
                    confidence: Some(0.71),
                    signals: vec!["hesitation_load".to_string(), "precision_balance".to_string()],
                });
            }
        }
        if let Some(learning_efficiency_pct) = features.learning_efficiency_pct {
            if learning_efficiency_pct <= 42.0 {
                push_unique(&mut cards, CoachingCardData {
                    id: "global-learning-efficiency-low".to_string(),
                    source: "global".to_string(),
                    title: "Practice Is Not Converting Cleanly Yet".to_string(),
                    badge: "Learning".to_string(),
                    badge_color: "#ff6b6b".to_string(),
                    body: "The new learning model says recent volume is producing less sticky progress than it should. Some work is helping in-session, but not enough of it is surviving into later blocks and later days.".to_string(),
                    tip: "Simplify for one week: fewer scenario swaps, stable block length, and one main mechanic focus. We want a cleaner learning signal before we add more variety or difficulty.".to_string(),
                    drills: vec![],
                    confidence: Some(0.75),
                    signals: vec!["momentum".to_string(), "practice_spacing".to_string()],
                });
            } else if learning_efficiency_pct >= 60.0 {
                push_unique(&mut cards, CoachingCardData {
                    id: "global-learning-efficiency-strong".to_string(),
                    source: "global".to_string(),
                    title: "Recent Practice Is Converting Well".to_string(),
                    badge: "Learning".to_string(),
                    badge_color: "#00f5a0".to_string(),
                    body: "The new learning model sees good conversion from recent work into later performance. Improvements are not staying trapped inside one session; they are carrying into later reps and mixed scenarios.".to_string(),
                    tip: "This is the right time to add a little more challenge. Keep the structure stable and raise only one demand so the carryover stays readable.".to_string(),
                    drills: vec![],
                    confidence: Some(0.68),
                    signals: vec!["momentum".to_string(), "cross_scenario_transfer".to_string()],
                });
            }
        }
    }

    if let Some(practice_profile) = practice_profile {
        let days_per_week = practice_profile.days_per_week;
        let avg_block_minutes = practice_profile.avg_block_minutes;
        let massed_pattern = avg_block_minutes >= 45.0
            || (days_per_week < 2.5 && practice_profile.avg_block_runs >= 6.0);
        let distributed_pattern =
            days_per_week >= 3.5 && (12.0..=35.0).contains(&avg_block_minutes);
        if massed_pattern {
            push_unique(&mut cards, CoachingCardData {
                id: "global-practice-density".to_string(),
                source: "global".to_string(),
                title: "Practice Density Is Hiding Progress".to_string(),
                badge: "Spacing".to_string(),
                badge_color: "#00b4ff".to_string(),
                body: format!("Recent work is concentrated into {:.0}-minute blocks across about {:.1} active days/week. That mixes warm-up gains and fatigue into the same block, which makes true improvement harder to read.", avg_block_minutes, days_per_week),
                tip: "Keep the volume, split the block. Two shorter 20–35 minute sessions usually preserve effort better than one long grind and make your next-day quality easier to judge.".to_string(),
                drills: vec![],
                confidence: Some(0.76),
                signals: vec!["practice_spacing".to_string(), "block_length".to_string()],
            });
        } else if distributed_pattern {
            push_unique(&mut cards, CoachingCardData {
                id: "global-practice-cadence".to_string(),
                source: "global".to_string(),
                title: "Your Practice Cadence Is Healthy".to_string(),
                badge: "Spacing".to_string(),
                badge_color: "#00f5a0".to_string(),
                body: format!("You are practicing across about {:.1} active days/week with blocks averaging {:.0} minutes. That is a strong range for retaining skill without paying too much fatigue tax.", days_per_week, avg_block_minutes),
                tip: "Use this structure as your base and adjust one variable at a time: either slightly more difficulty, slightly more contrast work, or slightly more deliberate warm-up, not all three at once.".to_string(),
                drills: vec![],
                confidence: Some(0.72),
                signals: vec!["practice_spacing".to_string(), "distributed_practice".to_string()],
            });
        }
    }

    if let (Some(dominant_family), Some(dominant_share_pct)) = (
        learning_state.dominant_family.as_ref(),
        learning_state.dominant_family_share_pct,
    ) {
        if dominant_share_pct >= 58.0 {
            let contrast_drills = contrast_plan_for_scenario_family(dominant_family);
            push_unique(&mut cards, CoachingCardData {
                id: "global-family-narrow".to_string(),
                source: "global".to_string(),
                title: "Practice Mix Is Too Narrow".to_string(),
                badge: "Transfer".to_string(),
                badge_color: "#a78bfa".to_string(),
                body: format!("{}% of your recent reliable runs sit in {}. That sharpens familiarity, but it usually undertrains broader transfer.", dominant_share_pct.round(), dominant_family),
                tip: "Keep your main family, but insert one contrast set after every 2–3 serious runs. The goal is not comfort inside the block; it is better retention and carryover when you come back.".to_string(),
                drills: contrast_drills,
                confidence: Some(0.8),
                signals: vec!["family_balance".to_string(), "transfer_bias".to_string()],
            });
        }
    }

    if let Some(avg_block_fade_pct) = learning_state.avg_block_fade_pct {
        if avg_block_fade_pct >= 5.0 {
            push_unique(&mut cards, CoachingCardData {
                id: "global-block-fade".to_string(),
                source: "global".to_string(),
                title: "Long Blocks Fade Late".to_string(),
                badge: "Endurance".to_string(),
                badge_color: "#ff9f43".to_string(),
                body: format!("Across your longer practice blocks, settled runs finish about {}% below the level you hit near the start of the block. That points to endurance or attention decay, not a lack of raw skill.", avg_block_fade_pct.round()),
                tip: "Treat the middle of the block as the scoring window. Once quality fades, swap into a lower-stakes drill or stop the block instead of grinding more serious attempts.".to_string(),
                drills: vec![],
                confidence: Some(0.83),
                signals: vec!["block_fade".to_string(), "fatigue_pattern".to_string()],
            });
        }
    }

    if let Some(switch_penalty_pct) = learning_state.switch_penalty_pct {
        if switch_penalty_pct >= 5.0 {
            push_unique(&mut cards, CoachingCardData {
                id: "global-switch-penalty".to_string(),
                source: "global".to_string(),
                title: "Scenario Switches Still Cost You".to_string(),
                badge: "Context".to_string(),
                badge_color: "#ffd700".to_string(),
                body: format!("Runs that follow a scenario change land about {}% below runs that stay on the same task, even after normalizing for each scenario's own score range.", switch_penalty_pct.round()),
                tip: "Use mini-blocks instead of single-run hopping: 2–3 reps on one task, then switch. That keeps some interleaving benefit without paying a reset cost every run.".to_string(),
                drills: vec![],
                confidence: Some(0.78),
                signals: vec!["switch_penalty".to_string(), "context_adaptation".to_string()],
            });
        }
    }

    if let Some(momentum_delta_pct) = learning_state.momentum_delta_pct {
        if momentum_delta_pct >= 4.0 {
            push_unique(&mut cards, CoachingCardData {
                id: "global-cross-scenario-form-rise".to_string(),
                source: "global".to_string(),
                title: "Cross-Scenario Form Is Rising".to_string(),
                badge: "Momentum".to_string(),
                badge_color: "#00f5a0".to_string(),
                body: format!("Recent settled runs are about {}% stronger than the window before them after normalizing for each scenario. Improvement is carrying across tasks, not staying trapped inside one score line.", momentum_delta_pct.round()),
                tip: "This is the moment to raise difficulty slightly or tighten one technical focus. The carryover is real, so you can challenge it without losing the trend.".to_string(),
                drills: vec![],
                confidence: Some(0.73),
                signals: vec!["momentum".to_string(), "cross_scenario_transfer".to_string()],
            });
        } else if momentum_delta_pct <= -4.0 {
            push_unique(&mut cards, CoachingCardData {
                id: "global-form-drop".to_string(),
                source: "global".to_string(),
                title: "Global Form Has Cooled Off".to_string(),
                badge: "Momentum".to_string(),
                badge_color: "#ff6b6b".to_string(),
                body: format!("Recent settled runs are about {}% weaker than the window before them across mixed scenarios. That usually points to fatigue, inconsistency, or too much change at once.", momentum_delta_pct.abs().round()),
                tip: "Run a reset week: keep volume steady, simplify the scenario rotation, and lock in one mechanic focus.".to_string(),
                drills: vec![],
                confidence: Some(0.75),
                signals: vec!["global_form_drop".to_string(), "momentum".to_string()],
            });
        }
    }

    if cards.is_empty() {
        cards.push(CoachingCardData {
            id: "global-practice-stable".to_string(),
            source: "global".to_string(),
            title: "Global Practice Looks Stable".to_string(),
            badge: "Baseline".to_string(),
            badge_color: "#00f5a0".to_string(),
            body: "Recent practice does not show a single major cross-scenario leak. Your training structure, readiness, and carryover look reasonably healthy from the data we have.".to_string(),
            tip: "Keep the routine steady and push one lever at a time: slightly harder scenarios, slightly cleaner execution, or slightly better spacing between blocks.".to_string(),
            drills: vec![],
            confidence: Some(0.58),
            signals: vec!["baseline".to_string()],
        });
    }

    let base_ranks = cards
        .iter()
        .enumerate()
        .map(|(index, card)| (card.id.clone(), 100 - index as i32))
        .collect::<HashMap<_, _>>();
    cards.sort_by_key(|card| {
        let base_rank = *base_ranks.get(&card.id).unwrap_or(&0);
        -(base_rank
            + preference_weight(card, preferences)
            + feedback_weight(card, feedback_rows, "player_learning_profile"))
    });
    cards.truncate(6);
    let _ = learning_profile;
    cards
}

fn metric_for_signal(
    signal_key: &str,
    profile: &PlayerLearningProfile,
) -> Option<(String, String, Option<f64>)> {
    let value = |key: &str| profile.metrics.get(key).cloned().unwrap_or(None);
    match signal_key {
        "warmup_tax" | "warmup_efficiency" => Some((
            "readinessPct".to_string(),
            "up".to_string(),
            value("readinessPct"),
        )),
        "practice_spacing" => Some((
            "learningEfficiencyPct".to_string(),
            "up".to_string(),
            value("learningEfficiencyPct"),
        )),
        "family_balance" | "transfer_bias" | "interleaving" => Some((
            "transferPct".to_string(),
            "up".to_string(),
            value("transferPct"),
        )),
        "block_fade" | "fatigue_pattern" => Some((
            "endurancePct".to_string(),
            "up".to_string(),
            value("endurancePct"),
        )),
        "switch_penalty" | "context_adaptation" => Some((
            "adaptationPct".to_string(),
            "up".to_string(),
            value("adaptationPct"),
        )),
        "retention_after_gap" | "consolidation" | "consolidation_strength" => Some((
            "retainedFormPct".to_string(),
            "up".to_string(),
            value("retainedFormPct"),
        )),
        "momentum" | "cross_scenario_transfer" | "global_form_drop" => Some((
            "learningEfficiencyPct".to_string(),
            "up".to_string(),
            value("learningEfficiencyPct"),
        )),
        "normalized_variance" | "execution_consistency" => Some((
            "consistencyPct".to_string(),
            "up".to_string(),
            value("consistencyPct"),
        )),
        "correction_load" => Some((
            "correctionLoadPct".to_string(),
            "down".to_string(),
            value("correctionLoadPct"),
        )),
        "reaction_latency" | "recognition" => Some((
            "reactionPct".to_string(),
            "up".to_string(),
            value("reactionPct"),
        )),
        "anticipation_latency" => Some((
            "anticipationPct".to_string(),
            "up".to_string(),
            value("anticipationPct"),
        )),
        "recovery_time" | "stabilization" | "stable_response" => Some((
            "stabilizationPct".to_string(),
            "up".to_string(),
            value("stabilizationPct"),
        )),
        "hesitation_load" => Some((
            "hesitationLoadPct".to_string(),
            "down".to_string(),
            value("hesitationLoadPct"),
        )),
        "precision_balance" => Some((
            "precisionPct".to_string(),
            "up".to_string(),
            value("precisionPct"),
        )),
        "control_foundation" => Some((
            "controlPct".to_string(),
            "up".to_string(),
            value("controlPct"),
        )),
        _ => None,
    }
}

fn build_recommendation_evaluations(
    snapshot_kind: &str,
    cards: &[CoachingCardData],
    profile: &PlayerLearningProfile,
) -> Vec<stats_db::CoachingRecommendationEvaluation> {
    cards
        .iter()
        .filter_map(|card| {
            let signal_key = card
                .signals
                .iter()
                .find(|signal| metric_for_signal(signal, profile).is_some())?
                .clone();
            let (metric_key, direction, value) = metric_for_signal(&signal_key, profile)?;
            Some(stats_db::CoachingRecommendationEvaluation {
                evaluation_id: format!(
                    "{}:{}:{}:{}",
                    snapshot_kind,
                    card.id,
                    profile.settled_sample_count,
                    profile.coverage_end_ms.unwrap_or(0)
                ),
                snapshot_kind: snapshot_kind.to_string(),
                recommendation_id: card.id.clone(),
                recommendation_title: card.title.clone(),
                signal_key,
                status: "pending".to_string(),
                created_at_unix_ms: profile.generated_at_ms,
                updated_at_unix_ms: profile.generated_at_ms,
                anchor_sample_count: profile.settled_sample_count,
                latest_sample_count: profile.settled_sample_count,
                anchor_metric_value: value,
                latest_metric_value: value,
                outcome_delta: None,
                context_json: serde_json::json!({
                    "metricKey": metric_key,
                    "direction": direction,
                    "focusAreaKey": profile.focus_area_key,
                    "focusAreaLabel": profile.focus_area_label,
                    "confidence": card.confidence,
                    "coverageEndMs": profile.coverage_end_ms,
                }),
            })
        })
        .collect()
}

fn resolve_recommendation_evaluations(
    evaluations: &[stats_db::CoachingRecommendationEvaluation],
    profile: &PlayerLearningProfile,
    min_sample_gain: u32,
) -> Vec<stats_db::CoachingRecommendationEvaluation> {
    evaluations
        .iter()
        .map(|evaluation| {
            if evaluation.status != "pending"
                || profile
                    .settled_sample_count
                    .saturating_sub(evaluation.anchor_sample_count)
                    < min_sample_gain
            {
                return evaluation.clone();
            }
            let metric_key = evaluation
                .context_json
                .get("metricKey")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            let direction = evaluation
                .context_json
                .get("direction")
                .and_then(|value| value.as_str())
                .unwrap_or("up");
            let latest_value = metric_key
                .as_ref()
                .and_then(|metric_key| profile.metrics.get(metric_key))
                .cloned()
                .unwrap_or(None);
            let mut next = evaluation.clone();
            next.updated_at_unix_ms = profile.generated_at_ms;
            next.latest_sample_count = profile.settled_sample_count;
            next.latest_metric_value = latest_value;
            if let (Some(anchor), Some(latest)) = (evaluation.anchor_metric_value, latest_value) {
                let signed_delta = if direction == "down" {
                    anchor - latest
                } else {
                    latest - anchor
                };
                next.status = if signed_delta >= 3.0 {
                    "improved".to_string()
                } else if signed_delta <= -3.0 {
                    "regressed".to_string()
                } else {
                    "flat".to_string()
                };
                next.outcome_delta = Some(signed_delta);
            }
            next
        })
        .collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn filter_records_by_date_range(
    records: Vec<SessionRecord>,
    date_range: Option<&str>,
) -> Vec<SessionRecord> {
    let Some(date_range) = date_range else {
        return records;
    };
    let days = match date_range {
        "30d" => 30,
        "90d" => 90,
        "365d" => 365,
        _ => return records,
    };
    let cutoff = Local::now()
        .checked_sub_signed(Duration::days(days))
        .map(|value| value.timestamp_millis())
        .unwrap_or(i64::MIN);
    records
        .into_iter()
        .filter(|record| parse_timestamp_ms(&record.timestamp).unwrap_or(0) >= cutoff)
        .collect()
}

pub fn get_global_overview(
    app: &AppHandle,
    date_range: Option<&str>,
) -> anyhow::Result<GlobalCoachingOverview> {
    let page = session_store::get_session_page(app, 0, 100_000);
    let records = filter_records_by_date_range(page.records, date_range);
    let mut analytics_records = build_analytics_records(records);
    analytics_records.sort_by_key(|record| record.timestamp_ms);
    let warmup_ids = classify_warmup(&analytics_records);
    let practice_profile = build_practice_profile(&analytics_records);
    let target_response_summaries =
        stats_db::get_all_target_response_summaries(app).unwrap_or_default();
    let learning_state = derive_global_coaching_learning_state(
        &analytics_records,
        practice_profile.as_ref(),
        &warmup_ids,
    );
    let behavior_features = derive_behavior_pattern_features(
        &analytics_records,
        practice_profile.as_ref(),
        &warmup_ids,
        &target_response_summaries,
    );
    let preferences = preferences_from_settings(app);
    let feedback_rows = stats_db::get_coaching_user_feedback(app, Some("player_learning_profile"))
        .unwrap_or_default();
    let player_learning_profile = build_player_learning_profile(
        &analytics_records,
        practice_profile.as_ref(),
        &warmup_ids,
        &target_response_summaries,
        now_ms(),
    );
    let global_cards = build_global_coaching_cards(
        &analytics_records,
        practice_profile.as_ref(),
        &warmup_ids,
        &target_response_summaries,
        &preferences,
        &feedback_rows,
    );

    let coaching_persistence_status = if let Some(profile) = player_learning_profile.as_ref() {
        let snapshot_kind = "player_learning_profile";
        let pending = stats_db::get_coaching_recommendation_evaluations(
            app,
            Some(snapshot_kind),
            Some("pending"),
        )
        .unwrap_or_default();
        let resolved = resolve_recommendation_evaluations(&pending, profile, 6);
        let seeded = build_recommendation_evaluations(snapshot_kind, &global_cards, profile);
        let snapshot = stats_db::CoachingStateSnapshot {
            snapshot_kind: snapshot_kind.to_string(),
            updated_at_unix_ms: profile.generated_at_ms,
            sample_count: profile.sample_count,
            settled_sample_count: profile.settled_sample_count,
            coverage_start_unix_ms: profile.coverage_start_ms,
            coverage_end_unix_ms: profile.coverage_end_ms,
            summary_json: serde_json::json!({
                "profile": profile,
                "features": behavior_features,
                "cards": global_cards,
            }),
        };
        let _ = stats_db::upsert_coaching_state_snapshot(app, &snapshot);
        let mut merged = resolved;
        merged.extend(seeded);
        let _ = stats_db::upsert_coaching_recommendation_evaluations(app, &merged);
        let all = stats_db::get_coaching_recommendation_evaluations(app, Some(snapshot_kind), None)
            .unwrap_or_default();
        Some(CoachingPersistenceStatus {
            snapshot_updated_at_ms: Some(snapshot.updated_at_unix_ms),
            pending_count: all
                .iter()
                .filter(|evaluation| evaluation.status == "pending")
                .count() as u32,
            improved_count: all
                .iter()
                .filter(|evaluation| evaluation.status == "improved")
                .count() as u32,
            flat_count: all
                .iter()
                .filter(|evaluation| evaluation.status == "flat")
                .count() as u32,
            regressed_count: all
                .iter()
                .filter(|evaluation| evaluation.status == "regressed")
                .count() as u32,
        })
    } else {
        None
    };

    Ok(GlobalCoachingOverview {
        practice_profile,
        warmup_ids: warmup_ids.into_iter().collect(),
        learning_state,
        behavior_features,
        player_learning_profile,
        global_cards,
        coaching_persistence_status,
    })
}

pub fn get_scenario_overview(
    app: &AppHandle,
    scenario_name: &str,
    date_range: Option<&str>,
) -> anyhow::Result<ScenarioCoachingOverview> {
    let page = session_store::get_session_page(app, 0, 100_000);
    let records = filter_records_by_date_range(page.records, date_range);
    let mut analytics_records = build_analytics_records(records);
    analytics_records.sort_by_key(|record| record.timestamp_ms);
    let all_records = analytics_records.clone();
    let practice_profile = build_practice_profile(&analytics_records);
    let target_response_summaries =
        stats_db::get_all_target_response_summaries(app).unwrap_or_default();
    let normalized_name = normalize_scenario_name(scenario_name);
    let scenario_records = analytics_records
        .into_iter()
        .filter(|record| record.normalized_scenario == normalized_name)
        .collect::<Vec<_>>();
    let mut reliable_sorted = scenario_records
        .iter()
        .filter(|record| record.is_reliable_for_analysis)
        .cloned()
        .collect::<Vec<_>>();
    reliable_sorted.sort_by_key(|record| record.timestamp_ms);
    let warmup_ids = classify_warmup(&reliable_sorted);
    let warmup_stats = build_scenario_warmup_stats(&reliable_sorted, &warmup_ids);
    let peak_sorted = reliable_sorted
        .iter()
        .filter(|record| !warmup_ids.contains(&record.record.id))
        .cloned()
        .collect::<Vec<_>>();
    let coach_sorted = if peak_sorted.len() >= 3 {
        peak_sorted
    } else {
        reliable_sorted.clone()
    };
    let dominant_type = dominant_scenario_type(&coach_sorted);
    let fingerprint = build_aim_fingerprint(&coach_sorted, &dominant_type);
    let scenario_target_response =
        build_target_response_aggregate(&coach_sorted, &target_response_summaries);
    let family_records = all_records
        .iter()
        .filter(|record| record.is_reliable_for_analysis)
        .filter(|record| scenario_type(&record.record.stats_panel) == dominant_type)
        .cloned()
        .collect::<Vec<_>>();
    let family_target_response =
        build_target_response_aggregate(&family_records, &target_response_summaries);
    let scores = coach_sorted
        .iter()
        .map(|record| record.record.score)
        .collect::<Vec<_>>();
    let avg_score = (!scores.is_empty()).then(|| mean(&scores));
    let score_cv_pct = avg_score
        .filter(|avg| *avg > 0.0)
        .map(|avg| (stddev(&scores) / avg) * 100.0);
    let slope_pts_per_run = (scores.len() >= 2).then(|| linear_regression_slope(&scores));
    let recent7 = scores
        .iter()
        .rev()
        .take(7)
        .copied()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    let recent_cv = if recent7.len() >= 2 && mean(&recent7) > 0.0 {
        (stddev(&recent7) / mean(&recent7)) * 100.0
    } else {
        0.0
    };
    let is_plateau = scores.len() >= 8
        && avg_score.is_some_and(|avg| avg > 0.0)
        && slope_pts_per_run
            .zip(avg_score)
            .map(|(slope, avg)| ((slope / avg) * 100.0).abs() < 0.5 && recent_cv < 8.0)
            .unwrap_or(false);
    let coaching_cards = if scores.len() >= 3 {
        build_scenario_coaching_cards(
            &coach_sorted,
            &coach_sorted,
            practice_profile.as_ref(),
            &dominant_type,
            fingerprint.as_ref(),
            scenario_target_response.as_ref(),
            family_target_response.as_ref(),
            score_cv_pct.unwrap_or(0.0),
            slope_pts_per_run.unwrap_or(0.0),
            avg_score.unwrap_or(0.0),
            is_plateau,
        )
    } else {
        Vec::new()
    };

    Ok(ScenarioCoachingOverview {
        scenario_type: dominant_type,
        score_cv_pct,
        slope_pts_per_run,
        avg_score,
        is_plateau,
        p10_score: percentile(&scores, 10.0),
        p50_score: percentile(&scores, 50.0),
        p90_score: percentile(&scores, 90.0),
        warmup_stats,
        coaching_cards,
    })
}

fn values_in_range(
    points: &[crate::bridge::BridgeRunTimelinePoint],
    start_sec: u32,
    end_sec: u32,
    pick: impl Fn(&crate::bridge::BridgeRunTimelinePoint) -> Option<f64>,
) -> Vec<f64> {
    points
        .iter()
        .filter(|point| point.t_sec >= start_sec && point.t_sec <= end_sec)
        .filter_map(pick)
        .collect()
}

fn shot_stats_in_range(
    points: &[crate::bridge::BridgeRunTimelinePoint],
    start_sec: u32,
    end_sec: u32,
) -> Option<(f64, f64)> {
    let window = points
        .iter()
        .filter(|point| point.t_sec >= start_sec && point.t_sec <= end_sec)
        .collect::<Vec<_>>();
    if window.len() < 2 {
        return None;
    }
    let fired_values = window
        .iter()
        .filter_map(|point| point.shots_fired)
        .collect::<Vec<_>>();
    let hit_values = window
        .iter()
        .filter_map(|point| point.shots_hit)
        .collect::<Vec<_>>();
    if fired_values.len() < 2 || hit_values.len() < 2 {
        return None;
    }
    let shots_fired = fired_values
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max)
        - fired_values.iter().copied().fold(f64::INFINITY, f64::min);
    let shots_hit = hit_values.iter().copied().fold(f64::NEG_INFINITY, f64::max)
        - hit_values.iter().copied().fold(f64::INFINITY, f64::min);
    if shots_fired < 6.0 {
        return None;
    }
    let hit_rate_pct = if shots_fired > 0.0 {
        (shots_hit / shots_fired) * 100.0
    } else {
        0.0
    };
    let shots_per_hit = if shots_hit > 0.0 {
        shots_fired / shots_hit
    } else {
        shots_fired
    };
    Some((hit_rate_pct, shots_per_hit))
}

pub fn get_session_run_coaching_analysis(
    app: &AppHandle,
    session_id: &str,
) -> anyhow::Result<SessionRunCoachingAnalysis> {
    let summary = stats_db::get_run_summary(app, session_id)?
        .ok_or_else(|| anyhow::anyhow!("run summary missing"))?;
    let timeline = stats_db::get_run_timeline(app, session_id)?;
    if timeline.len() < 4 {
        return Ok(SessionRunCoachingAnalysis {
            key_moments: vec![],
        });
    }
    let total_secs = (summary.duration_secs.unwrap_or_else(|| {
        timeline
            .last()
            .map(|point| point.t_sec as f64)
            .unwrap_or(0.0)
    }))
    .round()
    .max(1.0) as u32;
    let early_start = 0;
    let early_end = (total_secs / 3).max(1);
    let late_start = ((total_secs * 2) / 3).max(early_end);
    let late_end = total_secs;
    let early_spm = mean(&values_in_range(
        &timeline,
        early_start,
        early_end,
        |point| point.score_per_minute,
    ));
    let late_spm = mean(&values_in_range(&timeline, late_start, late_end, |point| {
        point.score_per_minute
    }));
    let early_acc = mean(&values_in_range(
        &timeline,
        early_start,
        early_end,
        |point| normalize_accuracy_pct(point.accuracy_pct, point.shots_hit, point.shots_fired),
    ));
    let late_acc = mean(&values_in_range(&timeline, late_start, late_end, |point| {
        normalize_accuracy_pct(point.accuracy_pct, point.shots_hit, point.shots_fired)
    }));
    let early_shot_stats = shot_stats_in_range(&timeline, early_start, early_end);
    let late_shot_stats = shot_stats_in_range(&timeline, late_start, late_end);
    let mut moments = Vec::<RunMomentInsight>::new();

    if early_spm > 0.0 && late_spm > 0.0 && (early_spm - late_spm) / early_spm > 0.12 {
        let accuracy_delta = if early_acc > 0.0 && late_acc > 0.0 {
            Some(late_acc - early_acc)
        } else {
            None
        };
        let improved_accuracy = accuracy_delta.map(|delta| delta >= 2.5).unwrap_or(false);
        moments.push(RunMomentInsight {
            id: "moment-late-spm-fade".to_string(),
            level: if improved_accuracy { "tip" } else { "warning" }.to_string(),
            title: if improved_accuracy {
                "Speed→Accuracy Trade-off Late".to_string()
            } else {
                "Late-Run Pace Drop".to_string()
            },
            detail: if improved_accuracy {
                format!(
                    "Pace fell from {:.0} to {:.0} SPM while accuracy improved by {:.1}%. Keep this control and add pace back gradually.",
                    early_spm,
                    late_spm,
                    accuracy_delta.unwrap_or(0.0)
                )
            } else {
                format!(
                    "Pace fell from {:.0} to {:.0} SPM in the final third without a meaningful accuracy gain.",
                    early_spm, late_spm
                )
            },
            metric: "spm".to_string(),
            start_sec: late_start,
            end_sec: late_end,
        });
    }
    if early_acc > 0.0 && late_acc > 0.0 && late_acc - early_acc >= 3.0 {
        let detail = if let (Some((_, early_shots_per_hit)), Some((_, late_shots_per_hit))) =
            (early_shot_stats, late_shot_stats)
        {
            format!(
                "Accuracy improved {:.1}% → {:.1}%, and shots-per-hit improved {:.2} → {:.2}.",
                early_acc, late_acc, early_shots_per_hit, late_shots_per_hit
            )
        } else {
            format!(
                "Accuracy improved from {:.1}% to {:.1}% late-run.",
                early_acc, late_acc
            )
        };
        moments.push(RunMomentInsight {
            id: "moment-accuracy-build".to_string(),
            level: "good".to_string(),
            title: "Accuracy Stabilized".to_string(),
            detail,
            metric: "accuracy".to_string(),
            start_sec: late_start,
            end_sec: late_end,
        });
    }
    moments.sort_by_key(|moment| match moment.level.as_str() {
        "warning" => 0,
        "tip" => 1,
        _ => 2,
    });
    moments.truncate(4);
    let _ = replay_store::load_replay(app, session_id);
    Ok(SessionRunCoachingAnalysis {
        key_moments: moments,
    })
}
