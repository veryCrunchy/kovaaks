import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ─── Types ────────────────────────────────────────────────────────────────────

type ValueType = "i32" | "u32" | "i64" | "f32" | "f64" | "u8";
type SubTab = "watches" | "scanner" | "ptrscan" | "chain" | "autochain" | "modules" | "ue4ss" | "objdebug" | "methodsrc";

interface WatchEntry {
  id: string;
  label: string;
  type: ValueType;
  // Either raw address OR chain offsets (chain preferred — survives ASLR restarts)
  addrHex?: string;
  chain?: string; // space-separated offsets e.g. "4F5FBF0 0 9C8"
  // runtime only
  currentValue?: string;
  currentAddr?: string;
  readOk?: boolean;
  error?: string;
}

interface ScanHit {
  addr: string;
  value: number;
  module_rel: string | null;
}

interface ChainStep {
  label: string;
  addr: string;
  ptr_value: string;
  ok: boolean;
}

interface ChainResult {
  steps: ChainStep[];
  final_addr: string | null;
  final_value: number | null;
  ok: boolean;
  error: string | null;
}

interface PtrScanHit {
  addr: string;        // address where the pointer lives
  ptr_value: string;   // the pointer value stored there
  offset: number;      // target - ptr_value (offset into the pointed object)
  module_rel: string | null; // module+0x... if static
}

interface StructScanHit {
  offset: string;
  addr: string;
  value: number;
}

interface ModuleEntry {
  name: string;
  base: string;
  size: number;
}

interface RuntimeFlags {
  profile: string;
  enable_pe_hook: boolean;
  disable_pe_hook: boolean;
  discovery: boolean;
  safe_mode: boolean;
  no_rust: boolean;
  log_all_events: boolean;
  object_debug: boolean;
  non_ui_probe: boolean;
  ui_counter_fallback: boolean;
  score_ui_fallback: boolean;
  hook_process_internal: boolean;
  hook_process_local_script: boolean;
  class_probe_hooks: boolean;
  allow_unsafe_hooks: boolean;
  native_hooks: boolean;
  hook_process_event: boolean;
  ui_settext_hook: boolean;
}

type RuntimeFlagKey =
  | "enable_pe_hook"
  | "disable_pe_hook"
  | "discovery"
  | "safe_mode"
  | "no_rust"
  | "log_all_events"
  | "object_debug"
  | "non_ui_probe"
  | "ui_counter_fallback"
  | "score_ui_fallback"
  | "hook_process_internal"
  | "hook_process_local_script"
  | "class_probe_hooks"
  | "allow_unsafe_hooks"
  | "native_hooks"
  | "hook_process_event"
  | "ui_settext_hook";

interface BridgeEventEntry {
  ts: string;
  source: "bridge" | "mod";
  raw: string;
  ev?: string;
}

interface BridgeParsedEvent {
  ev: string;
  value?: number | null;
  total?: number | null;
  delta?: number | null;
  field?: string | null;
  source?: string | null;
  raw: string;
}

type TriBoolFilter = "any" | "on" | "off";

interface MethodFlagSnapshot {
  pe_enabled?: boolean;
  profile_full?: boolean;
  discovery?: boolean;
  safe_mode?: boolean;
  pe_enable_flag?: boolean;
  pe_disable_flag?: boolean;
  log_all?: boolean;
  object_debug?: boolean;
  non_ui_probe?: boolean;
  ui_counter_fallback?: boolean;
  score_ui_fallback?: boolean;
  hook_process_internal?: boolean;
  hook_process_local_script?: boolean;
  class_probe_hooks?: boolean;
  allow_unsafe_hooks?: boolean;
  rust_enabled?: boolean;
  pe_hook_registered?: boolean;
  native_hooks_registered?: boolean;
  process_internal_callbacks_registered?: boolean;
  process_local_script_callbacks_registered?: boolean;
}

const METHOD_FLAG_FILTERS: Array<{ key: keyof MethodFlagSnapshot; label: string }> = [
  { key: "pe_enabled", label: "pe_enabled" },
  { key: "profile_full", label: "profile_full" },
  { key: "discovery", label: "discovery" },
  { key: "safe_mode", label: "safe_mode" },
  { key: "pe_enable_flag", label: "pe_enable_flag" },
  { key: "pe_disable_flag", label: "pe_disable_flag" },
  { key: "log_all", label: "log_all" },
  { key: "object_debug", label: "object_debug" },
  { key: "non_ui_probe", label: "non_ui_probe" },
  { key: "ui_counter_fallback", label: "ui_counter_fallback" },
  { key: "score_ui_fallback", label: "score_ui_fallback" },
  { key: "hook_process_internal", label: "hook_process_internal" },
  { key: "hook_process_local_script", label: "hook_process_local_script" },
  { key: "class_probe_hooks", label: "class_probe_hooks" },
  { key: "allow_unsafe_hooks", label: "allow_unsafe_hooks" },
  { key: "rust_enabled", label: "rust_enabled" },
  { key: "pe_hook_registered", label: "pe_hook_registered" },
  { key: "native_hooks_registered", label: "native_hooks_registered" },
  { key: "process_internal_callbacks_registered", label: "pi_callbacks_registered" },
  { key: "process_local_script_callbacks_registered", label: "pls_callbacks_registered" },
];

function makeDefaultMethodFlagFilters(): Record<keyof MethodFlagSnapshot, TriBoolFilter> {
  return METHOD_FLAG_FILTERS.reduce((acc, entry) => {
    acc[entry.key] = "any";
    return acc;
  }, {} as Record<keyof MethodFlagSnapshot, TriBoolFilter>);
}

interface MethodSample {
  idx: number;
  ts: string;
  ev: string;
  metric: string;
  method: string;
  fn: string;
  receiver: string;
  origin: string;
  originFlag: string;
  value: number | null;
  flags: MethodFlagSnapshot;
  raw: string;
}

interface UiSetTextEvent {
  ts: number;
  className: string;
  path: string;
  leaf: string;
  scope: "session" | "pause" | "other"; 
  root: string;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "mem_debug_watches_v1";

function loadWatches(): WatchEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveWatches(watches: WatchEntry[]) {
  // Strip runtime-only fields before persisting
  const clean = watches.map(({ currentValue: _, currentAddr: __, readOk: ___, error: ____, ...w }) => w);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2);
}

function fmtValue(v: number, type: ValueType): string {
  if (type === "f32" || type === "f64") return v.toFixed(4);
  return String(Math.round(v));
}

function parseUiSetTextLine(line: string): UiSetTextEvent | null {
  const prefix = "[kmod-events] [ui_settext] ctx=";
  if (!line.startsWith(prefix)) return null;
  const ctx = line.slice(prefix.length).trim();
  if (!ctx) return null;

  let className = "";
  let path = ctx;
  const space = ctx.indexOf(" ");
  if (space > 0) {
    className = ctx.slice(0, space).trim();
    path = ctx.slice(space + 1).trim();
  }

  const lastDot = path.lastIndexOf(".");
  const leaf = lastDot >= 0 ? path.slice(lastDot + 1) : path;
  let scope: UiSetTextEvent["scope"] = "other";
  if (path.includes("SessionStatistics_")) {
    scope = "session";
  } else if (path.includes("PauseMenu")) {
    scope = "pause";
  }

  const rootMatch = path.match(/WidgetTree\.([A-Za-z0-9_]+)/);
  const root = rootMatch?.[1] ?? "";

  return {
    ts: Date.now(),
    className,
    path,
    leaf,
    scope,
    root,
  };
}

function parseMethodFlagSnapshot(input: unknown): MethodFlagSnapshot {
  const obj = (input && typeof input === "object") ? (input as Record<string, unknown>) : null;
  if (!obj) return {};
  const readBool = (key: keyof MethodFlagSnapshot): boolean | undefined => {
    const v = obj[key as string];
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const lower = v.trim().toLowerCase();
      if (lower === "1" || lower === "true" || lower === "on") return true;
      if (lower === "0" || lower === "false" || lower === "off") return false;
    }
    return undefined;
  };
  return {
    pe_enabled: readBool("pe_enabled"),
    profile_full: readBool("profile_full"),
    discovery: readBool("discovery"),
    safe_mode: readBool("safe_mode"),
    pe_enable_flag: readBool("pe_enable_flag"),
    pe_disable_flag: readBool("pe_disable_flag"),
    log_all: readBool("log_all"),
    object_debug: readBool("object_debug"),
    non_ui_probe: readBool("non_ui_probe"),
    ui_counter_fallback: readBool("ui_counter_fallback"),
    score_ui_fallback: readBool("score_ui_fallback"),
    hook_process_internal: readBool("hook_process_internal"),
    hook_process_local_script: readBool("hook_process_local_script"),
    class_probe_hooks: readBool("class_probe_hooks"),
    allow_unsafe_hooks: readBool("allow_unsafe_hooks"),
    rust_enabled: readBool("rust_enabled"),
    pe_hook_registered: readBool("pe_hook_registered"),
    native_hooks_registered: readBool("native_hooks_registered"),
    process_internal_callbacks_registered: readBool("process_internal_callbacks_registered"),
    process_local_script_callbacks_registered: readBool("process_local_script_callbacks_registered"),
  };
}

function triBoolMatch(value: boolean | undefined, filter: TriBoolFilter): boolean {
  if (filter === "any") return true;
  if (value === undefined) return false;
  return filter === "on" ? value : !value;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const LABEL_COL: React.CSSProperties = { color: "rgba(255,255,255,0.35)", fontSize: 11, fontFamily: "monospace" };
const VALUE_COL: React.CSSProperties = { fontFamily: "monospace", fontSize: 12, fontVariantNumeric: "tabular-nums" };

const INPUT: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 4, color: "#fff", fontFamily: "monospace", fontSize: 12,
  padding: "3px 7px", outline: "none",
};

const BTN = (accent = false): React.CSSProperties => ({
  background: accent ? "rgba(0,245,160,0.12)" : "rgba(255,255,255,0.06)",
  border: `1px solid ${accent ? "rgba(0,245,160,0.3)" : "rgba(255,255,255,0.12)"}`,
  borderRadius: 4, color: accent ? "#00f5a0" : "rgba(255,255,255,0.7)",
  fontFamily: "monospace", fontSize: 11, padding: "3px 10px",
  cursor: "pointer", flexShrink: 0,
});

const TYPE_OPTIONS: ValueType[] = ["i32", "u32", "i64", "f32", "f64", "u8"];

const TYPE_LABELS: Record<ValueType, string> = {
  i32: "i32  signed int",
  u32: "u32  unsigned",
  i64: "i64  int 64-bit",
  f32: "f32  float",
  f64: "f64  double",
  u8:  "u8   byte",
};

function TypeSelect({ value, onChange }: { value: ValueType; onChange: (v: ValueType) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ValueType)}
      style={{ ...INPUT, width: 128, colorScheme: "dark" }}
    >
      {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
    </select>
  );
}

// ─── Watches tab ──────────────────────────────────────────────────────────────

function WatchesTab() {
  const [watches, setWatches] = useState<WatchEntry[]>(() => loadWatches());
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<ValueType>("i32");
  const [newAddr, setNewAddr] = useState("");
  const [newChain, setNewChain] = useState("");
  const [useChain, setUseChain] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollWatches = useCallback(async (current: WatchEntry[]) => {
    if (current.length === 0) return;
    const requests = current.map((w) => ({
      value_type: w.type,
      addr_hex: w.addrHex ?? null,
      chain: w.chain ? w.chain.split(/\s+/).filter(Boolean) : null,
    }));
    try {
      const results: Array<{ value?: number; addr?: string; ok: boolean; error?: string }> =
        await invoke("mem_read_watches", { requests });
      setWatches((prev) =>
        prev.map((w, i) => {
          const r = results[i];
          if (!r) return w;
          return {
            ...w,
            currentValue: r.ok && r.value != null ? fmtValue(r.value, w.type) : undefined,
            currentAddr: r.addr,
            readOk: r.ok,
            error: r.error,
          };
        })
      );
    } catch {
      // game not running — leave values stale
    }
  }, []);

  // Start polling on mount, stop on unmount
  useEffect(() => {
    pollRef.current = setInterval(() => {
      setWatches((current) => {
        pollWatches(current);
        return current;
      });
    }, 1000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollWatches]);

  // Persist whenever watches list changes (but not runtime fields — handled in saveWatches)
  useEffect(() => { saveWatches(watches); }, [watches]);

  // Reload when ScannerTab / ChainTab add a watch from the outside
  useEffect(() => {
    const handler = () => setWatches(loadWatches());
    window.addEventListener("watches-updated", handler);
    return () => window.removeEventListener("watches-updated", handler);
  }, []);

  function addWatch() {
    const entry: WatchEntry = {
      id: uid(),
      label: newLabel || (useChain ? newChain.split(/\s+/)[0] : newAddr) || "unnamed",
      type: newType,
      ...(useChain ? { chain: newChain.trim() } : { addrHex: newAddr.trim() }),
    };
    setWatches((prev) => [...prev, entry]);
    setNewLabel(""); setNewAddr(""); setNewChain("");
    setAdding(false);
  }

  function remove(id: string) {
    setWatches((prev) => prev.filter((w) => w.id !== id));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", letterSpacing: 1, textTransform: "uppercase" }}>
        Watch list — polled every 1 s — persists across restarts
      </div>

      {/* Table */}
      <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, overflow: "hidden" }}>
        {/* Header */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 160px 55px 130px 48px 28px", gap: 8, padding: "6px 12px", borderBottom: "1px solid rgba(255,255,255,0.07)", fontSize: 10, color: "rgba(255,255,255,0.25)", letterSpacing: 0.8 }}>
          <span>LABEL</span><span>ADDR / CHAIN</span><span>TYPE</span><span>VALUE</span><span /><span />
        </div>

        {watches.length === 0 && (
          <div style={{ padding: "20px 12px", color: "rgba(255,255,255,0.2)", fontSize: 12, textAlign: "center" }}>
            No watches yet — add one below or from Scanner results.
          </div>
        )}

        {watches.map((w) => {
          const resolvedAddr = w.currentAddr ?? w.addrHex;
          return (
            <div key={w.id} style={{ display: "grid", gridTemplateColumns: "1fr 160px 55px 130px 48px 28px", gap: 8, padding: "6px 12px", borderBottom: "1px solid rgba(255,255,255,0.04)", alignItems: "center" }}>
              <span style={{ fontFamily: "monospace", fontSize: 12, color: "#fff" }}>{w.label}</span>
              <span style={{ ...LABEL_COL, fontSize: 10, wordBreak: "break-all" }}>
                {w.chain ? `chain: ${w.chain}` : w.addrHex}
              </span>
              <span style={{ ...LABEL_COL }}>{w.type}</span>
              <span style={{
                ...VALUE_COL,
                color: w.readOk ? "#fff" : w.readOk === false ? "rgba(255,80,80,0.7)" : "rgba(255,255,255,0.25)",
              }}>
                {w.readOk && w.currentValue != null
                  ? w.currentValue
                  : w.error
                  ? <span style={{ fontSize: 10, color: "rgba(255,80,80,0.6)" }}>{w.error}</span>
                  : "—"}
                {w.currentAddr && <span style={{ ...LABEL_COL, marginLeft: 6 }}>{w.currentAddr}</span>}
              </span>
              {/* Ptr scan shortcut — only useful when we have a resolved address */}
              <button
                onClick={() => {
                  if (!resolvedAddr) return;
                  window.dispatchEvent(new CustomEvent("open-ptr-scan", { detail: { addr: resolvedAddr } }));
                  window.dispatchEvent(new CustomEvent("switch-debug-tab", { detail: { tab: "ptrscan" } }));
                }}
                disabled={!resolvedAddr}
                style={{ ...BTN(), fontSize: 10, padding: "2px 5px", opacity: resolvedAddr ? 1 : 0.3 }}
                title="Find pointers to this address"
              >
                →ptr
              </button>
              <button onClick={() => remove(w.id)} style={{ background: "none", border: "none", color: "rgba(255,80,80,0.5)", cursor: "pointer", fontSize: 14, padding: 0 }}>×</button>
            </div>
          );
        })}
      </div>

      {/* Add form */}
      {adding ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={LABEL_COL}>Label</span>
            <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. kills" style={{ ...INPUT, flex: 1 }} />
            <TypeSelect value={newType} onChange={setNewType} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={() => setUseChain(true)} style={{ ...BTN(useChain), fontSize: 10 }}>Chain</button>
            <button onClick={() => setUseChain(false)} style={{ ...BTN(!useChain), fontSize: 10 }}>Raw addr</button>
          </div>
          {useChain ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ ...LABEL_COL, fontSize: 10 }}>Offsets (space-separated hex, relative to game base). All but last are ptr dereferences.</span>
              <input value={newChain} onChange={(e) => setNewChain(e.target.value)} placeholder="e.g. 4F5FBF0 0 9C8" style={{ ...INPUT, width: "100%", boxSizing: "border-box" }} />
              <span style={{ ...LABEL_COL, fontSize: 10 }}>= game_base →+4F5FBF0 →+0 → read i32 at +9C8</span>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={LABEL_COL}>Address (hex)</span>
              <input value={newAddr} onChange={(e) => setNewAddr(e.target.value)} placeholder="0x1A2B3C4D" style={{ ...INPUT, flex: 1 }} />
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={addWatch} style={BTN(true)}>Add</button>
            <button onClick={() => setAdding(false)} style={BTN()}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ ...BTN(true), alignSelf: "flex-start" }}>+ Add Watch</button>
      )}
    </div>
  );
}

