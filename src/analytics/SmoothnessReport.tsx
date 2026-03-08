import { useEffect, useState } from "react";
import { C } from "../design/tokens";
import { Dot, Badge } from "../design/ui";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  ReferenceLine,
} from "recharts";
import type { MetricPoint, RawPositionPoint, ScreenFrame } from "../types/mouse";
import { MousePathViewer } from "./MousePathViewer";

interface Issue {
  severity: "high" | "medium" | "low";
  title: string;
  description: string;
}

function detectIssues(points: MetricPoint[]): Issue[] {
  if (points.length === 0) return [];

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const smoothnesses = points.map((p) => p.metrics.smoothness);
  const jitters = points.map((p) => p.metrics.jitter);
  const overshoots = points.map((p) => p.metrics.overshoot_rate);

  const pathEfficiencies = points.map((p) => p.metrics.path_efficiency);

  const avgSmooth = avg(smoothnesses);
  const avgJitter = avg(jitters);
  const avgOvershoot = avg(overshoots);
  const avgPathEff = avg(pathEfficiencies);

  const issues: Issue[] = [];

  if (avgSmooth < 40) {
    issues.push({
      severity: "high",
      title: "Very low smoothness",
      description:
        "Your overall smoothness is below 40. Consider lowering your sensitivity or using a larger mousepad.",
    });
  } else if (avgSmooth < 60) {
    issues.push({
      severity: "medium",
      title: "Below-average smoothness",
      description:
        "Your smoothness averages below 60. Slow, deliberate practice movements can help build muscle memory.",
    });
  }

  if (avgJitter > 0.5) {
    issues.push({
      severity: "high",
      title: "High jitter detected",
      description:
        "Frequent micro-direction changes were detected. Check for mouse feet wear or try a lower polling rate.",
    });
  } else if (avgJitter > 0.3) {
    issues.push({
      severity: "medium",
      title: "Moderate jitter",
      description:
        "Some jitter is present. Ensure your grip is relaxed and your elbow rests comfortably.",
    });
  }

  if (avgOvershoot > 0.4) {
    issues.push({
      severity: "high",
      title: "Frequent overshooting",
      description:
        "You overshoot targets often after fast flicks. Try Voltaic's deceleration drills or wrist aim exercises.",
    });
  } else if (avgOvershoot > 0.2) {
    issues.push({
      severity: "low",
      title: "Occasional overshooting",
      description:
        "Light overshooting after flicks. Practice controlled micro-adjustments after each flick.",
    });
  }

  if (avgPathEff < 0.72) {
    issues.push({
      severity: "high",
      title: "Severely curved paths",
      description:
        "Your cursor takes a noticeably curved or S-shaped route to targets. This usually means wrist instability or gripping the mouse too tightly. Try relaxing your grip and slowing down deliberate practice movements.",
    });
  } else if (avgPathEff < 0.82) {
    issues.push({
      severity: "medium",
      title: "Wobbly paths detected",
      description:
        "Your cursor drifts off-axis during flicks, resulting in curved paths. Tension in the forearm or wrist is a common cause. Deliberate slow-tracking exercises and lower sensitivity can help.",
    });
  }

  return issues;
}

const SEVERITY_COLOR: Record<string, string> = {
  high: "#ff4d4d",
  medium: "#ffd700",
  low: "#00b4ff",
};

