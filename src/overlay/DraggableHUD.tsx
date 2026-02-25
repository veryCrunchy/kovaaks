import { useCallback, useRef, useState } from "react";

interface Pos {
  x: number;
  y: number;
}

interface DraggableHUDProps {
  /** localStorage key to persist position */
  storageKey: string;
  /** Fallback position on first load */
  defaultPos: Pos;
  /** When true, shows a drag-handle ring so the user knows the HUD is repositionable */
  layoutMode?: boolean;
  children: React.ReactNode;
}

/**
 * Wraps an overlay element so it can be dragged anywhere on screen.
 * Position is persisted to localStorage so it survives reloads.
 * Uses pointer capture — no global event listeners needed.
 */
export function DraggableHUD({ storageKey, defaultPos, layoutMode = false, children }: DraggableHUDProps) {
  const [pos, setPos] = useState<Pos>(() => {
    try {
      const saved = localStorage.getItem(`hud-pos:${storageKey}`);
      if (saved) return JSON.parse(saved) as Pos;
    } catch {}
    return defaultPos;
  });

  const isDragging = useRef(false);
  const startMouse = useRef<Pos>({ x: 0, y: 0 });
  const startPos = useRef<Pos>(pos);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      isDragging.current = true;
      startMouse.current = { x: e.clientX, y: e.clientY };
      startPos.current = pos;
    },
    [pos]
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
      try {
        localStorage.setItem(`hud-pos:${storageKey}`, JSON.stringify(newPos));
      } catch {}
    },
    [storageKey]
  );

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        pointerEvents: "auto",
        cursor: isDragging.current ? "grabbing" : "grab",
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
            top: -18,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 9,
            color: "rgba(0,245,160,0.7)",
            fontFamily: "'JetBrains Mono', monospace",
            whiteSpace: "nowrap",
            pointerEvents: "none",
            letterSpacing: "0.05em",
          }}
        >
          drag
        </div>
      )}
      {children}
    </div>
  );
}
