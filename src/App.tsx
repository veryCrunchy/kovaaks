import { lazy, Suspense, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { VSMode } from "./overlay/VSMode";
import { SmoothnessHUD } from "./overlay/SmoothnessHUD";
import { StatsHUD } from "./overlay/StatsHUD";
import { LiveFeedbackToast } from "./overlay/LiveFeedbackToast";
import { DraggableHUD } from "./overlay/DraggableHUD";
import { PostSessionOverview } from "./overlay/PostSessionOverview";
import { BridgeStateDebugHUD } from "./overlay/BridgeStateDebugHUD";
import type { StatsPanelReading } from "./types/overlay";
import type { AppSettings } from "./types/settings";
import "./index.css";

// Heavy components — only loaded on demand
const Settings = lazy(() =>
  import("./settings/Settings").then(m => ({ default: m.Settings }))
);

type Mode = "overlay" | "settings" | "layout";
interface BridgeMetricEvent {
  ev: string;
  field?: string | null;
}

interface CursorPos {
  x: number;
  y: number;
}

interface OverlayOrigin {
  x: number;
  y: number;
  scale_factor: number;
}

type PresetName = "corners" | "right-stack" | "focus-center";
type HudKey = "vsmode" | "smoothness" | "statshud" | "feedback" | "post-session";
type AnchorName =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "center"
  | "left-mid"
  | "right-mid"
  | "top-mid"
  | "bottom-mid"
  | "right-upper"
  | "right-lower"
  | "left-upper"
  | "left-lower"
  | "center-left"
  | "center-right";

interface Point {
  x: number;
  y: number;
}

interface HudSize {
  width: number;
  height: number;
}

interface PlacedHudRect extends HudSize, Point {}

interface Viewport {
  width: number;
  height: number;
}

type HudPresetTargets = Partial<Record<HudKey, Point>>;

const HUD_GRID_DEFAULT = 16;
const HUD_PRESET_KEYS: HudKey[] = ["vsmode", "smoothness", "statshud", "feedback", "post-session"];

const HUD_FALLBACK_SIZES: Record<HudKey, HudSize> = {
  vsmode: { width: 290, height: 112 },
  smoothness: { width: 160, height: 92 },
  statshud: { width: 190, height: 255 },
  feedback: { width: 330, height: 160 },
  "post-session": { width: 470, height: 430 },
};

const PRESET_ORDER: Record<PresetName, HudKey[]> = {
  corners: ["post-session", "statshud", "feedback", "smoothness", "vsmode"],
  "right-stack": ["post-session", "statshud", "feedback", "smoothness", "vsmode"],
  "focus-center": ["post-session", "feedback", "statshud", "smoothness", "vsmode"],
};

const PRESET_ANCHORS: Record<PresetName, Record<HudKey, AnchorName[]>> = {
  corners: {
    vsmode: ["top-left", "left-mid"],
    smoothness: ["top-right", "right-upper"],
    statshud: ["right-upper", "right-mid", "bottom-right"],
    feedback: ["bottom-right", "bottom-mid", "right-lower"],
    "post-session": ["bottom-left", "center-left", "center"],
  },
  "right-stack": {
    vsmode: ["top-left", "left-upper", "left-mid"],
    smoothness: ["top-right", "right-upper"],
    statshud: ["right-upper", "right-mid"],
    feedback: ["right-lower", "bottom-right", "bottom-mid"],
    "post-session": ["center-left", "left-mid", "center"],
  },
  "focus-center": {
    vsmode: ["left-upper", "top-left"],
    smoothness: ["bottom-left", "bottom-mid"],
    statshud: ["right-upper", "top-right"],
    feedback: ["right-lower", "bottom-right"],
    "post-session": ["center", "center-left", "center-right"],
  },
};

function clamp(v: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, v));
}

