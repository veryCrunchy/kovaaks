import { motion, AnimatePresence } from "framer-motion";
import { useSessionSummary } from "../hooks/useSessionSummary";

// ── Colour palette (shared with StatsHUD) ─────────────────────────────────────
const SCENARIO_COLOR: Record<string, string> = {
  Tracking: "#60a5fa",
  OneShotClicking: "#a78bfa",
  MultiHitClicking: "#f472b6",
  ReactiveClicking: "#fb923c",
  AccuracyDrill: "#34d399",
  Unknown: "rgba(255,255,255,0.35)",
};

// ── Small formatting helpers ───────────────────────────────────────────────────
function fmtNum(v: number | null | undefined, dec = 0): string {
  if (v == null) return "--";
  return v.toFixed(dec);
}

function fmtScore(n: number): string {
  return n.toLocaleString();
}

function fmtDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtRunWindow(startSec?: number | null, endSec?: number | null): string | null {
  if (startSec == null || endSec == null) return null;
  const start = Math.max(0, Math.round(startSec));
  const end = Math.max(start, Math.round(endSec));
  return `${start}s–${end}s`;
}

function smoothLabel(score: number): { text: string; color: string } {
  if (score >= 80) return { text: "SMOOTH", color: "#00f5a0" };
  if (score >= 60) return { text: "GOOD", color: "#ffd700" };
  if (score >= 40) return { text: "ROUGH", color: "#fb923c" };
  return { text: "CHOPPY", color: "#ff4d4d" };
}

function tipColor(level: "good" | "tip" | "warning"): string {
  if (level === "good") return "#00f5a0";
  if (level === "warning") return "#ff6b6b";
  return "#ffd166";
}

// ── Sub-components ─────────────────────────────────────────────────────────────

interface StatRowProps {
  label: string;
  value: string;
  accent: string;
  highlight?: boolean;
}

function StatRow({ label, value, accent, highlight = false }: StatRowProps) {
  return (
    <div className="flex items-center justify-between" style={{ gap: 12 }}>
      <span style={{ fontSize: 9, color: "rgba(255,255,255,0.38)", letterSpacing: "0.1em", fontWeight: 600 }}>
        {label}
      </span>
      <span
        style={{
          fontSize: highlight ? 13 : 11,
          fontWeight: highlight ? 700 : 500,
          color: highlight ? accent : "rgba(255,255,255,0.82)",
          tabularNums: "tabular-nums",
        } as React.CSSProperties}
        className="tabular-nums"
      >
        {value}
      </span>
    </div>
  );
}

interface SmoothnessBarProps {
  label: string;
  value: number;
  /** True = lower is better */
  lowerBetter?: boolean;
  accent: string;
}

