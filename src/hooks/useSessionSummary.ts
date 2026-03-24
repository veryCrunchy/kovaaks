import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  PersistedStatsPanelSnapshot,
  SessionCompletePayload,
  SessionResult,
  StatsPanelReading,
} from "../types/overlay";
import type { BridgeRunSnapshot, MouseMetrics } from "../types/mouse";
import type { AppSettings } from "../types/settings";
import {
  buildRunCoachingTips,
  buildRunMomentInsights,
  normalizeBridgeRunTimeline,
  type RunTimelinePoint,
  type ScenarioRunSnapshot,
} from "../coaching/engine";

export type {
  RunCoachingTip,
  RunMomentInsight,
  RunTimelinePoint,
  ScenarioRunSnapshot,
} from "../coaching/engine";

export interface SessionSummary {
  session: SessionResult;
  metrics: MouseMetrics | null;
  statsPanel: StatsPanelReading | null;
  runSnapshot: ScenarioRunSnapshot | null;
}

interface BridgeMetricEvent {
  ev: string;
  value?: number | null;
  delta?: number | null;
  total?: number | null;
}

interface MutableRunMetrics {
  durationSecs: number | null;
  scoreTotal: number | null;
  scoreTotalDerived: number | null;
  scorePerMinute: number | null;
  shotsFired: number | null;
  shotsHit: number | null;
  kills: number | null;
  killsPerSecond: number | null;
  damageDone: number | null;
  damagePossible: number | null;
  damageEfficiency: number | null;
  accuracyPct: number | null;
}

interface MutableRunCounts {
  shotFiredEvents: number;
  shotHitEvents: number;
  killEvents: number;
  challengeQueuedEvents: number;
  challengeStartEvents: number;
  challengeEndEvents: number;
  challengeCompleteEvents: number;
  challengeCanceledEvents: number;
}

const MAX_TIMELINE_POINTS = 1_200;
const DEFAULT_AUTO_DISMISS_MS = 20_000;

function createEmptyRunMetrics(): MutableRunMetrics {
  return {
    durationSecs: null,
    scoreTotal: null,
    scoreTotalDerived: null,
    scorePerMinute: null,
    shotsFired: null,
    shotsHit: null,
    kills: null,
    killsPerSecond: null,
    damageDone: null,
    damagePossible: null,
    damageEfficiency: null,
    accuracyPct: null,
  };
}

