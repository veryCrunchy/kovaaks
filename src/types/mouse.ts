// ─── Mouse movement metrics ────────────────────────────────────────────────────

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

/** A single downsampled cursor position sample recorded during a session. */
export interface RawPositionPoint {
  /** Absolute screen X in physical pixels. */
  x: number;
  /** Absolute screen Y in physical pixels. */
  y: number;
  /** Milliseconds since session start. */
  timestamp_ms: number;
  /** True when this sample coincides with a left-button click. */
  is_click: boolean;
}

/**
 * A low-resolution JPEG frame captured from the centre of the game screen
 * during a session (5 fps, ≤320 px wide, quality 20).  Used as an underlay
 * in the mouse-path replay viewer so the user can see where targets were
 * relative to their cursor movement.
 */
export interface ScreenFrame {
  /** Milliseconds since session start. */
  timestamp_ms: number;
  /** Standard base64-encoded JPEG (RFC 4648). Use as `data:image/jpeg;base64,${jpeg_b64}`. */
  jpeg_b64: string;
}
