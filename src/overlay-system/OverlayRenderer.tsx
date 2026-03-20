import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import type { OverlayStateEnvelope } from "../types/overlayRuntime";
import type { RawPositionPoint } from "../types/mouse";
import type {
  OverlayPreset,
  OverlaySurfaceId,
  OverlayWidgetConfig,
  OverlayWidgetPlacement,
} from "../types/overlayPresets";
import { normalizeTextTransform } from "./presetUtils";

const MOUSE_PATH_API = "http://127.0.0.1:43115/api/streamer-overlay/mouse-path";
const MIN_PROGRESS_FOR_DIRECT_PROJECTION = 0.08;

interface OverlayRendererProps {
  preset: OverlayPreset;
  surface: OverlaySurfaceId;
  state: OverlayStateEnvelope;
  preview?: boolean;
  compatibilityMode?: "default" | "obs";
  coordinateScale?: number;
  widgetFilter?: string[] | null;
  className?: string;
  style?: CSSProperties;
  renderWidgetChrome?: (args: {
    widgetId: string;
    placement: OverlayWidgetPlacement;
    element: ReactNode;
  }) => ReactNode;
}

type WidgetProps = {
  preset: OverlayPreset;
  state: OverlayStateEnvelope;
  preview: boolean;
  compatibilityMode: "default" | "obs";
  config: OverlayWidgetConfig;
};

function alpha(hex: string, opacity: number): string {
  const clean = hex.replace("#", "").trim();
  const normalized = clean.length === 3
    ? clean.split("").map((part) => `${part}${part}`).join("")
    : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return hex;
  const value = Math.min(1, Math.max(0, opacity));
  const red = parseInt(normalized.slice(0, 2), 16);
  const green = parseInt(normalized.slice(2, 4), 16);
  const blue = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${value})`;
}

function cardStyle(
  preset: OverlayPreset,
  emphasis = false,
  compatibilityMode: "default" | "obs" = "default",
): CSSProperties {
  const theme = preset.theme;
  const radius = Math.max(8, theme.corner_radius);
  const blur = Math.max(0, theme.glass_blur);
  const shadowAlpha = Math.min(0.9, 0.18 + theme.shadow_strength * 0.42);
  const backdropValue = blur > 0 ? `blur(${blur}px) saturate(135%)` : undefined;
  const baseShadow = emphasis
    ? `0 18px 48px ${alpha("#000000", shadowAlpha)}`
    : `0 12px 32px ${alpha("#000000", shadowAlpha)}`;
  const glowShadow = emphasis
    ? `0 0 24px ${alpha(theme.glow_color, compatibilityMode === "obs" ? 0.48 : 0.35)}`
    : `0 0 16px ${alpha(theme.glow_color, compatibilityMode === "obs" ? 0.28 : 0.18)}`;
  const backgroundOpacity = compatibilityMode === "obs"
    ? Math.max(0.84, theme.background_opacity)
    : theme.background_opacity;
  return {
    borderRadius: radius,
    border: `1px solid ${alpha(theme.border_color, theme.border_opacity)}`,
    background: `linear-gradient(135deg, ${alpha(theme.background_gradient_start, backgroundOpacity)}, ${alpha(theme.background_gradient_end, Math.max(0.25, backgroundOpacity - 0.12))}), ${alpha(theme.surface_color, compatibilityMode === "obs" ? 0.88 : 0.6)}`,
    backgroundColor: alpha(theme.surface_color, compatibilityMode === "obs" ? 0.88 : 0.6),
    boxShadow: `${baseShadow}, ${glowShadow}`,
    backdropFilter: compatibilityMode === "obs" ? undefined : backdropValue,
    WebkitBackdropFilter: compatibilityMode === "obs" ? undefined : backdropValue,
  };
}

function activeScore(state: OverlayStateEnvelope): number | null {
  if (liveRunActive(state)) {
    return (
      state.stats_panel?.score_total
      ?? state.stats_panel?.score_total_derived
      ?? state.session_result?.score
      ?? null
    );
  }

  return (
    state.session_result?.score
    ?? state.stats_panel?.score_total
    ?? state.stats_panel?.score_total_derived
    ?? null
  );
}

function activeScenarioName(state: OverlayStateEnvelope): string {
  return state.stats_panel?.scenario_name || state.session_result?.scenario || "No scenario";
}

function fmt(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return value.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value.toFixed(1)}%`;
}

function finitePositive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function liveRunActive(state: OverlayStateEnvelope): boolean {
  const stats = state.stats_panel;
  if (!stats) return false;
  return stats.is_in_challenge === true
    || stats.is_in_scenario === true
    || stats.game_state_code === 4
    || stats.game_state_code === 5;
}

function countdownStageActive(state: OverlayStateEnvelope): boolean {
  const stats = state.stats_panel;
  if (!stats) return false;
  const queueRemaining = finitePositive(stats.queue_time_remaining);
  return queueRemaining != null && stats.is_in_challenge !== true && stats.game_state_code !== 4;
}

function pbPaceLiveActive(state: OverlayStateEnvelope): boolean {
  return liveRunActive(state) && !countdownStageActive(state);
}

function activeElapsedSeconds(state: OverlayStateEnvelope, preview: boolean): number | null {
  if (!liveRunActive(state)) {
    const resultDuration = finitePositive(state.session_result?.duration_secs);
    if (resultDuration != null) return resultDuration;
  }

  const challengeElapsed = finitePositive(state.stats_panel?.challenge_seconds_total);
  if (challengeElapsed != null) return challengeElapsed;

  const challengeLength = finitePositive(state.stats_panel?.challenge_time_length);
  const timeRemaining = finitePositive(state.stats_panel?.time_remaining);
  if (challengeLength != null && timeRemaining != null) {
    return Math.max(0, challengeLength - timeRemaining);
  }

  const sessionElapsed = finitePositive(state.stats_panel?.session_time_secs);
  if (sessionElapsed != null) {
    return sessionElapsed;
  }

  return preview ? 33 : null;
}