function anchorToPosition(anchor: AnchorName, size: HudSize, viewport: Viewport, pad: number): Point {
  const centerX = (viewport.width - size.width) / 2;
  const centerY = (viewport.height - size.height) / 2;
  const left = pad;
  const right = viewport.width - pad - size.width;
  const top = pad;
  const bottom = viewport.height - pad - size.height;

  switch (anchor) {
    case "top-left": return { x: left, y: top };
    case "top-right": return { x: right, y: top };
    case "bottom-left": return { x: left, y: bottom };
    case "bottom-right": return { x: right, y: bottom };
    case "center": return { x: centerX, y: centerY };
    case "left-mid": return { x: left, y: centerY };
    case "right-mid": return { x: right, y: centerY };
    case "top-mid": return { x: centerX, y: top };
    case "bottom-mid": return { x: centerX, y: bottom };
    case "right-upper": return { x: right, y: Math.max(top, viewport.height * 0.22 - size.height / 2) };
    case "right-lower": return { x: right, y: Math.min(bottom, viewport.height * 0.72 - size.height / 2) };
    case "left-upper": return { x: left, y: Math.max(top, viewport.height * 0.2 - size.height / 2) };
    case "left-lower": return { x: left, y: Math.min(bottom, viewport.height * 0.72 - size.height / 2) };
    case "center-left": return { x: Math.max(left, centerX - viewport.width * 0.18), y: centerY };
    case "center-right": return { x: Math.min(right, centerX + viewport.width * 0.18), y: centerY };
    default: return { x: left, y: top };
  }
}

function clampPointToViewport(pos: Point, size: HudSize, viewport: Viewport, pad: number): Point {
  const maxX = Math.max(pad, viewport.width - pad - size.width);
  const maxY = Math.max(pad, viewport.height - pad - size.height);
  return {
    x: clamp(Math.round(pos.x), pad, maxX),
    y: clamp(Math.round(pos.y), pad, maxY),
  };
}

