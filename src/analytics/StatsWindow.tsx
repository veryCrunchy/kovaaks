import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LeaderboardBrowser, ScenarioLeaderboardPanel } from "./LeaderboardBrowser";
import { DebugTab } from "./DebugTab";
import { MousePathViewer } from "./MousePathViewer";
import type {
  ReplayData,
  BridgeRunSnapshot,
  BridgeRunTimelinePoint,
} from "../types/mouse";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
  ReferenceArea,
  TooltipProps,
} from "recharts";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface SmoothnessSnapshot {
  composite: number;
  jitter: number;
  overshoot_rate: number;
  velocity_std: number;
  path_efficiency: number;
  avg_speed: number;
  click_timing_cv: number;
  correction_ratio: number;
  directional_bias: number;
}

interface StatsPanelSnapshot {
  scenario_type: string;
  kills: number | null;
  avg_kps: number | null;
  accuracy_pct: number | null;
  total_damage: number | null;
  avg_ttk_ms: number | null;
  best_ttk_ms: number | null;
  ttk_std_ms: number | null;
  accuracy_trend: number | null;
}

interface ShotTimingSnapshot {
  paired_shot_hits: number;
  avg_fire_to_hit_ms: number | null;
  p90_fire_to_hit_ms: number | null;
  avg_shots_to_hit: number | null;
  corrective_shot_ratio: number | null;
}

interface SessionRecord {
  id: string;
  scenario: string;
  score: number;
  accuracy: number;
  kills: number;
  deaths: number;
  duration_secs: number;
  timestamp: string;
  smoothness: SmoothnessSnapshot | null;
  stats_panel: StatsPanelSnapshot | null;
  shot_timing?: ShotTimingSnapshot | null;
  has_replay: boolean;
}

interface BridgeParsedEvent {
  ev: string;
  value?: number | null;
  delta?: number | null;
  total?: number | null;
  raw?: string;
}

type Tab = "overview" | "movement" | "performance" | "coaching" | "replay" | "leaderboard";

// ─── Constants ─────────────────────────────────────────────────────────────────

const SEV_COLOR = {
  high: "#ff4d4d",
  medium: "#ffd700",
  low: "#00b4ff",
  good: "#00f5a0",
} as const;

const CARD_STYLE: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 10,
  padding: "14px 18px",
  flex: 1,
  minWidth: 120,
};

const CHART_STYLE: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 12,
  padding: "16px 20px",
};

const TOOLTIP_STYLE: React.CSSProperties = {
  background: "rgba(12,12,20,0.95)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip the KovaaK's timestamp suffix from a scenario name so that runs of
 * the same scenario are grouped together regardless of how the name was stored.
 *
 * Handles all known formats, e.g.:
 *   "VT Aether Novice S5 - Challenge - 2026.02.25-12.15.10 Stats" → "VT Aether Novice S5"
 *   "Gridshot Ultimate - Challenge Start - 2024.01.15-12.30.45"   → "Gridshot Ultimate"
 */
function normalizeScenario(name: string): string {
  const m = name.match(/\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}/);
  if (!m || m.index === undefined) return name;
  const sep = name.lastIndexOf(" - ", m.index);
  return sep >= 0 ? name.slice(0, sep) : name;
}

function parseTimestamp(ts: string): Date | null {
  if (!ts) return null;
  const [datePart, timePart] = ts.split("-");
  if (!datePart || !timePart) return null;
  const [y, mo, d] = datePart.split(".").map(Number);
  const [h, mi, s] = timePart.split(".").map(Number);
  return new Date(y, mo - 1, d, h, mi, s);
}

function formatDateTime(ts: string): string {
  const d = parseTimestamp(ts);
  if (!d) return ts;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtScore(n: number) {
  return Math.round(n).toLocaleString();
}

function fmtDuration(secs: number) {
  if (secs < 60) return `${Math.round(secs)}s`;
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
}

function mean(arr: number[]) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((v) => (v - m) ** 2)));
}

function linearRegression(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? ys[0] : 0 };
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxy = xs.reduce((a, xi, i) => a + xi * ys[i], 0);
  const sxx = xs.reduce((a, xi) => a + xi ** 2, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx ** 2);
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

function rollingMean(arr: number[], window: number): (number | null)[] {
  return arr.map((_, i) => {
    if (i < window - 1) return null;
    const slice = arr.slice(i - window + 1, i + 1);
    return Math.round(mean(slice));
  });
}

function percentileOf(sortedArr: number[], p: number): number {
  if (!sortedArr.length) return 0;
  const idx = Math.max(0, Math.ceil((sortedArr.length * p) / 100) - 1);
  return sortedArr[idx];
}

interface RunMomentInsight {
  id: string;
  level: "good" | "tip" | "warning";
  title: string;
  detail: string;
  metric: "spm" | "accuracy" | "kps" | "damage_eff";
  startSec: number;
  endSec: number;
}

function runAvg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, val) => sum + val, 0) / values.length;
}

function runValuesInRange(
  points: BridgeRunTimelinePoint[],
  startSec: number,
  endSec: number,
  pick: (point: BridgeRunTimelinePoint) => number | null,
): number[] {
  return points
    .filter((point) => point.t_sec >= startSec && point.t_sec <= endSec)
    .map(pick)
    .filter((val): val is number => val != null && Number.isFinite(val));
}

interface RunWindowShotStats {
  shotsFired: number;
  shotsHit: number;
  hitRatePct: number;
  shotsPerHit: number;
}

function runShotStatsInRange(
  points: BridgeRunTimelinePoint[],
  startSec: number,
  endSec: number,
): RunWindowShotStats | null {
  const window = points.filter((point) => point.t_sec >= startSec && point.t_sec <= endSec);
  if (window.length < 2) return null;

  const firedVals = window
    .map((point) => point.shots_fired)
    .filter((val): val is number => val != null && Number.isFinite(val));
  const hitVals = window
    .map((point) => point.shots_hit)
    .filter((val): val is number => val != null && Number.isFinite(val));

  if (firedVals.length < 2 || hitVals.length < 2) return null;

  const shotsFired = Math.max(0, Math.max(...firedVals) - Math.min(...firedVals));
  const shotsHit = Math.max(0, Math.max(...hitVals) - Math.min(...hitVals));
  if (shotsFired < 6) return null;

  const hitRatePct = shotsFired > 0 ? (shotsHit / shotsFired) * 100 : 0;
  const shotsPerHit = shotsHit > 0 ? shotsFired / shotsHit : shotsFired;

  return {
    shotsFired,
    shotsHit,
    hitRatePct,
    shotsPerHit,
  };
}

function buildRunMomentInsights(
  points: BridgeRunTimelinePoint[],
  durationSecs: number | null | undefined,
): RunMomentInsight[] {
  if (points.length < 4) return [];
  const totalSecs = Math.max(1, Math.round(durationSecs ?? points[points.length - 1].t_sec));

  const earlyStart = 0;
  const earlyEnd = Math.max(1, Math.floor(totalSecs / 3));
  const lateStart = Math.max(0, Math.floor((totalSecs * 2) / 3));
  const lateEnd = totalSecs;

  const earlySpm = runAvg(runValuesInRange(points, earlyStart, earlyEnd, (p) => p.score_per_minute));
  const lateSpm = runAvg(runValuesInRange(points, lateStart, lateEnd, (p) => p.score_per_minute));
  const earlyAcc = runAvg(runValuesInRange(points, earlyStart, earlyEnd, (p) => p.accuracy_pct));
  const lateAcc = runAvg(runValuesInRange(points, lateStart, lateEnd, (p) => p.accuracy_pct));
  const earlyShotStats = runShotStatsInRange(points, earlyStart, earlyEnd);
  const lateShotStats = runShotStatsInRange(points, lateStart, lateEnd);

  const midStart = earlyEnd;
  const midEnd = Math.max(midStart + 1, lateStart);
  const thirds = [
    { label: "opening", startSec: earlyStart, endSec: earlyEnd },
    { label: "mid-run", startSec: midStart, endSec: midEnd },
    { label: "closing", startSec: lateStart, endSec: lateEnd },
  ]
    .map((window) => ({
      ...window,
      stats: runShotStatsInRange(points, window.startSec, window.endSec),
    }))
    .filter((window) => window.stats != null) as Array<{
    label: string;
    startSec: number;
    endSec: number;
    stats: RunWindowShotStats;
  }>;

  const peakSpmPoint = points
    .filter((p) => p.score_per_minute != null)
    .reduce<BridgeRunTimelinePoint | null>((best, curr) => {
      if (curr.score_per_minute == null) return best;
      if (!best || best.score_per_minute == null) return curr;
      return curr.score_per_minute > best.score_per_minute ? curr : best;
    }, null);

  const minAccPoint = points
    .filter((p) => p.accuracy_pct != null)
    .reduce<BridgeRunTimelinePoint | null>((worst, curr) => {
      if (curr.accuracy_pct == null) return worst;
      if (!worst || worst.accuracy_pct == null) return curr;
      return curr.accuracy_pct < worst.accuracy_pct ? curr : worst;
    }, null);

  const moments: RunMomentInsight[] = [];

  if (
    earlySpm != null
    && lateSpm != null
    && earlySpm > 0
    && (earlySpm - lateSpm) / earlySpm > 0.12
  ) {
    const accDelta = earlyAcc != null && lateAcc != null ? lateAcc - earlyAcc : null;
    const improvedAccuracy = accDelta != null && accDelta >= 2.5;

    moments.push({
      id: "moment-late-spm-fade",
      level: improvedAccuracy ? "tip" : "warning",
      title: improvedAccuracy ? "Speed→Accuracy Trade-off Late" : "Late-Run Pace Drop",
      detail: improvedAccuracy
        ? `Pace fell from ${Math.round(earlySpm)} to ${Math.round(lateSpm)} SPM while accuracy improved by ${accDelta!.toFixed(1)}%. Keep this control and add pace back gradually.`
        : `Pace fell from ${Math.round(earlySpm)} to ${Math.round(lateSpm)} SPM in the final third without a meaningful accuracy gain.`,
      metric: "spm",
      startSec: lateStart,
      endSec: lateEnd,
    });
  }

  if (earlyAcc != null && lateAcc != null && lateAcc - earlyAcc >= 3) {
    moments.push({
      id: "moment-accuracy-build",
      level: "good",
      title: "Accuracy Stabilized",
      detail:
        earlyShotStats && lateShotStats
          ? `Accuracy improved ${earlyAcc.toFixed(1)}% → ${lateAcc.toFixed(1)}%, and shots-per-hit improved ${earlyShotStats.shotsPerHit.toFixed(2)} → ${lateShotStats.shotsPerHit.toFixed(2)}.`
          : `Accuracy improved from ${earlyAcc.toFixed(1)}% to ${lateAcc.toFixed(1)}% late-run.`,
      metric: "accuracy",
      startSec: lateStart,
      endSec: lateEnd,
    });
  }

  if (thirds.length > 0) {
    const worstCorrectionWindow = [...thirds]
      .sort((a, b) => b.stats.shotsPerHit - a.stats.shotsPerHit)[0];

    if (worstCorrectionWindow.stats.shotsPerHit >= 1.6) {
      moments.push({
        id: "moment-correction-window",
        level: worstCorrectionWindow.stats.shotsPerHit >= 2.0 ? "warning" : "tip",
        title: "Correction-Heavy Window",
        detail: `${worstCorrectionWindow.label} needed ${worstCorrectionWindow.stats.shotsPerHit.toFixed(2)} shots per hit (${worstCorrectionWindow.stats.hitRatePct.toFixed(0)}% hit conversion).`,
        metric: "damage_eff",
        startSec: worstCorrectionWindow.startSec,
        endSec: worstCorrectionWindow.endSec,
      });
    }
  }

  if (peakSpmPoint?.score_per_minute != null) {
    moments.push({
      id: "moment-peak-spm",
      level: "good",
      title: "Peak Tempo Window",
      detail:
        peakSpmPoint.accuracy_pct != null
          ? `Best pace reached ${Math.round(peakSpmPoint.score_per_minute)} SPM at ${Math.round(peakSpmPoint.t_sec)}s with ${peakSpmPoint.accuracy_pct.toFixed(1)}% accuracy.`
          : `Best pace reached ${Math.round(peakSpmPoint.score_per_minute)} SPM at ${Math.round(peakSpmPoint.t_sec)}s.`,
      metric: "spm",
      startSec: Math.max(0, peakSpmPoint.t_sec - 4),
      endSec: Math.min(totalSecs, peakSpmPoint.t_sec + 4),
    });
  }

  if (minAccPoint?.accuracy_pct != null && minAccPoint.accuracy_pct < 78) {
    moments.push({
      id: "moment-low-accuracy",
      level: "tip",
      title: "Low Accuracy Pocket",
      detail: `Lowest point reached ${minAccPoint.accuracy_pct.toFixed(1)}% accuracy around ${Math.round(minAccPoint.t_sec)}s.`,
      metric: "accuracy",
      startSec: Math.max(0, minAccPoint.t_sec - 4),
      endSec: Math.min(totalSecs, minAccPoint.t_sec + 4),
    });
  }

  const levelRank: Record<RunMomentInsight["level"], number> = {
    warning: 0,
    tip: 1,
    good: 2,
  };

  return moments
    .sort((a, b) => levelRank[a.level] - levelRank[b.level])
    .slice(0, 4);
}

function formatRunWindow(startSec: number, endSec: number): string {
  const start = Math.max(0, Math.round(startSec));
  const end = Math.max(start, Math.round(endSec));
  return `${start}s–${end}s`;
}

function runMomentAction(moment: RunMomentInsight): string {
  switch (moment.id) {
    case "moment-late-spm-fade":
      return moment.level === "warning"
        ? "Do 3 reps where you hold your opening rhythm into the final third before trying to push speed."
        : "Keep this late-run control, then add pace back in 3–5% steps while preserving conversion.";
    case "moment-correction-window":
      return "Run this window at ~90% speed and focus on first-shot placement; only speed up after conversion stabilizes.";
    case "moment-low-accuracy":
      return "Pre-aim one target ahead in this window and delay the click slightly until the cursor is settled.";
    case "moment-accuracy-build":
      return "Use your opening pace for the first 5s, then apply this same settled timing earlier in the run.";
    case "moment-peak-spm":
      return "Anchor your rhythm to this window and repeat it across adjacent segments instead of short bursts.";
    default:
      return "Replay this window for 3 focused reps and change only one variable (speed, confirmation timing, or target switch plan).";
  }
}

// ─── Warmup detection ─────────────────────────────────────────────────────────

/** Sessions within a single continuous play block (gap < WARMUP_GAP_MS). */
interface PlayBlock {
  sessions: SessionRecord[];
  /** ms gap from last session of previous block; null = first ever block. */
  gapBeforeMs: number | null;
}

const WARMUP_GAP_MS = 6 * 60 * 60 * 1000; // 6 h gap → new play block
const WARMUP_SESSION_COUNT = 2;             // first N sessions in a new block = candidates
const WARMUP_SCORE_SD = 0.8;               // below (avg − N·σ) = warmup candidate

function groupIntoPlayBlocks(sorted: SessionRecord[]): PlayBlock[] {
  if (sorted.length === 0) return [];
  const blocks: PlayBlock[] = [];
  let current: SessionRecord[] = [sorted[0]];
  let blockGap: number | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const prev = parseTimestamp(sorted[i - 1].timestamp)?.getTime() ?? 0;
    const cur  = parseTimestamp(sorted[i].timestamp)?.getTime() ?? 0;
    const gap  = cur - prev;
    if (gap > WARMUP_GAP_MS) {
      blocks.push({ sessions: current, gapBeforeMs: blockGap });
      blockGap = gap;
      current = [sorted[i]];
    } else {
      current.push(sorted[i]);
    }
  }
  blocks.push({ sessions: current, gapBeforeMs: blockGap });
  return blocks;
}

