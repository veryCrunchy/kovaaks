import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { OverlayRenderer } from "./OverlayRenderer";
import { getAssignedPreset } from "./presetUtils";
import type { OverlayStateEnvelope } from "../types/overlayRuntime";
import type { AppSettings } from "../types/settings";

const BASE_WIDTH = 1920;
const BASE_HEIGHT = 1080;
const OVERLAY_STATE_URL = "http://127.0.0.1:43115/api/streamer-overlay/state";
const OVERLAY_EVENTS_URL = "http://127.0.0.1:43115/api/streamer-overlay/events";
const DESKTOP_SURFACE = "desktop_private";

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface DesktopOverlayProps {
  layoutMode: boolean;
  snapGridSize?: number;
}

export function DesktopOverlay({ layoutMode, snapGridSize }: DesktopOverlayProps) {
  const [overlayState, setOverlayState] = useState<OverlayStateEnvelope | null>(null);
  const [layoutState, setLayoutState] = useState<OverlayStateEnvelope | null>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ widgetId: string; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const layoutDirtyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;

    const loadInitial = async () => {
      try {
        const response = await fetch(OVERLAY_STATE_URL, { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as OverlayStateEnvelope;
        if (!cancelled) setOverlayState(payload);
      } catch {}
    };

    void loadInitial();

    try {
      source = new EventSource(OVERLAY_EVENTS_URL);
      source.onmessage = (event) => {
        if (cancelled) return;
        try {
          setOverlayState(JSON.parse(event.data) as OverlayStateEnvelope);
        } catch {}
      };
    } catch {}

    return () => {
      cancelled = true;
      source?.close();
    };
  }, []);

  useEffect(() => {
    const syncSize = () => {
      const node = hostRef.current;
      setViewport({
        width: Math.max(1, node?.clientWidth ?? window.innerWidth),
        height: Math.max(1, node?.clientHeight ?? window.innerHeight),
      });
    };

    syncSize();
    const observer = hostRef.current ? new ResizeObserver(syncSize) : null;
    if (hostRef.current && observer) observer.observe(hostRef.current);
    window.addEventListener("resize", syncSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", syncSize);
    };
  }, []);

  useEffect(() => {
    if (layoutMode && overlayState && !layoutState) {
      setLayoutState(cloneState(overlayState));
      layoutDirtyRef.current = false;
      return;
    }
    if (!layoutMode && layoutState) {
      setLayoutState(null);
      layoutDirtyRef.current = false;
    }
  }, [layoutMode, layoutState, overlayState]);

  const renderState = layoutMode ? (layoutState ?? overlayState) : overlayState;
  const preset = useMemo(
    () => (renderState ? getAssignedPreset(renderState, DESKTOP_SURFACE) : null),
    [renderState],
  );
  const scaleX = viewport.width / BASE_WIDTH;
  const scaleY = viewport.height / BASE_HEIGHT;

  const updateLayoutPlacement = (widgetId: string, patch: Record<string, number>) => {
    setLayoutState((current) => {
      if (!current) return current;
      const next = cloneState(current);
      const presetId = next.active_surface_assignments.desktop_private || next.active_overlay_preset_id;
      const targetPreset = next.overlay_presets.find((entry) => entry.id === presetId);
      const placement = targetPreset?.surface_variants?.desktop_private?.widget_layouts?.[widgetId];
      if (!targetPreset || !placement) return current;
      Object.assign(placement, patch);
      layoutDirtyRef.current = true;
      return next;
    });
  };

  const persistDesktopLayout = async () => {
    if (!layoutDirtyRef.current || !layoutState) return;
    const currentLayout = cloneState(layoutState);
    layoutDirtyRef.current = false;

    const settings = await invoke<AppSettings>("get_settings");
    const presetId = settings.active_surface_assignments.desktop_private || settings.active_overlay_preset_id;
    const sourcePreset = currentLayout.overlay_presets.find((entry) => entry.id === presetId);
    if (!sourcePreset) return;

    const nextSettings = cloneState(settings);
    const targetPreset = nextSettings.overlay_presets.find((entry) => entry.id === presetId);
    if (!targetPreset?.surface_variants?.desktop_private) return;

    targetPreset.surface_variants.desktop_private.widget_layouts =
      cloneState(sourcePreset.surface_variants.desktop_private.widget_layouts);

    await invoke("save_settings", { newSettings: nextSettings });
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!layoutMode || !dragRef.current) return;
      const dx = (event.clientX - dragRef.current.startX) / scaleX;
      const dy = (event.clientY - dragRef.current.startY) / scaleY;
      const snap = snapGridSize && snapGridSize > 1
        ? (value: number) => Math.round(value / snapGridSize) * snapGridSize
        : (value: number) => value;
      updateLayoutPlacement(dragRef.current.widgetId, {
        x: snap(dragRef.current.originX + dx),
        y: snap(dragRef.current.originY + dy),
      });
    };

    const onUp = () => {
      const hadDrag = !!dragRef.current;
      dragRef.current = null;
      if (hadDrag) {
        void persistDesktopLayout().catch(console.error);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [layoutMode, scaleX, scaleY, snapGridSize, layoutState]);

  if (!renderState || !preset) {
    return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
  }

  return (
    <div ref={hostRef} style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: layoutMode ? "auto" : "none" }}>
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
          surface={DESKTOP_SURFACE}
          state={renderState}
          style={{ width: BASE_WIDTH, height: BASE_HEIGHT }}
          renderWidgetChrome={({ widgetId, placement, element }) => (
            <div
              key={widgetId}
              onPointerDown={(event) => {
                if (!layoutMode) return;
                dragRef.current = {
                  widgetId,
                  startX: event.clientX,
                  startY: event.clientY,
                  originX: placement.x,
                  originY: placement.y,
                };
              }}
              style={{
                cursor: layoutMode ? "grab" : "default",
                outline: layoutMode ? "1px dashed rgba(255,255,255,0.18)" : "none",
                outlineOffset: 3,
              }}
            >
              {element}
            </div>
          )}
        />
      </div>
    </div>
  );
}
