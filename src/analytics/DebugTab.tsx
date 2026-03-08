import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { C } from "../design/tokens";

// ─── Types ────────────────────────────────────────────────────────────────────

type SubTab = "ue4ss" | "objdebug" | "methodsrc";

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
  class_probe_scalar_reads: boolean;
  class_probe_scan_all: boolean;
  allow_unsafe_hooks: boolean;
  native_hooks: boolean;
  hook_process_event: boolean;
  detour_callbacks: boolean;
  direct_pull_invoke: boolean;
  experimental_runtime: boolean;
  ui_settext_hook: boolean;
  ui_widget_probe: boolean;
  in_game_overlay: boolean;
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
  | "class_probe_scalar_reads"
  | "class_probe_scan_all"
  | "allow_unsafe_hooks"
  | "native_hooks"
  | "hook_process_event"
  | "detour_callbacks"
  | "direct_pull_invoke"
  | "experimental_runtime"
  | "ui_settext_hook"
  | "ui_widget_probe"
  | "in_game_overlay";

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

interface StatsPanelUpdatePayload {
  queue_time_remaining?: number | null;
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
  class_probe_scalar_reads?: boolean;
  class_probe_scan_all?: boolean;
  allow_unsafe_hooks?: boolean;
  detour_callbacks?: boolean;
  hook_process_event?: boolean;
  direct_pull_invoke?: boolean;
  experimental_runtime?: boolean;
  native_hooks?: boolean;
  native_hooks_requested?: boolean;
  ui_settext_hook?: boolean;
  ui_widget_probe?: boolean;
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
  { key: "class_probe_scalar_reads", label: "class_probe_scalar_reads" },
  { key: "class_probe_scan_all", label: "class_probe_scan_all" },
  { key: "allow_unsafe_hooks", label: "allow_unsafe_hooks" },
  { key: "detour_callbacks", label: "detour_callbacks" },
  { key: "hook_process_event", label: "hook_process_event" },
  { key: "direct_pull_invoke", label: "direct_pull_invoke" },
  { key: "experimental_runtime", label: "experimental_runtime" },
  { key: "native_hooks", label: "native_hooks" },
  { key: "native_hooks_requested", label: "native_hooks_requested" },
  { key: "ui_settext_hook", label: "ui_settext_hook" },
  { key: "ui_widget_probe", label: "ui_widget_probe" },
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
  tsMs: number;
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
  source: "ui_settext" | "kmod";
  objectId: string;
  objectLabel: string;
  valueText: string | null;
  raw: string;
}

interface ObjectDebugSnapshot {
  id: string;
  label: string;
  className: string;
  scope: UiSetTextEvent["scope"];
  source: UiSetTextEvent["source"];
  count: number;
  lastTs: number;
  lastLeaf: string;
  lastPath: string;
  lastValueText: string | null;
  lastRaw: string;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

const OBJECT_DEBUG_PINNED_KEY = "object_debug_pinned_v1";

function loadObjectDebugPinned(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(OBJECT_DEBUG_PINNED_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, 500);
  } catch {
    return [];
  }
}

function saveObjectDebugPinned(ids: string[]) {
  localStorage.setItem(OBJECT_DEBUG_PINNED_KEY, JSON.stringify(ids.slice(0, 500)));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractKeyValuePairs(text: string): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = [];
  const rx = /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|[^,\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(text)) !== null) {
    const key = match[1]?.trim();
    const value = match[2]?.trim();
    if (!key || !value) continue;
    pairs.push({ key, value });
    if (pairs.length >= 24) break;
  }
  return pairs;
}

function normalizeDebugTag(tag: string): string {
  const lower = tag.trim().toLowerCase();
  if (!lower) return "";
  const hash = lower.indexOf(" #");
  if (hash > 0) return lower.slice(0, hash);
  return lower;
}

function extractFieldValue(text: string, key: string): string | null {
  const marker = `${key}=`;
  const start = text.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  while (i < text.length && text[i] === " ") i += 1;
  if (i >= text.length) return null;
  const tail = text.slice(i);
  const next = tail.search(/\s+[A-Za-z_][A-Za-z0-9_]*=/);
  const raw = (next >= 0 ? tail.slice(0, next) : tail).trim();
  if (!raw) return null;
  return raw.replace(/^"+|"+$/g, "").trim();
}

function normalizeFnValue(v: string | null): string | null {
  if (!v) return null;
  let out = v.trim();
  if (!out) return null;
  if (out.toLowerCase().startsWith("function ")) {
    out = out.slice("function ".length).trim();
  }
  return out || null;
}

function classNameFromFn(fnPath: string | null): string {
  if (!fnPath) return "";
  const colon = fnPath.indexOf(":");
  const beforeColon = colon >= 0 ? fnPath.slice(0, colon) : fnPath;
  const dot = beforeColon.lastIndexOf(".");
  if (dot >= 0 && dot < beforeColon.length - 1) {
    return beforeColon.slice(dot + 1).trim();
  }
  const slash = beforeColon.lastIndexOf("/");
  if (slash >= 0 && slash < beforeColon.length - 1) {
    return beforeColon.slice(slash + 1).trim();
  }
  return "";
}