// Export helper so external code can add a scan hit to the watch list.
export function addWatchFromScan(hit: ScanHit, type: ValueType) {
  const watches = loadWatches();
  if (watches.some((w) => w.addrHex === hit.addr)) return;
  watches.push({ id: uid(), label: hit.module_rel ?? hit.addr, type, addrHex: hit.addr });
  saveWatches(watches);
  window.dispatchEvent(new CustomEvent("watches-updated"));
}

// ─── Scanner tab ──────────────────────────────────────────────────────────────

interface ScanProgressEvt {
  scanned_mb: number;
  hits: number;
  pct: number;
  done: boolean;
  cancelled: boolean;
  error?: string;
}

// Max hits to live-poll every second (keep RPM calls manageable)
const LIVE_POLL_CAP = 500;

function ScannerTab() {
  const [valueStr, setValueStr] = useState("");
  const [type, setType] = useState<ValueType>("i32");
  const [hits, setHits] = useState<ScanHit[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgressEvt | null>(null);
  const [liveValues, setLiveValues] = useState<Record<string, string>>({});
  const prevHitsRef = useRef<ScanHit[]>([]);

  // Poll live values for the current hit list (capped at LIVE_POLL_CAP)
  useEffect(() => {
    if (hits.length === 0 || hits.length > LIVE_POLL_CAP) {
      setLiveValues({});
      return;
    }
    const poll = async () => {
      const requests = hits.map((h) => ({ value_type: type, addr_hex: h.addr, chain: null }));
      try {
        const results: Array<{ value?: number; ok: boolean }> =
          await invoke("mem_read_watches", { requests });
        const map: Record<string, string> = {};
        hits.forEach((h, i) => {
          const r = results[i];
          if (r?.ok && r.value != null) map[h.addr] = fmtValue(r.value, type);
        });
        setLiveValues(map);
      } catch { /* game not running */ }
    };
    poll(); // immediate first read
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, [hits, type]);

  // Subscribe to live progress events from the Rust scan worker
  useEffect(() => {
    const unlisten = listen<ScanProgressEvt>("mem-scan-progress", (e) => {
      setProgress(e.payload);
      if (e.payload.done) setScanning(false);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  async function runScan(rescan: boolean) {
    const target = parseFloat(valueStr);
    if (isNaN(target)) { setProgress({ scanned_mb: 0, hits: 0, pct: 0, done: true, cancelled: false, error: "Enter a numeric value first." }); return; }

    setScanning(true);
    setProgress({ scanned_mb: 0, hits: 0, pct: 0, done: false, cancelled: false });
    try {
      let result: ScanHit[];
      if (rescan && prevHitsRef.current.length > 0) {
        result = await invoke<ScanHit[]>("mem_rescan", {
          addrs: prevHitsRef.current.map((h) => h.addr),
          valueType: type,
          target,
        });
        setProgress((p) => p ? { ...p, done: true, hits: result.length } : null);
        setScanning(false);
      } else {
        // Progress arrives via "mem-scan-progress" events; also clear scanning when invoke resolves.
        result = await invoke<ScanHit[]>("mem_scan", { valueType: type, target });
        setScanning(false);
      }
      setHits(result);
      prevHitsRef.current = result;
    } catch (e) {
      setProgress({ scanned_mb: 0, hits: 0, pct: 0, done: true, cancelled: false, error: String(e) });
      setScanning(false);
    }
  }

  async function cancel() {
    await invoke("mem_scan_cancel");
  }

  function addToWatches(hit: ScanHit) {
    const watches = loadWatches();
    if (watches.some((w) => w.addrHex === hit.addr)) return; // already watching
    watches.push({ id: uid(), label: hit.module_rel ?? hit.addr, type, addrHex: hit.addr });
    saveWatches(watches);
    window.dispatchEvent(new CustomEvent("watches-updated"));
  }

  const statusText = progress
    ? progress.error
      ? `Error: ${progress.error}`
      : progress.cancelled
      ? `Cancelled — ${progress.hits} hits found`
      : progress.done
      ? `Done — ${progress.hits} hit${progress.hits !== 1 ? "s" : ""}${progress.hits >= 2000 ? " (capped)" : ""}`
      : `Scanning… ${progress.scanned_mb} MB read, ${progress.hits} hits`
    : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Controls */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          value={valueStr}
          onChange={(e) => setValueStr(e.target.value)}
          placeholder="value to find…"
          style={{ ...INPUT, width: 140 }}
          onKeyDown={(e) => e.key === "Enter" && !scanning && runScan(false)}
        />
        <TypeSelect value={type} onChange={setType} />
        <button onClick={() => runScan(false)} disabled={scanning} style={BTN(true)}>
          {scanning ? "Scanning…" : "Scan"}
        </button>
        <button
          onClick={() => runScan(true)}
          disabled={scanning || prevHitsRef.current.length === 0}
          style={BTN()}
          title="Re-check previous results with new value"
        >
          Rescan
        </button>
        {scanning && (
          <button onClick={cancel} style={{ ...BTN(), color: "rgba(255,100,100,0.8)", borderColor: "rgba(255,100,100,0.3)" }}>
            Cancel
          </button>
        )}
        {!scanning && hits.length > 0 && (
          <button onClick={() => { setHits([]); prevHitsRef.current = []; setProgress(null); }} style={BTN()}>Clear</button>
        )}
      </div>

      {/* Progress bar + status */}
      {progress && !progress.done && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progress.pct}%`, background: "#00f5a0", borderRadius: 2, transition: "width 0.3s ease" }} />
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", fontFamily: "monospace" }}>{statusText}</div>
        </div>
      )}
      {progress?.done && statusText && (
        <div style={{ fontSize: 11, fontFamily: "monospace", color: progress.error || progress.cancelled ? "rgba(255,120,120,0.8)" : "rgba(0,245,160,0.7)" }}>
          {statusText}
        </div>
      )}

      {/* Results */}
      {hits.length > 0 && (
        <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, overflow: "hidden", maxHeight: 420, overflowY: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "150px 1fr 180px 28px", gap: 8, padding: "6px 12px", borderBottom: "1px solid rgba(255,255,255,0.07)", fontSize: 10, color: "rgba(255,255,255,0.25)", letterSpacing: 0.8, position: "sticky", top: 0, background: "rgba(0,0,0,0.7)" }}>
            <span>ADDRESS</span><span>MODULE REL</span><span>VALUE → LIVE</span><span />
          </div>
          {hits.map((h) => {
            const scanned = fmtValue(h.value, type);
            const live = liveValues[h.addr];
            const changed = live !== undefined && live !== scanned;
            const alreadyWatching = loadWatches().some((w) => w.addrHex === h.addr);
            return (
              <div key={h.addr} style={{ display: "grid", gridTemplateColumns: "150px 1fr 180px 28px", gap: 8, padding: "4px 12px", borderBottom: "1px solid rgba(255,255,255,0.03)", alignItems: "center" }}>
                <span style={{ ...LABEL_COL, fontSize: 11 }}>{h.addr}</span>
                <span style={{ ...LABEL_COL, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.module_rel ?? "—"}</span>
                <span style={{ ...VALUE_COL, display: "flex", alignItems: "center", gap: 4 }}>
                  <span>{scanned}</span>
                  {live !== undefined && (
                    <span style={{ fontSize: 11, color: changed ? "rgba(255,200,60,0.9)" : "rgba(0,245,160,0.7)" }}>→ {live}</span>
                  )}
                  {hits.length > LIVE_POLL_CAP && live === undefined && (
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>rescan↓</span>
                  )}
                </span>
                <button
                  onClick={() => addToWatches(h)}
                  disabled={alreadyWatching}
                  style={{ background: "none", border: "none", color: alreadyWatching ? "rgba(255,255,255,0.15)" : "rgba(0,245,160,0.6)", cursor: alreadyWatching ? "default" : "pointer", fontSize: 14, padding: 0 }}
                  title={alreadyWatching ? "Already in watches" : "Add to watches"}
                >
                  {alreadyWatching ? "·" : "+"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.18)", display: "flex", flexDirection: "column", gap: 3 }}>
        <span>Only scans PAGE_READWRITE regions. Results capped at 2 000. Scan → change value in-game → Rescan to narrow down.</span>
        <span>
          Types: <span style={{ color: "rgba(255,255,255,0.4)" }}>i32/u32</span> for integers (kills, shots, ammo)
          · <span style={{ color: "rgba(255,255,255,0.4)" }}>f32/f64</span> for decimals (time, damage)
          · <span style={{ color: "rgba(255,255,255,0.4)" }}>u8</span> for bytes (0–255)
        </span>
      </div>
    </div>
  );
}

// ─── Chain tester tab ─────────────────────────────────────────────────────────

function ChainTab({ pendingOffsets }: { pendingOffsets: string[] | null }) {
  const [offsets, setOffsets] = useState<string[]>(["4F5FBF0", "0", "9C8"]);
  const [type, setType] = useState<ValueType>("i32");
  const [result, setResult] = useState<ChainResult | null>(null);
  const [running, setRunning] = useState(false);

  // State for the "Find nearby fields" panel
  const [structScanBase, setStructScanBase] = useState("");
  const [structScanType, setStructScanType] = useState<ValueType>("i32");
  const [structScanTarget, setStructScanTarget] = useState("");
  const [structScanRadius, setStructScanRadius] = useState("1000");
  const [structScanHits, setStructScanHits] = useState<StructScanHit[]>([]);
  const [structScanning, setStructScanning] = useState(false);
  const [structScanError, setStructScanError] = useState<string | null>(null);

  // When PtrScanTab sends offsets to pre-populate, apply them
  useEffect(() => {
    if (pendingOffsets && pendingOffsets.length > 0) setOffsets(pendingOffsets);
  }, [pendingOffsets]);

  async function follow() {
    setRunning(true);
    try {
      const raw = await invoke<ChainResult>("mem_follow_chain", {
        offsetsHex: offsets.filter((o) => o.trim()),
        valueType: type,
      });
      setResult(raw);
      // On successful chain follow, auto-populate the base address for struct scan
      if (raw.ok && raw.steps.length > 1) {
        const finalStep = raw.steps[raw.steps.length - 2];
        setStructScanBase(finalStep.ptr_value);
      }
    } catch (e) {
      setResult({ steps: [], final_addr: null, final_value: null, ok: false, error: String(e) });
    } finally {
      setRunning(false);
    }
  }

  async function runStructScan() {
    const target = parseFloat(structScanTarget);
    const radius = parseInt(structScanRadius, 16);
    if (isNaN(target) || isNaN(radius) || !structScanBase) {
      setStructScanError("Base address, target value, and radius (hex) must be valid.");
      return;
    }
    setStructScanning(true);
    setStructScanError(null);
    setStructScanHits([]);
    try {
      const hits = await invoke<StructScanHit[]>("mem_scan_struct", {
        baseAddrHex: structScanBase,
        valueType: structScanType,
        target,
        radius,
      });
      setStructScanHits(hits);
    } catch (e) {
      setStructScanError(String(e));
    } finally {
      setStructScanning(false);
    }
  }

  function addOffset() { setOffsets((prev) => [...prev, ""]); }
  function removeOffset(i: number) { setOffsets((prev) => prev.filter((_, j) => j !== i)); }
  function setOffset(i: number, v: string) { setOffsets((prev) => prev.map((o, j) => j === i ? v : o)); }

  function saveAsWatch() {
    if (!result?.ok) return;
    const chainStr = offsets.filter(Boolean).join(" ");
    const watches = loadWatches();
    if (watches.some((w) => w.chain === chainStr)) return;
    watches.push({ id: uid(), label: `chain (${offsets.join("→")})`, type, chain: chainStr });
    saveWatches(watches);
    window.dispatchEvent(new CustomEvent("watches-updated"));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Concept banner */}
      <div style={{ fontSize: 11, fontFamily: "monospace", lineHeight: 1.7, padding: "8px 12px", background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6, color: "rgba(255,255,255,0.3)" }}>
        <span style={{ color: "rgba(100,180,255,0.8)" }}>PTR</span> hops read a 64-bit pointer and follow it to the next address.
        &nbsp;The last hop reads the final <span style={{ color: "#00f5a0" }}>{type}</span> value.
        &nbsp;Chain: <span style={{ color: "rgba(255,255,255,0.45)" }}>game_base → follow ptrs → read {type}</span>
      </div>

      {/* Chain steps */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {offsets.map((off, i) => {
          const isFinal = i === offsets.length - 1;
          const step = result?.steps[i];
          return (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{
                fontSize: 10, fontFamily: "monospace", padding: "2px 5px", borderRadius: 3, flexShrink: 0,
                minWidth: 34, textAlign: "center",
                background: isFinal ? "rgba(0,245,160,0.1)" : "rgba(100,180,255,0.08)",
                border: `1px solid ${isFinal ? "rgba(0,245,160,0.25)" : "rgba(100,180,255,0.15)"}`,
                color: isFinal ? "#00f5a0" : "rgba(100,180,255,0.8)",
              }}>
                {isFinal ? type : "PTR"}
              </span>
              <span style={{ ...LABEL_COL, width: 60, flexShrink: 0, fontSize: 10, textAlign: "right" }}>
                {i === 0 ? "game_base" : `ptr${i - 1}`}
              </span>
              <span style={{ color: "rgba(255,255,255,0.2)", fontSize: 12, flexShrink: 0 }}>+0x</span>
              <input
                value={off}
                onChange={(e) => setOffset(i, e.target.value)}
                placeholder="offset"
                style={{ ...INPUT, width: 100 }}
              />
              {step && (
                <>
                  <span style={{ color: "rgba(255,255,255,0.15)", flexShrink: 0 }}>→</span>
                  <span style={{
                    fontFamily: "monospace", fontSize: 11, flexShrink: 0,
                    color: step.ok
                      ? isFinal ? "#00f5a0" : "rgba(100,180,255,0.8)"
                      : "rgba(255,80,80,0.7)",
                  }}>
                    {step.ok ? step.ptr_value : "✗"}
                  </span>
                  {step.ok && !isFinal && (
                    <span style={{ ...LABEL_COL, fontSize: 10 }}>({step.addr})</span>
                  )}
                </>
              )}
              {offsets.length > 1 && (
                <button onClick={() => removeOffset(i)} style={{ background: "none", border: "none", color: "rgba(255,80,80,0.4)", cursor: "pointer", fontSize: 14, padding: 0, marginLeft: "auto", flexShrink: 0 }}>×</button>
              )}
            </div>
          );
        })}
        <button onClick={addOffset} style={{ ...BTN(), alignSelf: "flex-start", fontSize: 10, marginTop: 2 }}>+ Add hop</button>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={LABEL_COL}>Final type</span>
        <TypeSelect value={type} onChange={setType} />
        <button onClick={follow} disabled={running} style={BTN(true)}>
          {running ? "Following…" : "Follow chain"}
        </button>
        {result?.ok && (
          <button onClick={saveAsWatch} style={BTN()}>Save to Watches</button>
        )}
      </div>

      {/* Result summary */}
      {result?.ok && result.final_addr && (
        <div style={{ fontSize: 11, fontFamily: "monospace", padding: "6px 10px", borderRadius: 5, background: "rgba(0,245,160,0.05)", border: "1px solid rgba(0,245,160,0.15)", color: "rgba(0,245,160,0.8)" }}>
          ✓ &nbsp;{result.final_addr} = {result.final_value}
        </div>
      )}
      {result && !result.ok && result.error && (
        <div style={{ fontSize: 11, fontFamily: "monospace", padding: "6px 10px", borderRadius: 5, background: "rgba(255,80,80,0.05)", border: "1px solid rgba(255,80,80,0.15)", color: "rgba(255,80,80,0.8)" }}>
          ✗ &nbsp;{result.error}
        </div>
      )}

      {/* Find nearby fields panel */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 24, paddingTop: 20, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", letterSpacing: 1, textTransform: "uppercase" }}>
                Find nearby fields
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
                Scan memory near an object base to discover fields (e.g. find HP offset from Player base).
                Following a chain above will auto-fill the base address.
            </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={LABEL_COL}>Base (hex)</span>
            <input value={structScanBase} onChange={e => setStructScanBase(e.target.value)} placeholder="object base addr" style={{...INPUT, width: 140}} />
            <span style={LABEL_COL}>Type</span>
            <TypeSelect value={structScanType} onChange={setStructScanType} />
            <span style={LABEL_COL}>Target</span>
            <input value={structScanTarget} onChange={e => setStructScanTarget(e.target.value)} placeholder="value" style={{...INPUT, width: 80}} />
            <span style={LABEL_COL}>Radius (hex)</span>
            <input value={structScanRadius} onChange={e => setStructScanRadius(e.target.value)} placeholder="e.g. 1000" style={{...INPUT, width: 80}} />

            <button onClick={runStructScan} disabled={structScanning} style={BTN(true)}>
                {structScanning ? "Scanning..." : "Scan Struct"}
            </button>
        </div>

        {structScanError && (
            <div style={{ fontSize: 11, fontFamily: "monospace", color: "rgba(255,100,100,0.8)"}}>{structScanError}</div>
        )}

        {structScanHits.length > 0 && (
            <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, overflow: "hidden", maxHeight: 280, overflowY: "auto" }}>
                <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 120px", gap: 8, padding: "6px 12px", borderBottom: "1px solid rgba(255,255,255,0.07)", fontSize: 10, color: "rgba(255,255,255,0.25)", position: "sticky", top: 0, background: "rgba(0,0,0,0.7)" }}>
                    <span>OFFSET</span><span>ADDRESS</span><span>VALUE</span>
                </div>
                {structScanHits.map(h => (
                    <div key={h.addr} style={{ display: "grid", gridTemplateColumns: "100px 1fr 120px", gap: 8, padding: "4px 12px", borderBottom: "1px solid rgba(255,255,255,0.03)", alignItems: "center" }}>
                        <span style={{ fontFamily: "monospace", fontSize: 11, color: "#00f5a0" }}>{h.offset}</span>
                        <span style={{...LABEL_COL, fontSize: 11}}>{h.addr}</span>
                        <span style={VALUE_COL}>{fmtValue(h.value, structScanType)}</span>
                    </div>
                ))}
            </div>
        )}
      </div>
    </div>
  );
}

// ─── Pointer scan tab ────────────────────────────────────────────────────────

interface PtrScanProgressEvt {
  scanned_mb: number; hits: number; pct: number;
  done: boolean; cancelled: boolean; error?: string;
}

function PtrScanTab({ onLoadChain }: { onLoadChain: (offsets: string[]) => void }) {
  const [targetAddr, setTargetAddr] = useState("");
  const [maxBack, setMaxBack] = useState("1000");
  const [hits, setHits] = useState<PtrScanHit[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<PtrScanProgressEvt | null>(null);

  // Listen to ptr-scan-specific progress events (separate from value scan)
  useEffect(() => {
    const unlisten = listen<PtrScanProgressEvt>("mem-ptr-scan-progress", (e) => {
      setProgress(e.payload);
      if (e.payload.done) setScanning(false);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // "→ptr" button on a watch entry sets target addr and switches here
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ addr: string }>;
      setTargetAddr(ce.detail.addr);
    };
    window.addEventListener("open-ptr-scan", handler);
    return () => window.removeEventListener("open-ptr-scan", handler);
  }, []);

  async function run() {
    const maxBackNum = parseInt(maxBack, 16);
    if (isNaN(maxBackNum) || !targetAddr.trim()) return;
    setScanning(true);
    setProgress({ scanned_mb: 0, hits: 0, pct: 0, done: false, cancelled: false });
    try {
      const result = await invoke<PtrScanHit[]>("mem_ptr_scan", {
        targetAddr: targetAddr.trim(),
        maxBack: maxBackNum,
      });
      setHits(result);
      setScanning(false);
    } catch (e) {
      setProgress({ scanned_mb: 0, hits: 0, pct: 0, done: true, cancelled: false, error: String(e) });
      setScanning(false);
    }
  }

  async function cancel() { await invoke("mem_scan_cancel"); }

  function loadChain(h: PtrScanHit) {
    // Extract module hex offset from "Name.exe+0xABCD" → "ABCD"
    const rel = h.module_rel ?? "";
    const plusIdx = rel.indexOf("+0x");
    const modOff = plusIdx >= 0 ? rel.slice(plusIdx + 3) : rel;
    const targetOff = h.offset.toString(16).toUpperCase();
    onLoadChain([modOff, targetOff]);
  }

  const staticHits = hits.filter((h) => h.module_rel !== null);
  const dynamicHits = hits.filter((h) => h.module_rel === null);
  const statusText = progress
    ? progress.error ? `Error: ${progress.error}`
    : progress.cancelled ? `Cancelled — ${progress.hits} pointers found`
    : progress.done ? `Done — ${hits.length} pointer${hits.length !== 1 ? "s" : ""} (${staticHits.length} static)`
    : `Scanning… ${progress.scanned_mb} MB, ${progress.hits} hits`
    : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Concept */}
      <div style={{ fontSize: 11, fontFamily: "monospace", color: "rgba(255,255,255,0.3)", lineHeight: 1.7, padding: "8px 12px", background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6 }}>
        Finds all 8-byte pointers that land within <span style={{ color: "rgba(255,255,255,0.5)" }}>max_back</span> bytes of the target.
        &nbsp;<span style={{ color: "#00f5a0" }}>Static</span> hits (module-relative) are stable across restarts → use them to build chains.
        &nbsp;For deep chains, click <span style={{ color: "rgba(100,180,255,0.8)" }}>+lvl</span> on a heap hit to scan one level deeper.
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input value={targetAddr} onChange={(e) => setTargetAddr(e.target.value)}
          placeholder="target addr (hex)" style={{ ...INPUT, width: 160 }}
          onKeyDown={(e) => e.key === "Enter" && !scanning && run()} />
        <span style={LABEL_COL}>max back</span>
        <input value={maxBack} onChange={(e) => setMaxBack(e.target.value)}
          placeholder="hex" style={{ ...INPUT, width: 72 }}
          title="How far before the target to search (hex). 1000 = 4 KB, common for struct fields." />
        <button onClick={run} disabled={scanning || !targetAddr.trim()} style={BTN(true)}>
          {scanning ? "Scanning…" : "Find pointers"}
        </button>
        {scanning && (
          <button onClick={cancel} style={{ ...BTN(), color: "rgba(255,100,100,0.8)", borderColor: "rgba(255,100,100,0.3)" }}>Cancel</button>
        )}
        {!scanning && hits.length > 0 && (
          <button onClick={() => { setHits([]); setProgress(null); }} style={BTN()}>Clear</button>
        )}
      </div>

      {/* Progress */}
      {progress && !progress.done && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progress.pct}%`, background: "#00f5a0", borderRadius: 2, transition: "width 0.3s ease" }} />
          </div>
          <div style={{ fontSize: 11, fontFamily: "monospace", color: "rgba(255,255,255,0.45)" }}>{statusText}</div>
        </div>
      )}
      {progress?.done && statusText && (
        <div style={{ fontSize: 11, fontFamily: "monospace", color: progress.error || progress.cancelled ? "rgba(255,120,120,0.8)" : "rgba(0,245,160,0.7)" }}>
          {statusText}
        </div>
      )}

      {/* Static hits — green, stable across restarts */}
      {staticHits.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 10, color: "#00f5a0", letterSpacing: 1, textTransform: "uppercase" }}>
            Static pointers — survive restarts ({staticHits.length})
          </div>
          <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(0,245,160,0.12)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 80px", gap: 8, padding: "6px 12px", borderBottom: "1px solid rgba(255,255,255,0.07)", fontSize: 10, color: "rgba(255,255,255,0.25)" }}>
              <span>MODULE OFFSET</span><span>+STRUCT OFF</span><span />
            </div>
            {staticHits.map((h) => (
              <div key={h.addr} style={{ display: "grid", gridTemplateColumns: "1fr 90px 80px", gap: 8, padding: "5px 12px", borderBottom: "1px solid rgba(255,255,255,0.04)", alignItems: "center" }}>
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "#00f5a0" }}>{h.module_rel}</span>
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "rgba(255,255,255,0.6)" }}>+0x{h.offset.toString(16).toUpperCase()}</span>
                <button onClick={() => loadChain(h)} style={{ ...BTN(true), fontSize: 10, padding: "2px 6px" }}
                  title="Load these two offsets into Chain tab and switch to it">
                  →Chain
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Dynamic hits — heap pointers, need deeper scan */}
      {dynamicHits.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", letterSpacing: 1, textTransform: "uppercase" }}>
            Heap pointers — scan deeper to find their static base ({dynamicHits.length})
          </div>
          <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, overflow: "hidden", maxHeight: 280, overflowY: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: "160px 1fr 90px 50px", gap: 8, padding: "6px 12px", borderBottom: "1px solid rgba(255,255,255,0.07)", fontSize: 10, color: "rgba(255,255,255,0.25)" }}>
              <span>PTR ADDRESS</span><span>POINTS TO</span><span>+STRUCT OFF</span><span />
            </div>
            {dynamicHits.map((h) => (
              <div key={h.addr} style={{ display: "grid", gridTemplateColumns: "160px 1fr 90px 50px", gap: 8, padding: "4px 12px", borderBottom: "1px solid rgba(255,255,255,0.03)", alignItems: "center" }}>
                <span style={{ ...LABEL_COL, fontSize: 11 }}>{h.addr}</span>
                <span style={{ ...LABEL_COL, fontSize: 11 }}>{h.ptr_value}</span>
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "rgba(255,255,255,0.5)" }}>+0x{h.offset.toString(16).toUpperCase()}</span>
                <button
                  onClick={() => {
                    setTargetAddr(h.addr);
                    // stay on this tab — user can adjust max_back and re-run
                  }}
                  style={{ ...BTN(), fontSize: 10, padding: "2px 4px" }}
                  title="Scan for pointers to this heap address (go one level deeper)"
                >
                  +lvl
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {hits.length === 0 && progress?.done && !progress.error && !progress.cancelled && (
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", fontFamily: "monospace" }}>
          No pointers found. Try increasing max_back (e.g. 2000 or 4000 hex).
        </div>
      )}
    </div>
  );
}

