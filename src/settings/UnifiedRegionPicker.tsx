import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings, RegionRect, StatsFieldRegions } from "../types/settings";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface OverlayOrigin {
  x: number;
  y: number;
  scale_factor: number;
}

type StandaloneKey = "scenario_region";
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
  onStartAutoSetup?: () => void;
}

interface AutoSetupProgressPayload {
  confirmed: string[];
  total: number;
}

interface AutoSetupCompletePayload {
  regions: StatsFieldRegions;
  scenario_region: RegionRect | null;
  confirmed_count: number;
}

// ─── Region definitions ────────────────────────────────────────────────────────

const STANDALONE_DEFS: StandaloneDef[] = [
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
  {
    kind: "field",
    key: "spm",
    label: "SPM",
    description: "Drag over the score-per-minute value (e.g. '12,345')",
    color: "#60a5fa",
    colorBg: "rgba(96,165,250,0.07)",
  },
];

const ALL_DEFS: RegionDef[] = [...STANDALONE_DEFS, ...FIELD_DEFS];

function defByKey(key: AnyKey): RegionDef {
  return ALL_DEFS.find(d => d.key === key)!;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function UnifiedRegionPicker({ onComplete, onStartAutoSetup }: Props) {
  const [origin, setOrigin] = useState<OverlayOrigin>({
    x: 0,
    y: 0,
    scale_factor: window.devicePixelRatio ?? 1,
  });
  const [savedStandalone, setSavedStandalone] = useState<Partial<Record<StandaloneKey, RegionRect>>>({});
  const [savedFields, setSavedFields] = useState<StatsFieldRegions>({
    kills: null, kps: null, accuracy: null, damage: null, ttk: null, spm: null,
  });
  const [activeKey, setActiveKey] = useState<AnyKey | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [justSaved, setJustSaved] = useState<AnyKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Auto-setup: background polling mode shown when no fields are configured yet
  const [autoSetupMode, setAutoSetupMode] = useState(false);
  const [confirmedSetupFields, setConfirmedSetupFields] = useState<Set<FieldKey>>(new Set());
  const [autoSetupDone, setAutoSetupDone] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load origin + current settings on mount
  useEffect(() => {
    invoke<OverlayOrigin>("get_overlay_origin")
      .then(setOrigin)
      .catch(console.error);

    invoke<AppSettings>("get_settings")
      .then(s => {
        const standalone: Partial<Record<StandaloneKey, RegionRect>> = {};
        if (s.scenario_region) standalone.scenario_region = s.scenario_region;
        setSavedStandalone(standalone);
        const sfr = s.stats_field_regions;
        const allNull = !sfr || (!sfr.kills && !sfr.kps && !sfr.accuracy && !sfr.damage && !sfr.ttk && !sfr.spm);
        if (!allNull) {
          setSavedFields({
            kills: sfr.kills ?? null,
            kps: sfr.kps ?? null,
            accuracy: sfr.accuracy ?? null,
            damage: sfr.damage ?? null,
            ttk: sfr.ttk ?? null,
            spm: sfr.spm ?? null,
          });
        }
        setAutoSetupMode(allNull);
      })
      .catch(console.error);
  }, []);

  // ── Auto-setup background polling ────────────────────────────────────────

  useEffect(() => {
    if (!autoSetupMode) {
      invoke("stop_auto_setup").catch(console.error);
      return;
    }

    invoke("start_auto_setup").catch(console.error);

    const progressUnsub = listen<AutoSetupProgressPayload>("auto-setup-progress", e => {
      setConfirmedSetupFields(new Set(e.payload.confirmed as FieldKey[]));
    });
    const completeUnsub = listen<AutoSetupCompletePayload>("auto-setup-complete", e => {
      const { regions } = e.payload;
      setSavedFields({
        kills: regions.kills ?? null,
        kps: regions.kps ?? null,
        accuracy: regions.accuracy ?? null,
        damage: regions.damage ?? null,
        ttk: regions.ttk ?? null,
        spm: regions.spm ?? null,
      });
      invoke("set_stats_field_regions", { regions }).catch(console.error);
      if (e.payload.scenario_region) {
        setSavedStandalone(prev => ({ ...prev, scenario_region: e.payload.scenario_region! }));
        invoke("set_scenario_region", { region: e.payload.scenario_region }).catch(console.error);
      }
      setConfirmedSetupFields(new Set(["kills", "kps", "accuracy", "damage", "ttk", "spm"] as FieldKey[]));
      setAutoSetupDone(true);
      setTimeout(() => onComplete(), 3000);
    });

    return () => {
      progressUnsub.then(fn => fn());
      completeUnsub.then(fn => fn());
      invoke("stop_auto_setup").catch(console.error);
    };
  }, [autoSetupMode, onComplete]);

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
    if (key === "scenario_region") return savedStandalone[key] ?? null;
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

  const enterAutoSetup = useCallback(() => {
    setConfirmedSetupFields(new Set());
    setAutoSetupDone(false);
    setError(null);
    setAutoSetupMode(true);
  }, []);

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

      {/* Auto-setup panel — shown when no stats regions are configured yet */}
      {autoSetupMode && (
        <div
          style={{
            position: "absolute", top: "50%", left: "50%",
            transform: "translate(-50%, -50%)",
            background: "rgba(8,8,14,0.97)",
            border: `1px solid ${autoSetupDone ? "rgba(52,211,153,0.3)" : "rgba(255,255,255,0.07)"}`,
            borderRadius: 18, padding: "28px 32px", minWidth: 330,
            fontFamily: "'JetBrains Mono', monospace",
            pointerEvents: "auto", zIndex: 10,
            boxShadow: "0 8px 48px rgba(0,0,0,0.7)",
            transition: "border-color 0.5s",
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          {autoSetupDone ? (
            // ── Success state ──
            <>
              <div style={{ textAlign: "center", marginBottom: 6 }}>
                <div style={{ fontSize: 36, lineHeight: 1.2, color: "#34d399", marginBottom: 10 }}>✓</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#34d399", marginBottom: 6 }}>All set up!</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", lineHeight: 1.7, marginBottom: 22 }}>
                  {confirmedSetupFields.size}/5 regions detected automatically.<br />
                  Closing in a moment…
                </div>
              </div>
              <button
                onClick={onComplete}
                style={{
                  background: "rgba(52,211,153,0.12)", border: "1px solid rgba(52,211,153,0.3)",
                  borderRadius: 8, color: "#34d399", cursor: "pointer",
                  fontSize: 11, fontWeight: 700, padding: "7px 0", width: "100%",
                  fontFamily: "inherit", outline: "none",
                }}
              >
                Close now
              </button>
            </>
          ) : (
            // ── Detecting state ──
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <span style={{
                  display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                  background: "#fbbf24",
                  boxShadow: "0 0 8px #fbbf24",
                  animation: "pulse 1.8s ease-in-out infinite",
                  flexShrink: 0,
                }} />
                <span style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>Setting up automatically</span>
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", lineHeight: 1.7, marginBottom: 22 }}>
                Open KovaaK's and start a scenario.<br />
                Regions will lock in as they appear on screen.
              </div>

              {/* Field confirmation list */}
              <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 20 }}>
                {FIELD_DEFS.map(def => {
                  const done = confirmedSetupFields.has(def.key);
                  return (
                    <div key={def.key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{
                        width: 18, height: 18, borderRadius: "50%", flexShrink: 0,
                        border: done ? "none" : "2px solid rgba(255,255,255,0.15)",
                        background: done ? def.color : "transparent",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 10, color: "#000", fontWeight: 800,
                        transition: "all 0.35s",
                      }}>
                        {done ? "✓" : ""}
                      </div>
                      <span style={{
                        fontSize: 12,
                        color: done ? def.color : "rgba(255,255,255,0.38)",
                        transition: "color 0.35s",
                      }}>
                        {def.label}
                      </span>
                      {!done && (
                        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.18)", marginLeft: "auto" }}>
                          waiting…
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Progress bar */}
              <div style={{ height: 3, background: "rgba(255,255,255,0.07)", borderRadius: 2, marginBottom: 20 }}>
                <div style={{
                  height: "100%", borderRadius: 2,
                  background: "linear-gradient(90deg, #fbbf24, #34d399)",
                  width: `${(confirmedSetupFields.size / 5) * 100}%`,
                  transition: "width 0.5s ease",
                }} />
              </div>

              <button
                onClick={() => {
                  invoke("stop_auto_setup").catch(console.error);
                  setAutoSetupMode(false);
                }}
                style={{
                  background: "none", border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8, color: "rgba(255,255,255,0.3)",
                  cursor: "pointer", fontSize: 10, padding: "6px 0", width: "100%",
                  fontFamily: "inherit", outline: "none",
                  transition: "color 0.15s, border-color 0.15s",
                }}
                onMouseEnter={e => {
                  (e.target as HTMLButtonElement).style.color = "rgba(255,255,255,0.6)";
                  (e.target as HTMLButtonElement).style.borderColor = "rgba(255,255,255,0.25)";
                }}
                onMouseLeave={e => {
                  (e.target as HTMLButtonElement).style.color = "rgba(255,255,255,0.3)";
                  (e.target as HTMLButtonElement).style.borderColor = "rgba(255,255,255,0.1)";
                }}
              >
                Set up manually instead
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Bottom toolbar ──────────────────────────────────────────────────── */}
      {!autoSetupMode && (
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

        {/* Auto Setup */}
        <button
          onClick={() => onStartAutoSetup ? onStartAutoSetup() : enterAutoSetup()}
          style={{
            background: "rgba(251,191,36,0.07)",
            border: "1px solid rgba(251,191,36,0.28)",
            borderRadius: 7, cursor: "pointer",
            fontSize: 11, padding: "5px 13px",
            fontFamily: "inherit", outline: "none", transition: "all 0.15s",
            display: "flex", alignItems: "center", gap: 5,
            color: "rgba(251,191,36,0.85)",
          }}
        >
          Auto Setup
        </button>

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
      )}
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
