import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useRef } from "react";
import { useSessionSummary } from "../hooks/useSessionSummary";
import { GlassCard, Badge, StatRow, MiniBar, SectionLabel } from "../design/ui";
import { C, scenarioColor, SCENARIO_LABELS, fmt, fmtScore, fmtDuration } from "../design/tokens";

function smoothLabel(score: number): { text: string; color: string } {
  if (score >= 80) return { text: "SMOOTH", color: "#00f5a0" };
  if (score >= 60) return { text: "GOOD",   color: "#ffd700" };
  if (score >= 40) return { text: "ROUGH",  color: "#fb923c" };
  return                   { text: "CHOPPY", color: "#ff4d4d" };
}

function tipColor(level: "good" | "tip" | "warning"): string {
  if (level === "good")    return "#00f5a0";
  if (level === "warning") return "#ff6b6b";
  return "#ffd166";
}

function fmtRunWindow(startSec?: number | null, endSec?: number | null): string | null {
  if (startSec == null || endSec == null) return null;
  const start = Math.max(0, Math.round(startSec));
  const end   = Math.max(start, Math.round(endSec));
  return `${start}s–${end}s`;
}

// ── Main component ──────────────────────────────────────────────────────────────

interface PostSessionOverviewProps {
  preview?: boolean;
  onDismissButtonRectChange?: (rect: DOMRect | null) => void;
}

