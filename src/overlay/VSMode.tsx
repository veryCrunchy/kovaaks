import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useLiveScore } from "../hooks/useLiveScore";
import { useStatsPanel } from "../hooks/useStatsPanel";
import type { FriendProfile } from "../types/friends";
import { logError } from "../log";
import { GlassCard, Dot } from "../design/ui";
import { C } from "../design/tokens";

interface VSModeProps {
  currentScenario: string | null;
  /** When true, always render the card even with no session data (for repositioning). */
  preview?: boolean;
}

function normalizeScenarioName(name: string): string {
  return stripChallengeSuffix(name)
    .trim()
    .toLowerCase();
}

function stripChallengeSuffix(name: string): string {
  return name
    .replace(/\s+-\s+Challenge(?:\s+Start)?$/i, "")
    .trim();
}

function formatScore(n: number): string {
  return n.toLocaleString();
}

function getDeltaLabel(delta: number): string {
  if (delta === 0) return "±0";
  return delta > 0 ? `+${formatScore(delta)}` : `-${formatScore(Math.abs(delta))}`;
}

export function VSMode({ currentScenario, preview = false }: VSModeProps) {
  const { liveScore, sessionResult, isSessionActive, elapsedSeconds } = useLiveScore();
  const statsPanel = useStatsPanel();
  const [selectedFriend, setSelectedFriend] = useState<FriendProfile | null>(null);
  const [currentUser, setCurrentUser] = useState<FriendProfile | null>(null);
  const [friendScore, setFriendScore] = useState<number | null>(null);
  const [fetchingFriend, setFetchingFriend] = useState(false);
  const [personalBestScore, setPersonalBestScore] = useState<number | null>(null);
  const [fetchingPersonalBest, setFetchingPersonalBest] = useState(false);
  const [maxScore, setMaxScore] = useState(0);
  const [visible, setVisible] = useState(true);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track scenario duration for projection; default 60s, updated from sessionResult
  const [scenarioDuration, setScenarioDuration] = useState(60);
  const activeScenarioRaw =
    currentScenario ?? statsPanel?.scenario_name ?? sessionResult?.scenario ?? null;
  const activeScenario = activeScenarioRaw ? stripChallengeSuffix(activeScenarioRaw) : null;

  // Load friends list + selected opponent from settings on mount
  useEffect(() => {
    Promise.all([
      invoke<FriendProfile[]>("get_friends"),
      invoke<{ selected_friend?: string }>("get_settings"),
      invoke<FriendProfile | null>("get_current_kovaaks_user"),
    ])
      .then(([list, settings, current]) => {
        setCurrentUser(current);
        if (settings.selected_friend) {
          const match = list.find((f) => f.username === settings.selected_friend);
          if (match) setSelectedFriend(match);
        }
      })
      .catch((err) => {
        logError("VSMode", `Failed to load friends/settings: ${err && err.message ? err.message : err}`);
      });
  }, []);

  // Live-update selected friend when changed from Settings panel
  useEffect(() => {
    const unlisten = listen<string>("selected-friend-changed", (e) => {
      Promise.all([
        invoke<FriendProfile[]>("get_friends"),
        invoke<{ selected_friend?: string }>("get_settings"),
        invoke<FriendProfile | null>("get_current_kovaaks_user"),
      ])
        .then(([list, settings, current]) => {
          setCurrentUser(current);
          const username = e.payload || settings.selected_friend;
          if (username) {
            const match = list.find((f) => f.username === username);
            setSelectedFriend(match ?? null);
          } else {
            setSelectedFriend(null);
          }
        })
        .catch((err) => {
          logError("VSMode", `Failed to update selected friend: ${err && err.message ? err.message : err}`);
        });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    const unlisten = listen("kovaaks-user-updated", () => {
      void invoke<FriendProfile | null>("get_current_kovaaks_user")
        .then((profile) => setCurrentUser(profile))
        .catch((err) => {
          logError("VSMode", `Failed to refresh current user: ${err && err.message ? err.message : err}`);
        });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      void invoke<FriendProfile | null>("get_current_kovaaks_user")
        .then((profile) => setCurrentUser(profile))
        .catch((err) => {
          logError("VSMode", `Periodic current-user refresh failed: ${err && err.message ? err.message : err}`);
        });
    }, 5_000);
    return () => clearInterval(id);
  }, []);

  // Update scenario duration when a session completes
  useEffect(() => {
    if (sessionResult?.duration_secs) {
      setScenarioDuration(sessionResult.duration_secs);
    }
  }, [sessionResult?.duration_secs]);

  // Prefer live challenge length when available for projection timing.
  useEffect(() => {
    const challengeLength = statsPanel?.challenge_time_length;
    if (challengeLength != null && Number.isFinite(challengeLength) && challengeLength > 0) {
      setScenarioDuration(challengeLength);
    }
  }, [statsPanel?.challenge_time_length]);

  // Initial friend score fetch when friend/scenario changes
  useEffect(() => {
    const opponent = selectedFriend ?? currentUser;
    if (!opponent || !activeScenario) {
      setFriendScore(null);
      return;
    }
    setFetchingFriend(true);
    invoke<number | null>("fetch_friend_score", {
      username: opponent.username,
      scenarioName: activeScenario,
      steamId: opponent.steam_id,
      steamAccountName: opponent.steam_account_name,
    })
      .then((score) => setFriendScore(score))
      .catch((err) => {
        setFriendScore(null);
        logError(
          "VSMode",
          `Failed to fetch friend score for ${opponent.username} / ${activeScenario}: ${err && err.message ? err.message : err}`
        );
      })
      .finally(() => setFetchingFriend(false));
  }, [selectedFriend?.username, selectedFriend?.steam_id, currentUser?.username, currentUser?.steam_id, activeScenario]);

  // Load personal best for the active scenario so VS mode can fallback to PB.
  useEffect(() => {
    if (!activeScenario) {
      setPersonalBestScore(null);
      return;
    }

    const normalizedScenario = normalizeScenarioName(activeScenario);
    setFetchingPersonalBest(true);
    invoke<number | null>("get_personal_best_for_scenario", {
      scenarioName: normalizedScenario,
    })
      .then((score) => {
        setPersonalBestScore(score != null && score > 0 ? score : null);
      })
      .catch((err) => {
        setPersonalBestScore(null);
        logError(
          "VSMode",
          `Failed to load personal best for ${activeScenario}: ${err && err.message ? err.message : err}`
        );
      })
      .finally(() => setFetchingPersonalBest(false));
  }, [activeScenario, sessionResult?.timestamp]);

  // Periodic re-fetch every 30s while session is live (friend may be playing too)
  useEffect(() => {
    const opponent = selectedFriend ?? currentUser;
    if (!isSessionActive || !opponent || !activeScenario) return;
    const id = setInterval(() => {
      invoke<number | null>("fetch_friend_score", {
        username: opponent.username,
        scenarioName: activeScenario,
        steamId: opponent.steam_id,
        steamAccountName: opponent.steam_account_name,
      })
        .then((score) => setFriendScore(score))
        .catch((err) => {
          logError(
            "VSMode",
            `Periodic fetch_friend_score failed for ${opponent.username} / ${activeScenario}: ${err && err.message ? err.message : err}`
          );
        });
    }, 10_000);
    return () => clearInterval(id);
  }, [isSessionActive, selectedFriend?.username, selectedFriend?.steam_id, currentUser?.username, currentUser?.steam_id, activeScenario]);

  const displayScore = sessionResult?.score ?? liveScore ?? 0;
  const opponentFinalScore = selectedFriend || currentUser ? friendScore : personalBestScore;

  const liveChallengeSeconds =
    statsPanel?.challenge_seconds_total != null
    && Number.isFinite(statsPanel.challenge_seconds_total)
    && statsPanel.challenge_seconds_total >= 0
      ? statsPanel.challenge_seconds_total
      : null;

  const liveTimeRemaining =
    statsPanel?.time_remaining != null
    && Number.isFinite(statsPanel.time_remaining)
    && statsPanel.time_remaining >= 0
      ? statsPanel.time_remaining
      : null;

  const liveChallengeLength =
    statsPanel?.challenge_time_length != null
    && Number.isFinite(statsPanel.challenge_time_length)
    && statsPanel.challenge_time_length > 0
      ? statsPanel.challenge_time_length
      : null;

  const effectiveElapsed = liveChallengeSeconds ?? elapsedSeconds;
  const effectiveChallengeLength =
    liveChallengeLength
    ?? (liveTimeRemaining !== null ? effectiveElapsed + liveTimeRemaining : scenarioDuration);

  const progressRatio = (() => {
    if (sessionResult) return 1;
    if (!isSessionActive) return 0;

    if (liveTimeRemaining !== null && effectiveChallengeLength > 0) {
      return Math.max(
        0,
        Math.min((effectiveChallengeLength - liveTimeRemaining) / effectiveChallengeLength, 1),
      );
    }

    return effectiveChallengeLength > 0
      ? Math.max(0, Math.min(effectiveElapsed / effectiveChallengeLength, 1))
      : 0;
  })();

  // Opponent projected score at current run progress (from time remaining when available).
  // After session ends we compare against the final target score directly.
  const opponentProjected =
    opponentFinalScore !== null && !sessionResult
      ? Math.round(opponentFinalScore * progressRatio)
      : null;

  // What to show in the score label and delta
  const opponentDisplayScore = sessionResult ? opponentFinalScore : opponentProjected;

  // SPM label shown during live session: friend's total score / (duration / 60) ≈ pts/min
  const friendSpm =
    friendScore !== null
      ? Math.round(friendScore / (Math.max(effectiveChallengeLength, 1) / 60))
      : null;

  const combinedMax =
    opponentFinalScore !== null && opponentFinalScore > 0
      ? opponentFinalScore
      : Math.max(displayScore, maxScore, 1);

  useEffect(() => {
    if (displayScore > maxScore) setMaxScore(displayScore);
  }, [displayScore, maxScore]);

  const myPct = combinedMax > 0 ? Math.min((displayScore / combinedMax) * 100, 100) : 0;

  // Opponent bar value: grows with run progress during session, snaps to final on complete.
  const opponentBarValue = sessionResult
    ? (opponentFinalScore ?? 0)
    : (opponentProjected ?? 0);
  const opponentPct = combinedMax > 0 ? Math.min((opponentBarValue / combinedMax) * 100, 100) : 0;

  const delta =
    opponentDisplayScore !== null ? displayScore - opponentDisplayScore : null;
  const isAhead = delta !== null && delta > 0;
  const isBehind = delta !== null && delta < 0;
  const opponentLabel = selectedFriend
    ? (selectedFriend.steam_account_name || selectedFriend.username)
    : currentUser
    ? "YOUR BEST"
    : "HIGH SCORE";
  const isFetchingOpponent = selectedFriend || currentUser ? fetchingFriend : fetchingPersonalBest;

  const shouldShow = isSessionActive || sessionResult !== null || displayScore > 0;

  // Auto-fade 15s after session complete
  useEffect(() => {
    if (sessionResult) {
      setVisible(true);
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      fadeTimer.current = setTimeout(() => setVisible(false), 15_000);
    }
    return () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    };
  }, [sessionResult]);

  useEffect(() => {
    if (isSessionActive) setVisible(true);
  }, [isSessionActive]);

  if (!shouldShow && !preview) return null;
  if (!visible && !preview) return null;

  return (
    <AnimatePresence>
      <motion.div
        key="vs-mode"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.25 }}
        className="select-none"
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        <GlassCard style={{ width: 310, padding: "12px 14px" }}>
          {/* ── Header ──────────────────────────────────────────────────── */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-1.5 min-w-0">
              <Dot color={isSessionActive ? C.accent : "#444"} pulse={isSessionActive} size={6} />
              <span
                className="truncate text-xs"
                style={{ color: C.textMuted, maxWidth: 180 }}
              >
                {activeScenarioRaw ?? "VS MODE"}
              </span>
            </div>
            {sessionResult && (
              <span
                style={{
                  fontSize: 8,
                  fontWeight: 700,
                  letterSpacing: "0.12em",
                  color: C.accent,
                  background: C.accentDim,
                  border: `1px solid ${C.accentBorder}`,
                  borderRadius: 4,
                  padding: "2px 6px",
                }}
              >
                FINAL
              </span>
            )}
          </div>

          {/* ── YOUR score ──────────────────────────────────────────────── */}
          <div className="flex items-baseline justify-between mb-1">
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: C.textFaint }}>
              YOU
            </span>
            <motion.span
              key={displayScore}
              initial={{ opacity: 0.6, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              className="tabular-nums"
              style={{ fontSize: 26, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em", lineHeight: 1 }}
            >
              {formatScore(displayScore)}
            </motion.span>
          </div>

          {/* Your bar */}
          <div
            className="relative overflow-hidden mb-3"
            style={{ height: 5, borderRadius: 3, background: "rgba(255,255,255,0.07)" }}
          >
            <motion.div
              className="absolute left-0 top-0 h-full"
              style={{ background: "linear-gradient(90deg, #00f5a0, #00c8ff)", borderRadius: 3 }}
              initial={{ width: 0 }}
              animate={{ width: `${myPct}%` }}
              transition={{ duration: 0.35, ease: "easeOut" }}
            />
          </div>

          {/* ── OPPONENT ─────────────────────────────────────────────────── */}
          <div style={{ paddingTop: 4, borderTop: `1px solid ${C.borderSub}` }}>
            <div className="flex items-center justify-between mb-1">
              {/* Left: avatar + name */}
              <div className="flex items-center gap-1.5" style={{ pointerEvents: "auto", minWidth: 0 }}>
                {selectedFriend || currentUser ? (
                  (selectedFriend ?? currentUser)?.avatar_url ? (
                    <img
                      src={(selectedFriend ?? currentUser)?.avatar_url}
                      alt={(selectedFriend ?? currentUser)?.username}
                      style={{ width: 16, height: 16, borderRadius: "50%", objectFit: "cover", border: "1px solid rgba(255,255,255,0.15)", flexShrink: 0 }}
                    />
                  ) : (
                    <div style={{ width: 16, height: 16, borderRadius: "50%", background: "#ff6b6b", flexShrink: 0 }} />
                  )
                ) : (
                  <div style={{ width: 16, height: 16, borderRadius: "50%", background: "rgba(255,255,255,0.2)", flexShrink: 0 }} />
                )}

                <span className="truncate" style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", color: C.textMuted, maxWidth: 120 }}>
                  {opponentLabel}
                </span>

                {(selectedFriend || currentUser) && friendSpm !== null && !sessionResult && (
                  <span className="tabular-nums" style={{ fontSize: 9, color: "rgba(255,107,107,0.55)" }}>
                    {friendSpm.toLocaleString()} spm
                  </span>
                )}
              </div>

              {/* Right: score + delta */}
              <div className="flex items-center gap-2">
                <span
                  className="tabular-nums"
                  style={{ fontSize: 13, fontWeight: 600, color: C.textSub }}
                >
                  {isFetchingOpponent
                    ? "…"
                    : opponentDisplayScore !== null
                    ? formatScore(opponentDisplayScore)
                    : "—"}
                </span>
                {delta !== null && (
                  <span
                    className="tabular-nums"
                    style={{
                      fontSize:   12,
                      fontWeight: 700,
                      color:      isAhead ? C.accent : isBehind ? C.danger : "#666",
                      minWidth:   52,
                      textAlign:  "right",
                    }}
                  >
                    {getDeltaLabel(delta)}
                  </span>
                )}
              </div>
            </div>

            {/* Opponent bar */}
            <div
              className="relative overflow-hidden"
              style={{ height: 3, borderRadius: 2, background: "rgba(255,255,255,0.06)" }}
            >
              <motion.div
                className="absolute left-0 top-0 h-full"
                style={{ background: "linear-gradient(90deg, #ff6b6b, #ff9f4a)", borderRadius: 2 }}
                initial={{ width: 0 }}
                animate={{ width: `${opponentPct}%` }}
                transition={{ duration: sessionResult ? 0.35 : 1.0, ease: "easeOut" }}
              />
            </div>
          </div>

          {/* Post-session accuracy */}
          {sessionResult && (
            <div
              className="flex items-center justify-between mt-2.5 pt-2.5"
              style={{ borderTop: `1px solid ${C.borderSub}` }}
            >
              <span style={{ fontSize: 9, color: C.textFaint, letterSpacing: "0.1em" }}>ACCURACY</span>
              <span className="tabular-nums" style={{ fontSize: 13, fontWeight: 600, color: C.textSub }}>
                {sessionResult.accuracy.toFixed(1)}%
              </span>
            </div>
          )}
        </GlassCard>
      </motion.div>
    </AnimatePresence>
  );
}
