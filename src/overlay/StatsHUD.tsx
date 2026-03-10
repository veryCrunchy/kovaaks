import { motion, AnimatePresence } from "framer-motion";
import { useStatsPanel } from "../hooks/useStatsPanel";
import { GlassCard, Dot, StatRow } from "../design/ui";
import { C, scenarioColor, SCENARIO_LABELS, fmt, fmtAccuracy } from "../design/tokens";

interface StatsHUDProps {
  preview?: boolean;
}

export function StatsHUD({ preview = false }: StatsHUDProps) {
  const reading = useStatsPanel();

  if (!reading && !preview) return null;

  const scenarioType    = reading?.scenario_type ?? "Unknown";
  const scenarioSubtype = reading?.scenario_subtype ?? null;
  const gameState       = (reading?.game_state ?? "menu").toUpperCase();
  const color           = scenarioColor(scenarioType);
  const shortLabel      = SCENARIO_LABELS[scenarioType] ?? scenarioType;
  const isActive        = gameState === "IN-GAME" || gameState === "PLAYING";

  const showTTK    = scenarioType !== "Tracking" && scenarioType !== "AccuracyDrill" && scenarioType !== "Unknown";
  const showDamage = scenarioType === "TargetSwitching" || scenarioType === "MultiHitClicking";
  const showKills  = scenarioType !== "Tracking" && scenarioType !== "AccuracyDrill";

  const hasPositive    = (v: number | null | undefined) => v != null && isFinite(v) && v > 0.0001;
  const hasPositiveInt = (v: number | null | undefined) => v != null && isFinite(v) && v > 0;

  const showChallenge =
    (reading?.is_in_challenge ?? false) ||
    (reading?.is_in_scenario ?? false) ||
    hasPositive(reading?.time_remaining) ||
    hasPositive(reading?.challenge_seconds_total);

  return (
    <AnimatePresence>
      <motion.div
        key="stats-hud"
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.92 }}
        transition={{ duration: 0.22 }}
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        {/* Coloured left-border accent strip */}
        <div style={{ display: "flex", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ width: 3, background: color, flexShrink: 0, opacity: 0.8 }} />
          <GlassCard
            accent={color}
            style={{
              padding:      "9px 11px",
              minWidth:     130,
              borderLeft:   "none",
              borderTopLeftRadius:    0,
              borderBottomLeftRadius: 0,
            }}
          >
            {/* Scenario badge + state */}
            <div className="flex items-center gap-1.5 mb-2">
              <Dot color={color} pulse={isActive} size={6} />
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color, textTransform: "uppercase" }}>
                {shortLabel}
              </span>
              <span style={{ fontSize: 8, color: C.textFaint, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                · {gameState === "MENU" ? "IDLE" : gameState}
              </span>
            </div>

            {scenarioSubtype && (
              <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 6, marginTop: -4 }}>
                {scenarioSubtype}
              </div>
            )}

            {/* Stats */}
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <StatRow
                label="ACC"
                value={fmtAccuracy(reading?.accuracy_hits, reading?.accuracy_shots, reading?.accuracy_pct)}
              />
              <StatRow label="SPM" value={fmt(reading?.spm, 0)} />
              {showTTK && (
                <StatRow
                  label="TTK"
                  value={reading?.ttk_secs != null ? `${(reading.ttk_secs * 1000).toFixed(0)}ms` : "--"}
                />
              )}
              {showKills && <StatRow label="KPS" value={fmt(reading?.kps, 1)} />}
              {showDamage && <StatRow label="DMG" value={fmt(reading?.damage_dealt, 0)} />}

              {showChallenge && (
                <>
                  {hasPositive(reading?.time_remaining) && (
                    <StatRow label="REM" value={fmt(reading?.time_remaining, 1)} />
                  )}
                  {hasPositive(reading?.queue_time_remaining) && (
                    <StatRow label="Q·REM" value={fmt(reading?.queue_time_remaining, 1)} />
                  )}
                  {hasPositive(reading?.challenge_seconds_total) && (
                    <StatRow label="CH·SEC" value={fmt(reading?.challenge_seconds_total, 1)} />
                  )}
                  {hasPositive(reading?.challenge_average_fps) && (
                    <StatRow label="CH·FPS" value={fmt(reading?.challenge_average_fps, 2)} />
                  )}
                  {hasPositiveInt(reading?.challenge_tick_count_total) && (
                    <StatRow label="TICKS" value={fmt(reading?.challenge_tick_count_total, 0)} />
                  )}
                </>
              )}
            </div>
          </GlassCard>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
