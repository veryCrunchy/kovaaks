import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Btn, Badge } from "../design/ui";
import { C, SCENARIO_LABELS, accentAlpha } from "../design/tokens";

type HubKind = "profile" | "scenario" | "benchmark" | "playerScenario" | "run" | "replay";
type HubFilter = "all" | "profiles" | "scenarios" | "runs" | "replays";

interface HubRunPreview {
  sessionId: string;
  scenarioName: string;
  scenarioType: string;
  playedAtIso: string;
  score: number;
  accuracy: number;
  durationMs: number;
  userHandle: string;
  userDisplayName: string;
  runId: string;
}

interface HubTopScenario {
  scenarioName: string;
  scenarioSlug: string;
  scenarioType: string;
  runCount: number;
}

interface HubBenchmarkRankVisual {
  rankIndex: number;
  rankName: string;
  iconUrl: string;
  color: string;
  frameUrl: string;
}

interface HubBenchmarkSummary {
  benchmarkId: number;
  benchmarkName: string;
  benchmarkIconUrl: string;
  benchmarkAuthor: string;
  benchmarkType: string;
  overallRank: HubBenchmarkRankVisual | null;
}

interface HubBenchmarkThreshold {
  rankIndex: number;
  rankName: string;
  score: number;
  iconUrl: string;
  color: string;
}

interface HubBenchmarkScenarioEntry {
  scenarioName: string;
  scenarioSlug: string;
  score: number;
  leaderboardRank: number;
  scenarioRank: HubBenchmarkRankVisual | null;
  thresholds: HubBenchmarkThreshold[];
}

interface HubBenchmarkCategoryPage {
  categoryName: string;
  scenarios: HubBenchmarkScenarioEntry[];
}

interface HubBenchmarkPageResponse {
  userHandle: string;
  userDisplayName: string;
  benchmarkId: number;
  benchmarkName: string;
  benchmarkAuthor: string;
  benchmarkType: string;
  benchmarkIconUrl: string;
  overallRank: HubBenchmarkRankVisual | null;
  categories: HubBenchmarkCategoryPage[];
}

interface HubScenarioBenchmarkRank {
  benchmarkId: number;
  benchmarkName: string;
  benchmarkIconUrl: string;
  categoryName: string;
  scenarioScore: number;
  leaderboardRank: number;
  leaderboardId: number;
  scenarioRank: HubBenchmarkRankVisual | null;
}

interface HubCommunityProfilePreview {
  userHandle: string;
  userDisplayName: string;
  avatarUrl: string;
  runCount: number;
  scenarioCount: number;
  primaryScenarioType: string;
}

interface HubOverviewResponse {
  totalRuns: number;
  totalScenarios: number;
  totalPlayers: number;
  recentRuns: HubRunPreview[];
  topScenarios: HubTopScenario[];
  activeProfiles: HubCommunityProfilePreview[];
}

interface HubSearchScenarioResult {
  scenarioName: string;
  scenarioSlug: string;
  scenarioType: string;
  runCount: number;
}

interface HubSearchProfileResult {
  userHandle: string;
  userDisplayName: string;
  avatarUrl: string;
  runCount: number;
  scenarioCount: number;
  primaryScenarioType: string;
}

interface HubReplayPreview {
  publicRunId: string;
  sessionId: string;
  scenarioSlug: string;
  scenarioName: string;
  scenarioType: string;
  playedAtIso: string;
  score: number;
  accuracy: number;
  durationMs: number;
  userHandle: string;
  userDisplayName: string;
  hasVideo: boolean;
  hasMousePath: boolean;
  replayQuality: string;
}

interface HubSearchResponse {
  query: string;
  scenarios: HubSearchScenarioResult[];
  profiles: HubSearchProfileResult[];
  runs: HubReplayPreview[];
  replays: HubReplayPreview[];
}

interface HubScenarioPageResponse {
  scenarioName: string;
  scenarioSlug: string;
  scenarioType: string;
  runCount: number;
  bestScore: number;
  averageScore: number;
  averageAccuracy: number;
  averageDurationMs: number;
  recentRuns: HubRunPreview[];
  topRuns: HubRunPreview[];
}

interface HubProfileResponse {
  userExternalId: string;
  userHandle: string;
  userDisplayName: string;
  avatarUrl: string;
  runCount: number;
  scenarioCount: number;
  primaryScenarioType: string;
  averageScore: number;
  averageAccuracy: number;
  topScenarios: HubTopScenario[];
  recentRuns: HubRunPreview[];
  personalBests: HubRunPreview[];
  benchmarks: HubBenchmarkSummary[];
}

interface HubTimelineSecond {
  tSec: number;
  score: number;
  accuracy: number;
  damageEff: number;
  spm: number;
  shots: number;
  hits: number;
  kills: number;
  paused: boolean;
}

interface HubContextWindow {
  startMs: number;
  endMs: number;
  windowType: string;
  label: string;
  coachingTags: string[];
}

interface HubRunResponse {
  sessionId: string;
  scenarioName: string;
  scenarioType: string;
  playedAtIso: string;
  score: number;
  accuracy: number;
  durationMs: number;
  userHandle: string;
  userDisplayName: string;
  summary: Record<string, unknown>;
  featureSet: Record<string, unknown>;
  timelineSeconds: HubTimelineSecond[];
  contextWindows: HubContextWindow[];
  runId: string;
  scenarioRuns: HubRunPreview[];
  benchmarkRanks: HubScenarioBenchmarkRank[];
}

