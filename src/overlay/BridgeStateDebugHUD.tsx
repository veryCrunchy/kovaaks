import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useLiveScore } from "../hooks/useLiveScore";
import { useStatsPanel } from "../hooks/useStatsPanel";
import { C } from "../design/tokens";

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
        background: C.glass,
        border: `1px solid ${C.accentBorder}`,
        backdropFilter: "blur(16px) saturate(180%)",
        boxShadow: `0 8px 22px rgba(0,0,0,0.5), 0 0 0 1px ${C.accent}08`,
        color: C.text,
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
          borderBottom: `1px solid ${C.border}`,
          color: C.accent,
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: "0.1em",
          marginBottom: 8,
          paddingBottom: 6,
          textTransform: "uppercase",
        }}
      >
        Bridge State Debug
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "170px 1fr", gap: "2px 10px" }}>
        <span style={{ color: C.textMuted }}>session_active</span>
        <span style={{ color: isSessionActive ? C.accent : C.textSub }}>{fmtBool(isSessionActive)}</span>
        <span style={{ color: C.textMuted }}>elapsed_seconds</span>
        <span style={{ color: C.textSub }}>{elapsedSeconds}</span>
        <span style={{ color: C.textMuted }}>scenario_name</span>
        <span style={{ color: scenarioName ? C.text : C.textFaint }}>{scenarioName ?? "null"}</span>
        <span style={{ color: C.textMuted }}>game_state</span>
        <span style={{ color: C.textSub }}>{stats?.game_state ?? "null"}</span>
        <span style={{ color: C.textMuted }}>game_state_code</span>
        <span style={{ color: C.textSub }}>{stats?.game_state_code ?? "null"}</span>
        <span style={{ color: C.textMuted }}>is_in_scenario</span>
        <span style={{ color: stats?.is_in_scenario ? C.accent : C.textSub }}>{fmtBool(stats?.is_in_scenario)}</span>
        <span style={{ color: C.textMuted }}>is_in_challenge</span>
        <span style={{ color: stats?.is_in_challenge ? C.accent : C.textSub }}>{fmtBool(stats?.is_in_challenge)}</span>
        <span style={{ color: C.textMuted }}>is_in_scenario_editor</span>
        <span style={{ color: C.textSub }}>{fmtBool(stats?.is_in_scenario_editor)}</span>
        <span style={{ color: C.textMuted }}>is_in_trainer</span>
        <span style={{ color: C.textSub }}>{fmtBool(stats?.is_in_trainer)}</span>
        <span style={{ color: C.textMuted }}>scenario_play_type</span>
        <span style={{ color: C.textSub }}>{stats?.scenario_play_type ?? "null"}</span>
        <span style={{ color: C.textMuted }}>queue_time_remaining</span>
        <span style={{ color: C.textSub }}>{fmtNum(stats?.queue_time_remaining, 3)}</span>
        <span style={{ color: C.textMuted }}>time_remaining</span>
        <span style={{ color: C.textSub }}>{fmtNum(stats?.time_remaining, 3)}</span>
        <span style={{ color: C.textMuted }}>score_from_metrics</span>
        <span style={{ color: C.textSub }}>{liveScore ?? "null"}</span>
        <span style={{ color: C.textMuted }}>metric_score_total</span>
        <span style={{ color: C.textSub }}>{fmtNum(metricScoreTotal, 3)}</span>
        <span style={{ color: C.textMuted }}>metric_score_total_derived</span>
        <span style={{ color: C.textSub }}>{fmtNum(metricScoreDerived, 3)}</span>
      </div>

      <div
        style={{
          borderTop: `1px solid ${C.borderSub}`,
          color: C.textSub,
          marginTop: 8,
          paddingTop: 8,
        }}
      >
        <div
          style={{
            color: C.accent,
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.1em",
            marginBottom: 5,
            textTransform: "uppercase",
          }}
        >
          recent bridge metrics
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {traceRows.length === 0 && (
            <span style={{ color: C.textFaint }}>no metrics yet</span>
          )}
          {traceRows.map((row) => (
            <span key={row.id} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: C.textSub }}>
              {row.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
