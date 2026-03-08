import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  PersistedStatsPanelSnapshot,
  SessionCompletePayload,
  SessionResult,
  StatsPanelReading,
} from "../types/overlay";
import type { BridgeRunSnapshot, MouseMetrics } from "../types/mouse";

export interface RunCoachingTip {
  id: string;
  level: "good" | "tip" | "warning";
  title: string;
  detail: string;
  windowStartSec?: number | null;
  windowEndSec?: number | null;
}

export interface RunTimelinePoint {
  tSec: number;
  scorePerMinute: number | null;
  killsPerSecond: number | null;
  accuracyPct: number | null;
  damageEfficiency: number | null;
  scoreTotal: number | null;
  scoreTotalDerived: number | null;
  kills: number | null;
  shotsFired: number | null;
  shotsHit: number | null;
}

export interface RunMomentInsight {
  id: string;
  level: "good" | "tip" | "warning";
  title: string;
  detail: string;
  metric: "spm" | "accuracy" | "kps" | "damage_eff";
  startSec: number;
  endSec: number;
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
  timeline: RunTimelinePoint[];
  keyMoments: RunMomentInsight[];
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
const MAX_TIMELINE_POINTS = 1_200;

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

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, val) => sum + val, 0) / values.length;
}

function valuesInRange(
  points: RunTimelinePoint[],
  startSec: number,
  endSec: number,
  pick: (point: RunTimelinePoint) => number | null,
): number[] {
  return points
    .filter((point) => point.tSec >= startSec && point.tSec <= endSec)
    .map(pick)
    .filter((val): val is number => val != null && Number.isFinite(val));
}

interface RunWindowShotStats {
  shotsFired: number;
  shotsHit: number;
  hitRatePct: number;
  shotsPerHit: number;
}

function shotStatsInRange(
  points: RunTimelinePoint[],
  startSec: number,
  endSec: number,
): RunWindowShotStats | null {
  const window = points.filter((point) => point.tSec >= startSec && point.tSec <= endSec);
  if (window.length < 2) return null;

  const firedVals = window
    .map((point) => point.shotsFired)
    .filter((val): val is number => val != null && Number.isFinite(val));
  const hitVals = window
    .map((point) => point.shotsHit)
    .filter((val): val is number => val != null && Number.isFinite(val));

  if (firedVals.length < 2 || hitVals.length < 2) return null;

  const shotsFired = Math.max(0, Math.max(...firedVals) - Math.min(...firedVals));
  const shotsHit = Math.max(0, Math.max(...hitVals) - Math.min(...hitVals));
  if (shotsFired < 6) return null;

  const hitRatePct = shotsFired > 0 ? (shotsHit / shotsFired) * 100 : 0;
  const shotsPerHit = shotsHit > 0 ? shotsFired / shotsHit : shotsFired;

  return {
    shotsFired,
    shotsHit,
    hitRatePct,
    shotsPerHit,
  };
}

