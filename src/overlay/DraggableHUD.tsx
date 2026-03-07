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
  /** When true, allows this HUD to receive pointer input outside layout mode. */
  interactive?: boolean;
  children: React.ReactNode;
}

interface Size {
  width: number;
  height: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface RectPadding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const SCALE_MIN = 0.5;
const SCALE_MAX = 2.5;
const SCALE_STEP = 0.1;
const HUD_COLLISION_GAP = 8;
const HUD_EDGE_PADDING = 6;
const HUD_LAYOUT_TOP_INSET = 24;
const HUD_ATTR = "data-hud-draggable";
const HUD_KEY_ATTR = "data-hud-key";

function clampScale(v: number) {
  return Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, v)) * 10) / 10;
}

function samePos(a: Pos, b: Pos) {
  return a.x === b.x && a.y === b.y;
}

function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function expandRect(rect: Rect, pad: RectPadding): Rect {
  return {
    x: rect.x - pad.left,
    y: rect.y - pad.top,
    width: rect.width + pad.left + pad.right,
    height: rect.height + pad.top + pad.bottom,
  };
}

function totalOverlapArea(rect: Rect, others: Rect[], pad: RectPadding) {
  const paddedRect = expandRect(rect, pad);
  let area = 0;
  for (const other of others) {
    const paddedOther = expandRect(other, pad);
    if (!intersects(paddedRect, paddedOther)) continue;
    const overlapW = Math.min(paddedRect.x + paddedRect.width, paddedOther.x + paddedOther.width) - Math.max(paddedRect.x, paddedOther.x);
    const overlapH = Math.min(paddedRect.y + paddedRect.height, paddedOther.y + paddedOther.height) - Math.max(paddedRect.y, paddedOther.y);
    if (overlapW > 0 && overlapH > 0) area += overlapW * overlapH;
  }
  return area;
}

function buildRect(pos: Pos, size: Size): Rect {
  return {
    x: pos.x,
    y: pos.y,
    width: size.width,
    height: size.height,
  };
}

function buildAxisPoints(min: number, max: number, step: number) {
  if (max <= min) return [min];
  const points: number[] = [];
  for (let v = min; v <= max; v += step) points.push(v);
  if (points.length === 0 || points[points.length - 1] !== max) points.push(max);
  return points;
}

function findNearestFreeSpot(desired: Pos, size: Size, others: Rect[], bounds: Bounds, pad: RectPadding): Pos | null {
  const step = 16;
  const xs = buildAxisPoints(bounds.minX, bounds.maxX, step);
  const ys = buildAxisPoints(bounds.minY, bounds.maxY, step);

  let best: { pos: Pos; score: number } | null = null;
  for (const y of ys) {
    for (const x of xs) {
      const candidate = { x, y };
      if (totalOverlapArea(buildRect(candidate, size), others, pad) > 0) continue;
      const dx = candidate.x - desired.x;
      const dy = candidate.y - desired.y;
      const score = dx * dx + dy * dy;
      if (!best || score < best.score) {
        best = { pos: candidate, score };
      }
    }
  }

  return best?.pos ?? null;
}

function buildViewportBounds(size: Size, edgePadding = 0, topInset = 0): Bounds {
  const minX = edgePadding;
  const minY = edgePadding + topInset;
  return {
    minX,
    maxX: Math.max(minX, window.innerWidth - size.width - edgePadding),
    minY,
    maxY: Math.max(minY, window.innerHeight - size.height - edgePadding),
  };
}

function clampPosToBounds(pos: Pos, bounds: Bounds): Pos {
  return {
    x: Math.max(bounds.minX, Math.min(bounds.maxX, pos.x)),
    y: Math.max(bounds.minY, Math.min(bounds.maxY, pos.y)),
  };
}