function SmoothnessBar({ label, value, lowerBetter = false, accent }: SmoothnessBarProps) {
  // Clamp to 0-1 range for the bar width
  const pct = Math.min(Math.max(lowerBetter ? 1 - value : value, 0), 1) * 100;
  const displayVal = (value * 100).toFixed(1);
  return (
    <div style={{ marginBottom: 4 }}>
      <div className="flex items-center justify-between mb-0.5">
        <span style={{ fontSize: 8, color: "rgba(255,255,255,0.35)", letterSpacing: "0.08em" }}>{label}</span>
        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.55)", fontWeight: 600 }}>
          {displayVal}%
        </span>
      </div>
      <div
        style={{
          height: 3,
          borderRadius: 2,
          background: "rgba(255,255,255,0.07)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: accent,
            borderRadius: 2,
            opacity: 0.75,
            transition: "width 0.6s ease",
          }}
        />
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
interface PostSessionOverviewProps {
  /** Always render an empty state so the HUD can be repositioned. */
  preview?: boolean;
}

export function PostSessionOverview({ preview = false }: PostSessionOverviewProps) {
  const { summary, dismiss, dismissProgress } = useSessionSummary();

  if (!summary && !preview) return null;

  const { session, metrics, statsPanel, runSnapshot } = summary ?? {
    session: {
      scenario: "Scenario Name",
      score: 0,
      accuracy: 0,
      kills: 0,
      deaths: 0,
      duration_secs: 60,
      timestamp: "",
      csv_path: "",
    },
    metrics: null,
    statsPanel: null,
    runSnapshot: null,
  };

  const scenarioType = statsPanel?.scenario_type ?? "Unknown";
  const accent = SCENARIO_COLOR[scenarioType] ?? "#ffffff";

  const showKills = scenarioType !== "Tracking" && scenarioType !== "AccuracyDrill" && scenarioType !== "Unknown";
  const showTTK = scenarioType === "OneShotClicking" || scenarioType === "ReactiveClicking";
  const showDamage = scenarioType === "MultiHitClicking";

  const accuracyStr =
    statsPanel?.accuracy_pct != null
      ? `${statsPanel.accuracy_pct.toFixed(1)}%`
      : session.accuracy > 0
      ? `${(session.accuracy * 100).toFixed(1)}%`
      : "--";

  const spmStr = statsPanel?.spm != null ? fmtNum(statsPanel.spm, 0) : "--";
  const ttkStr =
    statsPanel?.ttk_secs != null
      ? `${(statsPanel.ttk_secs * 1000).toFixed(0)}ms`
      : (session.avg_ttk ?? 0) > 0
      ? `${((session.avg_ttk ?? 0) * 1000).toFixed(0)}ms`
      : "--";

  const smoothScore = metrics ? Math.round(metrics.smoothness) : null;
  const smoothInfo = smoothScore != null ? smoothLabel(smoothScore) : null;

  // Progress bar counts up from 0 → 1 then dismisses (reversed so it depletes)
  const barPct = (1 - dismissProgress) * 100;

  return (
    <AnimatePresence>
      {(summary || preview) && (
        <motion.div
          key="post-session-overview"
          initial={{ opacity: 0, scale: 0.92, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, y: 8 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          style={{ fontFamily: "'JetBrains Mono', monospace", width: 300 }}
        >
          <div
            className="rounded-xl overflow-hidden"
            style={{
              background: "rgba(8, 8, 14, 0.92)",
              border: `1px solid ${accent}30`,
              backdropFilter: "blur(14px)",
              boxShadow: `0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px ${accent}10`,
            }}
          >
            {/* ── Header ─────────────────────────────────────────────────────── */}
            <div
              className="flex items-center justify-between px-4 py-2.5"
              style={{ borderBottom: `1px solid ${accent}18`, background: `${accent}08` }}
            >
              <div className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: accent, boxShadow: `0 0 6px ${accent}` }}
                />
                <span style={{ fontSize: 9, color: accent, fontWeight: 700, letterSpacing: "0.14em" }}>
                  SESSION COMPLETE
                </span>
              </div>
              {summary && (
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    dismiss();
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    color: "rgba(255,255,255,0.3)",
                    fontSize: 13,
                    lineHeight: 1,
                    padding: "0 2px",
                    fontFamily: "inherit",
                    pointerEvents: "auto",
                  }}
                  title="Dismiss"
                >
                  ×
                </button>
              )}
            </div>

            <div className="px-4 pt-3 pb-4">
              {/* ── Scenario name ──────────────────────────────────────────────── */}
              <div
                className="mb-3 truncate"
                style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", fontWeight: 500 }}
                title={session.scenario}
              >
                {session.scenario}
              </div>

              {/* ── Score ─────────────────────────────────────────────────────── */}
              <div className="flex items-baseline gap-2 mb-4">
                <motion.span
                  key={session.score}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: 0.1 }}
                  style={{
                    fontSize: 36,
                    fontWeight: 800,
                    color: "#ffffff",
                    letterSpacing: "-0.02em",
                    lineHeight: 1,
                  }}
                  className="tabular-nums"
                >
                  {fmtScore(Math.round(session.score))}
                </motion.span>
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", fontWeight: 500 }}>pts</span>
              </div>

              {/* ── Stats grid ────────────────────────────────────────────────── */}
              <div
                style={{
                  background: "rgba(255,255,255,0.03)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  marginBottom: 10,
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                }}
              >
                <StatRow label="ACCURACY" value={accuracyStr} accent={accent} highlight />
                {showKills && (
                  <StatRow
                    label="KILLS"
                    value={session.kills > 0 ? String(session.kills) : (statsPanel?.kills != null ? String(statsPanel.kills) : "--")}
                    accent={accent}
                  />
                )}
                {showDamage && (statsPanel?.damage_dealt != null || (session.damage_done ?? 0) > 0) && (
                  <StatRow
                    label="DAMAGE"
                    value={fmtNum(statsPanel?.damage_dealt ?? session.damage_done ?? 0, 0)}
                    accent={accent}
                  />
                )}
                {spmStr !== "--" && (
                  <StatRow label="AVG SPM" value={spmStr} accent={accent} />
                )}
                {showTTK && ttkStr !== "--" && (
                  <StatRow label="AVG TTK" value={ttkStr} accent={accent} />
                )}
                <StatRow
                  label="DURATION"
                  value={fmtDuration(session.duration_secs)}
                  accent={accent}
                />
              </div>

              {/* ── Scenario snapshot (bridge-driven) ──────────────────────── */}
              {runSnapshot && (
                <div
                  style={{
                    background: "rgba(255,255,255,0.03)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    marginBottom: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 5,
                  }}
                >
                  <StatRow
                    label="RUN SCORE (DERIVED)"
                    value={runSnapshot.scoreTotalDerived != null ? fmtNum(runSnapshot.scoreTotalDerived, 0) : "--"}
                    accent={accent}
                  />
                  <StatRow
                    label="RUN SPM / PEAK"
                    value={
                      `${runSnapshot.scorePerMinute != null ? fmtNum(runSnapshot.scorePerMinute, 0) : "--"} / ${
                        runSnapshot.peakScorePerMinute != null ? fmtNum(runSnapshot.peakScorePerMinute, 0) : "--"
                      }`
                    }
                    accent={accent}
                  />
                  <StatRow
                    label="SHOTS / HITS"
                    value={`${runSnapshot.shotsFired ?? "--"} / ${runSnapshot.shotsHit ?? "--"}`}
                    accent={accent}
                  />
                  <StatRow
                    label="KPS / PEAK"
                    value={
                      `${runSnapshot.killsPerSecond != null ? fmtNum(runSnapshot.killsPerSecond, 2) : "--"} / ${
                        runSnapshot.peakKillsPerSecond != null ? fmtNum(runSnapshot.peakKillsPerSecond, 2) : "--"
                      }`
                    }
                    accent={accent}
                  />
                  <StatRow
                    label="DMG EFF"
                    value={runSnapshot.damageEfficiency != null ? `${fmtNum(runSnapshot.damageEfficiency, 1)}%` : "--"}
                    accent={accent}
                  />
                </div>
              )}

              {/* ── Smoothness section ────────────────────────────────────────── */}
              {metrics && (
                <div
                  style={{
                    background: "rgba(255,255,255,0.03)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    marginBottom: 10,
                  }}
                >
                  {/* Composite score row */}
                  <div className="flex items-center justify-between mb-2">
                    <span style={{ fontSize: 9, color: "rgba(255,255,255,0.38)", letterSpacing: "0.1em", fontWeight: 600 }}>
                      MOUSE SMOOTHNESS
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 800,
                          color: smoothInfo?.color ?? "#fff",
                          lineHeight: 1,
                        }}
                        className="tabular-nums"
                      >
                        {smoothScore ?? "--"}
                      </span>
                      <span style={{ fontSize: 8, color: smoothInfo?.color ?? "#fff", fontWeight: 700, opacity: 0.8 }}>
                        {smoothInfo?.text}
                      </span>
                    </div>
                  </div>

                  {/* Sub-metric bars */}
                  <SmoothnessBar
                    label="PATH EFFICIENCY"
                    value={metrics.path_efficiency}
                    accent={smoothInfo?.color ?? accent}
                  />
                  <SmoothnessBar
                    label="JITTER"
                    value={Math.min(metrics.jitter, 1)}
                    lowerBetter
                    accent={smoothInfo?.color ?? accent}
                  />
                  <SmoothnessBar
                    label="OVERSHOOT RATE"
                    value={metrics.overshoot_rate}
                    lowerBetter
                    accent={smoothInfo?.color ?? accent}
                  />
                  {metrics.avg_hold_ms < 80 && metrics.click_timing_cv > 0 && (
                    <SmoothnessBar
                      label="CLICK CONSISTENCY"
                      value={Math.min(metrics.click_timing_cv, 1)}
                      lowerBetter
                      accent={smoothInfo?.color ?? accent}
                    />
                  )}
                </div>
              )}

              {/* ── Run coaching tips ───────────────────────────────────────── */}
              {runSnapshot && runSnapshot.tips.length > 0 && (
                <div
                  style={{
                    background: "rgba(255,255,255,0.03)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.42)", letterSpacing: "0.1em", fontWeight: 700 }}>
                    RUN COACHING
                  </div>
                  {runSnapshot.tips.map((tip) => (
                    <div key={tip.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <div className="flex items-center justify-between" style={{ gap: 8 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: tipColor(tip.level) }}>
                          {tip.title}
                        </div>
                        {fmtRunWindow(tip.windowStartSec, tip.windowEndSec) && (
                          <div style={{ fontSize: 8, fontWeight: 700, color: "rgba(255,255,255,0.42)", letterSpacing: "0.08em" }}>
                            {fmtRunWindow(tip.windowStartSec, tip.windowEndSec)}
                          </div>
                        )}
                      </div>
                      <div style={{ fontSize: 9, lineHeight: 1.35, color: "rgba(255,255,255,0.7)" }}>
                        {tip.detail}
                      </div>
                    </div>
                  ))}
                </div>
              )}

            </div>

            {/* ── Auto-dismiss progress bar ──────────────────────────────────── */}
            {summary && (
              <div style={{ height: 2, background: "rgba(255,255,255,0.06)" }}>
                <motion.div
                  style={{
                    height: "100%",
                    width: `${barPct}%`,
                    background: `linear-gradient(90deg, ${accent}60, ${accent})`,
                    transition: "width 0.2s linear",
                  }}
                />
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
