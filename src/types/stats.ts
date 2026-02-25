// ─── Live score (OCR) ──────────────────────────────────────────────────────────

export interface LiveScorePayload {
  score: number;
  raw_text: string;
}

// ─── Mouse metrics ─────────────────────────────────────────────────────────────

export interface MouseMetrics {
  /** 0–100 composite smoothness score */
  smoothness: number;
  /**
   * Lateral RMS ÷ mean speed — deviation perpendicular to the primary axis of
   * motion. Dimensionless and DPI-independent. 0 = perfectly on-axis.
   * Tracking scenarios (left-right) use the horizontal axis, so only vertical
   * wobble registers as jitter.
   */
  jitter: number;
  /**
   * Fraction of qualified axial segments where the motion reverses sharply
   * (without decelerating through zero). Lower is better.
   */
  overshoot_rate: number;
  /**
   * Coefficient of variation of speed (std ÷ mean). Dimensionless and
   * DPI-independent. Lower = more consistent speed.
   */
  velocity_std: number;
  /** Average speed normalised to an 800-DPI baseline (px/s ÷ dpi/800). */
  avg_speed: number;
  /**
   * Path straightness: straight-line displacement ÷ total path length,
   * averaged over sliding position windows. 1.0 = perfectly straight;
   * lower values mean the cursor curved/weaved toward the target.
   */
  path_efficiency: number;
  /** Inter-click interval coefficient of variation. 0 = perfect metronome. */
  click_timing_cv: number;
  /** Fraction of movement in Fitts' correction phase. Lower = more decisive. */
  correction_ratio: number;
  /** Systematic overshoot direction bias. 0 = balanced, 1 = always same side. */
  directional_bias: number;
  /** Average LMB hold duration (ms) in the last tick window. Near-zero = tapping; high = holding. */
  avg_hold_ms: number;
}

export interface MetricPoint {
  timestamp_ms: number;
  metrics: MouseMetrics;
}

// ─── Session result (CSV watcher) ─────────────────────────────────────────────

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
// ─── Friend profiles ──────────────────────────────────────────────

export interface FriendProfile {
  username: string;
  steam_id: string;
  steam_account_name: string;
  avatar_url: string;
  country: string;
  kovaaks_plus: boolean;
}

export interface MostPlayedEntry {
  scenario_name: string;
  score: number;
  rank: number | null;
  counts: { plays: number };
}
// ─── Friend scores (──────────────────────────────────────────────────

/** Best score fetched from KovaaK's API for a friend on a specific scenario. */
export interface FriendScore {
  username: string;
  score: number;
}

// ─── App settings ──────────────────────────────────────────────────────────────

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StatsFieldRegions {
  kills: RegionRect | null;
  kps: RegionRect | null;
  accuracy: RegionRect | null;
  damage: RegionRect | null;
  ttk: RegionRect | null;
}

export interface AppSettings {
  stats_dir: string;
  region: RegionRect | null;
  ocr_poll_ms: number;
  overlay_visible: boolean;
  username: string;
  monitor_index: number;
  friends: FriendProfile[];
  scenario_region: RegionRect | null;
  selected_friend: string | null;
  mouse_dpi: number;
  /** Per-field OCR regions for the stats panel — one small region per stat. */
  stats_field_regions: StatsFieldRegions;
  /** Whether live coaching notifications are shown during sessions. */
  live_feedback_enabled: boolean;
  /** Verbosity: 0=minimal, 1=standard, 2=verbose. */
  live_feedback_verbosity: number;
  /** Whether live coaching messages are read aloud via text-to-speech. */
  live_feedback_tts_enabled: boolean;
  /** Name of the selected TTS voice (SpeechSynthesisVoice.name). Null = auto. */
  live_feedback_tts_voice: string | null;
  /** Per-HUD visibility toggles. */
  hud_vsmode_visible: boolean;
  hud_smoothness_visible: boolean;
  hud_stats_visible: boolean;
  hud_feedback_visible: boolean;
  /** Whether the post-session overview card is shown after each run. */
  hud_post_session_visible: boolean;
}

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

// ─── Stats panel OCR ──────────────────────────────────────────────────────────

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

/** Live coaching notification (from mouse hook or stats OCR). */
export interface LiveFeedback {
  message: string;
  /** "positive" | "tip" | "warning" */
  kind: "positive" | "tip" | "warning";
  /** Which metric key triggered this. */
  metric: string;
}