// ─── Auto Chain tab ──────────────────────────────────────────────────────────

interface AutoChainProgress {
  phase: number;        // 0 = building index, 1 = searching
  pct: number;
  index_size: number;
  chains_found: number;
  done: boolean;
  error?: string;
}

interface FoundChain {
  offsets: string[];
  module_rel: string;
  depth: number;
}

interface AutoChainResult {
  target_addr: string;
  target_label: string;
  chains: FoundChain[];
}

function AutoChainTab({ onLoadChain }: { onLoadChain: (offsets: string[]) => void }) {
  const [watches, setWatches] = useState<WatchEntry[]>(() => loadWatches());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Defaults tuned for KovaaK's (UE4):
  //   depth      6     — UE4 object graphs typically need 4-6 dereferences
  //   max_back   200   — real struct fields sit ≤ 512 bytes from their object base
  //   heap cap   100   — broader search per level to compensate for tight max_back
  //   max struct 200   — post-filter matches max_back; hides arena/buffer false hits
  const [maxDepth, setMaxDepth] = useState("6");
  const [maxBack, setMaxBack] = useState("200");
  const [maxHeapPerLevel, setMaxHeapPerLevel] = useState("100");
  const [maxStructOff, setMaxStructOff] = useState("200");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<AutoChainProgress | null>(null);
  const [results, setResults] = useState<AutoChainResult[]>([]);
  // Tracks the value_type to use per target label (set from the selected watch)
  const typeMapRef = useRef<Record<string, ValueType>>({});
  // chain key → { val, ok } after verification
  const [chainValues, setChainValues] = useState<Record<string, { val: string | null; ok: boolean }>>({});
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    const handler = () => setWatches(loadWatches());
    window.addEventListener("watches-updated", handler);
    return () => window.removeEventListener("watches-updated", handler);
  }, []);

  useEffect(() => {
    const unlisten = listen<AutoChainProgress>("mem-auto-chain-progress", (e) => {
      setProgress(e.payload);
      if (e.payload.done) setRunning(false);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Batch-read the current value through every found chain so users can verify correctness.
  async function verifyAllChains(chainResults: AutoChainResult[]) {
    const keys: string[] = [];
    const requests: Array<{ value_type: string; addr_hex: null; chain: string[] }> = [];

    for (const res of chainResults) {
      const vtype = typeMapRef.current[res.target_label] ?? "i32";
      for (const chain of res.chains) {
        keys.push(res.target_addr + "|" + chain.offsets.join(" "));
        requests.push({ value_type: vtype, addr_hex: null, chain: chain.offsets });
      }
    }
    if (requests.length === 0) return;

    setVerifying(true);
    try {
      const readResults: Array<{ value?: number; ok: boolean; error?: string }> =
        await invoke("mem_read_watches", { requests });
      const map: Record<string, { val: string | null; ok: boolean }> = {};
      keys.forEach((key, i) => {
        const r = readResults[i];
        const vtype = typeMapRef.current[
          (chainResults.find(res => key.startsWith(res.target_addr + "|"))?.target_label) ?? ""
        ] ?? "i32";
        map[key] = {
          val: r?.ok && r.value != null ? fmtValue(r.value, vtype) : null,
          ok: r?.ok ?? false,
        };
      });
      setChainValues(map);
    } catch { /* game not running */ }
    setVerifying(false);
  }

  async function run() {
    const selected = watches.filter((w) => selectedIds.has(w.id));
    if (selected.length === 0) return;

    setRunning(true);
    setResults([]);
    setChainValues({});
    setProgress({ phase: 0, pct: 0, index_size: 0, chains_found: 0, done: false });

    // Build typeMap from selected watches
    const newTypeMap: Record<string, ValueType> = {};
    selected.forEach((w) => { newTypeMap[w.label] = w.type; });
    typeMapRef.current = newTypeMap;

    // Resolve current addresses for chain-based watches
    const resolveReqs = selected.map((w) => ({
      value_type: w.type,
      addr_hex: w.addrHex ?? null,
      chain: w.chain ? w.chain.split(/\s+/).filter(Boolean) : null,
    }));
    let resolved: Array<{ addr?: string; ok: boolean }> = [];
    try {
      resolved = await invoke("mem_read_watches", { requests: resolveReqs });
    } catch { /* game not running — raw-addr watches still usable */ }

    const targetAddrs: string[] = [];
    const targetLabels: string[] = [];
    selected.forEach((w, i) => {
      const addr = w.addrHex ?? resolved[i]?.addr;
      if (addr) { targetAddrs.push(addr); targetLabels.push(w.label); }
    });

    if (targetAddrs.length === 0) {
      setProgress({
        phase: 0, pct: 0, index_size: 0, chains_found: 0, done: true,
        error: "No resolved addresses. Is the game running? Chain watches need the game online.",
      });
      setRunning(false);
      return;
    }

    const maxBackNum = parseInt(maxBack, 16);
    const depth = Math.max(1, Math.min(10, parseInt(maxDepth) || 5));
    const heapCap = Math.max(1, Math.min(500, parseInt(maxHeapPerLevel) || 50));

    try {
      const raw = await invoke<AutoChainResult[]>("mem_auto_chain_find", {
        targetAddrs,
        targetLabels,
        maxDepth: depth,
        maxBack: maxBackNum,
        maxHeapPerLevel: heapCap,
      });
      setResults(raw);
      setRunning(false);
      // Auto-verify all found chains immediately
      verifyAllChains(raw);
    } catch (e) {
      setProgress({ phase: 0, pct: 0, index_size: 0, chains_found: 0, done: true, error: String(e) });
      setRunning(false);
    }
  }

  async function cancel() { await invoke("mem_scan_cancel"); }

  // Only show chains where every non-first offset is within the struct-offset threshold.
  // Non-first offsets represent "distance from object base to field" — real struct fields
  // are almost always < 0x500.  Large values indicate accidental hits through memory arenas.
  const structOffThreshold = parseInt(maxStructOff, 16) || Infinity;
  const filteredResults = results.map((res) => ({
    ...res,
    chains: res.chains.filter((chain) =>
      chain.offsets.slice(1).every((o) => parseInt(o, 16) <= structOffThreshold)
    ),
    hiddenCount: res.chains.filter((chain) =>
      chain.offsets.slice(1).some((o) => parseInt(o, 16) > structOffThreshold)
    ).length,
  }));

  const totalChains = results.reduce((s, r) => s + r.chains.length, 0);
  const visibleChains = filteredResults.reduce((s, r) => s + r.chains.length, 0);
  const phaseLabel = progress
    ? progress.phase === 0
      ? `Building pointer index… ${progress.pct}%`
      : `Searching chains… ${progress.pct}%`
    : "";
  const hiddenTotal = totalChains - visibleChains;
  const statusText = progress
    ? progress.error
      ? `Error: ${progress.error}`
      : progress.done
      ? `Done — ${visibleChains} chain${visibleChains !== 1 ? "s" : ""} shown${hiddenTotal > 0 ? ` (${hiddenTotal} filtered — large offsets)` : ""}`
      : phaseLabel
    : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Concept banner */}
      <div style={{ fontSize: 11, fontFamily: "monospace", lineHeight: 1.7, padding: "8px 12px",
        background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6,
        color: "rgba(255,255,255,0.3)" }}>
        Scans <span style={{ color: "rgba(255,255,255,0.5)" }}>all</span> memory once to build a
        pointer index, then BFS-searches for static chains reaching each selected watch.
        &nbsp;<span style={{ color: "#00f5a0" }}>Values are read immediately so you can verify correctness.</span>
        &nbsp;Use <span style={{ color: "rgba(100,180,255,0.8)" }}>→Chain</span> to load into the Chain tab.
      </div>

      {/* Settings */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        {[
          { label: "depth",             val: maxDepth,        set: setMaxDepth,        w: 44,  title: "Max pointer dereference levels. KovaaK's (UE4) typically needs 4-6. Try 7-8 if nothing is found." },
          { label: "max back (hex)",    val: maxBack,         set: setMaxBack,         w: 72,  title: "Max distance from object base to target field (hex). 200 = 512 bytes covers most UE4 struct fields. Larger values find more hits but produce more unstable chains." },
          { label: "heap cap/lvl",      val: maxHeapPerLevel, set: setMaxHeapPerLevel, w: 44,  title: "Max heap addresses queued per BFS level. 100 is a good balance for UE4 — increase to 200+ if depth 6 finds nothing." },
          { label: "max struct off (hex)", val: maxStructOff, set: setMaxStructOff,   w: 72,  title: "Post-filter: hide chains with non-first offsets larger than this. Keep equal to max back. Large offsets = accidental hit through a memory arena, not a real struct field." },
        ].map(({ label, val, set, w, title }) => (
          <div key={label} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={LABEL_COL}>{label}</span>
            <input value={val} onChange={(e) => set(e.target.value)}
              style={{ ...INPUT, width: w }} title={title} />
          </div>
        ))}
      </div>

      {/* Watch selector */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", letterSpacing: 1, textTransform: "uppercase" }}>
          Select watches to find chains for
        </div>
        {watches.length === 0 ? (
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.2)", fontFamily: "monospace" }}>
            No watches yet — add some in the Watches tab first.
          </div>
        ) : (
          <div style={{ background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 8, overflow: "hidden" }}>
            {watches.map((w) => (
              <label key={w.id} style={{ display: "flex", gap: 10, alignItems: "center",
                padding: "6px 12px", borderBottom: "1px solid rgba(255,255,255,0.04)", cursor: "pointer" }}>
                <input type="checkbox" checked={selectedIds.has(w.id)}
                  onChange={() => toggleSelect(w.id)} style={{ accentColor: "#00f5a0" }} />
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "#fff", flex: 1 }}>{w.label}</span>
                <span style={{ ...LABEL_COL, fontSize: 10 }}>{w.type}</span>
                <span style={{ ...LABEL_COL, fontSize: 10, maxWidth: 180, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {w.chain ? `chain: ${w.chain}` : w.addrHex}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={run} disabled={running || selectedIds.size === 0} style={BTN(true)}>
          {running ? "Searching…" : `Find chains (${selectedIds.size} selected)`}
        </button>
        {running && (
          <button onClick={cancel} style={{ ...BTN(), color: "rgba(255,100,100,0.8)", borderColor: "rgba(255,100,100,0.3)" }}>
            Cancel
          </button>
        )}
        {!running && results.length > 0 && (
          <>
            <button onClick={() => verifyAllChains(results)} disabled={verifying} style={BTN()}>
              {verifying ? "Verifying…" : "Re-verify values"}
            </button>
            <button onClick={() => { setResults([]); setProgress(null); setChainValues({}); }} style={BTN()}>
              Clear
            </button>
          </>
        )}
      </div>

      {/* Progress bar */}
      {progress && !progress.done && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progress.pct}%`,
              background: progress.phase === 0 ? "rgba(100,180,255,0.7)" : "#00f5a0",
              borderRadius: 2, transition: "width 0.3s ease" }} />
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 11, fontFamily: "monospace", color: "rgba(255,255,255,0.4)" }}>
            <span>{statusText}</span>
            {progress.index_size > 0 && (
              <span style={{ color: "rgba(100,180,255,0.6)" }}>
                {(progress.index_size / 1000).toFixed(0)}K ptr entries indexed
              </span>
            )}
          </div>
        </div>
      )}
      {progress?.done && statusText && (
        <div style={{ fontSize: 11, fontFamily: "monospace",
          color: progress.error ? "rgba(255,120,120,0.8)" : "rgba(0,245,160,0.7)" }}>
          {statusText}
          {progress.index_size > 0 && !progress.error && (
            <span style={{ color: "rgba(255,255,255,0.3)", marginLeft: 12 }}>
              ({(progress.index_size / 1000).toFixed(0)}K ptr entries)
            </span>
          )}
        </div>
      )}

      {/* Results — one section per target watch */}
      {filteredResults.map((res) => {
        // We need the original (unfiltered) chain count for the header message
        const originalCount = results.find((r) => r.target_addr === res.target_addr)?.chains.length ?? 0;
        return (
          <div key={res.target_addr} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {/* Target header */}
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ fontFamily: "monospace", fontSize: 12, color: "#fff", fontWeight: 600 }}>
                {res.target_label}
              </span>
              <span style={{ ...LABEL_COL, fontSize: 11 }}>{res.target_addr}</span>
              <span style={{
                fontSize: 10, fontFamily: "monospace",
                color: res.chains.length > 0 ? "#00f5a0" : "rgba(255,255,255,0.2)",
              }}>
                {res.chains.length} chain{res.chains.length !== 1 ? "s" : ""}
              </span>
              {res.hiddenCount > 0 && (
                <span style={{ fontSize: 10, fontFamily: "monospace", color: "rgba(255,120,60,0.7)" }}>
                  +{res.hiddenCount} hidden (large offsets — likely unstable)
                </span>
              )}
            </div>

            {res.chains.length === 0 ? (
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", fontFamily: "monospace", paddingLeft: 12 }}>
                {originalCount > 0
                  ? `All ${originalCount} chain${originalCount !== 1 ? "s" : ""} filtered out — try a larger max struct off value.`
                  : "No static chains found — try larger depth or max back."}
              </div>
            ) : (
              <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(0,245,160,0.1)",
                borderRadius: 8, overflow: "hidden" }}>
                {/* Header */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 100px 45px 90px 70px",
                  gap: 8, padding: "5px 12px", borderBottom: "1px solid rgba(255,255,255,0.07)",
                  fontSize: 10, color: "rgba(255,255,255,0.25)", letterSpacing: 0.8,
                  position: "sticky", top: 0, background: "rgba(12,12,18,0.95)" }}>
                  <span>OFFSETS  (game_base → deref … → value)</span>
                  <span>STATIC PTR</span><span>DEPTH</span><span>VALUE NOW</span><span />
                </div>

                {res.chains.map((chain, ci) => {
                  const cvKey = res.target_addr + "|" + chain.offsets.join(" ");
                  const cv = chainValues[cvKey];
                  return (
                    <div key={ci} style={{ display: "grid", gridTemplateColumns: "1fr 100px 45px 90px 70px",
                      gap: 8, padding: "5px 12px", borderBottom: "1px solid rgba(255,255,255,0.03)",
                      alignItems: "center" }}>

                      {/* Color-coded offset chips */}
                      <div style={{ display: "flex", gap: 3, flexWrap: "wrap", minWidth: 0 }}>
                        {chain.offsets.map((o, oi) => {
                          const v = parseInt(o, 16);
                          // First chip = static module offset (always large, always blue)
                          // Non-first chips = struct field offsets, color by size:
                          //   ≤ 0x80  green   (definitely a struct field)
                          //   ≤ 0x400 cyan    (plausible struct field)
                          //   ≤ 0x1000 amber  (large but possible)
                          //   > 0x1000 red    (suspicious — likely arena hit)
                          const col = oi === 0
                            ? "rgba(100,180,255,0.85)"
                            : v <= 0x80   ? "#00f5a0"
                            : v <= 0x400  ? "rgba(100,220,255,0.85)"
                            : v <= 0x1000 ? "rgba(255,200,60,0.9)"
                            : "rgba(255,100,60,0.9)";
                          const bg = oi === 0
                            ? "rgba(100,180,255,0.08)"
                            : v <= 0x80   ? "rgba(0,245,160,0.06)"
                            : v <= 0x400  ? "rgba(100,220,255,0.06)"
                            : v <= 0x1000 ? "rgba(255,200,60,0.06)"
                            : "rgba(255,100,60,0.08)";
                          const border = oi === 0
                            ? "rgba(100,180,255,0.2)"
                            : v <= 0x80   ? "rgba(0,245,160,0.2)"
                            : v <= 0x400  ? "rgba(100,220,255,0.2)"
                            : v <= 0x1000 ? "rgba(255,200,60,0.25)"
                            : "rgba(255,100,60,0.3)";
                          return (
                            <span key={oi} title={oi === 0 ? "Static module offset" : `Struct field offset: 0x${o} = ${v} bytes`}
                              style={{ fontFamily: "monospace", fontSize: 10,
                                padding: "1px 5px", borderRadius: 3,
                                background: bg, border: `1px solid ${border}`, color: col }}>
                              0x{o}
                            </span>
                          );
                        })}
                      </div>

                      {/* Static anchor (module+offset) */}
                      <span style={{ fontFamily: "monospace", fontSize: 10,
                        color: "rgba(0,245,160,0.8)", overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={chain.module_rel}>
                        +0x{chain.offsets[0]}
                      </span>

                      {/* Depth (number of ptr dereferences) */}
                      <span style={{ fontFamily: "monospace", fontSize: 11,
                        color: "rgba(255,255,255,0.35)", textAlign: "center" }}>
                        {chain.depth}
                      </span>

                      {/* Live verified value */}
                      <span style={{
                        fontFamily: "monospace", fontSize: 12, fontVariantNumeric: "tabular-nums",
                        color: cv === undefined
                          ? "rgba(255,255,255,0.2)"
                          : cv.ok && cv.val !== null ? "#00f5a0"
                          : "rgba(255,80,80,0.7)",
                      }}>
                        {cv === undefined ? (verifying ? "…" : "—")
                          : cv.ok && cv.val !== null ? cv.val : "✗"}
                      </span>

                      <button onClick={() => onLoadChain(chain.offsets)}
                        style={{ ...BTN(cv?.ok ?? false), fontSize: 10, padding: "2px 6px" }}>
                        →Chain
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Modules tab ─────────────────────────────────────────────────────────────

function ModulesTab() {
  const [modules, setModules] = useState<ModuleEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  async function load() {
    setLoading(true);
    try {
      setModules(await invoke<ModuleEntry[]>("mem_get_modules"));
    } catch (e) {
      setModules([]);
    } finally {
      setLoading(false);
    }
  }

  const filtered = filter
    ? modules.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase()))
    : modules;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={load} disabled={loading} style={BTN(true)}>
          {loading ? "Loading…" : "Load modules"}
        </button>
        {modules.length > 0 && (
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            style={{ ...INPUT, width: 160 }}
          />
        )}
        {modules.length > 0 && <span style={{ ...LABEL_COL }}>{filtered.length} / {modules.length} modules</span>}
      </div>

      {filtered.length > 0 && (
        <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, overflow: "hidden", maxHeight: 420, overflowY: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 130px 80px", gap: 8, padding: "6px 12px", borderBottom: "1px solid rgba(255,255,255,0.07)", fontSize: 10, color: "rgba(255,255,255,0.25)", position: "sticky", top: 0, background: "rgba(0,0,0,0.7)" }}>
            <span>MODULE</span><span>BASE</span><span>SIZE</span>
          </div>
          {filtered.map((m) => (
            <div key={m.name + m.base} style={{ display: "grid", gridTemplateColumns: "1fr 130px 80px", gap: 8, padding: "4px 12px", borderBottom: "1px solid rgba(255,255,255,0.03)", alignItems: "center" }}>
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
              <span style={{ ...LABEL_COL, fontSize: 11 }}>{m.base}</span>
              <span style={{ ...LABEL_COL, fontSize: 11 }}>{(m.size / 1024 / 1024).toFixed(1)} MB</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── UE4SS Console tab ───────────────────────────────────────────────────────

function Ue4ssConsoleTab() {
  const [lines, setLines] = useState<string[]>([]);
  const [events, setEvents] = useState<BridgeEventEntry[]>([]);
  const [flags, setFlags] = useState<RuntimeFlags | null>(null);
  const [busy, setBusy] = useState(false);
  const [flagBusy, setFlagBusy] = useState(false);
  const [status, setStatus] = useState<string>("idle");
  const [autoScroll, setAutoScroll] = useState(true);
  const [eventFilter, setEventFilter] = useState("");
  const [eventSourceFilter, setEventSourceFilter] = useState<"all" | "bridge" | "mod">("all");
  const [eventKindFilter, setEventKindFilter] = useState<"all" | "non-ui" | "ui">("all");
  const [objectFilter, setObjectFilter] = useState("");
  const [objectKindFilter, setObjectKindFilter] = useState<"all" | "non-ui" | "ui">("all");
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const eventScrollerRef = useRef<HTMLDivElement | null>(null);
  const objectScrollerRef = useRef<HTMLDivElement | null>(null);

  const pushLine = useCallback((line: string) => {
    setLines((prev) => {
      const next = [...prev, line];
      return next.length > 1500 ? next.slice(next.length - 1500) : next;
    });
  }, []);

  const pushEvent = useCallback((entry: BridgeEventEntry) => {
    setEvents((prev) => {
      const next = [...prev, entry];
      return next.length > 1200 ? next.slice(next.length - 1200) : next;
    });
  }, []);

  const refreshFlags = useCallback(async () => {
    try {
      const data = await invoke<RuntimeFlags>("ue4ss_get_runtime_flags");
      setFlags(data);
    } catch (e) {
      setStatus(`flags read failed: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    invoke<string[]>("ue4ss_get_recent_logs", { limit: 800 })
      .then((rows) => {
        if (!mounted) return;
        setLines(rows ?? []);
      })
      .catch(() => {
        // no-op
      });
    refreshFlags();

    const unlistenLog = listen<string>("ue4ss-log-line", (event) => {
      const line = String(event.payload ?? "").trim();
      if (!line) return;
      pushLine(line);
      if (
        line.includes("[KovaaksBridgeMod]") ||
        line.startsWith("[kmod]") ||
        line.startsWith("[kmod-trace]") ||
        line.startsWith("[kmod-events]")
      ) {
        pushEvent({
          ts: new Date().toLocaleTimeString(),
          source: "mod",
          raw: line,
        });
      } else if (
        line.startsWith("[bridge] runtime flags detected") ||
        line.startsWith("[bridge] runtime flag ")
      ) {
        pushEvent({
          ts: new Date().toLocaleTimeString(),
          source: "bridge",
          raw: line,
        });
      }
    });

    const unlistenBridge = listen<string>("bridge-event", (event) => {
      const payload = String(event.payload ?? "").trim();
      if (!payload) return;
      const line = `[bridge-event] ${payload}`;
      pushLine(line);
    });

    const unlistenBridgeParsed = listen<BridgeParsedEvent>("bridge-parsed-event", (event) => {
      const payload = event.payload;
      if (!payload || !payload.ev) return;
      pushEvent({
        ts: new Date().toLocaleTimeString(),
        source: "bridge",
        raw: payload.raw || "",
        ev: payload.ev,
      });
    });

    return () => {
      mounted = false;
      unlistenLog.then((u) => u());
      unlistenBridge.then((u) => u());
      unlistenBridgeParsed.then((u) => u());
    };
  }, [pushLine, pushEvent, refreshFlags]);

  useEffect(() => {
    if (!autoScroll) return;
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [lines, autoScroll]);

  useEffect(() => {
    if (!autoScroll) return;
    const node = eventScrollerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [events, autoScroll]);

  const objectLines = useMemo(() => {
    return lines.filter((line) => {
      if (!line.startsWith("[kmod-events]")) return false;
      return (
        line.includes("[pe]") ||
        line.includes("[hook_stats]") ||
        line.includes("[hook_kind_hit]") ||
        line.includes("[direct_pull]") ||
        line.includes("[ui_settext]") ||
        line.includes("[ui_field]") ||
        line.includes("[emit]") ||
        line.includes("[emit_i32]") ||
        line.includes("[emit_f32]") ||
        line.includes("[emit_non_ui") ||
        line.includes("[emit_simple]") ||
        line.includes("[obj]")
      );
    });
  }, [lines]);

  const isUiLine = useCallback((line: string) => {
    const l = line.toLowerCase();
    return (
      l.includes("[ui_settext]") ||
      l.includes("[ui_field]") ||
      l.includes("\"ev\":\"ui_") ||
      l.includes("sessionstatistics")
    );
  }, []);

  const filteredObjectLines = useMemo(() => {
    const byKind = objectLines.filter((line) => {
      if (objectKindFilter === "all") return true;
      const ui = isUiLine(line);
      return objectKindFilter === "ui" ? ui : !ui;
    });
    if (!objectFilter.trim()) return byKind;
    const q = objectFilter.toLowerCase();
    return byKind.filter((line) => line.toLowerCase().includes(q));
  }, [objectLines, objectFilter, objectKindFilter, isUiLine]);

  const objectLogTailActive = useMemo(() => {
    return lines.some(
      (line) =>
        line.includes("[ue4ss-log] tailing") &&
        line.includes("KovaaksBridgeMod.events.log")
    );
  }, [lines]);

  useEffect(() => {
    if (!autoScroll) return;
    const node = objectScrollerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [filteredObjectLines, autoScroll]);

  async function setFlag(key: RuntimeFlagKey, enabled: boolean) {
    setFlagBusy(true);
    setStatus(`setting ${key}=${enabled ? 1 : 0}`);
    try {
      await invoke("ue4ss_set_runtime_flag", { key, enabled });
      await invoke("ue4ss_reload_runtime_flags");
      await refreshFlags();
      setStatus(`set ${key}=${enabled ? 1 : 0} (reload requested)`);
    } catch (e) {
      setStatus(`set ${key} failed: ${String(e)}`);
    } finally {
      setFlagBusy(false);
    }
  }

  async function reloadFlagsRuntime() {
    setFlagBusy(true);
    setStatus("requesting runtime flag reload");
    try {
      await invoke("ue4ss_reload_runtime_flags");
      await refreshFlags();
      setStatus("runtime flag reload requested");
    } catch (e) {
      setStatus(`runtime flag reload failed: ${String(e)}`);
    } finally {
      setFlagBusy(false);
    }
  }

  async function diagnose() {
    setStatus("diagnosing...");
    try {
      const [runtime, rows] = await Promise.all([
        invoke<RuntimeFlags>("ue4ss_get_runtime_flags"),
        invoke<string[]>("ue4ss_get_recent_logs", { limit: 500 }),
      ]);
      setFlags(runtime);
      const interesting = (rows ?? []).filter((l) =>
        l.includes("[KovaaksBridgeMod]") ||
        l.includes("ProcessEvent hook") ||
        l.includes("pe flags:")
      );
      for (const line of interesting.slice(-20)) {
        pushEvent({
          ts: new Date().toLocaleTimeString(),
          source: "mod",
          raw: `[diag] ${line}`,
        });
      }
      setStatus(`diagnose ok: ${interesting.length} relevant log lines`);
    } catch (e) {
      setStatus(`diagnose failed: ${String(e)}`);
    }
  }

  async function reinject() {
    setBusy(true);
    setStatus("injecting");
    try {
      await invoke("inject_bridge");
      await refreshFlags();
      setStatus("inject ok");
    } catch (e) {
      setStatus(`inject failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function hotReload() {
    setBusy(true);
      setStatus("sending Ctrl+R");
    try {
      await invoke("ue4ss_trigger_hot_reload");
      setStatus("hot reload sent");
    } catch (e) {
      setStatus(`hot reload failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const filteredEvents = events.filter((e) => {
    if (eventSourceFilter !== "all" && e.source !== eventSourceFilter) return false;
    if (eventKindFilter !== "all") {
      const text = `${e.ev ?? ""} ${e.raw}`.toLowerCase();
      const isUi =
        text.includes("ui_") ||
        text.includes("[ui_settext]") ||
        text.includes("[ui_field]") ||
        text.includes("sessionstatistics");
      if (eventKindFilter === "ui" && !isUi) return false;
      if (eventKindFilter === "non-ui" && isUi) return false;
    }
    if (!eventFilter.trim()) return true;
    const q = eventFilter.toLowerCase();
    return (
      e.raw.toLowerCase().includes(q) ||
      (e.ev?.toLowerCase().includes(q) ?? false) ||
      e.source.toLowerCase().includes(q)
    );
  });

  const eventCounts: Record<string, number> = {};
  for (const e of events) {
    const key = e.ev ?? e.source;
    eventCounts[key] = (eventCounts[key] ?? 0) + 1;
  }
  const topCounts = Object.entries(eventCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  const hookExpectedOn =
    (
      (flags?.enable_pe_hook ?? false) ||
      ((flags?.native_hooks ?? false) && (flags?.allow_unsafe_hooks ?? false)) ||
      (flags?.hook_process_event ?? false) ||
      (flags?.discovery ?? false) ||
      (flags?.log_all_events ?? false) ||
      (flags?.object_debug ?? false) ||
      (flags?.non_ui_probe ?? false) ||
      (flags?.ui_counter_fallback ?? false) ||
      (flags?.score_ui_fallback ?? false)
    ) &&
    !(flags?.disable_pe_hook ?? false) &&
    !(flags?.safe_mode ?? false);
  const nativeHooksBlocked = (flags?.native_hooks ?? false) && !(flags?.allow_unsafe_hooks ?? false);

  const flagRows: Array<{ key: RuntimeFlagKey; label: string; help: string }> = [
    { key: "enable_pe_hook", label: "Enable Event Pipeline", help: "Master gate for event processing." },
    { key: "disable_pe_hook", label: "Force disable PE", help: "Overrides enable when checked." },
    { key: "allow_unsafe_hooks", label: "Allow unsafe hooks", help: "Required gate for unstable hook paths (native/script/detour experiments)." },
    { key: "native_hooks", label: "Native hooks", help: "Register native UFunction post-hooks (requires 'Allow unsafe hooks')." },
    { key: "hook_process_event", label: "Hook ProcessEvent", help: "Install UE4SS ProcessEvent detour (unsafe/experimental)." },
    { key: "ui_settext_hook", label: "UI SetText hook", help: "Hook TextBlock:SetText for UI-derived counters (opt-in)." },
    { key: "discovery", label: "Discovery mode", help: "Extra fallback + unknown-event logging." },
    { key: "log_all_events", label: "Log all events", help: "Write every PE call + emitted event to KovaaksBridgeMod.events.log." },
    { key: "object_debug", label: "Object debug", help: "Capture detailed object/UI-level PE traces to KovaaksBridgeMod.events.log." },
    { key: "non_ui_probe", label: "Non-UI probe", help: "Capture non-UI hook probes and direct pull/property diagnostics without UI spam." },
    { key: "ui_counter_fallback", label: "UI counter fallback", help: "Allow session UI polling to emit pull_* counter metrics." },
    { key: "score_ui_fallback", label: "Score UI fallback", help: "Allow live score text widget fallback when direct score sources are unavailable." },
    { key: "hook_process_internal", label: "Hook ProcessInternal", help: "Unsafe/experimental script callback path. Off by default." },
    { key: "hook_process_local_script", label: "Hook ProcessLocalScript", help: "Unsafe/experimental script callback path. Off by default." },
    { key: "class_probe_hooks", label: "Class probe hooks", help: "Register wide diagnostic UFunction hooks. Can be unstable/heavy." },
    { key: "safe_mode", label: "Safe mode", help: "No resolve, no PE hook (stability test)." },
    { key: "no_rust", label: "No Rust bridge", help: "Disable rust core for isolation." },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button onClick={reinject} disabled={busy} style={BTN(true)}>Inject / Re-sync</button>
        <button onClick={hotReload} disabled={busy} style={BTN()}>Hot Reload (Ctrl+R)</button>
        <button onClick={() => { setLines([]); setEvents([]); }} style={BTN()}>Clear view</button>
        <button onClick={refreshFlags} disabled={flagBusy} style={BTN()}>Refresh flags</button>
        <button onClick={reloadFlagsRuntime} disabled={flagBusy} style={BTN()}>Reload Flags (Runtime)</button>
        <button onClick={diagnose} disabled={flagBusy || busy} style={BTN()}>Diagnose</button>
        <label style={{ ...LABEL_COL, display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          auto-scroll
        </label>
        <span style={{ ...LABEL_COL }}>{status}</span>
      </div>

      <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        <div style={{ ...LABEL_COL, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Runtime Profile</div>
        <div style={{ ...VALUE_COL }}>{flags?.profile ?? "unknown"}</div>
        <div style={{ ...LABEL_COL, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Hook Expected</div>
        <div style={{ ...VALUE_COL, color: hookExpectedOn ? "#00f5a0" : "rgba(255,120,120,0.95)" }}>
          {hookExpectedOn ? "ON" : "OFF"}
        </div>
        <div style={{ ...LABEL_COL, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Native Hooks</div>
        <div style={{ ...VALUE_COL, color: nativeHooksBlocked ? "rgba(255,180,90,0.95)" : "rgba(220,220,220,0.95)" }}>
          {nativeHooksBlocked ? "BLOCKED (unsafe gate off)" : (flags?.native_hooks ? "ENABLED" : "OFF")}
        </div>
        {flagRows.map((row) => (
          <label key={row.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ ...LABEL_COL, fontSize: 11 }}>
              <input
                type="checkbox"
                checked={Boolean(flags?.[row.key])}
                disabled={flagBusy}
                onChange={(e) => setFlag(row.key, e.target.checked)}
                style={{ marginRight: 8 }}
              />
              {row.label}
            </span>
            <span style={{ ...LABEL_COL, fontSize: 10 }}>{row.help}</span>
          </label>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div
          ref={scrollerRef}
          style={{
            background: "rgba(0,0,0,0.45)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            height: 420,
            overflowY: "auto",
            padding: 10,
          }}
        >
          {lines.length === 0 ? (
            <div style={{ ...LABEL_COL }}>No UE4SS logs yet.</div>
          ) : (
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "monospace",
                fontSize: 11,
                lineHeight: 1.4,
                color: "rgba(230,255,240,0.92)",
              }}
            >
              {lines.join("\n")}
            </pre>
          )}
        </div>

        <div style={{ background: "rgba(0,0,0,0.45)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value)}
              placeholder="filter events..."
              style={{ ...INPUT, width: 180 }}
            />
            <select
              value={eventSourceFilter}
              onChange={(e) => setEventSourceFilter(e.target.value as "all" | "bridge" | "mod")}
              style={{ ...INPUT, width: 120, colorScheme: "dark" }}
            >
              <option value="all">all</option>
              <option value="bridge">bridge</option>
              <option value="mod">mod</option>
            </select>
            <select
              value={eventKindFilter}
              onChange={(e) => setEventKindFilter(e.target.value as "all" | "non-ui" | "ui")}
              style={{ ...INPUT, width: 120, colorScheme: "dark" }}
            >
              <option value="all">all kinds</option>
              <option value="non-ui">non-ui</option>
              <option value="ui">ui</option>
            </select>
            <span style={{ ...LABEL_COL }}>{filteredEvents.length} events</span>
          </div>

          {topCounts.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {topCounts.map(([k, v]) => (
                <span key={k} style={{ ...LABEL_COL, fontSize: 10, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 4, padding: "2px 6px" }}>
                  {k}: {v}
                </span>
              ))}
            </div>
          )}

          <div
            ref={eventScrollerRef}
            style={{
              background: "rgba(0,0,0,0.25)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: 6,
              height: 330,
              overflowY: "auto",
              padding: 8,
            }}
          >
            {filteredEvents.length === 0 ? (
              <div style={{ ...LABEL_COL }}>No events yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {filteredEvents.map((e, idx) => (
                  <div key={`${e.ts}-${idx}`} style={{ display: "grid", gridTemplateColumns: "70px 55px 1fr", gap: 8, alignItems: "start", fontFamily: "monospace", fontSize: 11 }}>
                    <span style={{ color: "rgba(255,255,255,0.35)" }}>{e.ts}</span>
                    <span style={{ color: e.source === "bridge" ? "#00f5a0" : "rgba(140,200,255,0.95)" }}>{e.ev ?? e.source}</span>
                    <span style={{ color: "rgba(230,255,240,0.92)", wordBreak: "break-word" }}>{e.raw}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ background: "rgba(0,0,0,0.45)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ ...LABEL_COL, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Object Debug Stream</span>
          <span style={{ ...VALUE_COL, color: objectLogTailActive ? "#00f5a0" : "rgba(255,120,120,0.95)" }}>
            events.log tail: {objectLogTailActive ? "active" : "missing"}
          </span>
          <input
            value={objectFilter}
            onChange={(e) => setObjectFilter(e.target.value)}
            placeholder="filter object lines..."
            style={{ ...INPUT, width: 220 }}
          />
          <select
            value={objectKindFilter}
            onChange={(e) => setObjectKindFilter(e.target.value as "all" | "non-ui" | "ui")}
            style={{ ...INPUT, width: 120, colorScheme: "dark" }}
          >
            <option value="all">all kinds</option>
            <option value="non-ui">non-ui</option>
            <option value="ui">ui</option>
          </select>
          <span style={{ ...LABEL_COL }}>{filteredObjectLines.length} / {objectLines.length} lines</span>
        </div>
        <div
          ref={objectScrollerRef}
          style={{
            background: "rgba(0,0,0,0.25)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 6,
            height: 260,
            overflowY: "auto",
            padding: 8,
          }}
        >
          {filteredObjectLines.length === 0 ? (
            <div style={{ ...LABEL_COL }}>
              No object lines yet. Enable `non_ui_probe`, `log_all_events`, or `object_debug`, then reload runtime flags.
            </div>
          ) : (
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "monospace",
                fontSize: 11,
                lineHeight: 1.35,
                color: "rgba(230,255,240,0.92)",
              }}
            >
              {filteredObjectLines.join("\n")}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function MethodSourcesTab() {
  const [samples, setSamples] = useState<MethodSample[]>([]);
  const [status, setStatus] = useState("idle");
  const [metricFilter, setMetricFilter] = useState("");
  const [methodFilter, setMethodFilter] = useState("");
  const [fnFilter, setFnFilter] = useState("");
  const [originFlagFilter, setOriginFlagFilter] = useState("all");
  const [flagFilters, setFlagFilters] = useState<Record<keyof MethodFlagSnapshot, TriBoolFilter>>(
    () => makeDefaultMethodFlagFilters()
  );
  const [strictNonUiOnly, setStrictNonUiOnly] = useState(false);
  const [pinGoodOnly, setPinGoodOnly] = useState(false);
  const [pinnedKeys, setPinnedKeys] = useState<string[] | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const classHookLastRef = useRef<Map<string, { value: number; ts: number }>>(new Map());

  const parseNumber = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  const parseString = (v: unknown): string => (typeof v === "string" ? v : "");

  const fnLeafName = (fn: string): string => {
    const idx = fn.lastIndexOf(":");
    return idx >= 0 ? fn.slice(idx + 1) : fn;
  };

  const metricFromFn = (fn: string): string => {
    const leaf = fnLeafName(fn).trim();
    if (!leaf) return "class_hook_probe_ret";
    return `class_hook_${leaf.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}`;
  };

  const parseClassHookValue = (obj: Record<string, unknown>, fn: string): { method: string; value: number } | null => {
    const hasRet = parseNumber(obj.has_ret);
    if (hasRet === null || hasRet === 0) return null;
    const retU32 = parseNumber(obj.ret_u32);
    const retI32 = parseNumber(obj.ret_i32);
    const retF32 = parseNumber(obj.ret_f32);
    const leaf = fnLeafName(fn);
    const lower = leaf.toLowerCase();
    // UE4 blueprint-style getter helpers with ValueOr/ValueElse usually expose
    // value through params/out params; ret_* in class_hook_probe is often garbage.
    if (lower.includes("valueor") || lower.includes("valueelse")) {
      return null;
    }
    const boolLike =
      lower.startsWith("is") ||
      lower.startsWith("has") ||
      lower.startsWith("can") ||
      lower.startsWith("should") ||
      lower.startsWith("was") ||
      lower.startsWith("did");
    if (boolLike) {
      if (retU32 !== null) return { method: "class_hook_ret_bool", value: ((retU32 >>> 0) & 1) ? 1 : 0 };
      if (retI32 !== null) return { method: "class_hook_ret_bool", value: (retI32 & 1) ? 1 : 0 };
      return null;
    }
    if (retF32 !== null && Number.isFinite(retF32) && Math.abs(retF32) <= 1_000_000_000) {
      return { method: "class_hook_ret_f32", value: retF32 };
    }
    if (retI32 !== null && Number.isFinite(retI32) && Math.abs(retI32) <= 1_000_000_000) {
      return { method: "class_hook_ret_i32", value: retI32 };
    }
    return null;
  };

  const shouldDropClassHookSample = (metric: string, method: string, fn: string, value: number): boolean => {
    const now = Date.now();
    const key = `${metric}|${method}|${fn}`;
    const prev = classHookLastRef.current.get(key);
    if (prev && Math.abs(prev.value - value) <= 0.000001 && (now - prev.ts) < 250) {
      return true;
    }
    classHookLastRef.current.set(key, { value, ts: now });
    return false;
  };

  const parseRawPayload = useCallback((raw: string, ts: string): MethodSample | null => {
    if (!raw || !raw.trim().startsWith("{")) return null;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const ev = parseString(obj.ev).trim();
    if (!ev) return null;

    const flags = parseMethodFlagSnapshot(obj.flags);
    const origin = parseString(obj.origin) || "unknown";
    const originFlag = parseString(obj.origin_flag) || "unknown";
    const fn = parseString(obj.fn);
    const receiver = parseString(obj.receiver);
    const value = parseNumber(obj.value ?? obj.v);

    let metric = parseString(obj.metric) || ev;
    let method = parseString(obj.method) || "unknown";

    if (ev === "score_source") {
      metric = "pull_score_total";
      method = parseString(obj.source) || method;
    } else if (ev === "class_hook_probe") {
      const parsedRet = parseClassHookValue(obj, fn);
      if (!parsedRet) return null;
      metric = metricFromFn(fn);
      method = parsedRet.method;
      const value = parsedRet.value;
      if (shouldDropClassHookSample(metric, method, fn, value)) return null;
      return {
        idx: -1,
        ts,
        ev,
        metric,
        method,
        fn,
        receiver,
        origin: origin === "unknown" ? "class_hook_probe" : origin,
        originFlag: originFlag === "unknown" ? "class_probe_hooks" : originFlag,
        value,
        flags,
        raw,
      };
    } else if (ev.startsWith("pull_")) {
      // Bridge-forwarded compact pull events often only contain {ev,value} and
      // duplicate richer kmod-events rows. Skip those to avoid duplicate groups
      // with unknown origin/method.
      if (
        method === "unknown" &&
        origin === "unknown" &&
        originFlag === "unknown" &&
        Object.keys(flags).length === 0
      ) {
        return null;
      }
      metric = ev;
      if (method === "unknown") {
        method = origin && origin !== "unknown" ? origin : "pull_event";
      }
    } else if (ev !== "pull_source") {
      return null;
    }

    return {
      idx: -1,
      ts,
      ev,
      metric,
      method,
      fn,
      receiver,
      origin,
      originFlag,
      value,
      flags,
      raw,
    };
  }, []);

  const parseTextLogLine = useCallback((line: string, ts: string): MethodSample | null => {
    if (!line.includes("[kmod-events]")) return null;

    // Example: [kmod-events] [emit_non_ui_f32 #249] ev=pull_score_per_minute value=634.000000
    const emitMatch = line.match(/\[kmod-events\]\s+\[(emit(?:_non_ui)?_[if]\d+(?:\s+#\d+)?)\]\s+ev=(pull_[A-Za-z0-9_]+)\s+value=([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/);
    if (emitMatch) {
      const emitKind = emitMatch[1] ?? "";
      const metric = emitMatch[2] ?? "";
      const value = Number(emitMatch[3]);
      if (!Number.isFinite(value)) return null;
      const nonUi = emitKind.includes("emit_non_ui");
      return {
        idx: -1,
        ts,
        ev: metric,
        metric,
        method: nonUi ? "direct_pull_emit_non_ui" : "emit_event",
        fn: "",
        receiver: "",
        origin: nonUi ? "direct_pull" : "unknown",
        originFlag: nonUi ? "non_ui_probe" : "unknown",
        value,
        flags: {},
        raw: line,
      };
    }

    // Example: [kmod-events] [pull_source] metric=pull_shots_fired_total method=state_get ...
    const sourceMatch = line.match(/\[kmod-events\]\s+\[pull_source\]\s+metric=([A-Za-z0-9_]+)\s+method=([A-Za-z0-9_]+)\s+fn=(.*?)\s+receiver=(.*?)\s+value=([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+origin_flag=([A-Za-z0-9_]+)/);
    if (sourceMatch) {
      const metric = sourceMatch[1] ?? "pull_source";
      const method = sourceMatch[2] ?? "unknown";
      const fn = sourceMatch[3] ?? "";
      const receiver = sourceMatch[4] ?? "";
      const value = Number(sourceMatch[5]);
      const originFlag = sourceMatch[6] ?? "unknown";
      if (!Number.isFinite(value)) return null;
      return {
        idx: -1,
        ts,
        ev: "pull_source",
        metric,
        method,
        fn,
        receiver,
        origin: "direct_pull",
        originFlag,
        value,
        flags: {},
        raw: line,
      };
    }

    return null;
  }, []);

  const parseLinePayload = useCallback((line: string, ts: string): MethodSample | null => {
    const brace = line.indexOf("{");
    if (brace >= 0) {
      const raw = line.slice(brace).trim();
      const parsed = parseRawPayload(raw, ts);
      if (parsed) return parsed;
    }
    return parseTextLogLine(line, ts);
  }, [parseRawPayload, parseTextLogLine]);

  const pushSample = useCallback((sample: MethodSample) => {
    setSamples((prev) => {
      const nextIdx = prev.length > 0 ? prev[prev.length - 1].idx + 1 : 1;
      const next = [...prev, { ...sample, idx: nextIdx }];
      return next.length > 6000 ? next.slice(next.length - 6000) : next;
    });
  }, []);

  useEffect(() => {
    let mounted = true;
    setStatus("loading recent logs");
    invoke<string[]>("ue4ss_get_recent_logs", { limit: 2500 })
      .then((rows) => {
        if (!mounted) return;
        const parsedRows = (rows ?? [])
          .map((line) => parseLinePayload(line, new Date().toLocaleTimeString()))
          .filter((x): x is MethodSample => x !== null);
        setSamples(parsedRows.map((s, i) => ({ ...s, idx: i + 1 })));
        setStatus(`loaded ${parsedRows.length} method samples`);
      })
      .catch((e) => {
        setStatus(`load failed: ${String(e)}`);
      });

    const unlistenLog = listen<string>("ue4ss-log-line", (event) => {
      const line = String(event.payload ?? "").trim();
      if (!line) return;
      const parsed = parseTextLogLine(line, new Date().toLocaleTimeString());
      if (!parsed) return;
      pushSample(parsed);
    });

    const unlistenParsed = listen<BridgeParsedEvent>("bridge-parsed-event", (event) => {
      const payload = event.payload;
      const raw = payload?.raw ?? "";
      if (!raw) return;
      const parsed = parseRawPayload(raw, new Date().toLocaleTimeString());
      if (!parsed) return;
      pushSample(parsed);
    });

    return () => {
      mounted = false;
      unlistenLog.then((u) => u());
      unlistenParsed.then((u) => u());
    };
  }, [parseLinePayload, parseRawPayload, parseTextLogLine, pushSample]);

  const originFlagOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of samples) {
      if (s.originFlag) set.add(s.originFlag);
    }
    return ["all", ...Array.from(set).sort()];
  }, [samples]);

  const filteredSamples = useMemo(() => {
    const mq = metricFilter.trim().toLowerCase();
    const methq = methodFilter.trim().toLowerCase();
    const fnq = fnFilter.trim().toLowerCase();
    return samples.filter((s) => {
      if (mq && !s.metric.toLowerCase().includes(mq)) return false;
      if (methq && !s.method.toLowerCase().includes(methq)) return false;
      if (fnq && !(`${s.fn} ${s.receiver}`).toLowerCase().includes(fnq)) return false;
      if (originFlagFilter !== "all" && s.originFlag !== originFlagFilter) return false;
      for (const { key } of METHOD_FLAG_FILTERS) {
        if (!triBoolMatch(s.flags[key], flagFilters[key])) return false;
      }
      if (strictNonUiOnly) {
        const methodLower = s.method.toLowerCase();
        const originLower = s.origin.toLowerCase();
        const originFlagLower = s.originFlag.toLowerCase();
        const uiTagged =
          methodLower.includes("ui") ||
          originLower.includes("ui") ||
          originFlagLower.includes("ui");
        if (uiTagged) return false;
      }
      return true;
    });
  }, [
    samples,
    metricFilter,
    methodFilter,
    fnFilter,
    originFlagFilter,
    flagFilters,
    strictNonUiOnly,
  ]);

  const filteredSamplesFinal = useMemo(() => {
    if (!pinGoodOnly || !pinnedKeys || pinnedKeys.length === 0) return filteredSamples;
    const keySet = new Set(pinnedKeys);
    return filteredSamples.filter((s) => keySet.has(`${s.metric}|${s.method}|${s.originFlag}|${s.fn}`));
  }, [filteredSamples, pinGoodOnly, pinnedKeys]);

  const grouped = useMemo(() => {
    type Group = {
      key: string;
      metric: string;
      method: string;
      originFlag: string;
      fn: string;
      receiver: string;
      samples: number;
      nonZero: number;
      changes: number;
      zeroFlips: number;
      last: number | null;
      lastPositive: number | null;
      distinct: number;
    };
    const m = new Map<string, Group & { distinctSet: Set<string> }>();
    for (const s of filteredSamplesFinal) {
      const key = `${s.metric}|${s.method}|${s.originFlag}|${s.fn}`;
      const prev = m.get(key);
      if (!prev) {
        const distinctSet = new Set<string>();
        if (s.value !== null) distinctSet.add(s.value.toFixed(6));
        m.set(key, {
          key,
          metric: s.metric,
          method: s.method,
          originFlag: s.originFlag,
          fn: s.fn,
          receiver: s.receiver,
          samples: 1,
          nonZero: s.value !== null && Math.abs(s.value) > 0.000001 ? 1 : 0,
          changes: 0,
          zeroFlips: 0,
          last: s.value,
          lastPositive: s.value !== null && s.value > 0.000001 ? s.value : null,
          distinct: distinctSet.size,
          distinctSet,
        });
        continue;
      }
      prev.samples += 1;
      if (s.value !== null && Math.abs(s.value) > 0.000001) prev.nonZero += 1;
      if (prev.last !== null && s.value !== null && Math.abs(prev.last - s.value) > 0.000001) {
        prev.changes += 1;
      }
      if (prev.last !== null && prev.last > 0.000001 && s.value !== null && Math.abs(s.value) <= 0.000001) {
        prev.zeroFlips += 1;
      }
      prev.last = s.value;
      if (s.value !== null && s.value > 0.000001) {
        prev.lastPositive = s.value;
      }
      if (s.value !== null) prev.distinctSet.add(s.value.toFixed(6));
      prev.distinct = prev.distinctSet.size;
    }

    const classify = (g: Group): "good" | "noisy" | "dead" => {
      if (g.nonZero === 0) return "dead";
      if (g.samples < 4) return "noisy";
      const changeRate = g.samples > 1 ? g.changes / (g.samples - 1) : 0;
      const nonZeroRate = g.samples > 0 ? g.nonZero / g.samples : 0;
      const zeroFlipRate = g.samples > 1 ? g.zeroFlips / (g.samples - 1) : 0;
      if (changeRate >= 0.08 && nonZeroRate >= 0.25 && zeroFlipRate <= 0.55) return "good";
      if (changeRate < 0.02 || nonZeroRate < 0.1) return "dead";
      return "noisy";
    };

    const rows = [...m.values()].map((g) => ({
      ...g,
      verdict: classify(g),
      nonZeroPct: g.samples > 0 ? (g.nonZero / g.samples) * 100 : 0,
      changePct: g.samples > 1 ? (g.changes / (g.samples - 1)) * 100 : 0,
      zeroFlipPct: g.samples > 1 ? (g.zeroFlips / (g.samples - 1)) * 100 : 0,
    }));

    const rank: Record<string, number> = { good: 0, noisy: 1, dead: 2 };
    rows.sort((a, b) => {
      const vr = rank[a.verdict] - rank[b.verdict];
      if (vr !== 0) return vr;
      if (b.changes !== a.changes) return b.changes - a.changes;
      if (b.samples !== a.samples) return b.samples - a.samples;
      return a.metric.localeCompare(b.metric);
    });
    return rows;
  }, [filteredSamplesFinal]);

  const verdictCounts = useMemo(() => {
    const out: Record<"good" | "noisy" | "dead", number> = { good: 0, noisy: 0, dead: 0 };
    for (const g of grouped) out[g.verdict] += 1;
    return out;
  }, [grouped]);

  useEffect(() => {
    if (!autoScroll) return;
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [filteredSamplesFinal, autoScroll]);

  const verdictColor = (v: "good" | "noisy" | "dead") =>
    v === "good" ? "#00f5a0" : v === "noisy" ? "rgba(255,220,120,0.95)" : "rgba(255,110,110,0.95)";

  const pinGoodSources = useCallback(() => {
    const keys = grouped.filter((g) => g.verdict === "good").map((g) => g.key);
    setPinnedKeys(keys);
    setPinGoodOnly(true);
    setStatus(keys.length > 0 ? `pinned ${keys.length} good sources` : "no good sources to pin");
  }, [grouped]);

  const clearPin = useCallback(() => {
    setPinGoodOnly(false);
    setPinnedKeys(null);
    setStatus("pin cleared");
  }, []);

  const recommendedSourceMap = useMemo(() => {
    type GroupRow = (typeof grouped)[number];
    const byMetric = new Map<string, GroupRow>();
    const rank = (g: GroupRow) => {
      const verdictBias = g.verdict === "good" ? 120 : g.verdict === "noisy" ? 40 : 0;
      return verdictBias + (g.changePct * 1.2) + g.nonZeroPct - (g.zeroFlipPct * 0.8) + Math.min(g.samples, 250) * 0.05;
    };
    for (const g of grouped) {
      const prev = byMetric.get(g.metric);
      if (!prev || rank(g) > rank(prev)) {
        byMetric.set(g.metric, g);
      }
    }
    const metrics: Record<string, unknown> = {};
    for (const [metric, g] of byMetric.entries()) {
      metrics[metric] = {
        method: g.method,
        origin_flag: g.originFlag,
        fn: g.fn || null,
        receiver: g.receiver || null,
        verdict: g.verdict,
        samples: g.samples,
        change_pct: Number(g.changePct.toFixed(1)),
        non_zero_pct: Number(g.nonZeroPct.toFixed(1)),
        zero_flip_pct: Number(g.zeroFlipPct.toFixed(1)),
      };
    }
    return {
      generated_at: new Date().toISOString(),
      filters: {
        metric: metricFilter,
        method: methodFilter,
        fn: fnFilter,
        origin_flag: originFlagFilter,
        strict_non_ui_only: strictNonUiOnly,
        flags: flagFilters,
        pin_good_only: pinGoodOnly,
      },
      counts: {
        samples: filteredSamplesFinal.length,
        groups: grouped.length,
        good: verdictCounts.good,
        noisy: verdictCounts.noisy,
        dead: verdictCounts.dead,
      },
      metrics,
    };
  }, [
    grouped,
    verdictCounts,
    metricFilter,
    methodFilter,
    fnFilter,
    originFlagFilter,
    strictNonUiOnly,
    flagFilters,
    pinGoodOnly,
    filteredSamplesFinal.length,
  ]);

  const recommendedJson = useMemo(() => JSON.stringify(recommendedSourceMap, null, 2), [recommendedSourceMap]);

  const copyRecommendedMap = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(recommendedJson);
      setStatus("recommended source map copied");
    } catch (e) {
      setStatus(`copy failed: ${String(e)}`);
    }
  }, [recommendedJson]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={() => setSamples([])} style={BTN()}>Clear</button>
        <button onClick={() => setFlagFilters(makeDefaultMethodFlagFilters())} style={BTN()}>Reset Flag Filters</button>
        <button onClick={pinGoodSources} style={BTN(true)}>Pin Good Sources</button>
        <button onClick={clearPin} style={BTN()}>Clear Pin</button>
        <label style={{ ...LABEL_COL, display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={strictNonUiOnly}
            onChange={(e) => setStrictNonUiOnly(e.target.checked)}
          />
          strict-non-ui-only
        </label>
        <label style={{ ...LABEL_COL, display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={pinGoodOnly}
            onChange={(e) => setPinGoodOnly(e.target.checked)}
          />
          pin-good-only
        </label>
        <label style={{ ...LABEL_COL, display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          auto-scroll
        </label>
        <span style={{ ...LABEL_COL }}>{status}</span>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          value={metricFilter}
          onChange={(e) => setMetricFilter(e.target.value)}
          placeholder="metric filter (e.g. pull_score_per_minute)"
          style={{ ...INPUT, width: 260 }}
        />
        <input
          value={methodFilter}
          onChange={(e) => setMethodFilter(e.target.value)}
          placeholder="method filter (e.g. state_get / ui_poll)"
          style={{ ...INPUT, width: 230 }}
        />
        <input
          value={fnFilter}
          onChange={(e) => setFnFilter(e.target.value)}
          placeholder="fn/receiver filter"
          style={{ ...INPUT, width: 180 }}
        />
        <select
          value={originFlagFilter}
          onChange={(e) => setOriginFlagFilter(e.target.value)}
          style={{ ...INPUT, width: 170, colorScheme: "dark" }}
        >
          {originFlagOptions.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {METHOD_FLAG_FILTERS.map((f) => (
          <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ ...LABEL_COL }}>{f.label}</span>
            <select
              value={flagFilters[f.key]}
              onChange={(e) => {
                const next = e.target.value as TriBoolFilter;
                setFlagFilters((prev) => ({ ...prev, [f.key]: next }));
              }}
              style={{ ...INPUT, width: 70, colorScheme: "dark" }}
            >
              <option value="any">any</option>
              <option value="on">on</option>
              <option value="off">off</option>
            </select>
          </label>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <span style={{ ...LABEL_COL, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 4, padding: "2px 6px" }}>
          samples: {filteredSamplesFinal.length}
        </span>
        <span style={{ ...LABEL_COL, border: "1px solid rgba(120,180,255,0.3)", borderRadius: 4, padding: "2px 6px", color: "rgba(170,220,255,0.95)" }}>
          pinned: {pinGoodOnly ? (pinnedKeys?.length ?? 0) : 0}
        </span>
        <span style={{ ...LABEL_COL, border: "1px solid rgba(0,245,160,0.25)", borderRadius: 4, padding: "2px 6px", color: "#00f5a0" }}>
          good: {verdictCounts.good}
        </span>
        <span style={{ ...LABEL_COL, border: "1px solid rgba(255,220,120,0.3)", borderRadius: 4, padding: "2px 6px", color: "rgba(255,220,120,0.95)" }}>
          noisy: {verdictCounts.noisy}
        </span>
        <span style={{ ...LABEL_COL, border: "1px solid rgba(255,100,100,0.35)", borderRadius: 4, padding: "2px 6px", color: "rgba(255,110,110,0.95)" }}>
          dead: {verdictCounts.dead}
        </span>
      </div>

      <div style={{
        background: "rgba(0,0,0,0.45)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
        overflow: "hidden",
      }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: "170px 130px 120px 1fr 70px 70px 70px 70px 90px 70px",
          gap: 8,
          padding: "6px 10px",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          fontSize: 10,
          color: "rgba(255,255,255,0.3)",
          position: "sticky",
          top: 0,
          background: "rgba(0,0,0,0.8)",
          zIndex: 1,
        }}>
          <span>METRIC</span>
          <span>METHOD</span>
          <span>ORIGIN FLAG</span>
          <span>FN</span>
          <span>SMPL</span>
          <span>CHG%</span>
          <span>NZ%</span>
          <span>ZFLIP%</span>
          <span>LAST</span>
          <span>VERDICT</span>
        </div>
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          {grouped.length === 0 ? (
            <div style={{ ...LABEL_COL, padding: 10 }}>No matching method samples.</div>
          ) : (
            grouped.map((g) => (
              <div
                key={g.key}
                style={{
                  display: "grid",
                  gridTemplateColumns: "170px 130px 120px 1fr 70px 70px 70px 70px 90px 70px",
                  gap: 8,
                  padding: "5px 10px",
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                  fontFamily: "monospace",
                  fontSize: 11,
                  alignItems: "center",
                }}
              >
                <span style={{ color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.metric}</span>
                <span style={{ color: "rgba(180,230,255,0.95)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.method}</span>
                <span style={{ color: "rgba(255,255,255,0.7)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.originFlag}</span>
                <span style={{ color: "rgba(255,255,255,0.55)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={g.fn || g.receiver || ""}>
                  {g.fn || g.receiver || "—"}
                </span>
                <span style={{ color: "rgba(255,255,255,0.85)" }}>{g.samples}</span>
                <span style={{ color: "rgba(255,255,255,0.85)" }}>{g.changePct.toFixed(0)}</span>
                <span style={{ color: "rgba(255,255,255,0.85)" }}>{g.nonZeroPct.toFixed(0)}</span>
                <span style={{ color: "rgba(255,255,255,0.85)" }}>{g.zeroFlipPct.toFixed(0)}</span>
                <span style={{ color: "rgba(255,255,255,0.92)" }}>
                  {(g.lastPositive ?? g.last) === null ? "—" : (g.lastPositive ?? g.last)!.toFixed(3)}
                </span>
                <span style={{ color: verdictColor(g.verdict), fontWeight: 700 }}>{g.verdict}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={{
        background: "rgba(0,0,0,0.45)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <div style={{ ...LABEL_COL }}>
            Recommended source map (best source per metric under current filters)
          </div>
          <button onClick={copyRecommendedMap} style={BTN(true)}>Copy JSON</button>
        </div>
        <div style={{
          maxHeight: 180,
          overflowY: "auto",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 6,
          padding: 8,
          background: "rgba(0,0,0,0.25)",
        }}>
          <pre style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "monospace",
            fontSize: 11,
            lineHeight: 1.35,
            color: "rgba(230,255,240,0.9)",
          }}>
            {recommendedJson}
          </pre>
        </div>
      </div>

      <div style={{
        background: "rgba(0,0,0,0.45)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
        padding: 8,
      }}>
        <div style={{ ...LABEL_COL, marginBottom: 6 }}>
          Raw matching samples (latest 300)
        </div>
        <div
          ref={scrollerRef}
          style={{
            maxHeight: 220,
            overflowY: "auto",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 6,
            padding: 8,
            background: "rgba(0,0,0,0.25)",
          }}
        >
          {filteredSamplesFinal.length === 0 ? (
            <div style={{ ...LABEL_COL }}>No sample rows.</div>
          ) : (
            filteredSamplesFinal.slice(-300).map((s) => (
              <div key={`${s.idx}-${s.raw}`} style={{ display: "grid", gridTemplateColumns: "84px 160px 140px 90px 1fr", gap: 8, fontFamily: "monospace", fontSize: 11, marginBottom: 4 }}>
                <span style={{ color: "rgba(255,255,255,0.4)" }}>{s.ts}</span>
                <span style={{ color: "#fff" }}>{s.metric}</span>
                <span style={{ color: "rgba(170,220,255,0.95)" }}>{s.method}</span>
                <span style={{ color: "rgba(255,255,255,0.85)" }}>{s.value === null ? "—" : s.value.toFixed(3)}</span>
                <span style={{ color: "rgba(230,255,240,0.88)", wordBreak: "break-word" }}>{s.raw}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function ObjectDebugTab() {
  const [rows, setRows] = useState<UiSetTextEvent[]>([]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | UiSetTextEvent["scope"]>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const pushRows = useCallback((incoming: UiSetTextEvent[]) => {
    if (incoming.length === 0) return;
    setRows((prev) => {
      const next = [...prev, ...incoming];
      return next.length > 3000 ? next.slice(next.length - 3000) : next;
    });
  }, []);

  useEffect(() => {
    let mounted = true;
    invoke<string[]>("ue4ss_get_recent_logs", { limit: 1800 })
      .then((lines) => {
        if (!mounted) return;
        const parsed = (lines ?? [])
          .map(parseUiSetTextLine)
          .filter((x): x is UiSetTextEvent => x !== null);
        setRows(parsed.slice(parsed.length - 2000));
      })
      .catch(() => {
        // no-op
      });

    const unlisten = listen<string>("ue4ss-log-line", (event) => {
      const line = String(event.payload ?? "").trim();
      if (!line) return;
      const parsed = parseUiSetTextLine(line);
      if (parsed) pushRows([parsed]);
    });

    return () => {
      mounted = false;
      unlisten.then((u) => u());
    };
  }, [pushRows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (scope !== "all" && r.scope !== scope) return false;
      if (!q) return true;
      return (
        r.className.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q) ||
        r.leaf.toLowerCase().includes(q) ||
        r.root.toLowerCase().includes(q)
      );
    });
  }, [rows, query, scope]);

  const summary = useMemo(() => {
    const byLeaf = new Map<string, { count: number; lastTs: number; scope: UiSetTextEvent["scope"]; className: string }>();
    let session = 0;
    let pause = 0;
    let other = 0;
    for (const r of filtered) {
      if (r.scope === "session") session++;
      else if (r.scope === "pause") pause++;
      else other++;
      const prev = byLeaf.get(r.leaf);
      if (!prev) {
        byLeaf.set(r.leaf, { count: 1, lastTs: r.ts, scope: r.scope, className: r.className });
      } else {
        prev.count += 1;
        prev.lastTs = Math.max(prev.lastTs, r.ts);
      }
    }
    const topLeaves = [...byLeaf.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20);
    return {
      total: filtered.length,
      uniqueLeaves: byLeaf.size,
      session,
      pause,
      other,
      topLeaves,
    };
  }, [filtered]);

  useEffect(() => {
    if (!autoScroll) return;
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [filtered, autoScroll]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ ...LABEL_COL, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>
          Object Debug
        </span>
        <span style={{ ...VALUE_COL }}>rows: {summary.total}</span>
        <span style={{ ...VALUE_COL }}>widgets: {summary.uniqueLeaves}</span>
        <span style={{ ...VALUE_COL, color: "#00f5a0" }}>session: {summary.session}</span>
        <span style={{ ...VALUE_COL, color: "rgba(255,220,120,0.95)" }}>pause: {summary.pause}</span>
        <span style={{ ...VALUE_COL, color: "rgba(180,180,180,0.9)" }}>other: {summary.other}</span>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter class/path/widget..."
          style={{ ...INPUT, width: 260 }}
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as "all" | UiSetTextEvent["scope"])}
          style={{ ...INPUT, width: 120, colorScheme: "dark" }}
        >
          <option value="all">all</option>
          <option value="session">session</option>
          <option value="pause">pause</option>
          <option value="other">other</option>
        </select>
        <label style={{ ...LABEL_COL, display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          auto-scroll
        </label>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 10 }}>
        <div style={{ background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8, minHeight: 420 }}>
          <div style={{ ...LABEL_COL, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Top Widgets</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 50px 70px", gap: 6, ...LABEL_COL, fontSize: 10 }}>
            <span>Widget</span><span>Count</span><span>Scope</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, overflowY: "auto", maxHeight: 360 }}>
            {summary.topLeaves.length === 0 ? (
              <div style={{ ...LABEL_COL }}>No ui_settext rows yet.</div>
            ) : (
              summary.topLeaves.map(([leaf, info]) => (
                <div key={leaf} style={{ display: "grid", gridTemplateColumns: "1fr 50px 70px", gap: 6, alignItems: "center", fontFamily: "monospace", fontSize: 11 }}>
                  <span style={{ color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{leaf}</span>
                  <span style={{ color: "rgba(255,255,255,0.85)" }}>{info.count}</span>
                  <span style={{ color: info.scope === "session" ? "#00f5a0" : info.scope === "pause" ? "rgba(255,220,120,0.95)" : "rgba(200,200,200,0.9)" }}>
                    {info.scope}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div
          ref={scrollerRef}
          style={{
            background: "rgba(0,0,0,0.35)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            padding: 10,
            minHeight: 420,
            maxHeight: 420,
            overflowY: "auto",
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ ...LABEL_COL }}>No structured object rows yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {filtered.map((r, idx) => (
                <div key={`${r.ts}-${idx}`} style={{ display: "grid", gridTemplateColumns: "88px 120px 90px 1fr", gap: 8, fontFamily: "monospace", fontSize: 11 }}>
                  <span style={{ color: "rgba(255,255,255,0.4)" }}>
                    {new Date(r.ts).toLocaleTimeString()}
                  </span>
                  <span style={{ color: "rgba(170,220,255,0.95)" }}>{r.className || "?"}</span>
                  <span style={{ color: r.scope === "session" ? "#00f5a0" : r.scope === "pause" ? "rgba(255,220,120,0.95)" : "rgba(200,200,200,0.9)" }}>
                    {r.leaf}
                  </span>
                  <span style={{ color: "rgba(230,255,240,0.92)", wordBreak: "break-word" }}>{r.path}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main DebugTab ────────────────────────────────────────────────────────────

export function DebugTab() {
  const [sub, setSub] = useState<SubTab>("watches");
  // Offsets loaded from PtrScanTab "→Chain" button; fed into ChainTab
  const [pendingChainOffsets, setPendingChainOffsets] = useState<string[] | null>(null);

  // Allow sub-components to switch tabs via custom event
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<{ tab: SubTab }>).detail.tab;
      setSub(tab);
    };
    window.addEventListener("switch-debug-tab", handler);
    return () => window.removeEventListener("switch-debug-tab", handler);
  }, []);

  function handleLoadChain(offsets: string[]) {
    setPendingChainOffsets(offsets);
    setSub("chain");
  }

  const subTabs: { id: SubTab; label: string }[] = [
    { id: "watches",   label: "Watches" },
    { id: "scanner",   label: "Scanner" },
    { id: "ptrscan",   label: "Ptr Scan" },
    { id: "chain",     label: "Chain" },
    { id: "autochain", label: "Auto Chain" },
    { id: "modules",   label: "Modules" },
    { id: "ue4ss",     label: "UE4SS" },
    { id: "methodsrc", label: "Method Sources" },
    { id: "objdebug",  label: "Object Debug" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {/* Sub-tab bar */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid rgba(255,255,255,0.08)", marginBottom: 20 }}>
        {subTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setSub(t.id)}
            style={{
              background: "none", border: "none",
              borderBottom: sub === t.id ? "2px solid rgba(0,245,160,0.7)" : "2px solid transparent",
              padding: "7px 14px", marginBottom: -1, cursor: "pointer",
              color: sub === t.id ? "#fff" : "rgba(255,255,255,0.35)",
              fontFamily: "monospace", fontSize: 12,
              fontWeight: sub === t.id ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Always mounted — display:none preserves state (scan progress, watch poll, etc.) */}
      <div style={{ display: sub === "watches"   ? undefined : "none" }}><WatchesTab /></div>
      <div style={{ display: sub === "scanner"   ? undefined : "none" }}><ScannerTab /></div>
      <div style={{ display: sub === "ptrscan"   ? undefined : "none" }}><PtrScanTab onLoadChain={handleLoadChain} /></div>
      <div style={{ display: sub === "chain"     ? undefined : "none" }}><ChainTab pendingOffsets={pendingChainOffsets} /></div>
      <div style={{ display: sub === "autochain" ? undefined : "none" }}><AutoChainTab onLoadChain={handleLoadChain} /></div>
      <div style={{ display: sub === "modules"   ? undefined : "none" }}><ModulesTab /></div>
      <div style={{ display: sub === "ue4ss"     ? undefined : "none" }}><Ue4ssConsoleTab /></div>
      <div style={{ display: sub === "methodsrc" ? undefined : "none" }}><MethodSourcesTab /></div>
      <div style={{ display: sub === "objdebug"  ? undefined : "none" }}><ObjectDebugTab /></div>
    </div>
  );
}