const SYSTEM_ONLY_TAGS = new Set<string>([
  "kovaaksbridgemod",
  "kmod",
  "heartbeat",
  "hook_stats",
  "class_resolve",
  "direct_invoke_recover",
  "direct_invoke_fault",
  "pe_seen",
  "pe_new",
  "fallback_new",
  "in_game_overlay",
]);

function objectIdentityFromFields(
  source: UiSetTextEvent["source"],
  className: string,
  leaf: string,
  path: string,
  fields: Array<{ key: string; value: string }>,
): { id: string; label: string } {
  const base = className || leaf || "unknown";
  const fieldMap = new Map(fields.map((kv) => [kv.key.toLowerCase(), kv.value]));
  const preferredRef =
    fieldMap.get("ctx")
    ?? fieldMap.get("path")
    ?? fieldMap.get("caller_ptr")
    ?? fieldMap.get("caller")
    ?? fieldMap.get("receiver_ptr")
    ?? fieldMap.get("receiver")
    ?? fieldMap.get("object")
    ?? fieldMap.get("obj")
    ?? fieldMap.get("manager")
    ?? fieldMap.get("fn");

  if (source === "ui_settext") {
    return {
      id: `ui:${base}|${path}`,
      label: `${base} ${path}`.trim(),
    };
  }

  if (preferredRef) {
    return {
      id: `kmod:${base}|${preferredRef}`,
      label: `${base} ${preferredRef}`.trim(),
    };
  }

  return {
    id: `kmod:${base}|${leaf}`,
    label: `${base} ${leaf}`.trim(),
  };
}

function buildObjectDebugSnapshots(rows: UiSetTextEvent[]): Record<string, ObjectDebugSnapshot> {
  const out: Record<string, ObjectDebugSnapshot> = {};
  for (const row of rows) {
    const existing = out[row.objectId];
    if (!existing) {
      out[row.objectId] = {
        id: row.objectId,
        label: row.objectLabel,
        className: row.className,
        scope: row.scope,
        source: row.source,
        count: 1,
        lastTs: row.ts,
        lastLeaf: row.leaf,
        lastPath: row.path,
        lastValueText: row.valueText,
        lastRaw: row.raw,
      };
      continue;
    }
    const isNewer = row.ts >= existing.lastTs;
    out[row.objectId] = {
      ...existing,
      count: existing.count + 1,
      lastTs: Math.max(existing.lastTs, row.ts),
      ...(isNewer
        ? {
            label: row.objectLabel,
            className: row.className,
            scope: row.scope,
            source: row.source,
            lastLeaf: row.leaf,
            lastPath: row.path,
            lastValueText: row.valueText,
            lastRaw: row.raw,
          }
        : null),
    };
  }
  return out;
}

