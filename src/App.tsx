import { lazy, Suspense, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { C, accentAlpha } from "./design/tokens";
import { useAppTheme } from "./hooks/useAppTheme";
import { DesktopOverlay } from "./overlay-system/DesktopOverlay";
import { ShortcutHelpModal } from "./components/ShortcutHelpModal";
import "./index.css";

const Settings = lazy(() =>
  import("./settings/Settings").then((module) => ({ default: module.Settings })),
);

type Mode = "overlay" | "settings" | "layout";

const HUD_GRID_DEFAULT = 16;

export default function App() {
  useAppTheme();

  const [mode, setMode] = useState<Mode>("overlay");
  const [returnMode, setReturnMode] = useState<"overlay" | "settings">("overlay");
  const [gridMode, setGridMode] = useState(false);
  const [gridSize, setGridSize] = useState(HUD_GRID_DEFAULT);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const unlisten = listen<void>("toggle-settings", () => {
      setMode((current) =>
        current === "overlay" || current === "settings"
          ? (current === "overlay" ? "settings" : "overlay")
          : current,
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<void>("toggle-layout-huds", () => {
      setMode((current) => {
        if (current === "layout") return "overlay";
        setReturnMode(current === "settings" ? "settings" : "overlay");
        return "layout";
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tagName = (event.target as HTMLElement | null)?.tagName ?? "";
      const inField = tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
      if (!inField && event.shiftKey && event.key === "?") {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (event.key === "Escape") {
        setHelpOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (mode !== "layout") {
      setGridMode(false);
    }
  }, [mode]);

  return (
    <div
      className="fixed inset-0 select-none"
      style={{ background: "transparent", pointerEvents: mode === "overlay" && !helpOpen ? "none" : "auto" }}
    >
      <DesktopOverlay layoutMode={mode === "layout"} snapGridSize={gridMode ? gridSize : undefined} />

      {mode === "layout" && gridMode && (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            inset: 0,
            pointerEvents: "none",
            zIndex: 1,
            backgroundImage: `
              linear-gradient(to right, ${accentAlpha("1f")} 1px, transparent 1px),
              linear-gradient(to bottom, ${accentAlpha("1f")} 1px, transparent 1px)
            `,
            backgroundSize: `${gridSize}px ${gridSize}px`,
          }}
        />
      )}

      {mode === "layout" && (
        <div
          className="fixed z-50 flex items-center gap-3"
          style={{
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: C.glassDark,
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            padding: "8px 14px",
            fontFamily: "'JetBrains Mono', monospace",
            backdropFilter: "blur(20px) saturate(180%)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)",
            pointerEvents: "auto",
          }}
        >
          <span style={{ fontSize: 10, color: C.textMuted, letterSpacing: "0.04em" }}>
            Drag overlay widgets to reposition
          </span>
          <div style={{ width: 1, height: 16, background: C.border }} />
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 10,
              color: gridMode ? C.accent : C.textMuted,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={gridMode}
              onChange={(event) => setGridMode(event.target.checked)}
            />
            Grid
          </label>
          {gridMode && (
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              {[8, 12, 16, 24, 32].map((size) => (
                <button
                  key={size}
                  onClick={() => setGridSize(size)}
                  style={{
                    background: gridSize === size ? accentAlpha("22") : "rgba(255,255,255,0.06)",
                    border: `1px solid ${gridSize === size ? C.accentBorder : C.border}`,
                    borderRadius: 5,
                    color: gridSize === size ? C.accent : C.textMuted,
                    cursor: "pointer",
                    fontSize: 10,
                    padding: "2px 7px",
                    fontFamily: "inherit",
                    fontWeight: gridSize === size ? 700 : 400,
                  }}
                >
                  {size}
                </button>
              ))}
            </div>
          )}
          <div style={{ width: 1, height: 16, background: C.border }} />
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            style={{
              background: "rgba(255,255,255,0.07)",
              border: `1px solid ${C.border}`,
              borderRadius: 5,
              color: C.textSub,
              cursor: "pointer",
              fontSize: 10,
              padding: "3px 9px",
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 500,
            }}
          >
            Help
          </button>
          <div style={{ width: 1, height: 16, background: C.border }} />
          <button
            onClick={() => setMode(returnMode)}
            style={{
              background: C.accent,
              border: "none",
              borderRadius: 6,
              color: "#000",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 800,
              padding: "4px 16px",
              fontFamily: "inherit",
              letterSpacing: "0.04em",
            }}
          >
            Done
          </button>
        </div>
      )}

      {mode === "settings" && (
        <Suspense fallback={null}>
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ zIndex: 100, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)" }}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setMode("overlay");
              }
            }}
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
                onClose={() => setMode("overlay")}
                onLayoutHUDs={() => {
                  setReturnMode("settings");
                  setMode("layout");
                }}
              />
            </div>
          </div>
        </Suspense>
      )}

      <ShortcutHelpModal
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        title="AimMod Overlay Shortcuts"
        note="The desktop overlay now uses the same shared widget system as the stream/in-game overlay surfaces."
        groups={[
          {
            title: "Overlay",
            items: [
              { keys: "F8", action: "Open or close Settings" },
              { keys: "F10", action: "Toggle overlay layout mode" },
              { keys: "?", action: "Open this shortcuts panel" },
            ],
          },
          {
            title: "Layout Mode",
            items: [
              { keys: "Drag", action: "Move a widget" },
              { keys: "Grid", action: "Turn on snap-to-grid from the floating toolbar" },
              { keys: "Overlay Studio", action: "Use Overlay Studio for styling, visibility, and per-surface themes" },
            ],
          },
          {
            title: "General",
            items: [
              { keys: "Esc", action: "Close the shortcuts panel" },
            ],
          },
        ]}
      />
    </div>
  );
}
