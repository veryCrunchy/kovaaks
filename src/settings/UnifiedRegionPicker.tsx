import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, RegionRect, StatsFieldRegions } from "../types/stats";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface OverlayOrigin {
  x: number;
  y: number;
  scale_factor: number;
}

type StandaloneKey = "region" | "scenario_region";
type FieldKey = keyof StatsFieldRegions;
type AnyKey = StandaloneKey | FieldKey;

interface StandaloneDef {
  kind: "standalone";
  key: StandaloneKey;
  label: string;
  description: string;
  command: string;
  color: string;
  colorBg: string;
}

interface FieldDef {
  kind: "field";
  key: FieldKey;
  label: string;
  description: string;
  color: string;
  colorBg: string;
}

type RegionDef = StandaloneDef | FieldDef;

interface DragState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface Props {
  onComplete: () => void;
}

// ─── Region definitions ────────────────────────────────────────────────────────

const STANDALONE_DEFS: StandaloneDef[] = [
  {
    kind: "standalone",
    key: "region",
    label: "Live Score",
    description: "Drag over the SPM / score counter in the KovaaK's HUD",
    command: "set_region",
    color: "#00f5a0",
    colorBg: "rgba(0,245,160,0.07)",
  },
  {
    kind: "standalone",
    key: "scenario_region",
    label: "Scenario Name",
    description: "Drag over the scenario name text shown at the start of each run",
    command: "set_scenario_region",
    color: "#00b4ff",
    colorBg: "rgba(0,180,255,0.07)",
  },
];

const FIELD_DEFS: FieldDef[] = [
  {
    kind: "field",
    key: "kills",
    label: "Kill Count",
    description: "Drag tightly over just the kill count value (e.g. '127')",
    color: "#f87171",
    colorBg: "rgba(248,113,113,0.07)",
  },
  {
    kind: "field",
    key: "kps",
    label: "KPS",
    description: "Drag over the kills-per-second value (e.g. '2.3')",
    color: "#fb923c",
    colorBg: "rgba(251,146,60,0.07)",
  },
  {
    kind: "field",
    key: "accuracy",
    label: "Accuracy",
    description: "Drag over the accuracy fraction + % (e.g. '2,833/5,658 (50.1%)')",
    color: "#fbbf24",
    colorBg: "rgba(251,191,36,0.07)",
  },
  {
    kind: "field",
    key: "damage",
    label: "Damage",
    description: "Drag over the damage dealt value only (e.g. '8,836')",
    color: "#a78bfa",
    colorBg: "rgba(167,139,250,0.07)",
  },
  {
    kind: "field",
    key: "ttk",
    label: "Avg TTK",
    description: "Drag over the avg TTK value (e.g. '0.243s' or '--')",
    color: "#34d399",
    colorBg: "rgba(52,211,153,0.07)",
  },
];

const ALL_DEFS: RegionDef[] = [...STANDALONE_DEFS, ...FIELD_DEFS];

