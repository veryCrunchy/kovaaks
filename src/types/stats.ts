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

export interface AppSettings {
  stats_dir: string;
  region: RegionRect | null;
  ocr_poll_ms: number;
  overlay_visible: boolean;
  username: string;
  monitor_index: number;
  /** Friends to compare scores against (rich profiles from KovaaK's API) */
  friends: FriendProfile[];
  /** Optional screen region for OCR-reading the scenario name at session start */
  scenario_region: RegionRect | null;
  /** Username of the friend chosen as battle opponent in VS mode */
  selected_friend: string | null;
  /**
   * Mouse DPI/CPI used to normalise smoothness metrics.
   * avg_speed is divided by (mouse_dpi / 800) so scores are comparable
   * across different sensitivity setups. Defaults to 800.
   */
  mouse_dpi: number;
}

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
}