export function PostSessionOverview({ preview = false, onDismissButtonRectChange }: PostSessionOverviewProps) {
  const { summary, dismiss, dismissProgress } = useSessionSummary();
  const dismissButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!summary || !onDismissButtonRectChange) {
      onDismissButtonRectChange?.(null);
      return;
    }
    const updateRect = () =>
      onDismissButtonRectChange(dismissButtonRef.current?.getBoundingClientRect() ?? null);
    updateRect();
    const interval = window.setInterval(updateRect, 100);
    window.addEventListener("resize", updateRect);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("resize", updateRect);
      onDismissButtonRectChange(null);
    };
  }, [onDismissButtonRectChange, summary]);

  useEffect(() => {
    if (!summary || preview) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismiss, preview, summary]);

  if (!summary && !preview) return null;

  const { session, metrics, statsPanel, runSnapshot } = summary ?? {
    session:     { scenario: "Scenario Name", score: 0, accuracy: 0, kills: 0, deaths: 0, duration_secs: 60, timestamp: "", csv_path: "" },
    metrics:     null,
    statsPanel:  null,
    runSnapshot: null,
  };

  const scenarioType    = statsPanel?.scenario_type ?? "Unknown";
  const scenarioSubtype = statsPanel?.scenario_subtype ?? null;
  const accent          = scenarioColor(scenarioType);
  const shortLabel      = SCENARIO_LABELS[scenarioType] ?? scenarioType;

  const showKills  = scenarioType !== "Tracking" && scenarioType !== "AccuracyDrill" && scenarioType !== "Unknown";
  const showTTK    = scenarioType !== "Tracking" && scenarioType !== "AccuracyDrill" && scenarioType !== "Unknown";
  const showDamage = scenarioType === "TargetSwitching" || scenarioType === "MultiHitClicking";

  const accuracyStr =
    statsPanel?.accuracy_pct != null
      ? `${statsPanel.accuracy_pct.toFixed(1)}%`
      : session.accuracy > 0
      ? `${session.accuracy.toFixed(1)}%`
      : "--";

  const spmStr = statsPanel?.spm != null ? fmt(statsPanel.spm, 0) : "--";
  const ttkStr =
    statsPanel?.ttk_secs != null
      ? `${(statsPanel.ttk_secs * 1000).toFixed(0)}ms`
      : (session.avg_ttk ?? 0) > 0
      ? `${((session.avg_ttk ?? 0) * 1000).toFixed(0)}ms`
      : "--";

  const smoothScore = metrics ? Math.round(metrics.smoothness) : null;
  const smoothInfo  = smoothScore != null ? smoothLabel(smoothScore) : null;
  const barPct      = (1 - dismissProgress) * 100;

  return (
    <AnimatePresence>
      {(summary || preview) && (
        <motion.div
          key="post-session-overview"
          initial={{ opacity: 0, scale: 0.94, y: 10 }}
          animate={{ opacity: 1, scale: 1,    y: 0 }}
          exit={{    opacity: 0, scale: 0.94, y: 10 }}
          transition={{ duration: 0.28, ease: "easeOut" }}
          style={{ fontFamily: "'JetBrains Mono', monospace", width: 290 }}
        >
          <GlassCard accent={accent} style={{ overflow: "hidden" }}>
            {/* ── Header ────────────────────────────────────────────────────── */}
            <div
              style={{
                display:        "flex",
                alignItems:     "center",
                justifyContent: "space-between",
                padding:        "9px 13px 8px",
                borderBottom:   `1px solid ${accent}18`,
                background:     `${accent}06`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <Badge color={accent} size="xs">{shortLabel}</Badge>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: C.textMuted }}>
                  SESSION COMPLETE
                </span>
              </div>
              {summary && (
                <button
                  ref={dismissButtonRef}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); dismiss(); }}
                  title="Dismiss (Esc)"
                  style={{
                    background:   "rgba(255,255,255,0.06)",
                    border:       "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 5,
                    cursor:       "pointer",
                    color:        C.textMuted,
                    fontSize:     11,
                    width:        20,
                    height:       20,
                    display:      "flex",
                    alignItems:   "center",
                    justifyContent: "center",
                    padding:      0,
                    lineHeight:   1,
                    fontFamily:   "inherit",
                    pointerEvents: "auto",
                    flexShrink:   0,
                  }}
                >
                  ×
                </button>
              )}
            </div>

            <div style={{ padding: "11px 13px 13px" }}>
              {/* Scenario name */}
              <div
                className="truncate"
                title={session.scenario}
                style={{ fontSize: 10, color: C.textMuted, marginBottom: 2 }}
              >
                {session.scenario}
              </div>
              {scenarioSubtype && (
                <div style={{ fontSize: 9, color: accent, fontWeight: 600, letterSpacing: "0.08em", marginBottom: 4 }}>
                  {scenarioSubtype}
                </div>
              )}

              {/* ── Hero score ──────────────────────────────────────────────── */}
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, margin: "6px 0 12px" }}>
                <motion.span
                  key={session.score}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: 0.1 }}
                  className="tabular-nums"
                  style={{ fontSize: 38, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em", lineHeight: 1 }}
                >
                  {fmtScore(session.score)}
                </motion.span>
                <span style={{ fontSize: 10, color: C.textFaint, fontWeight: 500 }}>pts</span>
              </div>

              {/* ── Core stats ──────────────────────────────────────────────── */}
              <SectionLabel className="mb-1.5">Stats</SectionLabel>
              <div
                style={{
                  background:   C.surface,
                  borderRadius: 8,
                  padding:      "7px 9px",
                  marginBottom: 9,
                  display:      "flex",
                  flexDirection: "column",
                  gap:          4,
                }}
              >
                <StatRow label="ACCURACY" value={accuracyStr} accent={accent} highlight />
                {showKills && (
                  <StatRow
                    label="KILLS"
                    value={
                      session.kills > 0
                        ? String(session.kills)
                        : statsPanel?.kills != null
                        ? String(statsPanel.kills)
                        : "--"
                    }
                  />
                )}
                {showDamage && (statsPanel?.damage_dealt != null || (session.damage_done ?? 0) > 0) && (
                  <StatRow
                    label="DAMAGE"
                    value={fmt(statsPanel?.damage_dealt ?? session.damage_done ?? 0, 0)}
                  />
                )}
                {spmStr !== "--" && <StatRow label="AVG SPM" value={spmStr} />}
                {showTTK && ttkStr !== "--" && <StatRow label="AVG TTK" value={ttkStr} />}
                <StatRow label="DURATION" value={fmtDuration(session.duration_secs)} />
              </div>

              {/* ── Bridge run snapshot ─────────────────────────────────────── */}
              {runSnapshot && (
                <>
                  <SectionLabel className="mb-1.5">Run Data</SectionLabel>
                  <div
                    style={{
                      background:   C.surface,
                      borderRadius: 8,
                      padding:      "7px 9px",
                      marginBottom: 9,
                      display:      "flex",
                      flexDirection: "column",
                      gap:          4,
                    }}
                  >
                    <StatRow
                      label="SCORE (DERIVED)"
                      value={runSnapshot.scoreTotalDerived != null ? fmt(runSnapshot.scoreTotalDerived, 0) : "--"}
                    />
                    <StatRow
                      label="SPM / PEAK"
                      value={`${runSnapshot.scorePerMinute != null ? fmt(runSnapshot.scorePerMinute, 0) : "--"} / ${runSnapshot.peakScorePerMinute != null ? fmt(runSnapshot.peakScorePerMinute, 0) : "--"}`}
                    />
                    <StatRow
                      label="SHOTS / HITS"
                      value={`${runSnapshot.shotsFired ?? "--"} / ${runSnapshot.shotsHit ?? "--"}`}
                    />
                    <StatRow
                      label="KPS / PEAK"
                      value={`${runSnapshot.killsPerSecond != null ? fmt(runSnapshot.killsPerSecond, 2) : "--"} / ${runSnapshot.peakKillsPerSecond != null ? fmt(runSnapshot.peakKillsPerSecond, 2) : "--"}`}
                    />
                    <StatRow
                      label="DMG EFF"
                      value={runSnapshot.damageEfficiency != null ? `${fmt(runSnapshot.damageEfficiency, 1)}%` : "--"}
                    />
                  </div>
                </>
              )}

              {/* ── Smoothness ──────────────────────────────────────────────── */}
              {metrics && (
                <>
                  <SectionLabel className="mb-1.5">Mouse</SectionLabel>
                  <div
                    style={{
                      background:   C.surface,
                      borderRadius: 8,
                      padding:      "7px 9px",
                      marginBottom: 9,
                    }}
                  >
                    {/* Composite score */}
                    <div className="flex items-center justify-between mb-2">
                      <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.1em", color: C.textMuted }}>
                        SMOOTHNESS
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span
                          className="tabular-nums"
                          style={{ fontSize: 17, fontWeight: 800, color: smoothInfo?.color ?? "#fff", lineHeight: 1 }}
                        >
                          {smoothScore ?? "--"}
                        </span>
                        <span style={{ fontSize: 8, fontWeight: 700, color: smoothInfo?.color ?? "#fff", opacity: 0.8, letterSpacing: "0.08em" }}>
                          {smoothInfo?.text}
                        </span>
                      </div>
                    </div>

                    <MiniBar
                      label="PATH EFF"
                      value={`${(metrics.path_efficiency * 100).toFixed(1)}%`}
                      pct={metrics.path_efficiency * 100}
                      color={smoothInfo?.color ?? C.accent}
                      height={3}
                      className="mb-1.5"
                    />
                    <MiniBar
                      label="JITTER"
                      value={(Math.min(metrics.jitter, 1) * 100).toFixed(1) + "%"}
                      pct={(1 - Math.min(metrics.jitter, 1)) * 100}
                      color={smoothInfo?.color ?? C.accent}
                      height={3}
                      className="mb-1.5"
                    />
                    <MiniBar
                      label="OVERSHOOT"
                      value={(metrics.overshoot_rate * 100).toFixed(0) + "%"}
                      pct={(1 - Math.min(metrics.overshoot_rate, 1)) * 100}
                      color={smoothInfo?.color ?? C.accent}
                      height={3}
                      {...(metrics.avg_hold_ms < 80 && metrics.click_timing_cv > 0 ? { className: "mb-1.5" } : {})}
                    />
                    {metrics.avg_hold_ms < 80 && metrics.click_timing_cv > 0 && (
                      <MiniBar
                        label="CLICK CONS."
                        value={(Math.min(metrics.click_timing_cv, 1) * 100).toFixed(0) + "%"}
                        pct={(1 - Math.min(metrics.click_timing_cv, 1)) * 100}
                        color={smoothInfo?.color ?? C.accent}
                        height={3}
                      />
                    )}
                  </div>
                </>
              )}

              {/* ── Coaching tips ───────────────────────────────────────────── */}
              {runSnapshot && runSnapshot.tips.length > 0 && (
                <>
                  <SectionLabel className="mb-1.5">Coaching</SectionLabel>
                  <div
                    style={{
                      background:   C.surface,
                      borderRadius: 8,
                      padding:      "7px 9px",
                      display:      "flex",
                      flexDirection: "column",
                      gap:          7,
                    }}
                  >
                    {runSnapshot.tips.map((tip) => (
                      <div key={tip.id}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: tipColor(tip.level) }}>
                            {tip.title}
                          </span>
                          {fmtRunWindow(tip.windowStartSec, tip.windowEndSec) && (
                            <span style={{ fontSize: 8, fontWeight: 600, color: C.textFaint, letterSpacing: "0.08em" }}>
                              {fmtRunWindow(tip.windowStartSec, tip.windowEndSec)}
                            </span>
                          )}
                        </div>
                        <p style={{ fontSize: 9, lineHeight: 1.4, color: C.textSub, margin: 0 }}>
                          {tip.detail}
                        </p>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* ── Auto-dismiss progress bar ────────────────────────────────── */}
            {summary && (
              <div style={{ height: 2, background: "rgba(255,255,255,0.05)" }}>
                <motion.div
                  style={{
                    height:     "100%",
                    width:      `${barPct}%`,
                    background: `linear-gradient(90deg, ${accent}50, ${accent})`,
                    transition: "width 0.25s linear",
                  }}
                />
              </div>
            )}
          </GlassCard>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
