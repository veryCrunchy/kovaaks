import type {
  BridgeRunTimelinePoint,
  BridgeShotTelemetryEvent,
  BridgeTickStreamV1,
  RawPositionPoint,
} from "../types/mouse";

export interface DrillRecommendation {
  label: string;
  query: string;
}

export interface CoachingCardData {
  id: string;
  source: "global" | "scenario";
  title: string;
  badge: string;
  badgeColor: string;
  body: string;
  tip: string;
  drills?: DrillRecommendation[];
  confidence?: number;
  signals?: string[];
}

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

export function normalizeAccuracyPct(
  value: number | null | undefined,
  shotsHit?: number | null,
  shotsFired?: number | null,
): number | null {
  if (
    Number.isFinite(shotsHit)
    && Number.isFinite(shotsFired)
    && (shotsHit as number) >= 0
    && (shotsFired as number) > 0
    && (shotsHit as number) <= (shotsFired as number) + 0.0001
  ) {
    return Math.max(0, Math.min(100, ((shotsHit as number) / (shotsFired as number)) * 100));
  }

  if (!Number.isFinite(value) || (value as number) < 0) return null;
  const direct = value as number;
  if (direct <= 1) return Math.max(0, Math.min(100, direct * 100));
  if (direct <= 100) return direct;
  return null;
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

export interface CoachingAnalyticsRecord {
  id: string;
  normalizedScenario: string;
  timestampMs: number;
  duration_secs: number;
  score: number;
  accuracy?: number | null;
  isReliableForAnalysis: boolean;
  stats_panel?: {
    scenario_type?: string | null;
    accuracy_pct?: number | null;
    avg_kps?: number | null;
    avg_ttk_ms?: number | null;
  } | null;
  smoothness?: {
    composite?: number | null;
    jitter?: number | null;
    path_efficiency?: number | null;
    correction_ratio?: number | null;
  } | null;
  shot_timing?: {
    avg_fire_to_hit_ms?: number | null;
    avg_shots_to_hit?: number | null;
    corrective_shot_ratio?: number | null;
  } | null;
}

export interface PracticeProfileSnapshot {
  sessionCount: number;
  activeDays: number;
  spanDays: number;
  daysPerWeek: number;
  sessionsPerActiveDay: number;
  avgBlockRuns: number;
  avgBlockMinutes: number;
  maxBlockMinutes: number;
  scenarioDiversity: number;
  dominantScenario: string;
  dominantScenarioShare: number;
  avgUniqueScenariosPerBlock: number;
  avgScenarioSwitchesPerBlock: number;
  switchRate: number;
  topScenarios: { scenario: string; share: number; count: number }[];
}

export interface GlobalCoachingLearningState {
  sampleCount: number;
  settledSampleCount: number;
  warmupSampleCount: number;
  normalizedVariancePct: number | null;
  warmupTaxPct: number | null;
  avgBlockFadePct: number | null;
  switchPenaltyPct: number | null;
  momentumDeltaPct: number | null;
  retentionAfterGapPct: number | null;
  dominantFamily: string | null;
  dominantFamilySharePct: number | null;
  familyDiversity: number;
}

export interface BehaviorPatternFeatures {
  sampleCount: number;
  settledSampleCount: number;
  warmupConsistencyPct: number | null;
  readinessPct: number | null;
  adaptationPct: number | null;
  endurancePct: number | null;
  transferPct: number | null;
  precisionPct: number | null;
  controlPct: number | null;
  consistencyPct: number | null;
  learningEfficiencyPct: number | null;
  tempoPct: number | null;
  switchResiliencePct: number | null;
  retainedFormPct: number | null;
  fatiguePressurePct: number | null;
  correctionLoadPct: number | null;
  hesitationLoadPct: number | null;
  volatilityPct: number | null;
  momentumPct: number | null;
  precisionTempoBiasPct: number | null;
}

export interface PlayerLearningAxis {
  key: string;
  label: string;
  valuePct: number;
  detail: string;
}

export interface PlayerLearningSignal {
  key: string;
  label: string;
  detail: string;
  valuePct: number | null;
}

export interface PlayerLearningProfile {
  generatedAtMs: number;
  sampleCount: number;
  settledSampleCount: number;
  coverageStartMs: number | null;
  coverageEndMs: number | null;
  summary: string;
  focusAreaKey: string | null;
  focusAreaLabel: string | null;
  dominantConstraintKey: string | null;
  strengths: PlayerLearningSignal[];
  constraints: PlayerLearningSignal[];
  axes: PlayerLearningAxis[];
  metrics: Record<string, number | null>;
}

export interface PersistedCoachingStateSnapshot {
  snapshotKind: string;
  updatedAtUnixMs: number;
  sampleCount: number;
  settledSampleCount: number;
  coverageStartUnixMs: number | null;
  coverageEndUnixMs: number | null;
  summaryJson: Record<string, unknown>;
}

export interface CoachingRecommendationEvaluation {
  evaluationId: string;
  snapshotKind: string;
  recommendationId: string;
  recommendationTitle: string;
  signalKey: string;
  status: "pending" | "improved" | "flat" | "regressed";
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  anchorSampleCount: number;
  latestSampleCount: number;
  anchorMetricValue: number | null;
  latestMetricValue: number | null;
  outcomeDelta: number | null;
  contextJson: Record<string, unknown>;
}

export interface CoachingUserPreferences {
  focusArea: "balanced" | "precision" | "speed" | "control" | "consistency" | "endurance" | "transfer";
  challengePreference: "steady" | "balanced" | "aggressive";
  timePreference: "next_session" | "this_week" | "long_term";
}

export interface CoachingUserFeedbackRecord {
  snapshotKind: string;
  recommendationId: string;
  signalKey?: string | null;
  feedback: "helpful" | "trying" | "not_now" | "not_for_me";
  notes?: string | null;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  contextJson: Record<string, unknown>;
}

export interface SessionTargetResponseSnapshot {
  episode_count: number;
  path_change_count: number;
  target_switch_count: number;
  avg_reaction_time_ms: number | null;
  p90_reaction_time_ms: number | null;
  avg_pre_slowdown_reaction_ms: number | null;
  avg_recovery_time_ms: number | null;
  p90_recovery_time_ms: number | null;
  avg_path_change_reaction_ms: number | null;
  avg_target_switch_reaction_ms: number | null;
  avg_trigger_magnitude_deg: number | null;
  avg_peak_yaw_error_deg: number | null;
  stable_response_ratio: number | null;
}

export interface TargetResponseEpisode {
  id: string;
  kind: "path_change" | "target_switch";
  startMs: number;
  endMs: number;
  targetId: string;
  targetLabel: string;
  triggerMagnitudeDeg: number | null;
  peakYawErrorDeg: number | null;
  reactionTimeMs: number | null;
  preSlowdownReactionMs: number | null;
  recoveryTimeMs: number | null;
  stableResponse: boolean;
}

export interface TargetResponseAnalysis {
  episodeCount: number;
  responseCoveragePct: number | null;
  summary: SessionTargetResponseSnapshot;
  episodes: TargetResponseEpisode[];
}

export interface CoachingPersonalizationInput {
  preferences?: CoachingUserPreferences | null;
  feedback?: CoachingUserFeedbackRecord[] | null;
  snapshotKind?: string | null;
}

interface ScenarioScoreBaseline {
  medianScore: number;
  sessionCount: number;
  scenarioType: string;
}

interface NormalizedSessionSignal {
  record: CoachingAnalyticsRecord;
  normalizedScore: number;
  baseline: ScenarioScoreBaseline;
}

interface FamilyContrastPlan {
  label: string;
  drills: DrillRecommendation[];
}

interface PlayBlock<T extends CoachingAnalyticsRecord = CoachingAnalyticsRecord> {
  sessions: T[];
  gapBeforeMs: number | null;
}

interface RunWindowShotStats {
  shotsFired: number;
  shotsHit: number;
  hitRatePct: number;
  shotsPerHit: number;
}

const BLOCK_GAP_MS = 6 * 60 * 60 * 1000;

interface ReplayTickEntityState {
  id: string;
  profile: string;
  isPlayer: boolean;
  isBot: boolean;
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  roll: number;
  vx: number;
  vy: number;
  vz: number;
}

interface ReplayTickFrameCommand {
  tsMs: number;
  seq: number;
  upserts: ReplayTickEntityState[];
  removes: string[];
}

interface TargetResponseFrame {
  tsMs: number;
  player: ReplayTickEntityState;
  target: ReplayTickEntityState;
  distance2d: number;
  aimErrorDeg: number | null;
}

interface CursorMotionSample {
  tMs: number;
  dtMs: number;
  dx: number;
  dy: number;
  speed: number;
  headingDeg: number | null;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function percentileOf(sortedValues: number[], p: number): number {
  if (!sortedValues.length) return 0;
  const index = Math.max(0, Math.ceil((sortedValues.length * p) / 100) - 1);
  return sortedValues[index];
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function meanDefined(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => value != null && Number.isFinite(value));
  return filtered.length > 0 ? mean(filtered) : null;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((sorted.length * p) / 100) - 1));
  return sorted[index] ?? null;
}

function safeMean(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => value != null && Number.isFinite(value));
  return filtered.length > 0 ? mean(filtered) : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolish(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value >= 0.5;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "1" || trimmed === "true") return true;
    if (trimmed === "0" || trimmed === "false") return false;
  }
  return null;
}

function normalizeAngleDeg(value: number): number {
  let normalized = value % 360;
  if (normalized <= -180) normalized += 360;
  if (normalized > 180) normalized -= 360;
  return normalized;
}

function angleDiffDeg(a: number, b: number): number {
  return Math.abs(normalizeAngleDeg(a - b));
}

function vectorHeadingDeg(dx: number, dy: number): number | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) return null;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

function distance2d(x0: number, y0: number, x1: number, y1: number): number {
  return Math.hypot(x1 - x0, y1 - y0);
}

function meanHeadingDeg(samples: CursorMotionSample[]): number | null {
  const weighted = samples.filter((sample) => sample.headingDeg != null && Number.isFinite(sample.speed));
  if (weighted.length === 0) return null;
  let sumX = 0;
  let sumY = 0;
  for (const sample of weighted) {
    const radians = ((sample.headingDeg ?? 0) * Math.PI) / 180;
    const weight = Math.max(sample.speed, 1);
    sumX += Math.cos(radians) * weight;
    sumY += Math.sin(radians) * weight;
  }
  if (Math.abs(sumX) < 0.0001 && Math.abs(sumY) < 0.0001) return null;
  return (Math.atan2(sumY, sumX) * 180) / Math.PI;
}

