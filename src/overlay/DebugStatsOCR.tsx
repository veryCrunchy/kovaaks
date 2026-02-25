import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { StatsPanelReading } from "../types/overlay";

const DEBOUNCE_MS = 350;
const PARSED_EVENT = "stats-panel-update";
const RAW_EVENT = "stats-ocr-raw";

function fmtField(v: number | null | undefined): string {
  if (v == null) return "--";
  return String(v);
}

/**
 * Debug overlay panel showing the raw stats-panel OCR output alongside the
 * parsed field values. Displayed only in dev mode (controlled by App.tsx).
 * Updates are debounced so the panel doesn't flicker on every OCR tick.
 */
export function DebugStatsOCR() {
  const [reading, setReading] = useState<StatsPanelReading | null>(null);
  const [rawText, setRawText] = useState<string>("");
  const [lastMs, setLastMs] = useState<number | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<StatsPanelReading | null>(null);

  // Subscribe to parsed readings
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<StatsPanelReading>(PARSED_EVENT, (event) => {
      pendingRef.current = event.payload;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        if (pendingRef.current) {
          setReading(pendingRef.current);
          setLastMs(Date.now());
        }
      }, DEBOUNCE_MS);
    }).then((fn) => { unlisten = fn; });
    return () => {
      unlisten?.();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // Subscribe to raw OCR text (no debounce — we want to see every frame)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>(RAW_EVENT, (event) => {
      setRawText(event.payload);
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  const secondsAgo = lastMs != null ? Math.floor((Date.now() - lastMs) / 1000) : null;

  const fields: [string, string][] = reading
    ? [
        ["scenario", reading.scenario_type],
        ["kills", fmtField(reading.kills)],
        ["kps", fmtField(reading.kps)],
        ["acc_hits", fmtField(reading.accuracy_hits)],
        ["acc_shots", fmtField(reading.accuracy_shots)],
        ["acc_pct", reading.accuracy_pct != null ? `${reading.accuracy_pct.toFixed(1)}%` : "--"],
        ["dmg_dealt", fmtField(reading.damage_dealt)],
        ["dmg_total", fmtField(reading.damage_total)],
        ["spm", fmtField(reading.spm)],
        ["ttk", reading.ttk_secs != null ? `${(reading.ttk_secs * 1000).toFixed(0)}ms` : "--"],
      ]
    : [];

  return (
    <div
      style={{
        background: "rgba(4, 4, 10, 0.92)",
        border: "1px solid rgba(255, 200, 50, 0.25)",
        borderTop: "2px solid rgba(255,200,50,0.6)",
        borderRadius: 6,
        padding: "7px 10px",
        fontFamily: "'JetBrains Mono', monospace",
        minWidth: 220,
        maxWidth: 320,
        backdropFilter: "blur(8px)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 5,
          paddingBottom: 5,
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <span style={{ fontSize: 9, color: "rgba(255,200,50,0.8)", fontWeight: 700, letterSpacing: "0.1em" }}>
          OCR DEBUG
        </span>
        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>
          parsed {secondsAgo != null ? `${secondsAgo}s ago` : "—"}
        </span>
      </div>

      {/* Parsed fields */}
      {fields.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 6 }}>
          {fields.map(([key, val]) => (
            <div key={key} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", letterSpacing: "0.06em" }}>
                {key}
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: val === "--" ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.85)",
                  fontWeight: 600,
                }}
              >
                {val}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Raw OCR text */}
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 5 }}>
        <div style={{ fontSize: 9, color: "rgba(255,200,50,0.5)", marginBottom: 3, letterSpacing: "0.06em" }}>
          RAW OCR
        </div>
        <pre
          style={{
            fontSize: 8,
            color: rawText ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.15)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            margin: 0,
            maxHeight: 120,
            overflowY: "auto",
            lineHeight: 1.5,
          }}
        >
          {rawText || "waiting…"}
        </pre>
      </div>
    </div>
  );
}
