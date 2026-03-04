import { motion, AnimatePresence } from "framer-motion";
import { useLiveMemStats } from "../hooks/useLiveMemStats";

interface Props { preview?: boolean; }

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11 }}>
      <span style={{ color: "rgba(255,255,255,0.35)", fontFamily: "monospace" }}>{label}</span>
      <span style={{
        color: highlight ? "#00f5a0" : "rgba(255,255,255,0.75)",
        fontFamily: "monospace",
        fontVariantNumeric: "tabular-nums",
      }}>{value}</span>
    </div>
  );
}

export function LiveMemStatsHUD({ preview = false }: Props) {
  const s = useLiveMemStats();

  if (!s?.connected && !preview) return null;

  const c = s?.connected ?? false;
  const fmt = (v: number, d = 0) => c ? v.toFixed(d) : "—";
  const fmtI = (v: number) => c ? String(v) : "—";

  return (
    <AnimatePresence>
      <motion.div
        key="live-mem-hud"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.2 }}
      >
        <div style={{
          background: "rgba(8,8,14,0.88)",
          border: `1px solid ${c ? "rgba(0,245,160,0.2)" : "rgba(255,255,255,0.08)"}`,
          backdropFilter: "blur(10px)",
          borderRadius: 8,
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          minWidth: 170,
        }}>
          {/* Status */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <div style={{
              width: 6, height: 6, borderRadius: "50%",
              background: c ? "#00f5a0" : "rgba(255,255,255,0.2)",
              boxShadow: c ? "0 0 6px #00f5a0" : "none",
            }} />
            <span style={{ fontSize: 9, letterSpacing: 1, color: "rgba(255,255,255,0.3)", textTransform: "uppercase" }}>
              LIVE MEM
            </span>
          </div>
          {c && s?.scenario_name && (
            <div style={{
              fontSize: 9, fontFamily: "monospace",
              color: "rgba(255,255,255,0.5)",
              marginBottom: 2,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              maxWidth: 200,
            }}>
              {s.scenario_name}
            </div>
          )}

          {/* p2 fields */}
          <Row label="kills (9C8)"    value={fmtI(s?.kills ?? 0)}           highlight={(s?.kills ?? 0) > 0} />
          <Row label="tgt?  (9D8)"    value={fmtI(s?.tgt ?? 0)} />
          <Row label="sess  (0xA74)"  value={fmt(s?.session_time ?? 0, 1)} />

          {/* divider */}
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", margin: "2px 0" }} />

          {/* stats chain */}
          <Row label="shots (290/10)" value={fmtI(s?.shots_fired ?? 0)} />
          <Row label="dmg   (288)"    value={fmtI(s?.body_damage ?? 0)} />
          <Row label="pot   (2AC)"    value={fmt(s?.potential_damage ?? 0, 0)} />
          <Row label="fov   (384)"    value={fmt(s?.fov ?? 0, 1)} />
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
