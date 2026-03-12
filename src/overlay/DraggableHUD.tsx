import { useCallback, useEffect, useRef, useState } from "react";
import { C, accentAlpha } from "../design/tokens";

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
  /** When true, this HUD is excluded from overlap prevention (both as source and obstacle). */
  excludeFromOverlap?: boolean;
  /** Optional grid size in px for snap-to-grid while dragging in layout mode. */
  snapGridSize?: number;
  /** Optional external preset position target. Applied when presetNonce changes. */
  presetPosition?: Pos;
  /** Increment this value to re-apply presetPosition. */
  presetNonce?: number;
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

interface NormalizeOptions {
  movementBounds?: Bounds;
  skipOverlap?: boolean;
}

interface HudLayoutChangedDetail {
  source: string;
}

const SCALE_MIN = 0.5;
const SCALE_MAX = 2.5;
const SCALE_STEP = 0.1;
const HUD_COLLISION_GAP = 8;
const HUD_EDGE_PADDING = 2;
const HUD_LAYOUT_TOP_INSET = 12;
const HUD_AUTO_SHIFT_LIMIT_X = 140;
const HUD_AUTO_SHIFT_LIMIT_Y = 140;
const HUD_RESIZE_DELTA_EPSILON = 1;
const HUD_LAYOUT_CHANGED_EVENT = "kovaaks:hud-layout-changed";
const HUD_ATTR = "data-hud-draggable";
const HUD_KEY_ATTR = "data-hud-key";
const HUD_OVERLAP_ATTR = "data-hud-overlap";

function clampScale(v: number) {
  return Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, v)) * 10) / 10;
}

function snapToGrid(pos: Pos, gridSize?: number): Pos {
  if (!gridSize || gridSize <= 1) return pos;
  return {
    x: Math.round(pos.x / gridSize) * gridSize,
    y: Math.round(pos.y / gridSize) * gridSize,
  };
}

function distSq(a: Pos, b: Pos) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
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

function mergeBounds(base: Bounds, limit?: Bounds): Bounds {
  if (!limit) return base;

  const minX = Math.max(base.minX, limit.minX);
  const maxX = Math.min(base.maxX, limit.maxX);
  const minY = Math.max(base.minY, limit.minY);
  const maxY = Math.min(base.maxY, limit.maxY);

  return {
    minX: minX <= maxX ? minX : base.minX,
    maxX: minX <= maxX ? maxX : base.maxX,
    minY: minY <= maxY ? minY : base.minY,
    maxY: minY <= maxY ? maxY : base.maxY,
  };
}

function createAnchorBounds(anchor: Pos): Bounds {
  return {
    minX: anchor.x - HUD_AUTO_SHIFT_LIMIT_X,
    maxX: anchor.x + HUD_AUTO_SHIFT_LIMIT_X,
    minY: anchor.y - HUD_AUTO_SHIFT_LIMIT_Y,
    maxY: anchor.y + HUD_AUTO_SHIFT_LIMIT_Y,
  };
}