function familyBalanceScore(dominantFamilySharePct: number | null | undefined, diversity: number | null | undefined): number | null {
  if (!Number.isFinite(dominantFamilySharePct)) return null;
  const share = dominantFamilySharePct as number;
  const diversityBoost = Number.isFinite(diversity) ? clampNumber(((diversity as number) - 2) * 8, 0, 20) : 0;
  return clampNumber(100 - Math.max(0, share - 35) * 1.4 + diversityBoost, 0, 100);
}

function describeAxis(key: string, valuePct: number): string {
  switch (key) {
    case "readiness":
      return valuePct >= 60
        ? "You settle into useful reps quickly instead of donating many runs to warm-up."
        : "Opening runs are still paying a noticeable readiness tax before quality stabilizes.";
    case "adaptation":
      return valuePct >= 60
        ? "Your form travels reasonably well when the task changes."
        : "Context changes are still expensive and cost you quality after switches.";
    case "endurance":
      return valuePct >= 60
        ? "You hold useful quality deep enough into blocks to train with intent."
        : "Late-block quality is fading before the work is really finished.";
    case "transfer":
      return valuePct >= 60
        ? "Recent practice is giving you carryover beyond one favorite scenario."
        : "Practice is still a bit too narrow or too reset-heavy to maximize carryover.";
    case "precision":
      return valuePct >= 60
        ? "Hit quality and shot conversion are a reliable asset."
        : "Accuracy and shot conversion are leaking too much value.";
    case "control":
      return valuePct >= 60
        ? "Your movement foundation is supporting cleaner reps."
        : "Cursor control and correction load are still asking for cleanup.";
    case "consistency":
      return valuePct >= 60
        ? "Execution is fairly stable once a block settles."
        : "Performance swings are still wider than your underlying skill should require.";
    case "learning":
      return valuePct >= 60
        ? "Recent practice is converting into sticky, reusable progress."
        : "Volume is not yet turning into retained progress efficiently enough.";
    default:
      return valuePct >= 60 ? "This is currently helping your overall progress." : "This is currently limiting your overall progress.";
  }
}

function cardSignals(card: CoachingCardData): string[] {
  return card.signals ?? [];
}

function hasAnySignal(card: CoachingCardData, candidates: string[]): boolean {
  const signals = cardSignals(card);
  return candidates.some((candidate) => signals.includes(candidate));
}

function preferenceWeight(card: CoachingCardData, preferences: CoachingUserPreferences | null | undefined): number {
  if (!preferences) return 0;
  let weight = 0;

  switch (preferences.focusArea) {
    case "precision":
      if (hasAnySignal(card, ["correction_load", "precision_balance", "hesitation_load"])) weight += 4;
      break;
    case "speed":
      if (hasAnySignal(card, ["hesitation_load", "momentum", "cross_scenario_transfer", "precision_balance"])) weight += 4;
      break;
    case "control":
      if (hasAnySignal(card, ["control_foundation", "correction_load", "execution_consistency"])) weight += 4;
      break;
    case "consistency":
      if (hasAnySignal(card, ["normalized_variance", "warmup_tax", "practice_spacing", "block_fade"])) weight += 4;
      break;
    case "endurance":
      if (hasAnySignal(card, ["block_fade", "fatigue_pattern", "practice_spacing", "endurance_strength"])) weight += 4;
      break;
    case "transfer":
      if (hasAnySignal(card, ["family_balance", "switch_penalty", "retention_after_gap", "cross_scenario_transfer"])) weight += 4;
      break;
    default:
      break;
  }

  switch (preferences.challengePreference) {
    case "steady":
      if (hasAnySignal(card, ["warmup_tax", "correction_load", "normalized_variance", "practice_spacing"])) weight += 2;
      if (hasAnySignal(card, ["momentum", "cross_scenario_transfer"]) && !hasAnySignal(card, ["global_form_drop"])) weight -= 1;
      break;
    case "aggressive":
      if (hasAnySignal(card, ["momentum", "cross_scenario_transfer", "precision_balance", "context_adaptation"])) weight += 2;
      if (hasAnySignal(card, ["practice_spacing", "warmup_tax"])) weight -= 1;
      break;
    default:
      break;
  }

  switch (preferences.timePreference) {
    case "next_session":
      if (hasAnySignal(card, ["warmup_tax", "correction_load", "hesitation_load", "switch_penalty"])) weight += 2;
      break;
    case "long_term":
      if (hasAnySignal(card, ["retention_after_gap", "family_balance", "practice_spacing", "cross_scenario_transfer"])) weight += 2;
      break;
    default:
      if (hasAnySignal(card, ["block_fade", "momentum", "practice_spacing"])) weight += 1;
      break;
  }

  return weight;
}

function feedbackWeight(
  card: CoachingCardData,
  feedbackRows: CoachingUserFeedbackRecord[] | null | undefined,
  snapshotKind: string | null | undefined,
): number {
  if (!feedbackRows || feedbackRows.length === 0) return 0;
  const relevant = feedbackRows.filter((row) => !snapshotKind || row.snapshotKind === snapshotKind);
  if (relevant.length === 0) return 0;

  let weight = 0;
  const signals = new Set(cardSignals(card));
  for (const row of relevant) {
    const sameRecommendation = row.recommendationId === card.id;
    const sameSignal = row.signalKey != null && signals.has(row.signalKey);
    if (!sameRecommendation && !sameSignal) continue;
    switch (row.feedback) {
      case "helpful":
        weight += sameRecommendation ? -1 : 2;
        break;
      case "trying":
        weight += sameRecommendation ? 4 : 1;
        break;
      case "not_now":
        weight += sameRecommendation ? -3 : -1;
        break;
      case "not_for_me":
        weight += sameRecommendation ? -10 : -5;
        break;
      default:
        break;
    }
  }
  return weight;
}

function scenarioFamilyLabel(scenarioType: string): string {
  switch (scenarioType) {
    case "PureTracking":
    case "Tracking":
      return "Tracking";
    case "TargetSwitching":
    case "MultiHitClicking":
      return "Target Switching";
    case "StaticClicking":
    case "OneShotClicking":
      return "Static Clicking";
    case "DynamicClicking":
    case "MovingClicking":
    case "ReactiveClicking":
      return "Dynamic Clicking";
    case "AccuracyDrill":
      return "Accuracy";
    default:
      return scenarioType || "Unknown";
  }
}

function isTrackingScenario(scenarioType: string | null | undefined): boolean {
  if (!scenarioType) return false;
  return scenarioType === "PureTracking" || scenarioType.includes("Tracking");
}

function isTargetSwitchingScenario(scenarioType: string | null | undefined): boolean {
  return scenarioType === "TargetSwitching" || scenarioType === "MultiHitClicking";
}

function isStaticClickingScenario(scenarioType: string | null | undefined): boolean {
  return scenarioType === "StaticClicking" || scenarioType === "OneShotClicking";
}

function isDynamicClickingScenario(scenarioType: string | null | undefined): boolean {
  return scenarioType === "DynamicClicking" || scenarioType === "MovingClicking" || scenarioType === "ReactiveClicking";
}

function isAccuracyScenario(scenarioType: string | null | undefined): boolean {
  return scenarioType === "AccuracyDrill";
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
    .filter((value): value is number => value != null && Number.isFinite(value));
}

function shotStatsInRange(
  points: RunTimelinePoint[],
  startSec: number,
  endSec: number,
): RunWindowShotStats | null {
  const window = points.filter((point) => point.tSec >= startSec && point.tSec <= endSec);
  if (window.length < 2) return null;

  const firedValues = window
    .map((point) => point.shotsFired)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const hitValues = window
    .map((point) => point.shotsHit)
    .filter((value): value is number => value != null && Number.isFinite(value));

  if (firedValues.length < 2 || hitValues.length < 2) return null;

  const shotsFired = Math.max(0, Math.max(...firedValues) - Math.min(...firedValues));
  const shotsHit = Math.max(0, Math.max(...hitValues) - Math.min(...hitValues));
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

function buildScenarioScoreBaselines(
  records: CoachingAnalyticsRecord[],
): Map<string, ScenarioScoreBaseline> {
  const grouped = new Map<string, {
    scores: number[];
    scenarioTypeCounts: Map<string, number>;
  }>();

  for (const record of records) {
    if (!record.isReliableForAnalysis || !Number.isFinite(record.score) || record.score <= 0) continue;
    const entry = grouped.get(record.normalizedScenario) ?? {
      scores: [],
      scenarioTypeCounts: new Map<string, number>(),
    };
    entry.scores.push(record.score);
    const scenarioType = record.stats_panel?.scenario_type?.trim();
    if (scenarioType && scenarioType !== "Unknown") {
      entry.scenarioTypeCounts.set(
        scenarioType,
        (entry.scenarioTypeCounts.get(scenarioType) ?? 0) + 1,
      );
    }
    grouped.set(record.normalizedScenario, entry);
  }

  const baselines = new Map<string, ScenarioScoreBaseline>();
  for (const [scenario, entry] of grouped.entries()) {
    if (entry.scores.length < 3) continue;
    const sortedScores = [...entry.scores].sort((a, b) => a - b);
    const scenarioType =
      [...entry.scenarioTypeCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
      ?? "Unknown";
    baselines.set(scenario, {
      medianScore: percentileOf(sortedScores, 50),
      sessionCount: entry.scores.length,
      scenarioType,
    });
  }

  return baselines;
}

function buildNormalizedSessionSignals(records: CoachingAnalyticsRecord[]): NormalizedSessionSignal[] {
  const baselines = buildScenarioScoreBaselines(records);
  return records
    .filter((record) => record.isReliableForAnalysis)
    .map((record) => {
      const baseline = baselines.get(record.normalizedScenario);
      if (!baseline || baseline.medianScore <= 0) return null;
      const normalizedScore = record.score / baseline.medianScore;
      if (!Number.isFinite(normalizedScore) || normalizedScore <= 0) return null;
      return {
        record,
        normalizedScore: clampNumber(normalizedScore, 0.2, 3),
        baseline,
      };
    })
    .filter((entry): entry is NormalizedSessionSignal => entry != null);
}

function groupIntoPlayBlocks<T extends CoachingAnalyticsRecord>(sorted: T[]): PlayBlock<T>[] {
  if (sorted.length === 0) return [];
  const blocks: PlayBlock<T>[] = [];
  let current: T[] = [sorted[0]];
  let blockGap: number | null = null;

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1].timestampMs;
    const next = sorted[index].timestampMs;
    const gap = next - previous;
    if (gap > BLOCK_GAP_MS) {
      blocks.push({ sessions: current, gapBeforeMs: blockGap });
      blockGap = gap;
      current = [sorted[index]];
    } else {
      current.push(sorted[index]);
    }
  }

  blocks.push({ sessions: current, gapBeforeMs: blockGap });
  return blocks;
}