function activeChallengeLength(state: OverlayStateEnvelope, preview: boolean): number | null {
  const liveLength = finitePositive(state.stats_panel?.challenge_time_length);
  if (liveLength != null) return liveLength;

  if (!liveRunActive(state)) {
    const resultDuration = finitePositive(state.session_result?.duration_secs);
    if (resultDuration != null) return resultDuration;
  }

  const timeRemaining = finitePositive(state.stats_panel?.time_remaining);
  const challengeElapsed = finitePositive(state.stats_panel?.challenge_seconds_total);
  if (challengeElapsed != null && timeRemaining != null) {
    return challengeElapsed + timeRemaining;
  }

  return preview ? 60 : null;
}

function activeTimeRemainingSeconds(state: OverlayStateEnvelope, preview: boolean): number | null {
  const timeRemaining = finitePositive(state.stats_panel?.time_remaining);
  if (timeRemaining != null) return timeRemaining;

  const total = activeChallengeLength(state, preview);
  const elapsed = activeElapsedSeconds(state, preview);
  if (total != null && elapsed != null && Number.isFinite(total) && Number.isFinite(elapsed)) {
    return Math.max(0, total - elapsed);
  }

  return null;
}

function currentLiveSpm(state: OverlayStateEnvelope, preview: boolean): number | null {
  const spm = finitePositive(state.stats_panel?.spm);
  if (spm != null) return spm;

  return preview ? 1502 : null;
}

function activeProgressRatio(state: OverlayStateEnvelope, preview: boolean): number | null {
  const total = activeChallengeLength(state, preview);
  if (total == null || !Number.isFinite(total) || total <= 0) {
    return null;
  }

  const elapsed = activeElapsedSeconds(state, preview);
  if (elapsed == null || !Number.isFinite(elapsed)) {
    const timeRemaining = activeTimeRemainingSeconds(state, preview);
    if (timeRemaining != null && Number.isFinite(timeRemaining)) {
      return Math.max(0, Math.min((total - timeRemaining) / total, 1));
    }
    return null;
  }

  return Math.max(0, Math.min(elapsed / total, 1));
}

function currentProjectedFinalScore(state: OverlayStateEnvelope, preview: boolean): number | null {
  const score = activeScore(state) ?? (preview ? 826 : null);
  if (score == null) return null;
  if (!liveRunActive(state) && state.session_result) return score;

  const total = activeChallengeLength(state, preview);
  if (total != null && Number.isFinite(total) && total > 0) {
    const spm = currentLiveSpm(state, preview);
    if (spm != null && Number.isFinite(spm) && spm > 0) {
      return Math.round((spm * total) / 60);
    }
  }

  const progress = activeProgressRatio(state, preview);
  if (progress != null && progress >= MIN_PROGRESS_FOR_DIRECT_PROJECTION) {
    return Math.round(score / progress);
  }

  return score;
}

function pbPaceSnapshot(state: OverlayStateEnvelope, preview: boolean) {
  const score = activeScore(state) ?? (preview ? 826 : null);
  const pb = state.personal_best_score ?? (preview ? 912 : null);
  const paceLive = preview || pbPaceLiveActive(state);
  const progress = paceLive ? activeProgressRatio(state, preview) : null;
  const projected = paceLive ? currentProjectedFinalScore(state, preview) : null;
  const targetNow = pb != null && progress != null ? pb * progress : null;
  const paceDeltaNow = score != null && targetNow != null ? score - targetNow : null;
  const projectedDelta = projected != null && pb != null ? projected - pb : null;
  const currentSpm = paceLive ? currentLiveSpm(state, preview) : null;
  const total = activeChallengeLength(state, preview);
  const requiredSpm = pb != null && total != null && total > 0 ? pb / (total / 60) : null;
  const liveDelta = paceLive ? paceDeltaNow : null;

  return {
    score,
    pb,
    progress,
    projected,
    targetNow,
    paceDeltaNow,
    projectedDelta,
    liveDelta,
    currentSpm,
    requiredSpm,
  };
}

function templateVars(state: OverlayStateEnvelope, preview: boolean): Record<string, string> {
  const stats = state.stats_panel;
  const session = state.session_result;
  const feedback = state.live_feedback;
  const metrics = state.mouse_metrics;
  const friend = selectedFriendScore(state);
  const benchmarkMatch = state.benchmark_state?.current_scenario_matches?.[0];
  const {
    score,
    pb,
    projected,
    liveDelta,
    projectedDelta,
    currentSpm,
    requiredSpm,
  } = pbPaceSnapshot(state, preview);

  return {
    player_name: state.current_user?.steam_account_name || state.current_user?.username || (preview ? "Streamer Preview" : "Waiting for player"),
    scenario_name: activeScenarioName(state),
    scenario_type: stats?.scenario_type || (preview ? "Dynamic Clicking" : "Idle"),
    score: fmt(score),
    accuracy: fmtPct(stats?.accuracy_pct ?? session?.accuracy ?? (preview ? 93.6 : null)),
    spm: fmt(stats?.spm ?? (preview ? 814 : null)),
    kps: fmt(stats?.kps ?? (preview ? 2.9 : null), 1),
    pb_score: fmt(pb),
    pb_delta: liveDelta == null ? "--" : `${liveDelta >= 0 ? "+" : ""}${fmt(liveDelta)}`,
    projected_score: fmt(projected),
    projected_pb_delta: projectedDelta == null ? "--" : `${projectedDelta >= 0 ? "+" : ""}${fmt(projectedDelta)}`,
    current_spm: fmt(currentSpm),
    required_spm: fmt(requiredSpm),
    friend_name: friend?.name || (preview ? "Rival" : "No opponent"),
    friend_score: fmt(friend?.score ?? (preview ? 947 : null)),
    smoothness: fmt(metrics?.smoothness ?? (preview ? 82 : null)),
    feedback_message: feedback?.message || (preview ? "Relax the micro-correction after each flick." : "Waiting for live signal"),
    feedback_metric: feedback?.metric || (preview ? "live_tip" : "none"),
    last_score: fmt(session?.score ?? (preview ? 942 : null)),
    last_accuracy: fmtPct(session?.accuracy ?? (preview ? 95.1 : null)),
    last_duration: `${fmt(session?.duration_secs ?? (preview ? 60 : null), 1)}s`,
    benchmark_name: benchmarkMatch?.benchmark_name || (preview ? "Voltaic Intermediate" : "No benchmark"),
    benchmark_rank: benchmarkMatch?.rank_name || (preview ? "Emerald" : "Unranked"),
    benchmark_score: fmt(benchmarkMatch?.score ?? (preview ? 826 : null)),
  };
}

