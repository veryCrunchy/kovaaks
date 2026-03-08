import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useLiveScore } from "../hooks/useLiveScore";
import { useStatsPanel } from "../hooks/useStatsPanel";
import type { FriendProfile } from "../types/friends";
import { logError } from "../log";

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
    ])
      .then(([list, settings]) => {
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
      ])
        .then(([list, settings]) => {
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
    if (!selectedFriend || !activeScenario) {
      setFriendScore(null);
      return;
    }
    setFetchingFriend(true);
    invoke<number | null>("fetch_friend_score", {
      username: selectedFriend.username,
      scenarioName: activeScenario,
    })
      .then((score) => setFriendScore(score))
      .catch((err) => {
        setFriendScore(null);
        logError(
          "VSMode",
          `Failed to fetch friend score for ${selectedFriend.username} / ${activeScenario}: ${err && err.message ? err.message : err}`
        );
      })
      .finally(() => setFetchingFriend(false));
  }, [selectedFriend?.username, activeScenario]);

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
    if (!isSessionActive || !selectedFriend || !activeScenario) return;
    const id = setInterval(() => {
      invoke<number | null>("fetch_friend_score", {
        username: selectedFriend.username,
        scenarioName: activeScenario,
      })
        .then((score) => setFriendScore(score))
        .catch((err) => {
          logError(
            "VSMode",
            `Periodic fetch_friend_score failed for ${selectedFriend.username} / ${activeScenario}: ${err && err.message ? err.message : err}`
          );
        });
    }, 30_000);
    return () => clearInterval(id);
  }, [isSessionActive, selectedFriend?.username, activeScenario]);

  const displayScore = sessionResult?.score ?? liveScore ?? 0;
  const opponentFinalScore = selectedFriend ? friendScore : personalBestScore;

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
    : "HIGH SCORE";
  const isFetchingOpponent = selectedFriend ? fetchingFriend : fetchingPersonalBest;

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
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.3 }}
        className="select-none"
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        <div
          className="rounded-xl overflow-hidden"
          style={{
            background: "rgba(8, 8, 14, 0.88)",
            border: "1px solid rgba(255,255,255,0.07)",
            backdropFilter: "blur(12px)",
            width: 340,
            padding: "14px 16px",
          }}
        >
          {/* Header row */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div
                className="w-2 h-2 rounded-full"
                style={{
                  background: isSessionActive ? "#00f5a0" : "#666",
                  boxShadow: isSessionActive ? "0 0 6px #00f5a0" : "none",
                }}
              />
              <span
                className="text-xs font-medium"
                style={{ color: "rgba(255,255,255,0.5)" }}
              >
                {activeScenarioRaw ?? "VS MODE"}
              </span>
            </div>
            {sessionResult && (
              <span className="text-xs" style={{ color: "rgba(255,255,255,0.35)" }}>
                FINAL
              </span>
            )}
          </div>

          {/* ── YOUR score ── */}
          <div className="flex items-baseline justify-between mb-1">
            <span
              className="text-xs uppercase tracking-widest"
              style={{ color: "rgba(255,255,255,0.4)" }}
            >
              YOU
            </span>
            <motion.span
              key={displayScore}
              initial={{ opacity: 0.6, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="text-2xl font-bold tabular-nums"
              style={{ color: "#ffffff" }}
            >
              {formatScore(displayScore)}
            </motion.span>
          </div>

          {/* Your progress bar */}
          <div
            className="relative rounded-full overflow-hidden mb-3"
            style={{ height: 6, background: "rgba(255,255,255,0.08)" }}
          >
            <motion.div
              className="absolute left-0 top-0 h-full rounded-full"
              style={{ background: "linear-gradient(90deg, #00f5a0, #00b4ff)" }}
              initial={{ width: 0 }}
              animate={{ width: `${myPct}%` }}
              transition={{ duration: 0.3, ease: "easeOut" }}
            />
          </div>

          {/* ── OPPONENT comparison (friend or personal best fallback) ── */}
          <>
            <div className="flex items-center justify-between mb-1">
              <div
                className="flex items-center gap-2"
                style={{ pointerEvents: "auto" }}
              >
                {selectedFriend ? (
                  selectedFriend.avatar_url ? (
                    <img
                      src={selectedFriend.avatar_url}
                      alt={selectedFriend.username}
                      className="w-4 h-4 rounded-full object-cover flex-shrink-0"
                      style={{ border: "1px solid rgba(255,255,255,0.15)" }}
                    />
                  ) : (
                    <div
                      className="w-4 h-4 rounded-full flex-shrink-0"
                      style={{ background: "#ff6b6b" }}
                    />
                  )
                ) : (
                  <div
                    className="w-4 h-4 rounded-full flex-shrink-0"
                    style={{ background: "rgba(255,255,255,0.25)" }}
                  />
                )}

                <span
                  className="text-xs"
                  style={{ color: "rgba(255,255,255,0.4)" }}
                >
                  {opponentLabel}
                </span>

                {selectedFriend && friendSpm !== null && !sessionResult && (
                  <span
                    className="text-xs tabular-nums"
                    style={{ color: "rgba(255,107,107,0.5)" }}
                  >
                    {friendSpm.toLocaleString()} spm
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <span
                  className="text-sm font-semibold tabular-nums"
                  style={{ color: "rgba(255,255,255,0.55)" }}
                >
                  {isFetchingOpponent
                    ? "…"
                    : opponentDisplayScore !== null
                    ? formatScore(opponentDisplayScore)
                    : "—"}
                </span>
                {delta !== null && (
                  <span
                    className="text-sm font-bold tabular-nums"
                    style={{
                      color: isAhead ? "#00f5a0" : isBehind ? "#ff6b6b" : "#888",
                      minWidth: 60,
                      textAlign: "right",
                    }}
                  >
                    {getDeltaLabel(delta)}
                  </span>
                )}
              </div>
            </div>

            <div
              className="relative rounded-full overflow-hidden mb-2"
              style={{ height: 4, background: "rgba(255,255,255,0.06)" }}
            >
              <motion.div
                className="absolute left-0 top-0 h-full rounded-full"
                style={{ background: "linear-gradient(90deg, #ff6b6b, #ff9f4a)" }}
                initial={{ width: 0 }}
                animate={{ width: `${opponentPct}%` }}
                transition={{
                  duration: sessionResult ? 0.3 : 1.0,
                  ease: "easeOut",
                }}
              />
            </div>
          </>

          {/* Post-session accuracy */}
          {sessionResult && (
            <div
              className="mt-3 pt-3 flex items-center justify-between"
              style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
            >
              <span
                className="text-xs"
                style={{ color: "rgba(255,255,255,0.35)" }}
              >
                Accuracy
              </span>
              <span
                className="text-sm font-semibold tabular-nums"
                style={{ color: "rgba(255,255,255,0.7)" }}
              >
                {(sessionResult.accuracy * 100).toFixed(1)}%
              </span>
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
