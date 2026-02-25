import { motion, AnimatePresence } from "framer-motion";
import { useMouseMetrics } from "../hooks/useMouseMetrics";

function getColor(score: number): string {
  if (score >= 75) return "#00f5a0";
  if (score >= 50) return "#ffd700";
  return "#ff4d4d";
}

function getLabel(score: number): string {
  if (score >= 80) return "SMOOTH";
  if (score >= 60) return "OK";
  if (score >= 40) return "ROUGH";
  return "CHOPPY";
}

interface SmoothnessHUDProps {
  /** When true, always render even with no metrics (for repositioning). */
  preview?: boolean;
}

export function SmoothnessHUD({ preview = false }: SmoothnessHUDProps) {
  const metrics = useMouseMetrics();

  if (!metrics && !preview) return null;

  const score = metrics ? Math.round(metrics.smoothness) : 0;
  const color = metrics ? getColor(score) : "rgba(255,255,255,0.3)";
  const label = metrics ? getLabel(score) : "WAITING";

  return (
    <AnimatePresence>
      <motion.div
        key="smoothness-hud"
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
            border: `1px solid ${color}28`,
            backdropFilter: "blur(10px)",
            padding: "8px 12px",
            minWidth: 90,
          }}
        >
          {/* Score arc indicator */}
          <div className="flex items-center gap-2 mb-1">
            <div
              className="w-2 h-2 rounded-full"
              style={{
                background: color,
                boxShadow: `0 0 6px ${color}`,
              }}
            />
            <span
              className="text-xs font-medium tracking-wider"
              style={{ color: "rgba(255,255,255,0.4)" }}
            >
              SMOOTH
            </span>
          </div>

          {/* Big score number */}
          <div className="flex items-baseline gap-1.5">
            <motion.span
              key={score}
              initial={{ opacity: 0.5 }}
              animate={{ opacity: 1 }}
              className="text-xl font-bold tabular-nums"
              style={{ color }}
            >
              {score}
            </motion.span>
            <span className="text-xs" style={{ color: "rgba(255,255,255,0.3)" }}>
              /100
            </span>
          </div>

          {/* Label */}
          <div
            className="text-xs font-semibold tracking-widest mt-0.5"
            style={{ color }}
          >
            {label}
          </div>

          {/* Mini stat pills */}
          <div className="flex gap-1.5 mt-2">
            <StatPill
              label="WOBBLE"
              value={metrics ? metrics.jitter.toFixed(2) : "—"}
              tooltip="Lateral jitter (perpendicular to motion axis). 0 = on-axis clean."
              bad={!!metrics && metrics.jitter > 0.3}
            />
            <StatPill
              label="PATH"
              value={metrics ? `${Math.round(metrics.path_efficiency * 100)}%` : "—"}
              tooltip="Path straightness: displacement ÷ path length. 100% = laser-straight; low = cursor curved/weaved to target."
              bad={!!metrics && metrics.path_efficiency < 0.82}
            />
            <StatPill
              label="OVER"
              value={metrics ? `${(metrics.overshoot_rate * 100).toFixed(0)}%` : "—"}
              tooltip="Sharp axial reversals. High = aggressive overcorrections."
              bad={!!metrics && metrics.overshoot_rate > 0.25}
            />
            <StatPill
              label="CV"
              value={metrics ? metrics.velocity_std.toFixed(2) : "—"}
              tooltip="Speed consistency (coeff. of variation). Lower = steadier pace."
              bad={!!metrics && metrics.velocity_std > 0.5}
            />
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

interface StatPillProps {
  label: string;
  value: string;
  bad: boolean;
  tooltip?: string;
}

function StatPill({ label, value, bad, tooltip }: StatPillProps) {
  return (
    <div
      className="rounded px-1.5 py-0.5"
      title={tooltip}
      style={{
        background: "rgba(255,255,255,0.05)",
        border: `1px solid ${bad ? "rgba(255,77,77,0.3)" : "rgba(255,255,255,0.06)"}`,
        cursor: tooltip ? "help" : undefined,
      }}
    >
      <div
        className="text-[9px] uppercase tracking-wider"
        style={{ color: "rgba(255,255,255,0.3)" }}
      >
        {label}
      </div>
      <div
        className="text-[10px] font-semibold tabular-nums"
        style={{ color: bad ? "#ff6b6b" : "rgba(255,255,255,0.6)" }}
      >
        {value}
      </div>
    </div>
  );
}