interface HubPlayerScenarioHistoryResponse {
  scenarioName: string;
  scenarioSlug: string;
  scenarioType: string;
  runs: HubRunPreview[];
  bestScore: number;
  averageScore: number;
  bestAccuracy: number;
  averageAccuracy: number;
  runCount: number;
  benchmarkRanks: HubScenarioBenchmarkRank[];
}

interface HubTypeProfileBand {
  scenarioType: string;
  runCount: number;
  avgAccuracy: number;
  avgScore: number;
  bestScore: number;
  communityAvgAccuracy: number;
  communityAvgScore: number;
  accuracyPercentile: number;
  avgSmoothness: number;
}

interface HubAimProfileResponse {
  userHandle: string;
  userDisplayName: string;
  typeBands: HubTypeProfileBand[];
  overallAccuracy: number;
  overallAccuracyPercentile: number;
  totalRunCount: number;
  strongestType: string;
  mostPracticedType: string;
}

interface HubAimFingerprintAxis {
  key: string;
  label: string;
  value: number;
  volatility: number;
}

interface HubAimFingerprint {
  precision: number;
  speed: number;
  control: number;
  consistency: number;
  decisiveness: number;
  rhythm: number;
  rhythmLabel: string;
  sessionCount: number;
  axes: HubAimFingerprintAxis[];
  styleName: string;
  styleTagline: string;
  styleDescription: string;
  styleFocus: string;
  dominantScenarioType: string;
}

interface HubAimFingerprintResponse {
  overall: HubAimFingerprint | null;
}

interface HubSelection {
  kind: HubKind;
  id: string;
  label: string;
  handle?: string;
}

interface HubResultCard {
  kind: HubKind;
  id: string;
  label: string;
  meta: string;
  tag: string | null;
}

const panelStyle: CSSProperties = {
  background: C.glass,
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  padding: "16px 18px",
  backdropFilter: "blur(16px) saturate(180%)",
};

function fmtScore(value: number) {
  return Math.round(value || 0).toLocaleString();
}

