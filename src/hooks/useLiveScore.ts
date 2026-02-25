import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { LiveScorePayload, SessionResult } from "../types/stats";

const LIVE_SCORE_EVENT = "live-score";
const SESSION_COMPLETE_EVENT = "session-complete";
const SESSION_START_EVENT = "session-start";

export interface UseLiveScoreReturn {
  liveScore: number | null;
  sessionResult: SessionResult | null;
  isSessionActive: boolean;
  /** Seconds elapsed since session start; 0 when no active session */
  elapsedSeconds: number;
}

export function useLiveScore(): UseLiveScoreReturn {
  const [liveScore, setLiveScore] = useState<number | null>(null);
  const [sessionResult, setSessionResult] = useState<SessionResult | null>(null);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scoreTickInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  // These refs are written by events and read by the 1-second ticker —
  // no re-render needed when they change.
  const sessionStartTime = useRef<number>(0);  // ms timestamp; 0 = no active session
  const latestSpm = useRef<number>(0);          // most recent OCR reading
  const lastSpmChangedAt = useRef<number>(0);   // wall-clock ms when SPM last changed value
  const accumulatedScore = useRef<number>(0);   // running integral of SPM × dt

  // ── 1-second ticker ──────────────────────────────────────────────────────────
  // Each tick adds latestSpm × (1s / 60s) to accumulated score.
  // This is a Riemann sum — monotonically increasing (score can't go backwards).
  // When SPM drops to 0 (user paused) the score simply stops growing.
  const TICK_MS = 1000;
  const startTicker = () => {
    if (scoreTickInterval.current) clearInterval(scoreTickInterval.current);
    scoreTickInterval.current = setInterval(() => {
      if (sessionStartTime.current === 0) return;
      const spm = latestSpm.current;
      // Only accumulate while SPM is actively changing.
      // Rust only emits live-score when the value changes, so if no new event
      // arrived in the last 1.2s the rolling average is stale (player stopped).
      const SPM_STALE_MS = 1200;
      const spmIsLive = spm > 0 && (Date.now() - lastSpmChangedAt.current) < SPM_STALE_MS;
      if (spmIsLive) {
        accumulatedScore.current += spm * (TICK_MS / 60_000);
      }
      setElapsedSeconds(Math.round((Date.now() - sessionStartTime.current) / 1000));
      setLiveScore(Math.round(accumulatedScore.current));
    }, TICK_MS);
  };

  const stopTicker = () => {
    if (scoreTickInterval.current) {
      clearInterval(scoreTickInterval.current);
      scoreTickInterval.current = null;
    }
  };

  useEffect(() => {
    const unlistenStart = listen<void>(SESSION_START_EVENT, () => {
      // Fires on first OCR reading AND on mid-session restart detection in Rust.
      // Always reset clock — this is the authoritative "new run beginning" signal.
      sessionStartTime.current = Date.now();
      latestSpm.current = 0;
      lastSpmChangedAt.current = 0;
      accumulatedScore.current = 0;
      setLiveScore(0);
      setElapsedSeconds(0);
      setIsSessionActive(true);
      startTicker();
    });

    const unlistenLive = listen<LiveScorePayload>(LIVE_SCORE_EVENT, (event) => {
      const { score: spm } = event.payload;
      // Rust only fires this event when the value changes, so every
      // event is a genuine new reading — mark it as live immediately.
      lastSpmChangedAt.current = Date.now();
      latestSpm.current = spm;

      // If session-start hasn't fired yet (mid-session launch), bootstrap the clock
      // from first OCR reading so we show something rather than nothing.
      if (sessionStartTime.current === 0) {
        sessionStartTime.current = Date.now();
        accumulatedScore.current = 0;
        startTicker();
      }

      setIsSessionActive(true);

      // Kick the inactivity watchdog
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      inactivityTimer.current = setTimeout(() => {
        setIsSessionActive(false);
        stopTicker();
      }, 3000);
    });

    const unlistenSession = listen<SessionResult>(SESSION_COMPLETE_EVENT, (event) => {
      stopTicker();
      sessionStartTime.current = 0;
      latestSpm.current = 0;
      lastSpmChangedAt.current = 0;
      accumulatedScore.current = 0;
      setElapsedSeconds(0);
      setSessionResult(event.payload);
      // Use the authoritative score from the CSV
      setLiveScore(event.payload.score);
      setIsSessionActive(false);

      setTimeout(() => setSessionResult(null), 15_000);
    });

    return () => {
      unlistenStart.then((fn) => fn());
      unlistenLive.then((fn) => fn());
      unlistenSession.then((fn) => fn());
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      stopTicker();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { liveScore, sessionResult, isSessionActive, elapsedSeconds };

}
