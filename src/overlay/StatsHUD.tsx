import { motion, AnimatePresence } from "framer-motion";
import { useStatsPanel } from "../hooks/useStatsPanel";

const SCENARIO_COLOR: Record<string, string> = {
  Tracking: "#60a5fa",
  OneShotClicking: "#a78bfa",
  MultiHitClicking: "#f472b6",
  ReactiveClicking: "#fb923c",
  AccuracyDrill: "#34d399",
  Unknown: "rgba(255,255,255,0.35)",
};

function fmt(value: number | null | undefined, decimals = 0): string {
  if (value == null) return "--";
  return value.toFixed(decimals);
}

function fmtAccuracy(
  hits: number | null | undefined,
  shots: number | null | undefined,
  pct: number | null | undefined
): string {
  if (pct != null) return `${pct.toFixed(1)}%`;
  if (hits != null && shots != null && shots > 0)
    return `${((hits / shots) * 100).toFixed(1)}%`;
  return "--";
}

interface StatsHUDProps {
  /** Always render (no metrics) so users can drag it into position. */
  preview?: boolean;
}

export function StatsHUD({ preview = false }: StatsHUDProps) {
  const reading = useStatsPanel();

  if (!reading && !preview) return null;

  const scenarioType = reading?.scenario_type ?? "Unknown";
  const accentColor = SCENARIO_COLOR[scenarioType] ?? "#ffffff";
  const showTTK = scenarioType !== "Tracking" && scenarioType !== "Unknown";
  const showDamage = scenarioType === "MultiHitClicking";
  const showKills =
    scenarioType !== "Tracking" && scenarioType !== "AccuracyDrill";

  return (
    <AnimatePresence>
      <motion.div
        key="stats-hud"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.25 }}
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        <div
          className="rounded-lg"
          style={{
            background: "rgba(8, 8, 14, 0.82)",
            border: `1px solid ${accentColor}28`,
            backdropFilter: "blur(10px)",
            padding: "8px 12px",
            minWidth: 130,
          }}
        >
          {/* Header: scenario type badge */}
          <div
            className="flex items-center gap-2 mb-2"
            style={{ borderBottom: `1px solid ${accentColor}20`, paddingBottom: 6 }}
          >
            <div
              className="w-2 h-2 rounded-full"
              style={{ background: accentColor, boxShadow: `0 0 6px ${accentColor}` }}
            />
            <span style={{ fontSize: 9, color: accentColor, fontWeight: 700, letterSpacing: "0.1em" }}>
              {scenarioType === "Unknown" ? "IDLE" : scenarioType.toUpperCase().replace("CLICKING", " CLK")}
            </span>
          </div>

          {/* Stats rows */}
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {/* Accuracy */}
            <StatRow
              label="ACC"
              value={fmtAccuracy(reading?.accuracy_hits, reading?.accuracy_shots, reading?.accuracy_pct)}
              accent={accentColor}
            />

            {/* SPM */}
            <StatRow label="SPM" value={fmt(reading?.spm, 0)} accent={accentColor} />

            {/* TTK */}
            {showTTK && (
              <StatRow
                label="TTK"
                value={reading?.ttk_secs != null ? `${(reading.ttk_secs * 1000).toFixed(0)}ms` : "--"}
                accent={accentColor}
              />
            )}

            {/* KPS */}
            {showKills && (
              <StatRow label="KPS" value={fmt(reading?.kps, 1)} accent={accentColor} />
            )}

            {/* Damage */}
            {showDamage && (
              <StatRow label="DMG" value={fmt(reading?.damage_dealt, 0)} accent={accentColor} />
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

interface StatRowProps {
  label: string;
  value: string;
  accent: string;
}

function StatRow({ label, value }: StatRowProps) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
      <span style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.08em" }}>
        {label}
      </span>
      <span style={{ fontSize: 13, color: "rgba(255,255,255,0.9)", fontWeight: 600 }}>
        {value}
      </span>
    </div>
  );
}