function defByKey(key: AnyKey): RegionDef {
  return ALL_DEFS.find(d => d.key === key)!;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function UnifiedRegionPicker({ onComplete }: Props) {
  const [origin, setOrigin] = useState<OverlayOrigin>({
    x: 0,
    y: 0,
    scale_factor: window.devicePixelRatio ?? 1,
  });
  const [savedStandalone, setSavedStandalone] = useState<Partial<Record<StandaloneKey, RegionRect>>>({});
  const [savedFields, setSavedFields] = useState<StatsFieldRegions>({
    kills: null, kps: null, accuracy: null, damage: null, ttk: null,
  });
  const [activeKey, setActiveKey] = useState<AnyKey | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [justSaved, setJustSaved] = useState<AnyKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load origin + current settings on mount
  useEffect(() => {
    invoke<OverlayOrigin>("get_overlay_origin")
      .then(setOrigin)
      .catch(console.error);

    invoke<AppSettings>("get_settings")
      .then(s => {
        const standalone: Partial<Record<StandaloneKey, RegionRect>> = {};
        if (s.region) standalone.region = s.region;
        if (s.scenario_region) standalone.scenario_region = s.scenario_region;
        setSavedStandalone(standalone);
        if (s.stats_field_regions) {
          setSavedFields({
            kills: s.stats_field_regions.kills ?? null,
            kps: s.stats_field_regions.kps ?? null,
            accuracy: s.stats_field_regions.accuracy ?? null,
            damage: s.stats_field_regions.damage ?? null,
            ttk: s.stats_field_regions.ttk ?? null,
          });
        }
      })
      .catch(console.error);
  }, []);

  // ESC: de-select active region (or close if none)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (activeKey) {
          setActiveKey(null);
          setDrag(null);
          setIsDragging(false);
        } else {
          onComplete();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeKey, onComplete]);

  const activeDef = activeKey ? defByKey(activeKey) : null;

  function getSaved(key: AnyKey): RegionRect | null {
    if (key === "region" || key === "scenario_region") return savedStandalone[key] ?? null;
    return savedFields[key as FieldKey] ?? null;
  }

  // ── Drag handlers ───────────────────────────────────────────────────────────

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (!activeKey || e.button !== 0) return;
    e.preventDefault();
    setDrag({ startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY });
    setIsDragging(true);
    setError(null);
  }, [activeKey]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    setDrag(prev => prev && { ...prev, currentX: e.clientX, currentY: e.clientY });
  }, [isDragging]);

  const onMouseUp = useCallback(async (e: React.MouseEvent) => {
    if (!isDragging || !drag || !activeKey || !activeDef) return;

    const cssX = Math.min(drag.startX, e.clientX);
    const cssY = Math.min(drag.startY, e.clientY);
    const cssW = Math.abs(e.clientX - drag.startX);
    const cssH = Math.abs(e.clientY - drag.startY);

    setIsDragging(false);
    setDrag(null);

    // Ignore tiny accidental drags
    if (cssW < 8 || cssH < 8) return;

    const rect: RegionRect = {
      x: Math.round(cssX * origin.scale_factor) + origin.x,
      y: Math.round(cssY * origin.scale_factor) + origin.y,
      width: Math.round(cssW * origin.scale_factor),
      height: Math.round(cssH * origin.scale_factor),
    };

    try {
      if (activeDef.kind === "standalone") {
        await invoke(activeDef.command, { region: rect });
        setSavedStandalone(prev => ({ ...prev, [activeKey]: rect }));
      } else {
        const updated: StatsFieldRegions = { ...savedFields, [activeKey]: rect };
        await invoke("set_stats_field_regions", { regions: updated });
        setSavedFields(updated);
      }
      setJustSaved(activeKey);
      setActiveKey(null);
      setTimeout(() => setJustSaved(null), 2000);
    } catch (err) {
      setError(String(err));
    }
  }, [isDragging, drag, activeKey, activeDef, origin, savedFields]);

  // ── helpers ─────────────────────────────────────────────────────────────────

  // Convert a physical-pixel RegionRect back to CSS pixel coordinates for display
  const toCssRect = (rect: RegionRect) => ({
    left: (rect.x - origin.x) / origin.scale_factor,
    top: (rect.y - origin.y) / origin.scale_factor,
    width: rect.width / origin.scale_factor,
    height: rect.height / origin.scale_factor,
  });

  // Current drag selection box in CSS space
  const selBox = drag
    ? {
        left: Math.min(drag.startX, drag.currentX),
        top: Math.min(drag.startY, drag.currentY),
        width: Math.abs(drag.currentX - drag.startX),
        height: Math.abs(drag.currentY - drag.startY),
      }
    : null;
  const hasSelBox = selBox && selBox.width > 4 && selBox.height > 4;

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className="fixed inset-0"
      style={{
        cursor: activeKey ? "crosshair" : "default",
        userSelect: "none",
        zIndex: 9999,
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {/* Translucent background dim */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: "rgba(0,0,0,0.28)" }}
      />

      {/* Saved region overlays */}
      {ALL_DEFS.map(def => {
        const rect = getSaved(def.key);
        if (!rect) return null;
        const css = toCssRect(rect);
        const saved = justSaved === def.key;
        return (
          <div
            key={def.key}
            className="absolute pointer-events-none"
            style={{
              left: css.left, top: css.top, width: css.width, height: css.height,
              border: `2px solid ${def.color}`,
              background: def.colorBg,
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                position: "absolute", top: -22, left: 0,
                fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
                color: def.color, background: "rgba(0,0,0,0.82)",
                padding: "2px 7px", borderRadius: 4, whiteSpace: "nowrap", lineHeight: 1.4,
              }}
            >
              {def.label}
              {saved && <span style={{ marginLeft: 5, opacity: 0.9 }}>✓ saved</span>}
              &nbsp;
              <span style={{ opacity: 0.45 }}>{rect.width}×{rect.height}</span>
            </div>
          </div>
        );
      })}

      {/* Live drag box */}
      {hasSelBox && activeDef && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: selBox!.left, top: selBox!.top, width: selBox!.width, height: selBox!.height,
            border: `2px solid ${activeDef.color}`,
            background: activeDef.colorBg,
            boxSizing: "border-box",
          }}
        />
      )}

      {/* Size readout while dragging */}
      {hasSelBox && isDragging && drag && activeDef && (
        <div
          className="pointer-events-none"
          style={{
            position: "absolute",
            left: selBox!.left + selBox!.width / 2,
            top: selBox!.top + selBox!.height + 6,
            transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.75)", borderRadius: 4, padding: "2px 8px",
            fontSize: 10, color: activeDef.color,
            fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap",
          }}
        >
          {Math.abs(drag.currentX - drag.startX)}×{Math.abs(drag.currentY - drag.startY)} px
        </div>
      )}

      {/* Top instruction banner */}
      {activeKey && !isDragging && activeDef && (
        <div
          className="pointer-events-none"
          style={{
            position: "absolute", top: 28, left: "50%", transform: "translateX(-50%)",
            background: "rgba(8,8,14,0.88)", border: `1px solid ${activeDef.color}55`,
            borderRadius: 8, padding: "7px 18px", fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace", color: activeDef.color, whiteSpace: "nowrap",
          }}
        >
          {activeDef.description}
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          className="pointer-events-none"
          style={{
            position: "absolute", bottom: 96, left: "50%", transform: "translateX(-50%)",
            background: "rgba(255,77,77,0.12)", border: "1px solid rgba(255,77,77,0.35)",
            borderRadius: 8, padding: "6px 14px", fontSize: 11, color: "#ff6b6b",
            fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap",
          }}
        >
          {error}
        </div>
      )}

      {/* ── Bottom toolbar ──────────────────────────────────────────────────── */}
      <div
        className="absolute"
        style={{
          bottom: 24, left: "50%", transform: "translateX(-50%)",
          display: "flex", alignItems: "center", gap: 6,
          background: "rgba(8,8,14,0.94)", border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 12, padding: "10px 14px",
          fontFamily: "'JetBrains Mono', monospace",
          backdropFilter: "blur(16px)", boxShadow: "0 4px 32px rgba(0,0,0,0.65)",
          pointerEvents: "auto", zIndex: 10,
        }}
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Status label */}
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginRight: 4, whiteSpace: "nowrap" }}>
          {activeKey
            ? <span style={{ color: activeDef?.color, fontWeight: 600 }}>Drawing: {activeDef?.label}</span>
            : "Configure regions"}
        </div>

        {/* Standalone region buttons */}
        {STANDALONE_DEFS.map(def => <RegionButton key={def.key} def={def} activeKey={activeKey} justSaved={justSaved} saved={getSaved(def.key)} onToggle={k => setActiveKey(prev => prev === k ? null : k as AnyKey)} />)}

        {/* Divider */}
        <div style={{ width: 1, height: 20, background: "rgba(255,255,255,0.1)", margin: "0 2px" }} />

        {/* Per-field stats region buttons */}
        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", marginRight: 2, whiteSpace: "nowrap" }}>stats:</span>
        {FIELD_DEFS.map(def => <RegionButton key={def.key} def={def} activeKey={activeKey} justSaved={justSaved} saved={getSaved(def.key)} onToggle={k => setActiveKey(prev => prev === k ? null : k as AnyKey)} />)}

        {/* Divider */}
        <div style={{ width: 1, height: 20, background: "rgba(255,255,255,0.1)", margin: "0 2px" }} />

        {/* Done */}
        <button
          onClick={onComplete}
          style={{
            background: "rgba(0,245,160,0.12)", border: "1px solid rgba(0,245,160,0.3)",
            borderRadius: 7, color: "#00f5a0", cursor: "pointer",
            fontSize: 11, fontWeight: 700, padding: "5px 14px", fontFamily: "inherit", outline: "none",
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

// ─── RegionButton sub-component ────────────────────────────────────────────────

interface RegionButtonProps {
  def: RegionDef;
  activeKey: AnyKey | null;
  justSaved: AnyKey | null;
  saved: RegionRect | null;
  onToggle: (key: AnyKey) => void;
}

function RegionButton({ def, activeKey, justSaved, saved, onToggle }: RegionButtonProps) {
  const isActive = activeKey === def.key;
  const wasSaved = justSaved === def.key;
  const hasRegion = !!saved;
  return (
    <button
      onClick={() => onToggle(def.key)}
      style={{
        background: isActive ? `${def.color}20` : wasSaved ? `${def.color}14` : "rgba(255,255,255,0.05)",
        border: `1px solid ${isActive ? def.color : wasSaved ? `${def.color}88` : "rgba(255,255,255,0.12)"}`,
        borderRadius: 7, cursor: "pointer", fontSize: 11, padding: "5px 10px",
        fontFamily: "inherit", outline: "none", transition: "all 0.15s",
        display: "flex", alignItems: "center", gap: 5,
        color: isActive ? def.color : hasRegion ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.38)",
      }}
    >
      <span
        style={{
          width: 6, height: 6, borderRadius: "50%", flexShrink: 0, transition: "background 0.2s",
          background: hasRegion ? def.color : "rgba(255,255,255,0.18)",
        }}
      />
      {def.label}
      {saved && (
        <span style={{ fontSize: 9, opacity: 0.4, marginLeft: 2 }}>
          {saved.width}×{saved.height}
        </span>
      )}
    </button>
  );
}