function parseUiSetTextLine(line: string): UiSetTextEvent | null {
  const raw = line.trim();
  if (!raw) return null;

  const kmodPrefixMatch = raw.match(/^\[(kmod(?:-events|-trace)?)\]\s*/i);
  if (!kmodPrefixMatch) return null;

  const rest = raw.slice(kmodPrefixMatch[0].length).trim();
  if (!rest) return null;

  const taggedMatch = rest.match(/^\[([^\]]+)\]\s*(.*)$/);
  const tag = (taggedMatch?.[1] ?? "").trim();
  const normalizedTag = normalizeDebugTag(tag);
  const payload = (taggedMatch?.[2] ?? rest).trim();

  if (tag.toLowerCase() === "ui_settext" && payload.startsWith("ctx=")) {
    const remainder = payload.slice(4).trim();
    const textMarker = remainder.indexOf(" text=");
    const ctx = (textMarker >= 0 ? remainder.slice(0, textMarker) : remainder).trim();
    const textValue = (textMarker >= 0 ? remainder.slice(textMarker + 6) : "").trim();
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
    const identity = objectIdentityFromFields("ui_settext", className, leaf, path, []);

    return {
      ts: Date.now(),
      className,
      path,
      leaf,
      scope,
      root,
      source: "ui_settext",
      objectId: identity.id,
      objectLabel: identity.label,
      valueText: textValue || null,
      raw,
    };
  }

  const text = payload || rest;
  const keyValues = extractKeyValuePairs(text);

  const parsedFn = normalizeFnValue(extractFieldValue(text, "fn"));
  const parsedCtx = extractFieldValue(text, "ctx");
  const parsedCaller = extractFieldValue(text, "caller");
  const parsedFnPtr = extractFieldValue(text, "fn_ptr");
  const parsedCtxPtr = extractFieldValue(text, "ctx_ptr") ?? extractFieldValue(text, "caller_ptr");

  const enrichedFields: Array<{ key: string; value: string }> = [...keyValues];
  if (parsedFn) enrichedFields.push({ key: "fn", value: parsedFn });
  if (parsedCtx) enrichedFields.push({ key: "ctx", value: parsedCtx });
  if (parsedCaller) enrichedFields.push({ key: "caller", value: parsedCaller });
  if (parsedFnPtr) enrichedFields.push({ key: "fn_ptr", value: parsedFnPtr });
  if (parsedCtxPtr) enrichedFields.push({ key: "ctx_ptr", value: parsedCtxPtr });

  if (SYSTEM_ONLY_TAGS.has(normalizedTag)) {
    return null;
  }

  const preferredKeys = [
    "value",
    "score",
    "kills",
    "shots",
    "shotshit",
    "shotsfired",
    "seconds",
    "spm",
    "accuracy",
    "damage_done",
    "damage_possible",
    "time_remaining",
  ];
  const preferred = enrichedFields.find((kv) => preferredKeys.includes(kv.key.toLowerCase()));
  const fnMatch = text.match(/\bfn=([^\s]+)/);
  const classMatch = text.match(/\b([A-Za-z_][A-Za-z0-9_]*)(?::|\.)[A-Za-z0-9_]+/);
  const className = classNameFromFn(parsedFn) || fnMatch?.[1] || classMatch?.[1] || "";
  const leaf = parsedFn
    ? (parsedFn.includes(":") ? parsedFn.slice(parsedFn.lastIndexOf(":") + 1).trim() : parsedFn)
    : (tag || className || "kmod");
  let scope: UiSetTextEvent["scope"] = "other";
  if (/session|challenge/i.test(text)) {
    scope = "session";
  } else if (/pause/i.test(text)) {
    scope = "pause";
  }
  const identity = objectIdentityFromFields("kmod", className, leaf, text, enrichedFields);

  if (!parsedFn && !parsedCtx && !parsedCaller && !parsedCtxPtr) {
    return null;
  }

  return {
    ts: Date.now(),
    className,
    path: text,
    leaf,
    scope,
    root: "",
    source: "kmod",
    objectId: identity.id,
    objectLabel: identity.label,
    valueText: preferred ? preferred.value : (enrichedFields[0]?.value ?? null),
    raw,
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
    class_probe_scalar_reads: readBool("class_probe_scalar_reads"),
    class_probe_scan_all: readBool("class_probe_scan_all"),
    allow_unsafe_hooks: readBool("allow_unsafe_hooks"),
    detour_callbacks: readBool("detour_callbacks"),
    hook_process_event: readBool("hook_process_event"),
    direct_pull_invoke: readBool("direct_pull_invoke"),
    experimental_runtime: readBool("experimental_runtime"),
    native_hooks: readBool("native_hooks"),
    native_hooks_requested: readBool("native_hooks_requested"),
    ui_settext_hook: readBool("ui_settext_hook"),
    ui_widget_probe: readBool("ui_widget_probe"),
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

const LABEL_COL: React.CSSProperties = { color: C.textMuted, fontSize: 11, fontFamily: "monospace" };
const VALUE_COL: React.CSSProperties = { fontFamily: "monospace", fontSize: 12, fontVariantNumeric: "tabular-nums" };

const INPUT: React.CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: 4, color: C.text, fontFamily: "monospace", fontSize: 12,
  padding: "3px 7px", outline: "none",
};

const BTN = (accent = false): React.CSSProperties => ({
  background: accent ? C.accentDim : C.surface,
  border: `1px solid ${accent ? C.accentBorder : C.border}`,
  borderRadius: 4, color: accent ? C.accent : C.textSub,
  fontFamily: "monospace", fontSize: 11, padding: "3px 10px",
  cursor: "pointer", flexShrink: 0,
});

