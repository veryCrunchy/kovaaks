import { useCallback, useEffect, useRef, useState } from "react";

interface Pos {
  x: number;
  y: number;
}

interface DraggableHUDProps {
  /** localStorage key to persist position and scale */
  storageKey: string;
  /** Fallback position on first load */
  defaultPos: Pos;
  /** Default scale factor (1 = 100%). Persisted to localStorage. */
  defaultScale?: number;
  /** When true, shows drag outline and scale controls */
  layoutMode?: boolean;
  children: React.ReactNode;
}

const SCALE_MIN = 0.5;
const SCALE_MAX = 2.5;
const SCALE_STEP = 0.1;

function clampScale(v: number) {
  return Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, v)) * 10) / 10;
}

/**
 * Wraps an overlay HUD so it can be dragged and resized.
 * - Drag: available only in layout mode (avoids stealing clicks in overlay mode).
 * - Resize: scroll wheel while in layout mode, or \u00b1 buttons in the toolbar.
 * - Position and scale are persisted to localStorage.
 */
export function DraggableHUD({
  storageKey,
  defaultPos,
  defaultScale = 1,
  layoutMode = false,
  children,
}: DraggableHUDProps) {
  const [pos, setPos] = useState<Pos>(() => {
    try {
      const saved = localStorage.getItem(`hud-pos:${storageKey}`);
      if (saved) return JSON.parse(saved) as Pos;
    } catch {}
    return defaultPos;
  });

  const [scale, setScaleState] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(`hud-scale:${storageKey}`);
      if (saved) return clampScale(parseFloat(saved));
    } catch {}
    return defaultScale;
  });

  const saveScale = useCallback(
    (v: number) => {
      const clamped = clampScale(v);
      setScaleState(clamped);
      try { localStorage.setItem(`hud-scale:${storageKey}`, String(clamped)); } catch {}
    },
    [storageKey]
  );

  const isDragging = useRef(false);
  const startMouse = useRef<Pos>({ x: 0, y: 0 });
  const startPos = useRef<Pos>(pos);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!layoutMode) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      isDragging.current = true;
      startMouse.current = { x: e.clientX, y: e.clientY };
      startPos.current = pos;
    },
    [pos, layoutMode]
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging.current) return;
    setPos({
      x: startPos.current.x + (e.clientX - startMouse.current.x),
      y: startPos.current.y + (e.clientY - startMouse.current.y),
    });
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      const newPos: Pos = {
        x: startPos.current.x + (e.clientX - startMouse.current.x),
        y: startPos.current.y + (e.clientY - startMouse.current.y),
      };
      setPos(newPos);
      try { localStorage.setItem(`hud-pos:${storageKey}`, JSON.stringify(newPos)); } catch {}
    },
    [storageKey]
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!layoutMode) return;
      e.preventDefault();
      saveScale(scale + (e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP));
    },
    [layoutMode, scale, saveScale]
  );

  useEffect(() => {
    if (!layoutMode) isDragging.current = false;
  }, [layoutMode]);

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        transform: `scale(${scale})`,
        transformOrigin: "top left",
        pointerEvents: layoutMode ? "auto" : "none",
        cursor: layoutMode ? (isDragging.current ? "grabbing" : "grab") : "default",
        userSelect: "none",
        zIndex: 50,
        outline: layoutMode ? "2px dashed rgba(0,245,160,0.6)" : "none",
        outlineOffset: 6,
        borderRadius: layoutMode ? 8 : 0,
        transition: "outline 0.15s",
      }}
    >
      {layoutMode && (
        <div
          style={{
            position: "absolute",
            top: -24,
            left: 0,
            right: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            pointerEvents: "auto",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <span style={{ fontSize: 9, color: "rgba(0,245,160,0.7)", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
            drag \u00b7 scroll to resize
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <ScaleBtn label="-" onClick={(e) => { e.stopPropagation(); saveScale(scale - SCALE_STEP); }} />
            <span style={{ fontSize: 9, color: "rgba(0,245,160,0.55)", minWidth: 32, textAlign: "center" }}>
              {Math.round(scale * 100)}%
            </span>
            <ScaleBtn label="+" onClick={(e) => { e.stopPropagation(); saveScale(scale + SCALE_STEP); }} />
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

function ScaleBtn({ label, onClick }: { label: string; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      style={{
        background: "rgba(0,245,160,0.12)",
        border: "1px solid rgba(0,245,160,0.3)",
        borderRadius: 3,
        color: "#00f5a0",
        cursor: "pointer",
        fontSize: 11,
        fontFamily: "inherit",
        lineHeight: 1,
        padding: "1px 5px",
      }}
    >
      {label}
    </button>
  );
}