function contrastPlanForScenarioFamily(scenarioType: string): FamilyContrastPlan {
  if (isTrackingScenario(scenarioType)) {
    return {
      label: "dynamic clicking or target switching",
      drills: [
        { label: "Pasu", query: "Pasu" },
        { label: "1w4ts", query: "1w4ts" },
        { label: "Floating Heads", query: "Floating Heads" },
      ],
    };
  }
  if (
    isStaticClickingScenario(scenarioType)
    || isDynamicClickingScenario(scenarioType)
    || isTargetSwitchingScenario(scenarioType)
  ) {
    return {
      label: "smooth tracking",
      drills: [
        { label: "Smoothbot", query: "Smoothbot" },
        { label: "Air", query: "Air" },
        { label: "Centering", query: "Centering" },
      ],
    };
  }
  if (isAccuracyScenario(scenarioType)) {
    return {
      label: "reactive clicking",
      drills: [
        { label: "Microshot", query: "Microshot" },
        { label: "Tile Frenzy", query: "Tile Frenzy" },
        { label: "1wall 6targets", query: "1wall 6targets" },
      ],
    };
  }
  return {
    label: "a contrast family",
    drills: [
      { label: "Smoothbot", query: "Smoothbot" },
      { label: "Pasu", query: "Pasu" },
      { label: "Microshot", query: "Microshot" },
    ],
  };
}

export function normalizeBridgeRunTimeline(points: BridgeRunTimelinePoint[]): RunTimelinePoint[] {
  return points.map((point) => ({
    tSec: point.t_sec,
    scorePerMinute: point.score_per_minute,
    killsPerSecond: point.kills_per_second,
    accuracyPct: normalizeAccuracyPct(point.accuracy_pct, point.shots_hit, point.shots_fired),
    damageEfficiency: point.damage_efficiency,
    scoreTotal: point.score_total,
    scoreTotalDerived: point.score_total_derived,
    kills: point.kills,
    shotsFired: point.shots_fired,
    shotsHit: point.shots_hit,
  }));
}

function parseReplayTickEntity(value: unknown): ReplayTickEntityState | null {
  const obj = asObject(value);
  if (!obj) return null;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  if (!id) return null;

  const location = asObject(obj.location);
  const rotation = asObject(obj.rotation);
  if (!location || !rotation) return null;

  const velocity = asObject(obj.velocity);
  return {
    id,
    profile: typeof obj.profile === "string" ? obj.profile.trim() : "",
    isPlayer: readBoolish(obj.is_player) ?? false,
    isBot: readBoolish(obj.is_bot) ?? false,
    x: readNumber(location.x) ?? 0,
    y: readNumber(location.y) ?? 0,
    z: readNumber(location.z) ?? 0,
    pitch: readNumber(rotation.pitch) ?? 0,
    yaw: readNumber(rotation.yaw) ?? 0,
    roll: readNumber(rotation.roll) ?? 0,
    vx: readNumber(velocity?.x) ?? 0,
    vy: readNumber(velocity?.y) ?? 0,
    vz: readNumber(velocity?.z) ?? 0,
  };
}

function parseReplayTickFrameCommand(
  value: unknown,
  entityField: "entities" | "upserts",
  replayBaseTsMs: number,
): ReplayTickFrameCommand | null {
  const obj = asObject(value);
  if (!obj) return null;
  const rawTsMs = readNumber(obj.ts_ms);
  if (rawTsMs == null) return null;
  const rawSeq = readNumber(obj.seq);
  const entries = Array.isArray(obj[entityField]) ? obj[entityField] : [];
  const removes = Array.isArray(obj.remove)
    ? obj.remove
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0)
    : [];

  const upserts = entries
    .map((entry) => parseReplayTickEntity(entry))
    .filter((entry): entry is ReplayTickEntityState => entry != null);

  return {
    tsMs: Math.max(0, Math.round(rawTsMs - replayBaseTsMs)),
    seq: rawSeq != null ? Math.max(0, Math.round(rawSeq)) : Math.max(0, Math.round(rawTsMs - replayBaseTsMs)),
    upserts,
    removes,
  };
}

function buildReplayTickFrames(
  stream: BridgeTickStreamV1 | null | undefined,
  replayBaseTsMs: number,
): TargetResponseFrame[] {
  if (!stream) return [];

  const commands: ReplayTickFrameCommand[] = [];
  for (const value of stream.keyframes ?? []) {
    const command = parseReplayTickFrameCommand(value, "entities", replayBaseTsMs);
    if (command) commands.push(command);
  }
  for (const value of stream.deltas ?? []) {
    const command = parseReplayTickFrameCommand(value, "upserts", replayBaseTsMs);
    if (command) commands.push(command);
  }
  if (commands.length === 0) return [];

  commands.sort((left, right) => left.tsMs - right.tsMs || left.seq - right.seq);
  const activeEntities = new Map<string, ReplayTickEntityState>();
  const frames: TargetResponseFrame[] = [];

  for (const command of commands) {
    for (const entity of command.upserts) activeEntities.set(entity.id, entity);
    for (const id of command.removes) activeEntities.delete(id);

    const entities = [...activeEntities.values()];
    const player = entities.find((entity) => entity.isPlayer) ?? null;
    if (!player) continue;

    const bots = entities.filter((entity) => entity.isBot);
    if (bots.length === 0) continue;

    const nearestTarget = [...bots].sort(
      (left, right) =>
        distance2d(player.x, player.y, left.x, left.y) - distance2d(player.x, player.y, right.x, right.y),
    )[0];
    if (!nearestTarget) continue;

    const distanceToTarget = distance2d(player.x, player.y, nearestTarget.x, nearestTarget.y);
    const targetYaw = vectorHeadingDeg(nearestTarget.x - player.x, nearestTarget.y - player.y);

    frames.push({
      tsMs: command.tsMs,
      player,
      target: nearestTarget,
      distance2d: distanceToTarget,
      aimErrorDeg: targetYaw != null ? angleDiffDeg(player.yaw, targetYaw) : null,
    });
  }

  return frames;
}

function buildCursorMotionSamples(points: RawPositionPoint[]): CursorMotionSample[] {
  if (points.length < 2) return [];
  const ordered = [...points].sort((left, right) => left.timestamp_ms - right.timestamp_ms);
  const samples: CursorMotionSample[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const dtMs = Math.max(1, current.timestamp_ms - previous.timestamp_ms);
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    samples.push({
      tMs: current.timestamp_ms,
      dtMs,
      dx,
      dy,
      speed: (Math.hypot(dx, dy) / dtMs) * 1000,
      headingDeg: vectorHeadingDeg(dx, dy),
    });
  }
  return samples;
}

function motionSamplesInRange(
  samples: CursorMotionSample[],
  startMs: number,
  endMs: number,
): CursorMotionSample[] {
  return samples.filter((sample) => sample.tMs >= startMs && sample.tMs <= endMs);
}

function findReactionTimeMs(
  samples: CursorMotionSample[],
  eventMs: number,
  baselineHeadingDeg: number | null,
  baselineSpeed: number | null,
  triggerMagnitudeDeg: number | null,
): number | null {
  const after = motionSamplesInRange(samples, eventMs + 8, eventMs + 650);
  if (after.length === 0) return null;
  const headingThreshold = clampNumber((triggerMagnitudeDeg ?? 32) * 0.35, 12, 34);
  const speedFloor = baselineSpeed != null ? Math.max(20, baselineSpeed * 0.4) : 20;

  for (const sample of after) {
    const headingDelta = baselineHeadingDeg != null && sample.headingDeg != null
      ? angleDiffDeg(sample.headingDeg, baselineHeadingDeg)
      : null;
    const speedDeltaRatio = baselineSpeed != null && baselineSpeed > 0
      ? Math.abs(sample.speed - baselineSpeed) / baselineSpeed
      : null;
    if (
      (headingDelta != null && headingDelta >= headingThreshold && sample.speed >= speedFloor)
      || (headingDelta != null && headingDelta >= headingThreshold * 0.65 && (speedDeltaRatio ?? 0) >= 0.32)
    ) {
      return Math.max(0, sample.tMs - eventMs);
    }
  }

  return null;
}

function findPreSlowdownReactionMs(
  samples: CursorMotionSample[],
  eventMs: number,
  baselineSpeed: number | null,
): number | null {
  if (baselineSpeed == null || baselineSpeed <= 10) return null;
  const after = motionSamplesInRange(samples, eventMs, eventMs + 500);
  if (after.length === 0) return null;

  for (const sample of after) {
    if (sample.speed <= baselineSpeed * 0.82) {
      return Math.max(0, sample.tMs - eventMs);
    }
  }
  return null;
}

function findRecoveryTimeMs(
  frames: TargetResponseFrame[],
  startIndex: number,
  targetId: string,
  initialAimErrorDeg: number | null,
): number | null {
  const startFrame = frames[startIndex];
  if (!startFrame) return null;
  const thresholdDeg = clampNumber((initialAimErrorDeg ?? 6) * 0.55, 2.2, 10);
  let stableStartMs: number | null = null;
  let stableCount = 0;

  for (let index = startIndex; index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame.tsMs - startFrame.tsMs > 1400) break;
    if (frame.target.id !== targetId) {
      stableStartMs = null;
      stableCount = 0;
      continue;
    }
    if (frame.aimErrorDeg != null && frame.aimErrorDeg <= thresholdDeg) {
      stableStartMs ??= frame.tsMs;
      stableCount += 1;
      if (stableCount >= 2) {
        return Math.max(0, stableStartMs - startFrame.tsMs);
      }
    } else {
      stableStartMs = null;
      stableCount = 0;
    }
  }

  return null;
}

function formatTargetResponseLabel(target: ReplayTickEntityState | null | undefined): string {
  if (!target) return "Nearest bot";
  return target.profile?.trim() || target.id;
}

