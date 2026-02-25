import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useLiveScore } from "../hooks/useLiveScore";
import type { FriendProfile } from "../types/friends";

interface VSModeProps {
  currentScenario: string | null;
  /** When true, always render the card even with no session data (for repositioning). */
  preview?: boolean;
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
  const [selectedFriend, setSelectedFriend] = useState<FriendProfile | null>(null);
  const [friendScore, setFriendScore] = useState<number | null>(null);
  const [fetchingFriend, setFetchingFriend] = useState(false);
  const [maxScore, setMaxScore] = useState(0);
  const [visible, setVisible] = useState(true);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track scenario duration for projection; default 60s, updated from sessionResult
  const [scenarioDuration, setScenarioDuration] = useState(60);

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
      .catch(console.error);
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
        .catch(console.error);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Update scenario duration when a session completes
  useEffect(() => {
    if (sessionResult?.duration_secs) {
      setScenarioDuration(sessionResult.duration_secs);
    }
  }, [sessionResult?.duration_secs]);

  // Initial friend score fetch when friend/scenario changes
  useEffect(() => {
    if (!selectedFriend || !currentScenario) {
      setFriendScore(null);
      return;
    }
    setFriendScore(null);
    setFetchingFriend(true);
    invoke<number | null>("fetch_friend_score", {
      username: selectedFriend.username,
      scenarioName: currentScenario,
    })
      .then((score) => setFriendScore(score))
      .catch(() => setFriendScore(null))
      .finally(() => setFetchingFriend(false));
  }, [selectedFriend?.username, currentScenario]);

  // Periodic re-fetch every 30s while session is live (friend may be playing too)
  useEffect(() => {
    if (!isSessionActive || !selectedFriend || !currentScenario) return;
    const id = setInterval(() => {
      invoke<number | null>("fetch_friend_score", {
        username: selectedFriend.username,
        scenarioName: currentScenario,
      })
        .then((score) => setFriendScore(score))
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(id);
  }, [isSessionActive, selectedFriend?.username, currentScenario]);

  const displayScore = sessionResult?.score ?? liveScore ?? 0;

  // Friend's projected score at current elapsed time (linear model)
  // After session ends we compare against their actual final score directly
  const friendProjected =
    friendScore !== null && !sessionResult
      ? Math.round(friendScore * Math.min(elapsedSeconds / scenarioDuration, 1))
      : null;

  // What to show in the score label and delta
  const friendDisplayScore = sessionResult ? friendScore : friendProjected;

  // SPM label shown during live session: friend's total score / (duration / 60) ≈ pts/min
  const friendSpm =
    friendScore !== null
      ? Math.round(friendScore / (scenarioDuration / 60))
      : null;

  const combinedMax = Math.max(displayScore, friendScore ?? 0, maxScore);

  useEffect(() => {
    if (displayScore > maxScore) setMaxScore(displayScore);
  }, [displayScore, maxScore]);

  const myPct = combinedMax > 0 ? (displayScore / combinedMax) * 100 : 0;

  // Friend bar value: grows linearly during session, snaps to final on complete
  const friendBarValue = sessionResult
    ? (friendScore ?? 0)
    : (friendProjected ?? 0);
  const friendPct = combinedMax > 0 ? (friendBarValue / combinedMax) * 100 : 0;

  const delta =
    friendDisplayScore !== null ? displayScore - friendDisplayScore : null;
  const isAhead = delta !== null && delta > 0;
  const isBehind = delta !== null && delta < 0;

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
                {currentScenario ?? "VS MODE"}
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

          {/* ── FRIEND comparison ── */}
          {selectedFriend ? (
            <>
              {/* Friend score row */}
              <div className="flex items-center justify-between mb-1">
                <div
                  className="flex items-center gap-2"
                  style={{ pointerEvents: "auto" }}
                >
                  {selectedFriend.avatar_url ? (
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
                  )}
                  <span
                    className="text-xs"
                    style={{ color: "rgba(255,255,255,0.4)" }}
                  >
                    {selectedFriend.steam_account_name || selectedFriend.username}
                  </span>
                  {/* Flat SPM rate during live session */}
                  {friendSpm !== null && !sessionResult && (
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
                    {fetchingFriend
                      ? "…"
                      : friendDisplayScore !== null
                      ? formatScore(friendDisplayScore)
                      : "—"}
                  </span>
                  {delta !== null && (
                    <motion.span
                      key={delta}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-sm font-bold tabular-nums"
                      style={{
                        color: isAhead ? "#00f5a0" : isBehind ? "#ff6b6b" : "#888",
                        minWidth: 60,
                        textAlign: "right",
                      }}
                    >
                      {getDeltaLabel(delta)}
                    </motion.span>
                  )}
                </div>
              </div>

              {/* Friend projected bar (thinner, red) */}
              <div
                className="relative rounded-full overflow-hidden mb-2"
                style={{ height: 4, background: "rgba(255,255,255,0.06)" }}
              >
                <motion.div
                  className="absolute left-0 top-0 h-full rounded-full"
                  style={{ background: "linear-gradient(90deg, #ff6b6b, #ff9f4a)" }}
                  initial={{ width: 0 }}
                  animate={{ width: `${friendPct}%` }}
                  transition={{
                    duration: sessionResult ? 0.3 : 1.0,
                    ease: "easeOut",
                  }}
                />
              </div>
            </>
          ) : (
            <div
              className="text-xs mt-1 mb-2"
              style={{ color: "rgba(255,255,255,0.2)" }}
            >
              Set a battle opponent in Friends settings.
            </div>
          )}

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