function resolveTemplate(
  template: string | undefined,
  state: OverlayStateEnvelope,
  preview: boolean,
): string | null {
  if (!template?.trim()) return null;
  const vars = templateVars(state, preview);
  const resolved = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    return vars[key] ?? "";
  }).trim();
  return resolved || null;
}

function boundText(
  config: OverlayWidgetConfig,
  key: string,
  fallback: string,
  state: OverlayStateEnvelope,
  preview: boolean,
): string {
  return resolveTemplate(config.data_bindings?.[key], state, preview) || fallback;
}

function selectedFriendScore(state: OverlayStateEnvelope): { name: string; score: number | null } | null {
  const selected = state.selected_friend
    ? state.friends.find((friend) => friend.username === state.selected_friend)
    : null;
  if (!selected) return null;
  const match = state.friend_scores?.entries.find((entry) =>
    selected.steam_id
      ? entry.steam_id === selected.steam_id
      : entry.steam_account_name.toLowerCase() === (selected.steam_account_name || selected.username).toLowerCase()
  );
  return {
    name: selected.steam_account_name || selected.username,
    score: match?.score ?? null,
  };
}

function WidgetFrame({
  preset,
  config,
  compatibilityMode,
  title,
  eyebrow,
  emphasis = false,
  children,
}: {
  preset: OverlayPreset;
  config: OverlayWidgetConfig;
  compatibilityMode: "default" | "obs";
  title?: string;
  eyebrow?: string;
  emphasis?: boolean;
  children: ReactNode;
}) {
  const theme = preset.theme;
  const widgetStyle = config.style_overrides;
  const textTransform = normalizeTextTransform(theme.text_transform_mode);
  const frameStyle = cardStyle(preset, emphasis, compatibilityMode);
  return (
    <div
      style={{
        ...frameStyle,
        color: theme.text_color,
        padding: `${12 * theme.spacing_scale * widgetStyle.padding}px ${14 * theme.spacing_scale * widgetStyle.padding}px`,
        overflow: "hidden",
        background: widgetStyle.show_background ? frameStyle.background : "transparent",
        backgroundColor: widgetStyle.show_background ? frameStyle.backgroundColor : "transparent",
        border: widgetStyle.show_border
          ? frameStyle.border
          : "1px solid transparent",
        boxShadow: widgetStyle.show_glow ? frameStyle.boxShadow : undefined,
        opacity: widgetStyle.opacity,
      }}
    >
      {(eyebrow || title) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 10 * theme.spacing_scale }}>
          {eyebrow ? (
            <div
              style={{
                color: theme.muted_text_color,
                fontSize: 10 * theme.font_weight_scale * widgetStyle.font_scale,
                letterSpacing: "0.16em",
                textTransform,
                opacity: 0.88,
                textShadow: widgetStyle.show_glow ? `0 0 12px ${alpha(theme.glow_color, compatibilityMode === "obs" ? 0.24 : 0.14)}` : undefined,
              }}
            >
              {eyebrow}
            </div>
          ) : null}
          {title ? (
            <div
              style={{
                color: theme.text_color,
                fontSize: 18 * theme.font_weight_scale * widgetStyle.font_scale,
                fontWeight: 700,
                lineHeight: 1.05,
                textShadow: widgetStyle.show_glow ? `0 0 16px ${alpha(theme.glow_color, compatibilityMode === "obs" ? 0.22 : 0.12)}` : undefined,
              }}
            >
              {title}
            </div>
          ) : null}
        </div>
      )}
      {children}
    </div>
  );
}

function HeaderWidget({ preset, state, preview, compatibilityMode, config }: WidgetProps) {
  const title = boundText(
    config,
    "title_template",
    state.current_user?.steam_account_name || state.current_user?.username || (preview ? "Streamer Preview" : "Waiting for player"),
    state,
    preview,
  );
  const line1 = boundText(config, "subtitle_template", activeScenarioName(state), state, preview);
  const line2 = boundText(
    config,
    "body_template",
    `${state.stats_panel?.scenario_type || (preview ? "Dynamic Clicking" : "Idle")}${state.stats_panel?.scenario_subtype ? ` · ${state.stats_panel.scenario_subtype}` : ""}`,
    state,
    preview,
  );
  return (
    <WidgetFrame
      preset={preset}
      config={config}
      eyebrow={boundText(config, "eyebrow_template", "AimMod Overlay", state, preview)}
      title={title}
      emphasis
      compatibilityMode={compatibilityMode}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10 }}>
        <div>
          <div style={{ opacity: 0.8 }}>{line1}</div>
          <div style={{ opacity: 0.65, fontSize: 12 }}>
            {line2}
          </div>
        </div>
        <div
          style={{
            color: preset.theme.primary_color,
            fontWeight: 800,
            fontSize: 28,
            lineHeight: 1,
          }}
        >
          {fmt(activeScore(state))}
        </div>
      </div>
    </WidgetFrame>
  );
}

