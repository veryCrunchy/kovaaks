import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { StatsPanelReading } from "../types/stats";

const EVENT = "stats-panel-update";

/**
 * Subscribes to the `stats-panel-update` Tauri event and returns the most
 * recent reading from the in-game stats panel OCR pipeline.
 *
 * Returns `null` until the first event arrives (i.e. no active session).
 */
export function useStatsPanel(): StatsPanelReading | null {
  const [reading, setReading] = useState<StatsPanelReading | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<StatsPanelReading>(EVENT, (event) => {
      setReading(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  return reading;
}