function snapshotFromEpisodes(episodes: TargetResponseEpisode[]): SessionTargetResponseSnapshot {
  const reactionValues = episodes.map((episode) => episode.reactionTimeMs);
  const recoveryValues = episodes.map((episode) => episode.recoveryTimeMs);
  const pathChangeValues = episodes
    .filter((episode) => episode.kind === "path_change")
    .map((episode) => episode.reactionTimeMs);
  const targetSwitchValues = episodes
    .filter((episode) => episode.kind === "target_switch")
    .map((episode) => episode.reactionTimeMs);
  const stableResponses = episodes.filter((episode) => episode.stableResponse).length;

  return {
    episode_count: episodes.length,
    path_change_count: episodes.filter((episode) => episode.kind === "path_change").length,
    target_switch_count: episodes.filter((episode) => episode.kind === "target_switch").length,
    avg_reaction_time_ms: safeMean(reactionValues),
    p90_reaction_time_ms: percentile(
      reactionValues.filter((value): value is number => value != null && Number.isFinite(value)),
      90,
    ),
    avg_pre_slowdown_reaction_ms: safeMean(episodes.map((episode) => episode.preSlowdownReactionMs)),
    avg_recovery_time_ms: safeMean(recoveryValues),
    p90_recovery_time_ms: percentile(
      recoveryValues.filter((value): value is number => value != null && Number.isFinite(value)),
      90,
    ),
    avg_path_change_reaction_ms: safeMean(pathChangeValues),
    avg_target_switch_reaction_ms: safeMean(targetSwitchValues),
    avg_trigger_magnitude_deg: safeMean(episodes.map((episode) => episode.triggerMagnitudeDeg)),
    avg_peak_yaw_error_deg: safeMean(episodes.map((episode) => episode.peakYawErrorDeg)),
    stable_response_ratio: episodes.length > 0 ? stableResponses / episodes.length : null,
  };
}

export function analyzeTargetResponses(
  positions: RawPositionPoint[],
  shotTelemetry: BridgeShotTelemetryEvent[],
  tickStream: BridgeTickStreamV1 | null | undefined,
  replayBaseTsMs: number,
): TargetResponseAnalysis | null {
  const motionSamples = buildCursorMotionSamples(positions);
  const frames = buildReplayTickFrames(tickStream, replayBaseTsMs);
  if (motionSamples.length < 12 || frames.length < 6) return null;

  const episodes: TargetResponseEpisode[] = [];
  let lastTriggerMs = -Infinity;

  for (let index = 2; index < frames.length; index += 1) {
    const previous2 = frames[index - 2];
    const previous = frames[index - 1];
    const current = frames[index];
    if (current.tsMs - lastTriggerMs < 180) continue;

    let kind: TargetResponseEpisode["kind"] | null = null;
    let triggerMagnitudeDeg: number | null = null;
    let targetId = current.target.id;
    let targetLabel = formatTargetResponseLabel(current.target);

    if (previous.target.id !== current.target.id) {
      kind = "target_switch";
      const previousHeading = vectorHeadingDeg(previous.target.x - previous.player.x, previous.target.y - previous.player.y);
      const currentHeading = vectorHeadingDeg(current.target.x - current.player.x, current.target.y - current.player.y);
      triggerMagnitudeDeg =
        previousHeading != null && currentHeading != null
          ? angleDiffDeg(previousHeading, currentHeading)
          : 90;
    } else if (previous2.target.id === previous.target.id && previous.target.id === current.target.id) {
      const prevVectorX = previous.target.x - previous2.target.x;
      const prevVectorY = previous.target.y - previous2.target.y;
      const nextVectorX = current.target.x - previous.target.x;
      const nextVectorY = current.target.y - previous.target.y;
      const prevHeading = vectorHeadingDeg(prevVectorX, prevVectorY);
      const nextHeading = vectorHeadingDeg(nextVectorX, nextVectorY);
      const prevDistance = Math.hypot(prevVectorX, prevVectorY);
      const nextDistance = Math.hypot(nextVectorX, nextVectorY);
      const prevDtMs = Math.max(1, previous.tsMs - previous2.tsMs);
      const nextDtMs = Math.max(1, current.tsMs - previous.tsMs);
      const prevSpeed = (prevDistance / prevDtMs) * 1000;
      const nextSpeed = (nextDistance / nextDtMs) * 1000;
      const speedChangePct = Math.abs(nextSpeed - prevSpeed) / Math.max(prevSpeed, nextSpeed, 1);
      const headingChangeDeg = prevHeading != null && nextHeading != null ? angleDiffDeg(prevHeading, nextHeading) : 0;

      if (
        (headingChangeDeg >= 34 && (prevDistance >= 2 || nextDistance >= 2))
        || (headingChangeDeg >= 22 && speedChangePct >= 0.4)
      ) {
        kind = "path_change";
        triggerMagnitudeDeg = headingChangeDeg;
      }
    }

    if (!kind) continue;

    const baselineWindow = motionSamplesInRange(motionSamples, current.tsMs - 140, current.tsMs - 25);
    const baselineHeadingDeg = meanHeadingDeg(baselineWindow);
    const baselineSpeed = safeMean(baselineWindow.map((sample) => sample.speed));
    const reactionTimeMs = findReactionTimeMs(
      motionSamples,
      current.tsMs,
      baselineHeadingDeg,
      baselineSpeed,
      triggerMagnitudeDeg,
    );
    const preSlowdownReactionMs = findPreSlowdownReactionMs(motionSamples, current.tsMs, baselineSpeed);
    const recoveryTimeMs = findRecoveryTimeMs(
      frames,
      index,
      targetId,
      previous.aimErrorDeg ?? current.aimErrorDeg ?? null,
    );

    const episodeFrames = frames.filter((frame) =>
      frame.tsMs >= current.tsMs
      && frame.tsMs <= current.tsMs + Math.max(600, (recoveryTimeMs ?? 0) + 220)
      && frame.target.id === targetId,
    );
    const peakYawErrorDeg = safeMean([
      ...episodeFrames.map((frame) => frame.aimErrorDeg),
      previous.aimErrorDeg,
      current.aimErrorDeg,
    ].map((value) => value ?? null));

    episodes.push({
      id: `target-response-${kind}-${current.tsMs}-${targetId}`,
      kind,
      startMs: current.tsMs,
      endMs: current.tsMs + Math.max(180, recoveryTimeMs ?? 360),
      targetId,
      targetLabel,
      triggerMagnitudeDeg,
      peakYawErrorDeg,
      reactionTimeMs,
      preSlowdownReactionMs,
      recoveryTimeMs,
      stableResponse:
        reactionTimeMs != null
        && reactionTimeMs <= 260
        && recoveryTimeMs != null
        && recoveryTimeMs <= 460,
    });
    lastTriggerMs = current.tsMs;
  }

  if (episodes.length === 0) return null;

  const summary = snapshotFromEpisodes(episodes);
  const telemetryCoverage =
    shotTelemetry.length > 0
      ? clampNumber((episodes.length / Math.max(shotTelemetry.length, 1)) * 100, 0, 100)
      : clampNumber((episodes.length / Math.max(frames.length, 1)) * 100, 0, 100);

  return {
    episodeCount: episodes.length,
    responseCoveragePct: telemetryCoverage,
    summary,
    episodes,
  };
}

