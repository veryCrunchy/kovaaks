import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MetricPoint, RawPositionPoint, ScreenFrame } from "../types/mouse";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OvershootMarker {
  x: number;
  y: number;
  timestamp_ms: number;
}

interface SensitivitySuggestion {
  type: "overshoot" | "undershoot" | "balanced";
  headline: string;
  detail: string;
  badge: string;
  color: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Lerp between two [r,g,b] colours with optional alpha. */
function lerpColor(a: [number, number, number], b: [number, number, number], t: number, alpha = 1): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgba(${r},${g},${bl},${alpha})`;
}

/** Map a normalised speed value (0–1) to a colour on a blue→cyan→green→yellow→red ramp. */
function speedColor(t: number, alpha = 1): string {
  const stops: [number, [number, number, number]][] = [
    [0.00, [30, 100, 255]],   // blue   – stationary / very slow
    [0.25, [0,  200, 220]],   // cyan
    [0.50, [0,  220, 80]],    // green  – typical speed
    [0.75, [255, 220, 0]],    // yellow – fast
    [1.00, [255, 50,  30]],   // red    – spike
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      return lerpColor(c0, c1, (t - t0) / (t1 - t0), alpha);
    }
  }
  return `rgba(255,50,30,${alpha})`;
}

/** Detect overshoot events: direction-reversal in the dominant axis while moving fast. */
function detectOvershoots(pts: RawPositionPoint[]): OvershootMarker[] {
  if (pts.length < 4) return [];
  const markers: OvershootMarker[] = [];

  for (let i = 1; i < pts.length - 2; i++) {
    const prev = pts[i - 1];
    const cur  = pts[i];
    const next = pts[i + 1];

    const dt1 = Math.max((cur.timestamp_ms  - prev.timestamp_ms) / 1000, 0.001);
    const dt2 = Math.max((next.timestamp_ms - cur.timestamp_ms)  / 1000, 0.001);

    const vx1 = (cur.x  - prev.x) / dt1;
    const vy1 = (cur.y  - prev.y) / dt1;
    const vx2 = (next.x - cur.x)  / dt2;
    const vy2 = (next.y - cur.y)  / dt2;

    const spd1 = Math.hypot(vx1, vy1);
    const spd2 = Math.hypot(vx2, vy2);

    // Require both segments to be moving meaningfully
    if (spd1 < 30 || spd2 < 30) continue;

    const dot = (vx1 * vx2 + vy1 * vy2) / (spd1 * spd2);
    // Dot product < -0.5 ≈ angle > 120° = sharp reversal → overshoot
    if (dot < -0.5) {
      markers.push({ x: cur.x, y: cur.y, timestamp_ms: cur.timestamp_ms });
      i += 2; // skip ahead to avoid duplicate markers in the same reversal
    }
  }
  return markers;
}

/** Compute sensitivity training suggestion from per-second metric points. */
function computeSensitivitySuggestion(
  metricPoints: MetricPoint[],
): SensitivitySuggestion | null {
  if (metricPoints.length < 3) return null;
  const avgOvershoot   = avg(metricPoints.map((p) => p.metrics.overshoot_rate));
  const avgCorrection  = avg(metricPoints.map((p) => p.metrics.correction_ratio));
  const avgDirectional = avg(metricPoints.map((p) => p.metrics.directional_bias));

  if (avgOvershoot > 0.28) {
    const bias =
      avgDirectional > 0.4
        ? " (bias detected — also check your starting-position habit)"
        : "";
    return {
      type: "overshoot",
      headline: "Frequent overshoots detected",
      detail:
        `Your session averaged ${Math.round(avgOvershoot * 100)}% overshoot rate${bias}. ` +
        "Train with +20% higher sensitivity for 5–10 runs. The goal is to build smaller, " +
        "more controlled micro-corrections. Afterwards, return to your normal sens — " +
        "you'll find your flicks decelerate earlier.",
      badge: "+20% Sensitivity",
      color: "#ff6b6b",
    };
  }

  if (avgCorrection > 0.58 && avgOvershoot < 0.15) {
    return {
      type: "undershoot",
      headline: "Under-shooting / over-correcting detected",
      detail:
        `You spent ${Math.round(avgCorrection * 100)}% of movement time in the correction phase` +
        " with low overshoot — a sign of hesitant, under-committed flicks. Train with −20% lower " +
        "sensitivity for 5–10 runs to build more confident, large-scale arm movements. " +
        "Afterwards, back to your normal sens — your flicks will feel more direct.",
      badge: "−20% Sensitivity",
      color: "#ffd700",
    };
  }

  return null;
}

// ─── Canvas drawing ───────────────────────────────────────────────────────────

/**
 * Two rendering modes:
 *  - Follow-cam (playHeadFraction ≥ 0): fixed scale where viewportPx fills ~78%
 *    of the canvas width; the "camera" is centred on the current cursor position.
 *    The viewport rectangle is always centred on-screen.  Path points that went
 *    off-screen appear outside the box — this is the 3-D effect.
 *  - Full-path (playHeadFraction < 0): auto-fit bounding box; no viewport overlay.
 */
function drawPath(
  canvas: HTMLCanvasElement,
  pts: RawPositionPoint[],
  overshoots: OvershootMarker[],
  playHeadFraction: number, // 0–1; or <0 to draw full path
  trailFadeMs = 0,           // 0 = no fade; >0 = fade window in ms
  playbackMs = 0,
  viewportPx = 960,          // on-screen monitor capture width in delta-px
) {
  const ctx = canvas.getContext("2d");
  if (!ctx || pts.length < 2) {
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const showFull = playHeadFraction < 0;
  const count    = showFull
    ? pts.length
    : Math.max(2, Math.floor(playHeadFraction * pts.length));

  const CW = canvas.width;
  const CH = canvas.height;
  const PAD = 28;
  const W   = CW - PAD * 2;
  const H   = CH - PAD * 2;

  // ── Camera / projection ───────────────────────────────────────────────────
  let scale: number;
  let toX: (x: number) => number;
  let toY: (y: number) => number;

  if (showFull) {
    // Auto-fit all points
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    scale = Math.min(W / rangeX, H / rangeY);
    const ox = PAD + (W - rangeX * scale) / 2;
    const oy = PAD + (H - rangeY * scale) / 2;
    toX = (x) => ox + (x - minX) * scale;
    toY = (y) => oy + (y - minY) * scale;
  } else {
    // Follow-cam: viewport rectangle fills 65 % of canvas width,
    // leaving ~155 px horizontal and ~95 px vertical margin for off-screen paths.
    scale = (CW * 0.65) / viewportPx;
    const cam = pts[Math.min(count - 1, pts.length - 1)];
    toX = (x) => CW / 2 + (x - cam.x) * scale;
    toY = (y) => CH / 2 + (y - cam.y) * scale;
  }

  // ── Speed palette ─────────────────────────────────────────────────────────
  const speeds: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    const dx = q.x - p.x, dy = q.y - p.y;
    const dt = Math.max((q.timestamp_ms - p.timestamp_ms) / 1000, 0.001);
    speeds.push(Math.hypot(dx, dy) / dt);
  }
  const sorted = [...speeds].sort((a, b) => a - b);
  const p5  = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 1;
  const norm = (s: number) => Math.max(0, Math.min(1, (s - p5) / (p95 - p5 || 1)));

  // ── Clear + grid ──────────────────────────────────────────────────────────
  ctx.clearRect(0, 0, CW, CH);
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  for (let gx = 0; gx <= 4; gx++) {
    const px = PAD + (W / 4) * gx;
    ctx.beginPath(); ctx.moveTo(px, PAD); ctx.lineTo(px, CH - PAD); ctx.stroke();
  }
  for (let gy = 0; gy <= 4; gy++) {
    const py = PAD + (H / 4) * gy;
    ctx.beginPath(); ctx.moveTo(PAD, py); ctx.lineTo(CW - PAD, py); ctx.stroke();
  }

  // ── Viewport rectangle (follow-cam only) ─────────────────────────────────
  if (!showFull) {
    const vpW = viewportPx * scale;
    const vpH = vpW * (9 / 16);
    const vpX = CW / 2 - vpW / 2;
    const vpY = CH / 2 - vpH / 2;

    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0,          0,    CW,        vpY);
    ctx.fillRect(0,          vpY + vpH, CW,   CH - (vpY + vpH));
    ctx.fillRect(0,          vpY,  vpX,       vpH);
    ctx.fillRect(vpX + vpW,  vpY,  CW - (vpX + vpW), vpH);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(0,210,255,0.55)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(vpX, vpY, vpW, vpH);
    ctx.setLineDash([]);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(0,210,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(CW / 2 - 8, CH / 2); ctx.lineTo(CW / 2 + 8, CH / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(CW / 2, CH / 2 - 8); ctx.lineTo(CW / 2, CH / 2 + 8); ctx.stroke();
    ctx.restore();
  }

  // ── Path segments ─────────────────────────────────────────────────────────
  for (let i = 0; i < Math.min(count - 1, speeds.length); i++) {
    let alpha = 1;
    if (trailFadeMs > 0 && !showFull) {
      const age = playbackMs - pts[i + 1].timestamp_ms;
      if (age > trailFadeMs) continue;
      alpha = Math.max(0, 1 - age / trailFadeMs);
    }
    ctx.beginPath();
    ctx.moveTo(toX(pts[i].x), toY(pts[i].y));
    ctx.lineTo(toX(pts[i + 1].x), toY(pts[i + 1].y));
    ctx.strokeStyle = speedColor(norm(speeds[i]), alpha);
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  // ── Overshoot markers ─────────────────────────────────────────────────────
  const cutoff = showFull
    ? Infinity
    : (pts[Math.min(count - 1, pts.length - 1)]?.timestamp_ms ?? Infinity);

  for (const o of overshoots) {
    if (o.timestamp_ms > cutoff) continue;
    let oA = 0.85;
    if (trailFadeMs > 0 && !showFull) {
      const age = playbackMs - o.timestamp_ms;
      if (age > trailFadeMs) continue;
      oA = Math.max(0, 0.85 * (1 - age / trailFadeMs));
    }
    const px = toX(o.x), py = toY(o.y);
    ctx.beginPath();
    ctx.moveTo(px,     py - 10);
    ctx.lineTo(px + 7, py +  4);
    ctx.lineTo(px - 7, py +  4);
    ctx.closePath();
    ctx.fillStyle   = `rgba(255,80,30,${oA})`;
    ctx.strokeStyle = `rgba(255,160,80,${Math.min(1, oA * 1.05)})`;
    ctx.lineWidth   = 1;
    ctx.fill();
    ctx.stroke();
  }

  // ── Click markers ─────────────────────────────────────────────────────────
  for (let i = 0; i < Math.min(count, pts.length); i++) {
    const p = pts[i];
    if (!p.is_click) continue;
    let cA = 0.9;
    if (trailFadeMs > 0 && !showFull) {
      const age = playbackMs - p.timestamp_ms;
      if (age > trailFadeMs) continue;
      cA = Math.max(0, 0.9 * (1 - age / trailFadeMs));
    }
    ctx.beginPath();
    ctx.arc(toX(p.x), toY(p.y), 5, 0, Math.PI * 2);
    ctx.fillStyle   = `rgba(255,220,30,${cA})`;
    ctx.strokeStyle = `rgba(255,255,255,${cA * 0.55})`;
    ctx.lineWidth   = 1;
    ctx.fill();
    ctx.stroke();
  }

  // ── Start / end markers ───────────────────────────────────────────────────
  ctx.beginPath();
  ctx.arc(toX(pts[0].x), toY(pts[0].y), 5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,245,160,0.9)";
  ctx.fill();

  if (showFull) {
    const last = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(toX(last.x), toY(last.y), 5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,80,80,0.9)";
    ctx.fill();
  }

  // ── Playback cursor ───────────────────────────────────────────────────────
  if (!showFull) {
    // In follow-cam mode the cursor is always the canvas centre
    ctx.beginPath();
    ctx.arc(CW / 2, CH / 2, 7, 0, Math.PI * 2);
    ctx.fillStyle   = "rgba(255,255,255,0.95)";
    ctx.strokeStyle = "#000";
    ctx.lineWidth   = 1.5;
    ctx.fill();
    ctx.stroke();
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

/** Binary-search nearest recording frame for the given playback time. */
function nearestFrameIdx(frames: ScreenFrame[], ms: number): number {
  if (!frames.length) return 0;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].timestamp_ms < ms) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && ms - frames[lo - 1].timestamp_ms < frames[lo].timestamp_ms - ms) lo--;
  return lo;
}

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4];

const VIEWPORT_PRESETS: { label: string; w: number }[] = [
  { label: "1080p", w: 960  },  // 50% of 1920
  { label: "1440p", w: 1280 },  // 50% of 2560
  { label: "4K",    w: 1920 },  // 50% of 3840
];

const TRAIL_OPTIONS = [
  { label: "Off",  ms: 0     },
  { label: "0.5s", ms: 500   },
  { label: "1s",   ms: 1000  },
  { label: "3s",   ms: 3000  },
  { label: "5s",   ms: 5000  },
];

const BG_OPACITY_OPTIONS = [
  { label: "25%", v: 0.25 },
  { label: "50%", v: 0.50 },
  { label: "75%", v: 0.75 },
];

interface Props {
  rawPositions: RawPositionPoint[];
  metricPoints: MetricPoint[];
  screenFrames: ScreenFrame[];
}

export function MousePathViewer({ rawPositions, metricPoints, screenFrames }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef   = useRef<number | null>(null);

  const [isPlaying,    setIsPlaying]    = useState(false);
  const [playbackMs,   setPlaybackMs]   = useState(0);
  const [speed,        setSpeed]        = useState(1);
  const [showFull,     setShowFull]     = useState(false);
  const [trailFadeMs,  setTrailFadeMs]  = useState(0);
  const [bgOpacity,    setBgOpacity]    = useState(0.5);
  const [viewportW,    setViewportW]    = useState(960);

  const hasVideo = screenFrames.length > 0;

  const durationMs = rawPositions.length > 0
    ? rawPositions[rawPositions.length - 1].timestamp_ms
    : 0;

  const overshoots = useCallback(() => detectOvershoots(rawPositions), [rawPositions])();
  const suggestion = useCallback(
    () => computeSensitivitySuggestion(metricPoints),
    [metricPoints],
  )();

  // Nearest game recording frame for the current playback position
  const currentFrameSrc = useMemo<string | null>(() => {
    if (!hasVideo || showFull) return null;
    const idx = nearestFrameIdx(screenFrames, playbackMs);
    return `data:image/jpeg;base64,${screenFrames[idx].jpeg_b64}`;
  }, [screenFrames, playbackMs, showFull, hasVideo]);

  // ── Redraw on state change ────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (rawPositions.length < 2) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const fraction = showFull
      ? -1
      : durationMs > 0
        ? Math.min(1, playbackMs / durationMs)
        : -1;
    drawPath(canvas, rawPositions, overshoots, fraction, showFull ? 0 : trailFadeMs, playbackMs, viewportW);
  }, [rawPositions, overshoots, playbackMs, durationMs, showFull, trailFadeMs, viewportW]);

  // ── Playback loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying) {
      if (animRef.current != null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
      return;
    }

    let lastTs: number | null = null;

    const tick = (ts: number) => {
      if (lastTs !== null) {
        const delta = (ts - lastTs) * speed;
        setPlaybackMs((prev) => {
          const next = prev + delta;
          if (next >= durationMs) {
            setIsPlaying(false);
            return durationMs;
          }
          return next;
        });
      }
      lastTs = ts;
      animRef.current = requestAnimationFrame(tick);
    };

    animRef.current = requestAnimationFrame(tick);
    return () => {
      if (animRef.current != null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
    };
  }, [isPlaying, speed, durationMs]);

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    setIsPlaying(false);
    setShowFull(false);
    setPlaybackMs(Number(e.target.value));
  };

  const handlePlayPause = () => {
    setShowFull(false);
    if (playbackMs >= durationMs) setPlaybackMs(0);
    setIsPlaying((v) => !v);
  };

  const handleShowFull = () => {
    setIsPlaying(false);
    setShowFull((v) => !v);
  };

  const formatMs = (ms: number) =>
    `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${String(Math.floor((ms % 1000) / 100)).padStart(1, "0")}`;

  if (rawPositions.length < 2) {
    return (
      <div
        className="rounded-xl p-4 mb-4"
        style={{
          background: "rgba(255,255,255,0.03)",
          border:     "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <h3
          className="text-xs uppercase tracking-widest mb-2"
          style={{ color: "rgba(255,255,255,0.4)" }}
        >
          Mouse Path Replay
        </h3>
        <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 13 }}>
          No path data recorded. Mouse tracking requires at least one active session.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-4 flex flex-col gap-3">
      {/* Canvas */}
      <div
        className="rounded-xl overflow-hidden"
        style={{
          background: "rgba(255,255,255,0.025)",
          border:     "1px solid rgba(255,255,255,0.08)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-2"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
        >
          <h3
            className="text-xs uppercase tracking-widest"
            style={{ color: "rgba(255,255,255,0.4)" }}
          >
            Mouse Path Replay
          </h3>
          <div className="flex items-center gap-3" style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
            {/* Stat pills */}
            {hasVideo && (
              <span style={{ color: "rgba(0,245,160,0.7)" }}>
                ● {screenFrames.length} frames
              </span>
            )}
            <span>
              <span style={{ color: "rgba(255,220,30,0.9)" }}>●</span>{" "}
              {rawPositions.filter((p) => p.is_click).length} clicks
            </span>
            <span>
              <span style={{ color: "rgba(255,80,30,0.8)" }}>▲</span>{" "}
              {overshoots.length} overshoots
            </span>
            <span>{rawPositions.length.toLocaleString()} samples</span>
          </div>
        </div>

        {/* Legend bar */}
        <div
          className="flex items-center gap-3 px-4 py-1.5 text-xs"
          style={{
            borderBottom: "1px solid rgba(255,255,255,0.04)",
            color: "rgba(255,255,255,0.3)",
          }}
        >
          <span>Speed:</span>
          <div
            className="rounded"
            style={{
              width: 120,
              height: 8,
              background: "linear-gradient(to right, rgb(30,100,255), rgb(0,200,220), rgb(0,220,80), rgb(255,220,0), rgb(255,50,30))",
            }}
          />
          <span>slow → fast</span>
          <span className="ml-2">
            <span style={{ color: "rgba(0,245,160,0.9)" }}>●</span> start
          </span>
          <span>
            <span style={{ color: "rgba(255,80,80,0.9)" }}>●</span> end
          </span>
          <span>
            <span style={{ color: "rgba(255,220,30,0.9)" }}>●</span> click
          </span>
          <span>
            <span style={{ color: "rgba(255,80,30,0.85)" }}>▲</span> overshoot
          </span>
          <span>
            <span style={{ color: "rgba(0,210,255,0.7)" }}>⬜</span> viewport
          </span>
        </div>

        {/* Canvas + game recording underlay */}
        <div style={{ position: "relative", lineHeight: 0 }}>
          {currentFrameSrc && (
            <img
              src={currentFrameSrc}
              alt=""
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                opacity: bgOpacity,
                pointerEvents: "none",
                filter: "blur(0.5px)",
              }}
            />
          )}
          <canvas
            ref={canvasRef}
            width={900}
            height={520}
            style={{ width: "100%", height: "auto", display: "block", position: "relative", zIndex: 1 }}
          />
        </div>

        {/* Controls */}
        <div
          className="px-4 py-3 flex flex-col gap-2"
          style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
        >
          {/* Timeline scrubber */}
          <div className="flex items-center gap-3">
            <span
              className="tabular-nums"
              style={{ color: "rgba(255,255,255,0.45)", fontSize: 11, minWidth: 60 }}
            >
              {formatMs(showFull ? durationMs : playbackMs)}
            </span>
            <input
              type="range"
              min={0}
              max={durationMs}
              step={50}
              value={showFull ? durationMs : playbackMs}
              onChange={handleScrub}
              className="flex-1"
              style={{ accentColor: "#00f5a0" }}
            />
            <span
              className="tabular-nums"
              style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, minWidth: 60, textAlign: "right" }}
            >
              {formatMs(durationMs)}
            </span>
          </div>

          {/* Buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Play / pause */}
            <button
              onClick={handlePlayPause}
              className="rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors"
              style={{
                background:  isPlaying ? "rgba(0,245,160,0.15)" : "rgba(0,245,160,0.12)",
                border:      "1px solid rgba(0,245,160,0.3)",
                color:       "#00f5a0",
                cursor:      "pointer",
              }}
            >
              {isPlaying ? "⏸ Pause" : playbackMs >= durationMs ? "↺ Replay" : "▶ Play"}
            </button>

            {/* Reset */}
            <button
              onClick={() => { setIsPlaying(false); setPlaybackMs(0); setShowFull(false); }}
              className="rounded-lg px-3 py-1.5 text-sm transition-colors"
              style={{
                background: "rgba(255,255,255,0.05)",
                border:     "1px solid rgba(255,255,255,0.1)",
                color:      "rgba(255,255,255,0.5)",
                cursor:     "pointer",
              }}
            >
              ↺ Reset
            </button>

            {/* Show full path toggle */}
            <button
              onClick={handleShowFull}
              className="rounded-lg px-3 py-1.5 text-sm transition-colors"
              style={{
                background: showFull ? "rgba(167,139,250,0.18)" : "rgba(167,139,250,0.08)",
                border:     `1px solid rgba(167,139,250,${showFull ? 0.5 : 0.2})`,
                color:      "#a78bfa",
                cursor:     "pointer",
              }}
            >
              {showFull ? "● Full Path" : "Show Full Path"}
            </button>

            {/* Speed selector */}
            <div className="flex items-center gap-1 ml-auto">
              <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, marginRight: 4 }}>Speed</span>
              {SPEED_OPTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className="rounded px-2 py-1 text-xs transition-colors"
                  style={{
                    background: speed === s ? "rgba(0,180,255,0.2)"   : "rgba(255,255,255,0.05)",
                    border:     speed === s ? "1px solid rgba(0,180,255,0.5)" : "1px solid rgba(255,255,255,0.08)",
                    color:      speed === s ? "#00b4ff" : "rgba(255,255,255,0.4)",
                    cursor:     "pointer",
                  }}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>

          {/* Trail fade + video opacity row */}
          <div
            className="flex items-center gap-4 flex-wrap"
            style={{ borderTop: "1px solid rgba(255,255,255,0.04)", paddingTop: 8 }}
          >
            {/* Trail fade */}
            <div className="flex items-center gap-1">
              <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, marginRight: 4 }}>Trail</span>
              {TRAIL_OPTIONS.map(({ label, ms }) => (
                <button
                  key={label}
                  onClick={() => setTrailFadeMs(ms)}
                  className="rounded px-2 py-1 text-xs"
                  style={{
                    background: trailFadeMs === ms ? "rgba(167,139,250,0.2)"  : "rgba(255,255,255,0.05)",
                    border:     trailFadeMs === ms ? "1px solid rgba(167,139,250,0.5)" : "1px solid rgba(255,255,255,0.08)",
                    color:      trailFadeMs === ms ? "#a78bfa" : "rgba(255,255,255,0.4)",
                    cursor:     "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Viewport size — selects the monitor resolution so the FOV rect scales correctly */}
            <div className="flex items-center gap-1">
              <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, marginRight: 4 }}>FOV</span>
              {VIEWPORT_PRESETS.map(({ label, w }) => (
                <button
                  key={label}
                  onClick={() => setViewportW(w)}
                  className="rounded px-2 py-1 text-xs"
                  style={{
                    background: viewportW === w ? "rgba(0,210,255,0.18)" : "rgba(255,255,255,0.05)",
                    border:     viewportW === w ? "1px solid rgba(0,210,255,0.5)" : "1px solid rgba(255,255,255,0.08)",
                    color:      viewportW === w ? "#00d2ff" : "rgba(255,255,255,0.4)",
                    cursor:     "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Video opacity — only shown when game recording is available */}
            {hasVideo && (
              <div className="flex items-center gap-1 ml-auto">
                <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, marginRight: 4 }}>Video</span>
                {BG_OPACITY_OPTIONS.map(({ label, v }) => (
                  <button
                    key={label}
                    onClick={() => setBgOpacity(v)}
                    className="rounded px-2 py-1 text-xs"
                    style={{
                      background: bgOpacity === v ? "rgba(0,245,160,0.15)" : "rgba(255,255,255,0.05)",
                      border:     bgOpacity === v ? "1px solid rgba(0,245,160,0.4)" : "1px solid rgba(255,255,255,0.08)",
                      color:      bgOpacity === v ? "#00f5a0" : "rgba(255,255,255,0.4)",
                      cursor:     "pointer",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Overshoot summary (only if any detected) */}
      {overshoots.length > 0 && (
        <div
          className="rounded-xl px-4 py-3"
          style={{
            background: "rgba(255,80,30,0.06)",
            border:     "1px solid rgba(255,80,30,0.2)",
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span style={{ color: "#ff6b6b", fontSize: 13, fontWeight: 600 }}>
              ▲ {overshoots.length} Overshoot{overshoots.length !== 1 ? "s" : ""} Detected
            </span>
          </div>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 12, lineHeight: 1.5 }}>
            Orange triangles indicate where your cursor reversed direction sharply after a fast
            movement — a sign the flick carried past the intended target.
          </p>
        </div>
      )}

      {/* Sensitivity training suggestion */}
      {suggestion && (
        <div
          className="rounded-xl px-4 py-4"
          style={{
            background: `${suggestion.color}0d`,
            border:     `1px solid ${suggestion.color}40`,
          }}
        >
          <div className="flex items-start justify-between gap-3 mb-2">
            <span style={{ color: suggestion.color, fontSize: 13, fontWeight: 700 }}>
              🎯 Sensitivity Training Suggestion
            </span>
            <span
              className="rounded-full px-3 py-0.5 text-xs font-bold"
              style={{
                background: `${suggestion.color}25`,
                border:     `1px solid ${suggestion.color}60`,
                color:      suggestion.color,
                whiteSpace: "nowrap",
              }}
            >
              {suggestion.badge}
            </span>
          </div>
          <p
            className="text-xs font-semibold mb-1"
            style={{ color: suggestion.color }}
          >
            {suggestion.headline}
          </p>
          <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 12, lineHeight: 1.6 }}>
            {suggestion.detail}
          </p>
          <p
            className="mt-2 text-xs italic"
            style={{ color: "rgba(255,255,255,0.3)" }}
          >
            This is a temporary training sensitivity — not a permanent setting. Switch back after 5–10 runs.
          </p>
        </div>
      )}
    </div>
  );
}
