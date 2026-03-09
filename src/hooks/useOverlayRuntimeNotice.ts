import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { OverlayRuntimeNotice } from "../types/overlay";

const EVENT = "overlay-runtime-notice";

const HIDDEN_NOTICE: OverlayRuntimeNotice = {
  visible: false,
  kind: "warning",
  title: "",
  message: "",
};

export function useOverlayRuntimeNotice(): OverlayRuntimeNotice {
  const [notice, setNotice] = useState<OverlayRuntimeNotice>(HIDDEN_NOTICE);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    invoke<OverlayRuntimeNotice>("get_overlay_runtime_notice")
      .then((payload) => {
        if (!cancelled) setNotice(payload);
      })
      .catch(() => {
        if (!cancelled) setNotice(HIDDEN_NOTICE);
      });

    listen<OverlayRuntimeNotice>(EVENT, (event) => {
      setNotice(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return notice;
}