/**
 * Returns a Set of session IDs classified as warmup runs.
 * A session is warmup if it's one of the first N sessions in a play block
 * that starts after a 6+ hour gap AND its score is below (avg − 0.8σ).
 * Requires ≥ 5 sessions for a reliable baseline.
 */
function classifyWarmup(sorted: SessionRecord[]): Set<string> {
  if (sorted.length < 5) return new Set();
  const scores = sorted.map((r) => r.score);
  const avg = mean(scores);
  const sd  = stddev(scores);
  const threshold = avg - WARMUP_SCORE_SD * sd;
  const warmupIds = new Set<string>();
  for (const block of groupIntoPlayBlocks(sorted)) {
    if (!block.gapBeforeMs || block.gapBeforeMs < WARMUP_GAP_MS) continue;
    for (const s of block.sessions.slice(0, WARMUP_SESSION_COUNT)) {
      if (s.score < threshold) warmupIds.add(s.id);
    }
  }
  return warmupIds;
}

type SessionFilter = "all" | "warmup" | "warmedup";

// ─── Sub-components ────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div style={CARD_STYLE}>
      <div
        style={{
          fontSize: 11,
          color: "rgba(255,255,255,0.38)",
          textTransform: "uppercase",
          letterSpacing: 1,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontSize: "clamp(14px, 2.5vw, 20px)",
            fontWeight: 700,
            color: accent ?? "#fff",
            lineHeight: 1,
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </span>
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: "rgba(255,255,255,0.4)",
        textTransform: "uppercase",
        letterSpacing: 1,
        marginBottom: 14,
      }}
    >
      {children}
    </div>
  );
}

function MiniTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div style={{ ...TOOLTIP_STYLE, padding: "10px 14px", minWidth: 160 }}>
      <div
        style={{ color: "rgba(255,255,255,0.45)", marginBottom: 6, fontSize: 11 }}
      >
        {d?.dateLabel}
      </div>
      {payload.map((p) => (
        <div
          key={p.dataKey}
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
            marginBottom: 2,
          }}
        >
          <span style={{ color: "rgba(255,255,255,0.55)" }}>{p.name}</span>
          <span style={{ fontWeight: 700, color: p.color as string }}>
            {typeof p.value === "number"
              ? p.value >= 1000
                ? fmtScore(p.value)
                : p.value.toFixed(2)
              : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Insight detection ────────────────────────────────────────────────────────

interface Insight {
  kind: "issue" | "positive";
  severity?: "high" | "medium" | "low";
  /** "mouse" = derived from smoothness metrics; "game" = derived from stats-panel data */
  category: "mouse" | "game";
  title: string;
  description: string;
}

function detectInsights(records: SessionRecord[]): Insight[] {
  const smoothRecords = records.filter((r) => r.smoothness !== null);
  const panelRecords  = records.filter((r) => r.stats_panel !== null);
  const shotTimingRecords = records.filter((r) => r.shot_timing != null);
  const insights: Insight[] = [];

  // Derive scenario type from the most recent panel record that has one
  const scenarioType =
    panelRecords.length > 0
      ? (panelRecords[panelRecords.length - 1].stats_panel!.scenario_type ?? "Unknown")
      : "Unknown";

  const isTracking = scenarioType === "Tracking";
  const isOneShot  = scenarioType === "OneShotClicking";
  const isMultiHit = scenarioType === "MultiHitClicking";
  const isReactive = scenarioType === "ReactiveClicking";
  const isAccuracy = scenarioType === "AccuracyDrill";

  // ── Mouse / smoothness insights ──────────────────────────────────────────────
  if (smoothRecords.length > 0) {
    const g = (fn: (s: SmoothnessSnapshot) => number) =>
      mean(smoothRecords.map((r) => fn(r.smoothness!)));

    const composite  = g((s) => s.composite);
    const jitter     = g((s) => s.jitter);
    const overshoot  = g((s) => s.overshoot_rate);
    const path       = g((s) => s.path_efficiency);
    const correction = g((s) => s.correction_ratio);
    const bias       = g((s) => s.directional_bias);
    const clickCV    = g((s) => s.click_timing_cv);
    const velStd     = g((s) => s.velocity_std);

    // Composite smoothness
    const smoothPositiveCtx = isTracking ? "tracking lines are clean and on-axis"
      : isOneShot   ? "flicks are landing accurately with minimal correction"
      : isMultiHit  ? "movement between targets is fluid"
      : isReactive  ? "flick quality is high — decisions are fast and clean"
      : isAccuracy  ? "consistent micro-aim is translating into reliable shot placement"
      :               "movement is consistently clean";

    const smoothHighIssueCtx = isTracking ? "Lower sensitivity and deliberate slow-tracking drills will build a steadier aim line."
      : isOneShot   ? "Jittery flicks hurt first-bullet accuracy on one-taps. Wrist stability drills will help."
      : isMultiHit  ? "Shaky movement wastes shots. Relax your grip and practise controlled tracking."
      : isReactive  ? "Clean decisive flicks lower TTK. Work on eliminating tension from arm and wrist."
      :               "Consider lowering your sensitivity or using a larger mousepad.";

    if (composite >= 75)
      insights.push({ kind: "positive", category: "mouse", title: "Great movement quality", description: `Overall smoothness ${composite.toFixed(1)}/100 — your ${smoothPositiveCtx}.` });
    else if (composite < 40)
      insights.push({ kind: "issue", severity: "high", category: "mouse", title: "Movement needs work", description: `Overall smoothness ${composite.toFixed(1)}/100. ${smoothHighIssueCtx}` });
    else if (composite < 60)
      insights.push({ kind: "issue", severity: "medium", category: "mouse", title: "Smoothness has room to grow", description: `Overall smoothness ${composite.toFixed(1)}/100. Use short 5–8 minute blocks at ~90% speed and prioritize cleaner ${isTracking ? "tracking lines" : "first-shot paths"}.` });

    // Jitter / wobble
    const jitterHighCtx = isTracking
      ? "Your cursor wobbles off the tracking line. Try relaxing your grip — mouse wobble usually comes from grip tension, not from moving too fast."
      : isAccuracy
      ? "Micro-tremor on small precision targets costs you hits. Try a lighter grip, more wrist support, or slightly lower sensitivity."
      : "Your cursor shakes between movements. Check if your mouse feet are worn, relax your grip, or try moving with your arm rather than your wrist.";

    if (jitter > 0.5)
      insights.push({ kind: "issue", severity: "high", category: "mouse", title: "A lot of aim wobble", description: jitterHighCtx });
    else if (jitter > 0.3)
      insights.push({ kind: "issue", severity: "medium", category: "mouse", title: "Some aim wobble", description: isTracking
        ? "Cursor drifts off the tracking line between movements. Relax your grip and let your elbow rest comfortably."
        : "Some wobble in your movements. Relax your grip and make sure your elbow is supported." });
    else if (jitter < 0.15)
      insights.push({ kind: "positive", category: "mouse", title: "Rock-steady aim", description: `Very low wobble${isTracking ? " — cursor stays glued to the target with almost no lateral drift" : " — clean, shake-free aim line"}.` });

    // Overshoot / correction: prefer shot-anchored metrics when available.
    if (!isTracking && shotTimingRecords.length >= 2) {
      const shotVals = shotTimingRecords
        .map((r) => r.shot_timing?.avg_shots_to_hit)
        .filter((v): v is number => v != null && Number.isFinite(v));
      const correctiveVals = shotTimingRecords
        .map((r) => r.shot_timing?.corrective_shot_ratio)
        .filter((v): v is number => v != null && Number.isFinite(v));
      const latencyVals = shotTimingRecords
        .map((r) => r.shot_timing?.avg_fire_to_hit_ms)
        .filter((v): v is number => v != null && Number.isFinite(v));

      const avgShotsToHit = shotVals.length > 0 ? mean(shotVals) : null;
      const avgCorrectiveRatio = correctiveVals.length > 0 ? mean(correctiveVals) : null;
      const avgFireToHitMs = latencyVals.length > 0 ? mean(latencyVals) : null;

      const hasShotsToHit = avgShotsToHit != null;
      const hasCorrective = avgCorrectiveRatio != null;
      const hasLatency = avgFireToHitMs != null;

      if (!hasShotsToHit && !hasCorrective && !hasLatency) {
        // No usable shot-timing values yet — fall back to movement heuristic below.
      } else {

        const severeCorrection = (hasShotsToHit && avgShotsToHit > 1.75)
          || (hasCorrective && avgCorrectiveRatio > 0.48)
          || (hasLatency && avgFireToHitMs > 320);
        const mildCorrection = (hasShotsToHit && avgShotsToHit > 1.35)
          || (hasCorrective && avgCorrectiveRatio > 0.28)
          || (hasLatency && avgFireToHitMs > 220);

        if (severeCorrection) {
          insights.push({
            kind: "issue",
            severity: "high",
            category: "mouse",
            title: "High post-shot correction",
            description: `Shot recovery is heavy (${avgShotsToHit?.toFixed(2) ?? "—"} shots/hit, ${avgCorrectiveRatio != null ? `${(avgCorrectiveRatio * 100).toFixed(0)}%` : "—"} corrective hits, ${avgFireToHitMs?.toFixed(0) ?? "—"}ms fired→hit). Prioritize first-shot placement, then add pace.`,
          });
        } else if (mildCorrection) {
          insights.push({
            kind: "issue",
            severity: "low",
            category: "mouse",
            title: "Moderate post-shot correction",
            description: `Some shots still need recovery (${avgShotsToHit?.toFixed(2) ?? "—"} shots/hit, ${avgCorrectiveRatio != null ? `${(avgCorrectiveRatio * 100).toFixed(0)}%` : "—"} corrective hits). Stabilize first-shot conversion before pushing speed.`,
          });
        } else {
          insights.push({
            kind: "positive",
            category: "mouse",
            title: "Clean first-shot conversion",
            description: `Shot timing is efficient (${avgShotsToHit?.toFixed(2) ?? "—"} shots/hit, ${avgCorrectiveRatio != null ? `${(avgCorrectiveRatio * 100).toFixed(0)}%` : "—"} corrective hits, ${avgFireToHitMs?.toFixed(0) ?? "—"}ms fired→hit).`,
          });
        }
        // Skip heuristic overshoot logic when direct shot timing is available.
        // Continue with remaining insights.
        
        
      }
      if (hasShotsToHit || hasCorrective || hasLatency) {
        // already handled via shot-anchored logic
      } else {
        const overshootHighCtx = isOneShot
          ? "You’re passing through targets on many flicks. Decelerate slightly in the last stretch so first shots land on target."
          : isReactive
          ? "Overshooting adds recovery time before you can fire. Brake into the target zone instead of snapping through it."
          : "You regularly overshoot targets after flicks. Use controlled deceleration reps and focus on clean stops.";

        const overshootLowCtx = isOneShot
          ? "Slight overshoot on some flicks. A little more braking right before the target will improve your first-shot accuracy."
          : "Slight overshoot on some movements. Practice stopping cleanly at the target instead of correcting back.";

        const overshootGoodCtx = isOneShot
          ? "flicks land on target on the first try — no wasted bullet"
          : "flicks land accurately without drifting past";

        if (overshoot > 0.4)
          insights.push({ kind: "issue", severity: "high", category: "mouse", title: "Overshooting often", description: overshootHighCtx });
        else if (overshoot > 0.2)
          insights.push({ kind: "issue", severity: "low", category: "mouse", title: "Slight overshoot", description: overshootLowCtx });
        else if (overshoot < 0.1)
          insights.push({ kind: "positive", category: "mouse", title: "Clean, precise flicks", description: `Very low overshoot — ${overshootGoodCtx}.` });
      }
    } else {
      const overshootHighCtx = isOneShot
        ? "You’re passing through targets on many flicks. Decelerate slightly in the last stretch so first shots land on target."
        : isReactive
        ? "Overshooting adds recovery time before you can fire. Brake into the target zone instead of snapping through it."
        : "You regularly overshoot targets after flicks. Use controlled deceleration reps and focus on clean stops.";

      const overshootLowCtx = isOneShot
        ? "Slight overshoot on some flicks. A little more braking right before the target will improve your first-shot accuracy."
        : "Slight overshoot on some movements. Practice stopping cleanly at the target instead of correcting back.";

      const overshootGoodCtx = isOneShot
        ? "flicks land on target on the first try — no wasted bullet"
        : "flicks land accurately without drifting past";

      if (overshoot > 0.4)
        insights.push({ kind: "issue", severity: "high", category: "mouse", title: "Overshooting often", description: overshootHighCtx });
      else if (overshoot > 0.2)
        insights.push({ kind: "issue", severity: "low", category: "mouse", title: "Slight overshoot", description: overshootLowCtx });
      else if (overshoot < 0.1)
        insights.push({ kind: "positive", category: "mouse", title: "Clean, precise flicks", description: `Very low overshoot — ${overshootGoodCtx}.` });
    }

    // Path quality
    const pathHighIssueCtx = isTracking
      ? "Your cursor weaves around the target instead of sticking to it. This usually means forearm tension or an overly tight grip — relax and try to follow the target in one smooth arc."
      : isAccuracy
      ? "Your cursor curves toward precision targets rather than going straight. Slow down and approach from a consistent angle each time to build reliable muscle memory."
      : "Your cursor takes a curved route to targets. This often comes from wrist tension or gripping too hard — relax and try to move with your whole arm.";

    const pathGoodCtx = isTracking
      ? "cursor stays locked on the tracking target with almost no drift"
      : "cursor travels in a nearly straight line to each target";

    if (path < 0.72)
      insights.push({ kind: "issue", severity: "high", category: "mouse", title: "Very curved aim paths", description: pathHighIssueCtx });
    else if (path < 0.82)
      insights.push({ kind: "issue", severity: "medium", category: "mouse", title: "Slightly curved paths", description: isTracking
        ? "Cursor drifts off the tracking line. Wrist or forearm tension is usually the cause — consciously relax between movements."
        : "Cursor curves a little on the way to targets. Wrist tension is usually the cause — try to move from the elbow." });
    else if (path > 0.92)
      insights.push({ kind: "positive", category: "mouse", title: "Straight, efficient paths", description: `Path quality ${(path * 100).toFixed(1)}% — ${pathGoodCtx}.` });

    // Over-aim / micro-corrections
    const corrHighCtx = isMultiHit
      ? "You're spending too long fine-tuning your aim on each target — on multi-hit scenarios, being decisive and committing earlier wins more damage. Slightly lower sensitivity can make small adjustments easier."
      : isReactive
      ? "Too much time adjusting after your initial flick adds to your kill time. Trust where your cursor lands and fire — hesitation costs more than a slight miss."
      : "A lot of small adjustments after each movement. This means you're not fully confident in your aim yet — try lowering sensitivity slightly so small corrections feel easier.";

    const corrGoodCtx = isReactive
      ? "reacting and committing to the kill in one clean motion"
      : "committing to each shot quickly and confidently";

    if (correction > 0.45)
      insights.push({ kind: "issue", severity: "medium", category: "mouse", title: "Too many micro-corrections", description: corrHighCtx });
    else if (correction < 0.2)
      insights.push({ kind: "positive", category: "mouse", title: "Confident, decisive aim", description: `Very few corrections needed — ${corrGoodCtx}.` });

    // Directional drift
    if (bias > 0.6)
      insights.push({ kind: "issue", severity: "medium", category: "mouse", title: "Drifting consistently one direction", description: "Your aim consistently overshoots to the same side. Check whether your mousepad is angled, or whether your elbow position is pulling your wrist in one direction." });
    else if (bias < 0.2)
      insights.push({ kind: "positive", category: "mouse", title: "Balanced in both directions", description: "No consistent left-right drift — your aim is well-calibrated in both directions." });

    // Click rhythm — only meaningful for clicking scenarios
    if (!isTracking) {
      const clickHighCtx = isMultiHit
        ? "Your clicks aren't evenly spaced on multi-hit targets — a steady rhythm maximises damage output. Click timing trainers can help lock in a consistent tempo."
        : isReactive
        ? "There's a gap between your cursor landing and clicking. Practice committing immediately — once your cursor is on the target, fire without hesitation."
        : "Click timing varies a lot between shots. Rhythm drills or click-timing trainers can help build a consistent firing tempo.";

      const clickGoodCtx = isMultiHit
        ? "rhythmic shots are maximising damage output on multi-hit targets"
        : "clicks land with a consistent, reliable rhythm";

      if (clickCV > 0.5)
        insights.push({ kind: "issue", severity: "low", category: "mouse", title: "Uneven click rhythm", description: clickHighCtx });
      else if (clickCV < 0.15)
        insights.push({ kind: "positive", category: "mouse", title: "Consistent click rhythm", description: `Very even click timing — ${clickGoodCtx}.` });
    }

    // Tracking-specific: speed consistency
    if (isTracking) {
      if (velStd > 0.6)
        insights.push({ kind: "issue", severity: "medium", category: "mouse", title: "Choppy tracking speed", description: `Speed varies ${(velStd * 100).toFixed(0)}% around your average — your cursor speeds up and brakes rather than smoothly following the target. Try anticipating where the target is going rather than reacting to where it is.` });
      else if (velStd < 0.3)
        insights.push({ kind: "positive", category: "mouse", title: "Smooth, even tracking speed", description: `Speed is very consistent (${(velStd * 100).toFixed(0)}% variation) — shows strong target prediction and relaxed arm control.` });
    }
  }

  // ── Game-stats insights ───────────────────────────────────────────────────
  if (panelRecords.length >= 3) {
    const withTrend = panelRecords.filter((r) => r.stats_panel!.accuracy_trend != null);
    if (withTrend.length >= 2) {
      const avgTrend = mean(withTrend.map((r) => r.stats_panel!.accuracy_trend!));
      if (avgTrend < -5) {
        const ctx = isTracking
          ? `On-target time drops ~${Math.abs(avgTrend).toFixed(1)}% from the first to the second half of each session. You're getting tired partway through — shorter sessions or a break between runs would help.`
          : `Accuracy drops ~${Math.abs(avgTrend).toFixed(1)}% from the first to the second half of each session. Mental fatigue sets in mid-session — try capping sessions at 30–45 minutes.`;
        insights.push({ kind: "issue", severity: "medium", category: "game", title: "Accuracy drops over time", description: ctx });
      } else if (avgTrend > 5) {
        const metric = isTracking ? "On-target time" : "Accuracy";
        insights.push({ kind: "positive", category: "game", title: "Gets better as you play", description: `${metric} improves ~${avgTrend.toFixed(1)}% as each session goes on — you warm up well. Consider a brief warm-up routine to get there faster.` });
      }
    }

    const withTtk = panelRecords.filter(
      (r) => r.stats_panel!.ttk_std_ms != null && r.stats_panel!.avg_ttk_ms != null,
    );
    if (withTtk.length >= 2) {
      const avgTtkStd  = mean(withTtk.map((r) => r.stats_panel!.ttk_std_ms!));
      const avgTtkMean = mean(withTtk.map((r) => r.stats_panel!.avg_ttk_ms!));
      const cv = avgTtkMean > 0 ? avgTtkStd / avgTtkMean : 0;
      const ttkGoodMs = isReactive ? 350 : 400;

      if (cv > 0.5) {
        const ctx = isReactive
          ? `Your reaction kill times vary a lot (${(cv * 100).toFixed(0)}% spread). Some targets you hit fast, others much slower — try pre-aiming spawn points so every reaction starts from the same position.`
          : isOneShot
          ? `Kill times are inconsistent (${(cv * 100).toFixed(0)}% spread) — some targets take much longer than others. Work on a consistent flick tempo regardless of target position.`
          : `Kill times vary a lot (${(cv * 100).toFixed(0)}% spread). Consistent pre-aiming and a steady engagement tempo would smooth this out.`;
        insights.push({ kind: "issue", severity: "medium", category: "game", title: "Kill speed varies a lot", description: ctx });
      } else if (cv < 0.2 && avgTtkMean < ttkGoodMs) {
        const ctx = isReactive
          ? `Avg kill time ${avgTtkMean.toFixed(0)}ms with very little variation — fast and consistent reactions.`
          : `Avg kill time ${avgTtkMean.toFixed(0)}ms with very little variation (${(cv * 100).toFixed(0)}% spread) — killing targets reliably every time.`;
        insights.push({ kind: "positive", category: "game", title: "Very consistent kill speed", description: ctx });
      }
    }

    // Accuracy benchmarks
    const withAcc = panelRecords.filter((r) => r.stats_panel!.accuracy_pct != null);
    if (withAcc.length >= 3) {
      const avgAcc        = mean(withAcc.map((r) => r.stats_panel!.accuracy_pct!));
      const goodThreshold = isTracking ? 65 : isMultiHit ? 50 : isAccuracy ? 75 : 58;
      const lowThreshold  = isTracking ? 40 : isMultiHit ? 30 : isAccuracy ? 50 : 38;

      if (avgAcc >= goodThreshold + 15) {
        const ctx = isTracking
          ? `${avgAcc.toFixed(1)}% on-target time — strong target lock throughout each session.`
          : isOneShot
          ? `${avgAcc.toFixed(1)}% on one-tap targets — nearly every flick is landing cleanly.`
          : `${avgAcc.toFixed(1)}% accuracy — very few wasted shots.`;
        insights.push({ kind: "positive", category: "game", title: "High accuracy", description: ctx });
      } else if (avgAcc < lowThreshold) {
        const ctx = isTracking
          ? `${avgAcc.toFixed(1)}% on-target time. Focus on staying with the target rather than chasing it. Lower sensitivity often helps with this.`
          : isMultiHit
          ? `${avgAcc.toFixed(1)}% accuracy — too many shots are missing. Focus on getting on target first, then shoot rather than shooting while still moving.`
          : isOneShot
          ? `${avgAcc.toFixed(1)}% on one-taps. Slow your flick down a little — getting placement right matters more than speed at this stage.`
          : `${avgAcc.toFixed(1)}% accuracy — slow down slightly and focus on hitting cleanly before worrying about speed.`;
        insights.push({ kind: "issue", severity: "medium", category: "game", title: "Low accuracy", description: ctx });
      }
    }
  }

  return insights;
}

function InsightCard({ ins }: { ins: Insight }) {
  const color = ins.kind === "positive" ? SEV_COLOR.good : SEV_COLOR[ins.severity!];

  return (
    <div
      style={{
        background: `${color}12`,
        border: `1px solid ${color}30`,
        borderRadius: 10,
        padding: "12px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 700, color, fontSize: 13 }}>{ins.title}</span>
        {ins.kind === "issue" && ins.severity && (
          <span
            style={{
              fontSize: 10,
              color: `${color}80`,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            {ins.severity === "high" ? "priority" : ins.severity === "medium" ? "worth fixing" : "minor"}
          </span>
        )}
      </div>
      <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.55)", lineHeight: 1.6 }}>
        {ins.description}
      </p>
    </div>
  );
}

// ─── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab({
  records,
  sorted,
  best,
  warmupIds,
}: {
  records: SessionRecord[];
  sorted: SessionRecord[];
  best: number;
  warmupIds: Set<string>;
}) {
  const avgScore = mean(records.map((r) => r.score));
  const accRecords = records.filter((r) => r.accuracy > 0);
  const avgAcc = accRecords.length ? mean(accRecords.map((r) => r.accuracy)) : null;
  const totalKills = records.reduce((s, r) => s + r.kills, 0);
  const killRecords = records.filter((r) => r.kills > 0);
  const avgKills = killRecords.length ? mean(killRecords.map((r) => r.kills)) : null;
  const latestRecord = sorted[sorted.length - 1];

  // ── Trend helpers (for enhanced score chart + half-delta cards) ──────────────
  const hasSmooth = records.some((r) => r.smoothness != null);
  const hasPanelAcc = records.some((r) => r.stats_panel?.accuracy_pct != null);
  const hasTtk = records.some((r) => r.stats_panel?.avg_ttk_ms != null);

  const trendScores = sorted.map((r) => r.score);
  const trendAvg = mean(trendScores);
  const trendSD = stddev(trendScores);
  const trendRolling = rollingMean(trendScores, 5);
  const trendXs = trendScores.map((_, i) => i + 1);
  const { slope: trendSlope, intercept: trendIntercept } = linearRegression(trendXs, trendScores);

  const chartData = sorted.map((r, i) => ({
    i: i + 1,
    score: Math.round(r.score),
    rolling: trendRolling[i],
    trendLine: Math.round(trendIntercept + trendSlope * (i + 1)),
    composite: r.smoothness?.composite != null ? +r.smoothness.composite.toFixed(1) : null,
    acc: r.stats_panel?.accuracy_pct != null ? +r.stats_panel.accuracy_pct.toFixed(1) : null,
    ttk: r.stats_panel?.avg_ttk_ms != null ? +r.stats_panel.avg_ttk_ms.toFixed(0) : null,
    dateLabel: formatDateTime(r.timestamp),
  }));

  function halfDelta(key: keyof (typeof chartData)[0], invert = false): string {
    const vals = chartData.map((d) => d[key]).filter((v): v is number => v !== null);
    if (vals.length < 4) return "—";
    const half = Math.floor(vals.length / 2);
    const first = mean(vals.slice(0, half));
    const second = mean(vals.slice(half));
    const delta = second - first;
    const pct = first !== 0 ? (delta / Math.abs(first)) * 100 : 0;
    const improved = invert ? delta < 0 : delta > 0;
    return `${delta > 0 ? "+" : ""}${pct.toFixed(1)}% ${improved ? "↑" : "↓"}`;
  }

  const deltaCards = [
    { label: "Score", key: "score" as const, invert: false, color: "#00f5a0" },
    ...(hasSmooth ? [{ label: "Smoothness", key: "composite" as const, invert: false, color: "#00b4ff" }] : []),
    ...(hasPanelAcc ? [{ label: "Accuracy", key: "acc" as const, invert: false, color: "#a78bfa" }] : []),
    ...(hasTtk ? [{ label: "Avg TTK", key: "ttk" as const, invert: true, color: "#ffd700" }] : []),
  ];

  const recentRuns = [...sorted].reverse().slice(0, 30);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Summary cards */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="Best Score" value={fmtScore(best)} accent="#00f5a0" />
        <StatCard label="Avg Score" value={fmtScore(avgScore)} />
        <StatCard label="Sessions" value={records.length.toString()} />
        {avgAcc !== null && (
          <StatCard
            label="Avg Accuracy"
            value={(avgAcc * 100).toFixed(1) + "%"}
            accent="#a78bfa"
          />
        )}
        {totalKills > 0 && (
          <StatCard
            label="Total Kills"
            value={totalKills.toLocaleString()}
            sub={avgKills ? `~${avgKills.toFixed(0)}/session` : undefined}
            accent="#ffd700"
          />
        )}
        {latestRecord && (
          <StatCard
            label="Last Played"
            value={formatDateTime(latestRecord.timestamp)}
            sub={`Score: ${fmtScore(latestRecord.score)}`}
          />
        )}
      </div>

      {/* Progress delta cards: later sessions vs earlier sessions */}
      {deltaCards.length > 1 && sorted.length >= 4 && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {deltaCards.map((c) => {
            const delta = halfDelta(c.key, c.invert);
            const improved = delta.includes("↑");
            const neutral = delta === "—";
            return (
              <div key={c.label} style={{ ...CARD_STYLE, minWidth: 130 }}>
                <div
                  style={{
                    fontSize: 11,
                    color: "rgba(255,255,255,0.38)",
                    textTransform: "uppercase",
                    letterSpacing: 1,
                    marginBottom: 6,
                  }}
                >
                  {c.label}
                </div>
                <div
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: neutral ? "rgba(255,255,255,0.3)" : improved ? "#00f5a0" : "#ff6b6b",
                  }}
                >
                  {delta}
                </div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 3 }}>
                  later sessions vs earlier
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Enhanced score chart with rolling avg + trend line + ±1σ band */}
      <div style={CHART_STYLE}>
        <SectionTitle>Score progression</SectionTitle>
        <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
          {[
            { color: "#00f5a0", label: "Score" },
            ...(trendScores.length >= 5 ? [{ color: "#ffd700", label: "5-session avg", dash: true }] : []),
            ...(trendScores.length >= 4 ? [{ color: "#ff9f43", label: "Trend", dash: true }] : []),
          ].map((l) => (
            <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 14,
                  height: 2,
                  borderRadius: 2,
                  background: l.color,
                  opacity: (l as { dash?: boolean }).dash ? 0.7 : 1,
                  backgroundImage: (l as { dash?: boolean }).dash
                    ? `repeating-linear-gradient(90deg,${l.color} 0,${l.color} 4px,transparent 4px,transparent 7px)`
                    : undefined,
                }}
              />
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>{l.label}</span>
            </div>
          ))}
          {trendSD > 0 && (
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", marginLeft: 4 }}>
              shaded = ±1σ range
            </span>
          )}
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="i"
              tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={52}
              tickFormatter={(v: number) =>
                v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
              }
            />
            <Tooltip content={<MiniTooltip />} />
            {trendSD > 0 && (
              <ReferenceArea
                y1={Math.round(trendAvg - trendSD)}
                y2={Math.round(trendAvg + trendSD)}
                fill="rgba(0,180,255,0.06)"
                stroke="none"
              />
            )}
            <Line
              type="monotone"
              dataKey="score"
              name="Score"
              stroke="#00f5a0"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            {trendScores.length >= 5 && (
              <Line
                type="monotone"
                dataKey="rolling"
                name="5-session avg"
                stroke="#ffd700"
                strokeWidth={2}
                strokeDasharray="5 3"
                dot={false}
                connectNulls
              />
            )}
            {trendScores.length >= 4 && (
              <Line
                type="monotone"
                dataKey="trendLine"
                name="Trend"
                stroke="#ff9f43"
                strokeWidth={1.5}
                strokeDasharray="8 4"
                dot={false}
                connectNulls
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Recent runs table */}
      <div style={CHART_STYLE}>
        <SectionTitle>Recent runs</SectionTitle>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "rgba(255,255,255,0.3)", textAlign: "left" }}>
              {["Date", "Score", "Acc", "Kills", "Duration", "Smooth"].map((h) => (
                <th
                  key={h}
                  style={{
                    paddingBottom: 8,
                    fontWeight: 500,
                    borderBottom: "1px solid rgba(255,255,255,0.07)",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recentRuns.map((r, idx) => {
              const isBest = r.score === best;
              const isWarmup = warmupIds.has(r.id);
              return (
                <tr
                  key={r.id}
                  style={{
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    opacity: isWarmup ? 0.55 : 1,
                    background: isBest
                      ? "rgba(0,245,160,0.04)"
                      : idx % 2 === 0
                        ? "transparent"
                        : "rgba(255,255,255,0.01)",
                  }}
                >
                  <td style={{ padding: "8px 4px 8px 0", color: "rgba(255,255,255,0.5)" }}>
                    {formatDateTime(r.timestamp)}
                    {isWarmup && (
                      <span
                        style={{
                          fontSize: 9,
                          background: "rgba(255,180,0,0.18)",
                          color: "#ffb400",
                          borderRadius: 3,
                          padding: "1px 4px",
                          marginLeft: 5,
                          verticalAlign: "middle",
                        }}
                      >
                        warm-up
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: "8px 4px",
                      fontWeight: 700,
                      color: isBest ? "#00f5a0" : "#fff",
                    }}
                  >
                    {fmtScore(r.score)}
                    {isBest && (
                      <span style={{ fontSize: 10, color: "#00f5a0", marginLeft: 6 }}>PB</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 4px", color: "rgba(255,255,255,0.6)" }}>
                    {r.accuracy > 0 ? (r.accuracy * 100).toFixed(1) + "%" : "—"}
                  </td>
                  <td style={{ padding: "8px 4px", color: "rgba(255,255,255,0.55)" }}>
                    {r.kills > 0 ? r.kills : "—"}
                  </td>
                  <td style={{ padding: "8px 4px", color: "rgba(255,255,255,0.5)" }}>
                    {fmtDuration(r.duration_secs)}
                  </td>
                  <td
                    style={{
                      padding: "8px 4px",
                      color: r.smoothness ? "#00b4ff" : "rgba(255,255,255,0.2)",
                    }}
                  >
                    {r.smoothness ? r.smoothness.composite.toFixed(1) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Movement tab ─────────────────────────────────────────────────────────────

function MovementTab({
  records,
  sorted,
}: {
  records: SessionRecord[];
  sorted: SessionRecord[];
}) {

  const smoothRecords = records.filter((r) => r.smoothness !== null);

  if (smoothRecords.length === 0) {
    return (
      <div style={{ color: "rgba(255,255,255,0.3)", padding: 20, lineHeight: 1.7 }}>
        No smoothness data recorded for this scenario.
        <br />
        Make sure the mouse hook is active during play.
      </div>
    );
  }

  const g = (fn: (s: SmoothnessSnapshot) => number) =>
    mean(smoothRecords.map((r) => fn(r.smoothness!)));

  const avgComposite = g((s) => s.composite);
  const avgJitter = g((s) => s.jitter);
  const avgOvershoot = g((s) => s.overshoot_rate);
  const avgPath = g((s) => s.path_efficiency);
  const avgVelStd = g((s) => s.velocity_std);
  const avgCorrection = g((s) => s.correction_ratio);
  const avgBias = g((s) => s.directional_bias);
  const avgClickCV = g((s) => s.click_timing_cv);

  const smoothSorted = sorted.filter((r) => r.smoothness !== null);
  const chartData = smoothSorted.map((r, i) => ({
    i: i + 1,
    composite: +r.smoothness!.composite.toFixed(1),
    jitter: +(r.smoothness!.jitter * 100).toFixed(2),
    overshoot: +(r.smoothness!.overshoot_rate * 100).toFixed(1),
    path_eff: +(r.smoothness!.path_efficiency * 100).toFixed(1),
    vel_std: +(r.smoothness!.velocity_std * 100).toFixed(1),
    correction: +(r.smoothness!.correction_ratio * 100).toFixed(1),
    bias: +(r.smoothness!.directional_bias * 100).toFixed(1),
    dateLabel: formatDateTime(r.timestamp),
  }));

  const metrics = [
    {
      label: "Overall Smoothness",
      value: avgComposite.toFixed(1),
      unit: "/100",
      note: "higher = smoother movement",
      accent:
        avgComposite >= 70 ? "#00f5a0" : avgComposite >= 50 ? "#ffd700" : "#ff6b6b",
    },
    {
      label: "Wobble (Jitter)",
      value: avgJitter.toFixed(3),
      note: "lower = steadier aim",
      accent: avgJitter < 0.2 ? "#00f5a0" : avgJitter < 0.35 ? "#ffd700" : "#ff6b6b",
    },
    {
      label: "Overshoot",
      value: (avgOvershoot * 100).toFixed(1),
      unit: "%",
      note: "lower = fewer overshoots",
      accent:
        avgOvershoot < 0.15 ? "#00f5a0" : avgOvershoot < 0.3 ? "#ffd700" : "#ff6b6b",
    },
    {
      label: "Path Quality",
      value: (avgPath * 100).toFixed(1),
      unit: "%",
      note: "higher = straighter aim paths",
      accent: avgPath > 0.87 ? "#00f5a0" : avgPath > 0.75 ? "#ffd700" : "#ff6b6b",
    },
    {
      label: "Speed Consistency",
      value: (avgVelStd * 100).toFixed(1),
      unit: "%",
      note: "lower = more even mouse speed",
      accent: avgVelStd < 0.4 ? "#00f5a0" : avgVelStd < 0.6 ? "#ffd700" : "#ff6b6b",
    },
    {
      label: "Over-aim",
      value: (avgCorrection * 100).toFixed(1),
      unit: "%",
      note: "lower = fewer micro-corrections",
      accent:
        avgCorrection < 0.25 ? "#00f5a0" : avgCorrection < 0.4 ? "#ffd700" : "#ff6b6b",
    },
    {
      label: "Side Drift",
      value: (avgBias * 100).toFixed(1),
      unit: "%",
      note: "lower = aim drifts neither way",
      accent: avgBias < 0.25 ? "#00f5a0" : avgBias < 0.5 ? "#ffd700" : "#ff6b6b",
    },
    {
      label: "Click Rhythm",
      value: avgClickCV.toFixed(3),
      note: "lower = more consistent clicks",
      accent:
        avgClickCV < 0.2 ? "#00f5a0" : avgClickCV < 0.4 ? "#ffd700" : "#ff6b6b",
    },
  ];

  const insights = detectInsights(records);
  const mouseInsights = insights.filter((ins) => ins.category === "mouse");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Metrics grid */}
      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}
      >
        {metrics.map((m) => (
          <div
            key={m.label}
            style={{
              ...CARD_STYLE,
              minWidth: 0,
              flex: "none",
              padding: "12px 14px",
            }}
          >
            <div
              style={{
                fontSize: 10,
                color: "rgba(255,255,255,0.35)",
                textTransform: "uppercase",
                letterSpacing: 1,
                marginBottom: 4,
              }}
            >
              {m.label}
            </div>
            <div
              style={{ fontSize: 19, fontWeight: 700, color: m.accent, lineHeight: 1 }}
            >
              {m.value}
              <span style={{ fontSize: 12, fontWeight: 400 }}>{m.unit}</span>
            </div>
            <div
              style={{ fontSize: 10, color: "rgba(255,255,255,0.28)", marginTop: 3 }}
            >
              {m.note}
            </div>
          </div>
        ))}
      </div>

      {/* Composite + path + speed CV trend */}
      <div style={CHART_STYLE}>
        <SectionTitle>Smoothness trend</SectionTitle>
        <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
          {[
            { color: "#00b4ff", label: "Smoothness score" },
            { color: "#00f5a0", label: "Path quality %" },
            { color: "#ffd700", label: "Speed consistency %" },
          ].map((l) => (
            <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 12,
                  height: 2,
                  borderRadius: 2,
                  background: l.color,
                }}
              />
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                {l.label}
              </span>
            </div>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={150}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="i"
              tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={38}
            />
            <Tooltip content={<MiniTooltip />} />
            <Line
              type="monotone"
              dataKey="composite"
              name="Smoothness score"
              stroke="#00b4ff"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="path_eff"
              name="Path quality %"
              stroke="#00f5a0"
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="vel_std"
              name="Speed consistency %"
              stroke="#ffd700"
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Error metrics */}
      <div style={CHART_STYLE}>
        <SectionTitle>Aim errors — all lower is better</SectionTitle>
        <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
          {[
            { color: "#ff6b6b", label: "Wobble ×100" },
            { color: "#ff9f43", label: "Overshoot %" },
            { color: "#a78bfa", label: "Over-aim %" },
            { color: "#e056fd", label: "Side drift %" },
          ].map((l) => (
            <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 12,
                  height: 2,
                  borderRadius: 2,
                  background: l.color,
                }}
              />
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                {l.label}
              </span>
            </div>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={130}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="i"
              tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={38}
            />
            <Tooltip content={<MiniTooltip />} />
            <Line
              type="monotone"
              dataKey="jitter"
              name="Wobble ×100"
              stroke="#ff6b6b"
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="overshoot"
              name="Overshoot %"
              stroke="#ff9f43"
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="correction"
              name="Over-aim %"
              stroke="#a78bfa"
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="bias"
              name="Side drift %"
              stroke="#e056fd"
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Insights */}
      {mouseInsights.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionTitle>Insights</SectionTitle>
          {mouseInsights.map((ins, i) => (
            <InsightCard key={i} ins={ins} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Performance tab ──────────────────────────────────────────────────────────

function PerformanceTab({
  records,
  sorted,
}: {
  records: SessionRecord[];
  sorted: SessionRecord[];
}) {
  const perfRecords = records
    .map((r) => {
      const fallbackKps =
        r.duration_secs > 0 && Number.isFinite(r.duration_secs) ? r.kills / r.duration_secs : null;
      const fallbackAcc = Number.isFinite(r.accuracy) ? r.accuracy : null;
      return {
        ...r,
        perf_kps: r.stats_panel?.avg_kps ?? fallbackKps,
        perf_acc: r.stats_panel?.accuracy_pct ?? fallbackAcc,
        perf_ttk: r.stats_panel?.avg_ttk_ms ?? null,
        perf_ttk_std: r.stats_panel?.ttk_std_ms ?? null,
        perf_trend: r.stats_panel?.accuracy_trend ?? null,
        perf_scenario_type: r.stats_panel?.scenario_type ?? null,
      };
    })
    .filter((r) => r.perf_kps != null || r.perf_acc != null || r.perf_ttk != null);

  if (perfRecords.length === 0) {
    return (
      <div style={{ color: "rgba(255,255,255,0.3)", padding: 20, lineHeight: 1.7 }}>
        No performance data recorded for this scenario.
        <br />
        Run a scenario with AimMod active to capture detailed
        kill-speed, accuracy, and TTK metrics.
      </div>
    );
  }

  const perfSorted = sorted
    .map((r) => {
      const fallbackKps =
        r.duration_secs > 0 && Number.isFinite(r.duration_secs) ? r.kills / r.duration_secs : null;
      const fallbackAcc = Number.isFinite(r.accuracy) ? r.accuracy : null;
      return {
        ...r,
        perf_kps: r.stats_panel?.avg_kps ?? fallbackKps,
        perf_acc: r.stats_panel?.accuracy_pct ?? fallbackAcc,
        perf_ttk: r.stats_panel?.avg_ttk_ms ?? null,
        perf_ttk_std: r.stats_panel?.ttk_std_ms ?? null,
        perf_trend: r.stats_panel?.accuracy_trend ?? null,
        perf_scenario_type: r.stats_panel?.scenario_type ?? null,
      };
    })
    .filter((r) => r.perf_kps != null || r.perf_acc != null || r.perf_ttk != null);

  const withKps = perfRecords.filter((r) => r.perf_kps != null);
  const withAcc = perfRecords.filter((r) => r.perf_acc != null);
  const withTtk = perfRecords.filter((r) => r.perf_ttk != null);
  const withBestTtk = perfRecords.filter((r) => r.stats_panel?.best_ttk_ms != null);
  const withTrend = perfRecords.filter((r) => r.perf_trend != null);

  const avgKps = withKps.length ? mean(withKps.map((r) => r.perf_kps!)) : null;
  const avgAccPct = withAcc.length ? mean(withAcc.map((r) => r.perf_acc!)) : null;
  const avgTtk = withTtk.length ? mean(withTtk.map((r) => r.perf_ttk!)) : null;
  const bestTtk = withBestTtk.length
    ? Math.min(...withBestTtk.map((r) => r.stats_panel!.best_ttk_ms!))
    : null;
  const avgTrend = withTrend.length ? mean(withTrend.map((r) => r.perf_trend!)) : null;

  const scenarioType =
    perfRecords[perfRecords.length - 1]?.perf_scenario_type ?? "Unknown";

  const chartData = perfSorted.map((r, i) => ({
    i: i + 1,
    kps: r.perf_kps != null ? +r.perf_kps.toFixed(2) : null,
    acc: r.perf_acc != null ? +r.perf_acc.toFixed(1) : null,
    ttk: r.perf_ttk != null ? +r.perf_ttk.toFixed(0) : null,
    ttk_std: r.perf_ttk_std != null ? +r.perf_ttk_std.toFixed(0) : null,
    trend: r.perf_trend != null ? +r.perf_trend.toFixed(1) : null,
    dateLabel: formatDateTime(r.timestamp),
  }));

  const panelInsights = detectInsights(records).filter((ins) => ins.category === "game");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Summary cards */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="Scenario Type" value={scenarioType} />
        {avgKps != null && (
          <StatCard
            label="Avg KPS"
            value={avgKps.toFixed(2)}
            sub="kills per second"
            accent="#00f5a0"
          />
        )}
        {avgAccPct != null && (
          <StatCard
            label="Avg Accuracy"
            value={avgAccPct.toFixed(1) + "%"}
            accent="#00b4ff"
          />
        )}
        {avgTtk != null && (
          <StatCard label="Avg TTK" value={avgTtk.toFixed(0) + "ms"} accent="#ffd700" />
        )}
        {bestTtk != null && (
          <StatCard
            label="Best TTK"
            value={bestTtk.toFixed(0) + "ms"}
            sub="fastest kill"
            accent="#00f5a0"
          />
        )}
        {avgTrend != null && (
          <StatCard
            label="Acc. Trend"
            value={(avgTrend > 0 ? "+" : "") + avgTrend.toFixed(1) + "%"}
            sub="later half of session vs earlier half"
            accent={avgTrend > 2 ? "#00f5a0" : avgTrend < -2 ? "#ff6b6b" : "rgba(255,255,255,0.6)"}
          />
        )}
      </div>

      {/* TTK trend */}
      {withTtk.length > 1 && (
        <div style={CHART_STYLE}>
          <SectionTitle>Time to Kill in milliseconds — lower is faster</SectionTitle>
          <div style={{ display: "flex", gap: 16, marginBottom: 10 }}>
            {[
              { color: "#ffd700", label: "Avg kill speed" },
              { color: "#ff9f43", label: "Kill speed spread" },
            ].map((l) => (
              <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div
                  style={{ width: 12, height: 2, borderRadius: 2, background: l.color }}
                />
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                  {l.label}
                </span>
              </div>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="i"
                tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={46}
              />
              <Tooltip content={<MiniTooltip />} />
              <Line
                type="monotone"
                dataKey="ttk"
                name="Avg TTK"
                stroke="#ffd700"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="ttk_std"
                name="Kill speed spread"
                stroke="#ff9f43"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Accuracy trend */}
      {withAcc.length > 1 && (
        <div style={CHART_STYLE}>
          <SectionTitle>Accuracy (%)</SectionTitle>
          <ResponsiveContainer width="100%" height={130}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="i"
                tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={38}
                domain={["auto", "auto"]}
              />
              <Tooltip content={<MiniTooltip />} />
              <Line
                type="monotone"
                dataKey="acc"
                name="Accuracy %"
                stroke="#00b4ff"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Within-session accuracy trend (fatigue) */}
      {withTrend.length > 1 && (
        <div style={CHART_STYLE}>
          <SectionTitle>
            Accuracy within each session — above zero means you get better as you play
          </SectionTitle>
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="i"
                tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={38}
              />
              <Tooltip content={<MiniTooltip />} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
              <Line
                type="monotone"
                dataKey="trend"
                name="Acc. trend"
                stroke="#a78bfa"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* KPS trend */}
      {withKps.length > 1 && (
        <div style={CHART_STYLE}>
          <SectionTitle>Kills per second</SectionTitle>
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="i"
                tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={38}
              />
              <Tooltip content={<MiniTooltip />} />
              <Line
                type="monotone"
                dataKey="kps"
                name="KPS"
                stroke="#00f5a0"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {panelInsights.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionTitle>Insights</SectionTitle>
          {panelInsights.map((ins, i) => (
            <InsightCard key={i} ins={ins} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Replay tab ───────────────────────────────────────────────────────────────

function ReplayTab({
  records,
  sorted,
  warmupIds,
}: {
  records: SessionRecord[];
  sorted: SessionRecord[];
  warmupIds: Set<string>;
}) {
  const replayRecords = useMemo(
    () => [...sorted].reverse().filter((r) => r.has_replay),
    [sorted],
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    replayRecords.length > 0 ? replayRecords[0].id : null,
  );
  const [replayData, setReplayData] = useState<ReplayData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedId) { setReplayData(null); return; }
    setLoading(true);
    invoke<ReplayData>("load_session_replay", { sessionId: selectedId })
      .then((d) => { setReplayData(d); setLoading(false); })
      .catch(() => { setReplayData(null); setLoading(false); });
  }, [selectedId]);

  // When new sessions arrive, auto-select the newest if nothing is selected
  useEffect(() => {
    if (!selectedId && replayRecords.length > 0) {
      setSelectedId(replayRecords[0].id);
    }
  }, [replayRecords]);

  const selectedRecord = records.find((r) => r.id === selectedId) ?? null;
  const runSnapshot: BridgeRunSnapshot | null = replayData?.run_snapshot ?? null;
  const selectedShotTiming = selectedRecord?.shot_timing ?? null;
  const runTimeline = useMemo(() => runSnapshot?.timeline ?? [], [runSnapshot]);
  const hasRunTimelineSignal = useMemo(
    () => runTimeline.some((point) =>
      point.score_per_minute != null
      || point.kills_per_second != null
      || point.accuracy_pct != null
      || point.damage_efficiency != null,
    ),
    [runTimeline],
  );
  const runMoments = useMemo(
    () => buildRunMomentInsights(runTimeline, runSnapshot?.duration_secs),
    [runTimeline, runSnapshot?.duration_secs],
  );
  const runChartData = useMemo(
    () => runTimeline.map((point) => ({
      tSec: point.t_sec,
      spm: point.score_per_minute,
      kps: point.kills_per_second,
      acc: point.accuracy_pct,
      dmgEff: point.damage_efficiency,
    })),
    [runTimeline],
  );
  const runAccuracy =
    runSnapshot?.accuracy_pct
    ?? (
      runSnapshot?.shots_fired != null
      && runSnapshot.shots_fired > 0
      && runSnapshot.shots_hit != null
      ? (runSnapshot.shots_hit / runSnapshot.shots_fired) * 100
      : null
    )
    ?? (selectedRecord && selectedRecord.accuracy > 0 ? selectedRecord.accuracy * 100 : null);
  const runDurationSecs = runSnapshot?.duration_secs ?? selectedRecord?.duration_secs ?? null;
  const runShotsToHit = runSnapshot?.avg_shots_to_hit ?? selectedShotTiming?.avg_shots_to_hit ?? null;
  const runCorrectiveRatio = runSnapshot?.corrective_shot_ratio ?? selectedShotTiming?.corrective_shot_ratio ?? null;
  const runFireToHitMs = runSnapshot?.avg_fire_to_hit_ms ?? selectedShotTiming?.avg_fire_to_hit_ms ?? null;
  const runFireToHitP90Ms = runSnapshot?.p90_fire_to_hit_ms ?? selectedShotTiming?.p90_fire_to_hit_ms ?? null;
  const runDamageEff =
    runSnapshot?.damage_efficiency
    ?? (
      runSnapshot?.damage_possible != null
      && runSnapshot.damage_possible > 0
      && runSnapshot.damage_done != null
      ? (runSnapshot.damage_done / runSnapshot.damage_possible) * 100
      : null
    );
  // Worst-moment clips removed — full interactive viewer is shown instead

  if (replayRecords.length === 0) {
    return (
      <div style={{ color: "rgba(255,255,255,0.3)", padding: 20, lineHeight: 1.7 }}>
        No replays saved yet.
        <br />
        Replays are recorded automatically during sessions when the mouse hook is active.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Session selector */}
      <div style={CHART_STYLE}>
        <SectionTitle>Select session</SectionTitle>
        <div style={{ maxHeight: 180, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ color: "rgba(255,255,255,0.3)" }}>
                {["Date", "Score", "Acc", "Smooth"].map((h) => (
                  <th
                    key={h}
                    style={{
                      paddingBottom: 6,
                      fontWeight: 500,
                      textAlign: "left",
                      borderBottom: "1px solid rgba(255,255,255,0.07)",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {replayRecords.map((r) => {
                const active = r.id === selectedId;
                const isWarmup = warmupIds.has(r.id);
                return (
                  <tr
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    style={{
                      cursor: "pointer",
                      opacity: isWarmup ? 0.65 : 1,
                      background: active ? "rgba(0,245,160,0.07)" : "transparent",
                      borderBottom: "1px solid rgba(255,255,255,0.04)",
                    }}
                  >
                    <td style={{ padding: "7px 4px 7px 0", color: active ? "#00f5a0" : "rgba(255,255,255,0.5)" }}>
                      {formatDateTime(r.timestamp)}
                      {isWarmup && (
                        <span
                          style={{
                            fontSize: 9,
                            background: "rgba(255,180,0,0.18)",
                            color: "#ffb400",
                            borderRadius: 3,
                            padding: "1px 4px",
                            marginLeft: 5,
                            verticalAlign: "middle",
                          }}
                        >
                          warm-up
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "7px 4px", fontWeight: active ? 700 : 400, color: active ? "#fff" : "rgba(255,255,255,0.7)" }}>
                      {fmtScore(r.score)}
                    </td>
                    <td style={{ padding: "7px 4px", color: "rgba(255,255,255,0.5)" }}>
                      {r.accuracy > 0 ? (r.accuracy * 100).toFixed(1) + "%" : "—"}
                    </td>
                    <td style={{ padding: "7px 4px", color: r.smoothness ? "#00b4ff" : "rgba(255,255,255,0.2)" }}>
                      {r.smoothness ? r.smoothness.composite.toFixed(1) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mouse path viewer */}
      {loading && (
        <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 12 }}>Loading replay…</div>
      )}
      {!loading && runSnapshot && selectedRecord && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={CHART_STYLE}>
            <SectionTitle>Bridge run stats (persisted)</SectionTitle>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <StatCard
                label="Duration"
                value={runDurationSecs != null ? fmtDuration(runDurationSecs) : "—"}
                accent="#00b4ff"
              />
              <StatCard
                label="SPM"
                value={runSnapshot.score_per_minute != null ? runSnapshot.score_per_minute.toFixed(0) : "—"}
                sub={runSnapshot.peak_score_per_minute != null ? `peak ${runSnapshot.peak_score_per_minute.toFixed(0)}` : undefined}
                accent="#00f5a0"
              />
              <StatCard
                label="Accuracy"
                value={runAccuracy != null ? `${runAccuracy.toFixed(1)}%` : "—"}
                accent="#ffd700"
              />
              <StatCard
                label="Damage Eff"
                value={runDamageEff != null ? `${runDamageEff.toFixed(1)}%` : "—"}
                accent="#a78bfa"
              />
              <StatCard
                label="Shots / Hit"
                value={runShotsToHit != null ? runShotsToHit.toFixed(2) : "—"}
                sub={runCorrectiveRatio != null ? `${(runCorrectiveRatio * 100).toFixed(0)}% corrective` : undefined}
                accent="#00b4ff"
              />
              <StatCard
                label="Fire→Hit"
                value={runFireToHitMs != null ? `${runFireToHitMs.toFixed(0)}ms` : "—"}
                sub={runFireToHitP90Ms != null ? `p90 ${runFireToHitP90Ms.toFixed(0)}ms` : undefined}
                accent="#ff9f43"
              />
            </div>
            {(runChartData.length <= 1 || !hasRunTimelineSignal) && (
              <div style={{ marginTop: 10, fontSize: 11, color: "rgba(255,255,255,0.42)", lineHeight: 1.5 }}>
                Per-second bridge timeline data is sparse for this run. Aggregate values above are shown from available session data.
              </div>
            )}
          </div>

          {runChartData.length > 1 && hasRunTimelineSignal && (
            <div style={CHART_STYLE}>
              <SectionTitle>Timeline by second (exact run windows)</SectionTitle>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={runChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    dataKey="tSec"
                    tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    label={{ value: "seconds", position: "insideBottomRight", offset: -5, fill: "rgba(255,255,255,0.35)", fontSize: 10 }}
                  />
                  <YAxis
                    yAxisId="pace"
                    tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={42}
                  />
                  <YAxis
                    yAxisId="pct"
                    orientation="right"
                    tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={42}
                    domain={[0, 100]}
                  />
                  <Tooltip content={<MiniTooltip />} />
                  {runMoments.map((moment) => (
                    <ReferenceArea
                      key={moment.id}
                      x1={moment.startSec}
                      x2={moment.endSec}
                      fill={moment.level === "warning" ? "#ff6b6b" : moment.level === "good" ? "#00f5a0" : "#ffd166"}
                      fillOpacity={0.08}
                      strokeOpacity={0}
                    />
                  ))}
                  <Line
                    yAxisId="pace"
                    type="monotone"
                    dataKey="spm"
                    name="SPM"
                    stroke="#00f5a0"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    yAxisId="pace"
                    type="monotone"
                    dataKey="kps"
                    name="KPS"
                    stroke="#00b4ff"
                    strokeWidth={1.7}
                    strokeDasharray="4 3"
                    dot={false}
                    connectNulls
                  />
                  <Line
                    yAxisId="pct"
                    type="monotone"
                    dataKey="acc"
                    name="Accuracy %"
                    stroke="#ffd700"
                    strokeWidth={1.8}
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {(replayData?.frames?.length ?? 0) === 0 && (
            <div style={{ ...CHART_STYLE, color: "rgba(255,255,255,0.52)", fontSize: 12, lineHeight: 1.6 }}>
              No video frames were saved for this replay.
            </div>
          )}

          {runMoments.length > 0 && (
            <div style={CHART_STYLE}>
              <SectionTitle>Moment coaching (time-specific)</SectionTitle>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {runMoments.map((moment) => (
                  <div
                    key={moment.id}
                    style={{
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 8,
                      padding: "10px 12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ fontWeight: 700, color: moment.level === "warning" ? "#ff6b6b" : moment.level === "good" ? "#00f5a0" : "#ffd166" }}>
                        {moment.title}
                      </div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
                        {formatRunWindow(moment.startSec, moment.endSec)}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.62)", lineHeight: 1.55 }}>
                      {moment.detail}
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.78)", lineHeight: 1.55 }}>
                      <span style={{ color: "rgba(255,255,255,0.42)" }}>Action: </span>
                      {runMomentAction(moment)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {!loading && replayData && selectedRecord && !runSnapshot && (
        <div style={{ ...CHART_STYLE, color: "rgba(255,255,255,0.42)", fontSize: 12, lineHeight: 1.6 }}>
          This replay was saved before bridge timeline persistence was added, so only mouse path data is available.
        </div>
      )}
      {!loading && replayData && selectedRecord && (
        <div style={CHART_STYLE}>
          <SectionTitle>
            Mouse path —{" "}
            <span style={{ color: "#00f5a0", fontWeight: 700 }}>{fmtScore(selectedRecord.score)}</span>{" "}
            pts · {formatDateTime(selectedRecord.timestamp)}
          </SectionTitle>
          <MousePathViewer
            rawPositions={replayData.positions}
            metricPoints={replayData.metrics}
            screenFrames={replayData.frames ?? []}
          />
        </div>
      )}
    </div>
  );
}

// ─── Aim Fingerprint ──────────────────────────────────────────────────────────

interface AimFingerprint {
  precision: number;    // 0-100 (path efficiency + low jitter)
  speed: number;        // 0-100 (avg_speed normalised)
  control: number;      // 0-100 (1 - overshoot)
  consistency: number;  // 0-100 (1 - velocity_std)
  decisiveness: number; // 0-100 (1 - correction_ratio)
  rhythm: number;       // 0-100 (1 - click_timing_cv)
}

function dominantScenarioType(records: SessionRecord[]): string {
  const panelRecs = records.filter(
    (r) => r.stats_panel?.scenario_type && r.stats_panel.scenario_type !== "Unknown",
  );
  if (!panelRecs.length) return "Unknown";
  const counts = new Map<string, number>();
  for (const r of panelRecs) {
    const t = r.stats_panel!.scenario_type;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best = "Unknown", bestCount = 0;
  for (const [t, c] of counts) if (c > bestCount) { best = t; bestCount = c; }
  return best;
}

function buildAimFingerprint(smoothRecords: SessionRecord[], scenarioType: string): AimFingerprint {
  const g = (fn: (s: SmoothnessSnapshot) => number) =>
    mean(smoothRecords.map((r) => fn(r.smoothness!)));

  const jitter     = g((s) => s.jitter);
  const overshoot  = g((s) => s.overshoot_rate);
  const velStd     = g((s) => s.velocity_std);
  const avgSpeed   = g((s) => s.avg_speed);
  const pathEff    = g((s) => s.path_efficiency);
  const correction = g((s) => s.correction_ratio);
  const clickCV    = g((s) => s.click_timing_cv);

  const isTracking = scenarioType === "PureTracking" || scenarioType.includes("Tracking");

  const precision    = Math.round(Math.min(100, Math.max(0, (pathEff * 0.65 + Math.max(0, 1 - jitter * 4) * 0.35) * 100)));
  const speed        = Math.round(Math.min(100, Math.max(0, (avgSpeed - 100) / 19)));
  const control      = Math.round(Math.min(100, Math.max(0, (1 - overshoot * 2.2) * 100)));
  const consistency  = Math.round(Math.min(100, Math.max(0, (1 - velStd) * 100)));
  const decisiveness = Math.round(Math.min(100, Math.max(0, (1 - correction * 2.5) * 100)));
  // For tracking: 6th axis = tracking flow (speed evenness, not click timing)
  // For clicking: 6th axis = click rhythm
  const rhythm = isTracking
    ? Math.round(Math.min(100, Math.max(0, (1 - Math.min(velStd * 1.5, 1)) * 100)))
    : Math.round(Math.min(100, Math.max(0, (1 - Math.min(clickCV, 1)) * 100)));

  return { precision, speed, control, consistency, decisiveness, rhythm };
}

interface AimStyle {
  name: string;
  tagline: string;
  color: string;
  description: string;
  focus: string;
}

function classifyAimStyle(fp: AimFingerprint, scenarioType: string): AimStyle {
  const { precision, speed, control, consistency, decisiveness, rhythm } = fp;
  const isTracking = scenarioType === "PureTracking" || scenarioType.includes("Tracking");

  if (isTracking) {
    // rhythm axis = tracking flow (speed evenness) for tracking scenarios
    if (precision > 70 && consistency > 70 && rhythm > 70)
      return {
        name: "The Rail",
        tagline: "Locked on and flowing",
        color: "#00f5a0",
        description:
          "Your tracking is smooth, consistent, and precise — you stay on target with minimal wobble and even speed. You're already a strong tracker; push into harder, faster-moving targets to keep growing.",
        focus: "Faster target variants, smaller hitbox scenarios, long-session endurance",
      };
    if (speed > 65 && consistency < 50)
      return {
        name: "The Sprinter",
        tagline: "Fast but choppy",
        color: "#ff6b6b",
        description:
          "You can keep up with fast targets but your speed is uneven — you accelerate and decelerate in bursts instead of flowing continuously. This choppiness breaks your aim and loses score in longer tracking windows.",
        focus: "Smooth-tracking drills, large target slow-tracking, constant-speed follow scenarios",
      };
    if (control > 70 && precision > 65 && rhythm > 60)
      return {
        name: "The Orbiter",
        tagline: "Smooth and controlled",
        color: "#00b4ff",
        description:
          "You maintain clean, controlled contact with targets and rarely overshoot. Your movement flows well. Speed is the next unlock — you're leaving points on the table by playing too conservatively on faster targets.",
        focus: "Speed-ramp drills, reactive tracking, target-leading practice",
      };
    if (speed > 60 && control > 55 && decisiveness > 60)
      return {
        name: "The Overtaker",
        tagline: "Aggressive and reactive",
        color: "#ffd700",
        description:
          "You chase targets hard and react fast — your instincts are sharp. The gap to close is refining that speed into smoother, sustained contact rather than aggressive reacquisitions.",
        focus: "Strafing target scenarios, smooth acceleration drills, reduce overcorrections",
      };
    if (consistency > 65 && speed < 40)
      return {
        name: "The Anchor",
        tagline: "Steady but slow",
        color: "#a78bfa",
        description:
          "Your tracking is mechanically consistent and clean, but you struggle when targets accelerate or change direction. Your foundation is solid — it's time to push your speed ceiling.",
        focus: "Dynamic tracking scenarios, speed-increasing variants, reaction-based targets",
      };
    return {
      name: "The Foundation Builder",
      tagline: "Building tracking fundamentals",
      color: "#ffd700",
      description:
        "Your tracking mechanics are still developing. Focus on staying on target continuously, matching target speed evenly, and reducing jitter before worrying about score.",
      focus: "Beginner tracking scenarios, large slow targets, smooth-follow drills",
    };
  }

  // Clicking/flicking archetypes
  if (speed > 65 && control < 40)
    return {
      name: "The Aggressor",
      tagline: "Raw speed, needs refinement",
      color: "#ff6b6b",
      description:
        "You move fast and commit hard, but overshoot often. Your instincts are strong — channel that aggression into deliberate deceleration near the target.",
      focus: "Deceleration drills, close-range flick scenarios, overshooting correction",
    };
  if (precision > 70 && control > 65 && speed < 50)
    return {
      name: "The Surgeon",
      tagline: "Clean and controlled",
      color: "#00f5a0",
      description:
        "Your mouse movement is exceptionally clean. You rarely miss, but you're playing conservatively. Match that precision at higher speed and your scores will jump.",
      focus: "Reactive scenarios, tempo drills, increasing flick distance",
    };
  if (consistency > 70 && rhythm > 70)
    return {
      name: "The Metronome",
      tagline: "Mechanically reliable",
      color: "#00b4ff",
      description:
        "Extremely consistent mechanics with a reliable click rhythm. This repeatability is your foundation. Target harder scenarios that force you outside your comfort zone.",
      focus: "Difficulty escalation, novel scenario types to raise your ceiling",
    };
  if (decisiveness > 70 && precision < 55)
    return {
      name: "The Gambler",
      tagline: "Confident but imprecise",
      color: "#ffd700",
      description:
        "You commit fast and trust your instincts — great for reaction time. But shots sometimes fire before fully acquiring the target. Slowing down 10% could dramatically improve accuracy.",
      focus: "Micro-adjustment training, precision clicking, accuracy-first drills",
    };
  if (precision > 65 && consistency > 65)
    return {
      name: "The Technician",
      tagline: "Solid all-around mechanics",
      color: "#a78bfa",
      description:
        "A well-rounded, technically sound aimer with strong precision and consistency. Speed and reactive decision-making are your main remaining growth levers.",
      focus: "Reactive flick scenarios, head-tracking, increasing pace",
    };
  return {
    name: "The Foundation Builder",
    tagline: "Developing core mechanics",
    color: "#ffd700",
    description:
      "Your aim style is still taking shape. Focus on fundamentals: reduce jitter, clean up movement paths, and build consistent click timing before chasing scores.",
    focus: "Tracking basics, precision clicking, click timing trainers",
  };
}

// ─── Coaching Cards ────────────────────────────────────────────────────────────

interface CoachingCardData {
  title: string;
  badge: string;
  badgeColor: string;
  body: string;
  tip: string;
}

function generateCoachingCards(
  records: SessionRecord[],
  sorted: SessionRecord[],
  fingerprint: AimFingerprint | null,
  scoreCV: number,
  slope: number,
  avgScoreVal: number,
  isPlateau: boolean,
  scenarioType: string,
): CoachingCardData[] {
  const cards: CoachingCardData[] = [];
  const panelRecords = records.filter((r) => r.stats_panel != null);
  const shotTimingRecords = records.filter((r) => r.shot_timing != null);
  const n = sorted.length;
  const isTracking = scenarioType === "PureTracking" || scenarioType.includes("Tracking");

  const shotToHitVals = shotTimingRecords
    .map((r) => r.shot_timing?.avg_shots_to_hit)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const correctiveVals = shotTimingRecords
    .map((r) => r.shot_timing?.corrective_shot_ratio)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const fireToHitVals = shotTimingRecords
    .map((r) => r.shot_timing?.avg_fire_to_hit_ms)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const shotAvgShotsToHit = shotToHitVals.length > 0 ? mean(shotToHitVals) : null;
  const shotAvgCorrective = correctiveVals.length > 0 ? mean(correctiveVals) : null;
  const shotAvgFireToHit = fireToHitVals.length > 0 ? mean(fireToHitVals) : null;
  const hasShotRecoverySignal = !isTracking
    && shotTimingRecords.length >= 3
    && (shotAvgShotsToHit != null || shotAvgCorrective != null || shotAvgFireToHit != null);

  if (isPlateau)
    cards.push({
      title: "Plateau Detected",
      badge: "Motor Learning",
      badgeColor: "#ff9f43",
      body: `Your last 7 sessions show minimal score movement (slope: ${slope > 0 ? "+" : ""}${Math.round(slope)} pts/run, low recent variance). This is completely normal — your nervous system needs new stimuli to adapt further. Grinding the same scenario will not break a plateau.`,
      tip: "Switch to a harder scenario variant or cross-train on a different aim type (e.g. tracking → clicking) for 5–10 sessions, then return. Novel difficulty forces neural adaptation and produces fresh gains when you come back.",
    });

  if (scoreCV > 12 && n >= 5)
    cards.push({
      title: "High Score Variance",
      badge: "Consistency Science",
      badgeColor: "#ffd700",
      body: `Your scores vary by ${scoreCV.toFixed(1)}% around your average (ideal: <8%). High variance typically signals inconsistent warm-up, mental state differences between sessions, or changing grip/posture.`,
      tip: "Add 2–3 'warm-up only' runs before each real attempt. Research on motor skill shows consistent pre-performance routines reduce run-to-run variability by up to 30% by priming the correct movement patterns.",
    });

  const trendRecs = panelRecords.filter((r) => r.stats_panel?.accuracy_trend != null);
  if (trendRecs.length >= 3) {
    const avgTrend = mean(trendRecs.map((r) => r.stats_panel!.accuracy_trend!));
    if (avgTrend < -5)
      cards.push({
        title: "Cognitive Fatigue Pattern",
        badge: "Exercise Science",
        badgeColor: "#ff6b6b",
        body: `Your accuracy drops an average of ${Math.abs(avgTrend).toFixed(1)}% from the first half to the second half of sessions. Aim skill is among the first to degrade under cognitive load — your fine motor control deteriorates before you notice it consciously.`,
        tip: "Cap continuous play at 45–60 minutes. Taking a 5-minute break every 20–25 minutes sustains performance significantly longer than marathon sessions. The break also accelerates within-session motor consolidation.",
      });
    else if (avgTrend > 5)
      cards.push({
        title: "Extended Warm-up Pattern",
        badge: "Motor Activation",
        badgeColor: "#00f5a0",
        body: `Your accuracy improves ${avgTrend.toFixed(1)}% from session start to finish — your motor system takes time to fully activate. This means your early-session scores underrepresent your true skill level.`,
        tip: "Add a dedicated warm-up before your main scenario: 2–3 minutes of easy tracking or large relaxed flicks. This pre-activates the motor cortex pathways used in aim and helps you peak sooner.",
      });
  }

  if (hasShotRecoverySignal) {
    const severe = (shotAvgShotsToHit != null && shotAvgShotsToHit > 1.75)
      || (shotAvgCorrective != null && shotAvgCorrective > 0.48)
      || (shotAvgFireToHit != null && shotAvgFireToHit > 320);
    const mild = (shotAvgShotsToHit != null && shotAvgShotsToHit > 1.35)
      || (shotAvgCorrective != null && shotAvgCorrective > 0.28)
      || (shotAvgFireToHit != null && shotAvgFireToHit > 220);

    if (severe) {
      cards.push({
        title: "Shot Recovery Bottleneck",
        badge: "Shot Timing",
        badgeColor: "#00b4ff",
        body: `Your fired→hit data shows heavy recovery burden (${shotAvgShotsToHit?.toFixed(2) ?? "—"} shots/hit, ${shotAvgCorrective != null ? `${(shotAvgCorrective * 100).toFixed(0)}%` : "—"} corrective hits, ${shotAvgFireToHit?.toFixed(0) ?? "—"}ms fired→hit). This is consistent with overflick + micro-correction before final confirmation.`,
        tip: "Shift 10–15% focus from max flick speed to first-shot landing quality: brake earlier and fire once your crosshair settles. Track this card over sessions until shots/hit moves toward 1.2 or lower.",
      });
    } else if (mild) {
      cards.push({
        title: "Recoveries Still Costing Time",
        badge: "Shot Timing",
        badgeColor: "#00b4ff",
        body: `Shot recovery is moderate (${shotAvgShotsToHit?.toFixed(2) ?? "—"} shots/hit, ${shotAvgCorrective != null ? `${(shotAvgCorrective * 100).toFixed(0)}%` : "—"} corrective hits). Small overshoots are forcing extra correction before secure hits.`,
        tip: "Use deceleration reps: finish flicks under control and prioritize first-shot confirmation, then add speed back gradually.",
      });
    } else {
      cards.push({
        title: "Strong First-Shot Conversion",
        badge: "Shot Timing",
        badgeColor: "#00f5a0",
        body: `You convert efficiently after firing (${shotAvgShotsToHit?.toFixed(2) ?? "—"} shots/hit, ${shotAvgCorrective != null ? `${(shotAvgCorrective * 100).toFixed(0)}%` : "—"} corrective hits, ${shotAvgFireToHit?.toFixed(0) ?? "—"}ms fired→hit).`,
        tip: "Keep this while increasing pace. Maintain control on shot entry so first-shot quality stays stable at higher speed.",
      });
    }
  }

  if (!hasShotRecoverySignal && fingerprint && fingerprint.control < 45 && n >= 5) {
    if (isTracking)
      cards.push({
        title: "Overshooting Your Targets",
        badge: "Tracking Control",
        badgeColor: "#00b4ff",
        body: `Your control score is ${fingerprint.control}/100, indicating you frequently swing past or overshoot the target. In tracking, overshooting breaks continuous contact and forces a recovery — those recovery gaps are where you bleed score.`,
        tip: "Try 'micro-pressure' drills: maintain the lightest possible grip and focus on matching the target's speed exactly rather than chasing it. Think of it as escorting the target, not hunting it. After a few sessions your brain starts predicting target movement instead of reacting to it.",
      });
    else
      cards.push({
        title: "Speed-Accuracy Tradeoff",
        badge: "Biomechanics",
        badgeColor: "#00b4ff",
        body: `Your control score is ${fingerprint.control}/100, indicating frequent overshoot. Fitts' Law states that as movement amplitude and speed increase, endpoint accuracy decreases. You are currently on the speed-dominant side of this tradeoff.`,
        tip: "Practice 'deceleration drills': flick toward a target but consciously brake 20–30% before the target. The cursor should arrive on the target, not blow past it. After ~3 sessions, this decelerative movement ingrains as muscle memory and your speed-accuracy balance improves.",
      });
  }

  if (fingerprint && fingerprint.rhythm < 40) {
    if (isTracking)
      cards.push({
        title: "Choppy Tracking Speed",
        badge: "Flow Training",
        badgeColor: "#a78bfa",
        body: `Your flow score is ${fingerprint.rhythm}/100 — your cursor speed is uneven across the target's movement. Choppy speed means you're constantly accelerating and braking, which leads to brief off-target moments and reduces your score window.`,
        tip: "Run a slow, large-target tracking scenario with no time pressure. Focus only on keeping your cursor speed constant — imagine you're tracing a line at a fixed pace. This trains smooth speed regulation that then carries over to faster, more reactive scenarios.",
      });
    else
      cards.push({
        title: "Inconsistent Click Timing",
        badge: "Rhythm Training",
        badgeColor: "#a78bfa",
        body: `Your rhythm score is ${fingerprint.rhythm}/100 — click timing varies significantly between shots. Studies on elite FPS players show consistent click timing correlates strongly with kill efficiency. Timing variation often means hesitating before each shot, which adds 50–150ms of latency.`,
        tip: "Use click timing scenarios (KovaaK's has several) for 10 minutes per session. Build a consistent pre-shot commitment rhythm: acquire target → commit → click, without a hesitation gap between commit and click.",
      });
  }

  // Tracking-specific: target prediction card
  if (isTracking && n >= 5 && fingerprint && fingerprint.decisiveness < 50)
    cards.push({
      title: "Reacting Instead of Predicting",
      badge: "Tracking Skill",
      badgeColor: "#ff9f43",
      body: `Your decisiveness score (${fingerprint.decisiveness}/100) suggests you're chasing targets reactively — your cursor follows behind rather than leading. Elite trackers spend 60–70% of their time slightly ahead of the target, predicting movement rather than reacting to it.`,
      tip: "In your next session, consciously try to 'lead' the target by a tiny amount. It will feel wrong at first, but it trains predictive tracking which is far more stable under fast or erratic movement. Start with scenarios using consistent target paths before applying it to erratic ones.",
    });

  if (fingerprint && fingerprint.precision < 50 && n >= 3)
    cards.push({
      title: "Wrist Stability & Path Efficiency",
      badge: "Biomechanics",
      badgeColor: "#ff9f43",
      body: `Your precision score is ${fingerprint.precision}/100, suggesting curved or erratic cursor paths. This typically indicates forearm/wrist tension, a too-tight grip, or a sensitivity that's high relative to your mousepad size.`,
      tip: "Try the 'loose grip' drill: hold your mouse with barely enough pressure to lift it. Play a tracking scenario for 5 minutes. This forces arm-driven movement instead of wrist micro-corrections, which dramatically reduces micro-tremor and improves path straightness.",
    });

  if (slope > avgScoreVal * 0.005 && n >= 10) {
    const sessionsToNext = Math.round(avgScoreVal * 0.1 / slope);
    if (sessionsToNext > 0 && sessionsToNext < 150)
      cards.push({
        title: "Active Improvement Phase",
        badge: "Motor Learning",
        badgeColor: "#00f5a0",
        body: `You're gaining ~${Math.round(slope)} pts/session. The motor learning 'power law of practice' predicts improvement rates slow as skill increases — but you're still in a productive growth phase.`,
        tip: `At this rate you'd reach +10% of your current average in ~${sessionsToNext} more sessions. To sustain the pace, incrementally increase scenario difficulty rather than grinding at the same challenge level. Comfortable practice produces diminishing returns.`,
      });
  }

  if (n >= 5)
    cards.push({
      title: "The Spacing Effect",
      badge: "Cognitive Science",
      badgeColor: "#00b4ff",
      body: "Distributed practice (multiple short sessions across days) produces significantly better long-term skill retention than massed practice (marathon sessions). This is one of the most replicated findings in motor learning research.",
      tip: "Aim for 20–30 minutes daily rather than 2+ hour weekend sessions. Even 15 minutes of focused practice 5 days a week outperforms a 2-hour Saturday grind for long-term skill retention and game transfer.",
    });

  if (n >= 8 && !isPlateau)
    cards.push({
      title: "Interleaved Practice",
      badge: "Skill Transfer",
      badgeColor: "#a78bfa",
      body: "Mixing scenario types in a single session improves overall aim transfer to real games more than repeating the same scenario. The variety forces active pattern retrieval each time, which is harder but produces better long-term retention.",
      tip: isTracking
        ? "Structure sessions as: warm-up tracking (5 min) → a precision/clicking scenario (10 min) → your main tracking scenario (15 min). Crossing between tracking and clicking helps your brain build a more complete aim model."
        : "Structure sessions as: warm-up flicking (5 min) → a tracking scenario to train smooth cursor control (10 min) → your main click scenario (15 min). This interleaved format feels harder but produces superior retention and cross-scenario skill transfer.",
    });

  return cards.slice(0, 6);
}

function CoachingCard({ card }: { card: CoachingCardData }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 10,
        padding: "14px 16px",
        cursor: "pointer",
        userSelect: "none",
      }}
      onClick={() => setExpanded((x) => !x)}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span
            style={{
              background: `${card.badgeColor}20`,
              border: `1px solid ${card.badgeColor}40`,
              color: card.badgeColor,
              borderRadius: 4,
              fontSize: 10,
              padding: "2px 7px",
              textTransform: "uppercase",
              letterSpacing: 0.8,
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            {card.badge}
          </span>
          <span
            style={{
              fontWeight: 700,
              fontSize: 13,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {card.title}
          </span>
        </div>
        <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, flexShrink: 0 }}>
          {expanded ? "▲" : "▼"}
        </span>
      </div>
      {expanded && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <p
            style={{
              margin: 0,
              fontSize: 12,
              color: "rgba(255,255,255,0.55)",
              lineHeight: 1.7,
            }}
          >
            {card.body}
          </p>
          <div
            style={{
              background: `${card.badgeColor}12`,
              borderLeft: `3px solid ${card.badgeColor}`,
              padding: "8px 12px",
              borderRadius: "0 6px 6px 0",
            }}
          >
            <div
              style={{
                fontSize: 10,
                color: card.badgeColor,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                marginBottom: 5,
              }}
            >
              Action
            </div>
            <p
              style={{
                margin: 0,
                fontSize: 12,
                color: "rgba(255,255,255,0.7)",
                lineHeight: 1.65,
              }}
            >
              {card.tip}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ScoreDistributionChart({
  scores,
  p10,
  p50,
  p90,
}: {
  scores: number[];
  p10: number;
  p50: number;
  p90: number;
}) {
  if (scores.length < 4) return null;
  const min = scores[0];
  const max = scores[scores.length - 1];
  const range = max - min;
  if (range === 0) return null;
  const BINS = 10;
  const binSize = range / BINS;
  const bins = Array.from({ length: BINS }, (_, i) => {
    const lo = min + i * binSize;
    const hi = lo + binSize;
    const count = scores.filter((s) =>
      i === BINS - 1 ? s >= lo && s <= hi : s >= lo && s < hi,
    ).length;
    return { label: fmtScore(Math.round(lo)), count, lo, hi };
  });
  return (
    <div style={CHART_STYLE}>
      <SectionTitle>Score distribution</SectionTitle>
      <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
        {[
          { color: "#a78bfa", label: `Floor (bottom 10%): ${fmtScore(p10)}` },
          { color: "#ffd700", label: `Median: ${fmtScore(p50)}` },
          { color: "#00f5a0", label: `Peak (top 10%): ${fmtScore(p90)}` },
        ].map((l) => (
          <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div
              style={{ width: 8, height: 8, borderRadius: "50%", background: l.color }}
            />
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>{l.label}</span>
          </div>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={bins} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.06)"
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 10 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={28}
            allowDecimals={false}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0]?.payload as (typeof bins)[0];
              return (
                <div style={{ ...TOOLTIP_STYLE, padding: "8px 12px" }}>
                  <div
                    style={{
                      color: "rgba(255,255,255,0.5)",
                      fontSize: 11,
                      marginBottom: 4,
                    }}
                  >
                    {fmtScore(Math.round(d.lo))} – {fmtScore(Math.round(d.hi))}
                  </div>
                  <div style={{ fontWeight: 700 }}>{d.count} sessions</div>
                </div>
              );
            }}
          />
          <Bar dataKey="count" radius={[3, 3, 0, 0]}>
            {bins.map((bin, i) => (
              <Cell
                key={i}
                fill={bin.lo >= p90 ? "#00f5a0" : bin.hi <= p10 ? "#a78bfa80" : "#00b4ff50"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Coaching tab ─────────────────────────────────────────────────────────────

function CoachingTab({
  records,
  sorted,
  warmupIds,
  sessionFilter,
}: {
  records: SessionRecord[];
  sorted: SessionRecord[];
  warmupIds: Set<string>;
  sessionFilter: SessionFilter;
}) {
  // CoachingTab always works on the full dataset and handles splits internally.
  const warmupSorted  = sorted.filter((r) => warmupIds.has(r.id));
  const peakSorted    = sorted.filter((r) => !warmupIds.has(r.id));
  const peakRecords   = records.filter((r) => !warmupIds.has(r.id));
  const hasWarmupData = warmupSorted.length > 0;

  // Use peak-only data for the main coaching analysis so warmup sessions don't skew it.
  // Fall back to all records if there are no peak records yet.
  const coachRecords = peakRecords.length >= 3 ? peakRecords : records;
  const coachSorted  = peakRecords.length >= 3 ? peakSorted  : sorted;

  const smoothRecords = coachRecords.filter((r) => r.smoothness !== null);
  const scores = coachSorted.map((r) => r.score);

  const showWarmupSection = sessionFilter !== "warmedup" && hasWarmupData;
  const showPeakSection   = sessionFilter !== "warmup";

  if (scores.length < 3 && !showWarmupSection) {
    return (
      <div style={{ color: "rgba(255,255,255,0.3)", padding: 20, lineHeight: 1.7 }}>
        Play at least 3 sessions to unlock coaching analysis.
      </div>
    );
  }

  // ── Peak performance stats ────────────────────────────────────────────────
  const avgScoreVal  = scores.length > 0 ? mean(scores) : 0;
  const scoreStdDev  = stddev(scores);
  const scoreCV      = avgScoreVal > 0 ? (scoreStdDev / avgScoreVal) * 100 : 0;
  const xs           = scores.map((_, i) => i + 1);
  const { slope }    = linearRegression(xs, scores);
  const slopeNormPct = avgScoreVal > 0 ? (slope / avgScoreVal) * 100 : 0;
  const recent7      = scores.slice(-7);
  const recentCV     = mean(recent7) > 0 ? (stddev(recent7) / mean(recent7)) * 100 : 0;
  const isPlateau    = scores.length >= 8 && Math.abs(slopeNormPct) < 0.5 && recentCV < 8;

  const scenarioType = dominantScenarioType(coachRecords);
  const isTracking   = scenarioType === "PureTracking" || scenarioType.includes("Tracking");

  const fingerprint  = smoothRecords.length > 0 ? buildAimFingerprint(smoothRecords, scenarioType) : null;
  const aimStyle     = fingerprint ? classifyAimStyle(fingerprint, scenarioType) : null;

  const sixthAxisLabel = isTracking ? "Flow" : "Rhythm";

  const radarData = fingerprint
    ? [
        { metric: "Precision",    value: fingerprint.precision },
        { metric: "Speed",        value: fingerprint.speed },
        { metric: "Control",      value: fingerprint.control },
        { metric: "Consistency",  value: fingerprint.consistency },
        { metric: "Decisiveness", value: fingerprint.decisiveness },
        { metric: sixthAxisLabel, value: fingerprint.rhythm },
      ]
    : [];

  const coachingCards = scores.length >= 3 ? generateCoachingCards(
    coachRecords,
    coachSorted,
    fingerprint,
    scoreCV,
    slope,
    avgScoreVal,
    isPlateau,
    scenarioType,
  ) : [];

  const sortedScores = [...scores].sort((a, b) => a - b);
  const p10 = percentileOf(sortedScores, 10);
  const p50 = percentileOf(sortedScores, 50);
  const p90 = percentileOf(sortedScores, 90);

  // ── Warmup stats ──────────────────────────────────────────────────────────
  const warmupStats = (() => {
    if (!hasWarmupData) return null;
    const warmupScores = warmupSorted.map((r) => r.score);
    const peakScores   = peakSorted.map((r) => r.score);
    const warmupAvg    = mean(warmupScores);
    const peakAvg      = peakScores.length > 0 ? mean(peakScores) : 0;
    const dropPct      = peakAvg > 0 ? ((peakAvg - warmupAvg) / peakAvg) * 100 : 0;

    // Count average warmup sessions per play block
    const blocks = groupIntoPlayBlocks(sorted);
    const warmupBlocks = blocks.filter(
      (b) => b.gapBeforeMs && b.gapBeforeMs >= WARMUP_GAP_MS &&
             b.sessions.some((s) => warmupIds.has(s.id)),
    );
    const avgWarmupSessions = warmupBlocks.length > 0
      ? warmupBlocks.reduce(
          (sum, b) => sum + b.sessions.filter((s) => warmupIds.has(s.id)).length, 0,
        ) / warmupBlocks.length
      : 0;

    return { warmupAvg, peakAvg, dropPct, avgWarmupSessions, blockCount: warmupBlocks.length };
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

      {/* ── Warmup section ───────────────────────────────────────────────── */}
      {showWarmupSection && warmupStats && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              paddingBottom: 10,
              borderBottom: "1px solid rgba(255,180,0,0.15)",
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#ffb400",
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: "#ffb400",
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              Warmup Phase
            </span>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginLeft: 4 }}>
              {warmupIds.size} session{warmupIds.size !== 1 ? "s" : ""} detected
            </span>
          </div>

          {/* Warmup summary cards */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={CARD_STYLE}>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.38)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                Warmup drop
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#ffb400" }}>
                −{warmupStats.dropPct.toFixed(1)}%
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 3 }}>
                vs your peak average
              </div>
            </div>
            <div style={CARD_STYLE}>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.38)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                Avg warmup sessions
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#ffb400" }}>
                {warmupStats.avgWarmupSessions.toFixed(1)}
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 3 }}>
                per play block
              </div>
            </div>
            <div style={CARD_STYLE}>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.38)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                Warmup avg score
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>
                {fmtScore(warmupStats.warmupAvg)}
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 3 }}>
                vs peak {fmtScore(warmupStats.peakAvg)}
              </div>
            </div>
          </div>

          {/* Warmup coaching card */}
          <div
            style={{
              background: "rgba(255,180,0,0.06)",
              border: "1px solid rgba(255,180,0,0.2)",
              borderRadius: 10,
              padding: "14px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  background: "rgba(255,180,0,0.2)",
                  border: "1px solid rgba(255,180,0,0.4)",
                  color: "#ffb400",
                  borderRadius: 4,
                  fontSize: 10,
                  padding: "2px 7px",
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                }}
              >
                Warmup Science
              </span>
              <span style={{ fontWeight: 700, fontSize: 13 }}>
                Your warmup takes ~{Math.ceil(warmupStats.avgWarmupSessions)} session{Math.ceil(warmupStats.avgWarmupSessions) !== 1 ? "s" : ""}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.55)", lineHeight: 1.7 }}>
              After a 6+ hour break you score ~{warmupStats.dropPct.toFixed(0)}% below your peak
              during the first {Math.ceil(warmupStats.avgWarmupSessions)} run{Math.ceil(warmupStats.avgWarmupSessions) !== 1 ? "s" : ""}.
              This is completely normal — your motor system needs to re-activate the neural pathways
              for fine aim control. These sessions are excluded from your peak-performance analysis above.
            </p>
            <div
              style={{
                background: "rgba(255,180,0,0.1)",
                borderLeft: "3px solid #ffb400",
                padding: "8px 12px",
                borderRadius: "0 6px 6px 0",
              }}
            >
              <div style={{ fontSize: 10, color: "#ffb400", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 5 }}>
                Action
              </div>
              <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.7)", lineHeight: 1.65 }}>
                {warmupStats.avgWarmupSessions <= 1
                  ? "You warm up quickly. A 3-minute easy tracking or large-target flicking routine before your first real run would likely eliminate the dip entirely."
                  : warmupStats.avgWarmupSessions <= 2
                  ? "Add a 5-minute structured warm-up routine (slow tracking → medium flicks → main scenario) before treating any run as a 'real' attempt. This pre-activates the motor patterns your main scenario needs."
                  : "Your warm-up is longer than average. Consider starting each session with 2–3 easy scenarios that progressively increase in difficulty, ending just below your main scenario's intensity. This structured ramp will tighten your warmup to 1–2 runs."}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Divider between sections when showing both */}
      {showWarmupSection && showPeakSection && warmupStats && scores.length >= 3 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            paddingBottom: 10,
            borderBottom: "1px solid rgba(0,245,160,0.15)",
          }}
        >
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#00f5a0", flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: "#00f5a0", textTransform: "uppercase", letterSpacing: 1 }}>
            Peak Performance
          </span>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginLeft: 4 }}>
            {coachSorted.length} session{coachSorted.length !== 1 ? "s" : ""} · warmup excluded
          </span>
        </div>
      )}

      {/* ── Peak performance section ──────────────────────────────────────── */}
      {showPeakSection && scores.length < 3 && (
        <div style={{ color: "rgba(255,255,255,0.3)", padding: "10px 0", lineHeight: 1.7 }}>
          Play at least 3 warmed-up sessions to unlock peak performance coaching.
        </div>
      )}
      {showPeakSection && scores.length >= 3 && (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* ── Aim Fingerprint ── */}
      {fingerprint && aimStyle && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ ...CHART_STYLE, flex: "1 1 280px", minWidth: 220 }}>
            <SectionTitle>Aim Fingerprint</SectionTitle>
            <ResponsiveContainer width="100%" height={220}>
              <RadarChart data={radarData} cx="50%" cy="50%">
                <PolarGrid stroke="rgba(255,255,255,0.1)" />
                <PolarAngleAxis
                  dataKey="metric"
                  tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 11 }}
                />
                <PolarRadiusAxis
                  angle={90}
                  domain={[0, 100]}
                  tick={false}
                  axisLine={false}
                />
                <Radar
                  dataKey="value"
                  stroke={aimStyle.color}
                  fill={aimStyle.color}
                  fillOpacity={0.18}
                  strokeWidth={2}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          <div
            style={{
              ...CHART_STYLE,
              flex: "1 1 200px",
              minWidth: 180,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: 10,
            }}
          >
            <div
              style={{
                fontSize: 10,
                color: "rgba(255,255,255,0.35)",
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              Aim Style
            </div>
            <div
              style={{ fontSize: 20, fontWeight: 800, color: aimStyle.color, lineHeight: 1.1 }}
            >
              {aimStyle.name}
            </div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", fontStyle: "italic" }}>
              {aimStyle.tagline}
            </div>
            <p
              style={{
                margin: 0,
                fontSize: 12,
                color: "rgba(255,255,255,0.55)",
                lineHeight: 1.65,
              }}
            >
              {aimStyle.description}
            </p>
            <div
              style={{
                fontSize: 11,
                color: aimStyle.color,
                borderTop: `1px solid ${aimStyle.color}30`,
                paddingTop: 10,
                lineHeight: 1.5,
              }}
            >
              <span style={{ opacity: 0.6 }}>Focus: </span>
              {aimStyle.focus}
            </div>
          </div>
        </div>
      )}

      {/* ── Score analytics cards ── */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard
          label="Consistency"
          value={scoreCV.toFixed(1) + "% spread"}
          sub={scoreCV < 5 ? "Very consistent" : scoreCV < 12 ? "Moderate variance" : "High variance"}
          accent={scoreCV < 5 ? "#00f5a0" : scoreCV < 12 ? "#ffd700" : "#ff6b6b"}
        />
        <StatCard
          label="Learning Rate"
          value={(slope > 0 ? "+" : "") + Math.round(slope) + " pts/run"}
          sub={isPlateau ? "Plateau detected" : slope > avgScoreVal * 0.005 ? "Trending up" : Math.abs(slope) < avgScoreVal * 0.005 ? "Stable" : "Trending down"}
          accent={slope > avgScoreVal * 0.005 ? "#00f5a0" : slope < -avgScoreVal * 0.01 ? "#ff6b6b" : "#ffd700"}
        />
        <StatCard label="Score Floor"  value={fmtScore(p10)} sub="your bottom 10% of runs" accent="#a78bfa" />
        <StatCard label="Typical Score" value={fmtScore(p50)} sub="your most common result" />
        <StatCard label="Peak Zone"    value={fmtScore(p90)} sub="your top 10% of runs" accent="#00f5a0" />
      </div>

      {/* ── Distribution chart ── */}
      <ScoreDistributionChart scores={sortedScores} p10={p10} p50={p50} p90={p90} />

      {/* ── Coaching cards ── */}
      {coachingCards.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <SectionTitle>Coaching Insights — click any card to expand</SectionTitle>
          {coachingCards.map((card, i) => (
            <CoachingCard key={i} card={card} />
          ))}
        </div>
      )}
      </div>  /* end peak performance section */
      )}
    </div>
  );
}

// ─── Scenario details (tabbed) ────────────────────────────────────────────────

function ScenarioDetails({ records, scenarioName }: { records: SessionRecord[]; scenarioName: string }) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>("all");

  const sorted = useMemo(
    () =>
      [...records].sort((a, b) => {
        const da = parseTimestamp(a.timestamp)?.getTime() ?? 0;
        const db = parseTimestamp(b.timestamp)?.getTime() ?? 0;
        return da - db;
      }),
    [records],
  );

  const warmupIds = useMemo(() => classifyWarmup(sorted), [sorted]);
  const hasWarmup = warmupIds.size > 0;

  const filteredRecords = useMemo(() => {
    if (sessionFilter === "warmup")   return records.filter((r) => warmupIds.has(r.id));
    if (sessionFilter === "warmedup") return records.filter((r) => !warmupIds.has(r.id));
    return records;
  }, [records, warmupIds, sessionFilter]);

  const filteredSorted = useMemo(() => {
    if (sessionFilter === "warmup")   return sorted.filter((r) => warmupIds.has(r.id));
    if (sessionFilter === "warmedup") return sorted.filter((r) => !warmupIds.has(r.id));
    return sorted;
  }, [sorted, warmupIds, sessionFilter]);

  const best = Math.max(...filteredRecords.map((r) => r.score), 0);
  const hasSmooth = records.some((r) => r.smoothness != null);

  const tabs: { id: Tab; label: string; hidden?: boolean }[] = [
    { id: "overview", label: "Overview" },
    { id: "movement", label: "Movement", hidden: !hasSmooth },
    { id: "performance", label: "Performance" },
    { id: "coaching", label: "Coaching" },
    { id: "replay", label: "Replay" },
    { id: "leaderboard", label: "Leaderboard" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Tab bar + session filter toggle */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 4,
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        {tabs.map((t) => {
          if (t.hidden) return null;
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                background: "none",
                border: "none",
                borderBottom: active ? "2px solid #00f5a0" : "2px solid transparent",
                padding: "8px 16px",
                marginBottom: -1,
                cursor: "pointer",
                color: active ? "#fff" : "rgba(255,255,255,0.4)",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: active ? 700 : 400,
                transition: "color 0.12s",
              }}
            >
              {t.label}
            </button>
          );
        })}

        {/* Session filter — only shown when warmup sessions have been detected */}
        {hasWarmup && (
          <div
            style={{
              display: "flex",
              gap: 4,
              marginLeft: "auto",
              marginBottom: 6,
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginRight: 4, textTransform: "uppercase", letterSpacing: 0.8 }}>
              View
            </span>
            {(["all", "warmup", "warmedup"] as SessionFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setSessionFilter(f)}
                style={{
                  background: sessionFilter === f
                    ? f === "warmup" ? "rgba(255,180,0,0.15)" : "rgba(0,245,160,0.12)"
                    : "none",
                  border: sessionFilter === f
                    ? f === "warmup" ? "1px solid rgba(255,180,0,0.4)" : "1px solid rgba(0,245,160,0.3)"
                    : "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 6,
                  padding: "4px 10px",
                  fontSize: 11,
                  color: sessionFilter === f
                    ? f === "warmup" ? "#ffb400" : "#00f5a0"
                    : "rgba(255,255,255,0.4)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  transition: "all 0.1s",
                }}
              >
                {f === "all" ? "All" : f === "warmup" ? "Warm-up" : "Warmed-up"}
              </button>
            ))}
          </div>
        )}
      </div>

      {activeTab === "overview" && (
        <OverviewTab records={filteredRecords} sorted={filteredSorted} best={best} warmupIds={warmupIds} />
      )}
      {activeTab === "movement" && <MovementTab records={filteredRecords} sorted={filteredSorted} />}
      {activeTab === "performance" && (
        <PerformanceTab records={filteredRecords} sorted={filteredSorted} />
      )}
      {activeTab === "coaching" && (
        <CoachingTab
          records={records}
          sorted={sorted}
          warmupIds={warmupIds}
          sessionFilter={sessionFilter}
        />
      )}
      {activeTab === "replay" && (
        <ReplayTab records={filteredRecords} sorted={filteredSorted} warmupIds={warmupIds} />
      )}
      {activeTab === "leaderboard" && <ScenarioLeaderboardPanel scenarioName={scenarioName} />}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

type RootMode = "sessions" | "leaderboards" | "debug";

export function StatsWindow({ embedded }: { embedded?: boolean } = {}) {
  const [records, setRecords] = useState<SessionRecord[]>([]);
  const [search, setSearch] = useState("");
  const [selectedScenario, setSelectedScenario] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [rootMode, setRootMode] = useState<RootMode>("sessions");
  const [liveBridgeStats, setLiveBridgeStats] = useState<Record<string, number>>({});
  const [liveBridgeEventCounts, setLiveBridgeEventCounts] = useState<Record<string, number>>({});

  // Always-current ref prevents stale closure in event listener
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedScenario;

  async function loadHistory(preserveSelection: boolean) {
    try {
      const data = await invoke<SessionRecord[]>("get_session_history");
      setRecords(data);
      if (!preserveSelection || !selectedRef.current) {
        if (data.length > 0) {
          const latest = data.reduce((a, b) =>
            (parseTimestamp(b.timestamp)?.getTime() ?? 0) >
            (parseTimestamp(a.timestamp)?.getTime() ?? 0)
              ? b
              : a,
          );
          setSelectedScenario(normalizeScenario(latest.scenario));
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadHistory(false);
    let lastBridgeRefresh = 0;
    const maybeRefreshHistory = (force = false) => {
      const now = Date.now();
      if (!force && now - lastBridgeRefresh < 1500) return;
      lastBridgeRefresh = now;
      loadHistory(true);
    };

    // Refresh when a session is finalized and persisted.
    const unlistenComplete = listen("session-complete", () => {
      maybeRefreshHistory(true);
    });

    // Fallback when bridge signals completion but file-watcher timing varies.
    const unlistenBridgeParsed = listen<BridgeParsedEvent>("bridge-parsed-event", (event) => {
      const ev = String(event.payload?.ev ?? "");
      if (
        ev === "challenge_complete" ||
        ev === "post_challenge_complete" ||
        ev === "challenge_quit" ||
        ev === "challenge_canceled"
      ) {
        maybeRefreshHistory(true);
      }
    });

    // Keep a tiny live snapshot so Session Stats isn't empty while no run is persisted yet.
    const unlistenBridgeMetric = listen<BridgeParsedEvent>("bridge-metric", (event) => {
      const ev = String(event.payload?.ev ?? "");
      const value = event.payload?.value;
      const delta = event.payload?.delta;
      if (!ev) return;

      if (ev.startsWith("pull_") && typeof value === "number" && Number.isFinite(value)) {
        setLiveBridgeStats((prev) => {
          if (prev[ev] === value) return prev;
          return { ...prev, [ev]: value };
        });
      }

      if (
        ev === "shot_fired" ||
        ev === "shot_hit" ||
        ev === "kill" ||
        ev === "challenge_queued" ||
        ev === "challenge_start" ||
        ev === "challenge_end" ||
        ev === "challenge_complete" ||
        ev === "challenge_completed" ||
        ev === "challenge_canceled" ||
        ev === "scenario_start" ||
        ev === "scenario_end"
      ) {
        const inc =
          typeof delta === "number" && Number.isFinite(delta)
            ? Math.max(1, Math.round(delta))
            : 1;
        setLiveBridgeEventCounts((prev) => ({ ...prev, [ev]: (prev[ev] ?? 0) + inc }));
      }
    });

    return () => {
      unlistenComplete.then((fn) => fn());
      unlistenBridgeParsed.then((fn) => fn());
      unlistenBridgeMetric.then((fn) => fn());
    };
  }, []);

  async function handleClear() {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    await invoke("clear_session_history");
    setRecords([]);
    setSelectedScenario(null);
    setConfirmClear(false);
  }

  const scenarioGroups = useMemo(() => {
    const q = search.toLowerCase();
    const map = new Map<string, { best: number; count: number; lastTs: string }>();
    for (const r of records) {
      const name = normalizeScenario(r.scenario);
      if (q && !name.toLowerCase().includes(q)) continue;
      const cur = map.get(name);
      const curTs = cur?.lastTs ?? "";
      const isNewer =
        (parseTimestamp(r.timestamp)?.getTime() ?? 0) >
        (parseTimestamp(curTs)?.getTime() ?? 0);
      map.set(name, {
        best: Math.max(cur?.best ?? 0, r.score),
        count: (cur?.count ?? 0) + 1,
        lastTs: isNewer ? r.timestamp : curTs,
      });
    }
    return [...map.entries()]
      .map(([name, s]) => ({ name, ...s }))
      .sort(
        (a, b) =>
          (parseTimestamp(b.lastTs)?.getTime() ?? 0) -
          (parseTimestamp(a.lastTs)?.getTime() ?? 0),
      );
  }, [records, search]);

  const selectedRecords = useMemo(
    () => records.filter((r) => normalizeScenario(r.scenario) === selectedScenario),
    [records, selectedScenario],
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: embedded ? "100%" : "100vh",
        background: "#0a0a0f",
        color: "#fff",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        overflow: "hidden",
      }}
    >
      {/* ── Mode tab bar ── */}
      <div
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          padding: "0 16px",
          background: "rgba(255,255,255,0.015)",
          flexShrink: 0,
        }}
      >
        {(["sessions", "leaderboards", "debug"] as RootMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setRootMode(m)}
            style={{
              background: "none",
              border: "none",
              borderBottom: rootMode === m ? "2px solid #00f5a0" : "2px solid transparent",
              padding: "11px 16px",
              marginBottom: -1,
              cursor: "pointer",
              color: rootMode === m ? "#fff" : "rgba(255,255,255,0.4)",
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: rootMode === m ? 700 : 400,
            }}
          >
            {m === "sessions" ? "Session Stats" : m === "leaderboards" ? "Leaderboards" : "Debug"}
          </button>
        ))}
      </div>

      {/* ── Sessions content ── */}
      {rootMode === "sessions" && (
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {/* ── Sidebar ── */}
      <div
        style={{
          width: 250,
          minWidth: 250,
          borderRight: "1px solid rgba(255,255,255,0.07)",
          display: "flex",
          flexDirection: "column",
          background: "rgba(255,255,255,0.015)",
        }}
      >
        <div style={{ padding: "18px 16px 12px" }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>
            Session Stats
          </div>
          <input
            type="text"
            placeholder="Search scenarios…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 7,
              padding: "7px 10px",
              color: "#fff",
              fontSize: 12,
              fontFamily: "inherit",
              outline: "none",
            }}
          />
        </div>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {loading ? (
            <div
              style={{ padding: "20px 16px", color: "rgba(255,255,255,0.3)", fontSize: 12 }}
            >
              Loading…
            </div>
          ) : scenarioGroups.length === 0 ? (
            <div
              style={{
                padding: "20px 16px",
                color: "rgba(255,255,255,0.25)",
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              {records.length === 0
                ? "No sessions recorded yet. Sessions are saved automatically when you finish a run."
                : "No matches."}
            </div>
          ) : (
            scenarioGroups.map((g) => {
              const active = g.name === selectedScenario;
              return (
                <button
                  key={g.name}
                  onClick={() => setSelectedScenario(g.name)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: active ? "rgba(0,245,160,0.08)" : "transparent",
                    border: "none",
                    borderLeft: active
                      ? "2px solid #00f5a0"
                      : "2px solid transparent",
                    padding: "10px 14px",
                    cursor: "pointer",
                    color: active ? "#fff" : "rgba(255,255,255,0.65)",
                    fontFamily: "inherit",
                    fontSize: 12,
                  }}
                >
                  <div
                    style={{
                      fontWeight: active ? 700 : 400,
                      marginBottom: 3,
                      lineHeight: 1.3,
                      wordBreak: "break-word",
                    }}
                  >
                    {g.name}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: active
                        ? "rgba(255,255,255,0.45)"
                        : "rgba(255,255,255,0.28)",
                      display: "flex",
                      gap: 10,
                    }}
                  >
                    <span>
                      {g.count} run{g.count !== 1 ? "s" : ""}
                    </span>
                    <span
                      style={{
                        color: active ? "#00f5a0" : "rgba(255,255,255,0.35)",
                      }}
                    >
                      PB {fmtScore(g.best)}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div
          style={{
            padding: "10px 16px",
            borderTop: "1px solid rgba(255,255,255,0.07)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.25)" }}>
            {records.length} total
          </span>
          <button
            onClick={handleClear}
            onBlur={() => setConfirmClear(false)}
            style={{
              background: confirmClear ? "rgba(255,107,107,0.15)" : "transparent",
              border: `1px solid ${confirmClear ? "#ff6b6b" : "rgba(255,255,255,0.12)"}`,
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
              color: confirmClear ? "#ff6b6b" : "rgba(255,255,255,0.4)",
              fontFamily: "inherit",
              fontSize: 11,
              transition: "all 0.15s",
            }}
          >
            {confirmClear ? "Confirm clear" : "Clear"}
          </button>
        </div>
      </div>

      {/* ── Main panel ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
        {selectedScenario && selectedRecords.length > 0 ? (
          <>
            <h2
              style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 700, color: "#fff" }}
            >
              {selectedScenario}
            </h2>
            <ScenarioDetails records={selectedRecords} scenarioName={selectedScenario!} />
          </>
        ) : (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              color: "rgba(255,255,255,0.2)",
              gap: 12,
            }}
          >
            <div>
              {records.length === 0
                ? "Play a session to start recording stats."
                : "Select a scenario from the sidebar."}
            </div>
            {records.length === 0 &&
              (Object.keys(liveBridgeStats).length > 0 || Object.keys(liveBridgeEventCounts).length > 0) && (
              <div
                style={{
                  marginTop: 4,
                  border: "1px solid rgba(0,245,160,0.22)",
                  background: "rgba(0,245,160,0.06)",
                  borderRadius: 8,
                  padding: "10px 12px",
                  minWidth: 320,
                  color: "rgba(255,255,255,0.82)",
                }}
              >
                <div style={{ fontSize: 12, marginBottom: 6, color: "#00f5a0" }}>
                  Live AimMod metrics (not persisted yet)
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 10px", fontSize: 11 }}>
                  {[
                    "pull_shots_fired_total",
                    "pull_shots_hit_total",
                    "pull_kills_total",
                    "pull_score_per_minute",
                    "pull_score_total_derived",
                    "pull_score_total",
                    "pull_damage_done",
                    "pull_damage_possible",
                    "pull_damage_efficiency",
                    "pull_kills_per_second",
                    "pull_seconds_total",
                  ].map((k) => (
                    <div key={k} style={{ display: "contents" }}>
                      <span style={{ color: "rgba(255,255,255,0.6)" }}>{k}</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                        {liveBridgeStats[k] !== undefined ? String(liveBridgeStats[k]) : "-"}
                      </span>
                    </div>
                  ))}
                </div>
                {Object.keys(liveBridgeEventCounts).length > 0 && (
                  <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 10px", fontSize: 11 }}>
                    {[
                      "challenge_queued",
                      "challenge_start",
                      "scenario_start",
                      "shot_fired",
                      "shot_hit",
                      "kill",
                      "challenge_complete",
                      "challenge_canceled",
                    ].map((k) => (
                      <div key={k} style={{ display: "contents" }}>
                        <span style={{ color: "rgba(255,255,255,0.6)" }}>{k}</span>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                          {liveBridgeEventCounts[k] !== undefined ? String(liveBridgeEventCounts[k]) : "-"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
        </div>
      )}

      {/* ── Leaderboards content ── */}
      {rootMode === "leaderboards" && (
        <div style={{ flex: 1, overflow: "hidden" }}>
          <LeaderboardBrowser />
        </div>
      )}

      {/* ── Memory debug ── */}
      {rootMode === "debug" && (
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
          <DebugTab />
        </div>
      )}
    </div>
  );
}
