import { lazy, Suspense, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { VSMode } from "./overlay/VSMode";
import { SmoothnessHUD } from "./overlay/SmoothnessHUD";
import { StatsHUD } from "./overlay/StatsHUD";
import { LiveFeedbackToast } from "./overlay/LiveFeedbackToast";
import { DebugStatsOCR } from "./overlay/DebugStatsOCR";
import { DraggableHUD } from "./overlay/DraggableHUD";
import { PostSessionOverview } from "./overlay/PostSessionOverview";
import type { AppSettings } from "./types/stats";
import "./index.css";

// Heavy components — only loaded on demand
const Settings = lazy(() =>
  import("./settings/Settings").then(m => ({ default: m.Settings }))
);
const UnifiedRegionPicker = lazy(() =>
  import("./settings/UnifiedRegionPicker").then(m => ({ default: m.UnifiedRegionPicker }))
);

type Mode = "overlay" | "settings" | "region-picker" | "layout";

export default function App() {
  const [mode, setMode] = useState<Mode>("overlay");
  const [currentScenario, setCurrentScenario] = useState<string | null>(null);
  const [returnMode, setReturnMode] = useState<"overlay" | "settings">("overlay");
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

  // F8 — toggle settings panel
  useEffect(() => {
    const unlisten = listen<void>("toggle-settings", () => {
      setMode(prev => (prev === "overlay" || prev === "settings") ? (prev === "overlay" ? "settings" : "overlay") : prev);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // F9 — jump straight to region picker; return to overlay when done (not settings)
  useEffect(() => {
    const unlisten = listen<void>("open-region-picker", () => {
      setReturnMode("overlay");
      setMode("region-picker");
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

  // Track current scenario name for VS Mode comparison
  useEffect(() => {
    const unlisten = listen<{ scenario: string }>("session-complete", (e) => {
      setCurrentScenario(e.payload.scenario);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // OCR-detected scenario name (fires at session start, before CSV is written).
  // validate_scenario returns the canonical corrected name, or null if garbage.
  useEffect(() => {
    const unlisten = listen<string>("scenario-detected", (e) => {
      const name = e.payload;
      console.log("[scenario-detected] received:", name);
      invoke<string | null>("validate_scenario", { scenarioName: name })
        .then((canonical) => {
          if (canonical !== null) {
            console.log("[scenario-detected] accepted:", canonical, canonical !== name ? `(corrected from "${name}")` : "");
            setCurrentScenario(canonical);
          } else {
            console.warn("[scenario-detected] rejected:", name);
          }
        })
        .catch((e) => console.error("[scenario-detected] validate_scenario error:", e));
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // Manage mouse click-through: only active in pure overlay mode
  useEffect(() => {
    const passthrough = mode === "overlay";
    invoke("set_mouse_passthrough", { enabled: passthrough }).catch(console.error);
  }, [mode]);

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

      {/* Overlay HUDs — hidden while region picker is open so the game is fully visible */}
      {mode !== "region-picker" && hudVis !== null && (
        <>
          {hudVis.vsmode && (
            <DraggableHUD storageKey="vsmode" defaultPos={{ x: 16, y: 16 }} layoutMode={mode === "layout"}>
              <VSMode currentScenario={currentScenario} preview={true} />
            </DraggableHUD>
          )}
          {hudVis.smoothness && (
            <DraggableHUD storageKey="smoothness" defaultPos={{ x: window.innerWidth - 130, y: window.innerHeight - 80 }} layoutMode={mode === "layout"}>
              <SmoothnessHUD preview={true} />
            </DraggableHUD>
          )}
          {hudVis.stats && (
            <DraggableHUD storageKey="statshud" defaultPos={{ x: window.innerWidth - 160, y: window.innerHeight - 200 }} layoutMode={mode === "layout"}>
              <StatsHUD preview={true} />
            </DraggableHUD>
          )}
          {hudVis.feedback && (
            <DraggableHUD storageKey="feedback" defaultPos={{ x: window.innerWidth - 310, y: window.innerHeight - 160 }} layoutMode={mode === "layout"}>
              <LiveFeedbackToast ttsEnabled={hudVis.ttsEnabled} ttsVoice={hudVis.ttsVoice} />
            </DraggableHUD>
          )}
          {hudVis.postSession && (
            <DraggableHUD storageKey="post-session" defaultPos={{ x: Math.round(window.innerWidth / 2) - 150, y: Math.round(window.innerHeight / 2) - 200 }} layoutMode={mode === "layout"}>
              <PostSessionOverview preview={mode === "layout"} />
            </DraggableHUD>
          )}
          {import.meta.env.DEV && (
            <DraggableHUD storageKey="debug-ocr" defaultPos={{ x: 16, y: window.innerHeight - 280 }} layoutMode={mode === "layout"}>
              <DebugStatsOCR />
            </DraggableHUD>
          )}
        </>
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

      {/* Settings panel — slides in over the overlay */}
      {mode === "settings" && (
        <Suspense fallback={null}>
          <div className="absolute inset-0" style={{ zIndex: 100 }}>
            <Settings
              onClose={() => { setMode("overlay"); reloadHudVis(); }}
              onPickRegions={() => { setReturnMode("settings"); setMode("region-picker"); }}
              onLayoutHUDs={() => { setReturnMode("settings"); setMode("layout"); }}
            />
          </div>
        </Suspense>
      )}

      {/* Region picker — full-screen transparent overlay so user sees the game */}
      {mode === "region-picker" && (
        <Suspense fallback={null}>
          <UnifiedRegionPicker onComplete={() => setMode(returnMode)} />
        </Suspense>
      )}
    </div>
  );
}