function readOtherHudRects(storageKey: string): Rect[] {
  const nodes = document.querySelectorAll<HTMLElement>(`[${HUD_ATTR}="1"]`);
  const rects: Rect[] = [];
  for (const node of nodes) {
    if (node.getAttribute(HUD_KEY_ATTR) === storageKey) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    rects.push({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }
  return rects;
}

function resolveCollisions(
  pos: Pos,
  size: Size,
  storageKey: string,
  bounds: Bounds,
  collisionPadding: RectPadding,
): Pos {
  let rect: Rect = {
    x: pos.x,
    y: pos.y,
    width: size.width,
    height: size.height,
  };

  const desired = { ...pos };
  const others = readOtherHudRects(storageKey);
  const desiredRect = buildRect(desired, size);
  if (totalOverlapArea(desiredRect, others, collisionPadding) === 0) {
    return desired;
  }

  for (let i = 0; i < 16; i += 1) {
    const currentOverlap = totalOverlapArea(rect, others, collisionPadding);
    if (currentOverlap === 0) return { x: rect.x, y: rect.y };

    const candidates = new Map<string, { pos: Pos; overlap: number; score: number }>();
    for (const other of others) {
      if (totalOverlapArea(rect, [other], collisionPadding) === 0) continue;

      const trialPositions = [
        { x: other.x - rect.width - HUD_COLLISION_GAP, y: rect.y },
        { x: other.x + other.width + HUD_COLLISION_GAP, y: rect.y },
        { x: rect.x, y: other.y - rect.height - HUD_COLLISION_GAP },
        { x: rect.x, y: other.y + other.height + HUD_COLLISION_GAP },
        { x: other.x - rect.width - HUD_COLLISION_GAP, y: other.y - rect.height - HUD_COLLISION_GAP },
        { x: other.x + other.width + HUD_COLLISION_GAP, y: other.y - rect.height - HUD_COLLISION_GAP },
        { x: other.x - rect.width - HUD_COLLISION_GAP, y: other.y + other.height + HUD_COLLISION_GAP },
        { x: other.x + other.width + HUD_COLLISION_GAP, y: other.y + other.height + HUD_COLLISION_GAP },
      ];

      for (const trial of trialPositions) {
        const clamped = clampPosToBounds(trial, bounds);
        const key = `${Math.round(clamped.x)}:${Math.round(clamped.y)}`;
        const trialRect = buildRect(clamped, size);
        const overlap = totalOverlapArea(trialRect, others, collisionPadding);
        const dx = clamped.x - desired.x;
        const dy = clamped.y - desired.y;
        const score = dx * dx + dy * dy;
        const existing = candidates.get(key);

        if (!existing || overlap < existing.overlap || (overlap === existing.overlap && score < existing.score)) {
          candidates.set(key, { pos: clamped, overlap, score });
        }
      }
    }

    const ordered = Array.from(candidates.values())
      .sort((a, b) => (a.overlap - b.overlap) || (a.score - b.score));

    if (ordered.length === 0) break;
    const best = ordered[0];
    if (best.overlap >= currentOverlap && samePos(best.pos, { x: rect.x, y: rect.y })) {
      break;
    }

    rect = {
      ...rect,
      x: best.pos.x,
      y: best.pos.y,
    };
  }

  if (totalOverlapArea(rect, others, collisionPadding) > 0) {
    const nearestFree = findNearestFreeSpot(desired, size, others, bounds, collisionPadding);
    if (nearestFree) return nearestFree;
  }

  return clampPosToBounds({ x: rect.x, y: rect.y }, bounds);
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
  interactive = false,
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
  const rootRef = useRef<HTMLDivElement | null>(null);

  const getCurrentSize = useCallback((nextScale = scale): Size => {
    const el = rootRef.current;
    if (!el) return { width: 0, height: 0 };
    return {
      width: el.offsetWidth * nextScale,
      height: el.offsetHeight * nextScale,
    };
  }, [scale]);

  const persistPos = useCallback((nextPos: Pos) => {
    try { localStorage.setItem(`hud-pos:${storageKey}`, JSON.stringify(nextPos)); } catch {}
  }, [storageKey]);

  const normalizePos = useCallback((rawPos: Pos, nextScale = scale) => {
    const size = getCurrentSize(nextScale);
    const topInset = layoutMode ? (HUD_LAYOUT_TOP_INSET * nextScale) : 0;
    const bounds = buildViewportBounds(size, HUD_EDGE_PADDING, topInset);
    const clamped = clampPosToBounds(rawPos, bounds);
    const basePad = HUD_COLLISION_GAP / 2;
    const collisionPadding: RectPadding = {
      left: basePad,
      right: basePad,
      top: basePad + (layoutMode ? HUD_LAYOUT_TOP_INSET * nextScale : 0),
      bottom: basePad,
    };
    return resolveCollisions(clamped, size, storageKey, bounds, collisionPadding);
  }, [getCurrentSize, layoutMode, scale, storageKey]);

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
    const dragged = {
      x: startPos.current.x + (e.clientX - startMouse.current.x),
      y: startPos.current.y + (e.clientY - startMouse.current.y),
    };
    setPos(normalizePos(dragged));
  }, [normalizePos]);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      const newPos = normalizePos({
        x: startPos.current.x + (e.clientX - startMouse.current.x),
        y: startPos.current.y + (e.clientY - startMouse.current.y),
      });
      setPos(newPos);
      persistPos(newPos);
    },
    [normalizePos, persistPos]
  );

  const onPointerCancel = useCallback(() => {
    isDragging.current = false;
  }, []);

  const applyScale = useCallback((targetScale: number) => {
    const nextScale = clampScale(targetScale);
    saveScale(nextScale);
    setPos((prev) => {
      const normalized = normalizePos(prev, nextScale);
      if (samePos(prev, normalized)) return prev;
      persistPos(normalized);
      return normalized;
    });
  }, [normalizePos, persistPos, saveScale]);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!layoutMode) return;
      e.preventDefault();
      applyScale(scale + (e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP));
    },
    [applyScale, layoutMode, scale]
  );

  useEffect(() => {
    if (!layoutMode) isDragging.current = false;
  }, [layoutMode]);

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      setPos((prev) => {
        const normalized = normalizePos(prev);
        if (samePos(prev, normalized)) return prev;
        persistPos(normalized);
        return normalized;
      });
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [normalizePos, persistPos]);

  useEffect(() => {
    const onResize = () => {
      setPos((prev) => {
        const normalized = normalizePos(prev);
        if (samePos(prev, normalized)) return prev;
        persistPos(normalized);
        return normalized;
      });
    };

    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [normalizePos, persistPos]);

  return (
    <div
      ref={rootRef}
      data-hud-draggable="1"
      data-hud-key={storageKey}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onWheel={onWheel}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        transform: `scale(${scale})`,
        transformOrigin: "top left",
        pointerEvents: layoutMode || interactive ? "auto" : "none",
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
            <ScaleBtn label="-" onClick={(e) => { e.stopPropagation(); applyScale(scale - SCALE_STEP); }} />
            <span style={{ fontSize: 9, color: "rgba(0,245,160,0.55)", minWidth: 32, textAlign: "center" }}>
              {Math.round(scale * 100)}%
            </span>
            <ScaleBtn label="+" onClick={(e) => { e.stopPropagation(); applyScale(scale + SCALE_STEP); }} />
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