function StatPill({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 10px",
        borderRadius: 12,
        background: alpha("#ffffff", 0.04),
        border: `1px solid ${alpha(color || "#ffffff", 0.18)}`,
      }}
    >
      <span style={{ fontSize: 10, letterSpacing: "0.12em", opacity: 0.72 }}>{label}</span>
      <span style={{ fontSize: 16, fontWeight: 700, color: color || "inherit" }}>{value}</span>
    </div>
  );
}

function LiveStatsWidget({ preset, state, preview, compatibilityMode, config }: WidgetProps) {
  const stats = state.stats_panel;
  return (
    <WidgetFrame
      preset={preset}
      config={config}
      eyebrow={boundText(config, "eyebrow_template", "Live Stats", state, preview)}
      title={resolveTemplate(config.data_bindings?.title_template, state, preview) || (preview && !stats ? "Practice Snapshot" : undefined)}
      compatibilityMode={compatibilityMode}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <StatPill label="Score" value={fmt(activeScore(state))} color={preset.theme.primary_color} />
        <StatPill label="ACC" value={fmtPct(stats?.accuracy_pct ?? (preview ? 93.6 : null))} />
        <StatPill label="SPM" value={fmt(stats?.spm ?? (preview ? 814 : null))} />
        <StatPill label="KPS" value={fmt(stats?.kps ?? (preview ? 2.9 : null), 1)} />
      </div>
    </WidgetFrame>
  );
}

function ProgressBarWidget({ preset, state, preview, compatibilityMode, config }: WidgetProps) {
  const stats = state.stats_panel;
  const total = stats?.challenge_time_length ?? 60;
  const elapsed = stats?.challenge_seconds_total ?? stats?.session_time_secs ?? (preview ? 33 : 0);
  const progress = total > 0 ? Math.max(0, Math.min(elapsed / total, 1)) : 0;
  return (
    <WidgetFrame preset={preset} config={config} eyebrow={boundText(config, "eyebrow_template", "Scenario Progress", state, preview)} compatibilityMode={compatibilityMode}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
        <span>{boundText(config, "title_template", activeScenarioName(state), state, preview)}</span>
        <span style={{ color: preset.theme.primary_color }}>
          {fmt(elapsed, 1)}s / {fmt(total, 1)}s
        </span>
      </div>
      <div style={{ height: 12, borderRadius: 999, background: alpha("#ffffff", 0.08), overflow: "hidden" }}>
        <div
          style={{
            width: `${progress * 100}%`,
            height: "100%",
            background: `linear-gradient(90deg, ${preset.theme.primary_color}, ${preset.theme.accent_color})`,
          }}
        />
      </div>
    </WidgetFrame>
  );
}

function PbPaceWidget({ preset, state, preview, compatibilityMode, config }: WidgetProps) {
  const liveSession = pbPaceLiveActive(state);
  const countdownActive = countdownStageActive(state);
  const snapshot = pbPaceSnapshot(state, preview);
  const lockedSnapshotRef = useRef<ReturnType<typeof pbPaceSnapshot> | null>(null);
  const previousLiveRef = useRef(false);

  const hasMeaningfulLiveSnapshot =
    (snapshot.score != null && snapshot.score > 0)
    || (snapshot.projected != null && snapshot.projected > 0)
    || (snapshot.currentSpm != null && snapshot.currentSpm > 0);

  if (liveSession && hasMeaningfulLiveSnapshot) {
    lockedSnapshotRef.current = snapshot;
  }

  if (!liveSession && previousLiveRef.current && lockedSnapshotRef.current == null && hasMeaningfulLiveSnapshot) {
    lockedSnapshotRef.current = snapshot;
  }

  previousLiveRef.current = liveSession;

  const shouldUseLockedSnapshot =
    !liveSession
    && lockedSnapshotRef.current != null
    && !countdownActive
    && (
      (snapshot.score == null || snapshot.score <= 0)
      || (snapshot.currentSpm == null || snapshot.currentSpm <= 0)
      || (snapshot.projected == null || snapshot.projected <= 0)
      || state.session_result != null
    );

  const displaySnapshot = shouldUseLockedSnapshot
    ? (lockedSnapshotRef.current ?? snapshot)
    : snapshot;

  const {
    pb,
    projected,
    liveDelta,
    projectedDelta,
    currentSpm,
    requiredSpm,
  } = displaySnapshot;

  const delta = liveSession || shouldUseLockedSnapshot ? liveDelta : projectedDelta;
  const titleValue = liveSession || shouldUseLockedSnapshot
    ? fmt(projected)
    : fmt(activeScore(state) ?? projected);
  const subtitleValue = liveSession || shouldUseLockedSnapshot
    ? `PB ${fmt(pb)} · ${fmt(currentSpm)} / ${fmt(requiredSpm)} spm`
    : `Personal best ${fmt(pb)}`;
  return (
    <WidgetFrame preset={preset} config={config} eyebrow={boundText(config, "eyebrow_template", "PB Pace", state, preview)} compatibilityMode={compatibilityMode}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 800, color: preset.theme.primary_color }}>
            {boundText(config, "title_template", titleValue, state, preview)}
          </div>
          <div style={{ opacity: 0.72, fontSize: 12 }}>
            {boundText(config, "subtitle_template", subtitleValue, state, preview)}
          </div>
        </div>
        <div
          style={{
            fontSize: 22,
            fontWeight: 800,
            color:
              delta == null
                ? preset.theme.muted_text_color
                : delta >= 0
                  ? preset.theme.primary_color
                  : preset.theme.danger_color,
          }}
        >
          {delta == null ? "--" : `${delta >= 0 ? "+" : ""}${fmt(delta)}`}
        </div>
      </div>
    </WidgetFrame>
  );
}

