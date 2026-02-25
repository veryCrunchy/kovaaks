import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
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
}

type Tab = "overview" | "mouse" | "gamestats" | "trends";

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
          fontSize: 20,
          fontWeight: 700,
          color: accent ?? "#fff",
          lineHeight: 1,
        }}
      >
        {value}
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
      insights.push({ kind: "positive", category: "mouse", title: "Excellent smoothness", description: `Average composite ${composite.toFixed(1)}/100 — your ${smoothPositiveCtx}.` });
    else if (composite < 40)
      insights.push({ kind: "issue", severity: "high", category: "mouse", title: "Very low smoothness", description: `Average composite ${composite.toFixed(1)}/100. ${smoothHighIssueCtx}` });
    else if (composite < 60)
      insights.push({ kind: "issue", severity: "medium", category: "mouse", title: "Below-average smoothness", description: `Average composite ${composite.toFixed(1)}/100. Slow, deliberate practice builds the muscle memory needed for consistent ${isTracking ? "tracking" : "aim"}.` });

    // Jitter
    const jitterHighCtx = isTracking
      ? "Lateral wobble directly reduces on-target time. Check mouse feet wear, grip tension, or try a lower polling rate."
      : isAccuracy
      ? "Micro-tremor on precision targets wastes micro-adjustments. Try lower sensitivity, more wrist support, or relaxing your grip."
      : "Frequent micro-direction changes. Check mouse feet wear, grip tension, or try a lower polling rate.";

    if (jitter > 0.5)
      insights.push({ kind: "issue", severity: "high", category: "mouse", title: "High jitter", description: jitterHighCtx });
    else if (jitter > 0.3)
      insights.push({ kind: "issue", severity: "medium", category: "mouse", title: "Moderate jitter", description: isTracking
        ? "Off-axis wobble during tracking segments. Ensure your grip is relaxed and elbow rests comfortably."
        : "Some jitter present. Ensure your grip is relaxed and elbow rests comfortably." });
    else if (jitter < 0.15)
      insights.push({ kind: "positive", category: "mouse", title: "Very steady aim", description: `Low jitter (${jitter.toFixed(3)})${isTracking ? " — cursor stays locked on-axis with minimal lateral drift" : " — clean aim line with minimal micro-tremor"}.` });

    // Overshoot
    const overshootHighCtx = isOneShot
      ? "Each overshoot on a one-shot target costs a kill. Practice braking earlier so the cursor arrives on target, not past it."
      : isReactive
      ? "Overshooting increases effective reaction TTK. Practice decelerating into the target zone rather than snapping through it."
      : "You overshoot targets often after flicks. Try deceleration drills or wrist aim exercises.";

    const overshootLowCtx = isOneShot
      ? "Light overshooting on one-tap flicks. A touch more deceleration near the target will improve first-bullet accuracy."
      : "Light overshooting after flicks. Practice controlled micro-adjustments after each flick.";

    const overshootGoodCtx = isOneShot
      ? "flicks land on target first-try, maximising kills per bullet"
      : "flicks land accurately without excess correction";

    if (overshoot > 0.4)
      insights.push({ kind: "issue", severity: "high", category: "mouse", title: "Frequent overshooting", description: overshootHighCtx });
    else if (overshoot > 0.2)
      insights.push({ kind: "issue", severity: "low", category: "mouse", title: "Occasional overshooting", description: overshootLowCtx });
    else if (overshoot < 0.1)
      insights.push({ kind: "positive", category: "mouse", title: "Precise flick control", description: `Very low overshoot rate — ${overshootGoodCtx}.` });

    // Path efficiency
    const pathHighIssueCtx = isTracking
      ? "Cursor weaves around the tracking target instead of staying locked. Forearm tension or over-gripping is common — relax and try to follow the target in a straight arc."
      : isAccuracy
      ? "Curved approaches to precision targets build inconsistent muscle memory. Slow down and approach each target from a consistent angle."
      : "Cursor takes a noticeably curved route to targets. Wrist instability or over-gripping. Relax grip and slow deliberate movements.";

    const pathGoodCtx = isTracking
      ? "cursor stays locked on the tracking target with minimal drift"
      : "cursor travels in a nearly straight line to targets";

    if (path < 0.72)
      insights.push({ kind: "issue", severity: "high", category: "mouse", title: "Severely curved paths", description: pathHighIssueCtx });
    else if (path < 0.82)
      insights.push({ kind: "issue", severity: "medium", category: "mouse", title: "Wobbly paths", description: isTracking
        ? "Cursor drifts off the tracking line. Forearm or wrist tension is a common cause."
        : "Cursor drifts off-axis during flicks. Forearm or wrist tension is a common cause." });
    else if (path > 0.92)
      insights.push({ kind: "positive", category: "mouse", title: "Straight aim paths", description: `Path efficiency ${(path * 100).toFixed(1)}% — ${pathGoodCtx}.` });

    // Correction ratio
    const corrHighCtx = isMultiHit
      ? "Too long in the correction phase on multi-hit targets — decisiveness wins more damage. Slightly lower sensitivity can improve micro-adjustment precision."
      : isReactive
      ? "High correction time on reactive targets increases effective TTK. Trust your initial flick and commit to the shot sooner."
      : "High time in Fitts' correction phase. You may be unsure of target positions — reduce sensitivity for more precise micro-adjustments.";

    const corrGoodCtx = isReactive
      ? "reacting and committing to the kill in one clean motion"
      : "committing to shots quickly and with confidence";

    if (correction > 0.45)
      insights.push({ kind: "issue", severity: "medium", category: "mouse", title: "Over-correction behavior", description: corrHighCtx });
    else if (correction < 0.2)
      insights.push({ kind: "positive", category: "mouse", title: "Decisive aim", description: `Low correction ratio — ${corrGoodCtx}.` });

    // Directional bias
    if (bias > 0.6)
      insights.push({ kind: "issue", severity: "medium", category: "mouse", title: "Consistent overshoot bias", description: "You systematically overshoot to the same side. Check if mousepad is angled or if you have a dominant wrist rotation." });
    else if (bias < 0.2)
      insights.push({ kind: "positive", category: "mouse", title: "Balanced directional control", description: "No systematic bias — overshoot correction is well-calibrated in both directions." });

    // Click timing — only meaningful for clicking scenarios
    if (!isTracking) {
      const clickHighCtx = isMultiHit
        ? "Rhythmic clicking while tracking multi-hit targets maximises damage output. Click timing trainers can lock in a consistent rhythm."
        : isReactive
        ? "Inconsistent reaction-to-click gap. Practice pre-committing — once your cursor lands on the target, fire immediately."
        : "High click timing variance. Rhythm drills or click-timing trainers can improve consistency.";

      const clickGoodCtx = isMultiHit
        ? "rhythmic shots are maximising DPS on multi-hit targets"
        : "clicks are rhythmically precise";

      if (clickCV > 0.5)
        insights.push({ kind: "issue", severity: "low", category: "mouse", title: "Inconsistent click timing", description: clickHighCtx });
      else if (clickCV < 0.15)
        insights.push({ kind: "positive", category: "mouse", title: "Consistent click rhythm", description: `Very low click timing variance — ${clickGoodCtx}.` });
    }

    // Tracking-specific: velocity consistency
    if (isTracking) {
      if (velStd > 0.6)
        insights.push({ kind: "issue", severity: "medium", category: "mouse", title: "Uneven tracking speed", description: `Speed CV ${(velStd * 100).toFixed(0)}% — cursor accelerates and brakes rather than smoothly following the target. Focus on matching and anticipating the target's velocity.` });
      else if (velStd < 0.3)
        insights.push({ kind: "positive", category: "mouse", title: "Smooth tracking velocity", description: `Speed CV ${(velStd * 100).toFixed(0)}% — consistent velocity shows strong target prediction and arm control.` });
    }
  }

  // ── Stats-panel / game insights ───────────────────────────────────────────
  if (panelRecords.length >= 3) {
    const withTrend = panelRecords.filter((r) => r.stats_panel!.accuracy_trend != null);
    if (withTrend.length >= 2) {
      const avgTrend = mean(withTrend.map((r) => r.stats_panel!.accuracy_trend!));
      if (avgTrend < -5) {
        const ctx = isTracking
          ? `On-target time drops ~${Math.abs(avgTrend).toFixed(1)}% from first to second half. Consider shorter sessions or breaks between runs.`
          : `Accuracy drops ~${Math.abs(avgTrend).toFixed(1)}% from first to second half. Consider shorter sessions or mental fatigue breaks.`;
        insights.push({ kind: "issue", severity: "medium", category: "game", title: "Accuracy fatigue", description: ctx });
      } else if (avgTrend > 5) {
        const metric = isTracking ? "Tracking accuracy" : "Accuracy";
        insights.push({ kind: "positive", category: "game", title: "Warming up well", description: `${metric} improves ~${avgTrend.toFixed(1)}% as sessions progress — you warm up effectively.` });
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
          ? `Reaction TTK varies widely (CV ${(cv * 100).toFixed(0)}%). Build a consistent pre-aim routine so reaction windows are repeatable.`
          : isOneShot
          ? `Kill speed varies a lot (CV ${(cv * 100).toFixed(0)}%). Some targets take much longer than others — work on consistent flick tempo.`
          : `High TTK variance (CV ${(cv * 100).toFixed(0)}%) — kill speed varies significantly. Work on consistent engagement timing.`;
        insights.push({ kind: "issue", severity: "medium", category: "game", title: "Inconsistent TTK", description: ctx });
      } else if (cv < 0.2 && avgTtkMean < ttkGoodMs) {
        const ctx = isReactive
          ? `Avg reaction TTK ${avgTtkMean.toFixed(0)}ms with low variance — fast, consistent reactions.`
          : `Avg TTK ${avgTtkMean.toFixed(0)}ms with low variance (CV ${(cv * 100).toFixed(0)}%) — kills are landing reliably.`;
        insights.push({ kind: "positive", category: "game", title: "Consistent TTK", description: ctx });
      }
    }

    // Per-type accuracy benchmarks
    const withAcc = panelRecords.filter((r) => r.stats_panel!.accuracy_pct != null);
    if (withAcc.length >= 3) {
      const avgAcc       = mean(withAcc.map((r) => r.stats_panel!.accuracy_pct!));
      const goodThreshold = isTracking ? 65 : isMultiHit ? 50 : isAccuracy ? 75 : 58;
      const lowThreshold  = isTracking ? 40 : isMultiHit ? 30 : isAccuracy ? 50 : 38;

      if (avgAcc >= goodThreshold + 15) {
        const ctx = isTracking
          ? `${avgAcc.toFixed(1)}% average on-target time — strong target lock throughout sessions.`
          : isOneShot
          ? `${avgAcc.toFixed(1)}% on one-tap targets — nearly every flick is landing cleanly.`
          : `${avgAcc.toFixed(1)}% average accuracy — few wasted shots.`;
        insights.push({ kind: "positive", category: "game", title: isTracking ? "High tracking accuracy" : "High accuracy", description: ctx });
      } else if (avgAcc < lowThreshold) {
        const ctx = isTracking
          ? `${avgAcc.toFixed(1)}% average on-target time. Focus on staying locked rather than chasing. Lower sensitivity may help.`
          : isMultiHit
          ? `${avgAcc.toFixed(1)}% accuracy — too many shots are missing. Prioritise target acquisition over firing speed.`
          : isOneShot
          ? `${avgAcc.toFixed(1)}% on one-taps. Work on controlled flicks — placement before speed.`
          : `${avgAcc.toFixed(1)}% average accuracy. Slow down slightly and focus on placement before speed.`;
        insights.push({ kind: "issue", severity: "medium", category: "game", title: isTracking ? "Low tracking accuracy" : "Low accuracy", description: ctx });
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
            {ins.severity}
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
}: {
  records: SessionRecord[];
  sorted: SessionRecord[];
  best: number;
}) {
  const avgScore = mean(records.map((r) => r.score));
  const accRecords = records.filter((r) => r.accuracy > 0);
  const avgAcc = accRecords.length ? mean(accRecords.map((r) => r.accuracy)) : null;
  const totalKills = records.reduce((s, r) => s + r.kills, 0);
  const killRecords = records.filter((r) => r.kills > 0);
  const avgKills = killRecords.length ? mean(killRecords.map((r) => r.kills)) : null;
  const latestRecord = sorted[sorted.length - 1];

  const chartData = sorted.map((r, i) => ({
    i: i + 1,
    score: Math.round(r.score),
    dateLabel: formatDateTime(r.timestamp),
  }));

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

      {/* Score trend */}
      <div style={CHART_STYLE}>
        <SectionTitle>Score over time</SectionTitle>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#00f5a0" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#00f5a0" stopOpacity={0} />
              </linearGradient>
            </defs>
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
            <Area
              type="monotone"
              dataKey="score"
              name="Score"
              stroke="#00f5a0"
              strokeWidth={2}
              fill="url(#scoreGrad)"
              dot={false}
              activeDot={{ r: 4, fill: "#00f5a0" }}
            />
          </AreaChart>
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
              return (
                <tr
                  key={r.id}
                  style={{
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    background: isBest
                      ? "rgba(0,245,160,0.04)"
                      : idx % 2 === 0
                        ? "transparent"
                        : "rgba(255,255,255,0.01)",
                  }}
                >
                  <td style={{ padding: "8px 4px 8px 0", color: "rgba(255,255,255,0.5)" }}>
                    {formatDateTime(r.timestamp)}
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

// ─── Mouse tab ────────────────────────────────────────────────────────────────

function MouseTab({
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
      label: "Composite",
      value: avgComposite.toFixed(1),
      unit: "/100",
      note: "higher = better",
      accent:
        avgComposite >= 70 ? "#00f5a0" : avgComposite >= 50 ? "#ffd700" : "#ff6b6b",
    },
    {
      label: "Jitter",
      value: avgJitter.toFixed(3),
      note: "lower = better",
      accent: avgJitter < 0.2 ? "#00f5a0" : avgJitter < 0.35 ? "#ffd700" : "#ff6b6b",
    },
    {
      label: "Overshoot",
      value: (avgOvershoot * 100).toFixed(1),
      unit: "%",
      note: "lower = better",
      accent:
        avgOvershoot < 0.15 ? "#00f5a0" : avgOvershoot < 0.3 ? "#ffd700" : "#ff6b6b",
    },
    {
      label: "Path Eff.",
      value: (avgPath * 100).toFixed(1),
      unit: "%",
      note: "higher = better",
      accent: avgPath > 0.87 ? "#00f5a0" : avgPath > 0.75 ? "#ffd700" : "#ff6b6b",
    },
    {
      label: "Speed CV",
      value: (avgVelStd * 100).toFixed(1),
      unit: "%",
      note: "lower = consistent",
      accent: avgVelStd < 0.4 ? "#00f5a0" : avgVelStd < 0.6 ? "#ffd700" : "#ff6b6b",
    },
    {
      label: "Correction",
      value: (avgCorrection * 100).toFixed(1),
      unit: "%",
      note: "lower = decisive",
      accent:
        avgCorrection < 0.25 ? "#00f5a0" : avgCorrection < 0.4 ? "#ffd700" : "#ff6b6b",
    },
    {
      label: "Dir. Bias",
      value: (avgBias * 100).toFixed(1),
      unit: "%",
      note: "lower = balanced",
      accent: avgBias < 0.25 ? "#00f5a0" : avgBias < 0.5 ? "#ffd700" : "#ff6b6b",
    },
    {
      label: "Click CV",
      value: avgClickCV.toFixed(3),
      note: "lower = rhythmic",
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
            { color: "#00b4ff", label: "Composite" },
            { color: "#00f5a0", label: "Path eff. %" },
            { color: "#ffd700", label: "Speed CV %" },
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
              name="Composite"
              stroke="#00b4ff"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="path_eff"
              name="Path eff. %"
              stroke="#00f5a0"
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="vel_std"
              name="Speed CV %"
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
        <SectionTitle>Error metrics (lower = better)</SectionTitle>
        <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
          {[
            { color: "#ff6b6b", label: "Jitter ×100" },
            { color: "#ff9f43", label: "Overshoot %" },
            { color: "#a78bfa", label: "Correction %" },
            { color: "#e056fd", label: "Dir. Bias %" },
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
              name="Jitter ×100"
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
              name="Correction %"
              stroke="#a78bfa"
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="bias"
              name="Dir. Bias %"
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

// ─── Game Stats tab ───────────────────────────────────────────────────────────

function GameStatsTab({
  records,
  sorted,
}: {
  records: SessionRecord[];
  sorted: SessionRecord[];
}) {
  const panelRecords = records.filter((r) => r.stats_panel !== null);

  if (panelRecords.length === 0) {
    return (
      <div style={{ color: "rgba(255,255,255,0.3)", padding: 20, lineHeight: 1.7 }}>
        No in-game stats data recorded for this scenario.
        <br />
        Configure the stats panel OCR region in Settings to capture kill count,
        accuracy, and TTK.
      </div>
    );
  }

  const panelSorted = sorted.filter((r) => r.stats_panel !== null);

  const withKps = panelRecords.filter((r) => r.stats_panel!.avg_kps != null);
  const withAcc = panelRecords.filter((r) => r.stats_panel!.accuracy_pct != null);
  const withTtk = panelRecords.filter((r) => r.stats_panel!.avg_ttk_ms != null);
  const withBestTtk = panelRecords.filter((r) => r.stats_panel!.best_ttk_ms != null);
  const withTrend = panelRecords.filter(
    (r) => r.stats_panel!.accuracy_trend != null,
  );

  const avgKps = withKps.length ? mean(withKps.map((r) => r.stats_panel!.avg_kps!)) : null;
  const avgAccPct = withAcc.length
    ? mean(withAcc.map((r) => r.stats_panel!.accuracy_pct!))
    : null;
  const avgTtk = withTtk.length ? mean(withTtk.map((r) => r.stats_panel!.avg_ttk_ms!)) : null;
  const bestTtk = withBestTtk.length
    ? Math.min(...withBestTtk.map((r) => r.stats_panel!.best_ttk_ms!))
    : null;
  const avgTrend = withTrend.length
    ? mean(withTrend.map((r) => r.stats_panel!.accuracy_trend!))
    : null;

  const scenarioType =
    panelRecords[panelRecords.length - 1]?.stats_panel?.scenario_type ?? "Unknown";

  const chartData = panelSorted.map((r, i) => ({
    i: i + 1,
    kps: r.stats_panel!.avg_kps != null ? +r.stats_panel!.avg_kps!.toFixed(2) : null,
    acc:
      r.stats_panel!.accuracy_pct != null
        ? +r.stats_panel!.accuracy_pct!.toFixed(1)
        : null,
    ttk:
      r.stats_panel!.avg_ttk_ms != null
        ? +r.stats_panel!.avg_ttk_ms!.toFixed(0)
        : null,
    ttk_std:
      r.stats_panel!.ttk_std_ms != null
        ? +r.stats_panel!.ttk_std_ms!.toFixed(0)
        : null,
    trend:
      r.stats_panel!.accuracy_trend != null
        ? +r.stats_panel!.accuracy_trend!.toFixed(1)
        : null,
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
            sub="2nd half vs 1st half"
            accent={avgTrend > 2 ? "#00f5a0" : avgTrend < -2 ? "#ff6b6b" : "rgba(255,255,255,0.6)"}
          />
        )}
      </div>

      {/* TTK trend */}
      {withTtk.length > 1 && (
        <div style={CHART_STYLE}>
          <SectionTitle>Time-to-kill (ms) — lower = faster</SectionTitle>
          <div style={{ display: "flex", gap: 16, marginBottom: 10 }}>
            {[
              { color: "#ffd700", label: "Avg TTK" },
              { color: "#ff9f43", label: "TTK std dev" },
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
                name="TTK std dev"
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
            Within-session accuracy trend — positive = improving as session progresses
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

// ─── Trends tab ───────────────────────────────────────────────────────────────

function TrendsTab({
  records,
  sorted,
}: {
  records: SessionRecord[];
  sorted: SessionRecord[];
}) {
  const hasSmooth = records.some((r) => r.smoothness != null);
  const hasPanelAcc = records.some((r) => r.stats_panel?.accuracy_pct != null);
  const hasTtk = records.some((r) => r.stats_panel?.avg_ttk_ms != null);

  const chartData = sorted.map((r, i) => ({
    i: i + 1,
    score: Math.round(r.score),
    composite: r.smoothness?.composite != null ? +r.smoothness.composite.toFixed(1) : null,
    acc:
      r.stats_panel?.accuracy_pct != null
        ? +r.stats_panel.accuracy_pct.toFixed(1)
        : null,
    ttk:
      r.stats_panel?.avg_ttk_ms != null
        ? +r.stats_panel.avg_ttk_ms.toFixed(0)
        : null,
    path_eff:
      r.smoothness?.path_efficiency != null
        ? +(r.smoothness.path_efficiency * 100).toFixed(1)
        : null,
    dateLabel: formatDateTime(r.timestamp),
  }));

  // Compute % change between first and second half of sessions
  function halfDelta(key: keyof (typeof chartData)[0], invert = false): string {
    const vals = chartData
      .map((d) => d[key])
      .filter((v): v is number => v !== null);
    if (vals.length < 4) return "—";
    const half = Math.floor(vals.length / 2);
    const first = mean(vals.slice(0, half));
    const second = mean(vals.slice(half));
    const delta = second - first;
    const pct = first !== 0 ? (delta / Math.abs(first)) * 100 : 0;
    const improved = invert ? delta < 0 : delta > 0;
    return `${delta > 0 ? "+" : ""}${pct.toFixed(1)}% ${improved ? "↑" : "↓"}`;
  }

  const cards = [
    { label: "Score", key: "score" as const, invert: false, color: "#00f5a0" },
    ...(hasSmooth
      ? [{ label: "Smoothness", key: "composite" as const, invert: false, color: "#00b4ff" }]
      : []),
    ...(hasPanelAcc
      ? [{ label: "Accuracy", key: "acc" as const, invert: false, color: "#a78bfa" }]
      : []),
    ...(hasTtk
      ? [{ label: "Avg TTK", key: "ttk" as const, invert: true, color: "#ffd700" }]
      : []),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Half-delta summary */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {cards.map((c) => {
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
                  color: neutral
                    ? "rgba(255,255,255,0.3)"
                    : improved
                      ? "#00f5a0"
                      : "#ff6b6b",
                }}
              >
                {delta}
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 3 }}>
                2nd half vs 1st half
              </div>
            </div>
          );
        })}
      </div>

      {/* Score */}
      <div style={CHART_STYLE}>
        <SectionTitle>Score progression</SectionTitle>
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
              width={52}
              tickFormatter={(v: number) =>
                v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
              }
            />
            <Tooltip content={<MiniTooltip />} />
            <Line
              type="monotone"
              dataKey="score"
              name="Score"
              stroke="#00f5a0"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Smoothness + path */}
      {hasSmooth && (
        <div style={CHART_STYLE}>
          <SectionTitle>Mouse quality over time</SectionTitle>
          <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
            {[
              { color: "#00b4ff", label: "Composite" },
              { color: "#00f5a0", label: "Path eff. %" },
            ].map((l) => (
              <div
                key={l.label}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <div
                  style={{ width: 12, height: 2, borderRadius: 2, background: l.color }}
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
                dataKey="composite"
                name="Composite"
                stroke="#00b4ff"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="path_eff"
                name="Path eff. %"
                stroke="#00f5a0"
                strokeWidth={1.5}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Accuracy + TTK */}
      {(hasPanelAcc || hasTtk) && (
        <div style={CHART_STYLE}>
          <SectionTitle>Game performance over time</SectionTitle>
          <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
            {[
              ...(hasPanelAcc ? [{ color: "#a78bfa", label: "Accuracy %" }] : []),
              ...(hasTtk ? [{ color: "#ffd700", label: "Avg TTK (ms)" }] : []),
            ].map((l) => (
              <div
                key={l.label}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <div
                  style={{ width: 12, height: 2, borderRadius: 2, background: l.color }}
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
              {hasPanelAcc && (
                <Line
                  type="monotone"
                  dataKey="acc"
                  name="Accuracy %"
                  stroke="#a78bfa"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              )}
              {hasTtk && (
                <Line
                  type="monotone"
                  dataKey="ttk"
                  name="Avg TTK (ms)"
                  stroke="#ffd700"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ─── Scenario details (tabbed) ────────────────────────────────────────────────

function ScenarioDetails({ records }: { records: SessionRecord[] }) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  const sorted = useMemo(
    () =>
      [...records].sort((a, b) => {
        const da = parseTimestamp(a.timestamp)?.getTime() ?? 0;
        const db = parseTimestamp(b.timestamp)?.getTime() ?? 0;
        return da - db;
      }),
    [records],
  );

  const best = Math.max(...records.map((r) => r.score));
  const hasSmooth = records.some((r) => r.smoothness != null);
  const hasPanel = records.some((r) => r.stats_panel != null);

  const tabs: { id: Tab; label: string; hidden?: boolean }[] = [
    { id: "overview", label: "Overview" },
    { id: "mouse", label: "Mouse", hidden: !hasSmooth },
    { id: "gamestats", label: "Game Stats", hidden: !hasPanel },
    { id: "trends", label: "Trends" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Tab bar */}
      <div
        style={{
          display: "flex",
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
      </div>

      {activeTab === "overview" && (
        <OverviewTab records={records} sorted={sorted} best={best} />
      )}
      {activeTab === "mouse" && <MouseTab records={records} sorted={sorted} />}
      {activeTab === "gamestats" && (
        <GameStatsTab records={records} sorted={sorted} />
      )}
      {activeTab === "trends" && <TrendsTab records={records} sorted={sorted} />}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export function StatsWindow({ embedded }: { embedded?: boolean } = {}) {
  const [records, setRecords] = useState<SessionRecord[]>([]);
  const [search, setSearch] = useState("");
  const [selectedScenario, setSelectedScenario] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);

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
    const unlisten = listen("session-complete", () => loadHistory(true));
    return () => {
      unlisten.then((fn) => fn());
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
        height: embedded ? "100%" : "100vh",
        background: "#0a0a0f",
        color: "#fff",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        overflow: "hidden",
      }}
    >
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
            <ScenarioDetails records={selectedRecords} />
          </>
        ) : (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "rgba(255,255,255,0.2)",
            }}
          >
            {records.length === 0
              ? "Play a session to start recording stats."
              : "Select a scenario from the sidebar."}
          </div>
        )}
      </div>
    </div>
  );
}