function overlapArea(a: PlacedHudRect, b: PlacedHudRect, gap: number): number {
  const left = Math.max(a.x - gap, b.x - gap);
  const right = Math.min(a.x + a.width + gap, b.x + b.width + gap);
  const top = Math.max(a.y - gap, b.y - gap);
  const bottom = Math.min(a.y + a.height + gap, b.y + b.height + gap);
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

function totalOverlap(candidate: PlacedHudRect, placed: PlacedHudRect[], gap: number): number {
  let total = 0;
  for (const p of placed) total += overlapArea(candidate, p, gap);
  return total;
}

function ringOffsets(radius: number): Array<{ dx: number; dy: number }> {
  if (radius === 0) return [{ dx: 0, dy: 0 }];
  const out: Array<{ dx: number; dy: number }> = [];
  for (let dx = -radius; dx <= radius; dx += 1) {
    out.push({ dx, dy: -radius });
    out.push({ dx, dy: radius });
  }
  for (let dy = -radius + 1; dy <= radius - 1; dy += 1) {
    out.push({ dx: -radius, dy });
    out.push({ dx: radius, dy });
  }
  return out;
}

function findBestGridSlot(
  size: HudSize,
  anchors: AnchorName[],
  viewport: Viewport,
  placed: PlacedHudRect[],
  gridStep: number,
  pad: number,
  gap: number,
): Point {
  const maxRadius = Math.max(6, Math.ceil(Math.max(viewport.width, viewport.height) / gridStep));
  let bestFallback: { pos: Point; overlap: number; score: number } | null = null;

  for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
    const base = clampPointToViewport(anchorToPosition(anchors[anchorIndex], size, viewport, pad), size, viewport, pad);
    const seen = new Set<string>();

    for (let radius = 0; radius <= maxRadius; radius += 1) {
      for (const { dx, dy } of ringOffsets(radius)) {
        const candidateRaw: Point = {
          x: base.x + dx * gridStep,
          y: base.y + dy * gridStep,
        };
        const snapped: Point = {
          x: Math.round(candidateRaw.x / gridStep) * gridStep,
          y: Math.round(candidateRaw.y / gridStep) * gridStep,
        };
        const pos = clampPointToViewport(snapped, size, viewport, pad);
        const key = `${pos.x}:${pos.y}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const rect: PlacedHudRect = { ...pos, ...size };
        const overlap = totalOverlap(rect, placed, gap);
        const dist = Math.abs(pos.x - base.x) + Math.abs(pos.y - base.y);
        const score = anchorIndex * 1_000_000 + overlap * 100 + dist;

        if (overlap === 0) return pos;
        if (!bestFallback || overlap < bestFallback.overlap || (overlap === bestFallback.overlap && score < bestFallback.score)) {
          bestFallback = { pos, overlap, score };
        }
      }
    }
  }

  return bestFallback?.pos ?? clampPointToViewport({ x: pad, y: pad }, size, viewport, pad);
}

function readVisibleHudSizes(keys: HudKey[]): Partial<Record<HudKey, HudSize>> {
  const out: Partial<Record<HudKey, HudSize>> = {};
  for (const key of keys) {
    const node = document.querySelector<HTMLElement>(`[data-hud-draggable="1"][data-hud-key="${key}"]`);
    if (!node) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    out[key] = {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }
  return out;
}

function buildHudPreset(name: PresetName, activeKeys: HudKey[], gridStep: number): HudPresetTargets {
  const viewport: Viewport = { width: window.innerWidth, height: window.innerHeight };
  const measured = readVisibleHudSizes(activeKeys);
  const placed: PlacedHudRect[] = [];
  const targets: HudPresetTargets = {};
  const pad = Math.max(10, Math.round(Math.min(viewport.width, viewport.height) * 0.012));
  const gap = Math.max(8, Math.round(gridStep * 0.6));
  const order = PRESET_ORDER[name].filter((key) => activeKeys.includes(key));

  for (const key of order) {
    const size = measured[key] ?? HUD_FALLBACK_SIZES[key];
    const anchors = PRESET_ANCHORS[name][key];
    const pos = findBestGridSlot(size, anchors, viewport, placed, gridStep, pad, gap);
    targets[key] = pos;
    placed.push({ ...pos, ...size });
  }

  return targets;
}

export default function App() {
  const [mode, setMode] = useState<Mode>("overlay");
  const [currentScenario, setCurrentScenario] = useState<string | null>(null);
  const [returnMode, setReturnMode] = useState<"overlay" | "settings">("overlay");
  const [postSessionDismissRect, setPostSessionDismissRect] = useState<DOMRect | null>(null);
  const [gridMode, setGridMode] = useState<boolean>(false);
  const [gridSize, setGridSize] = useState<number>(HUD_GRID_DEFAULT);
  const [presetNonce, setPresetNonce] = useState<number>(0);
  const [presetTargets, setPresetTargets] = useState<HudPresetTargets | null>(null);
  const [debugHudVisible, setDebugHudVisible] = useState<boolean>(() => {
    try {
      return localStorage.getItem("hud-debug-state-visible") === "1";
    } catch {
      return false;
    }
  });
  // HUD visibility — null until loaded from settings (prevents flash of wrong state on startup)
  const [hudVis, setHudVis] = useState<{
    vsmode: boolean;
    smoothness: boolean;
    stats: boolean;
    feedback: boolean;
    postSession: boolean;
    ttsEnabled: boolean;
    ttsVoice: string | null;
  } | null>(null);

  const reloadHudVis = () => {
    invoke<AppSettings>("get_settings").then((s) => {
      setHudVis({
        vsmode: s.hud_vsmode_visible,
        smoothness: s.hud_smoothness_visible,
        stats: s.hud_stats_visible,
        feedback: s.hud_feedback_visible,
        postSession: s.hud_post_session_visible,
        ttsEnabled: s.live_feedback_tts_enabled,
        ttsVoice: s.live_feedback_tts_voice,
      });
    }).catch(console.error);
  };

  // Load initial visibility
  useEffect(() => { reloadHudVis(); }, []);

  // Reload HUD visibility whenever settings are saved (from any context)
  useEffect(() => {
    const unlisten = listen<void>("settings-changed", () => { reloadHudVis(); });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // F8 — toggle settings panel
  useEffect(() => {
    const unlisten = listen<void>("toggle-settings", () => {
      setMode(prev => (prev === "overlay" || prev === "settings") ? (prev === "overlay" ? "settings" : "overlay") : prev);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // F10 — toggle HUD drag-to-reposition mode; return to overlay when done
  useEffect(() => {
    const unlisten = listen<void>("toggle-layout-huds", () => {
      setMode(prev => {
        if (prev === "layout") return "overlay";
        setReturnMode("overlay");
        return "layout";
      });
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  useEffect(() => {
    if (mode !== "layout") {
      setGridMode(false);
    }
  }, [mode]);

  // F9 — toggle bridge state debug HUD
  useEffect(() => {
    const unlisten = listen<void>("toggle-debug-state-overlay", () => {
      setDebugHudVisible((prev) => {
        const next = !prev;
        try {
          localStorage.setItem("hud-debug-state-visible", next ? "1" : "0");
        } catch {}
        return next;
      });
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // Track current scenario name for VS Mode comparison from live bridge/stats events.
  useEffect(() => {
    const applyScenario = (name: string | null | undefined) => {
      const normalized = name?.trim();
      if (!normalized) return;
      setCurrentScenario(normalized);
    };

    const unlistenSessionStart = listen<void>("session-start", () => {
      // Avoid pinning stale scenario from the previous run.
      setCurrentScenario(null);
    });
    const unlistenSessionComplete = listen<{ scenario: string }>("session-complete", (e) => {
      applyScenario(e.payload.scenario);
    });
    const unlistenStatsPanel = listen<StatsPanelReading>("stats-panel-update", (e) => {
      applyScenario(e.payload.scenario_name);
    });
    const unlistenBridgeMetric = listen<BridgeMetricEvent>("bridge-metric", (e) => {
      if (e.payload.ev === "scenario_name") {
        applyScenario(e.payload.field);
      }
    });

    return () => {
      unlistenSessionStart.then((fn) => fn());
      unlistenSessionComplete.then((fn) => fn());
      unlistenStatsPanel.then((fn) => fn());
      unlistenBridgeMetric.then((fn) => fn());
    };
  }, []);

  // Manage mouse click-through: active in overlay mode
  useEffect(() => {
    let cancelled = false;
    let overlayOrigin: OverlayOrigin | null = null;
    let lastPassthrough: boolean | null = null;
    let intervalId: number | null = null;

    const setPassthrough = (enabled: boolean) => {
      if (cancelled || lastPassthrough === enabled) return;
      lastPassthrough = enabled;
      invoke("set_mouse_passthrough", { enabled }).catch(console.error);
    };

    const refreshOverlayOrigin = async () => {
      try {
        overlayOrigin = await invoke<OverlayOrigin>("get_overlay_origin");
      } catch (error) {
        console.error(error);
        overlayOrigin = null;
      }
    };

    const isCursorOverDismissButton = async () => {
      if (!postSessionDismissRect) return false;
      if (!overlayOrigin) {
        await refreshOverlayOrigin();
      }
      if (!overlayOrigin) return false;

      const cursor = await invoke<CursorPos>("get_cursor_pos");
      const padding = 8 * overlayOrigin.scale_factor;
      const left = overlayOrigin.x + postSessionDismissRect.left * overlayOrigin.scale_factor - padding;
      const top = overlayOrigin.y + postSessionDismissRect.top * overlayOrigin.scale_factor - padding;
      const right = overlayOrigin.x + postSessionDismissRect.right * overlayOrigin.scale_factor + padding;
      const bottom = overlayOrigin.y + postSessionDismissRect.bottom * overlayOrigin.scale_factor + padding;

      return cursor.x >= left && cursor.x <= right && cursor.y >= top && cursor.y <= bottom;
    };

    const tick = async () => {
      if (mode !== "overlay") {
        setPassthrough(false);
        return;
      }

      if (!postSessionDismissRect) {
        setPassthrough(true);
        return;
      }

      try {
        setPassthrough(!(await isCursorOverDismissButton()));
      } catch (error) {
        console.error(error);
        setPassthrough(true);
      }
    };

    refreshOverlayOrigin().then(() => { void tick(); });
    intervalId = window.setInterval(() => { void tick(); }, 30);
    window.addEventListener("resize", refreshOverlayOrigin);

    return () => {
      cancelled = true;
      if (intervalId != null) {
        window.clearInterval(intervalId);
      }
      window.removeEventListener("resize", refreshOverlayOrigin);
    };
  }, [mode, postSessionDismissRect]);

  const applyPreset = (name: PresetName) => {
    const activeKeys: HudKey[] = [];
    if (hudVis?.vsmode) activeKeys.push("vsmode");
    if (hudVis?.smoothness) activeKeys.push("smoothness");
    if (hudVis?.stats) activeKeys.push("statshud");
    if (hudVis?.feedback) activeKeys.push("feedback");
    if (hudVis?.postSession) activeKeys.push("post-session");

    const fallbackStep = Math.max(10, Math.min(24, Math.round(Math.min(window.innerWidth, window.innerHeight) / 60)));
    const presetStep = gridMode ? gridSize : fallbackStep;
    const keys = activeKeys.length > 0 ? activeKeys : HUD_PRESET_KEYS;

    setPresetTargets(buildHudPreset(name, keys, presetStep));
    setPresetNonce((v) => v + 1);
  };

  return (
    <div
      className="fixed inset-0 select-none"
      style={{ background: "transparent", pointerEvents: mode === "overlay" ? "none" : "auto" }}
    >
      {/* DEV: corner dot to confirm overlay is active */}
      {import.meta.env.DEV && (
        <div
          style={{
            position: "fixed",
            top: 6,
            right: 6,
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "#00f5a0",
            boxShadow: "0 0 6px #00f5a0",
            pointerEvents: "none",
            zIndex: 9999,
          }}
        />
      )}

      {/* Overlay HUDs */}
      {hudVis !== null && (
        <>
          {hudVis.vsmode && (
            <DraggableHUD
              storageKey="vsmode"
              defaultPos={{ x: 16, y: 16 }}
              layoutMode={mode === "layout"}
              snapGridSize={gridMode ? gridSize : undefined}
              presetPosition={presetTargets?.vsmode}
              presetNonce={presetNonce}
            >
              <VSMode currentScenario={currentScenario} preview={true} />
            </DraggableHUD>
          )}
          {hudVis.smoothness && (
            <DraggableHUD
              storageKey="smoothness"
              defaultPos={{ x: window.innerWidth - 130, y: window.innerHeight - 80 }}
              layoutMode={mode === "layout"}
              snapGridSize={gridMode ? gridSize : undefined}
              presetPosition={presetTargets?.smoothness}
              presetNonce={presetNonce}
            >
              <SmoothnessHUD preview={true} />
            </DraggableHUD>
          )}
          {hudVis.stats && (
            <DraggableHUD
              storageKey="statshud"
              defaultPos={{ x: window.innerWidth - 160, y: window.innerHeight - 200 }}
              layoutMode={mode === "layout"}
              snapGridSize={gridMode ? gridSize : undefined}
              presetPosition={presetTargets?.statshud}
              presetNonce={presetNonce}
            >
              <StatsHUD preview={true} />
            </DraggableHUD>
          )}
          {hudVis.feedback && (
            <DraggableHUD
              storageKey="feedback"
              defaultPos={{ x: window.innerWidth - 310, y: window.innerHeight - 160 }}
              layoutMode={mode === "layout"}
              snapGridSize={gridMode ? gridSize : undefined}
              presetPosition={presetTargets?.feedback}
              presetNonce={presetNonce}
            >
              <LiveFeedbackToast ttsEnabled={hudVis.ttsEnabled} ttsVoice={hudVis.ttsVoice} />
            </DraggableHUD>
          )}
          {hudVis.postSession && (
            <DraggableHUD
              storageKey="post-session"
              defaultPos={{ x: Math.round(window.innerWidth / 2) - 150, y: Math.round(window.innerHeight / 2) - 200 }}
              layoutMode={mode === "layout"}
              interactive={postSessionDismissRect !== null}
              snapGridSize={gridMode ? gridSize : undefined}
              presetPosition={presetTargets?.["post-session"]}
              presetNonce={presetNonce}
            >
              <PostSessionOverview
                preview={mode === "layout"}
                onDismissButtonRectChange={setPostSessionDismissRect}
              />
            </DraggableHUD>
          )}
          {debugHudVisible && (
            <DraggableHUD
              storageKey="bridge-state-debug"
              defaultPos={{ x: 16, y: Math.round(window.innerHeight - 280) }}
              layoutMode={mode === "layout"}
              excludeFromOverlap={true}
              snapGridSize={gridMode ? gridSize : undefined}
            >
              <BridgeStateDebugHUD />
            </DraggableHUD>
          )}
        </>
      )}

      {mode === "layout" && gridMode && (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            inset: 0,
            pointerEvents: "none",
            zIndex: 1,
            backgroundImage: `
              linear-gradient(to right, rgba(0,245,160,0.12) 1px, transparent 1px),
              linear-gradient(to bottom, rgba(0,245,160,0.12) 1px, transparent 1px)
            `,
            backgroundSize: `${gridSize}px ${gridSize}px`,
            backgroundPosition: "0 0, 0 0",
          }}
        />
      )}

      {/* Layout mode — Done button so user can exit repositioning */}
      {mode === "layout" && (
        <div
          className="fixed z-50 flex items-center gap-3"
          style={{
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(8,8,14,0.92)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 10,
            padding: "8px 16px",
            fontFamily: "'JetBrains Mono', monospace",
            backdropFilter: "blur(12px)",
            boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
            pointerEvents: "auto",
          }}
        >
          <span className="text-xs" style={{ color: "rgba(255,255,255,0.45)" }}>
            Drag HUDs to reposition
          </span>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 10,
              color: "rgba(255,255,255,0.72)",
            }}
          >
            <input
              type="checkbox"
              checked={gridMode}
              onChange={(e) => setGridMode(e.target.checked)}
            />
            Grid
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {[8, 12, 16, 24, 32].map((size) => (
              <button
                key={size}
                onClick={() => setGridSize(size)}
                style={{
                  background: gridSize === size ? "rgba(0,245,160,0.25)" : "rgba(255,255,255,0.08)",
                  border: "1px solid rgba(255,255,255,0.2)",
                  borderRadius: 5,
                  color: "rgba(255,255,255,0.88)",
                  cursor: "pointer",
                  fontSize: 10,
                  padding: "2px 6px",
                  fontFamily: "inherit",
                }}
              >
                {size}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <PresetBtn label="Corners" onClick={() => applyPreset("corners")} />
            <PresetBtn label="Right Stack" onClick={() => applyPreset("right-stack")} />
            <PresetBtn label="Focus" onClick={() => applyPreset("focus-center")} />
          </div>
          <button
            onClick={() => setMode(returnMode)}
            style={{
              background: "#00f5a0",
              border: "none",
              borderRadius: 6,
              color: "#000",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 700,
              padding: "3px 14px",
              fontFamily: "inherit",
            }}
          >
            Done
          </button>
        </div>
      )}

      {/* Settings panel — floating overlay, click backdrop to dismiss */}
      {mode === "settings" && (
        <Suspense fallback={null}>
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ zIndex: 100, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)" }}
            onMouseDown={(e) => { if (e.target === e.currentTarget) { setMode("overlay"); reloadHudVis(); } }}
          >
            <div
              style={{
                width: 1040,
                height: 720,
                maxWidth: "94vw",
                maxHeight: "92vh",
                borderRadius: 14,
                overflow: "hidden",
                boxShadow: "0 12px 56px rgba(0,0,0,0.75)",
                border: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <Settings
                onClose={() => { setMode("overlay"); reloadHudVis(); }}
                onLayoutHUDs={() => { setReturnMode("settings"); setMode("layout"); }}
              />
            </div>
          </div>
        </Suspense>
      )}
    </div>
  );
}

function PresetBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "rgba(255,255,255,0.08)",
        border: "1px solid rgba(255,255,255,0.22)",
        borderRadius: 5,
        color: "rgba(255,255,255,0.9)",
        cursor: "pointer",
        fontSize: 10,
        padding: "2px 8px",
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {label}
    </button>
  );
}