function VsModeWidget({ preset, state, preview, compatibilityMode, config }: WidgetProps) {
  const friend = selectedFriendScore(state) ?? (preview ? { name: "Rival", score: 947 } : null);
  return (
    <WidgetFrame preset={preset} config={config} eyebrow={boundText(config, "eyebrow_template", "Battle", state, preview)} compatibilityMode={compatibilityMode}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
        <div>
          <div style={{ opacity: 0.68, fontSize: 12 }}>Against</div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>
            {boundText(config, "title_template", friend?.name || "No opponent selected", state, preview)}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ opacity: 0.68, fontSize: 12 }}>Target</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: preset.theme.accent_color }}>
            {fmt(friend?.score ?? null)}
          </div>
        </div>
      </div>
    </WidgetFrame>
  );
}

function SmoothnessWidget({ preset, state, preview, compatibilityMode, config }: WidgetProps) {
  const metrics = state.mouse_metrics;
  const score = metrics?.smoothness ?? (preview ? 82 : null);
  return (
    <WidgetFrame preset={preset} config={config} eyebrow={boundText(config, "eyebrow_template", "Smoothness", state, preview)} compatibilityMode={compatibilityMode}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div style={{ fontSize: 34, fontWeight: 800, color: preset.theme.primary_color }}>
          {boundText(config, "title_template", fmt(score), state, preview)}
        </div>
        <div style={{ textAlign: "right", fontSize: 12, opacity: 0.76 }}>
          <div>Path {fmt((metrics?.path_efficiency ?? (preview ? 0.91 : null)) != null ? (metrics?.path_efficiency ?? 0.91) * 100 : null, 0)}%</div>
          <div>Wobble {fmt(metrics?.jitter ?? (preview ? 0.18 : null), 2)}</div>
        </div>
      </div>
    </WidgetFrame>
  );
}

function CoachingWidget({ preset, state, preview, compatibilityMode, config }: WidgetProps) {
  const feedback = state.live_feedback ?? (preview ? { message: "Relax the micro-correction after each flick.", kind: "tip", metric: "correction_ratio" } : null);
  const color =
    feedback?.kind === "warning"
      ? preset.theme.danger_color
      : feedback?.kind === "positive"
        ? preset.theme.primary_color
        : preset.theme.warning_color;

  return (
    <WidgetFrame
      preset={preset}
      config={config}
      compatibilityMode={compatibilityMode}
      eyebrow={boundText(config, "eyebrow_template", "Coaching", state, preview)}
      title={boundText(config, "title_template", feedback?.metric || (preview ? "Live tip" : "Waiting for live signal"), state, preview)}
    >
      <div style={{ color: color || preset.theme.text_color, lineHeight: 1.5 }}>
        {boundText(
          config,
          "body_template",
          feedback?.message || "AimMod will show live coaching here when it has enough session data.",
          state,
          preview,
        )}
      </div>
    </WidgetFrame>
  );
}

