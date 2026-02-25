import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RegionRect } from "../types/stats";

interface RegionPickerProps {
  onComplete: (rect: RegionRect) => void;
  onCancel: () => void;
  /** Tauri command to call when saving the region. Defaults to "set_region". */
  saveCommand?: string;
}

interface DragState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  active: boolean;
}

interface OverlayOrigin {
  x: number;
  y: number;
  scale_factor: number;
}

export function RegionPicker({ onComplete, onCancel, saveCommand = "set_region" }: RegionPickerProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [saved, setSaved] = useState<RegionRect | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Physical screen origin and DPI scale of the overlay window.
  // CSS coords from mouse events are relative to the overlay viewport top-left;
  // we need to add the overlay's physical screen position to get absolute coords
  // that match what GDI BitBlt reads.
  const [origin, setOrigin] = useState<OverlayOrigin>({ x: 0, y: 0, scale_factor: window.devicePixelRatio ?? 1 });

  useEffect(() => {
    invoke<OverlayOrigin>("get_overlay_origin")
      .then(setOrigin)
      .catch(console.error);
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // left button only
    e.preventDefault();
    setDrag({ startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY, active: true });
    setSaved(null);
    setError(null);
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drag?.active) return;
    setDrag(prev => prev && { ...prev, currentX: e.clientX, currentY: e.clientY });
  }, [drag]);

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (!drag?.active) return;
    const cssX = Math.min(drag.startX, e.clientX);
    const cssY = Math.min(drag.startY, e.clientY);
    const cssW = Math.abs(e.clientX - drag.startX);
    const cssH = Math.abs(e.clientY - drag.startY);
    setDrag(prev => prev && { ...prev, currentX: e.clientX, currentY: e.clientY, active: false });
    if (cssW > 8 && cssH > 8) {
      // Convert CSS coords to absolute physical screen pixels:
      // 1. Multiply by scale_factor (CSS px → physical px relative to overlay origin)
      // 2. Add overlay window's physical screen position (handles non-primary monitors)
      setSaved({
        x: Math.round(cssX * origin.scale_factor) + origin.x,
        y: Math.round(cssY * origin.scale_factor) + origin.y,
        width: Math.round(cssW * origin.scale_factor),
        height: Math.round(cssH * origin.scale_factor),
      });
    }
  }, [drag, origin]);

  const handleSave = useCallback(async () => {
    if (!saved) return;
    setSaving(true);
    setError(null);
    try {
      await invoke(saveCommand, { region: saved });
      onComplete(saved);
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }, [saved, onComplete]);

  // Selection box in CSS pixel space for the visible indicator
  const box = drag
    ? {
        left: Math.min(drag.startX, drag.currentX),
        top: Math.min(drag.startY, drag.currentY),
        width: Math.abs(drag.currentX - drag.startX),
        height: Math.abs(drag.currentY - drag.startY),
      }
    : null;

  const hasBox = box && box.width > 2 && box.height > 2;

  return (
    // Full-screen interaction layer — transparent so the game is visible
    <div
      className="fixed inset-0"
      style={{ cursor: "crosshair", userSelect: "none" }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {/* Subtle full-screen dim */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: "rgba(0,0,0,0.25)" }}
      />

      {/* ── Floating instruction pill (bottom-right, hidden while dragging) ── */}
      {!drag?.active && (
        <div
          className="absolute z-20 flex items-center gap-3"
          style={{
            bottom: 24,
            right: 24,
            background: "rgba(8,8,14,0.92)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 10,
            padding: "8px 14px",
            fontFamily: "'JetBrains Mono', monospace",
            backdropFilter: "blur(12px)",
            pointerEvents: "auto",
            boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          {!saved ? (
            <>
              <span className="text-xs" style={{ color: "rgba(255,255,255,0.5)" }}>
                Drag over the <span style={{ color: "#ffd700" }}>SPM digits</span>
              </span>
              <button
                onClick={onCancel}
                style={{
                  background: "rgba(255,255,255,0.07)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 6,
                  color: "rgba(255,255,255,0.5)",
                  cursor: "pointer",
                  fontSize: 11,
                  padding: "2px 10px",
                  fontFamily: "inherit",
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <span className="text-xs" style={{ color: "#00f5a0" }}>
                {saved.width}×{saved.height}px — looks good?
              </span>
              <button
                onClick={() => { setSaved(null); setDrag(null); }}
                style={{
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 6,
                  color: "rgba(255,255,255,0.45)",
                  cursor: "pointer",
                  fontSize: 11,
                  padding: "2px 10px",
                  fontFamily: "inherit",
                }}
              >
                Redo
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  background: "#00f5a0",
                  border: "none",
                  borderRadius: 6,
                  color: "#000",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "3px 12px",
                  fontFamily: "inherit",
                  opacity: saving ? 0.7 : 1,
                }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Error toast ─────────────────────────────────────────────────── */}
      {error && (
        <div
          className="absolute z-20 pointer-events-none"
          style={{
            bottom: 80,
            right: 24,
            background: "rgba(255,77,77,0.12)",
            border: "1px solid rgba(255,77,77,0.35)",
            borderRadius: 8,
            padding: "6px 12px",
            fontSize: 11,
            color: "#ff6b6b",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {error}
        </div>
      )}

      {/* ── Dragged selection rectangle ────────────────────────────────── */}
      {hasBox && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: box!.left,
            top: box!.top,
            width: box!.width,
            height: box!.height,
            border: "2px solid #00f5a0",
            background: "rgba(0,245,160,0.06)",
            boxShadow: "0 0 0 1px rgba(0,245,160,0.2), 0 0 16px rgba(0,245,160,0.1)",
          }}
        />
      )}

      {/* ── Size readout while actively dragging ────────────────────────── */}
      {hasBox && drag?.active && box!.width > 30 && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: box!.left + box!.width / 2,
            top: box!.top + box!.height + 6,
            transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.7)",
            borderRadius: 4,
            padding: "1px 6px",
            fontSize: 10,
            color: "#00f5a0",
            fontFamily: "'JetBrains Mono', monospace",
            whiteSpace: "nowrap",
          }}
        >
          {Math.abs(drag.currentX - drag.startX)}×{Math.abs(drag.currentY - drag.startY)}
        </div>
      )}
    </div>
  );
}