function readOtherHudRects(storageKey: string): Rect[] {
  const nodes = document.querySelectorAll<HTMLElement>(`[${HUD_ATTR}="1"]`);
  const rects: Rect[] = [];
  for (const node of nodes) {
    if (node.getAttribute(HUD_KEY_ATTR) === storageKey) continue;
    if (node.getAttribute(HUD_OVERLAP_ATTR) !== "1") continue;
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
  excludeFromOverlap = false,
  snapGridSize,
  presetPosition,
  presetNonce = 0,
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
  const anchorPosRef = useRef<Pos>(pos);
  const lastSizeRef = useRef<Size | null>(null);
  const lastPresetNonceRef = useRef<number>(presetNonce);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const snapPosIfNeeded = useCallback((candidate: Pos): Pos => {
    if (!layoutMode) return candidate;
    return snapToGrid(candidate, snapGridSize);
  }, [layoutMode, snapGridSize]);

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

  const emitLayoutChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent<HudLayoutChangedDetail>(HUD_LAYOUT_CHANGED_EVENT, {
      detail: { source: storageKey },
    }));
  }, [storageKey]);

  const getAutoMovementBounds = useCallback((size: Size, nextScale = scale): Bounds => {
    const topInset = layoutMode ? (HUD_LAYOUT_TOP_INSET * nextScale) : 0;
    const viewportBounds = buildViewportBounds(size, HUD_EDGE_PADDING, topInset);
    return mergeBounds(viewportBounds, createAnchorBounds(anchorPosRef.current));
  }, [layoutMode, scale]);

  const normalizePos = useCallback((rawPos: Pos, nextScale = scale, options?: NormalizeOptions) => {
    const size = getCurrentSize(nextScale);
    const topInset = layoutMode ? (HUD_LAYOUT_TOP_INSET * nextScale) : 0;
    const viewportBounds = buildViewportBounds(size, HUD_EDGE_PADDING, topInset);
    const bounds = mergeBounds(viewportBounds, options?.movementBounds);
    const clamped = clampPosToBounds(rawPos, bounds);
    if (!layoutMode || excludeFromOverlap || options?.skipOverlap) return clamped;
    const basePad = HUD_COLLISION_GAP / 2;
    const collisionPadding: RectPadding = {
      left: basePad,
      right: basePad,
      top: basePad + (layoutMode ? HUD_LAYOUT_TOP_INSET * nextScale : 0),
      bottom: basePad,
    };
    return resolveCollisions(clamped, size, storageKey, bounds, collisionPadding);
  }, [excludeFromOverlap, getCurrentSize, layoutMode, scale, storageKey]);

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
    const dragged = snapPosIfNeeded({
      x: startPos.current.x + (e.clientX - startMouse.current.x),
      y: startPos.current.y + (e.clientY - startMouse.current.y),
    });
    setPos(normalizePos(dragged));
  }, [normalizePos, snapPosIfNeeded]);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      const newPos = normalizePos(snapPosIfNeeded({
        x: startPos.current.x + (e.clientX - startMouse.current.x),
        y: startPos.current.y + (e.clientY - startMouse.current.y),
      }));
      setPos(newPos);
      anchorPosRef.current = newPos;
      persistPos(newPos);
      emitLayoutChanged();
    },
    [emitLayoutChanged, normalizePos, persistPos, snapPosIfNeeded]
  );

  const onPointerCancel = useCallback(() => {
    isDragging.current = false;
  }, []);

  const applyScale = useCallback((targetScale: number) => {
    const nextScale = clampScale(targetScale);
    saveScale(nextScale);
    setPos((prev) => {
      const normalized = normalizePos(prev, nextScale);
      anchorPosRef.current = normalized;
      if (samePos(prev, normalized)) return prev;
      persistPos(normalized);
      emitLayoutChanged();
      return normalized;
    });
  }, [emitLayoutChanged, normalizePos, persistPos, saveScale]);

  const tryRestoreTowardAnchor = useCallback(() => {
    if (!layoutMode) return;
    setPos((prev) => {
      const size = getCurrentSize();
      const movementBounds = getAutoMovementBounds(size);
      const restored = normalizePos(anchorPosRef.current, scale, { movementBounds });
      if (samePos(prev, restored)) return prev;
      if (distSq(restored, anchorPosRef.current) >= distSq(prev, anchorPosRef.current)) return prev;
      persistPos(restored);
      emitLayoutChanged();
      return restored;
    });
  }, [emitLayoutChanged, getAutoMovementBounds, getCurrentSize, normalizePos, persistPos, scale]);

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
      lastSizeRef.current = getCurrentSize();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [getCurrentSize, pos]);

  useEffect(() => {
    const onResize = () => {
      if (!layoutMode) {
        setPos((prev) => {
          const normalized = normalizePos(anchorPosRef.current);
          return samePos(prev, normalized) ? prev : normalized;
        });
        lastSizeRef.current = getCurrentSize();
        return;
      }

      setPos((prev) => {
        const normalized = normalizePos(prev);
        if (samePos(prev, normalized)) return prev;
        persistPos(normalized);
        emitLayoutChanged();
        return normalized;
      });
      lastSizeRef.current = getCurrentSize();
      window.requestAnimationFrame(() => {
        tryRestoreTowardAnchor();
      });
    };

    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [emitLayoutChanged, getCurrentSize, normalizePos, persistPos, tryRestoreTowardAnchor]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (isDragging.current) return;

      const currentSize = getCurrentSize();
      const previousSize = lastSizeRef.current;
      lastSizeRef.current = currentSize;
      if (!previousSize) return;

      if (!layoutMode) {
        setPos((prev) => {
          const normalized = normalizePos(anchorPosRef.current);
          return samePos(prev, normalized) ? prev : normalized;
        });
        return;
      }

      const heightDelta = currentSize.height - previousSize.height;
      if (Math.abs(heightDelta) < HUD_RESIZE_DELTA_EPSILON) return;

      const limitedBounds = layoutMode
        ? getAutoMovementBounds(currentSize, scale)
        : undefined;

      setPos((prev) => {
        const roomAbove = limitedBounds ? (prev.y - limitedBounds.minY) : 0;
        const roomBelow = limitedBounds
          ? ((window.innerHeight - HUD_EDGE_PADDING) - (prev.y + previousSize.height))
          : 0;
        const growUp = !!limitedBounds && heightDelta > 0 && roomAbove > roomBelow;

        let desired = prev;
        if (growUp) {
          desired = { x: prev.x, y: prev.y - heightDelta };
        } else if (heightDelta < 0 && prev.y < anchorPosRef.current.y) {
          desired = {
            x: prev.x,
            y: Math.min(anchorPosRef.current.y, prev.y - heightDelta),
          };
        }

        const normalized = normalizePos(desired, scale, { movementBounds: limitedBounds });
        if (samePos(prev, normalized)) return prev;
        persistPos(normalized);
        emitLayoutChanged();
        return normalized;
      });

      window.requestAnimationFrame(() => {
        tryRestoreTowardAnchor();
      });
    });

    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [emitLayoutChanged, getAutoMovementBounds, getCurrentSize, layoutMode, normalizePos, persistPos, scale, tryRestoreTowardAnchor]);

  useEffect(() => {
    const onLayoutChanged = (event: Event) => {
      if (!layoutMode) return;
      const detail = (event as CustomEvent<HudLayoutChangedDetail>).detail;
      if (!detail || detail.source === storageKey) return;
      if (isDragging.current) return;
      tryRestoreTowardAnchor();
    };

    window.addEventListener(HUD_LAYOUT_CHANGED_EVENT, onLayoutChanged);
    return () => {
      window.removeEventListener(HUD_LAYOUT_CHANGED_EVENT, onLayoutChanged);
    };
  }, [layoutMode, storageKey, tryRestoreTowardAnchor]);

  useEffect(() => {
    if (presetNonce === lastPresetNonceRef.current) return;
    lastPresetNonceRef.current = presetNonce;
    if (!presetPosition) return;

    const target = snapPosIfNeeded(presetPosition);
    const normalized = normalizePos(target, scale, { skipOverlap: true });
    setPos((prev) => {
      if (samePos(prev, normalized)) return prev;
      persistPos(normalized);
      return normalized;
    });
    anchorPosRef.current = normalized;
  }, [normalizePos, persistPos, presetNonce, presetPosition, scale, snapPosIfNeeded]);

  const gridColumn = snapGridSize ? Math.round(pos.x / snapGridSize) : null;
  const gridRow = snapGridSize ? Math.round(pos.y / snapGridSize) : null;

  return (
    <div
      ref={rootRef}
      data-hud-draggable="1"
      data-hud-key={storageKey}
      data-hud-overlap={excludeFromOverlap ? "0" : "1"}
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
        outline: layoutMode ? `2px dashed ${accentAlpha("99")}` : "none",
        outlineOffset: 6,
        borderRadius: layoutMode ? 8 : 0,
        boxShadow: layoutMode && isDragging.current ? `0 0 0 1px ${C.accentBorder}, 0 0 28px rgba(0,245,160,0.18)` : "none",
        transition: "outline 0.15s, box-shadow 0.15s",
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
          <span style={{ fontSize: 9, color: accentAlpha("99"), letterSpacing: "0.06em", whiteSpace: "nowrap", fontFamily: "'JetBrains Mono', monospace" }}>
            drag \u00b7 scroll to resize
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <ScaleBtn label="−" onClick={(e) => { e.stopPropagation(); applyScale(scale - SCALE_STEP); }} />
            <span style={{ fontSize: 9, color: C.accent, minWidth: 32, textAlign: "center", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
              {Math.round(scale * 100)}%
            </span>
            <ScaleBtn label="+" onClick={(e) => { e.stopPropagation(); applyScale(scale + SCALE_STEP); }} />
          </div>
        </div>
      )}
      {layoutMode && (
        <div
          style={{
            position: "absolute",
            left: 0,
            bottom: -24,
            display: "flex",
            alignItems: "center",
            gap: 6,
            pointerEvents: "none",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <span
            style={{
              fontSize: 9,
              color: C.textSub,
              background: "rgba(8,12,20,0.86)",
              border: `1px solid ${C.border}`,
              borderRadius: 999,
              padding: "3px 7px",
            }}
          >
            {Math.round(pos.x)}, {Math.round(pos.y)}
          </span>
          {snapGridSize && (
            <span
              style={{
                fontSize: 9,
                color: C.accent,
                background: accentAlpha("14"),
                border: `1px solid ${C.accentBorder}`,
                borderRadius: 999,
                padding: "3px 7px",
              }}
            >
              snap {snapGridSize}px · {gridColumn},{gridRow}
            </span>
          )}
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
        background: accentAlpha("14"),
        border: `1px solid ${accentAlpha("40")}`,
        borderRadius: 4,
        color: C.accent,
        cursor: "pointer",
        fontSize: 12,
        fontFamily: "'JetBrains Mono', monospace",
        lineHeight: 1,
        padding: "2px 6px",
        fontWeight: 700,
      }}
    >
      {label}
    </button>
  );
}
