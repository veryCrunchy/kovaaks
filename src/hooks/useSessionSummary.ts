import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import type { SessionResult, StatsPanelReading } from "../types/overlay";
import type { MouseMetrics } from "../types/mouse";

export interface RunCoachingTip {
  id: string;
  level: "good" | "tip" | "warning";
  title: string;
  detail: string;
}

export interface ScenarioRunSnapshot {
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
  peakScorePerMinute: number | null;
  peakKillsPerSecond: number | null;
  shotFiredEvents: number;
  shotHitEvents: number;
  killEvents: number;
  challengeQueuedEvents: number;
  challengeStartEvents: number;
  challengeEndEvents: number;
  challengeCompleteEvents: number;
  challengeCanceledEvents: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
  tips: RunCoachingTip[];
}

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

/** Auto-dismiss timeout in milliseconds. */
const AUTO_DISMISS_MS = 20_000;

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

function buildRunTips(snapshot: Omit<ScenarioRunSnapshot, "tips">): RunCoachingTip[] {
  const tips: RunCoachingTip[] = [];

  if (snapshot.accuracyPct != null) {
    if (snapshot.accuracyPct < 75) {
      tips.push({
        id: "acc-low",
        level: "warning",
        title: "Low Accuracy",
        detail: "Accuracy dropped below 75%. Slow your first shot slightly and prioritize cleaner target confirmation over raw fire rate.",
      });
    } else if (snapshot.accuracyPct >= 92) {
      tips.push({
        id: "acc-strong",
        level: "good",
        title: "Strong Accuracy",
        detail: "Accuracy is stable. Push pace incrementally to convert this precision into higher score throughput.",
      });
    }
  }

  if (snapshot.damageEfficiency != null && snapshot.damageEfficiency < 85) {
    tips.push({
      id: "dmg-eff",
      level: "tip",
      title: "Damage Conversion",
      detail: "Damage efficiency is below 85%. Focus on stopping crosshair momentum before click to reduce low-value hits and misses.",
    });
  }

  if (snapshot.killsPerSecond != null && snapshot.accuracyPct != null) {
    if (snapshot.killsPerSecond < 0.75 && snapshot.accuracyPct >= 88) {
      tips.push({
        id: "speed-gap",
        level: "tip",
        title: "Speed Ceiling",
        detail: "Precision is good but kill pace is limited. Add faster target-switch drills and commit earlier on clean lines.",
      });
    }
  }

  if (snapshot.scorePerMinute != null && snapshot.peakScorePerMinute != null) {
    const drop = snapshot.peakScorePerMinute - snapshot.scorePerMinute;
    if (snapshot.peakScorePerMinute > 0 && drop / snapshot.peakScorePerMinute > 0.12) {
      tips.push({
        id: "pace-fade",
        level: "tip",
        title: "Late-Run Pace Fade",
        detail: "SPM faded more than 12% from peak. Add a controlled reset breath every 10-15s to stabilize tempo.",
      });
    }
  }

  if (tips.length === 0) {
    tips.push({
      id: "baseline",
      level: "good",
      title: "Stable Run",
      detail: "No major weak signal detected in this snapshot. Keep scenario difficulty progressing to avoid plateau.",
    });
  }

  return tips.slice(0, 3);
}

function buildRunSnapshot(
  session: SessionResult,
  metricsRef: MutableRefObject<MutableRunMetrics>,
  peakSpmRef: MutableRefObject<number | null>,
  peakKpsRef: MutableRefObject<number | null>,
  countsRef: MutableRefObject<MutableRunCounts>,
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
  };

  return {
    ...snapshotBase,
    tips: buildRunTips(snapshotBase),
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
  const runStartedAtMs = useRef<number>(0);

  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const dismissedAt = useRef<number>(0);

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
  };

  const dismiss = () => {
    stopTimers();
    setSummary(null);
    setDismissProgress(0);
  };

  useEffect(() => {
    const unlistenMetrics = listen<MouseMetrics>("mouse-metrics", (e) => {
      latestMetrics.current = e.payload;
    });

    const unlistenStats = listen<StatsPanelReading>("stats-panel-update", (e) => {
      latestStatsPanel.current = e.payload;
    });

    const unlistenBridgeMetric = listen<BridgeMetricEvent>("bridge-metric", (e) => {
      const payload = e.payload;
      const ev = String(payload?.ev ?? "");
      if (!ev) return;
      const value = isFiniteNumber(payload?.value) ? payload.value : null;
      const delta = isFiniteNumber(payload?.delta) ? payload.delta : null;
      const total = isFiniteNumber(payload?.total) ? payload.total : null;

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
    });

    const unlistenComplete = listen<SessionResult>("session-complete", (e) => {
      stopTimers();
      const runSnapshot = buildRunSnapshot(
        e.payload,
        runMetrics,
        runPeakSpm,
        runPeakKps,
        runCounts,
        runStartedAtMs.current,
      );
      setSummary({
        session: e.payload,
        metrics: latestMetrics.current,
        statsPanel: latestStatsPanel.current,
        runSnapshot,
      });
      setDismissProgress(0);

      latestMetrics.current = null;
      latestStatsPanel.current = null;
      runStartedAtMs.current = 0;
      resetRunSnapshotRefs();

      dismissedAt.current = Date.now();
      dismissTimer.current = setTimeout(dismiss, AUTO_DISMISS_MS);
      progressInterval.current = setInterval(() => {
        const elapsed = Date.now() - dismissedAt.current;
        setDismissProgress(Math.min(elapsed / AUTO_DISMISS_MS, 1));
      }, 200);
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
      stopTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { summary, dismiss, dismissProgress };
}
