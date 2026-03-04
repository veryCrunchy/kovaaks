// ─── Session results (CSV watcher) ────────────────────────────────────────────

export interface SessionResult {
  scenario: string;
  score: number;
  accuracy: number;
  kills: number;
  deaths: number;
  duration_secs: number;
  avg_ttk?: number;
  damage_done?: number;
  timestamp: string;
  csv_path: string;
}

// ─── Live score payload (legacy feed) ────────────────────────────────────────

export interface LiveScorePayload {
  /** score_total = authoritative/derived live score; spm = legacy score-per-minute feed */
  kind?: "score_total" | "spm";
  score: number;
  raw_text: string;
}

// ─── Stats panel live payload ────────────────────────────────────────────────

/**
 * Live reading from the KovaaK's in-game stats panel.
 * Fields are null when the scenario doesn't populate them (e.g. pure tracking
 * has no kills; one-shot scenarios have no damage).
 * The `scenario_type` field is inferred from the presence pattern.
 */
export interface StatsPanelReading {
  session_time_secs: number | null;
  kills: number | null;
  kps: number | null;
  accuracy_hits: number | null;
  accuracy_shots: number | null;
  accuracy_pct: number | null;
  damage_dealt: number | null;
  damage_total: number | null;
  spm: number | null;
  ttk_secs: number | null;
  challenge_seconds_total?: number | null;
  challenge_time_length?: number | null;
  challenge_tick_count_total?: number | null;
  challenge_average_fps?: number | null;
  random_sens_scale?: number | null;
  time_remaining?: number | null;
  queue_time_remaining?: number | null;
  is_in_challenge?: boolean | null;
  is_in_scenario?: boolean | null;
  is_in_scenario_editor?: boolean | null;
  is_in_trainer?: boolean | null;
  scenario_is_paused?: boolean | null;
  scenario_is_enabled?: boolean | null;
  scenario_play_type?: number | null;
  game_state?: string | null;
  /** State-manager scenario identity when available. */
  scenario_name?: string | null;
  /** "Unknown" | "Tracking" | "OneShotClicking" | "MultiHitClicking" | "ReactiveClicking" | "AccuracyDrill" */
  scenario_type: string;
}

/** A single shot event detected by the stats-panel delta engine. */
export interface ShotEvent {
  hit: boolean;
  kill: boolean;
  timestamp_ms: number;
  ttk_ms: number | null;
  scenario_type: string;
  mouse_overshoot: number;
  mouse_correction_ratio: number;
  mouse_jitter: number;
}

/** Live coaching notification (from mouse hook or stats pipeline). */
export interface LiveFeedback {
  message: string;
  /** "positive" | "tip" | "warning" */
  kind: "positive" | "tip" | "warning";
  /** Which metric key triggered this. */
  metric: string;
}