function createEmptyRunCounts(): MutableRunCounts {
  return {
    shotFiredEvents: 0,
    shotHitEvents: 0,
    killEvents: 0,
    challengeQueuedEvents: 0,
    challengeStartEvents: 0,
    challengeEndEvents: 0,
    challengeCompleteEvents: 0,
    challengeCanceledEvents: 0,
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function toPositiveOrNull(v: number | null): number | null {
  return v != null && Number.isFinite(v) && v >= 0 ? v : null;
}

function buildRunSnapshot(
  session: SessionResult,
  metricsRef: MutableRefObject<MutableRunMetrics>,
  peakSpmRef: MutableRefObject<number | null>,
  peakKpsRef: MutableRefObject<number | null>,
  countsRef: MutableRefObject<MutableRunCounts>,
  timelineRef: MutableRefObject<RunTimelinePoint[]>,
  startedAtMs: number,
): ScenarioRunSnapshot {
  const m = metricsRef.current;
  const shotsFired = toPositiveOrNull(m.shotsFired);
  const shotsHit = toPositiveOrNull(m.shotsHit);
  const computedAccuracy =
    shotsFired != null && shotsFired > 0 && shotsHit != null
      ? (shotsHit / shotsFired) * 100
      : null;
  const computedDamageEfficiency =
    m.damagePossible != null && m.damagePossible > 0 && m.damageDone != null
      ? (m.damageDone / m.damagePossible) * 100
      : null;

  const timeline = timelineRef.current.slice(-MAX_TIMELINE_POINTS);
  const snapshotBase: Omit<ScenarioRunSnapshot, "tips"> = {
    durationSecs: toPositiveOrNull(m.durationSecs) ?? session.duration_secs ?? null,
    scoreTotal: toPositiveOrNull(m.scoreTotal),
    scoreTotalDerived: toPositiveOrNull(m.scoreTotalDerived),
    scorePerMinute: toPositiveOrNull(m.scorePerMinute),
    shotsFired,
    shotsHit,
    kills: toPositiveOrNull(m.kills),
    killsPerSecond: toPositiveOrNull(m.killsPerSecond),
    damageDone: toPositiveOrNull(m.damageDone),
    damagePossible: toPositiveOrNull(m.damagePossible),
    damageEfficiency: toPositiveOrNull(m.damageEfficiency) ?? computedDamageEfficiency,
    accuracyPct: toPositiveOrNull(m.accuracyPct) ?? computedAccuracy,
    peakScorePerMinute: toPositiveOrNull(peakSpmRef.current),
    peakKillsPerSecond: toPositiveOrNull(peakKpsRef.current),
    shotFiredEvents: countsRef.current.shotFiredEvents,
    shotHitEvents: countsRef.current.shotHitEvents,
    killEvents: countsRef.current.killEvents,
    challengeQueuedEvents: countsRef.current.challengeQueuedEvents,
    challengeStartEvents: countsRef.current.challengeStartEvents,
    challengeEndEvents: countsRef.current.challengeEndEvents,
    challengeCompleteEvents: countsRef.current.challengeCompleteEvents,
    challengeCanceledEvents: countsRef.current.challengeCanceledEvents,
    startedAtMs: startedAtMs > 0 ? startedAtMs : null,
    endedAtMs: Date.now(),
    timeline,
    keyMoments: buildRunMomentInsights(
      timeline,
      toPositiveOrNull(m.durationSecs) ?? session.duration_secs ?? null,
      3,
    ),
  };

  return {
    ...snapshotBase,
    tips: buildRunCoachingTips(snapshotBase, snapshotBase.keyMoments, 3),
  };
}

function buildRunSnapshotFromBridge(
  session: SessionResult,
  snapshot: BridgeRunSnapshot,
): ScenarioRunSnapshot {
  const timeline: RunTimelinePoint[] = normalizeBridgeRunTimeline(snapshot.timeline ?? []);

  const snapshotBase: Omit<ScenarioRunSnapshot, "tips"> = {
    durationSecs: toPositiveOrNull(snapshot.duration_secs) ?? session.duration_secs ?? null,
    scoreTotal: toPositiveOrNull(snapshot.score_total),
    scoreTotalDerived: toPositiveOrNull(snapshot.score_total_derived),
    scorePerMinute: toPositiveOrNull(snapshot.score_per_minute),
    shotsFired: toPositiveOrNull(snapshot.shots_fired),
    shotsHit: toPositiveOrNull(snapshot.shots_hit),
    kills: toPositiveOrNull(snapshot.kills),
    killsPerSecond: toPositiveOrNull(snapshot.kills_per_second),
    damageDone: toPositiveOrNull(snapshot.damage_done),
    damagePossible: toPositiveOrNull(snapshot.damage_possible),
    damageEfficiency: toPositiveOrNull(snapshot.damage_efficiency),
    accuracyPct: toPositiveOrNull(snapshot.accuracy_pct),
    peakScorePerMinute: toPositiveOrNull(snapshot.peak_score_per_minute),
    peakKillsPerSecond: toPositiveOrNull(snapshot.peak_kills_per_second),
    shotFiredEvents: snapshot.event_counts?.shot_fired_events ?? 0,
    shotHitEvents: snapshot.event_counts?.shot_hit_events ?? 0,
    killEvents: snapshot.event_counts?.kill_events ?? 0,
    challengeQueuedEvents: snapshot.event_counts?.challenge_queued_events ?? 0,
    challengeStartEvents: snapshot.event_counts?.challenge_start_events ?? 0,
    challengeEndEvents: snapshot.event_counts?.challenge_end_events ?? 0,
    challengeCompleteEvents: snapshot.event_counts?.challenge_complete_events ?? 0,
    challengeCanceledEvents: snapshot.event_counts?.challenge_canceled_events ?? 0,
    startedAtMs: snapshot.started_at_unix_ms ?? null,
    endedAtMs: snapshot.ended_at_unix_ms ?? null,
    timeline,
    keyMoments: buildRunMomentInsights(
      timeline,
      toPositiveOrNull(snapshot.duration_secs) ?? session.duration_secs ?? null,
      3,
    ),
  };

  return {
    ...snapshotBase,
    tips: buildRunCoachingTips(snapshotBase, snapshotBase.keyMoments, 3),
  };
}

function normalizePersistedStatsPanel(
  persisted: PersistedStatsPanelSnapshot | null | undefined,
  runSnapshot: ScenarioRunSnapshot | null,
  session: SessionResult,
): StatsPanelReading | null {
  if (!persisted) return null;
  return {
    session_time_secs: runSnapshot?.durationSecs ?? session.duration_secs ?? null,
    score_total: runSnapshot?.scoreTotal ?? null,
    score_total_derived: runSnapshot?.scoreTotalDerived ?? null,
    kills: persisted.kills ?? null,
    kps: persisted.avg_kps ?? null,
    accuracy_hits: null,
    accuracy_shots: null,
    accuracy_pct: persisted.accuracy_pct ?? runSnapshot?.accuracyPct ?? null,
    damage_dealt: persisted.total_damage ?? runSnapshot?.damageDone ?? null,
    damage_total: runSnapshot?.damagePossible ?? null,
    spm: runSnapshot?.scorePerMinute ?? null,
    ttk_secs: persisted.avg_ttk_ms != null ? persisted.avg_ttk_ms / 1000 : null,
    scenario_type: persisted.scenario_type,
    scenario_subtype: persisted.scenario_subtype ?? null,
  };
}

/**
 * Captures an end-of-run snapshot with bridge pull metrics + key event deltas,
 * then surfaces concise coaching tips for that specific scenario run.
 */
export function useSessionSummary(): {
  summary: SessionSummary | null;
  dismiss: () => void;
  /** 0-1 progress toward auto-dismiss; updated every ~200ms */
  dismissProgress: number;
} {
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [dismissProgress, setDismissProgress] = useState(0);

  const latestMetrics = useRef<MouseMetrics | null>(null);
  const latestStatsPanel = useRef<StatsPanelReading | null>(null);

  const runMetrics = useRef<MutableRunMetrics>(createEmptyRunMetrics());
  const runCounts = useRef<MutableRunCounts>(createEmptyRunCounts());
  const runPeakSpm = useRef<number | null>(null);
  const runPeakKps = useRef<number | null>(null);
  const runTimeline = useRef<RunTimelinePoint[]>([]);
  const runStartedAtMs = useRef<number>(0);

  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const dismissedAt = useRef<number>(0);
  const autoDismissMs = useRef<number>(DEFAULT_AUTO_DISMISS_MS);

  const stopTimers = () => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
    if (progressInterval.current) {
      clearInterval(progressInterval.current);
      progressInterval.current = null;
    }
  };

  const resetRunSnapshotRefs = () => {
    runMetrics.current = createEmptyRunMetrics();
    runCounts.current = createEmptyRunCounts();
    runPeakSpm.current = null;
    runPeakKps.current = null;
    runTimeline.current = [];
  };

  const recordTimelinePoint = (timeHintSecs?: number | null) => {
    const startMs = runStartedAtMs.current;
    if (startMs <= 0) return;

    const fallbackSecs = Math.max(0, (Date.now() - startMs) / 1000);
    const hintedSecs =
      isFiniteNumber(timeHintSecs)
      ? Math.max(0, timeHintSecs)
      : runMetrics.current.durationSecs ?? fallbackSecs;
    const tSec = Math.max(0, Math.floor(hintedSecs));

    const point: RunTimelinePoint = {
      tSec,
      scorePerMinute: toPositiveOrNull(runMetrics.current.scorePerMinute),
      killsPerSecond: toPositiveOrNull(runMetrics.current.killsPerSecond),
      accuracyPct: toPositiveOrNull(runMetrics.current.accuracyPct),
      damageEfficiency: toPositiveOrNull(runMetrics.current.damageEfficiency),
      scoreTotal: toPositiveOrNull(runMetrics.current.scoreTotal),
      scoreTotalDerived: toPositiveOrNull(runMetrics.current.scoreTotalDerived),
      kills: toPositiveOrNull(runMetrics.current.kills),
      shotsFired: toPositiveOrNull(runMetrics.current.shotsFired),
      shotsHit: toPositiveOrNull(runMetrics.current.shotsHit),
    };

    if (runTimeline.current.length > 0) {
      const idx = runTimeline.current.length - 1;
      const prev = runTimeline.current[idx];
      if (prev.tSec === tSec) {
        runTimeline.current[idx] = {
          ...prev,
          ...point,
          scorePerMinute: point.scorePerMinute ?? prev.scorePerMinute,
          killsPerSecond: point.killsPerSecond ?? prev.killsPerSecond,
          accuracyPct: point.accuracyPct ?? prev.accuracyPct,
          damageEfficiency: point.damageEfficiency ?? prev.damageEfficiency,
          scoreTotal: point.scoreTotal ?? prev.scoreTotal,
          scoreTotalDerived: point.scoreTotalDerived ?? prev.scoreTotalDerived,
          kills: point.kills ?? prev.kills,
          shotsFired: point.shotsFired ?? prev.shotsFired,
          shotsHit: point.shotsHit ?? prev.shotsHit,
        };
        return;
      }
    }

    runTimeline.current.push(point);
    if (runTimeline.current.length > MAX_TIMELINE_POINTS) {
      runTimeline.current.splice(0, runTimeline.current.length - MAX_TIMELINE_POINTS);
    }
  };

  const dismiss = () => {
    stopTimers();
    setSummary(null);
    setDismissProgress(0);
  };

  useEffect(() => {
    const applySettings = (settings: Pick<AppSettings, "post_session_summary_duration_secs">) => {
      autoDismissMs.current = Math.max(0, settings.post_session_summary_duration_secs) * 1000;
    };

    void invoke<AppSettings>("get_settings")
      .then(applySettings)
      .catch(() => {
        autoDismissMs.current = DEFAULT_AUTO_DISMISS_MS;
      });

    const unlistenSettings = listen("settings-changed", async () => {
      try {
        const next = await invoke<AppSettings>("get_settings");
        applySettings(next);
      } catch {
        // Keep the current timeout if settings refresh fails.
      }
    });

    const unlistenMetrics = listen<MouseMetrics>("mouse-metrics", (e) => {
      latestMetrics.current = e.payload;
    });

    const unlistenStats = listen<StatsPanelReading>("stats-panel-update", (e) => {
      latestStatsPanel.current = e.payload;
      const payload = e.payload;

      const durationSecs =
        isFiniteNumber(payload?.challenge_seconds_total)
          ? payload.challenge_seconds_total
          : isFiniteNumber(payload?.session_time_secs)
          ? payload.session_time_secs
          : null;

      if (durationSecs != null) {
        if (runStartedAtMs.current === 0 && durationSecs > 0) {
          runStartedAtMs.current = Date.now() - durationSecs * 1000;
        }
        runMetrics.current.durationSecs = durationSecs;
      }

      if (isFiniteNumber(payload?.spm)) runMetrics.current.scorePerMinute = payload.spm;
      if (isFiniteNumber(payload?.score_total)) runMetrics.current.scoreTotal = payload.score_total;
      if (isFiniteNumber(payload?.score_total_derived)) runMetrics.current.scoreTotalDerived = payload.score_total_derived;
      if (isFiniteNumber(payload?.kps)) runMetrics.current.killsPerSecond = payload.kps;
      if (isFiniteNumber(payload?.kills)) runMetrics.current.kills = payload.kills;
      if (isFiniteNumber(payload?.accuracy_pct)) runMetrics.current.accuracyPct = payload.accuracy_pct;
      if (isFiniteNumber(payload?.accuracy_hits)) runMetrics.current.shotsHit = payload.accuracy_hits;
      if (isFiniteNumber(payload?.accuracy_shots)) runMetrics.current.shotsFired = payload.accuracy_shots;
      if (isFiniteNumber(payload?.damage_dealt)) runMetrics.current.damageDone = payload.damage_dealt;
      if (isFiniteNumber(payload?.damage_total)) runMetrics.current.damagePossible = payload.damage_total;
      if (
        isFiniteNumber(payload?.damage_dealt)
        && isFiniteNumber(payload?.damage_total)
        && payload.damage_total > 0
      ) {
        runMetrics.current.damageEfficiency = (payload.damage_dealt / payload.damage_total) * 100;
      }

      recordTimelinePoint(durationSecs);
    });

    const unlistenBridgeMetric = listen<BridgeMetricEvent>("bridge-metric", (e) => {
      const payload = e.payload;
      const ev = String(payload?.ev ?? "");
      if (!ev) return;
      const value = isFiniteNumber(payload?.value) ? payload.value : null;
      const delta = isFiniteNumber(payload?.delta) ? payload.delta : null;
      const total = isFiniteNumber(payload?.total) ? payload.total : null;

      if (runStartedAtMs.current === 0 && ev === "pull_seconds_total" && value != null && value > 0) {
        runStartedAtMs.current = Date.now() - value * 1000;
      }

      if (ev === "challenge_start" || ev === "scenario_start") {
        if (runStartedAtMs.current === 0) runStartedAtMs.current = Date.now();
        runCounts.current.challengeStartEvents += 1;
      } else if (ev === "challenge_queued") {
        runCounts.current.challengeQueuedEvents += 1;
      } else if (ev === "challenge_end" || ev === "scenario_end") {
        runCounts.current.challengeEndEvents += 1;
      } else if (ev === "challenge_complete" || ev === "challenge_completed" || ev === "post_challenge_complete") {
        runCounts.current.challengeCompleteEvents += 1;
      } else if (ev === "challenge_canceled" || ev === "challenge_quit") {
        runCounts.current.challengeCanceledEvents += 1;
      }

      if (ev === "shot_fired") {
        runCounts.current.shotFiredEvents += Math.max(1, Math.round(delta ?? 1));
      } else if (ev === "shot_hit") {
        runCounts.current.shotHitEvents += Math.max(1, Math.round(delta ?? 1));
      } else if (ev === "kill") {
        runCounts.current.killEvents += Math.max(1, Math.round(delta ?? 1));
      }

      if (value == null) return;

      switch (ev) {
        case "pull_shots_fired_total":
          runMetrics.current.shotsFired = value;
          break;
        case "pull_shots_hit_total":
          runMetrics.current.shotsHit = value;
          break;
        case "pull_kills_total":
          runMetrics.current.kills = value;
          break;
        case "pull_seconds_total":
          runMetrics.current.durationSecs = value;
          break;
        case "pull_score_per_minute":
          runMetrics.current.scorePerMinute = value;
          runPeakSpm.current = Math.max(runPeakSpm.current ?? 0, value);
          break;
        case "pull_kills_per_second":
          runMetrics.current.killsPerSecond = value;
          runPeakKps.current = Math.max(runPeakKps.current ?? 0, value);
          break;
        case "pull_damage_done":
          runMetrics.current.damageDone = value;
          break;
        case "pull_damage_possible":
          runMetrics.current.damagePossible = value;
          break;
        case "pull_damage_efficiency":
          runMetrics.current.damageEfficiency = value;
          break;
        case "pull_accuracy":
          runMetrics.current.accuracyPct = value;
          break;
        case "pull_score_total":
          runMetrics.current.scoreTotal = value;
          break;
        case "pull_score_total_derived":
          runMetrics.current.scoreTotalDerived = value;
          break;
        default:
          break;
      }

      if (ev === "shot_fired" && total != null) runMetrics.current.shotsFired = total;
      if (ev === "shot_hit" && total != null) runMetrics.current.shotsHit = total;
      if (ev === "kill" && total != null) runMetrics.current.kills = total;

      recordTimelinePoint();
    });

    const unlistenComplete = listen<SessionCompletePayload>("session-complete", (e) => {
      stopTimers();
      const session = e.payload as SessionResult;
      const runSnapshot = e.payload.run_snapshot
        ? buildRunSnapshotFromBridge(session, e.payload.run_snapshot)
        : buildRunSnapshot(
            session,
            runMetrics,
            runPeakSpm,
            runPeakKps,
            runCounts,
            runTimeline,
            runStartedAtMs.current,
          );
      const statsPanel =
        normalizePersistedStatsPanel(e.payload.stats_panel, runSnapshot, session)
        ?? latestStatsPanel.current;
      setSummary({
        session,
        metrics: latestMetrics.current,
        statsPanel,
        runSnapshot,
      });
      setDismissProgress(0);

      latestMetrics.current = null;
      latestStatsPanel.current = null;
      runStartedAtMs.current = 0;
      resetRunSnapshotRefs();

      dismissedAt.current = Date.now();
      if (autoDismissMs.current > 0) {
        dismissTimer.current = setTimeout(dismiss, autoDismissMs.current);
        progressInterval.current = setInterval(() => {
          const elapsed = Date.now() - dismissedAt.current;
          setDismissProgress(Math.min(elapsed / autoDismissMs.current, 1));
        }, 200);
      }
    });

    const unlistenStart = listen<void>("session-start", () => {
      stopTimers();
      setSummary(null);
      setDismissProgress(0);
      latestMetrics.current = null;
      latestStatsPanel.current = null;
      runStartedAtMs.current = Date.now();
      resetRunSnapshotRefs();
    });

    return () => {
      unlistenMetrics.then((fn) => fn());
      unlistenStats.then((fn) => fn());
      unlistenBridgeMetric.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
      unlistenStart.then((fn) => fn());
      unlistenSettings.then((fn) => fn());
      stopTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { summary, dismiss, dismissProgress };
}
