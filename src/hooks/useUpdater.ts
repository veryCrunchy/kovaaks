import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useState, useCallback } from "react";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; update: Update }
  | { state: "downloading"; progress: number }
  | { state: "ready" }
  | { state: "up-to-date" }
  | { state: "error"; message: string };

export function useUpdater() {
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });

  const checkForUpdate = useCallback(async () => {
    setStatus({ state: "checking" });
    try {
      const update = await check();
      if (!update) {
        setStatus({ state: "up-to-date" });
        setTimeout(() => setStatus({ state: "idle" }), 3000);
        return;
      }
      setStatus({ state: "available", update });
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
      setTimeout(() => setStatus({ state: "idle" }), 5000);
    }
  }, []);

  const installUpdate = useCallback(async (update: Update) => {
    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            setStatus({ state: "downloading", progress: 0 });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setStatus({
              state: "downloading",
              progress: total > 0 ? Math.round((downloaded / total) * 100) : 0,
            });
            break;
          case "Finished":
            setStatus({ state: "ready" });
            break;
        }
      });
      // Relaunch after install completes
      await relaunch();
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
      setTimeout(() => setStatus({ state: "idle" }), 5000);
    }
  }, []);

  return { status, checkForUpdate, installUpdate };
}
