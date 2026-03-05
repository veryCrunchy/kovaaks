import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useLiveScore } from "../hooks/useLiveScore";
import { useStatsPanel } from "../hooks/useStatsPanel";

interface BridgeMetricEvent {
  ev: string;
  value?: number | null;
  field?: string | null;
  source?: string | null;
}

interface MetricTraceRow {
  id: number;
  text: string;
}

const TRACE_MAX_ROWS = 10;
const INTERESTING_METRICS = new Set<string>([
  "scenario_name",
  "pull_is_in_scenario",
  "pull_is_in_challenge",
  "pull_is_in_scenario_editor",
  "pull_is_in_trainer",
  "pull_queue_time_remaining",
  "pull_score_total",
  "pull_score_total_derived",
  "score_source",
]);

function fmtBool(value: boolean | null | undefined): string {
  if (value === true) return "true";
  if (value === false) return "false";
  return "null";
}

function fmtNum(value: number | null | undefined, decimals = 3): string {
  if (value == null || !Number.isFinite(value)) return "null";
  return value.toFixed(decimals);
}

export function BridgeStateDebugHUD() {
  const stats = useStatsPanel();
  const { liveScore, isSessionActive, elapsedSeconds } = useLiveScore();
  const [metricScoreTotal, setMetricScoreTotal] = useState<number | null>(null);
  const [metricScoreDerived, setMetricScoreDerived] = useState<number | null>(null);
  const [metricScenarioName, setMetricScenarioName] = useState<string | null>(null);
  const [traceRows, setTraceRows] = useState<MetricTraceRow[]>([]);

  useEffect(() => {
    let nextTraceId = 1;
    const unlisten = listen<BridgeMetricEvent>("bridge-metric", (event) => {
      const payload = event.payload;
      if (!INTERESTING_METRICS.has(payload.ev)) return;

      if (payload.ev === "pull_score_total" && payload.value != null && Number.isFinite(payload.value)) {
        setMetricScoreTotal(payload.value);
      } else if (
        payload.ev === "pull_score_total_derived"
        && payload.value != null
        && Number.isFinite(payload.value)
      ) {
        setMetricScoreDerived(payload.value);
      } else if (payload.ev === "scenario_name" && payload.field) {
        const trimmed = payload.field.trim();
        if (trimmed.length > 0) setMetricScenarioName(trimmed);
      }

      const scoreLike = payload.value != null && Number.isFinite(payload.value)
        ? `=${payload.value.toFixed(3)}`
        : "";
      const fieldLike = payload.field ? ` field=${payload.field}` : "";
      const sourceLike = payload.source ? ` src=${payload.source}` : "";
      const line = `${payload.ev}${scoreLike}${fieldLike}${sourceLike}`;
      const row: MetricTraceRow = { id: nextTraceId++, text: line };
      setTraceRows((prev) => [row, ...prev].slice(0, TRACE_MAX_ROWS));
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const scenarioName = useMemo(() => {
    const raw = stats?.scenario_name ?? metricScenarioName ?? null;
    if (!raw) return null;
    const normalized = raw.trim();
    return normalized.length > 0 ? normalized : null;
  }, [metricScenarioName, stats?.scenario_name]);

  return (
    <div
      className="rounded-lg"
      style={{
        background: "rgba(7, 12, 18, 0.9)",
        border: "1px solid rgba(56, 189, 248, 0.45)",
        boxShadow: "0 8px 22px rgba(0, 0, 0, 0.42)",
        color: "#e5f4ff",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
        lineHeight: 1.35,
        minWidth: 400,
        maxWidth: 520,
        padding: "10px 12px",
      }}
    >
      <div
        style={{
          borderBottom: "1px solid rgba(148, 163, 184, 0.35)",
          color: "#7dd3fc",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.08em",
          marginBottom: 8,
          paddingBottom: 6,
          textTransform: "uppercase",
        }}
      >
        Bridge State Debug
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "170px 1fr", gap: "2px 10px" }}>
        <span style={{ color: "rgba(226,232,240,0.75)" }}>session_active</span>
        <span>{fmtBool(isSessionActive)}</span>
        <span style={{ color: "rgba(226,232,240,0.75)" }}>elapsed_seconds</span>
        <span>{elapsedSeconds}</span>
        <span style={{ color: "rgba(226,232,240,0.75)" }}>scenario_name</span>
        <span>{scenarioName ?? "null"}</span>
        <span style={{ color: "rgba(226,232,240,0.75)" }}>game_state</span>
        <span>{stats?.game_state ?? "null"}</span>
        <span style={{ color: "rgba(226,232,240,0.75)" }}>is_in_scenario</span>
        <span>{fmtBool(stats?.is_in_scenario)}</span>
        <span style={{ color: "rgba(226,232,240,0.75)" }}>is_in_challenge</span>
        <span>{fmtBool(stats?.is_in_challenge)}</span>
        <span style={{ color: "rgba(226,232,240,0.75)" }}>is_in_scenario_editor</span>
        <span>{fmtBool(stats?.is_in_scenario_editor)}</span>
        <span style={{ color: "rgba(226,232,240,0.75)" }}>is_in_trainer</span>
        <span>{fmtBool(stats?.is_in_trainer)}</span>
        <span style={{ color: "rgba(226,232,240,0.75)" }}>scenario_play_type</span>
        <span>{stats?.scenario_play_type ?? "null"}</span>
        <span style={{ color: "rgba(226,232,240,0.75)" }}>queue_time_remaining</span>
        <span>{fmtNum(stats?.queue_time_remaining, 3)}</span>
        <span style={{ color: "rgba(226,232,240,0.75)" }}>time_remaining</span>
        <span>{fmtNum(stats?.time_remaining, 3)}</span>
        <span style={{ color: "rgba(226,232,240,0.75)" }}>score_from_metrics</span>
        <span>{liveScore ?? "null"}</span>
        <span style={{ color: "rgba(226,232,240,0.75)" }}>metric_score_total</span>
        <span>{fmtNum(metricScoreTotal, 3)}</span>
        <span style={{ color: "rgba(226,232,240,0.75)" }}>metric_score_total_derived</span>
        <span>{fmtNum(metricScoreDerived, 3)}</span>
      </div>

      <div
        style={{
          borderTop: "1px solid rgba(148, 163, 184, 0.25)",
          color: "rgba(226,232,240,0.92)",
          marginTop: 8,
          paddingTop: 8,
        }}
      >
        <div
          style={{
            color: "rgba(125, 211, 252, 0.95)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.06em",
            marginBottom: 5,
            textTransform: "uppercase",
          }}
        >
          recent bridge metrics
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {traceRows.length === 0 && (
            <span style={{ color: "rgba(148, 163, 184, 0.9)" }}>no metrics yet</span>
          )}
          {traceRows.map((row) => (
            <span key={row.id} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {row.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
