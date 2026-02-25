import { useEffect, useMemo, useState } from "react";
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
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Parse KovaaK's timestamp "2024.01.15-12.30.45" → Date */
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
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtScore(n: number) {
  return Math.round(n).toLocaleString();
}

function fmtPct(n: number) {
  return (n * 100).toFixed(1) + "%";
}

function fmtDuration(secs: number) {
  if (secs < 60) return `${Math.round(secs)}s`;
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
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
    <div
      style={{
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 10,
        padding: "14px 18px",
        minWidth: 130,
        flex: 1,
      }}
    >
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.38)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent ?? "#fff", lineHeight: 1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

const CHART_TOOLTIP_STYLE = {
  background: "rgba(12,12,20,0.95)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
};

function ScoreTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div style={{ ...CHART_TOOLTIP_STYLE, padding: "10px 14px" }}>
      <div style={{ color: "rgba(255,255,255,0.45)", marginBottom: 4, fontSize: 11 }}>{d?.dateLabel}</div>
      <div style={{ color: "#00f5a0", fontWeight: 700 }}>
        {fmtScore(payload[0]?.value ?? 0)}
      </div>
    </div>
  );
}

function SmoothnessTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div style={{ ...CHART_TOOLTIP_STYLE, padding: "10px 14px", minWidth: 170 }}>
      <div style={{ color: "rgba(255,255,255,0.45)", marginBottom: 6, fontSize: 11 }}>{d?.dateLabel}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ display: "flex", justifyContent: "space-between", gap: 16, color: p.color, marginBottom: 2 }}>
          <span style={{ color: "rgba(255,255,255,0.55)" }}>{p.name}</span>
          <span style={{ fontWeight: 700 }}>{(p.value as number)?.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Details Panel ────────────────────────────────────────────────────────

function ScenarioDetails({ records }: { records: SessionRecord[] }) {
  const sorted = useMemo(
    () => [...records].sort((a, b) => {
      const da = parseTimestamp(a.timestamp)?.getTime() ?? 0;
      const db = parseTimestamp(b.timestamp)?.getTime() ?? 0;
      return da - db;
    }),
    [records]
  );

  const best = Math.max(...records.map((r) => r.score));
  const avg = records.reduce((s, r) => s + r.score, 0) / records.length;
  const smoothRecords = records.filter((r) => r.smoothness !== null);
  const avgSmooth =
    smoothRecords.length > 0
      ? smoothRecords.reduce((s, r) => s + r.smoothness!.composite, 0) / smoothRecords.length
      : null;

  const chartData = sorted.map((r, i) => ({
    i: i + 1,
    score: Math.round(r.score),
    composite: r.smoothness?.composite != null ? +r.smoothness.composite.toFixed(1) : null,
    jitter: r.smoothness?.jitter != null ? +r.smoothness.jitter.toFixed(2) : null,
    path: r.smoothness?.path_efficiency != null ? +(r.smoothness.path_efficiency * 100).toFixed(1) : null,
    dateLabel: formatDateTime(r.timestamp),
    isBest: r.score === best,
  }));

  const hasSmooth = smoothRecords.length > 0;
  const recentRuns = [...sorted].reverse().slice(0, 30);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Summary cards */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="Best Score" value={fmtScore(best)} accent="#00f5a0" />
        <StatCard label="Avg Score" value={fmtScore(avg)} />
        <StatCard label="Sessions" value={records.length.toString()} />
        {avgSmooth !== null && (
          <StatCard
            label="Avg Smoothness"
            value={avgSmooth.toFixed(1)}
            sub={`${smoothRecords.length} rated`}
            accent="#00b4ff"
          />
        )}
      </div>

      {/* Score trend */}
      <div
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: 12,
          padding: "16px 20px",
        }}
      >
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 14 }}>
          Score over time
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#00f5a0" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#00f5a0" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="i" tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }} tickLine={false} axisLine={false} width={52}
              tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)}
            />
            <Tooltip content={<ScoreTooltip />} />
            <Area
              type="monotone"
              dataKey="score"
              stroke="#00f5a0"
              strokeWidth={2}
              fill="url(#scoreGrad)"
              dot={false}
              activeDot={{ r: 4, fill: "#00f5a0" }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Smoothness trend */}
      {hasSmooth && (
        <div
          style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 12,
            padding: "16px 20px",
          }}
        >
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 14 }}>
            Smoothness trend
          </div>
          <div style={{ display: "flex", gap: 20, marginBottom: 10 }}>
            {[
              { color: "#00b4ff", label: "Composite (0–100)" },
              { color: "#00f5a0", label: "Path efficiency ×100" },
              { color: "#ff6b6b", label: "Jitter (lower = better)" },
            ].map((l) => (
              <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 12, height: 2, borderRadius: 2, background: l.color }} />
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>{l.label}</span>
              </div>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="i" tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }} tickLine={false} axisLine={false} width={38} />
              <Tooltip content={<SmoothnessTooltip />} />
              <Line type="monotone" dataKey="composite" name="Composite" stroke="#00b4ff" strokeWidth={2} dot={false} connectNulls />
              <Line type="monotone" dataKey="path" name="Path eff. ×100" stroke="#00f5a0" strokeWidth={1.5} dot={false} connectNulls />
              <Line type="monotone" dataKey="jitter" name="Jitter" stroke="#ff6b6b" strokeWidth={1.5} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Recent runs table */}
      <div
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: 12,
          padding: "16px 20px",
        }}
      >
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
          Recent runs
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "rgba(255,255,255,0.3)", textAlign: "left" }}>
              {["Date", "Score", "Acc", "Duration", "Smooth", "Jitter", "Path eff."].map((h) => (
                <th key={h} style={{ paddingBottom: 8, fontWeight: 500, borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
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
                    background: isBest ? "rgba(0,245,160,0.04)" : idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
                  }}
                >
                  <td style={{ padding: "8px 0", color: "rgba(255,255,255,0.5)" }}>{formatDateTime(r.timestamp)}</td>
                  <td style={{ padding: "8px 0", fontWeight: 700, color: isBest ? "#00f5a0" : "#fff" }}>
                    {fmtScore(r.score)}
                    {isBest && <span style={{ fontSize: 10, color: "#00f5a0", marginLeft: 6 }}>PB</span>}
                  </td>
                  <td style={{ padding: "8px 0", color: "rgba(255,255,255,0.6)" }}>{fmtPct(r.accuracy)}</td>
                  <td style={{ padding: "8px 0", color: "rgba(255,255,255,0.5)" }}>{fmtDuration(r.duration_secs)}</td>
                  <td style={{ padding: "8px 0", color: r.smoothness ? "#00b4ff" : "rgba(255,255,255,0.2)" }}>
                    {r.smoothness ? r.smoothness.composite.toFixed(1) : "—"}
                  </td>
                  <td style={{ padding: "8px 0", color: "rgba(255,255,255,0.45)" }}>
                    {r.smoothness ? r.smoothness.jitter.toFixed(2) : "—"}
                  </td>
                  <td style={{ padding: "8px 0", color: "rgba(255,255,255,0.45)" }}>
                    {r.smoothness ? (r.smoothness.path_efficiency * 100).toFixed(1) + "%" : "—"}
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

// ─── Root Component ────────────────────────────────────────────────────────────

export function StatsWindow() {
  const [records, setRecords] = useState<SessionRecord[]>([]);
  const [search, setSearch] = useState("");
  const [selectedScenario, setSelectedScenario] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);

  async function loadHistory() {
    try {
      const data = await invoke<SessionRecord[]>("get_session_history");
      setRecords(data);
      // Auto-select the scenario with the most recent session if none selected
      if (!selectedScenario && data.length > 0) {
        const latest = data.reduce((a, b) => {
          const ta = parseTimestamp(a.timestamp)?.getTime() ?? 0;
          const tb = parseTimestamp(b.timestamp)?.getTime() ?? 0;
          return tb > ta ? b : a;
        });
        setSelectedScenario(latest.scenario);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadHistory();
    // Refresh when a new session completes
    const unlisten = listen("session-complete", () => loadHistory());
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  async function handleClear() {
    if (!confirmClear) { setConfirmClear(true); return; }
    await invoke("clear_session_history");
    setRecords([]);
    setSelectedScenario(null);
    setConfirmClear(false);
  }

  // Group by scenario
  const scenarioGroups = useMemo(() => {
    const q = search.toLowerCase();
    const map = new Map<string, { best: number; count: number; lastTs: string }>();
    for (const r of records) {
      if (q && !r.scenario.toLowerCase().includes(q)) continue;
      const cur = map.get(r.scenario);
      const curTs = cur?.lastTs ?? "";
      const isNewer = (parseTimestamp(r.timestamp)?.getTime() ?? 0) > (parseTimestamp(curTs)?.getTime() ?? 0);
      map.set(r.scenario, {
        best: Math.max(cur?.best ?? 0, r.score),
        count: (cur?.count ?? 0) + 1,
        lastTs: isNewer ? r.timestamp : curTs,
      });
    }
    return [...map.entries()]
      .map(([name, s]) => ({ name, ...s }))
      .sort((a, b) => (parseTimestamp(b.lastTs)?.getTime() ?? 0) - (parseTimestamp(a.lastTs)?.getTime() ?? 0));
  }, [records, search]);

  const selectedRecords = useMemo(
    () => records.filter((r) => r.scenario === selectedScenario),
    [records, selectedScenario]
  );

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
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
        {/* Header */}
        <div style={{ padding: "18px 16px 12px" }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12, color: "#fff" }}>
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

        {/* Scenario list */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {loading ? (
            <div style={{ padding: "20px 16px", color: "rgba(255,255,255,0.3)", fontSize: 12 }}>Loading…</div>
          ) : scenarioGroups.length === 0 ? (
            <div style={{ padding: "20px 16px", color: "rgba(255,255,255,0.25)", fontSize: 12, lineHeight: 1.6 }}>
              {records.length === 0
                ? "No sessions recorded yet.\nSessions are saved automatically when you finish a run."
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
                    borderLeft: active ? "2px solid #00f5a0" : "2px solid transparent",
                    padding: "10px 14px 10px 14px",
                    cursor: "pointer",
                    color: active ? "#fff" : "rgba(255,255,255,0.65)",
                    fontFamily: "inherit",
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontWeight: active ? 700 : 400, marginBottom: 3, lineHeight: 1.3, wordBreak: "break-word" }}>
                    {g.name}
                  </div>
                  <div style={{ fontSize: 11, color: active ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.28)", display: "flex", gap: 10 }}>
                    <span>{g.count} run{g.count !== 1 ? "s" : ""}</span>
                    <span style={{ color: active ? "#00f5a0" : "rgba(255,255,255,0.35)" }}>
                      PB {fmtScore(g.best)}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Footer: total count + clear */}
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
            <h2 style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 700, color: "#fff" }}>
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
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ fontSize: 13 }}>
              {records.length === 0 ? "Play a session to start recording stats." : "Select a scenario from the sidebar."}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
