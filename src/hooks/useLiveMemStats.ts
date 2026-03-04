import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

export interface LiveMemStats {
  /** p2 + 0x9C8 — kill count, resets on scenario end */
  kills: number;
  /** p2 + 0x9D8 — unknown; observed as kills+1 */
  tgt: number;
  /** p2 + 0xA74 — total session time (seconds); freezes between stats updates */
  session_time: number;
  /** stats + 0x290 / 10 — shots fired */
  shots_fired: number;
  /** stats + 0x288 — body damage */
  body_damage: number;
  /** stats + 0x2AC — potential damage */
  potential_damage: number;
  /** stats + 0x384 — FOV */
  fov: number;
  /** active scenario name via 7-hop pointer chain; empty string when not in scenario */
  scenario_name: string;
  /** true when game process found and chain resolved */
  connected: boolean;
}

const EVENT = "live-mem-stats";

export function useLiveMemStats(): LiveMemStats | null {
  const [stats, setStats] = useState<LiveMemStats | null>(null);

  useEffect(() => {
    const unlisten = listen<LiveMemStats>(EVENT, (event) => {
      setStats(event.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  return stats;
}
