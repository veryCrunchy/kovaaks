import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { OverlayRenderer } from "./overlay-system/OverlayRenderer";
import { OVERLAY_WIDGET_IDS, getAssignedPreset } from "./overlay-system/presetUtils";
import type { OverlayStateEnvelope } from "./types/overlayRuntime";
import type { OverlaySurfaceId } from "./types/overlayPresets";
import "./index.css";

const BASE_WIDTH = 1920;
const BASE_HEIGHT = 1080;

function surfaceFromLocation(): OverlaySurfaceId {
  const params = new URLSearchParams(window.location.search);
  const surface = params.get("surface");
  if (surface === "in_game" || surface === "desktop_private") return surface;
  return "obs";
}

function apiBaseUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("apiBase") || "http://127.0.0.1:43115";
}

function widgetFilterFromLocation(): string[] | null {
  const params = new URLSearchParams(window.location.search);
  const raw = [
    ...params.getAll("widget"),
    ...params.getAll("widgets").flatMap((value) => value.split(",")),
  ];
  const normalized = Array.from(
    new Set(
      raw
        .map((value) => value.trim())
        .filter((value) => OVERLAY_WIDGET_IDS.includes(value as (typeof OVERLAY_WIDGET_IDS)[number])),
    ),
  );
  return normalized.length ? normalized : null;
}

function BrowserOverlayApp() {
  const [state, setState] = useState<OverlayStateEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ width: BASE_WIDTH, height: BASE_HEIGHT });
  const hostRef = useRef<HTMLDivElement | null>(null);
  const surface = useMemo(surfaceFromLocation, []);
  const baseUrl = useMemo(apiBaseUrl, []);
  const widgetFilter = useMemo(widgetFilterFromLocation, []);

  useEffect(() => {
    let cancelled = false;
    let eventSource: EventSource | null = null;

    const loadInitial = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/streamer-overlay/state`, { cache: "no-store" });
        if (!response.ok) throw new Error(`State request failed: ${response.status}`);
        const payload = (await response.json()) as OverlayStateEnvelope;
        if (!cancelled) {
          setState(payload);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    };

    void loadInitial();

    try {
      eventSource = new EventSource(`${baseUrl}/api/streamer-overlay/events`);
      eventSource.onmessage = (event) => {
        if (cancelled) return;
        try {
          setState(JSON.parse(event.data) as OverlayStateEnvelope);
          setError(null);
        } catch (parseError) {
          setError(parseError instanceof Error ? parseError.message : String(parseError));
        }
      };
      eventSource.onerror = () => {
        if (!cancelled) {
          setError((current) => current ?? "Live overlay feed disconnected");
        }
      };
    } catch (sourceError) {
      setError(sourceError instanceof Error ? sourceError.message : String(sourceError));
    }

    return () => {
      cancelled = true;
      eventSource?.close();
    };
  }, [baseUrl]);

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;

    const syncSize = () => {
      const width = Math.max(1, node.clientWidth);
      const height = Math.max(1, node.clientHeight);
      setViewport((current) =>
        current.width === width && current.height === height ? current : { width, height }
      );
    };

    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(node);
    window.addEventListener("resize", syncSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncSize);
    };
  }, []);

  const preset = state ? getAssignedPreset(state, surface) : null;
  const scaleX = viewport.width / BASE_WIDTH;
  const scaleY = viewport.height / BASE_HEIGHT;

  return (
    <div ref={hostRef} style={{ width: "100%", height: "100%", background: "transparent", overflow: "hidden", position: "relative" }}>
      {preset && state ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: BASE_WIDTH,
            height: BASE_HEIGHT,
            transform: `scale(${scaleX}, ${scaleY})`,
            transformOrigin: "top left",
          }}
        >
          <OverlayRenderer
            preset={preset}
            surface={surface}
            state={state}
            compatibilityMode={surface === "obs" ? "obs" : "default"}
            widgetFilter={widgetFilter}
            style={{ width: BASE_WIDTH, height: BASE_HEIGHT }}
          />
        </div>
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#c7fff0",
            fontFamily: "'JetBrains Mono', monospace",
            background: "transparent",
          }}
        >
          {error || "Waiting for AimMod overlay service…"}
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserOverlayApp />
  </React.StrictMode>,
);