export function buildRunMomentInsights(
  points: RunTimelinePoint[],
  durationSecs: number | null | undefined,
  maxMoments = 4,
): RunMomentInsight[] {
  if (points.length < 4) return [];
  const totalSecs = Math.max(1, Math.round(durationSecs ?? points[points.length - 1]?.tSec ?? points.length));

  const earlyStart = 0;
  const earlyEnd = Math.max(1, Math.floor(totalSecs / 3));
  const lateStart = Math.max(0, Math.floor((totalSecs * 2) / 3));
  const lateEnd = totalSecs;

  const earlySpm = mean(valuesInRange(points, earlyStart, earlyEnd, (point) => point.scorePerMinute));
  const lateSpm = mean(valuesInRange(points, lateStart, lateEnd, (point) => point.scorePerMinute));
  const earlyAcc = mean(valuesInRange(points, earlyStart, earlyEnd, (point) => point.accuracyPct));
  const lateAcc = mean(valuesInRange(points, lateStart, lateEnd, (point) => point.accuracyPct));
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
    .filter((point) => point.scorePerMinute != null)
    .reduce<RunTimelinePoint | null>((best, current) => {
      if (current.scorePerMinute == null) return best;
      if (!best || best.scorePerMinute == null) return current;
      return current.scorePerMinute > best.scorePerMinute ? current : best;
    }, null);

  const minAccPoint = points
    .filter((point) => point.accuracyPct != null)
    .reduce<RunTimelinePoint | null>((worst, current) => {
      if (current.accuracyPct == null) return worst;
      if (!worst || worst.accuracyPct == null) return current;
      return current.accuracyPct < worst.accuracyPct ? current : worst;
    }, null);

  const moments: RunMomentInsight[] = [];

  if (
    earlySpm > 0
    && lateSpm > 0
    && (earlySpm - lateSpm) / earlySpm > 0.12
  ) {
    const accuracyDelta = earlyAcc > 0 && lateAcc > 0 ? lateAcc - earlyAcc : null;
    const improvedAccuracy = accuracyDelta != null && accuracyDelta >= 2.5;

    moments.push({
      id: "moment-late-spm-fade",
      level: improvedAccuracy ? "tip" : "warning",
      title: improvedAccuracy ? "Speed→Accuracy Trade-off Late" : "Late-Run Pace Drop",
      detail: improvedAccuracy
        ? `Pace fell from ${Math.round(earlySpm)} to ${Math.round(lateSpm)} SPM while accuracy improved by ${accuracyDelta!.toFixed(1)}%. Keep this control and add pace back gradually.`
        : `Pace fell from ${Math.round(earlySpm)} to ${Math.round(lateSpm)} SPM in the final third without a meaningful accuracy gain.`,
      metric: "spm",
      startSec: lateStart,
      endSec: lateEnd,
    });
  }

  if (earlyAcc > 0 && lateAcc > 0 && lateAcc - earlyAcc >= 3) {
    moments.push({
      id: "moment-accuracy-build",
      level: "good",
      title: "Accuracy Stabilized",
      detail:
        earlyShotStats && lateShotStats
          ? `Accuracy improved ${earlyAcc.toFixed(1)}% → ${lateAcc.toFixed(1)}%, and shots-per-hit improved ${earlyShotStats.shotsPerHit.toFixed(2)} → ${lateShotStats.shotsPerHit.toFixed(2)}.`
          : `Accuracy improved from ${earlyAcc.toFixed(1)}% to ${lateAcc.toFixed(1)}% late-run.`,
      metric: "accuracy",
      startSec: lateStart,
      endSec: lateEnd,
    });
  }

  if (thirds.length > 0) {
    const worstCorrectionWindow = [...thirds].sort((a, b) => b.stats.shotsPerHit - a.stats.shotsPerHit)[0];
    if (worstCorrectionWindow.stats.shotsPerHit >= 1.6) {
      moments.push({
        id: "moment-correction-window",
        level: worstCorrectionWindow.stats.shotsPerHit >= 2 ? "warning" : "tip",
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
    .sort((left, right) => levelRank[left.level] - levelRank[right.level])
    .slice(0, maxMoments);
}

export function buildRunCoachingTips(
  snapshot: Omit<ScenarioRunSnapshot, "tips">,
  keyMoments: RunMomentInsight[],
  maxTips = 3,
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
    const shotsPerHit = snapshot.shotsHit > 0 ? snapshot.shotsFired / snapshot.shotsHit : snapshot.shotsFired;
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

  if (
    snapshot.killsPerSecond != null
    && snapshot.accuracyPct != null
    && snapshot.killsPerSecond < 0.75
    && snapshot.accuracyPct >= 88
  ) {
    pushUnique({
      id: "speed-gap",
      level: "tip",
      title: "Speed Ceiling",
      detail: "Precision is strong but kill pace is limited. Add short target-switch blocks and pre-plan your next target during confirms.",
    });
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

  if (tips.length < maxTips && keyMoments.length > 2) {
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

  return tips.slice(0, maxTips);
}

export function formatRunWindow(startSec: number, endSec: number): string {
  const start = Math.max(0, Math.round(startSec));
  const end = Math.max(start, Math.round(endSec));
  return `${start}s–${end}s`;
}

export function runMomentAction(moment: RunMomentInsight): string {
  switch (moment.id) {
    case "moment-late-spm-fade":
      return moment.level === "warning"
        ? "Do 3 reps where you hold your opening rhythm into the final third before trying to push speed."
        : "Keep this late-run control, then add pace back in 3–5% steps while preserving conversion.";
    case "moment-correction-window":
      return "Run this window at ~90% speed and focus on first-shot placement; only speed up after conversion stabilizes.";
    case "moment-low-accuracy":
      return "Pre-aim one target ahead in this window and delay the click slightly until the cursor is settled.";
    case "moment-accuracy-build":
      return "Use your opening pace for the first 5s, then apply this same settled timing earlier in the run.";
    case "moment-peak-spm":
      return "Anchor your rhythm to this window and repeat it across adjacent segments instead of short bursts.";
    default:
      return "Replay this window for 3 focused reps and change only one variable (speed, confirmation timing, or target switch plan).";
  }
}

export function deriveGlobalCoachingLearningState(
  records: CoachingAnalyticsRecord[],
  practiceProfile: PracticeProfileSnapshot | null,
  warmupIds: Set<string>,
): GlobalCoachingLearningState | null {
  const reliableSorted = [...records]
    .filter((record) => record.isReliableForAnalysis)
    .sort((left, right) => left.timestampMs - right.timestampMs);
  if (reliableSorted.length < 6) return null;

  const normalizedSignals = buildNormalizedSessionSignals(reliableSorted);
  if (normalizedSignals.length < 6) return null;

  const settledSignals = normalizedSignals.filter((entry) => !warmupIds.has(entry.record.id));
  const warmupSignals = normalizedSignals.filter((entry) => warmupIds.has(entry.record.id));

  const familyCounts = new Map<string, number>();
  for (const entry of normalizedSignals) {
    const family = entry.baseline.scenarioType;
    if (!family || family === "Unknown") continue;
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  }

  const familyEntries = [...familyCounts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  const totalFamilyRuns = familyEntries.reduce((sum, [, count]) => sum + count, 0);
  const dominantFamily = familyEntries[0]?.[0] ?? null;
  const dominantFamilySharePct =
    dominantFamily && totalFamilyRuns > 0
      ? (familyEntries[0][1] / totalFamilyRuns) * 100
      : null;

  const normalizedValues = settledSignals.map((entry) => entry.normalizedScore);
  const normalizedVariancePct = normalizedValues.length >= 2
    ? (stddev(normalizedValues) / Math.max(mean(normalizedValues), 0.0001)) * 100
    : null;

  const warmupTaxPct =
    warmupSignals.length >= 3 && settledSignals.length >= 5
      ? ((mean(settledSignals.map((entry) => entry.normalizedScore)) - mean(warmupSignals.map((entry) => entry.normalizedScore)))
        / Math.max(mean(settledSignals.map((entry) => entry.normalizedScore)), 0.0001)) * 100
      : null;

  const normalizedBlockRecords = settledSignals.map((entry) => ({
    ...entry.record,
    normalizedScore: entry.normalizedScore,
  }));
  const blocks = groupIntoPlayBlocks(normalizedBlockRecords);
  const blockFadePcts: number[] = [];
  const switchedScores: number[] = [];
  const repeatedScores: number[] = [];
  const retentionScores: number[] = [];

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const sessions = block.sessions;
    const blockMinutes = sessions.reduce((sum, session) => sum + Math.max(0, session.duration_secs), 0) / 60;
    if (sessions.length >= 4 && blockMinutes >= 12) {
      const earlyAvg = mean(sessions.slice(0, Math.min(2, sessions.length)).map((session) => session.normalizedScore));
      const lateAvg = mean(sessions.slice(-Math.min(2, sessions.length)).map((session) => session.normalizedScore));
      if (earlyAvg > 0) {
        blockFadePcts.push(((earlyAvg - lateAvg) / earlyAvg) * 100);
      }
    }

    for (let index = 1; index < sessions.length; index += 1) {
      const current = sessions[index];
      const previous = sessions[index - 1];
      if (current.normalizedScenario !== previous.normalizedScenario) {
        switchedScores.push(current.normalizedScore);
      } else {
        repeatedScores.push(current.normalizedScore);
      }
    }

    if (blockIndex > 0 && (block.gapBeforeMs ?? 0) >= 12 * 60 * 60 * 1000) {
      const previousBlock = blocks[blockIndex - 1];
      const previousSettled = previousBlock.sessions.slice(-Math.min(2, previousBlock.sessions.length));
      const nextSettled = sessions.slice(0, Math.min(2, sessions.length));
      if (previousSettled.length > 0 && nextSettled.length > 0) {
        const previousAvg = mean(previousSettled.map((session) => session.normalizedScore));
        const nextAvg = mean(nextSettled.map((session) => session.normalizedScore));
        if (previousAvg > 0) {
          retentionScores.push((nextAvg / previousAvg) * 100);
        }
      }
    }
  }

  const switchPenaltyPct =
    switchedScores.length >= 6 && repeatedScores.length >= 6
      ? ((mean(repeatedScores) - mean(switchedScores)) / Math.max(mean(repeatedScores), 0.0001)) * 100
      : null;

  const avgBlockFadePct = blockFadePcts.length >= 2 ? mean(blockFadePcts) : null;
  const retentionAfterGapPct = retentionScores.length >= 2 ? mean(retentionScores) : null;

  const settledValues = settledSignals.map((entry) => entry.normalizedScore);
  let momentumDeltaPct: number | null = null;
  if (settledValues.length >= 8) {
    const window = Math.min(8, Math.max(4, Math.floor(settledValues.length / 3)));
    const recent = settledValues.slice(-window);
    const older = settledValues.slice(-window * 2, -window);
    if (older.length === window && recent.length === window) {
      momentumDeltaPct = ((mean(recent) - mean(older)) / Math.max(mean(older), 0.0001)) * 100;
    }
  }

  return {
    sampleCount: normalizedSignals.length,
    settledSampleCount: settledSignals.length,
    warmupSampleCount: warmupSignals.length,
    normalizedVariancePct,
    warmupTaxPct,
    avgBlockFadePct,
    switchPenaltyPct,
    momentumDeltaPct,
    retentionAfterGapPct,
    dominantFamily,
    dominantFamilySharePct,
    familyDiversity: practiceProfile?.scenarioDiversity ?? familyEntries.length,
  };
}

export function deriveBehaviorPatternFeatures(
  records: CoachingAnalyticsRecord[],
  practiceProfile: PracticeProfileSnapshot | null,
  warmupIds: Set<string>,
): BehaviorPatternFeatures | null {
  const learningState = deriveGlobalCoachingLearningState(records, practiceProfile, warmupIds);
  if (!learningState) return null;

  const reliableSorted = [...records]
    .filter((record) => record.isReliableForAnalysis)
    .sort((left, right) => left.timestampMs - right.timestampMs);
  if (reliableSorted.length < 6) return null;

  const recent = reliableSorted.slice(-Math.min(36, reliableSorted.length));
  const warmupSignals = buildNormalizedSessionSignals(reliableSorted)
    .filter((entry) => warmupIds.has(entry.record.id))
    .map((entry) => entry.normalizedScore);
  const warmupConsistencyPct =
    warmupSignals.length >= 3
      ? clampNumber(100 - (stddev(warmupSignals) / Math.max(mean(warmupSignals), 0.0001)) * 100, 0, 100)
      : null;

  const correctionLoadPct = (() => {
    const avgShotsToHit = meanDefined(recent.map((record) => record.shot_timing?.avg_shots_to_hit));
    if (avgShotsToHit == null) return null;
    return clampNumber(Math.max(0, avgShotsToHit - 1) * 100, 0, 100);
  })();

  const hesitationLoadPct = (() => {
    const avgFireToHitMs = meanDefined(recent.map((record) => record.shot_timing?.avg_fire_to_hit_ms));
    if (avgFireToHitMs == null) return null;
    return clampNumber(((avgFireToHitMs - 120) / 420) * 100, 0, 100);
  })();

  const controlPct = (() => {
    const smoothRecords = recent.filter((record) => record.smoothness != null);
    if (smoothRecords.length < 4) return null;
    const composite = meanDefined(smoothRecords.map((record) => record.smoothness?.composite)) ?? 50;
    const pathEff = (meanDefined(smoothRecords.map((record) => record.smoothness?.path_efficiency)) ?? 0.5) * 100;
    const correctionPenalty = (meanDefined(smoothRecords.map((record) => record.smoothness?.correction_ratio)) ?? 0.3) * 100;
    const jitterPenalty = clampNumber((meanDefined(smoothRecords.map((record) => record.smoothness?.jitter)) ?? 0.15) * 180, 0, 100);
    return clampNumber(composite * 0.45 + pathEff * 0.3 + (100 - correctionPenalty) * 0.15 + (100 - jitterPenalty) * 0.1, 0, 100);
  })();

  const precisionPct = (() => {
    const accuracyMean = meanDefined(recent.map((record) => normalizeAccuracyPct(record.stats_panel?.accuracy_pct ?? record.accuracy ?? null)));
    const conversionPct = correctionLoadPct != null ? clampNumber(100 - correctionLoadPct, 0, 100) : null;
    if (accuracyMean == null && conversionPct == null) return null;
    return clampNumber((accuracyMean ?? 82) * 0.65 + (conversionPct ?? 55) * 0.35, 0, 100);
  })();

  const tempoPct = (() => {
    const settledSignals = buildNormalizedSessionSignals(reliableSorted)
      .filter((entry) => !warmupIds.has(entry.record.id));
    if (settledSignals.length < 5) return null;
    return clampNumber(50 + (mean(settledSignals.slice(-Math.min(12, settledSignals.length)).map((entry) => entry.normalizedScore)) - 1) * 80, 0, 100);
  })();

  const readinessPct = (() => {
    const warmupPenalty = learningState.warmupTaxPct != null ? clampNumber(100 - learningState.warmupTaxPct * 9, 0, 100) : null;
    if (warmupPenalty == null && warmupConsistencyPct == null) return null;
    return clampNumber((warmupPenalty ?? 55) * 0.7 + (warmupConsistencyPct ?? 55) * 0.3, 0, 100);
  })();

  const switchResiliencePct = learningState.switchPenaltyPct != null
    ? clampNumber(100 - learningState.switchPenaltyPct * 10, 0, 100)
    : null;
  const retainedFormPct = learningState.retentionAfterGapPct != null
    ? clampNumber(learningState.retentionAfterGapPct, 0, 100)
    : null;
  const fatiguePressurePct = (() => {
    const fadePressure = learningState.avgBlockFadePct != null ? learningState.avgBlockFadePct * 12 : null;
    const blockPressure = practiceProfile != null ? Math.max(0, practiceProfile.avgBlockMinutes - 32) * 1.2 : 0;
    if (fadePressure == null && blockPressure <= 0) return null;
    return clampNumber((fadePressure ?? 0) + blockPressure, 0, 100);
  })();
  const endurancePct = fatiguePressurePct != null ? clampNumber(100 - fatiguePressurePct, 0, 100) : null;
  const consistencyPct = learningState.normalizedVariancePct != null
    ? clampNumber(100 - learningState.normalizedVariancePct * 5, 0, 100)
    : null;
  const transferPct = (() => {
    const familyBalancePct = familyBalanceScore(
      learningState.dominantFamilySharePct,
      learningState.familyDiversity,
    );
    if (familyBalancePct == null && switchResiliencePct == null && retainedFormPct == null) return null;
    return clampNumber((familyBalancePct ?? 50) * 0.35 + (switchResiliencePct ?? 50) * 0.35 + (retainedFormPct ?? 50) * 0.3, 0, 100);
  })();
  const adaptationPct = (() => {
    if (readinessPct == null && switchResiliencePct == null && retainedFormPct == null) return null;
    return clampNumber((readinessPct ?? 50) * 0.35 + (switchResiliencePct ?? 50) * 0.45 + (retainedFormPct ?? 50) * 0.2, 0, 100);
  })();
  const learningEfficiencyPct = (() => {
    const momentum = learningState.momentumDeltaPct ?? 0;
    const retention = (retainedFormPct ?? 95) - 95;
    const volumePenalty = practiceProfile != null ? Math.max(0, practiceProfile.avgBlockMinutes - 35) * 0.8 : 0;
    return clampNumber(50 + momentum * 6 + retention * 1.8 - volumePenalty, 0, 100);
  })();

  return {
    sampleCount: learningState.sampleCount,
    settledSampleCount: learningState.settledSampleCount,
    warmupConsistencyPct,
    readinessPct,
    adaptationPct,
    endurancePct,
    transferPct,
    precisionPct,
    controlPct,
    consistencyPct,
    learningEfficiencyPct,
    tempoPct,
    switchResiliencePct,
    retainedFormPct,
    fatiguePressurePct,
    correctionLoadPct,
    hesitationLoadPct,
    volatilityPct: learningState.normalizedVariancePct,
    momentumPct: learningState.momentumDeltaPct,
    precisionTempoBiasPct:
      precisionPct != null && tempoPct != null
        ? clampNumber(precisionPct - tempoPct, -100, 100)
        : null,
  };
}

export function buildPlayerLearningProfile(
  records: CoachingAnalyticsRecord[],
  practiceProfile: PracticeProfileSnapshot | null,
  warmupIds: Set<string>,
  generatedAtMs = Date.now(),
): PlayerLearningProfile | null {
  const features = deriveBehaviorPatternFeatures(records, practiceProfile, warmupIds);
  if (!features) return null;

  const reliableSorted = [...records]
    .filter((record) => record.isReliableForAnalysis)
    .sort((left, right) => left.timestampMs - right.timestampMs);
  if (reliableSorted.length < 6) return null;

  const axes: PlayerLearningAxis[] = [
    { key: "readiness", label: "Readiness", valuePct: features.readinessPct ?? 50, detail: describeAxis("readiness", features.readinessPct ?? 50) },
    { key: "adaptation", label: "Adaptation", valuePct: features.adaptationPct ?? 50, detail: describeAxis("adaptation", features.adaptationPct ?? 50) },
    { key: "endurance", label: "Endurance", valuePct: features.endurancePct ?? 50, detail: describeAxis("endurance", features.endurancePct ?? 50) },
    { key: "transfer", label: "Transfer", valuePct: features.transferPct ?? 50, detail: describeAxis("transfer", features.transferPct ?? 50) },
    { key: "precision", label: "Precision", valuePct: features.precisionPct ?? 50, detail: describeAxis("precision", features.precisionPct ?? 50) },
    { key: "control", label: "Control", valuePct: features.controlPct ?? 50, detail: describeAxis("control", features.controlPct ?? 50) },
    { key: "consistency", label: "Consistency", valuePct: features.consistencyPct ?? 50, detail: describeAxis("consistency", features.consistencyPct ?? 50) },
    { key: "learning", label: "Learning", valuePct: features.learningEfficiencyPct ?? 50, detail: describeAxis("learning", features.learningEfficiencyPct ?? 50) },
  ].sort((left, right) => right.valuePct - left.valuePct);

  const strengths = axes
    .filter((axis) => axis.valuePct >= 58)
    .slice(0, 3)
    .map<PlayerLearningSignal>((axis) => ({
      key: axis.key,
      label: axis.label,
      detail: axis.detail,
      valuePct: axis.valuePct,
    }));
  const constraints = [...axes]
    .reverse()
    .filter((axis) => axis.valuePct <= 52)
    .slice(0, 3)
    .map<PlayerLearningSignal>((axis) => ({
      key: axis.key,
      label: axis.label,
      detail: axis.detail,
      valuePct: axis.valuePct,
    }));
  const focusArea = constraints[0] ?? [...axes].sort((left, right) => left.valuePct - right.valuePct)[0] ?? null;
  const topStrength = strengths[0] ?? axes[0] ?? null;

  const summary = focusArea && topStrength
    ? `${topStrength.label} is currently your steadiest global asset, while ${focusArea.label} is the cleanest bottleneck to attack next.`
    : "The current coaching model has enough data to describe broad learning tendencies, but not enough contrast yet for a sharp next target.";

  return {
    generatedAtMs,
    sampleCount: features.sampleCount,
    settledSampleCount: features.settledSampleCount,
    coverageStartMs: reliableSorted[0]?.timestampMs ?? null,
    coverageEndMs: reliableSorted[reliableSorted.length - 1]?.timestampMs ?? null,
    summary,
    focusAreaKey: focusArea?.key ?? null,
    focusAreaLabel: focusArea?.label ?? null,
    dominantConstraintKey: focusArea?.key ?? null,
    strengths,
    constraints,
    axes,
    metrics: {
      readinessPct: features.readinessPct,
      adaptationPct: features.adaptationPct,
      endurancePct: features.endurancePct,
      transferPct: features.transferPct,
      precisionPct: features.precisionPct,
      controlPct: features.controlPct,
      consistencyPct: features.consistencyPct,
      learningEfficiencyPct: features.learningEfficiencyPct,
      tempoPct: features.tempoPct,
      switchResiliencePct: features.switchResiliencePct,
      retainedFormPct: features.retainedFormPct,
      fatiguePressurePct: features.fatiguePressurePct,
      correctionLoadPct: features.correctionLoadPct,
      hesitationLoadPct: features.hesitationLoadPct,
      volatilityPct: features.volatilityPct,
      momentumPct: features.momentumPct,
      warmupConsistencyPct: features.warmupConsistencyPct,
      precisionTempoBiasPct: features.precisionTempoBiasPct,
    },
  };
}

function metricForSignal(
  signalKey: string,
  profile: PlayerLearningProfile,
): { metricKey: string; direction: "up" | "down"; value: number | null } | null {
  const metrics = profile.metrics;
  switch (signalKey) {
    case "warmup_tax":
      return { metricKey: "readinessPct", direction: "up", value: metrics.readinessPct };
    case "warmup_efficiency":
      return { metricKey: "readinessPct", direction: "up", value: metrics.readinessPct };
    case "practice_spacing":
      return { metricKey: "learningEfficiencyPct", direction: "up", value: metrics.learningEfficiencyPct };
    case "family_balance":
    case "transfer_bias":
    case "interleaving":
      return { metricKey: "transferPct", direction: "up", value: metrics.transferPct };
    case "block_fade":
    case "fatigue_pattern":
      return { metricKey: "endurancePct", direction: "up", value: metrics.endurancePct };
    case "switch_penalty":
    case "context_adaptation":
      return { metricKey: "adaptationPct", direction: "up", value: metrics.adaptationPct };
    case "retention_after_gap":
    case "consolidation":
    case "consolidation_strength":
      return { metricKey: "retainedFormPct", direction: "up", value: metrics.retainedFormPct };
    case "momentum":
    case "cross_scenario_transfer":
    case "global_form_drop":
      return { metricKey: "learningEfficiencyPct", direction: "up", value: metrics.learningEfficiencyPct };
    case "normalized_variance":
    case "execution_consistency":
      return { metricKey: "consistencyPct", direction: "up", value: metrics.consistencyPct };
    case "correction_load":
      return { metricKey: "correctionLoadPct", direction: "down", value: metrics.correctionLoadPct };
    case "hesitation_load":
      return { metricKey: "hesitationLoadPct", direction: "down", value: metrics.hesitationLoadPct };
    case "precision_balance":
      return { metricKey: "precisionPct", direction: "up", value: metrics.precisionPct };
    case "control_foundation":
      return { metricKey: "controlPct", direction: "up", value: metrics.controlPct };
    default:
      return null;
  }
}

export function buildCoachingRecommendationEvaluations(
  snapshotKind: string,
  cards: CoachingCardData[],
  profile: PlayerLearningProfile,
): CoachingRecommendationEvaluation[] {
  return cards.flatMap((card) => {
    const signalKey = card.signals?.find((signal) => metricForSignal(signal, profile) != null);
    if (!signalKey) return [];
    const metric = metricForSignal(signalKey, profile);
    if (!metric) return [];
    const evaluationId = `${snapshotKind}:${card.id}:${profile.settledSampleCount}:${profile.coverageEndMs ?? 0}`;
    return [{
      evaluationId,
      snapshotKind,
      recommendationId: card.id,
      recommendationTitle: card.title,
      signalKey,
      status: "pending",
      createdAtUnixMs: profile.generatedAtMs,
      updatedAtUnixMs: profile.generatedAtMs,
      anchorSampleCount: profile.settledSampleCount,
      latestSampleCount: profile.settledSampleCount,
      anchorMetricValue: metric.value,
      latestMetricValue: metric.value,
      outcomeDelta: null,
      contextJson: {
        metricKey: metric.metricKey,
        direction: metric.direction,
        focusAreaKey: profile.focusAreaKey,
        focusAreaLabel: profile.focusAreaLabel,
        confidence: card.confidence ?? null,
        coverageEndMs: profile.coverageEndMs,
      },
    }];
  });
}

export function buildPersistedCoachingStateSnapshot(
  snapshotKind: string,
  profile: PlayerLearningProfile,
  features: BehaviorPatternFeatures | null,
  cards: CoachingCardData[],
): PersistedCoachingStateSnapshot {
  return {
    snapshotKind,
    updatedAtUnixMs: profile.generatedAtMs,
    sampleCount: profile.sampleCount,
    settledSampleCount: profile.settledSampleCount,
    coverageStartUnixMs: profile.coverageStartMs,
    coverageEndUnixMs: profile.coverageEndMs,
    summaryJson: {
      profile,
      features,
      cards,
    },
  };
}

export function resolveCoachingRecommendationEvaluations(
  evaluations: CoachingRecommendationEvaluation[],
  profile: PlayerLearningProfile,
  minSampleGain = 6,
): CoachingRecommendationEvaluation[] {
  return evaluations.map((evaluation) => {
    if (evaluation.status !== "pending") return evaluation;
    if (profile.settledSampleCount - evaluation.anchorSampleCount < minSampleGain) return evaluation;
    const metricKey = typeof evaluation.contextJson.metricKey === "string"
      ? evaluation.contextJson.metricKey
      : null;
    const direction = evaluation.contextJson.direction === "down" ? "down" : "up";
    const latestValue = metricKey ? (profile.metrics[metricKey] ?? null) : null;
    if (latestValue == null || evaluation.anchorMetricValue == null) {
      return {
        ...evaluation,
        updatedAtUnixMs: profile.generatedAtMs,
        latestSampleCount: profile.settledSampleCount,
        latestMetricValue: latestValue,
      };
    }
    const signedDelta = direction === "down"
      ? evaluation.anchorMetricValue - latestValue
      : latestValue - evaluation.anchorMetricValue;
    const status: CoachingRecommendationEvaluation["status"] =
      signedDelta >= 3 ? "improved" : signedDelta <= -3 ? "regressed" : "flat";
    return {
      ...evaluation,
      status,
      updatedAtUnixMs: profile.generatedAtMs,
      latestSampleCount: profile.settledSampleCount,
      latestMetricValue: latestValue,
      outcomeDelta: signedDelta,
    };
  });
}

export function buildGlobalCoachingCards(
  records: CoachingAnalyticsRecord[],
  practiceProfile: PracticeProfileSnapshot | null,
  warmupIds: Set<string>,
  personalization?: CoachingPersonalizationInput | null,
): CoachingCardData[] {
  const learningState = deriveGlobalCoachingLearningState(records, practiceProfile, warmupIds);
  const behaviorFeatures = deriveBehaviorPatternFeatures(records, practiceProfile, warmupIds);
  const learningProfile = buildPlayerLearningProfile(records, practiceProfile, warmupIds);
  if (!learningState) return [];

  const cards: CoachingCardData[] = [];
  const pushUnique = (card: CoachingCardData) => {
    if (cards.some((existing) => existing.id === card.id)) return;
    cards.push(card);
  };

  if (learningState.warmupTaxPct != null) {
    if (learningState.warmupTaxPct >= 6) {
      pushUnique({
        id: "global-warmup-tax",
        source: "global",
        title: "Warm-up Tax Across Scenarios",
        badge: "Readiness",
        badgeColor: "#ffb400",
        body: `Across recent scenarios, your opening runs land about ${learningState.warmupTaxPct.toFixed(0)}% below your own settled-in level once each run is normalized against that scenario's usual score band. The issue is global readiness, not one bad scenario.`,
        tip: "Protect score attempts with a short 2–3 run ramp: easy tracking or wide targets, then medium-speed confirms, then serious attempts once the cursor feels settled.",
        confidence: 0.84,
        signals: ["warmup_tax", "cross_scenario_normalization"],
      });
    } else if (learningState.warmupTaxPct <= 1.5) {
      pushUnique({
        id: "global-quick-ramp",
        source: "global",
        title: "You Ramp Quickly",
        badge: "Readiness",
        badgeColor: "#00f5a0",
        body: "Your opening runs are already close to your own settled standard across different scenarios. That is a strong sign that your setup and pre-run routine are doing their job.",
        tip: "Keep the routine stable. If you want more progress, spend the saved warm-up time on one focused mechanic block instead of adding random extra attempts.",
        confidence: 0.74,
        signals: ["warmup_efficiency"],
      });
    }
  }

  if (behaviorFeatures?.correctionLoadPct != null && behaviorFeatures.correctionLoadPct >= 28) {
    pushUnique({
      id: "global-correction-load",
      source: "global",
      title: "You Are Spending Too Many Extra Shots",
      badge: "Conversion",
      badgeColor: "#ff6b6b",
      body: `Across recent instrumented runs, your correction load sits around ${behaviorFeatures.correctionLoadPct.toFixed(0)}%. The misses are not only accuracy misses; they are repeated micro-corrections that slow the whole chain down.`,
      tip: "Use lower-speed confirmation reps for 5–8 minutes and judge success by first-shot quality, not raw score. Cleaner conversion will usually lift both precision and tempo.",
      confidence: 0.77,
      signals: ["correction_load", "precision_balance"],
    });
  } else if (behaviorFeatures?.correctionLoadPct != null && behaviorFeatures.correctionLoadPct <= 12) {
    pushUnique({
      id: "global-clean-conversion",
      source: "global",
      title: "Shot Conversion Is A Real Strength",
      badge: "Conversion",
      badgeColor: "#00f5a0",
      body: `Recent instrumented runs are only paying about ${behaviorFeatures.correctionLoadPct.toFixed(0)}% correction load. That means first-shot quality is carrying real weight for you instead of relying on cleanup shots.`,
      tip: "Protect that conversion edge and look for score through pace, target planning, or switch speed rather than by forcing extra clicks.",
      confidence: 0.66,
      signals: ["correction_load"],
    });
  }

  if (behaviorFeatures?.hesitationLoadPct != null && behaviorFeatures.hesitationLoadPct >= 42) {
    pushUnique({
      id: "global-hesitation-load",
      source: "global",
      title: "Hesitation Is Capping Tempo",
      badge: "Tempo",
      badgeColor: "#ffd700",
      body: `Your recent fire-to-hit timings suggest a noticeable hesitation load around ${behaviorFeatures.hesitationLoadPct.toFixed(0)}%. The bottleneck looks less like pure aim error and more like delayed commit timing.`,
      tip: "Run short commit drills where you accept slightly lower accuracy but forbid double-checking. We want cleaner decisions first, then polish the aim around them.",
      confidence: 0.71,
      signals: ["hesitation_load", "precision_balance"],
    });
  }

  if (
    learningProfile?.metrics.precisionTempoBiasPct != null
    && learningProfile.metrics.precisionTempoBiasPct >= 14
  ) {
    pushUnique({
      id: "global-precision-ahead-of-tempo",
      source: "global",
      title: "Precision Is Outrunning Tempo",
      badge: "Balance",
      badgeColor: "#00b4ff",
      body: "Your learning profile shows precision and conversion developing faster than tempo. That is a good foundation, but it also means some score is left on the table because the commit cadence is too cautious.",
      tip: "Keep one accuracy anchor scenario, then pair it with a faster contrast scenario where the goal is faster commits at only a small accuracy cost.",
      confidence: 0.69,
      signals: ["precision_balance"],
    });
  } else if (
    learningProfile?.metrics.precisionTempoBiasPct != null
    && learningProfile.metrics.precisionTempoBiasPct <= -14
  ) {
    pushUnique({
      id: "global-tempo-ahead-of-precision",
      source: "global",
      title: "Tempo Is Beating Shot Quality",
      badge: "Balance",
      badgeColor: "#ff9f43",
      body: "Your current learning profile suggests pace is arriving faster than clean shot conversion. That can create exciting peaks, but it usually makes progress harder to stabilize.",
      tip: "Keep the tempo, but cap block speed at the point where first-shot quality stops collapsing. We want usable speed, not speed that has to be corrected away.",
      confidence: 0.7,
      signals: ["precision_balance", "correction_load"],
    });
  }

  if (behaviorFeatures?.controlPct != null && behaviorFeatures.controlPct >= 68) {
    pushUnique({
      id: "global-control-foundation",
      source: "global",
      title: "Movement Control Is Supporting You",
      badge: "Foundation",
      badgeColor: "#00f5a0",
      body: `Your recent movement data points to a control foundation around ${behaviorFeatures.controlPct.toFixed(0)}%. That means pathing and correction behavior are stable enough to support harder training choices.`,
      tip: "Use that foundation to push one harder variable at a time: smaller targets, more speed, or more switching. You do not need to train everything upward at once.",
      confidence: 0.63,
      signals: ["control_foundation"],
    });
  }

  if (behaviorFeatures?.learningEfficiencyPct != null && behaviorFeatures.learningEfficiencyPct <= 42) {
    pushUnique({
      id: "global-learning-efficiency-low",
      source: "global",
      title: "Practice Is Not Converting Cleanly Yet",
      badge: "Learning",
      badgeColor: "#ff6b6b",
      body: "The new learning model says recent volume is producing less sticky progress than it should. Some work is helping in-session, but not enough of it is surviving into later blocks and later days.",
      tip: "Simplify for one week: fewer scenario swaps, stable block length, and one main mechanic focus. We want a cleaner learning signal before we add more variety or difficulty.",
      confidence: 0.75,
      signals: ["momentum", "practice_spacing"],
    });
  } else if (behaviorFeatures?.learningEfficiencyPct != null && behaviorFeatures.learningEfficiencyPct >= 60) {
    pushUnique({
      id: "global-learning-efficiency-strong",
      source: "global",
      title: "Recent Practice Is Converting Well",
      badge: "Learning",
      badgeColor: "#00f5a0",
      body: "The new learning model sees good conversion from recent work into later performance. Improvements are not staying trapped inside one session; they are carrying into later reps and mixed scenarios.",
      tip: "This is the right time to add a little more challenge. Keep the structure stable and raise only one demand so the carryover stays readable.",
      confidence: 0.68,
      signals: ["momentum", "cross_scenario_transfer"],
    });
  }

  if (practiceProfile && practiceProfile.sessionCount >= 5) {
    const daysPerWeek = practiceProfile.daysPerWeek;
    const avgBlockMinutes = practiceProfile.avgBlockMinutes;
    const massedPattern = avgBlockMinutes >= 45 || (daysPerWeek < 2.5 && practiceProfile.avgBlockRuns >= 6);
    const distributedPattern = daysPerWeek >= 3.5 && avgBlockMinutes >= 12 && avgBlockMinutes <= 35;

    if (massedPattern) {
      pushUnique({
        id: "global-practice-density",
        source: "global",
        title: "Practice Density Is Hiding Progress",
        badge: "Spacing",
        badgeColor: "#00b4ff",
        body: `Recent work is concentrated into ${avgBlockMinutes.toFixed(0)}-minute blocks across about ${daysPerWeek.toFixed(1)} active day${daysPerWeek >= 1.5 ? "s" : ""}/week. That mixes warm-up gains and fatigue into the same block, which makes true improvement harder to read.`,
        tip: "Keep the volume, split the block. Two shorter 20–35 minute sessions usually preserve effort better than one long grind and make your next-day quality easier to judge.",
        confidence: 0.76,
        signals: ["practice_spacing", "block_length"],
      });
    } else if (distributedPattern) {
      pushUnique({
        id: "global-practice-cadence",
        source: "global",
        title: "Your Practice Cadence Is Healthy",
        badge: "Spacing",
        badgeColor: "#00f5a0",
        body: `You are practicing across about ${daysPerWeek.toFixed(1)} active days/week with blocks averaging ${avgBlockMinutes.toFixed(0)} minutes. That is a strong range for retaining skill without paying too much fatigue tax.`,
        tip: "Use this structure as your base and adjust one variable at a time: either slightly more difficulty, slightly more contrast work, or slightly more deliberate warm-up, not all three at once.",
        confidence: 0.72,
        signals: ["practice_spacing", "distributed_practice"],
      });
    }
  }

  if (
    learningState.dominantFamily != null
    && learningState.dominantFamilySharePct != null
    && learningState.dominantFamilySharePct >= 58
  ) {
    const contrast = contrastPlanForScenarioFamily(learningState.dominantFamily);
    pushUnique({
      id: "global-family-narrow",
      source: "global",
      title: "Practice Mix Is Too Narrow",
      badge: "Transfer",
      badgeColor: "#a78bfa",
      body: `${Math.round(learningState.dominantFamilySharePct)}% of your recent reliable runs sit in ${scenarioFamilyLabel(learningState.dominantFamily)}. That sharpens familiarity, but it usually undertrains broader transfer.`,
      tip: `Keep your main family, but insert one ${contrast.label} set after every 2–3 serious runs. The goal is not comfort inside the block; it is better retention and carryover when you come back.`,
      drills: contrast.drills,
      confidence: 0.8,
      signals: ["family_balance", "transfer_bias"],
    });
  } else if (
    learningState.familyDiversity >= 4
    && learningState.dominantFamilySharePct != null
    && learningState.dominantFamilySharePct <= 40
  ) {
    pushUnique({
      id: "global-family-balanced",
      source: "global",
      title: "Family Coverage Looks Balanced",
      badge: "Transfer",
      badgeColor: "#00f5a0",
      body: `Recent practice is spread across ${learningState.familyDiversity} scenario families without one family swallowing the block. That gives you useful interference without turning the session into noise.`,
      tip: "Keep one primary focus for the day, but preserve this level of contrast work. Variety is helping your overall carryover, not just your score on one favorite scenario.",
      confidence: 0.7,
      signals: ["family_balance", "interleaving"],
    });
  }

  if (learningState.avgBlockFadePct != null) {
    if (learningState.avgBlockFadePct >= 5) {
      pushUnique({
        id: "global-block-fade",
        source: "global",
        title: "Long Blocks Fade Late",
        badge: "Endurance",
        badgeColor: "#ff9f43",
        body: `Across your longer practice blocks, settled runs finish about ${learningState.avgBlockFadePct.toFixed(0)}% below the level you hit near the start of the block. That points to endurance or attention decay, not a lack of raw skill.`,
        tip: "Treat the middle of the block as the scoring window. Once quality fades, swap into a lower-stakes drill or stop the block instead of grinding more serious attempts.",
        confidence: 0.83,
        signals: ["block_fade", "fatigue_pattern"],
      });
    } else if (learningState.avgBlockFadePct <= 1.5 && (practiceProfile?.avgBlockMinutes ?? 0) >= 15) {
      pushUnique({
        id: "global-block-stability",
        source: "global",
        title: "You Hold Quality Deep Into Blocks",
        badge: "Endurance",
        badgeColor: "#00f5a0",
        body: "Your later settled runs stay close to your early-block standard even in longer sessions. That is a real endurance strength and gives you more freedom to train with volume.",
        tip: "Use that endurance advantage on deliberate quality reps, not on mindless extra volume. Staying stable is most valuable when the later reps still have a purpose.",
        confidence: 0.68,
        signals: ["block_fade", "endurance_strength"],
      });
    }
  }

  if (learningState.switchPenaltyPct != null) {
    if (learningState.switchPenaltyPct >= 5) {
      pushUnique({
        id: "global-switch-cost",
        source: "global",
        title: "Scenario Switches Still Cost You",
        badge: "Context",
        badgeColor: "#ffd700",
        body: `Runs that follow a scenario change land about ${learningState.switchPenaltyPct.toFixed(0)}% below runs that stay on the same task, even after normalizing for each scenario's own score range. Right now the switch itself is expensive.`,
        tip: "Use mini-blocks instead of single-run hopping: 2–3 reps on one task, then switch. That keeps some interleaving benefit without paying a reset cost every run.",
        confidence: 0.8,
        signals: ["switch_penalty", "context_reset"],
      });
    } else if (learningState.switchPenaltyPct <= 1.5 && (practiceProfile?.avgUniqueScenariosPerBlock ?? 0) >= 2) {
      pushUnique({
        id: "global-switch-strength",
        source: "global",
        title: "You Re-center Quickly After Switches",
        badge: "Context",
        badgeColor: "#00b4ff",
        body: "Your run quality stays stable even when the block changes task. That is a strong sign that your fundamentals transfer cleanly instead of depending on scenario-specific rhythm.",
        tip: "You can afford more contrast work than most players. Keep using controlled interleaving and judge it by next-day quality, not only by instant same-block peaks.",
        confidence: 0.67,
        signals: ["switch_penalty", "context_adaptation"],
      });
    }
  }

  if (learningState.retentionAfterGapPct != null) {
    if (learningState.retentionAfterGapPct < 92) {
      pushUnique({
        id: "global-retention-weak",
        source: "global",
        title: "Breaks Are Costing Too Much Retention",
        badge: "Learning",
        badgeColor: "#ff6b6b",
        body: `After longer breaks, your first settled block comes back at about ${learningState.retentionAfterGapPct.toFixed(0)}% of the previous block's normalized level. Skill is returning, but not staying as sticky as it could.`,
        tip: "Reduce novelty for a week: repeat the same main scenarios on a stable cadence and keep block structure consistent so consolidation has a cleaner signal to retain.",
        confidence: 0.65,
        signals: ["retention_after_gap", "consolidation"],
      });
    } else if (learningState.retentionAfterGapPct >= 98) {
      pushUnique({
        id: "global-retention-strong",
        source: "global",
        title: "Your Skill Retention Is Strong",
        badge: "Learning",
        badgeColor: "#00f5a0",
        body: `After longer breaks, your first settled block comes back at about ${learningState.retentionAfterGapPct.toFixed(0)}% of the previous block's normalized level. That is a strong sign that practice is sticking.`,
        tip: "You can afford to rotate difficulty a bit more aggressively because the learning is surviving the gap, not evaporating between sessions.",
        confidence: 0.61,
        signals: ["retention_after_gap", "consolidation_strength"],
      });
    }
  }

  if (learningState.momentumDeltaPct != null) {
    if (learningState.momentumDeltaPct >= 4) {
      pushUnique({
        id: "global-momentum-up",
        source: "global",
        title: "Cross-Scenario Form Is Rising",
        badge: "Momentum",
        badgeColor: "#00f5a0",
        body: `Your recent settled runs are about ${learningState.momentumDeltaPct.toFixed(0)}% stronger than the chunk before them after normalizing for each scenario. That means the improvement is carrying across tasks, not staying trapped inside one score line.`,
        tip: "This is the moment to raise difficulty slightly or tighten one technical focus. The carryover is real, so you can challenge it without losing the trend.",
        confidence: 0.79,
        signals: ["momentum", "cross_scenario_transfer"],
      });
    } else if (learningState.momentumDeltaPct <= -4) {
      pushUnique({
        id: "global-momentum-down",
        source: "global",
        title: "Global Form Has Cooled Off",
        badge: "Momentum",
        badgeColor: "#ff6b6b",
        body: `Your recent settled runs are about ${Math.abs(learningState.momentumDeltaPct).toFixed(0)}% weaker than the chunk before them across mixed scenarios. That usually points to fatigue, inconsistency, or too much change at once.`,
        tip: "Run a reset week: keep volume steady, simplify the scenario rotation, and lock in one mechanic focus. The goal is to get your normal level back before adding more difficulty.",
        confidence: 0.78,
        signals: ["momentum", "global_form_drop"],
      });
    }
  }

  if (
    cards.length === 0
    && learningState.normalizedVariancePct != null
  ) {
    if (learningState.normalizedVariancePct >= 12) {
      cards.push({
        id: "global-variance-high",
        source: "global",
        title: "Execution Is Swingy Across Scenarios",
        badge: "Consistency",
        badgeColor: "#ff9f43",
        body: `Even after normalizing per scenario, your settled runs still swing by about ${learningState.normalizedVariancePct.toFixed(0)}%. That means the inconsistency is coming from your overall execution, not just from which scenario you queued.`,
        tip: "Tighten the repeatables first: same warm-up, same seating and grip, same first-block structure, and one focus cue for the whole session.",
        confidence: 0.73,
        signals: ["normalized_variance", "execution_consistency"],
      });
    } else {
      cards.push({
        id: "global-stable",
        source: "global",
        title: "Global Practice Looks Stable",
        badge: "Baseline",
        badgeColor: "#00f5a0",
        body: "Recent practice does not show a single major cross-scenario leak. Your training structure, readiness, and carryover look reasonably healthy from the data we have.",
        tip: "Keep the routine steady and push one lever at a time: slightly harder scenarios, slightly cleaner execution, or slightly better spacing between blocks.",
        confidence: 0.56,
        signals: ["stable_baseline"],
      });
    }
  }

  return cards
    .map((card, index) => ({
      card,
      index,
      score:
        (100 - index)
        + preferenceWeight(card, personalization?.preferences)
        + feedbackWeight(card, personalization?.feedback, personalization?.snapshotKind),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.card)
    .slice(0, 6);
}
