import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { MouseMetrics } from "../types/mouse";

const MOUSE_METRICS_EVENT = "mouse-metrics";

export function useMouseMetrics(): MouseMetrics | null {
  const [metrics, setMetrics] = useState<MouseMetrics | null>(null);

  useEffect(() => {
    // Receive live metrics while a session is active
    const unlistenMetrics = listen<MouseMetrics>(MOUSE_METRICS_EVENT, (event) => {
      setMetrics(event.payload);
    });

    // Clear stale metrics as soon as the session ends so the HUD hides
    const unlistenComplete = listen("session-complete", () => {
      setMetrics(null);
    });

    return () => {
      unlistenMetrics.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
    };
  }, []);

  return metrics;
}