function BenchmarkCurrentWidget({ preset, state, preview, compatibilityMode, config }: WidgetProps) {
  const benchmarkState = state.benchmark_state;
  const matches = benchmarkState?.current_scenario_matches?.length
    ? benchmarkState.current_scenario_matches
    : [];

  return (
    <WidgetFrame
      preset={preset}
      config={config}
      compatibilityMode={compatibilityMode}
      eyebrow={boundText(config, "eyebrow_template", "Benchmarks", state, preview)}
      title={boundText(config, "title_template", state.benchmark_state?.scenario_name || activeScenarioName(state), state, preview)}
    >
      {matches.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {matches.map((match) => (
            <div
              key={`${match.benchmark_id}:${match.category_name}:${match.scenario_name}`}
              style={{
                borderRadius: 14,
                border: `1px solid ${alpha(match.rank_color || preset.theme.primary_color, 0.35)}`,
                background: alpha("#ffffff", 0.035),
                padding: "10px 12px",
              }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "start" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{match.benchmark_name}</div>
                  <div style={{ marginTop: 2, fontSize: 11, opacity: 0.7 }}>{match.category_name}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: match.rank_color || preset.theme.primary_color }}>
                    {match.rank_name || "Unranked"}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.72 }}>{fmt(match.score)}</div>
                </div>
              </div>
              <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, opacity: 0.76 }}>
                <span>{match.leaderboard_rank > 0 ? `Top ${match.leaderboard_rank.toLocaleString()}` : "No leaderboard rank"}</span>
                <span>
                  {match.next_threshold_name && match.next_threshold_score != null
                    ? `${match.next_threshold_name} ${fmt(match.next_threshold_score)}`
                    : "Top tier reached"}
                </span>
              </div>
              {match.progress_pct != null ? (
                <div style={{ marginTop: 8, height: 8, borderRadius: 999, background: alpha("#ffffff", 0.08), overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${match.progress_pct}%`,
                      height: "100%",
                      background: `linear-gradient(90deg, ${preset.theme.primary_color}, ${preset.theme.accent_color})`,
                    }}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ color: preset.theme.muted_text_color, lineHeight: 1.55 }}>
          {benchmarkState?.last_error
            || (benchmarkState?.loading
              ? "Loading benchmark progress..."
              : benchmarkState?.selected_benchmark_ids?.length
                ? "This scenario is not part of the selected benchmark set."
                : preview
                  ? "Select one or more benchmarks in Overlay Studio to preview live benchmark progress here."
                  : "Select one or more benchmarks in Overlay Studio to show live benchmark progress.")}
        </div>
      )}
    </WidgetFrame>
  );
}

function BenchmarkPageWidget({ preset, state, preview, compatibilityMode, config }: WidgetProps) {
  const benchmarkState = state.benchmark_state;
  const page = (() => {
    if (benchmarkState?.matching_pages?.length) {
      return benchmarkState.matching_pages.find((entry) => entry.benchmarkId === benchmarkState.primary_benchmark_id)
        || benchmarkState.matching_pages[0];
    }
    if (benchmarkState?.pages?.length) {
      return benchmarkState.pages.find((entry) => entry.benchmarkId === benchmarkState.primary_benchmark_id)
        || benchmarkState.pages[0];
    }
    return null;
  })();

  if (!page) {
    return (
      <WidgetFrame
        preset={preset}
        config={config}
        compatibilityMode={compatibilityMode}
        eyebrow={boundText(config, "eyebrow_template", "Benchmark Page", state, preview)}
        title="No benchmark page selected"
      >
        <div style={{ color: preset.theme.muted_text_color, lineHeight: 1.55 }}>
          {benchmarkState?.last_error
            || (benchmarkState?.loading
              ? "Loading benchmark page..."
              : benchmarkState?.selected_benchmark_ids?.length
                ? "No selected benchmark page is available for the current runtime yet."
                : "Select benchmarks in Overlay Studio. This widget will render the chosen benchmark page and highlight the current scenario when it appears there.")}
        </div>
      </WidgetFrame>
    );
  }

  const currentScenarioSlug = activeScenarioName(state).trim().toLowerCase();
  return (
    <WidgetFrame
      preset={preset}
      config={config}
      compatibilityMode={compatibilityMode}
      eyebrow={boundText(config, "eyebrow_template", "Benchmark Page", state, preview)}
      title={boundText(config, "title_template", page.benchmarkName, state, preview)}
      emphasis
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 12, opacity: 0.72 }}>
          {page.kovaaksUsername || state.current_user?.steam_account_name || state.current_user?.username || "Current player"}
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, color: page.overallRankColor || preset.theme.primary_color }}>
          {page.overallRankName || "Unranked"}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 520, overflow: "hidden" }}>
        {page.categories.map((category) => (
          <div
            key={`${page.benchmarkId}:${category.categoryName}`}
            style={{
              borderRadius: 14,
              border: `1px solid ${alpha(preset.theme.border_color, 0.24)}`,
              background: alpha("#ffffff", 0.03),
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "10px 12px",
                borderBottom: `1px solid ${alpha(preset.theme.border_color, 0.14)}`,
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 10,
                alignItems: "center",
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700 }}>{category.categoryName}</div>
              <div style={{ fontSize: 11, color: preset.theme.primary_color }}>NRG {category.categoryRank || "--"}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {category.scenarios.map((scenario) => {
                const active = scenario.scenarioName.trim().toLowerCase() === currentScenarioSlug;
                return (
                  <div
                    key={`${category.categoryName}:${scenario.scenarioName}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1fr) auto auto",
                      gap: 10,
                      alignItems: "center",
                      padding: "9px 12px",
                      borderTop: `1px solid ${alpha(preset.theme.border_color, 0.08)}`,
                      background: active ? alpha(preset.theme.primary_color, 0.08) : "transparent",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 11.5, fontWeight: active ? 800 : 600, color: active ? preset.theme.primary_color : preset.theme.text_color }}>
                        {scenario.scenarioName}
                      </div>
                      <div style={{ fontSize: 10, opacity: 0.62 }}>
                        {scenario.leaderboardRank > 0 ? `Top ${scenario.leaderboardRank.toLocaleString()}` : "Unranked leaderboard"}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{fmt(scenario.score)}</div>
                    <div style={{ fontSize: 11, color: scenario.rankColor || preset.theme.accent_color, minWidth: 64, textAlign: "right" }}>
                      {scenario.rankName || "Unranked"}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </WidgetFrame>
  );
}

function PostRunSummaryWidget({ preset, state, preview, compatibilityMode, config }: WidgetProps) {
  const result = state.session_result;
  return (
    <WidgetFrame
      preset={preset}
      config={config}
      compatibilityMode={compatibilityMode}
      eyebrow={boundText(config, "eyebrow_template", "Post-Run Summary", state, preview)}
      title={boundText(config, "title_template", result?.scenario || (preview ? "VT Pasu Small" : "No recent run"), state, preview)}
      emphasis
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <StatPill label="Score" value={fmt(result?.score ?? (preview ? 942 : null))} color={preset.theme.primary_color} />
        <StatPill label="ACC" value={fmtPct(result?.accuracy ?? (preview ? 95.1 : null))} />
        <StatPill label="Time" value={`${fmt(result?.duration_secs ?? (preview ? 60 : null), 1)}s`} />
      </div>
    </WidgetFrame>
  );
}

// ─── Preview path: Lissajous-like figure with click points ───────────────────
const MOUSE_PATH_PREVIEW: RawPositionPoint[] = (() => {
  const pts: RawPositionPoint[] = [];
  const n = 240;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 4;
    pts.push({
      x: Math.cos(t) * 90 + Math.sin(t * 0.71) * 38 + Math.cos(t * 2.3) * 14,
      y: Math.sin(t) * 64 + Math.cos(t * 1.27) * 28 + Math.sin(t * 1.9) * 10,
      timestamp_ms: i * 12,
      is_click: i % 53 === 0 || i % 79 === 0,
    });
  }
  return pts;
})();

