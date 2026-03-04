import { useLiveMemStats } from "../hooks/useLiveMemStats";

function StatRow({ label, value, addr, dim }: { label: string; value: string; addr: string; dim?: boolean }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "baseline",
      gap: 10,
      padding: "7px 0",
      borderBottom: "1px solid rgba(255,255,255,0.05)",
    }}>
      <span style={{
        fontFamily: "monospace",
        fontSize: 11,
        color: "rgba(255,255,255,0.25)",
        minWidth: 130,
        flexShrink: 0,
      }}>
        {addr}
      </span>
      <span style={{
        fontSize: 12,
        color: "rgba(255,255,255,0.4)",
        minWidth: 120,
        flexShrink: 0,
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: "monospace",
        fontSize: 14,
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        color: dim ? "rgba(255,255,255,0.2)" : "#fff",
        marginLeft: "auto",
      }}>
        {value}
      </span>
    </div>
  );
}

export function LiveTab() {
  const s = useLiveMemStats();

  const c = s?.connected ?? false;
  const fmt  = (v: number, d = 2) => c ? v.toFixed(d) : "—";
  const fmtI = (v: number)        => c ? String(v) : "—";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Connection banner */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 14px",
        background: c ? "rgba(0,245,160,0.06)" : "rgba(255,255,255,0.02)",
        border: `1px solid ${c ? "rgba(0,245,160,0.2)" : "rgba(255,255,255,0.07)"}`,
        borderRadius: 10,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
          background: c ? "#00f5a0" : "rgba(255,255,255,0.15)",
          boxShadow: c ? "0 0 8px #00f5a0" : "none",
        }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ fontSize: 12, color: c ? "#00f5a0" : "rgba(255,255,255,0.3)", fontWeight: 600 }}>
            {c
              ? (s?.kills ?? 0) > 0
                ? "KovaaK's — scenario active"
                : "KovaaK's — connected (in menu / between scenarios)"
              : "KovaaK's not detected"}
          </span>
          {c && s?.scenario_name && (
            <span style={{ fontSize: 11, fontFamily: "monospace", color: "rgba(255,255,255,0.55)" }}>
              {s.scenario_name}
            </span>
          )}
        </div>
      </div>

      {/* Section: Scenario name */}
      <div>
        <div style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase",
          color: "rgba(255,255,255,0.2)", marginBottom: 4,
        }}>
          Scenario name (7-hop chain from base+0x537EC68)
        </div>
        <div style={{
          background: "rgba(0,0,0,0.25)",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 8, padding: "2px 14px",
        }}>
          <StatRow
            addr="base+537EC68→50→98→718→D20→48→8→DC"
            label="scenario_name"
            value={c ? (s?.scenario_name || "(empty — chain fail or menu)") : "—"}
            dim={!c || !s?.scenario_name}
          />
        </div>
      </div>

      {/* Section: PlayerController (p2) */}
      <div>
        <div style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase",
          color: "rgba(255,255,255,0.2)", marginBottom: 4,
        }}>
          PlayerController (p2)
        </div>
        <div style={{
          background: "rgba(0,0,0,0.25)",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 8, padding: "2px 14px",
        }}>
          <StatRow addr="p2 + 0x9C8  i32" label="kills"           value={fmtI(s?.kills ?? 0)}          dim={!c} />
          <StatRow addr="p2 + 0x9D8  i32" label="tgt? (unknown)"  value={fmtI(s?.tgt ?? 0)}            dim={!c} />
          <StatRow addr="p2 + 0xA74  f32" label="session_time (total, freezes btw shots)" value={fmt(s?.session_time ?? 0, 2)} dim={!c} />
        </div>
      </div>

      {/* Section: stats object */}
      <div>
        <div style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase",
          color: "rgba(255,200,80,0.5)", marginBottom: 4,
        }}>
          Stats object (p2→+0x118→+0x120→+0x28) — OFFSETS UNVERIFIED, may be stale
        </div>
        <div style={{
          background: "rgba(0,0,0,0.25)",
          border: "1px solid rgba(255,200,80,0.12)",
          borderRadius: 8, padding: "2px 14px",
        }}>
          <StatRow addr="stats + 0x290  i32" label="shots fired (×10 in mem)"  value={fmtI(s?.shots_fired ?? 0)}             dim={!c || (s?.shots_fired ?? 0) === 0} />
          <StatRow addr="stats + 0x288  i32" label="body damage"               value={fmtI(s?.body_damage ?? 0)}             dim={!c || (s?.body_damage ?? 0) === 0} />
          <StatRow addr="stats + 0x2AC  f32" label="potential damage"          value={fmt(s?.potential_damage ?? 0, 0)}      dim={!c || (s?.potential_damage ?? 0) === 0} />
          <StatRow addr="stats + 0x384  f32" label="FOV"                       value={fmt(s?.fov ?? 0, 1)}                   dim={!c || (s?.fov ?? 0) === 0} />
        </div>
      </div>

      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.18)" }}>
        Beta branch offsets only. Score not in memory — written to CSV on scenario end only.
        Scenario name via Steam rich-presence write chain (unconfirmed across all game states).
      </div>
    </div>
  );
}
