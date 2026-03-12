// ─── Design Tokens ─────────────────────────────────────────────────────────────
// Single source of truth for colours, typography, and scenario metadata.

export const SCENARIO_COLORS: Record<string, string> = {
  Tracking:          "#60a5fa",
  TargetSwitching:   "#f472b6",
  StaticClicking:    "#a78bfa",
  DynamicClicking:   "#fb923c",
  MovingClicking:    "#fb923c",
  OneShotClicking:   "#a78bfa",
  MultiHitClicking:  "#f472b6",
  ReactiveClicking:  "#fb923c",
  AccuracyDrill:     "#34d399",
  Unknown:           "rgba(255,255,255,0.3)",
};

export const SCENARIO_LABELS: Record<string, string> = {
  Tracking:          "Tracking",
  TargetSwitching:   "Target Switch",
  StaticClicking:    "Static Click",
  DynamicClicking:   "Dynamic Click",
  MovingClicking:    "Dynamic Click",
  OneShotClicking:   "Static Click",
  MultiHitClicking:  "Target Switch",
  ReactiveClicking:  "Dynamic Click",
  AccuracyDrill:     "Accuracy",
  Unknown:           "Unknown",
};

export const C = {
  // Backgrounds — pulled from KovaaK's palette at runtime via CSS vars
  bg:           "var(--am-bg-deep)",
  glass:        "rgba(var(--am-bg-deep-rgb), 0.88)",
  glassDark:    "rgba(var(--am-bg-deep-rgb), 0.94)",
  surface:      "rgba(var(--am-surface-rgb), 0.06)",
  surfaceHover: "rgba(var(--am-surface-rgb), 0.10)",

  // Borders
  border:       "rgba(255,255,255,0.08)",
  borderSub:    "rgba(255,255,255,0.05)",
  borderBright: "rgba(255,255,255,0.14)",

  // Accent — resolved at runtime via CSS custom property --am-accent
  accent:       "var(--am-accent)",
  accentDim:    "var(--am-accent-dim)",
  accentBorder: "var(--am-accent-border)",
  accentGlow:   "var(--am-accent-glow)",

  // Text hierarchy
  text:         "#ffffff",
  textSub:      "var(--am-text-sub)",
  textMuted:    "rgba(255,255,255,0.45)",
  textFaint:    "rgba(255,255,255,0.22)",
  textDisabled: "rgba(255,255,255,0.15)",

  // Semantic — resolved at runtime from KovaaK's palette
  danger:       "var(--am-danger)",
  dangerDim:    "rgba(var(--am-danger-rgb), 0.12)",
  dangerBorder: "rgba(var(--am-danger-rgb), 0.25)",
  warn:         "#ffd700",
  warnDim:      "rgba(255,215,0,0.12)",
  info:         "#60a5fa",
  infoDim:      "rgba(96,165,250,0.12)",
} as const;

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns an accent color with arbitrary alpha for use in inline styles.
 * Replaces the `${C.accent}XX` hex-alpha concatenation pattern.
 * @param hexByte - two hex digits for the alpha channel, e.g. "22" ≈ 13% opacity.
 */
export function accentAlpha(hexByte: string): string {
  const alpha = (parseInt(hexByte, 16) / 255).toFixed(3);
  return `rgba(var(--am-accent-rgb), ${alpha})`;
}

export function scenarioColor(type: string): string {
  return SCENARIO_COLORS[type] ?? SCENARIO_COLORS.Unknown;
}

export function fmt(v: number | null | undefined, dec = 0): string {
  if (v == null) return "--";
  return v.toFixed(dec);
}

export function fmtScore(n: number): string {
  return n.toLocaleString();
}

export function fmtDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function fmtAccuracy(
  hits: number | null | undefined,
  shots: number | null | undefined,
  pct: number | null | undefined,
): string {
  if (pct != null) return `${pct.toFixed(1)}%`;
  if (hits != null && shots != null && shots > 0)
    return `${((hits / shots) * 100).toFixed(1)}%`;
  return "--";
}
