import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RegionRect, StatsFieldRegions } from "../types/settings";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AutoSetupProgressPayload {
  confirmed: string[];
  /** Unconfirmed fields that have a current candidate rect (physical screen px). */
  candidates: Record<string, RegionRect>;
  total: number;
}

interface AutoSetupCompletePayload {
  regions: StatsFieldRegions;
  scenario_region: RegionRect | null;
  confirmed_count: number;
}

interface OverlayOrigin {
  x: number;
  y: number;
  scale_factor: number;
}

const FIELD_DEFS = [
  { key: "kills",    label: "Kill Count", color: "#f87171", required: true  },
  { key: "kps",      label: "KPS",        color: "#fb923c", required: true  },
  { key: "accuracy", label: "Accuracy",   color: "#fbbf24", required: true  },
  { key: "damage",   label: "Damage",     color: "#a78bfa", required: true  },
  { key: "ttk",      label: "Avg TTK",    color: "#34d399", required: true  },
  { key: "spm",      label: "SPM",        color: "#60a5fa", required: true  },
  { key: "scenario", label: "Scenario",   color: "#e879f9", required: false },
] as const;

type FieldKey = typeof FIELD_DEFS[number]["key"];

// Extra padding (CSS px) around interactive elements for passthrough proximity
const HOVER_PADDING = 20;

