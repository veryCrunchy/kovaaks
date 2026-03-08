import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { StatsPanelReading } from "../types/overlay";
import type { SessionResult } from "../types/overlay";

const SESSION_COMPLETE_EVENT = "session-complete";
const SESSION_START_EVENT = "session-start";
const SESSION_END_EVENT = "session-end";
const STATS_PANEL_EVENT = "stats-panel-update";
const SCORE_TOTAL_STALE_MS = 1500;
const DERIVED_SCORE_FRESH_MS = 3000;
const SESSION_ACTIVITY_STALE_MS = 12_000;

function gameStateImpliesActive(code: number | null | undefined): boolean {
  return code === 3 || code === 4;
}

function hasAuthoritativeActiveContext(
  isInScenario: boolean,
  isInChallenge: boolean,
  gameStateCode: number | null | undefined,
): boolean {
  return isInScenario || isInChallenge || gameStateImpliesActive(gameStateCode);
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
  const lastBridgeActivityAtMs = useRef<number>(0);
  const isInScenario = useRef(false);
  const isInChallenge = useRef(false);
  const activeGameStateCode = useRef<number | null>(null);
  const sessionStartTime = useRef<number>(0); // ms timestamp; 0 = no active session

  const clearSessionState = () => {
    sessionStartTime.current = 0;
    lastScoreTotal.current = null;
    lastScoreTotalAtMs.current = 0;
    lastScoreTotalDerived.current = null;
    lastScoreTotalDerivedAtMs.current = 0;
    lastBridgeActivityAtMs.current = 0;
    isInScenario.current = false;
    isInChallenge.current = false;
    activeGameStateCode.current = null;
    setElapsedSeconds(0);
    setLiveScore(0);
    setIsSessionActive(false);
    if (inactivityTimer.current) {
      clearTimeout(inactivityTimer.current);
      inactivityTimer.current = null;
    }
    stopElapsedTicker();
  };

  const armSessionHeartbeat = () => {
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(() => {
      const now = Date.now();
      const authoritativeActive = hasAuthoritativeActiveContext(
        isInScenario.current,
        isInChallenge.current,
        activeGameStateCode.current,
      );
      const recentlyActive =
        sessionStartTime.current !== 0
        && (now - lastBridgeActivityAtMs.current) <= SESSION_ACTIVITY_STALE_MS;

      if (authoritativeActive || recentlyActive) {
        armSessionHeartbeat();
        return;
      }

      clearSessionState();
    }, SESSION_ACTIVITY_STALE_MS);
  };

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
      lastBridgeActivityAtMs.current = nowMs;
      if (sessionStartTime.current === 0) {
        sessionStartTime.current = nowMs;
        setElapsedSeconds(0);
        startElapsedTicker();
      } else {
        setElapsedSeconds(Math.round((nowMs - sessionStartTime.current) / 1000));
      }
      setIsSessionActive(true);
      armSessionHeartbeat();
    };

    const handleExplicitSessionStart = (nowMs: number) => {
      sessionStartTime.current = nowMs;
      lastScoreTotal.current = null;
      lastScoreTotalAtMs.current = 0;
      lastScoreTotalDerived.current = null;
      lastScoreTotalDerivedAtMs.current = 0;
      touchSessionActive(nowMs);
      setLiveScore(0);
      setElapsedSeconds(0);
      startElapsedTicker();
    };

    const handleExplicitSessionEnd = () => {
      if (hasAuthoritativeActiveContext(
        isInScenario.current,
        isInChallenge.current,
        activeGameStateCode.current,
      )) {
        armSessionHeartbeat();
        return;
      }
      clearSessionState();
    };

    const unlistenStart = listen<void>(SESSION_START_EVENT, () => {
      handleExplicitSessionStart(Date.now());
    });

    const unlistenEnd = listen<void>(SESSION_END_EVENT, () => {
      handleExplicitSessionEnd();
    });

    const unlistenStats = listen<StatsPanelReading>(STATS_PANEL_EVENT, (event) => {
      const now = Date.now();
      const payload = event.payload;
      isInChallenge.current = payload.is_in_challenge === true;
      isInScenario.current = payload.is_in_scenario === true;
      activeGameStateCode.current =
        payload.game_state_code != null && Number.isFinite(payload.game_state_code)
          ? Math.round(payload.game_state_code)
          : activeGameStateCode.current;

      const sessionSeconds = payload.session_time_secs;
      const challengeSeconds = payload.challenge_seconds_total;
      const scoreTotal = payload.score_total;
      const scoreTotalDerived = payload.score_total_derived;
      const hasLiveProgress =
        (sessionSeconds != null && Number.isFinite(sessionSeconds) && sessionSeconds >= 0)
        || (challengeSeconds != null && Number.isFinite(challengeSeconds) && challengeSeconds >= 0)
        || (scoreTotal != null && Number.isFinite(scoreTotal) && scoreTotal >= 0)
        || (scoreTotalDerived != null && Number.isFinite(scoreTotalDerived) && scoreTotalDerived >= 0)
        || hasAuthoritativeActiveContext(
          isInScenario.current,
          isInChallenge.current,
          activeGameStateCode.current,
        );

      if (hasLiveProgress) {
        touchSessionActive(now);
      } else {
        armSessionHeartbeat();
      }

      if (scoreTotal != null && Number.isFinite(scoreTotal) && scoreTotal >= 0) {
        const hasRecentPositiveDerived =
          (lastScoreTotalDerived.current ?? 0) > 0
          && (now - lastScoreTotalDerivedAtMs.current) <= DERIVED_SCORE_FRESH_MS;
        const isLowConfidenceZeroTotal = scoreTotal <= 0.000001 && hasRecentPositiveDerived;

        if (!isLowConfidenceZeroTotal) {
          lastScoreTotal.current = scoreTotal;
          lastScoreTotalAtMs.current = now;
          setLiveScore(Math.round(scoreTotal));
        }
      }

      if (scoreTotalDerived != null && Number.isFinite(scoreTotalDerived) && scoreTotalDerived >= 0) {
        lastScoreTotalDerived.current = scoreTotalDerived;
        lastScoreTotalDerivedAtMs.current = now;

        const hasFreshPositiveTotal = (lastScoreTotal.current ?? 0) > 0
          && (now - lastScoreTotalAtMs.current) <= SCORE_TOTAL_STALE_MS;
        if (!hasFreshPositiveTotal) {
          setLiveScore(Math.round(scoreTotalDerived));
        }
      }
    });

    const unlistenSession = listen<SessionResult>(SESSION_COMPLETE_EVENT, (event) => {
      clearSessionState();
      setSessionResult(event.payload);
      setLiveScore(event.payload.score);

      setTimeout(() => setSessionResult(null), 15_000);
    });

    return () => {
      unlistenStart.then((fn) => fn());
      unlistenEnd.then((fn) => fn());
      unlistenStats.then((fn) => fn());
      unlistenSession.then((fn) => fn());
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      stopElapsedTicker();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { liveScore, sessionResult, isSessionActive, elapsedSeconds };

}
