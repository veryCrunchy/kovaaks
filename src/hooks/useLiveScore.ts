import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { LiveScorePayload, SessionResult } from "../types/overlay";

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
  const elapsedTickInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const sessionStartTime = useRef<number>(0); // ms timestamp; 0 = no active session

  const startElapsedTicker = () => {
    if (elapsedTickInterval.current) clearInterval(elapsedTickInterval.current);
    elapsedTickInterval.current = setInterval(() => {
      if (sessionStartTime.current === 0) return;
      setElapsedSeconds(Math.round((Date.now() - sessionStartTime.current) / 1000));
    }, 1000);
  };

  const stopElapsedTicker = () => {
    if (elapsedTickInterval.current) {
      clearInterval(elapsedTickInterval.current);
      elapsedTickInterval.current = null;
    }
  };

  useEffect(() => {
    const unlistenStart = listen<void>(SESSION_START_EVENT, () => {
      sessionStartTime.current = Date.now();
      setLiveScore(0);
      setElapsedSeconds(0);
      setIsSessionActive(true);
      startElapsedTicker();
    });

    const unlistenLive = listen<LiveScorePayload>(LIVE_SCORE_EVENT, (event) => {
      const now = Date.now();
      const { score, kind } = event.payload;

      // Only trust authoritative totals from mod/bridge.
      if (kind && kind !== "score_total") {
        return;
      }
      if (!Number.isFinite(score) || score < 0) {
        return;
      }

      // Mid-session attach fallback when session-start wasn't observed.
      if (sessionStartTime.current === 0) {
        sessionStartTime.current = now;
        startElapsedTicker();
      }

      setLiveScore(Math.round(score));
      setElapsedSeconds(Math.round((now - sessionStartTime.current) / 1000));
      setIsSessionActive(true);

      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      inactivityTimer.current = setTimeout(() => {
        setIsSessionActive(false);
        stopElapsedTicker();
      }, 3000);
    });

    const unlistenSession = listen<SessionResult>(SESSION_COMPLETE_EVENT, (event) => {
      stopElapsedTicker();
      sessionStartTime.current = 0;
      setElapsedSeconds(0);
      setSessionResult(event.payload);
      setLiveScore(event.payload.score);
      setIsSessionActive(false);

      setTimeout(() => setSessionResult(null), 15_000);
    });

    return () => {
      unlistenStart.then((fn) => fn());
      unlistenLive.then((fn) => fn());
      unlistenSession.then((fn) => fn());
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      stopElapsedTicker();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { liveScore, sessionResult, isSessionActive, elapsedSeconds };

}