function buildRunMomentInsights(points: RunTimelinePoint[], durationSecs: number | null): RunMomentInsight[] {
  if (points.length < 4) return [];
  const totalSecs = Math.max(
    1,
    Math.round(durationSecs ?? points[points.length - 1]?.tSec ?? points.length),
  );

  const earlyStart = 0;
  const earlyEnd = Math.max(1, Math.floor(totalSecs / 3));
  const lateStart = Math.max(0, Math.floor((totalSecs * 2) / 3));
  const lateEnd = totalSecs;

  const earlySpm = avg(valuesInRange(points, earlyStart, earlyEnd, (p) => p.scorePerMinute));
  const lateSpm = avg(valuesInRange(points, lateStart, lateEnd, (p) => p.scorePerMinute));

  const earlyAcc = avg(valuesInRange(points, earlyStart, earlyEnd, (p) => p.accuracyPct));
  const lateAcc = avg(valuesInRange(points, lateStart, lateEnd, (p) => p.accuracyPct));
  const earlyShotStats = shotStatsInRange(points, earlyStart, earlyEnd);
  const lateShotStats = shotStatsInRange(points, lateStart, lateEnd);

  const midStart = earlyEnd;
  const midEnd = Math.max(midStart + 1, lateStart);
  const thirds = [
    { label: "opening", startSec: earlyStart, endSec: earlyEnd },
    { label: "mid-run", startSec: midStart, endSec: midEnd },
    { label: "closing", startSec: lateStart, endSec: lateEnd },
  ]
    .map((window) => ({
      ...window,
      stats: shotStatsInRange(points, window.startSec, window.endSec),
    }))
    .filter((window) => window.stats != null) as Array<{
    label: string;
    startSec: number;
    endSec: number;
    stats: RunWindowShotStats;
  }>;

  const peakSpmPoint = points
    .filter((p) => p.scorePerMinute != null)
    .reduce<RunTimelinePoint | null>((best, curr) => {
      if (curr.scorePerMinute == null) return best;
      if (!best || best.scorePerMinute == null) return curr;
      return curr.scorePerMinute > best.scorePerMinute ? curr : best;
    }, null);

  const minAccPoint = points
    .filter((p) => p.accuracyPct != null)
    .reduce<RunTimelinePoint | null>((worst, curr) => {
      if (curr.accuracyPct == null) return worst;
      if (!worst || worst.accuracyPct == null) return curr;
      return curr.accuracyPct < worst.accuracyPct ? curr : worst;
    }, null);

  const moments: RunMomentInsight[] = [];

  if (
    earlySpm != null
    && lateSpm != null
    && earlySpm > 0
    && (earlySpm - lateSpm) / earlySpm > 0.12
  ) {
    const accDelta =
      earlyAcc != null && lateAcc != null
        ? lateAcc - earlyAcc
        : null;
    const improvedAccuracy = accDelta != null && accDelta >= 2.5;

    moments.push({
      id: "moment-late-spm-fade",
      level: improvedAccuracy ? "tip" : "warning",
      title: improvedAccuracy ? "Speed→Accuracy Trade-off Late" : "Late-Run Pace Drop",
      detail: improvedAccuracy
        ? `Pace fell from ${Math.round(earlySpm)} to ${Math.round(lateSpm)} SPM while accuracy improved by ${accDelta!.toFixed(1)}%. Keep this control but add pace back gradually.`
        : `Pace fell from ${Math.round(earlySpm)} to ${Math.round(lateSpm)} SPM in the final third without a meaningful accuracy gain.`,
      metric: "spm",
      startSec: lateStart,
      endSec: lateEnd,
    });
  }

  if (
    earlyAcc != null
    && lateAcc != null
    && lateAcc - earlyAcc >= 3
  ) {
    moments.push({
      id: "moment-accuracy-build",
      level: "good",
      title: "Accuracy Stabilized",
      detail:
        earlyShotStats && lateShotStats
          ? `Accuracy improved from ${earlyAcc.toFixed(1)}% to ${lateAcc.toFixed(1)}%, and shots-per-hit improved ${earlyShotStats.shotsPerHit.toFixed(2)} → ${lateShotStats.shotsPerHit.toFixed(2)}.`
          : `Accuracy improved from ${earlyAcc.toFixed(1)}% early to ${lateAcc.toFixed(1)}% late.`,
      metric: "accuracy",
      startSec: lateStart,
      endSec: lateEnd,
    });
  }

  if (thirds.length > 0) {
    const worstCorrectionWindow = [...thirds]
      .sort((a, b) => b.stats.shotsPerHit - a.stats.shotsPerHit)[0];

    if (worstCorrectionWindow.stats.shotsPerHit >= 1.6) {
      moments.push({
        id: "moment-correction-window",
        level: worstCorrectionWindow.stats.shotsPerHit >= 2.0 ? "warning" : "tip",
        title: "Correction-Heavy Window",
        detail: `${worstCorrectionWindow.label} needed ${worstCorrectionWindow.stats.shotsPerHit.toFixed(2)} shots per hit (${worstCorrectionWindow.stats.hitRatePct.toFixed(0)}% hit conversion).`,
        metric: "damage_eff",
        startSec: worstCorrectionWindow.startSec,
        endSec: worstCorrectionWindow.endSec,
      });
    }
  }

  if (peakSpmPoint?.scorePerMinute != null) {
    moments.push({
      id: "moment-peak-spm",
      level: "good",
      title: "Peak Tempo Window",
      detail:
        peakSpmPoint.accuracyPct != null
          ? `Best pace reached ${Math.round(peakSpmPoint.scorePerMinute)} SPM at ${Math.round(peakSpmPoint.tSec)}s with ${peakSpmPoint.accuracyPct.toFixed(1)}% accuracy.`
          : `Best pace reached ${Math.round(peakSpmPoint.scorePerMinute)} SPM at ${Math.round(peakSpmPoint.tSec)}s.`,
      metric: "spm",
      startSec: Math.max(0, peakSpmPoint.tSec - 4),
      endSec: Math.min(totalSecs, peakSpmPoint.tSec + 4),
    });
  }

  if (minAccPoint?.accuracyPct != null && minAccPoint.accuracyPct < 78) {
    moments.push({
      id: "moment-low-accuracy",
      level: "tip",
      title: "Low Accuracy Pocket",
      detail: `Lowest point reached ${minAccPoint.accuracyPct.toFixed(1)}% accuracy around ${Math.round(minAccPoint.tSec)}s.`,
      metric: "accuracy",
      startSec: Math.max(0, minAccPoint.tSec - 4),
      endSec: Math.min(totalSecs, minAccPoint.tSec + 4),
    });
  }

  const levelRank: Record<RunMomentInsight["level"], number> = {
    warning: 0,
    tip: 1,
    good: 2,
  };

  return moments
    .sort((a, b) => levelRank[a.level] - levelRank[b.level])
    .slice(0, 3);
}

