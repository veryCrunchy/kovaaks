import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { SessionResult } from "../types/overlay";

const BRIDGE_METRIC_EVENT = "bridge-metric";
const SESSION_COMPLETE_EVENT = "session-complete";
const SESSION_START_EVENT = "session-start";
const SCORE_TOTAL_STALE_MS = 1500;
const DERIVED_SCORE_FRESH_MS = 3000;

interface BridgeMetricPayload {
  ev: string;
  value?: number | null;
}

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
  const lastScoreTotal = useRef<number | null>(null);
  const lastScoreTotalAtMs = useRef<number>(0);
  const lastScoreTotalDerived = useRef<number | null>(null);
  const lastScoreTotalDerivedAtMs = useRef<number>(0);

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
    const touchSessionActive = (nowMs: number) => {
      if (sessionStartTime.current === 0) {
        sessionStartTime.current = nowMs;
        setElapsedSeconds(0);
        startElapsedTicker();
      } else {
        setElapsedSeconds(Math.round((nowMs - sessionStartTime.current) / 1000));
      }
      setIsSessionActive(true);
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      inactivityTimer.current = setTimeout(() => {
        setIsSessionActive(false);
        stopElapsedTicker();
      }, 3000);
    };

    const unlistenStart = listen<void>(SESSION_START_EVENT, () => {
      sessionStartTime.current = Date.now();
      lastScoreTotal.current = null;
      lastScoreTotalAtMs.current = 0;
      lastScoreTotalDerived.current = null;
      lastScoreTotalDerivedAtMs.current = 0;
      setLiveScore(0);
      setElapsedSeconds(0);
      setIsSessionActive(true);
      startElapsedTicker();
    });

    const unlistenBridgeMetric = listen<BridgeMetricPayload>(BRIDGE_METRIC_EVENT, (event) => {
      const now = Date.now();
      const payload = event.payload;

      if (
        payload.ev === "challenge_start"
        || payload.ev === "scenario_start"
        || payload.ev === "challenge_restart"
        || payload.ev === "scenario_restart"
        || payload.ev === "scenario_restarted"
      ) {
        sessionStartTime.current = now;
        lastScoreTotal.current = null;
        lastScoreTotalAtMs.current = 0;
        lastScoreTotalDerived.current = null;
        lastScoreTotalDerivedAtMs.current = 0;
        setElapsedSeconds(0);
        setLiveScore(0);
        setIsSessionActive(true);
        startElapsedTicker();
        return;
      }

      if (
        payload.ev === "challenge_end"
        || payload.ev === "scenario_end"
        || payload.ev === "challenge_complete"
        || payload.ev === "challenge_completed"
        || payload.ev === "post_challenge_complete"
        || payload.ev === "challenge_canceled"
        || payload.ev === "challenge_quit"
      ) {
        sessionStartTime.current = 0;
        lastScoreTotal.current = null;
        lastScoreTotalAtMs.current = 0;
        lastScoreTotalDerived.current = null;
        lastScoreTotalDerivedAtMs.current = 0;
        setElapsedSeconds(0);
        setLiveScore(0);
        setIsSessionActive(false);
        stopElapsedTicker();
        return;
      }

      if (payload.ev !== "pull_score_total" && payload.ev !== "pull_score_total_derived") {
        return;
      }

      const value = payload.value;
      if (value == null || !Number.isFinite(value) || value < 0) {
        return;
      }

      if (payload.ev === "pull_score_total") {
        const hasRecentPositiveDerived =
          (lastScoreTotalDerived.current ?? 0) > 0
          && (now - lastScoreTotalDerivedAtMs.current) <= DERIVED_SCORE_FRESH_MS;
        const isLowConfidenceZeroTotal = value <= 0.000001 && hasRecentPositiveDerived;

        if (!isLowConfidenceZeroTotal) {
          lastScoreTotal.current = value;
          lastScoreTotalAtMs.current = now;
          setLiveScore(Math.round(value));
        }
      } else {
        lastScoreTotalDerived.current = value;
        lastScoreTotalDerivedAtMs.current = now;

        const hasFreshPositiveTotal = (lastScoreTotal.current ?? 0) > 0
          && (now - lastScoreTotalAtMs.current) <= SCORE_TOTAL_STALE_MS;
        if (!hasFreshPositiveTotal) {
          setLiveScore(Math.round(value));
        }
      }
      touchSessionActive(now);
    });

    const unlistenSession = listen<SessionResult>(SESSION_COMPLETE_EVENT, (event) => {
      stopElapsedTicker();
      sessionStartTime.current = 0;
      lastScoreTotal.current = null;
      lastScoreTotalAtMs.current = 0;
      lastScoreTotalDerived.current = null;
      lastScoreTotalDerivedAtMs.current = 0;
      setElapsedSeconds(0);
      setSessionResult(event.payload);
      setLiveScore(event.payload.score);
      setIsSessionActive(false);

      setTimeout(() => setSessionResult(null), 15_000);
    });

    return () => {
      unlistenStart.then((fn) => fn());
      unlistenBridgeMetric.then((fn) => fn());
      unlistenSession.then((fn) => fn());
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      stopElapsedTicker();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { liveScore, sessionResult, isSessionActive, elapsedSeconds };

}