interface Props {
  onComplete: (regions: StatsFieldRegions) => void;
  onCancel: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mono: CSSProperties = { fontFamily: "'JetBrains Mono', 'Consolas', monospace" };

function actionBtn(
  color: string,
  title: string,
  onClick: () => void,
  label: string,
) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        ...mono,
        background: color,
        border: "none",
        borderRadius: 3,
        color: color === "#fbbf24" ? "#000" : "#fff",
        cursor: "pointer",
        fontSize: 10,
        fontWeight: 800,
        lineHeight: 1,
        padding: "3px 6px",
        outline: "none",
        flexShrink: 0,
        boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
      }}
    >
      {label}
    </button>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AutoSetupHUD({ onComplete, onCancel }: Props) {
  const [confirmed, setConfirmed] = useState<Set<FieldKey>>(new Set());
  const [candidates, setCandidates] = useState<Record<string, RegionRect>>({});
  const [done, setDone] = useState(false);
  // Total required fields for completion (from Rust; excludes optional fields).
  const [requiredTotal, setRequiredTotal] = useState(FIELD_DEFS.filter(f => f.required).length);

  // Overlay window origin — loaded once, kept in both state (triggers box
  // re-layout) and ref (read synchronously in the proximity interval).
  const [origin, setOrigin] = useState<OverlayOrigin>({ x: 0, y: 0, scale_factor: 1 });
  const originRef = useRef<OverlayOrigin>(origin);

  useEffect(() => {
    invoke<OverlayOrigin>("get_overlay_origin").then(o => {
      originRef.current = o;
      setOrigin(o);
    }).catch(console.error);
  }, []);

  // ── Start Rust polling loop ───────────────────────────────────────────────
  useEffect(() => {
    invoke("start_auto_setup").catch(console.error);

    const progressUnsub = listen<AutoSetupProgressPayload>("auto-setup-progress", (e) => {
      setConfirmed(new Set(e.payload.confirmed as FieldKey[]));
      setCandidates(e.payload.candidates ?? {});
      setRequiredTotal(e.payload.total);
    });

    const completeUnsub = listen<AutoSetupCompletePayload>("auto-setup-complete", async (e) => {
      setConfirmed(new Set(FIELD_DEFS.map(f => f.key)));
      setCandidates({});
      setDone(true);

      try {
        const settings = await invoke<{ stats_field_regions: StatsFieldRegions | null; scenario_region: RegionRect | null } & Record<string, unknown>>("get_settings");
        await invoke("save_settings", {
          newSettings: {
            ...settings,
            stats_field_regions: e.payload.regions,
            ...(e.payload.scenario_region ? { scenario_region: e.payload.scenario_region } : {}),
          },
        });
      } catch (err) {
        console.error("[AutoSetupHUD] save error:", err);
      }

      setTimeout(() => onComplete(e.payload.regions), 1500);
    });

    return () => {
      invoke("stop_auto_setup").catch(console.error);
      progressUnsub.then(fn => fn());
      completeUnsub.then(fn => fn());
    };
  }, [onComplete]);

  // ── Escape to cancel ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  // ── Cursor proximity — disable passthrough near ANY interactive element ──
  // Elements mark themselves with data-auto-interactive so we can query them all.
  useEffect(() => {
    let isPassthrough = true;
    const id = setInterval(async () => {
      const cursor = await invoke<{ x: number; y: number }>("get_cursor_pos");
      const o = originRef.current;
      const cx = (cursor.x - o.x) / o.scale_factor;
      const cy = (cursor.y - o.y) / o.scale_factor;

      const elems = document.querySelectorAll("[data-auto-interactive]");
      let near = false;
      for (const el of elems) {
        const r = el.getBoundingClientRect();
        if (cx >= r.left - HOVER_PADDING && cx <= r.right  + HOVER_PADDING &&
            cy >= r.top  - HOVER_PADDING && cy <= r.bottom + HOVER_PADDING) {
          near = true;
          break;
        }
      }
      if (near && isPassthrough) {
        isPassthrough = false;
        invoke("set_mouse_passthrough", { enabled: false }).catch(console.error);
      } else if (!near && !isPassthrough) {
        isPassthrough = true;
        invoke("set_mouse_passthrough", { enabled: true }).catch(console.error);
      }
    }, 80);

    return () => {
      clearInterval(id);
      invoke("set_mouse_passthrough", { enabled: true }).catch(console.error);
    };
  }, []);

  // ── Convert physical RegionRect → CSS position (px) ─────────────────────
  function toCSS(rect: RegionRect) {
    const { x, y, scale_factor } = origin;
    return {
      left:   (rect.x - x) / scale_factor,
      top:    (rect.y - y) / scale_factor,
      width:  rect.width  / scale_factor,
      height: rect.height / scale_factor,
    };
  }

  const requiredConfirmed = FIELD_DEFS.filter(f => f.required && confirmed.has(f.key)).length;
  const progress = requiredTotal > 0 ? requiredConfirmed / requiredTotal : 0;

  return (
    // Full-screen transparent layer — pointer-events: none by default so
    // KovaaK's receives all input.  Interactive children opt back in.
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, pointerEvents: "none", ...mono }}>

      {/* ── Candidate bounding-box overlays ─────────────────────────────── */}
      {Object.entries(candidates).map(([field, rect]) => {
        const def = FIELD_DEFS.find(d => d.key === field);
        if (!def) return null;
        const css = toCSS(rect);
        return (
          <div
            key={field}
            style={{
              position: "fixed",
              left:   css.left,
              top:    css.top,
              width:  css.width,
              height: css.height,
              border: `2px solid ${def.color}`,
              borderRadius: 3,
              pointerEvents: "none",
              boxSizing: "border-box",
              boxShadow: `0 0 0 1px rgba(0,0,0,0.55), 0 0 10px ${def.color}55`,
            }}
          >
            {/* Label + confirm/reject toolbar — floats above the box, interactive only here */}
            <div
              data-auto-interactive
              style={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                marginBottom: 4,
                display: "flex",
                alignItems: "center",
                gap: 4,
                pointerEvents: "auto",
                whiteSpace: "nowrap",
              }}
            >
              {/* Field name pill */}
              <span style={{
                background: def.color,
                color: def.color === "#fbbf24" ? "#000" : "#fff",
                fontSize: 9,
                fontWeight: 700,
                padding: "2px 6px",
                borderRadius: 3,
                letterSpacing: "0.02em",
                boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
              }}>
                {def.label}
              </span>

              {/* ✓ Confirm */}
              {actionBtn(
                "#16a34a", "Confirm — this region looks correct",
                () => invoke("force_confirm_field", { field }).catch(console.error),
                "✓ confirm",
              )}

              {/* ✗ Reject */}
              {actionBtn(
                "#dc2626", "Reject — try to detect again",
                () => invoke("force_reject_field", { field }).catch(console.error),
                "✗ retry",
              )}
            </div>
          </div>
        );
      })}

      {/* ── Status panel (bottom-right corner) ──────────────────────────── */}
      <div style={{ position: "fixed", bottom: 28, right: 28 }}>
        <div
          data-auto-interactive
          style={{
            pointerEvents: "auto",
            background: done ? "rgba(6,12,10,0.94)" : "rgba(8,8,14,0.92)",
            border: `1px solid ${done ? "rgba(52,211,153,0.35)" : "rgba(255,255,255,0.09)"}`,
            borderRadius: 14,
            padding: "14px 18px",
            minWidth: 220,
            boxShadow: "0 8px 40px rgba(0,0,0,0.65)",
            transition: "border-color 0.4s",
          }}
        >
          {done ? (
            // ── All confirmed ──────────────────────────────────────────────
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 18, color: "#34d399", lineHeight: 1 }}>✓</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#34d399" }}>All set up!</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>
                  {requiredConfirmed}/{requiredTotal} required regions confirmed
                  {confirmed.has("scenario" as FieldKey) && " + scenario"}
                </div>
              </div>
            </div>
          ) : (
            // ── Detecting ─────────────────────────────────────────────────
            <>
              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <span style={{
                  width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                  background: "#fbbf24",
                  boxShadow: "0 0 6px #fbbf24",
                  animation: "pulse 1.8s ease-in-out infinite",
                }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: "#fff" }}>Auto setup running</span>
              </div>

              {/* Per-field status list */}
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 11 }}>
                {FIELD_DEFS.map(def => {
                  const isConfirmed = confirmed.has(def.key);
                  const hasCandidate = !isConfirmed && def.key in candidates;
                  return (
                    <div key={def.key} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      {/* Status dot */}
                      <div style={{
                        width: 14, height: 14, borderRadius: "50%", flexShrink: 0,
                        border: isConfirmed || hasCandidate ? "none" : "2px solid rgba(255,255,255,0.14)",
                        background: isConfirmed
                          ? def.color
                          : hasCandidate
                            ? `${def.color}55`
                            : "transparent",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 8, color: "#000", fontWeight: 900,
                        transition: "all 0.3s",
                        boxShadow: hasCandidate ? `0 0 5px ${def.color}88` : "none",
                      }}>
                        {isConfirmed ? "✓" : ""}
                      </div>

                      {/* Field name */}
                      <span style={{
                        fontSize: 11,
                        color: isConfirmed
                          ? def.color
                          : hasCandidate
                            ? "rgba(255,255,255,0.7)"
                            : "rgba(255,255,255,0.28)",
                        transition: "color 0.3s",
                        flex: 1,
                      }}>
                        {def.label}
                      </span>

                      {/* State badge */}
                      <span style={{
                        fontSize: 8,
                        color: isConfirmed
                          ? def.color
                          : hasCandidate
                            ? "#fbbf24"
                            : "rgba(255,255,255,0.18)",
                        letterSpacing: "0.04em",
                      }}>
                        {isConfirmed ? "OK" : hasCandidate ? "?" : def.required ? "…" : "optional"}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Progress bar */}
              <div style={{
                height: 2, background: "rgba(255,255,255,0.07)",
                borderRadius: 1, marginBottom: 11,
              }}>
                <div style={{
                  height: "100%", borderRadius: 1,
                  background: "linear-gradient(90deg, #fbbf24, #34d399)",
                  width: `${progress * 100}%`,
                  transition: "width 0.5s ease",
                }} />
              </div>

              {/* Hint + cancel */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", lineHeight: 1.4 }}>
                  Boxes appear when regions are detected
                </span>
                <button
                  onClick={onCancel}
                  style={{
                    ...mono,
                    background: "none",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 5, cursor: "pointer",
                    fontSize: 9, color: "rgba(255,255,255,0.3)",
                    padding: "3px 8px", outline: "none",
                    transition: "color 0.15s, border-color 0.15s",
                    flexShrink: 0,
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.65)";
                    (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(255,255,255,0.28)";
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.3)";
                    (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(255,255,255,0.1)";
                  }}
                >
                  stop
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
