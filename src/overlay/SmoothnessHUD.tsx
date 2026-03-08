import { motion, AnimatePresence } from "framer-motion";
import { useMouseMetrics } from "../hooks/useMouseMetrics";
import { GlassCard, Dot, MiniBar } from "../design/ui";
import { C } from "../design/tokens";

function getColor(score: number): string {
  if (score >= 75) return "#00f5a0";
  if (score >= 50) return "#ffd700";
  if (score >= 25) return "#fb923c";
  return "#ff4d4d";
}

function getLabel(score: number): string {
  if (score >= 80) return "SMOOTH";
  if (score >= 60) return "GOOD";
  if (score >= 40) return "ROUGH";
  return "CHOPPY";
}

interface SmoothnessHUDProps {
  preview?: boolean;
}

export function SmoothnessHUD({ preview = false }: SmoothnessHUDProps) {
  const metrics = useMouseMetrics();

  if (!metrics && !preview) return null;

  const score = metrics ? Math.round(metrics.smoothness) : 0;
  const color = metrics ? getColor(score) : C.textDisabled;
  const label = metrics ? getLabel(score) : "IDLE";

  const jitter       = metrics?.jitter ?? 0;
  const pathEff      = metrics?.path_efficiency ?? 0;
  const overshoot    = metrics?.overshoot_rate ?? 0;
  const velocityCv   = metrics?.velocity_std ?? 0;

  const subMetrics = [
    { label: "WOBBLE", value: jitter.toFixed(2),                  bad: jitter > 0.3,     tooltip: "Lateral jitter — lower is better" },
    { label: "PATH",   value: `${Math.round(pathEff * 100)}%`,    bad: pathEff < 0.82,   tooltip: "Path straightness — higher is better" },
    { label: "OVER",   value: `${(overshoot * 100).toFixed(0)}%`, bad: overshoot > 0.25, tooltip: "Overshoot rate — lower is better" },
    { label: "CV",     value: velocityCv.toFixed(2),              bad: velocityCv > 0.5, tooltip: "Speed consistency — lower is better" },
  ];

  return (
    <AnimatePresence>
      <motion.div
        key="smoothness-hud"
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.92 }}
        transition={{ duration: 0.22 }}
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        <GlassCard accent={color} style={{ padding: "10px 13px", minWidth: 130 }}>
          {/* Header row */}
          <div className="flex items-center gap-1.5 mb-2.5">
            <Dot color={color} pulse={!!metrics} size={6} />
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: C.textMuted }}>
              SMOOTHNESS
            </span>
          </div>

          {/* Score */}
          <div className="flex items-baseline gap-1 mb-0.5">
            <motion.span
              key={score}
              initial={{ opacity: 0.5, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.2 }}
              className="tabular-nums"
              style={{ fontSize: 30, fontWeight: 800, color, lineHeight: 1, letterSpacing: "-0.02em" }}
            >
              {score}
            </motion.span>
            <span style={{ fontSize: 10, color: C.textFaint }}>/100</span>
          </div>

          {/* Label */}
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color, marginBottom: 8 }}>
            {label}
          </div>

          {/* Score bar */}
          <MiniBar pct={score} color={color} height={3} className="mb-2.5" />

          {/* Sub-metric grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 6px" }}>
            {subMetrics.map((m) => (
              <div
                key={m.label}
                title={m.tooltip}
                style={{
                  background:   "rgba(255,255,255,0.04)",
                  border:       `1px solid ${m.bad ? "rgba(255,77,77,0.25)" : "rgba(255,255,255,0.06)"}`,
                  borderRadius: 5,
                  padding:      "3px 6px",
                  cursor:       "help",
                }}
              >
                <div style={{ fontSize: 7.5, letterSpacing: "0.1em", color: C.textFaint, textTransform: "uppercase" }}>
                  {m.label}
                </div>
                <div
                  className="tabular-nums"
                  style={{ fontSize: 10, fontWeight: 600, color: m.bad ? C.danger : C.textSub, marginTop: 1 }}
                >
                  {metrics ? m.value : "—"}
                </div>
              </div>
            ))}
          </div>
        </GlassCard>
      </motion.div>
    </AnimatePresence>
  );
}