export function SmoothnessReport() {
  const [points, setPoints] = useState<MetricPoint[]>([]);
  const [rawPositions, setRawPositions] = useState<RawPositionPoint[]>([]);
  const [screenFrames, setScreenFrames] = useState<ScreenFrame[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSessionData = () => {
    Promise.all([
      invoke<MetricPoint[]>("get_session_mouse_data"),
      invoke<RawPositionPoint[]>("get_session_raw_positions"),
      invoke<ScreenFrame[]>("get_session_screen_frames"),
    ])
      .then(([data, raw, frames]) => {
        setPoints(data);
        setRawPositions(raw);
        setScreenFrames(frames);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    fetchSessionData();
    // Re-fetch automatically whenever a session finishes
    const unlisten = listen("session-complete", () => fetchSessionData());
    return () => { unlisten.then((fn) => fn()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const issues = detectIssues(points);

  const chartData = points.map((p) => ({
    t: Math.round(p.timestamp_ms / 1000),
    smoothness: Math.round(p.metrics.smoothness),
    jitter: parseFloat((p.metrics.jitter * 100).toFixed(1)),
    overshoot: parseFloat((p.metrics.overshoot_rate * 100).toFixed(1)),
    speed: Math.round(p.metrics.avg_speed),
    path_eff: parseFloat((p.metrics.path_efficiency * 100).toFixed(1)),
  }));

  // Jitter histogram buckets
  const jitterBuckets: Record<string, number> = {};
  for (let i = 0; i <= 10; i++) {
    jitterBuckets[`${i * 10}`] = 0;
  }
  points.forEach((p) => {
    const bucket = Math.min(Math.floor(p.metrics.jitter * 100), 100);
    const key = `${Math.floor(bucket / 10) * 10}`;
    jitterBuckets[key] = (jitterBuckets[key] || 0) + 1;
  });
  const histogramData = Object.entries(jitterBuckets).map(([label, count]) => ({
    label: `${label}`,
    count,
  }));

  return (
    <div
      className="p-6 min-h-screen"
      style={{ background: C.bg, color: C.text, fontFamily: "'JetBrains Mono', monospace" }}
    >
      <h1
        className="text-xl font-bold mb-6"
        style={{ color: C.accent, letterSpacing: "0.1em" }}
      >
        SMOOTHNESS REPORT
      </h1>

      {loading ? (
        <div style={{ color: C.textFaint }}>Loading session data…</div>
      ) : points.length === 0 ? (
        <div style={{ color: C.textFaint, display: "flex", alignItems: "center", gap: 12 }}>
          No session data yet. Play a scenario first.
          <button
            onClick={() => { setLoading(true); fetchSessionData(); }}
            className="am-btn"
            style={{
              background: C.accentDim,
              border: `1px solid ${C.accentBorder}`,
              color: C.accent,
              borderRadius: 6,
              padding: "3px 12px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            ↺ Refresh
          </button>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-4 gap-3 mb-8">
            {[
              {
                label: "Avg Smoothness",
                value: `${Math.round(points.reduce((a, p) => a + p.metrics.smoothness, 0) / points.length)}/100`,
                color: "#00f5a0",
              },
              {
                label: "Avg Jitter",
                value: (
                  points.reduce((a, p) => a + p.metrics.jitter, 0) / points.length
                ).toFixed(3),
                color: "#ffd700",
              },
              {
                label: "Overshoot Rate",
                value: `${Math.round((points.reduce((a, p) => a + p.metrics.overshoot_rate, 0) / points.length) * 100)}%`,
                color: "#ff6b6b",
              },
              {
                label: "Avg Path Eff.",
                value: `${Math.round((points.reduce((a, p) => a + p.metrics.path_efficiency, 0) / points.length) * 100)}%`,
                color: "#a78bfa",
              },
              {
                label: "Samples",
                value: points.length.toString(),
                color: "rgba(255,255,255,0.5)",
              },
            ].map(({ label, value, color }) => (
              <div
                key={label}
                className="rounded-xl p-4"
                style={{
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                }}
              >
                <div
                  className="text-xs uppercase tracking-wider mb-1"
                  style={{ color: C.textFaint }}
                >
                  {label}
                </div>
                <div
                  className="text-2xl font-bold tabular-nums"
                  style={{ color }}
                >
                  {value}
                </div>
              </div>
            ))}
          </div>

          {/* Mouse path viewer */}
          <MousePathViewer rawPositions={rawPositions} metricPoints={points} screenFrames={screenFrames} />

          {/* Smoothness over time */}
          <ChartSection title="Smoothness Score (per second)">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="t"
                  tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10 }}
                  tickFormatter={(v) => `${v}s`}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10 }}
                />
                <Tooltip
                  contentStyle={{
                    background: C.glassDark,
                    border: `1px solid ${C.border}`,
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <ReferenceLine y={60} stroke="rgba(0,245,160,0.3)" strokeDasharray="4 4" />
                <Line
                  type="monotone"
                  dataKey="smoothness"
                  stroke="#00f5a0"
                  strokeWidth={2}
                  dot={false}
                  name="Smoothness"
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartSection>

          {/* Velocity curve */}
          <ChartSection title="Velocity (px/s)">
            <ResponsiveContainer width="100%" height={140}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="t"
                  tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10 }}
                  tickFormatter={(v) => `${v}s`}
                />
                <YAxis tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10 }} />
                <Tooltip
                  contentStyle={{
                    background: C.glassDark,
                    border: `1px solid ${C.border}`,
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="speed"
                  stroke="#00b4ff"
                  strokeWidth={1.5}
                  dot={false}
                  name="Speed"
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartSection>

          {/* Jitter histogram */}
          <ChartSection title="Jitter Distribution">
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={histogramData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10 }}
                />
                <YAxis tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10 }} />
                <Tooltip
                  contentStyle={{
                    background: C.glassDark,
                    border: `1px solid ${C.border}`,
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="count" fill="#ffd700" radius={[3, 3, 0, 0]} name="Count" />
              </BarChart>
            </ResponsiveContainer>
          </ChartSection>

          {/* Path efficiency */}
          <ChartSection title="Path Efficiency (%) — 100% = straight line to target">
            <ResponsiveContainer width="100%" height={130}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="t"
                  tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10 }}
                  tickFormatter={(v) => `${v}s`}
                />
                <YAxis
                  domain={[50, 100]}
                  tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10 }}
                />
                <Tooltip
                  contentStyle={{
                    background: C.glassDark,
                    border: `1px solid ${C.border}`,
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <ReferenceLine y={82} stroke="rgba(167,139,250,0.3)" strokeDasharray="4 4" />
                <Line
                  type="monotone"
                  dataKey="path_eff"
                  stroke="#a78bfa"
                  strokeWidth={1.5}
                  dot={false}
                  name="Path Eff %"
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartSection>

          {/* Overshoot rate */}
          <ChartSection title="Overshoot Rate (%)">
            <ResponsiveContainer width="100%" height={130}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="t"
                  tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10 }}
                  tickFormatter={(v) => `${v}s`}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10 }}
                />
                <Tooltip
                  contentStyle={{
                    background: C.glassDark,
                    border: `1px solid ${C.border}`,
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <ReferenceLine y={30} stroke="rgba(255,77,77,0.3)" strokeDasharray="4 4" />
                <Line
                  type="monotone"
                  dataKey="overshoot"
                  stroke="#ff6b6b"
                  strokeWidth={1.5}
                  dot={false}
                  name="Overshoot %"
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartSection>

          {/* Issues detected */}
          {issues.length > 0 && (
            <div className="mt-8">
              <h2
                className="text-sm font-semibold uppercase tracking-widest mb-4"
                style={{ color: C.textMuted }}
              >
                Issues Detected
              </h2>
              <div className="flex flex-col gap-3">
                {issues.map((issue, i) => (
                  <div
                    key={i}
                    className="rounded-xl p-4"
                    style={{
                      background: C.surface,
                      border: `1px solid ${C.border}`,
                      borderLeft: `3px solid ${SEVERITY_COLOR[issue.severity]}`,
                    }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Dot color={SEVERITY_COLOR[issue.severity]} />
                      <span
                        className="text-sm font-semibold"
                        style={{ color: SEVERITY_COLOR[issue.severity] }}
                      >
                        {issue.title}
                      </span>
                      <Badge color={SEVERITY_COLOR[issue.severity]}>{issue.severity}</Badge>
                    </div>
                    <p
                      className="text-xs leading-relaxed"
                      style={{ color: C.textSub }}
                    >
                      {issue.description}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ChartSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-xl p-4 mb-4"
      style={{
        background: C.glass,
        border: `1px solid ${C.border}`,
        backdropFilter: "blur(16px) saturate(180%)",
      }}
    >
      <h3
        className="text-xs uppercase tracking-widest mb-3"
        style={{ color: C.textFaint }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}
