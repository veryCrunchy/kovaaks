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
  // Backgrounds
  bg:           "#06060e",
  glass:        "rgba(10, 10, 18, 0.88)",
  glassDark:    "rgba(5, 5, 12, 0.94)",
  surface:      "rgba(255,255,255,0.04)",
  surfaceHover: "rgba(255,255,255,0.07)",

  // Borders
  border:       "rgba(255,255,255,0.08)",
  borderSub:    "rgba(255,255,255,0.05)",
  borderBright: "rgba(255,255,255,0.14)",

  // Accent (green)
  accent:       "#00f5a0",
  accentDim:    "rgba(0,245,160,0.12)",
  accentBorder: "rgba(0,245,160,0.25)",
  accentGlow:   "rgba(0,245,160,0.3)",

  // Text hierarchy
  text:         "#ffffff",
  textSub:      "rgba(255,255,255,0.7)",
  textMuted:    "rgba(255,255,255,0.45)",
  textFaint:    "rgba(255,255,255,0.22)",
  textDisabled: "rgba(255,255,255,0.15)",

  // Semantic
  danger:       "#ff4d4d",
  dangerDim:    "rgba(255,77,77,0.12)",
  dangerBorder: "rgba(255,77,77,0.25)",
  warn:         "#ffd700",
  warnDim:      "rgba(255,215,0,0.12)",
  info:         "#60a5fa",
  infoDim:      "rgba(96,165,250,0.12)",
} as const;

// ─── Helpers ───────────────────────────────────────────────────────────────────

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