function fmtPct(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

function fmtDurationMs(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) return "—";
  const totalSeconds = Math.max(0, Math.round(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function fmtPlayedAt(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relativeHubTime(value: string | null | undefined) {
  if (!value) return "Recently";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fmtPlayedAt(value);
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.max(1, Math.round(diffMs / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 14) return `${diffDays}d ago`;
  return fmtPlayedAt(value);
}

function displayScenarioType(value?: string | null) {
  const normalized = value?.trim();
  if (!normalized || normalized === "Unknown") return null;
  return SCENARIO_LABELS[normalized] ?? normalized;
}

function hasBenchmarkRank(rank?: HubBenchmarkRankVisual | null) {
  const label = rank?.rankName?.trim();
  return Boolean(label && label.toLowerCase() !== "no rank");
}

function isNetworkStyleHubError(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("error sending request")
    || lower.includes("failed to connect")
    || lower.includes("connection refused")
    || lower.includes("dns")
    || lower.includes("timeout")
    || lower.includes("timed out")
    || lower.includes("certificate")
    || lower.includes("tls")
    || lower.includes("network")
  );
}

function formatHubError(message: string | null) {
  if (!message) return null;
  return isNetworkStyleHubError(message) ? "Could not connect to AimMod Hub. Retry later." : message;
}

function summaryNumber(map: Record<string, unknown>, key: string): number | null {
  const value = map[key];
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const numberValue = record.numberValue;
  if (typeof numberValue === "number" && Number.isFinite(numberValue)) return numberValue;
  const stringValue = record.stringValue;
  if (typeof stringValue === "string") {
    const parsed = Number(stringValue);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstSearchSelection(results: HubSearchResponse): HubSelection | null {
  const firstProfile = results.profiles[0];
  if (firstProfile) {
    return {
      kind: "profile",
      id: firstProfile.userHandle,
      label: firstProfile.userDisplayName || firstProfile.userHandle,
    };
  }
  const firstScenario = results.scenarios[0];
  if (firstScenario) {
    return {
      kind: "scenario",
      id: firstScenario.scenarioSlug,
      label: firstScenario.scenarioName,
    };
  }
  const firstReplay = results.replays[0];
  if (firstReplay) {
    return {
      kind: "replay",
      id: firstReplay.publicRunId || firstReplay.sessionId,
      label: firstReplay.scenarioName,
    };
  }
  const firstRun = results.runs[0];
  if (firstRun) {
    return {
      kind: "run",
      id: firstRun.publicRunId || firstRun.sessionId,
      label: firstRun.scenarioName,
    };
  }
  return null;
}

export function HubBrowserPanel() {
  const [overview, setOverview] = useState<HubOverviewResponse | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [queryDraft, setQueryDraft] = useState("");
  const [searchResults, setSearchResults] = useState<HubSearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState<HubFilter>("all");
  const [selection, setSelection] = useState<HubSelection | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [profileDetail, setProfileDetail] = useState<HubProfileResponse | null>(null);
  const [scenarioDetail, setScenarioDetail] = useState<HubScenarioPageResponse | null>(null);
  const [benchmarkDetail, setBenchmarkDetail] = useState<HubBenchmarkPageResponse | null>(null);
  const [playerScenarioDetail, setPlayerScenarioDetail] = useState<HubPlayerScenarioHistoryResponse | null>(null);
  const [runDetail, setRunDetail] = useState<HubRunResponse | null>(null);
  const [aimProfile, setAimProfile] = useState<HubAimProfileResponse | null>(null);
  const [aimFingerprint, setAimFingerprint] = useState<HubAimFingerprint | null>(null);

  const clearSelection = () => setSelection(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingOverview(true);
    setOverviewError(null);
    void invoke<HubOverviewResponse>("hub_get_overview")
      .then((result) => {
        if (cancelled) return;
        setOverview(result);
        setLoadingOverview(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setOverview(null);
        setOverviewError(formatHubError(String(error)) ?? "Could not load AimMod Hub.");
        setLoadingOverview(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selection) {
      setDetailError(null);
      setProfileDetail(null);
      setScenarioDetail(null);
      setBenchmarkDetail(null);
      setPlayerScenarioDetail(null);
      setRunDetail(null);
      setAimProfile(null);
      setAimFingerprint(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setProfileDetail(null);
    setScenarioDetail(null);
    setBenchmarkDetail(null);
    setPlayerScenarioDetail(null);
    setRunDetail(null);
    setAimProfile(null);
    setAimFingerprint(null);

    const load = async () => {
      try {
        if (selection.kind === "profile") {
          const [profile, aimProfileResp, fingerprintResp] = await Promise.all([
            invoke<HubProfileResponse>("hub_get_profile", { handle: selection.id }),
            invoke<HubAimProfileResponse>("hub_get_aim_profile", { handle: selection.id }),
            invoke<HubAimFingerprintResponse>("hub_get_aim_fingerprint", { handle: selection.id }),
          ]);
          if (cancelled) return;
          setProfileDetail(profile);
          setAimProfile(aimProfileResp);
          setAimFingerprint(fingerprintResp.overall ?? null);
        } else if (selection.kind === "benchmark") {
          const page = await invoke<HubBenchmarkPageResponse>("hub_get_benchmark_page", {
            handle: selection.handle,
            benchmarkId: Number(selection.id),
          });
          if (cancelled) return;
          setBenchmarkDetail(page);
        } else if (selection.kind === "scenario") {
          const page = await invoke<HubScenarioPageResponse>("hub_get_scenario", { slug: selection.id });
          if (cancelled) return;
          setScenarioDetail(page);
        } else if (selection.kind === "playerScenario") {
          const history = await invoke<HubPlayerScenarioHistoryResponse>("hub_get_player_scenario_history", {
            handle: selection.handle,
            scenarioSlug: selection.id,
          });
          if (cancelled) return;
          setPlayerScenarioDetail(history);
        } else {
          const run = await invoke<HubRunResponse>("hub_get_run", { runId: selection.id });
          if (cancelled) return;
          setRunDetail(run);
        }
        if (!cancelled) {
          setDetailLoading(false);
        }
      } catch (error) {
        if (cancelled) return;
        setDetailError(formatHubError(String(error)) ?? "Could not load AimMod Hub detail.");
        setDetailLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [selection]);

  const filteredSearchSections = useMemo(() => {
    const payload = searchResults;
    if (!payload) return [];
    const sections: Array<{ key: HubFilter; label: string; items: HubResultCard[] }> = [
      {
        key: "profiles",
        label: "Players",
        items: payload.profiles.map((item) => ({
          kind: "profile" as const,
          id: item.userHandle,
          label: item.userDisplayName || item.userHandle,
          meta: `${item.runCount} runs · ${item.scenarioCount} scenarios`,
          tag: displayScenarioType(item.primaryScenarioType),
        })),
      },
      {
        key: "scenarios",
        label: "Scenarios",
        items: payload.scenarios.map((item) => ({
          kind: "scenario" as const,
          id: item.scenarioSlug,
          label: item.scenarioName,
          meta: `${item.runCount} runs`,
          tag: displayScenarioType(item.scenarioType),
        })),
      },
      {
        key: "runs",
        label: "Runs",
        items: payload.runs.map((item) => ({
          kind: "run" as const,
          id: item.publicRunId || item.sessionId,
          label: item.scenarioName,
          meta: `${fmtScore(item.score)} · ${fmtPct(item.accuracy)} · ${relativeHubTime(item.playedAtIso)}`,
          tag: item.userDisplayName || item.userHandle,
        })),
      },
      {
        key: "replays",
        label: "Replays",
        items: payload.replays.map((item) => ({
          kind: "replay" as const,
          id: item.publicRunId || item.sessionId,
          label: item.scenarioName,
          meta: `${item.hasVideo ? "Video" : "Mouse path"} · ${relativeHubTime(item.playedAtIso)}`,
          tag: item.userDisplayName || item.userHandle,
        })),
      },
    ];

    return sections.filter((section) => section.items.length > 0 && (filter === "all" || filter === section.key));
  }, [filter, searchResults]);

  const submitSearch = async () => {
    const trimmed = queryDraft.trim();
    if (!trimmed) {
      setSearchResults(null);
      setSearchError(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const results = await invoke<HubSearchResponse>("hub_search", { query: trimmed });
      setSearchResults(results);
      if (!selection) {
        setSelection(firstSearchSelection(results));
      }
    } catch (error) {
      setSearchResults(null);
      setSearchError(formatHubError(String(error)) ?? "Could not search AimMod Hub.");
    } finally {
      setSearching(false);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 0.95fr) minmax(0, 1.25fr)", gap: 18 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        <div style={panelStyle}>
          <div style={{ fontSize: 11, color: C.accent, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>
            Search the Hub
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <input
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitSearch();
                }
              }}
              placeholder="Search players, scenarios, replays"
              style={{
                flex: 1,
                minWidth: 0,
                borderRadius: 10,
                border: `1px solid ${C.borderSub}`,
                background: "rgba(255,255,255,0.03)",
                color: C.text,
                padding: "10px 12px",
                fontSize: 12,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            />
            <Btn size="sm" variant="primary" onClick={() => void submitSearch()} disabled={searching}>
              {searching ? "Searching…" : "Search"}
            </Btn>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["all", "profiles", "scenarios", "runs", "replays"] as HubFilter[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                style={{
                  borderRadius: 999,
                  border: `1px solid ${filter === value ? accentAlpha("55") : C.borderSub}`,
                  background: filter === value ? accentAlpha("18") : "transparent",
                  color: filter === value ? C.accent : C.textFaint,
                  fontSize: 10,
                  padding: "4px 9px",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {value}
              </button>
            ))}
          </div>
          {searchError ? (
            <div style={{ marginTop: 10, fontSize: 12, color: C.warn }}>{searchError}</div>
          ) : null}
        </div>

        {!searchResults && (
          <div style={panelStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>Popular right now</div>
                <div style={{ fontSize: 11, color: C.textFaint, marginTop: 4 }}>See what players are grinding, what scenarios are active, and which runs are worth opening.</div>
              </div>
              {loadingOverview ? <Badge color="#00b4ff">Loading</Badge> : null}
            </div>
            {overviewError ? (
              <div style={{ fontSize: 12, color: C.warn }}>{overviewError}</div>
            ) : loadingOverview || !overview ? (
              <div style={{ fontSize: 12, color: C.textFaint }}>Loading what people are playing…</div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                  <StatTile label="Runs" value={overview.totalRuns.toLocaleString()} />
                  <StatTile label="Players" value={overview.totalPlayers.toLocaleString()} />
                  <StatTile label="Scenarios" value={overview.totalScenarios.toLocaleString()} />
                </div>
                <HubList
                  title="Players"
                  items={overview.activeProfiles.map((item) => ({
                    key: item.userHandle,
                    title: item.userDisplayName || item.userHandle,
                    meta: `${item.runCount} runs · ${item.scenarioCount} scenarios played`,
                    tag: displayScenarioType(item.primaryScenarioType),
                    onClick: () =>
                      setSelection({
                        kind: "profile",
                        id: item.userHandle,
                        label: item.userDisplayName || item.userHandle,
                      }),
                  }))}
                />
                <HubList
                  title="Scenarios"
                  items={overview.topScenarios.map((item) => ({
                    key: item.scenarioSlug,
                    title: item.scenarioName,
                    meta: `${item.runCount} runs`,
                    tag: displayScenarioType(item.scenarioType),
                    onClick: () =>
                      setSelection({
                        kind: "scenario",
                        id: item.scenarioSlug,
                        label: item.scenarioName,
                      }),
                  }))}
                />
                <HubList
                  title="Recent runs"
                  items={overview.recentRuns.slice(0, 8).map((item) => ({
                    key: item.runId || item.sessionId,
                    title: item.scenarioName,
                    meta: `${fmtScore(item.score)} · ${fmtPct(item.accuracy)} · ${relativeHubTime(item.playedAtIso)}`,
                    tag: item.userDisplayName || item.userHandle,
                    onClick: () =>
                      setSelection({
                        kind: "run",
                        id: item.runId || item.sessionId,
                        label: item.scenarioName,
                      }),
                  }))}
                />
              </>
            )}
          </div>
        )}

        {searchResults && (
          <div style={panelStyle}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>Matches</div>
            <div style={{ marginTop: 4, fontSize: 11, color: C.textFaint }}>
              {filteredSearchSections.reduce((sum, section) => sum + section.items.length, 0)} results for “{searchResults.query || queryDraft.trim()}”
            </div>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 14, maxHeight: 760, overflowY: "auto", paddingRight: 4 }}>
              {filteredSearchSections.length === 0 ? (
                <div style={{ fontSize: 12, color: C.textFaint }}>No matches yet.</div>
              ) : (
                filteredSearchSections.map((section) => (
                  <div key={section.key}>
                    <div style={{ fontSize: 10, color: C.accent, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700, marginBottom: 8 }}>
                      {section.label}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {section.items.map((item) => (
                        <button
                          key={`${section.key}:${item.id}`}
                          type="button"
                          onClick={() => setSelection(item)}
                          style={{
                            textAlign: "left",
                            borderRadius: 10,
                            border: `1px solid ${selection?.id === item.id ? accentAlpha("55") : C.borderSub}`,
                            background: selection?.id === item.id ? accentAlpha("10") : "rgba(255,255,255,0.02)",
                            color: C.text,
                            padding: "10px 12px",
                            cursor: "pointer",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: C.text, lineHeight: 1.45, wordBreak: "break-word" }}>{item.label}</div>
                            {item.tag ? <Badge color={item.kind === "profile" ? "#00b4ff" : C.accent}>{item.tag}</Badge> : null}
                          </div>
                          <div style={{ fontSize: 10, color: C.textFaint, marginTop: 6, lineHeight: 1.5 }}>
                            {item.meta}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={panelStyle}>
          {selection ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14, paddingBottom: 12, borderBottom: `1px solid ${C.borderSub}` }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 10, color: C.accent, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>
                  {selection.kind === "profile"
                  ? "Player"
                  : selection.kind === "scenario"
                      ? "Scenario"
                      : selection.kind === "benchmark"
                        ? "Benchmark"
                      : selection.kind === "playerScenario"
                        ? "Scenario history"
                        : selection.kind === "replay"
                          ? "Replay"
                        : "Run"}
                </div>
                <div style={{ marginTop: 4, fontSize: 14, color: C.text, fontWeight: 700, lineHeight: 1.4, wordBreak: "break-word" }}>
                  {selection.label}
                </div>
              </div>
              <Btn size="sm" variant="ghost" onClick={clearSelection}>Back</Btn>
            </div>
          ) : null}
          {!selection ? (
            <div style={{ color: C.textFaint, fontSize: 12, lineHeight: 1.8 }}>
              Search for a player, scenario, run, or replay to open it here.
            </div>
          ) : detailError ? (
            <div style={{ color: C.warn, fontSize: 12 }}>{detailError}</div>
          ) : detailLoading ? (
            <div style={{ color: C.textFaint, fontSize: 12 }}>Loading {selection.label}…</div>
          ) : profileDetail ? (
            <ProfileDetailCard
              profile={profileDetail}
              aimProfile={aimProfile}
              aimFingerprint={aimFingerprint}
              onSelectBenchmark={(benchmarkId, label) =>
                setSelection({
                  kind: "benchmark",
                  id: String(benchmarkId),
                  label,
                  handle: profileDetail.userHandle,
                })}
              onSelectScenario={(slug, label) =>
                setSelection({ kind: "playerScenario", id: slug, label, handle: profileDetail.userHandle })
              }
              onSelectRun={(runId, label) => setSelection({ kind: "run", id: runId, label })}
            />
          ) : scenarioDetail ? (
            <ScenarioDetailCard
              scenario={scenarioDetail}
              onSelectRun={(runId, label) => setSelection({ kind: "run", id: runId, label })}
            />
          ) : benchmarkDetail ? (
            <BenchmarkDetailCard
              page={benchmarkDetail}
              onSelectScenario={(slug, label) =>
                setSelection({
                  kind: "playerScenario",
                  id: slug,
                  label,
                  handle: benchmarkDetail.userHandle,
                })}
            />
          ) : playerScenarioDetail ? (
            <PlayerScenarioDetailCard
              history={playerScenarioDetail}
              handle={selection.handle || ""}
              onSelectBenchmark={(benchmarkId, label) =>
                setSelection({
                  kind: "benchmark",
                  id: String(benchmarkId),
                  label,
                  handle: selection.handle,
                })}
              onSelectRun={(runId, label) => setSelection({ kind: "run", id: runId, label })}
            />
          ) : runDetail ? (
            <RunDetailCard
              run={runDetail}
              onSelectBenchmark={(benchmarkId, label) =>
                setSelection({
                  kind: "benchmark",
                  id: String(benchmarkId),
                  label,
                  handle: runDetail.userHandle,
                })}
              onSelectProfile={(handle, label) => setSelection({ kind: "profile", id: handle, label })}
            />
          ) : (
            <div style={{ color: C.textFaint, fontSize: 12 }}>Pick something on the left to keep browsing.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        borderRadius: 10,
        border: `1px solid ${C.borderSub}`,
        background: "rgba(255,255,255,0.02)",
        padding: "10px 12px",
      }}
    >
      <div style={{ fontSize: 10, color: C.textFaint, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 22, color: C.text, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function HubList({
  title,
  items,
}: {
  title: string;
  items: Array<{ key: string; title: string; meta: string; tag: string | null; onClick: () => void }>;
}) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 10, color: C.accent, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700, marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={item.onClick}
            style={{
              textAlign: "left",
              borderRadius: 10,
              border: `1px solid ${C.borderSub}`,
              background: "rgba(255,255,255,0.02)",
              color: C.text,
              padding: "10px 12px",
              cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.4 }}>{item.title}</div>
              {item.tag ? <Badge color={C.accent}>{item.tag}</Badge> : null}
            </div>
            <div style={{ fontSize: 10, color: C.textFaint, marginTop: 6 }}>{item.meta}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ProfileDetailCard({
  profile,
  aimProfile,
  aimFingerprint,
  onSelectBenchmark,
  onSelectScenario,
  onSelectRun,
}: {
  profile: HubProfileResponse;
  aimProfile: HubAimProfileResponse | null;
  aimFingerprint: HubAimFingerprint | null;
  onSelectBenchmark: (benchmarkId: number, label: string) => void;
  onSelectScenario: (slug: string, label: string) => void;
  onSelectRun: (runId: string, label: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 11, color: C.accent, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>
          Player
        </div>
        <div style={{ marginTop: 6, fontSize: 24, fontWeight: 700, color: C.text }}>
          {profile.userDisplayName || profile.userHandle}
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: C.textSub }}>
          @{profile.userHandle} · {profile.runCount.toLocaleString()} runs · {profile.scenarioCount.toLocaleString()} scenarios
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        <StatTile label="Average score" value={fmtScore(profile.averageScore)} />
        <StatTile label="Average accuracy" value={fmtPct(profile.averageAccuracy)} />
        <StatTile label="Main focus" value={displayScenarioType(profile.primaryScenarioType) || "Mixed"} />
      </div>

      {profile.benchmarks.some((benchmark) => hasBenchmarkRank(benchmark.overallRank)) && (
        <BenchmarkRankList
          title="Benchmarks"
          items={profile.benchmarks.filter((benchmark) => hasBenchmarkRank(benchmark.overallRank)).map((benchmark) => ({
            key: `${benchmark.benchmarkId}:${benchmark.benchmarkName}`,
            title: benchmark.benchmarkName,
            meta: benchmark.benchmarkType || benchmark.benchmarkAuthor || "Benchmark",
            iconUrl: benchmark.overallRank?.iconUrl || benchmark.benchmarkIconUrl,
            value: benchmark.overallRank?.rankName || "",
            onClick: () => onSelectBenchmark(benchmark.benchmarkId, benchmark.benchmarkName),
          }))}
        />
      )}

      {aimProfile && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>Play style</div>
          <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
            <MiniInfo label="Strongest area" value={displayScenarioType(aimProfile.strongestType) || "Mixed"} />
            <MiniInfo label="Most played" value={displayScenarioType(aimProfile.mostPracticedType) || "Mixed"} />
            <MiniInfo label="Overall accuracy" value={fmtPct(aimProfile.overallAccuracy)} />
            <MiniInfo label="Compared to other players" value={fmtPct(aimProfile.overallAccuracyPercentile, 0)} />
          </div>
          {aimProfile.typeBands.length > 0 && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              {aimProfile.typeBands.slice(0, 6).map((band) => (
                <div key={band.scenarioType} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11 }}>
                  <span style={{ color: C.text }}>{displayScenarioType(band.scenarioType) || band.scenarioType}</span>
                  <span style={{ color: C.textFaint }}>
                    {band.runCount} runs · {fmtPct(band.avgAccuracy)} accuracy · {fmtScore(band.bestScore)} best
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {aimFingerprint && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>How they aim</div>
          <div style={{ marginTop: 6, fontSize: 18, color: C.text }}>{aimFingerprint.styleName}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: C.textSub, lineHeight: 1.7 }}>
            {aimFingerprint.styleTagline}
            {aimFingerprint.styleDescription ? ` · ${aimFingerprint.styleDescription}` : ""}
          </div>
          {aimFingerprint.axes.length > 0 && (
            <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
              {aimFingerprint.axes.slice(0, 6).map((axis) => (
                <MiniInfo
                  key={axis.key}
                  label={axis.label}
                  value={`${axis.value}/100${axis.volatility > 0 ? ` · ±${axis.volatility}` : ""}`}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <HubList
        title="Most played scenarios"
        items={profile.topScenarios.slice(0, 8).map((item) => ({
          key: item.scenarioSlug,
          title: item.scenarioName,
          meta: `${item.runCount} runs`,
          tag: displayScenarioType(item.scenarioType),
          onClick: () => onSelectScenario(item.scenarioSlug, item.scenarioName),
        }))}
      />

      <HubList
        title="Recent runs"
        items={profile.recentRuns.slice(0, 8).map((item) => ({
          key: item.runId || item.sessionId,
          title: item.scenarioName,
          meta: `${fmtScore(item.score)} · ${fmtPct(item.accuracy)} · ${fmtPlayedAt(item.playedAtIso)}`,
          tag: displayScenarioType(item.scenarioType),
          onClick: () => onSelectRun(item.runId || item.sessionId, item.scenarioName),
        }))}
      />
    </div>
  );
}

function ScenarioDetailCard({
  scenario,
  onSelectRun,
}: {
  scenario: HubScenarioPageResponse;
  onSelectRun: (runId: string, label: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 11, color: C.accent, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>
          Scenario
        </div>
        <div style={{ marginTop: 6, fontSize: 24, fontWeight: 700, color: C.text }}>{scenario.scenarioName}</div>
        <div style={{ marginTop: 6, fontSize: 12, color: C.textSub }}>
          {displayScenarioType(scenario.scenarioType) || "Mixed"} · {scenario.runCount.toLocaleString()} runs
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
        <StatTile label="Best" value={fmtScore(scenario.bestScore)} />
        <StatTile label="Average" value={fmtScore(scenario.averageScore)} />
        <StatTile label="Accuracy" value={fmtPct(scenario.averageAccuracy)} />
        <StatTile label="Duration" value={fmtDurationMs(scenario.averageDurationMs)} />
      </div>

      <HubList
        title="Best runs"
        items={scenario.topRuns.slice(0, 8).map((item) => ({
          key: item.runId || item.sessionId,
          title: item.userDisplayName || item.userHandle || item.scenarioName,
          meta: `${fmtScore(item.score)} · ${fmtPct(item.accuracy)} · ${relativeHubTime(item.playedAtIso)}`,
          tag: displayScenarioType(item.scenarioType),
          onClick: () => onSelectRun(item.runId || item.sessionId, item.scenarioName),
        }))}
      />

      <HubList
        title="Recent runs"
        items={scenario.recentRuns.slice(0, 8).map((item) => ({
          key: item.runId || item.sessionId,
          title: `${item.userDisplayName || item.userHandle || item.scenarioName} · ${fmtScore(item.score)}`,
          meta: `${fmtScore(item.score)} · ${fmtPct(item.accuracy)} · ${relativeHubTime(item.playedAtIso)}`,
          tag: displayScenarioType(item.scenarioType),
          onClick: () => onSelectRun(item.runId || item.sessionId, item.scenarioName),
        }))}
      />
    </div>
  );
}

function PlayerScenarioDetailCard({
  history,
  handle,
  onSelectBenchmark,
  onSelectRun,
}: {
  history: HubPlayerScenarioHistoryResponse;
  handle: string;
  onSelectBenchmark: (benchmarkId: number, label: string) => void;
  onSelectRun: (runId: string, label: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 11, color: C.accent, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>
          Scenario history
        </div>
        <div style={{ marginTop: 6, fontSize: 24, fontWeight: 700, color: C.text }}>{history.scenarioName}</div>
        <div style={{ marginTop: 6, fontSize: 12, color: C.textSub }}>
          @{handle} · {history.runCount.toLocaleString()} runs · {displayScenarioType(history.scenarioType) || "Mixed"}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
        <StatTile label="Best" value={fmtScore(history.bestScore)} />
        <StatTile label="Average" value={fmtScore(history.averageScore)} />
        <StatTile label="Best accuracy" value={fmtPct(history.bestAccuracy)} />
        <StatTile label="Average accuracy" value={fmtPct(history.averageAccuracy)} />
      </div>

      {history.benchmarkRanks.some((rank) => hasBenchmarkRank(rank.scenarioRank)) && (
        <BenchmarkRankList
          title="Benchmark ranks"
          items={history.benchmarkRanks.filter((rank) => hasBenchmarkRank(rank.scenarioRank)).map((rank) => ({
            key: `${rank.benchmarkId}:${rank.categoryName}`,
            title: rank.benchmarkName,
            meta: `${rank.categoryName} · Score ${fmtScore(rank.scenarioScore)}${rank.leaderboardRank > 0 ? ` · Top ${rank.leaderboardRank}` : ""}`,
            iconUrl: rank.scenarioRank?.iconUrl || rank.benchmarkIconUrl,
            value: rank.scenarioRank?.rankName || "",
            onClick: () => onSelectBenchmark(rank.benchmarkId, rank.benchmarkName),
          }))}
        />
      )}

      <HubList
        title="Recent runs"
        items={history.runs.slice(0, 10).map((item) => ({
          key: item.runId || item.sessionId,
          title: `${fmtScore(item.score)} · ${fmtPct(item.accuracy)}`,
          meta: `${fmtDurationMs(item.durationMs)} · ${relativeHubTime(item.playedAtIso)}`,
          tag: null,
          onClick: () => onSelectRun(item.runId || item.sessionId, history.scenarioName),
        }))}
      />
    </div>
  );
}

function RunDetailCard({
  run,
  onSelectBenchmark,
  onSelectProfile,
}: {
  run: HubRunResponse;
  onSelectBenchmark: (benchmarkId: number, label: string) => void;
  onSelectProfile: (handle: string, label: string) => void;
}) {
  const scorePerMinute = summaryNumber(run.summary, "scorePerMinute");
  const damageEfficiency = summaryNumber(run.summary, "damageEfficiency");
  const shotsFired = summaryNumber(run.summary, "shotsFired");
  const shotsHit = summaryNumber(run.summary, "shotsHit");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 11, color: C.accent, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>
          Run
        </div>
        <div style={{ marginTop: 6, fontSize: 22, fontWeight: 700, color: C.text }}>{run.scenarioName}</div>
        <div style={{ marginTop: 6, fontSize: 12, color: C.textSub }}>
          {run.userDisplayName || run.userHandle} · {fmtPlayedAt(run.playedAtIso)}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn size="sm" variant="ghost" onClick={() => onSelectProfile(run.userHandle, run.userDisplayName || run.userHandle)}>
          Open player
        </Btn>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
        <StatTile label="Score" value={fmtScore(run.score)} />
        <StatTile label="Accuracy" value={fmtPct(run.accuracy)} />
        <StatTile label="Duration" value={fmtDurationMs(run.durationMs)} />
        <StatTile label="Type" value={displayScenarioType(run.scenarioType) || "Mixed"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        <MiniInfo label="Score pace" value={scorePerMinute != null ? fmtScore(scorePerMinute) : "—"} />
        <MiniInfo label="Damage eff" value={damageEfficiency != null ? fmtPct(damageEfficiency) : "—"} />
        <MiniInfo label="Shots / Hits" value={shotsFired != null ? `${fmtScore(shotsFired)} / ${fmtScore(shotsHit ?? 0)}` : "—"} />
        <MiniInfo label="Key moments" value={String(run.contextWindows.length)} />
      </div>

      {run.benchmarkRanks.some((rank) => hasBenchmarkRank(rank.scenarioRank)) && (
        <BenchmarkRankList
          title="Benchmark ranks"
          items={run.benchmarkRanks.filter((rank) => hasBenchmarkRank(rank.scenarioRank)).map((rank) => ({
            key: `${rank.benchmarkId}:${rank.categoryName}`,
            title: rank.benchmarkName,
            meta: `${rank.categoryName} · Score ${fmtScore(rank.scenarioScore)}${rank.leaderboardRank > 0 ? ` · Top ${rank.leaderboardRank}` : ""}`,
            iconUrl: rank.scenarioRank?.iconUrl || rank.benchmarkIconUrl,
            value: rank.scenarioRank?.rankName || "",
            onClick: () => onSelectBenchmark(rank.benchmarkId, rank.benchmarkName),
          }))}
        />
      )}

      {run.contextWindows.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>Key moments</div>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8, maxHeight: 300, overflowY: "auto", paddingRight: 4 }}>
            {run.contextWindows.slice(0, 12).map((window, index) => (
              <div key={`${window.label}:${index}`} style={{ borderRadius: 10, border: `1px solid ${C.borderSub}`, padding: "10px 12px", background: "rgba(255,255,255,0.02)" }}>
                <div style={{ fontSize: 12, color: C.text, fontWeight: 700 }}>{window.label || window.windowType || `Window ${index + 1}`}</div>
                <div style={{ marginTop: 4, fontSize: 10, color: C.textFaint }}>
                  {fmtDurationMs(window.endMs - window.startMs)} · {window.coachingTags.join(" · ") || "No callouts"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BenchmarkDetailCard({
  page,
  onSelectScenario,
}: {
  page: HubBenchmarkPageResponse;
  onSelectScenario: (slug: string, label: string) => void;
}) {
  const categories = page.categories
    .map((category) => ({
      ...category,
      scenarios: category.scenarios.filter((scenario) => hasBenchmarkRank(scenario.scenarioRank)),
    }))
    .filter((category) => category.scenarios.length > 0);

  const rankedScenarioCount = categories.reduce((sum, category) => sum + category.scenarios.length, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 11, color: C.accent, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700 }}>
          Benchmark
        </div>
        <div style={{ marginTop: 6, fontSize: 24, fontWeight: 700, color: C.text }}>{page.benchmarkName}</div>
        <div style={{ marginTop: 6, fontSize: 12, color: C.textSub }}>
          {page.userDisplayName || page.userHandle}
          {page.benchmarkType ? ` · ${page.benchmarkType}` : ""}
          {page.benchmarkAuthor ? ` · ${page.benchmarkAuthor}` : ""}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
        <StatTile label="Current rank" value={page.overallRank?.rankName || "Unranked"} />
        <StatTile label="Categories" value={String(categories.length)} />
        <StatTile label="Ranked scenarios" value={String(rankedScenarioCount)} />
        <StatTile label="Player" value={page.userDisplayName || page.userHandle} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: 760, overflowY: "auto", paddingRight: 4 }}>
        {categories.map((category) => (
          <div
            key={category.categoryName}
            style={{
              borderRadius: 12,
              border: `1px solid ${C.borderSub}`,
              background: "rgba(255,255,255,0.02)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "12px 14px",
                borderBottom: `1px solid ${C.borderSub}`,
                background: "rgba(255,255,255,0.02)",
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{category.categoryName}</div>
              <div style={{ marginTop: 4, fontSize: 10, color: C.textFaint }}>
                {category.scenarios.length} ranked scenario{category.scenarios.length === 1 ? "" : "s"}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {category.scenarios.map((scenario) => (
                <button
                  key={`${category.categoryName}:${scenario.scenarioSlug || scenario.scenarioName}`}
                  type="button"
                  onClick={() => onSelectScenario(scenario.scenarioSlug || scenario.scenarioName, scenario.scenarioName)}
                  style={{
                    textAlign: "left",
                    padding: "12px 14px",
                    background: "transparent",
                    border: 0,
                    borderTop: `1px solid ${C.borderSub}`,
                    color: C.text,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.5 }}>{scenario.scenarioName}</div>
                      <div style={{ marginTop: 4, fontSize: 10, color: C.textFaint }}>
                        {fmtScore(scenario.score)}
                        {scenario.leaderboardRank > 0 ? ` · Top ${scenario.leaderboardRank}` : ""}
                      </div>
                    </div>
                    <Badge color={C.accent}>{scenario.scenarioRank?.rankName || "Unranked"}</Badge>
                  </div>
                  {scenario.thresholds.length > 0 ? (
                    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                      {scenario.thresholds.map((threshold) => {
                        const progress = threshold.score > 0 ? Math.max(0, Math.min(100, (scenario.score / threshold.score) * 100)) : 0;
                        return (
                          <div
                            key={`${scenario.scenarioSlug || scenario.scenarioName}:${threshold.rankIndex}`}
                            style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr) 68px", gap: 8, alignItems: "center" }}
                          >
                            <div style={{ fontSize: 10, color: C.text }}>{threshold.rankName}</div>
                            <div style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                              <div
                                style={{
                                  width: `${progress}%`,
                                  height: "100%",
                                  borderRadius: 999,
                                  background: "linear-gradient(90deg, rgba(87,247,194,0.9), rgba(0,180,255,0.8))",
                                }}
                              />
                            </div>
                            <div style={{ fontSize: 10, color: C.textFaint, textAlign: "right" }}>{fmtScore(threshold.score)}</div>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BenchmarkRankList({
  title,
  items,
}: {
  title: string;
  items: Array<{ key: string; title: string; meta: string; value: string; iconUrl: string; onClick?: () => void }>;
}) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{title}</div>
      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, maxHeight: 320, overflowY: "auto", paddingRight: 4 }}>
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={item.onClick}
            style={{
              borderRadius: 10,
              border: `1px solid ${C.borderSub}`,
              background: "rgba(255,255,255,0.02)",
              padding: "10px 12px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              textAlign: "left",
              cursor: item.onClick ? "pointer" : "default",
            }}
          >
            {item.iconUrl ? (
              <img
                src={item.iconUrl}
                alt=""
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  objectFit: "cover",
                  border: `1px solid ${C.borderSub}`,
                  background: "rgba(255,255,255,0.04)",
                }}
              />
            ) : null}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.text, lineHeight: 1.4 }}>{item.title}</div>
              <div style={{ marginTop: 2, fontSize: 11, color: C.textSub, lineHeight: 1.5 }}>{item.value}</div>
              <div style={{ marginTop: 2, fontSize: 10, color: C.textFaint, lineHeight: 1.5 }}>{item.meta}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function MiniInfo({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ borderRadius: 10, border: `1px solid ${C.borderSub}`, padding: "10px 12px", background: "rgba(255,255,255,0.02)" }}>
      <div style={{ fontSize: 10, color: C.textFaint, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 13, color: C.text, fontWeight: 700, lineHeight: 1.5 }}>{value}</div>
    </div>
  );
}