// ─── AimMod Runtime Console tab ──────────────────────────────────────────────

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
  const lastQremRef = useRef<number | null>(null);
  const lastChRef = useRef<number | null>(null);

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

    const unlistenBridgeMetric = listen<BridgeParsedEvent>("bridge-metric", (event) => {
      const payload = event.payload;
      if (!payload || !payload.ev) return;

      if (
        payload.ev === "pull_queue_time_remaining"
        || payload.ev === "challenge_queue_time_remaining"
        || payload.ev === "queue_time_remaining"
        || payload.ev === "qrem"
      ) {
        const qrem = payload.value;
        if (typeof qrem !== "number" || !Number.isFinite(qrem)) return;
        const prev = lastQremRef.current;
        if (prev !== null && Math.abs(prev - qrem) <= 0.0001) return;
        lastQremRef.current = qrem;
        pushEvent({
          ts: new Date().toLocaleTimeString(),
          source: "bridge",
          raw: `[bridge-metric] qrem=${qrem.toFixed(3)}`,
          ev: "qrem",
        });
        return;
      }

      if (
        payload.ev === "pull_is_in_challenge"
        || payload.ev === "is_in_challenge"
        || payload.ev === "ch"
      ) {
        const rawValue = payload.value;
        if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) return;
        const ch = rawValue >= 0.5 ? 1 : 0;
        if (lastChRef.current === ch) return;
        lastChRef.current = ch;
        pushEvent({
          ts: new Date().toLocaleTimeString(),
          source: "bridge",
          raw: `[bridge-metric] ch=${ch}`,
          ev: "ch",
        });
      }
    });

    const unlistenChallengeStart = listen("challenge-start", () => {
      lastChRef.current = 1;
      pushEvent({
        ts: new Date().toLocaleTimeString(),
        source: "bridge",
        raw: "[challenge-start]",
        ev: "challenge_start",
      });
    });

    const unlistenChallengeEnd = listen("challenge-end", () => {
      lastChRef.current = 0;
      pushEvent({
        ts: new Date().toLocaleTimeString(),
        source: "bridge",
        raw: "[challenge-end]",
        ev: "challenge_end",
      });
    });

    const unlistenStatsPanel = listen<StatsPanelUpdatePayload>("stats-panel-update", (event) => {
      const qrem = event.payload?.queue_time_remaining;
      if (typeof qrem !== "number" || !Number.isFinite(qrem)) return;
      const prev = lastQremRef.current;
      if (prev !== null && Math.abs(prev - qrem) <= 0.0001) return;
      lastQremRef.current = qrem;
      pushEvent({
        ts: new Date().toLocaleTimeString(),
        source: "bridge",
        raw: `[stats-panel-update] queue_time_remaining=${qrem.toFixed(3)}`,
        ev: "pull_queue_time_remaining",
      });
    });

    return () => {
      mounted = false;
      unlistenLog.then((u) => u());
      unlistenBridge.then((u) => u());
      unlistenBridgeParsed.then((u) => u());
      unlistenBridgeMetric.then((u) => u());
      unlistenChallengeStart.then((u) => u());
      unlistenChallengeEnd.then((u) => u());
      unlistenStatsPanel.then((u) => u());
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
      const lower = line.toLowerCase();
      const isKmodLine =
        line.startsWith("[kmod-events]") ||
        line.startsWith("[kmod]") ||
        line.startsWith("[kmod-trace]");

      if (isKmodLine) {
        return true;
      }

      if (!line.startsWith("[bridge-event]")) return false;
      return (
        lower.includes("\"ev\":\"pull_source\"") &&
        (lower.includes("scenariomanager") ||
          lower.includes("performanceindicatorsstatereceiver") ||
          lower.includes("scenario_state_receiver"))
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
    { key: "hook_process_event", label: "Hook ProcessEvent", help: "Install ProcessEvent detour (unsafe/experimental)." },
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
    { key: "class_probe_scalar_reads", label: "Class probe scalar reads", help: "Allow class probe paths to read/emit scalar numeric values." },
    { key: "class_probe_scan_all", label: "Class probe scan-all", help: "Broad class-probe registration sweep; high overhead and instability risk." },
    { key: "direct_pull_invoke", label: "Direct pull invoke", help: "Enable direct non-UI invocation/poll path for pull_* metrics." },
    { key: "detour_callbacks", label: "Detour callbacks", help: "Enable ProcessEvent detour callback dispatch (same underlying gate as Hook ProcessEvent)." },
    { key: "experimental_runtime", label: "Experimental runtime", help: "Master gate for detour/class-probe/direct-pull experimental paths." },
    { key: "safe_mode", label: "Safe mode", help: "No resolve, no PE hook (stability test)." },
    { key: "ui_widget_probe", label: "UI widget probe", help: "Enable explicit CreateWidget/AddToViewport probe diagnostics." },
    { key: "in_game_overlay", label: "In-game HUD", help: "Create and update the in-game AimMod HUD widget (standard path)." },
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
            <div style={{ ...LABEL_COL }}>No AimMod runtime logs yet.</div>
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

  const parseRawPayload = useCallback((raw: string, ts: string, tsMs: number): MethodSample | null => {
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
        tsMs,
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
      metric = ev;
      if (method === "unknown") {
        method = origin && origin !== "unknown" ? origin : "pull_event";
      }
    } else if (ev === "pull_retry") {
      const status = parseString(obj.status) || "unknown";
      const retryMethod = parseString(obj.retry_method) || parseString(obj.pull_method) || method;
      metric = (parseString(obj.metric) || metric || "pull_retry").trim();
      method = `pull_retry:${retryMethod}:${status}`;
    } else if (ev !== "pull_source") {
      return null;
    }

    return {
      idx: -1,
      ts,
      tsMs,
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

  const parseTextLogLine = useCallback((line: string, ts: string, tsMs: number): MethodSample | null => {
    if (!line.includes("[kmod-events]")) return null;

    const parseKvField = (text: string, key: string): string => {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(`${escaped}=([\\s\\S]*?)(?=\\s+[A-Za-z_][A-Za-z0-9_]*=|$)`);
      const m = text.match(rx);
      return (m?.[1] ?? "").trim();
    };

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
        tsMs,
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

    if (line.includes("[pull_source")) {
      const metric = parseKvField(line, "metric") || "pull_source";
      const method = parseKvField(line, "method") || "unknown";
      const fn = parseKvField(line, "fn") || parseKvField(line, "source") || "";
      const receiver = parseKvField(line, "receiver") || parseKvField(line, "source") || "";
      const value = Number(parseKvField(line, "value"));
      const origin = parseKvField(line, "origin") || (method.includes("ui") ? "ui_poll" : "direct_pull");
      const originFlag = parseKvField(line, "origin_flag") || (method.includes("ui") ? "ui_counter_fallback" : "non_ui_probe");
      if (!Number.isFinite(value)) return null;
      return {
        idx: -1,
        ts,
        tsMs,
        ev: "pull_source",
        metric,
        method,
        fn,
        receiver,
        origin,
        originFlag,
        value,
        flags: {},
        raw: line,
      };
    }

    if (line.includes("[pull_retry")) {
      const metric = parseKvField(line, "metric") || "pull_retry";
      const pullMethod = parseKvField(line, "method") || "unknown";
      const status = parseKvField(line, "status") || "unknown";
      const attemptRaw = parseKvField(line, "attempt");
      const attemptNum = Number((attemptRaw.split("/")[0] ?? "").trim());
      const fn = parseKvField(line, "fn");
      const receiver = parseKvField(line, "receiver");
      const originFlag = parseKvField(line, "origin_flag") || "non_ui_probe";
      return {
        idx: -1,
        ts,
        tsMs,
        ev: "pull_retry",
        metric,
        method: `pull_retry:${pullMethod}:${status}`,
        fn,
        receiver,
        origin: "direct_pull",
        originFlag,
        value: Number.isFinite(attemptNum) ? attemptNum : null,
        flags: {},
        raw: line,
      };
    }

    return null;
  }, []);

  const parseLinePayload = useCallback((line: string, ts: string, tsMs: number): MethodSample | null => {
    const brace = line.indexOf("{");
    if (brace >= 0) {
      const raw = line.slice(brace).trim();
      const parsed = parseRawPayload(raw, ts, tsMs);
      if (parsed) return parsed;
    }
    return parseTextLogLine(line, ts, tsMs);
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
          .map((line) => {
            const now = Date.now();
            return parseLinePayload(line, new Date(now).toLocaleTimeString(), now);
          })
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
      const now = Date.now();
      const parsed = parseTextLogLine(line, new Date(now).toLocaleTimeString(), now);
      if (!parsed) return;
      pushSample(parsed);
    });

    const unlistenParsed = listen<BridgeParsedEvent>("bridge-parsed-event", (event) => {
      const payload = event.payload;
      const raw = payload?.raw ?? "";
      if (!raw) return;
      const now = Date.now();
      const parsed = parseRawPayload(raw, new Date(now).toLocaleTimeString(), now);
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
      lastTsMs: number;
      distinct: number;
    };
    const m = new Map<string, Group & { distinctSet: Set<string> }>();
    for (const s of filteredSamplesFinal) {
      const sampleTsMs = Number.isFinite(s.tsMs) ? s.tsMs : 0;
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
          lastTsMs: sampleTsMs,
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
      if (sampleTsMs > prev.lastTsMs) {
        prev.lastTsMs = sampleTsMs;
      }
      if (s.value !== null) prev.distinctSet.add(s.value.toFixed(6));
      prev.distinct = prev.distinctSet.size;
    }

    const classify = (g: Group): "good" | "noisy" | "dead" => {
      const nowMs = Date.now();
      const ageMs = g.lastTsMs > 0 ? Math.max(0, nowMs - g.lastTsMs) : Number.POSITIVE_INFINITY;
      const staleMs = 15_000;
      const isRecent = ageMs <= staleMs;
      if (g.nonZero === 0) return isRecent ? "noisy" : "dead";
      if (g.samples < 4) return "noisy";
      const changeRate = g.samples > 1 ? g.changes / (g.samples - 1) : 0;
      const nonZeroRate = g.samples > 0 ? g.nonZero / g.samples : 0;
      const zeroFlipRate = g.samples > 1 ? g.zeroFlips / (g.samples - 1) : 0;
      if (changeRate >= 0.08 && nonZeroRate >= 0.25 && zeroFlipRate <= 0.55) return "good";
      if (changeRate < 0.02 || nonZeroRate < 0.1) return isRecent ? "noisy" : "dead";
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
  const [objects, setObjects] = useState<Record<string, ObjectDebugSnapshot>>({});
  const [pinnedObjectIds, setPinnedObjectIds] = useState<string[]>(() => loadObjectDebugPinned());
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | UiSetTextEvent["scope"]>("all");
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [selectedRowToken, setSelectedRowToken] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const rowToken = useCallback((r: UiSetTextEvent) => `${r.ts}|${r.objectId}|${r.raw}`, []);

  useEffect(() => {
    saveObjectDebugPinned(pinnedObjectIds);
  }, [pinnedObjectIds]);

  const pushRows = useCallback((incoming: UiSetTextEvent[]) => {
    if (incoming.length === 0) return;
    setRows((prev) => {
      const next = [...prev, ...incoming];
      return next.length > 3000 ? next.slice(next.length - 3000) : next;
    });
    setObjects((prev) => {
      const next: Record<string, ObjectDebugSnapshot> = { ...prev };
      for (const row of incoming) {
        const existing = next[row.objectId];
        if (!existing) {
          next[row.objectId] = {
            id: row.objectId,
            label: row.objectLabel,
            className: row.className,
            scope: row.scope,
            source: row.source,
            count: 1,
            lastTs: row.ts,
            lastLeaf: row.leaf,
            lastPath: row.path,
            lastValueText: row.valueText,
            lastRaw: row.raw,
          };
          continue;
        }
        const isNewer = row.ts >= existing.lastTs;
        next[row.objectId] = {
          ...existing,
          count: existing.count + 1,
          lastTs: Math.max(existing.lastTs, row.ts),
          ...(isNewer
            ? {
                label: row.objectLabel,
                className: row.className,
                scope: row.scope,
                source: row.source,
                lastLeaf: row.leaf,
                lastPath: row.path,
                lastValueText: row.valueText,
                lastRaw: row.raw,
              }
            : null),
        };
      }

      const keys = Object.keys(next);
      if (keys.length > 2400) {
        const pinned = new Set(pinnedObjectIds);
        const removable = keys
          .filter((id) => !pinned.has(id))
          .sort((a, b) => next[a].lastTs - next[b].lastTs);
        const toRemove = Math.min(removable.length, keys.length - 2200);
        for (let idx = 0; idx < toRemove; idx += 1) {
          delete next[removable[idx]];
        }
      }

      return next;
    });
  }, [pinnedObjectIds]);

  useEffect(() => {
    let mounted = true;
    invoke<string[]>("ue4ss_get_recent_logs", { limit: 1800 })
      .then((lines) => {
        if (!mounted) return;
        const parsed = (lines ?? [])
          .map(parseUiSetTextLine)
          .filter((x): x is UiSetTextEvent => x !== null);
        const seed = parsed.slice(parsed.length - 2000);
        setRows(seed);
        setObjects(buildObjectDebugSnapshots(seed));
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

  const pinnedSet = useMemo(() => new Set(pinnedObjectIds), [pinnedObjectIds]);

  const filteredBase = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (scope !== "all" && r.scope !== scope) return false;
      if (!q) return true;
      return (
        r.className.toLowerCase().includes(q)
        || r.path.toLowerCase().includes(q)
        || r.leaf.toLowerCase().includes(q)
        || r.root.toLowerCase().includes(q)
        || r.objectLabel.toLowerCase().includes(q)
      );
    });
  }, [rows, query, scope]);

  const objectList = useMemo(() => {
    const q = query.trim().toLowerCase();
    const arr = Object.values(objects).filter((o) => {
      if (scope !== "all" && o.scope !== scope) return false;
      if (!q) return true;
      return (
        o.label.toLowerCase().includes(q)
        || o.className.toLowerCase().includes(q)
        || o.lastLeaf.toLowerCase().includes(q)
        || o.lastPath.toLowerCase().includes(q)
        || o.lastRaw.toLowerCase().includes(q)
      );
    });
    arr.sort((a, b) => {
      const pinDelta = Number(pinnedSet.has(b.id)) - Number(pinnedSet.has(a.id));
      if (pinDelta !== 0) return pinDelta;
      if (b.lastTs !== a.lastTs) return b.lastTs - a.lastTs;
      if (b.count !== a.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    });
    return arr;
  }, [objects, pinnedSet, query, scope]);

  useEffect(() => {
    if (!selectedObjectId) return;
    if (!objectList.some((o) => o.id === selectedObjectId)) {
      setSelectedObjectId(null);
      setSelectedRowToken(null);
    }
  }, [objectList, selectedObjectId]);

  const filteredRows = useMemo(() => {
    if (!selectedObjectId) return filteredBase;
    return filteredBase.filter((r) => r.objectId === selectedObjectId);
  }, [filteredBase, selectedObjectId]);

  const summary = useMemo(() => {
    let session = 0;
    let pause = 0;
    let other = 0;
    for (const r of filteredBase) {
      if (r.scope === "session") session++;
      else if (r.scope === "pause") pause++;
      else other++;
    }
    return {
      totalRows: filteredRows.length,
      totalObjects: objectList.length,
      session,
      pause,
      other,
      pinned: pinnedObjectIds.length,
    };
  }, [filteredBase, filteredRows.length, objectList.length, pinnedObjectIds.length]);

  const selectedSnapshot = useMemo(() => {
    if (!selectedObjectId) return null;
    return objects[selectedObjectId] ?? null;
  }, [objects, selectedObjectId]);

  const selectedRow = useMemo(() => {
    if (filteredRows.length === 0) return null;
    if (!selectedRowToken) return filteredRows[filteredRows.length - 1];
    return filteredRows.find((r) => rowToken(r) === selectedRowToken) ?? filteredRows[filteredRows.length - 1];
  }, [filteredRows, rowToken, selectedRowToken]);

  const selectedPairs = useMemo(() => {
    const raw = selectedRow?.raw ?? selectedSnapshot?.lastRaw ?? "";
    if (!raw) return [];
    return extractKeyValuePairs(raw);
  }, [selectedRow, selectedSnapshot]);

  const togglePinned = useCallback((id: string) => {
    setPinnedObjectIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((v) => v !== id);
      }
      return [id, ...prev].slice(0, 500);
    });
  }, []);

  const pinSelected = useCallback(() => {
    if (!selectedObjectId) return;
    setPinnedObjectIds((prev) => (prev.includes(selectedObjectId) ? prev : [selectedObjectId, ...prev].slice(0, 500)));
  }, [selectedObjectId]);

  const unpinSelected = useCallback(() => {
    if (!selectedObjectId) return;
    setPinnedObjectIds((prev) => prev.filter((id) => id !== selectedObjectId));
  }, [selectedObjectId]);

  useEffect(() => {
    if (!autoScroll) return;
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [filteredRows, autoScroll]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ ...LABEL_COL, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>
          Object Debug
        </span>
        <span style={{ ...VALUE_COL }}>rows: {summary.totalRows}</span>
        <span style={{ ...VALUE_COL }}>objects: {summary.totalObjects}</span>
        <span style={{ ...VALUE_COL, color: "rgba(255,245,170,0.95)" }}>pinned: {summary.pinned}</span>
        <span style={{ ...VALUE_COL, color: "rgba(170,220,255,0.95)" }}>
          selected: {selectedSnapshot?.label ?? "none"}
        </span>
        <span style={{ ...VALUE_COL, color: "#00f5a0" }}>session: {summary.session}</span>
        <span style={{ ...VALUE_COL, color: "rgba(255,220,120,0.95)" }}>pause: {summary.pause}</span>
        <span style={{ ...VALUE_COL, color: "rgba(180,180,180,0.9)" }}>other: {summary.other}</span>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter class/path/object/event..."
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
        <button
          onClick={() => {
            setSelectedObjectId(null);
            setSelectedRowToken(null);
          }}
          style={BTN()}
        >
          clear selection
        </button>
        <button onClick={pinSelected} style={BTN()} disabled={!selectedObjectId}>pin selected</button>
        <button onClick={unpinSelected} style={BTN()} disabled={!selectedObjectId}>unpin selected</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 10 }}>
        <div style={{ background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8, minHeight: 420 }}>
          <div style={{ ...LABEL_COL, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Objects</div>
          <div style={{ display: "grid", gridTemplateColumns: "24px 1fr 50px 70px", gap: 6, ...LABEL_COL, fontSize: 10 }}>
            <span>★</span><span>Object</span><span>Count</span><span>Scope</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, overflowY: "auto", maxHeight: 360 }}>
            {objectList.length === 0 ? (
              <div style={{ ...LABEL_COL }}>No object debug rows yet.</div>
            ) : (
              objectList.slice(0, 200).map((obj) => {
                const isSelected = selectedObjectId === obj.id;
                const isPinned = pinnedSet.has(obj.id);
                return (
                  <div
                    key={obj.id}
                    style={{
                    display: "grid",
                      gridTemplateColumns: "24px 1fr 50px 70px",
                    gap: 6,
                    alignItems: "center",
                      border: isSelected ? "1px solid rgba(0,245,160,0.4)" : "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 6,
                      background: isSelected ? "rgba(0,245,160,0.09)" : "rgba(255,255,255,0.02)",
                      padding: "4px 6px",
                  }}
                >
                    <button
                      onClick={() => togglePinned(obj.id)}
                      style={{
                        ...BTN(),
                        padding: 0,
                        width: 20,
                        height: 20,
                        lineHeight: "20px",
                        textAlign: "center",
                        color: isPinned ? "rgba(255,245,120,0.95)" : "rgba(255,255,255,0.45)",
                        borderColor: isPinned ? "rgba(255,245,120,0.45)" : "rgba(255,255,255,0.12)",
                      }}
                      title={isPinned ? "Unpin object" : "Pin object"}
                    >
                      {isPinned ? "★" : "☆"}
                    </button>
                    <button
                      onClick={() => {
                        setSelectedObjectId((prev) => (prev === obj.id ? null : obj.id));
                        setSelectedRowToken(null);
                      }}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#fff",
                        textAlign: "left",
                        padding: 0,
                        cursor: "pointer",
                        fontFamily: "monospace",
                        fontSize: 11,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={obj.label}
                    >
                      {obj.label}
                    </button>
                    <span style={{ color: "rgba(255,255,255,0.85)", fontFamily: "monospace", fontSize: 11 }}>{obj.count}</span>
                    <span style={{ color: obj.scope === "session" ? "#00f5a0" : obj.scope === "pause" ? "rgba(255,220,120,0.95)" : "rgba(200,200,200,0.9)", fontFamily: "monospace", fontSize: 11 }}>
                      {obj.scope}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateRows: "128px 1fr", gap: 8, minHeight: 420 }}>
          <div style={{
            background: "rgba(0,0,0,0.35)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}>
            <div style={{ ...LABEL_COL, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Selected Item</div>
            {!selectedSnapshot && !selectedRow ? (
              <div style={{ ...LABEL_COL }}>Select an entry on the left or click a row to inspect values.</div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "88px 120px 80px 1fr", gap: 8, fontFamily: "monospace", fontSize: 11 }}>
                  <span style={{ color: "rgba(255,255,255,0.4)" }}>
                    {new Date((selectedRow?.ts ?? selectedSnapshot?.lastTs ?? Date.now())).toLocaleTimeString()}
                  </span>
                  <span
                    style={{ color: "rgba(170,220,255,0.95)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={(selectedRow?.className ?? selectedSnapshot?.className ?? "?")}
                  >
                    {selectedRow?.className ?? selectedSnapshot?.className ?? "?"}
                  </span>
                  <span
                    style={{
                      color:
                        (selectedRow?.scope ?? selectedSnapshot?.scope) === "session"
                          ? "#00f5a0"
                          : (selectedRow?.scope ?? selectedSnapshot?.scope) === "pause"
                            ? "rgba(255,220,120,0.95)"
                            : "rgba(200,200,200,0.9)",
                    }}
                  >
                    {selectedRow?.source ?? selectedSnapshot?.source ?? "?"}
                  </span>
                  <span
                    style={{ color: "rgba(230,255,240,0.92)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={selectedRow?.valueText ?? selectedSnapshot?.lastValueText ?? selectedRow?.path ?? selectedSnapshot?.lastPath ?? ""}
                  >
                    {selectedRow?.valueText ?? selectedSnapshot?.lastValueText ?? selectedRow?.path ?? selectedSnapshot?.lastPath ?? "—"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {selectedPairs.length === 0 ? (
                    <span style={{ ...LABEL_COL }}>No parsed key/value fields on this row.</span>
                  ) : (
                    selectedPairs.slice(0, 8).map((kv, idx) => (
                      <span
                        key={`${kv.key}-${idx}`}
                        style={{
                          fontFamily: "monospace",
                          fontSize: 11,
                          color: "rgba(210,245,255,0.95)",
                          border: "1px solid rgba(120,180,255,0.25)",
                          borderRadius: 4,
                          padding: "2px 6px",
                        }}
                      >
                        {kv.key}={kv.value}
                      </span>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          <div
            ref={scrollerRef}
            style={{
              background: "rgba(0,0,0,0.35)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 8,
              padding: 10,
              minHeight: 284,
              maxHeight: 284,
              overflowY: "auto",
            }}
          >
            {filteredRows.length === 0 ? (
              <div style={{ ...LABEL_COL }}>
                {selectedObjectId
                  ? "No recent rows for selected object (snapshot retained)."
                  : "No structured object rows yet."}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {filteredRows.map((r, idx) => {
                  const token = rowToken(r);
                  const isSelected = selectedRowToken ? token === selectedRowToken : idx === (filteredRows.length - 1);
                  return (
                    <button
                      key={`${token}-${idx}`}
                      onClick={() => {
                        setSelectedObjectId(r.objectId);
                        setSelectedRowToken(token);
                      }}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "88px 180px 100px 110px 1fr",
                        gap: 8,
                        fontFamily: "monospace",
                        fontSize: 11,
                        textAlign: "left",
                        border: isSelected ? "1px solid rgba(0,245,160,0.35)" : "1px solid rgba(255,255,255,0.06)",
                        borderRadius: 6,
                        background: isSelected ? "rgba(0,245,160,0.08)" : "rgba(255,255,255,0.01)",
                        padding: "4px 6px",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ color: "rgba(255,255,255,0.4)" }}>
                        {new Date(r.ts).toLocaleTimeString()}
                      </span>
                      <span
                        style={{ color: "rgba(170,220,255,0.95)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={r.objectLabel}
                      >
                        {r.objectLabel}
                      </span>
                      <span style={{ color: r.scope === "session" ? "#00f5a0" : r.scope === "pause" ? "rgba(255,220,120,0.95)" : "rgba(200,200,200,0.9)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.leaf}>
                        {r.leaf}
                      </span>
                      <span style={{ color: "rgba(180,205,255,0.92)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.valueText ?? ""}>
                        {r.valueText ?? "—"}
                      </span>
                      <span style={{ color: "rgba(230,255,240,0.92)", wordBreak: "break-word" }} title={r.path}>{r.path}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main DebugTab ────────────────────────────────────────────────────────────

export function DebugTab() {
  const [sub, setSub] = useState<SubTab>("ue4ss");

  const subTabs: { id: SubTab; label: string }[] = [
    { id: "ue4ss",     label: "AimMod Runtime" },
    { id: "methodsrc", label: "Method Sources" },
    { id: "objdebug",  label: "Object Debug" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {/* Sub-tab bar */}
      <div style={{ display: "flex", gap: 0, borderBottom: `1px solid ${C.border}`, marginBottom: 20 }}>
        {subTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setSub(t.id)}
            style={{
              background: "none", border: "none",
              borderBottom: sub === t.id ? `2px solid ${C.accent}` : "2px solid transparent",
              padding: "7px 14px", marginBottom: -1, cursor: "pointer",
              color: sub === t.id ? C.text : C.textFaint,
              fontFamily: "monospace", fontSize: 12,
              fontWeight: sub === t.id ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ display: sub === "ue4ss"     ? undefined : "none" }}><Ue4ssConsoleTab /></div>
      <div style={{ display: sub === "methodsrc" ? undefined : "none" }}><MethodSourcesTab /></div>
      <div style={{ display: sub === "objdebug"  ? undefined : "none" }}><ObjectDebugTab /></div>
    </div>
  );
}