function speedColor(t: number, alpha = 1): string {
  // blue → cyan → green → yellow → red
  let r: number, g: number, b: number;
  const s = Math.min(1, Math.max(0, t));
  if (s < 0.25) {
    const u = s / 0.25;
    r = 0; g = Math.round(255 * u); b = 255;
  } else if (s < 0.5) {
    const u = (s - 0.25) / 0.25;
    r = 0; g = 255; b = Math.round(255 * (1 - u));
  } else if (s < 0.75) {
    const u = (s - 0.5) / 0.25;
    r = Math.round(255 * u); g = 255; b = 0;
  } else {
    const u = (s - 0.75) / 0.25;
    r = 255; g = Math.round(255 * (1 - u)); b = 0;
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawMousePath(
  canvas: HTMLCanvasElement,
  pts: RawPositionPoint[],
  accentColor: string,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (pts.length < 2) {
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.font = `${Math.round(W / 22)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No session active", W / 2, H / 2);
    return;
  }

  // Bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const pad = 10;
  const uniformScale = Math.min((W - pad * 2) / rangeX, (H - pad * 2) / rangeY);
  const offX = pad + ((W - pad * 2) - rangeX * uniformScale) / 2;
  const offY = pad + ((H - pad * 2) - rangeY * uniformScale) / 2;
  const toC = (p: RawPositionPoint) => ({
    cx: offX + (p.x - minX) * uniformScale,
    cy: offY + (p.y - minY) * uniformScale,
  });

  // Speed per segment
  const speeds: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const dt = Math.max(1, pts[i].timestamp_ms - pts[i - 1].timestamp_ms);
    speeds.push(Math.sqrt(dx * dx + dy * dy) / dt);
  }
  const maxSpd = Math.max(...speeds, 1);

  // Age-based alpha: newest points are fully opaque, oldest fade to ~20%
  const latestTs = pts[pts.length - 1].timestamp_ms;
  const spanMs = Math.max(1, latestTs - pts[0].timestamp_ms);

  // Draw path
  for (let i = 1; i < pts.length; i++) {
    const prev = toC(pts[i - 1]);
    const curr = toC(pts[i]);
    const age = (latestTs - pts[i].timestamp_ms) / spanMs; // 0=newest, 1=oldest
    const alpha = 0.2 + 0.8 * (1 - age);
    ctx.beginPath();
    ctx.moveTo(prev.cx, prev.cy);
    ctx.lineTo(curr.cx, curr.cy);
    ctx.strokeStyle = speedColor(speeds[i] / maxSpd, alpha);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Click markers
  for (const p of pts) {
    if (!p.is_click) continue;
    const { cx, cy } = toC(p);
    const age = (latestTs - p.timestamp_ms) / spanMs;
    const alpha = 0.3 + 0.7 * (1 - age);
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,220,50,${alpha})`;
    ctx.fill();
  }

  // Current position dot
  const last = toC(pts[pts.length - 1]);
  ctx.beginPath();
  ctx.arc(last.cx, last.cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = accentColor || "#00f5a0";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(last.cx, last.cy, 4, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function MousePathWidget({ preset, state, preview }: WidgetProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const posRef = useRef<RawPositionPoint[]>([]);
  const inSession = !!(state.stats_panel?.is_in_scenario || state.stats_panel?.is_in_challenge);

  // Poll live positions
  useEffect(() => {
    if (preview) return;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(MOUSE_PATH_API, { cache: "no-store" });
        if (res.ok) posRef.current = (await res.json()) as RawPositionPoint[];
      } catch {}
      if (alive) setTimeout(poll, 100);
    };
    void poll();
    return () => { alive = false; };
  }, [preview]);

  // Sync canvas pixel size to CSS layout size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sync = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let handle = 0;
    const frame = () => {
      const pts = preview ? MOUSE_PATH_PREVIEW : posRef.current;
      const isActive = preview || inSession || pts.length > 0;
      if (isActive) drawMousePath(canvas, pts, preset.theme.accent_color);
      handle = requestAnimationFrame(frame);
    };
    handle = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(handle);
  }, [preview, inSession, preset.theme.accent_color]);

  const theme = preset.theme;
  return (
    <div
      style={{
        borderRadius: Math.max(8, theme.corner_radius),
        overflow: "hidden",
        background: `rgba(0,0,0,${Math.min(0.7, theme.background_opacity + 0.2)})`,
        border: `1px solid rgba(255,255,255,0.08)`,
      }}
    >
      <div
        style={{
          padding: "5px 8px 3px",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: theme.accent_color,
          opacity: 0.8,
        }}
      >
        Live Path
      </div>
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: "100%",
          aspectRatio: "16/9",
        }}
      />
    </div>
  );
}

const WIDGET_COMPONENTS: Record<string, (props: WidgetProps) => ReactNode> = {
  header: HeaderWidget,
  live_stats: LiveStatsWidget,
  progress_bar: ProgressBarWidget,
  pb_pace: PbPaceWidget,
  vsmode: VsModeWidget,
  smoothness: SmoothnessWidget,
  coaching_toast: CoachingWidget,
  post_run_summary: PostRunSummaryWidget,
  benchmark_current: BenchmarkCurrentWidget,
  benchmark_page: BenchmarkPageWidget,
  mouse_path: MousePathWidget,
};

function widgetContainerStyle(
  placement: OverlayWidgetPlacement,
  preview: boolean,
  coordinateScale: number,
): CSSProperties {
  return {
    position: "absolute",
    left: placement.x * coordinateScale,
    top: placement.y * coordinateScale,
    width: placement.width * coordinateScale,
    transform: `scale(${placement.scale})`,
    transformOrigin: "top left",
    zIndex: placement.z_index,
    opacity: placement.opacity,
    pointerEvents: preview ? "auto" : "none",
  };
}

