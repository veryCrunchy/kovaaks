import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { LiveFeedback } from "../types/overlay";

export interface ToastEntry extends LiveFeedback {
  id: number;
  expiresAt: number;
}

const EVENT = "live-feedback";
/** How long each toast is visible in milliseconds. */
const TOAST_TTL_MS = 4_000;

let _nextId = 0;

// ─── TTS (disabled — SAPI wiring removed until voice support is resolved) ─────
// TODO: re-enable when a reliable TTS backend is available.
// The Rust `speak_with_sapi` / `list_sapi_voices` commands are preserved in
// lib.rs + sapi.rs for future use.

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Subscribes to the `live-feedback` Tauri event and returns an auto-expiring
 * list of toast notifications.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useLiveFeedback(ttsEnabled = false, voiceName: string | null = null): ToastEntry[] {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const ttsEnabledRef = useRef(ttsEnabled);
  const voiceNameRef  = useRef(voiceName);

  // Keep refs in sync so the event closure always reads the latest values
  useEffect(() => { ttsEnabledRef.current = ttsEnabled; }, [ttsEnabled]);
  useEffect(() => { voiceNameRef.current  = voiceName;  }, [voiceName]);

  // Subscribe to incoming feedback events
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<LiveFeedback>(EVENT, (event) => {
      const entry: ToastEntry = {
        ...event.payload,
        id: _nextId++,
        expiresAt: Date.now() + TOAST_TTL_MS,
      };

      setToasts((prev) => [...prev, entry]);

      // TTS is currently disabled (no reliable voice backend available).
      // if (ttsEnabledRef.current) { speak(entry.message, voiceNameRef.current); }

      // Schedule removal for this specific toast
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== entry.id));
      }, TOAST_TTL_MS);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => { unlisten?.(); };
  }, []);

  return toasts;
}