function buildRunTips(
  snapshot: Omit<ScenarioRunSnapshot, "tips">,
  keyMoments: RunMomentInsight[],
): RunCoachingTip[] {
  const tips: RunCoachingTip[] = [];
  const pushUnique = (tip: RunCoachingTip) => {
    if (tips.some((existing) => existing.id === tip.id)) return;
    tips.push(tip);
  };

  for (const moment of keyMoments.slice(0, 2)) {
    pushUnique({
      id: `moment-${moment.id}`,
      level: moment.level,
      title: moment.title,
      detail: moment.detail,
      windowStartSec: moment.startSec,
      windowEndSec: moment.endSec,
    });
  }

  if (snapshot.shotsFired != null && snapshot.shotsFired >= 20 && snapshot.shotsHit != null) {
    const shotsPerHit = snapshot.shotsHit > 0
      ? snapshot.shotsFired / snapshot.shotsHit
      : snapshot.shotsFired;

    if (shotsPerHit >= 1.7) {
      pushUnique({
        id: "shot-correction-high",
        level: "warning",
        title: "High Correction Load",
        detail: `Run averaged ${shotsPerHit.toFixed(2)} shots per hit. Use 5–8 minute blocks at ~90% speed and prioritize first-shot placement before speeding up.`,
      });
    } else if (shotsPerHit <= 1.2) {
      pushUnique({
        id: "shot-correction-good",
        level: "good",
        title: "Clean Shot Conversion",
        detail: `Run averaged ${shotsPerHit.toFixed(2)} shots per hit. Keep this conversion and increase pace in small steps (about 3–5% per block).`,
      });
    }
  }

  if (snapshot.accuracyPct != null) {
    if (snapshot.accuracyPct < 75) {
      pushUnique({
        id: "acc-low",
        level: "warning",
        title: "Accuracy Below Baseline",
        detail: "Accuracy is below 75%. Reduce speed slightly and lock in clean first-shot confirms before pushing tempo.",
      });
    } else if (snapshot.accuracyPct >= 92) {
      pushUnique({
        id: "acc-strong",
        level: "good",
        title: "Strong Accuracy",
        detail: "Accuracy is stable. Increase pace in small increments while keeping shot conversion steady.",
      });
    }
  }

  if (snapshot.damageEfficiency != null && snapshot.damageEfficiency < 85) {
    pushUnique({
      id: "dmg-eff",
      level: "tip",
      title: "Damage Conversion",
      detail: "Damage efficiency is below 85%. Focus on cleaner target confirmation before firing to reduce low-value hits and misses.",
    });
  }

  if (snapshot.killsPerSecond != null && snapshot.accuracyPct != null) {
    if (snapshot.killsPerSecond < 0.75 && snapshot.accuracyPct >= 88) {
      pushUnique({
        id: "speed-gap",
        level: "tip",
        title: "Speed Ceiling",
        detail: "Precision is strong but kill pace is limited. Add short target-switch blocks and pre-plan your next target during confirms.",
      });
    }
  }

  if (snapshot.scorePerMinute != null && snapshot.peakScorePerMinute != null) {
    const drop = snapshot.peakScorePerMinute - snapshot.scorePerMinute;
    if (snapshot.peakScorePerMinute > 0 && drop / snapshot.peakScorePerMinute > 0.12) {
      pushUnique({
        id: "pace-fade",
        level: "tip",
        title: "Late-Run Pace Fade",
        detail: "SPM faded more than 12% from peak. Add a brief reset cue every 10–15s to stabilize tempo.",
      });
    }
  }

  if (tips.length < 3 && keyMoments.length > 2) {
    const remainingMoment = keyMoments[2];
    pushUnique({
      id: `moment-${remainingMoment.id}`,
      level: remainingMoment.level,
      title: remainingMoment.title,
      detail: remainingMoment.detail,
      windowStartSec: remainingMoment.startSec,
      windowEndSec: remainingMoment.endSec,
    });
  }

  if (tips.length === 0) {
    pushUnique({
      id: "baseline",
      level: "good",
      title: "Stable Run",
      detail: "No major weak signal detected. Keep training deliberate: one focus metric per block, then increase difficulty gradually.",
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
    ),
  };

  return {
    ...snapshotBase,
    tips: buildRunTips(snapshotBase, snapshotBase.keyMoments),
  };
}

function buildRunSnapshotFromBridge(
  session: SessionResult,
  snapshot: BridgeRunSnapshot,
): ScenarioRunSnapshot {
  const timeline: RunTimelinePoint[] = (snapshot.timeline ?? []).map((point) => ({
    tSec: point.t_sec,
    scorePerMinute: point.score_per_minute,
    killsPerSecond: point.kills_per_second,
    accuracyPct: point.accuracy_pct,
    damageEfficiency: point.damage_efficiency,
    scoreTotal: point.score_total,
    scoreTotalDerived: point.score_total_derived,
    kills: point.kills,
    shotsFired: point.shots_fired,
    shotsHit: point.shots_hit,
  }));

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
    ),
  };

  return {
    ...snapshotBase,
    tips: buildRunTips(snapshotBase, snapshotBase.keyMoments),
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