export function OverlayRenderer({
  preset,
  surface,
  state,
  preview = false,
  compatibilityMode = "default",
  coordinateScale = 1,
  widgetFilter,
  className,
  style,
  renderWidgetChrome,
}: OverlayRendererProps) {
  const countdownCompensationRef = useRef<{
    scenarioName: string | null;
    lastRawElapsed: number | null;
    countdownOffset: number;
    stableChallengeLength: number | null;
    lastCorrectedElapsed: number | null;
  }>({
    scenarioName: null,
    lastRawElapsed: null,
    countdownOffset: 0,
    stableChallengeLength: null,
    lastCorrectedElapsed: null,
  });

  useEffect(() => {
    const stats = state.stats_panel;
    const rawElapsed = finiteNonNegative(stats?.challenge_seconds_total);
    const queueRemaining = finitePositive(stats?.queue_time_remaining);
    const rawChallengeLength = finitePositive(stats?.challenge_time_length);
    const scenarioName = stats?.scenario_name?.trim() || null;
    const active = liveRunActive(state);
    const tracker = countdownCompensationRef.current;

    if (!active) {
      tracker.scenarioName = scenarioName;
      tracker.lastRawElapsed = rawElapsed;
      tracker.countdownOffset = 0;
      tracker.stableChallengeLength = rawChallengeLength;
      tracker.lastCorrectedElapsed = rawElapsed;
      return;
    }

    const scenarioChanged = tracker.scenarioName !== scenarioName;
    const elapsedReset = rawElapsed != null
      && tracker.lastRawElapsed != null
      && rawElapsed + 0.5 < tracker.lastRawElapsed;

    if (scenarioChanged || elapsedReset) {
      tracker.countdownOffset = 0;
      tracker.lastCorrectedElapsed = null;
      tracker.stableChallengeLength = rawChallengeLength;
    }

    if (rawChallengeLength != null) {
      tracker.stableChallengeLength = rawChallengeLength;
    }

    const authoritativeChallengeActive =
      stats?.is_in_challenge === true
      || stats?.game_state_code === 4;
    const queueStageActive =
      !authoritativeChallengeActive
      && (stats?.game_state_code === 2 || queueRemaining != null);

    if (queueStageActive && rawElapsed != null) {
      tracker.countdownOffset = Math.max(tracker.countdownOffset, rawElapsed);
    }

    if (rawElapsed != null) {
      const correctedElapsed = Math.max(0, rawElapsed - tracker.countdownOffset);
      if (
        tracker.lastCorrectedElapsed != null
        && correctedElapsed + 0.35 < tracker.lastCorrectedElapsed
        && !elapsedReset
      ) {
        tracker.lastCorrectedElapsed = tracker.lastCorrectedElapsed;
      } else {
        tracker.lastCorrectedElapsed = tracker.lastCorrectedElapsed == null
          ? correctedElapsed
          : Math.max(tracker.lastCorrectedElapsed, correctedElapsed);
      }
    }

    tracker.scenarioName = scenarioName;
    tracker.lastRawElapsed = rawElapsed;
  }, [
    state.stats_panel?.challenge_seconds_total,
    state.stats_panel?.challenge_time_length,
    state.stats_panel?.queue_time_remaining,
    state.stats_panel?.scenario_name,
    state.stats_panel?.score_total,
    state.stats_panel?.score_total_derived,
    state.stats_panel?.spm,
    state.stats_panel?.is_in_challenge,
    state.stats_panel?.is_in_scenario,
    state.stats_panel?.game_state_code,
  ]);

  const normalizedState = useMemo<OverlayStateEnvelope>(() => {
    const stats = state.stats_panel;
    const rawElapsed = finiteNonNegative(stats?.challenge_seconds_total);
    if (!stats) {
      return state;
    }

    const tracker = countdownCompensationRef.current;
    const correctedElapsed = rawElapsed != null
      ? (tracker.lastCorrectedElapsed ?? Math.max(0, rawElapsed - tracker.countdownOffset))
      : stats.challenge_seconds_total;
    const stableChallengeLength = tracker.stableChallengeLength ?? stats.challenge_time_length;

    const elapsedUnchanged =
      (correctedElapsed == null && stats.challenge_seconds_total == null)
      || (correctedElapsed != null
        && stats.challenge_seconds_total != null
        && Math.abs(correctedElapsed - stats.challenge_seconds_total) < 0.0001);
    const lengthUnchanged =
      (stableChallengeLength == null && stats.challenge_time_length == null)
      || (stableChallengeLength != null
        && stats.challenge_time_length != null
        && Math.abs(stableChallengeLength - stats.challenge_time_length) < 0.0001);

    if (elapsedUnchanged && lengthUnchanged) {
      return state;
    }

    return {
      ...state,
      stats_panel: {
        ...stats,
        challenge_seconds_total: correctedElapsed,
        challenge_time_length: stableChallengeLength,
      },
    };
  }, [state]);

  const surfaceVariant = preset.surface_variants[surface];
  const theme = preset.theme;
  const allowedWidgets = widgetFilter?.length ? new Set(widgetFilter) : null;
  const rootStyle: CSSProperties = {
    position: "relative",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    fontFamily: theme.font_family,
    color: theme.text_color,
    ...style,
  };

  return (
    <div className={className} style={rootStyle}>
      {Object.entries(surfaceVariant?.widget_layouts ?? {}).map(([widgetId, placement]) => {
        const config = preset.widgets[widgetId];
        const Component = WIDGET_COMPONENTS[config?.widget_type || widgetId];
        if (!config || !Component) return null;
        if (allowedWidgets && !allowedWidgets.has(widgetId)) return null;
        if (!placement.visible) return null;
        const element = (
          <div key={widgetId} style={widgetContainerStyle(placement, preview, coordinateScale)}>
            <Component
              preset={preset}
              state={normalizedState}
              preview={preview}
              compatibilityMode={compatibilityMode}
              config={config}
            />
          </div>
        );
        return renderWidgetChrome
          ? renderWidgetChrome({ widgetId, placement, element })
          : element;
      })}
    </div>
  );
}
