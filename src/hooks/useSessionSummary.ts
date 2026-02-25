import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { SessionResult, StatsPanelReading } from "../types/overlay";
import type { MouseMetrics } from "../types/mouse";

export interface SessionSummary {
  session: SessionResult;
  metrics: MouseMetrics | null;
  statsPanel: StatsPanelReading | null;
}

/** Auto-dismiss timeout in milliseconds. */
const AUTO_DISMISS_MS = 20_000;

/**
 * Captures a snapshot of all available data when a session ends:
 * - The CSV-derived SessionResult (score, accuracy, kills, duration, etc.)
 * - The last known MouseMetrics reading (cleared once captured)
 * - The last known StatsPanelReading (for SPM, TTK, kills, etc.)
 *
 * The summary auto-dismisses after AUTO_DISMISS_MS and clears when a new
 * session starts.  Call `dismiss()` to close it immediately.
 */
export function useSessionSummary(): {
  summary: SessionSummary | null;
  dismiss: () => void;
  /** 0-1 progress toward auto-dismiss; updated every ~200ms */
  dismissProgress: number;
} {
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [dismissProgress, setDismissProgress] = useState(0);

  // Latest metric snapshots — written by raw events, read on session-complete
  const latestMetrics = useRef<MouseMetrics | null>(null);
  const latestStatsPanel = useRef<StatsPanelReading | null>(null);

  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const dismissedAt = useRef<number>(0);

  const stopTimers = () => {
    if (dismissTimer.current) { clearTimeout(dismissTimer.current); dismissTimer.current = null; }
    if (progressInterval.current) { clearInterval(progressInterval.current); progressInterval.current = null; }
  };

  const dismiss = () => {
    stopTimers();
    setSummary(null);
    setDismissProgress(0);
  };

  useEffect(() => {
    const unlistenMetrics = listen<MouseMetrics>("mouse-metrics", (e) => {
      latestMetrics.current = e.payload;
    });

    const unlistenStats = listen<StatsPanelReading>("stats-panel-update", (e) => {
      latestStatsPanel.current = e.payload;
    });

    const unlistenComplete = listen<SessionResult>("session-complete", (e) => {
      stopTimers();
      setSummary({
        session: e.payload,
        metrics: latestMetrics.current,
        statsPanel: latestStatsPanel.current,
      });
      setDismissProgress(0);

      // Capture snapshot then reset refs so next session starts clean
      latestMetrics.current = null;
      latestStatsPanel.current = null;

      dismissedAt.current = Date.now();
      dismissTimer.current = setTimeout(dismiss, AUTO_DISMISS_MS);
      progressInterval.current = setInterval(() => {
        const elapsed = Date.now() - dismissedAt.current;
        setDismissProgress(Math.min(elapsed / AUTO_DISMISS_MS, 1));
      }, 200);
    });

    const unlistenStart = listen<void>("session-start", () => {
      stopTimers();
      setSummary(null);
      setDismissProgress(0);
      latestMetrics.current = null;
      latestStatsPanel.current = null;
    });

    return () => {
      unlistenMetrics.then(fn => fn());
      unlistenStats.then(fn => fn());
      unlistenComplete.then(fn => fn());
      unlistenStart.then(fn => fn());
      stopTimers();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { summary, dismiss, dismissProgress };
}
