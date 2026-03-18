import type { FriendProfile } from "./friends";
import type { MouseMetrics } from "./mouse";
import type { SessionCompletePayload, OverlayRuntimeNotice } from "./overlay";
import type { OverlayPreset, OverlaySurfaceAssignments } from "./overlayPresets";

export interface OverlayStatsSnapshot {
  session_time_secs: number | null;
  score_total: number | null;
  score_total_derived: number | null;
  kills: number | null;
  kps: number | null;
  accuracy_hits: number | null;
  accuracy_shots: number | null;
  accuracy_pct: number | null;
  damage_dealt: number | null;
  damage_total: number | null;
  spm: number | null;
  ttk_secs: number | null;
  challenge_seconds_total: number | null;
  challenge_time_length: number | null;
  time_remaining: number | null;
  queue_time_remaining: number | null;
  is_in_challenge: boolean | null;
  is_in_scenario: boolean | null;
  scenario_is_paused: boolean | null;
  game_state_code: number | null;
  game_state: string | null;
  scenario_name: string | null;
  scenario_type: string;
  scenario_subtype: string | null;
}

export interface OverlayLiveFeedback {
  message: string;
  kind: string;
  metric: string;
}

export interface OverlayFriendScoreEntry {
  steam_id: string;
  steam_account_name: string;
  score: number;
  rank: number;
  kovaaks_plus_active: boolean;
}

export interface OverlayFriendScoresSnapshot {
  source: string;
  scenario_name: string;
  leaderboard_id: number;
  response_code: number;
  entries: OverlayFriendScoreEntry[];
}

export interface OverlayRuntimeHealth {
  game_running: boolean;
  runtime_loaded: boolean;
  bridge_connected: boolean;
  has_recent_stats: boolean;
  restart_required: boolean;
}

export interface OverlayBenchmarkThreshold {
  rankIndex: number;
  rankName: string;
  iconUrl: string;
  color: string;
  score: number;
}

export interface OverlayBenchmarkScenarioPage {
  scenarioName: string;
  score: number;
  leaderboardRank: number;
  leaderboardId: number;
  rankIndex: number;
  rankName: string;
  rankIconUrl: string;
  rankColor: string;
  thresholds: OverlayBenchmarkThreshold[];
}

export interface OverlayBenchmarkCategoryPage {
  categoryName: string;
  categoryRank: number;
  scenarios: OverlayBenchmarkScenarioPage[];
}

export interface OverlayExternalBenchmarkPage {
  steamId: string;
  kovaaksUsername: string;
  isAimmodUser: boolean;
  aimmodHandle: string;
  benchmarkId: number;
  benchmarkName: string;
  benchmarkIconUrl: string;
  overallRankIndex: number;
  overallRankName: string;
  overallRankIcon: string;
  overallRankColor: string;
  ranks: Array<{
    rankIndex: number;
    rankName: string;
    iconUrl: string;
    color: string;
    frameUrl: string;
  }>;
  categories: OverlayBenchmarkCategoryPage[];
}

export interface OverlayBenchmarkScenarioMatch {
  benchmark_id: number;
  benchmark_name: string;
  benchmark_icon_url: string;
  category_name: string;
  scenario_name: string;
  score: number;
  leaderboard_rank: number;
  rank_index: number;
  rank_name: string;
  rank_icon_url: string;
  rank_color: string;
  next_threshold_name: string | null;
  next_threshold_score: number | null;
  progress_pct: number | null;
}

export interface OverlayBenchmarkState {
  loading: boolean;
  last_error: string | null;
  selected_benchmark_ids: number[];
  primary_benchmark_id: number | null;
  scenario_name: string | null;
  player_steam_id: string | null;
  pages: OverlayExternalBenchmarkPage[];
  matching_pages: OverlayExternalBenchmarkPage[];
  current_scenario_matches: OverlayBenchmarkScenarioMatch[];
}

export interface OverlayStateEnvelope {
  generated_at_unix_ms: number;
  active_overlay_preset_id: string;
  active_surface_assignments: OverlaySurfaceAssignments;
  overlay_presets: OverlayPreset[];
  friends: FriendProfile[];
  selected_friend: string | null;
  current_user: FriendProfile | null;
  stats_panel: OverlayStatsSnapshot | null;
  mouse_metrics: MouseMetrics | null;
  session_result: SessionCompletePayload | null;
  live_feedback: OverlayLiveFeedback | null;
  personal_best_score: number | null;
  friend_scores: OverlayFriendScoresSnapshot | null;
  benchmark_state: OverlayBenchmarkState | null;
  runtime_notice: OverlayRuntimeNotice;
  runtime_health: OverlayRuntimeHealth;
}
