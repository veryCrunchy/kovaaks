import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface LogEntry {
  ts: number;
  level: "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";
  target: string;
  message: string;
}

type LevelFilter = "ALL" | "ERROR" | "WARN" | "INFO" | "DEBUG";

const LEVEL_COLOR: Record<string, string> = {
  ERROR: "#ff4d4d",
  WARN:  "#ffd700",
  INFO:  "#00f5a0",
  DEBUG: "#60a5fa",
  TRACE: "rgba(255,255,255,0.3)",
};

const LEVEL_WEIGHT: Record<string, string> = {
  ERROR: "700",
  WARN:  "600",
  INFO:  "500",
  DEBUG: "400",
  TRACE: "400",
};

function fmt(ts: number) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export function LogViewer() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<LevelFilter>("ALL");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load buffer on mount
  useEffect(() => {
    invoke<LogEntry[]>("get_log_buffer")
      .then((buf) => setEntries(buf))
      .catch(console.error);
  }, []);

  // Subscribe to live events
  useEffect(() => {
    const unlisten = listen<LogEntry>("log-entry", (e) => {
      setEntries((prev) => {
        const next = [...prev, e.payload];
        return next.length > 2000 ? next.slice(next.length - 2000) : next;
      });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [entries, autoScroll]);

  // Detect manual scroll-up to pause auto-scroll
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  const handleClear = useCallback(() => {
    invoke("clear_log_buffer").catch(console.error);
    setEntries([]);
  }, []);

  const handleExport = useCallback(() => {
    // Serialize ALL entries (not just filtered) to plain text
    const lines = entries.map((e) => {
      const d = new Date(e.ts);
      const ts = d.toISOString();
      return `${ts} [${e.level.padEnd(5)}] ${e.target}: ${e.message}`;
    });
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `aimmod-logs-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [entries]);

  const LEVEL_ORDER = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];
  const filterLevel = filter === "ALL" ? null : LEVEL_ORDER.indexOf(filter);

  const visible = entries.filter((e) => {
    if (filterLevel !== null && LEVEL_ORDER.indexOf(e.level) > filterLevel) return false;
    if (search) {
      const q = search.toLowerCase();
      return e.message.toLowerCase().includes(q) || e.target.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#0a0a0f",
        color: "#fff",
        fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
        fontSize: 12,
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(0,0,0,0.4)",
          flexShrink: 0,
          flexWrap: "wrap",
        }}
      >
        <span style={{ color: "#00f5a0", fontWeight: 700, letterSpacing: 2, marginRight: 4 }}>
          LOGS
        </span>

        {/* Level filter buttons */}
        {(["ALL", "ERROR", "WARN", "INFO", "DEBUG"] as LevelFilter[]).map((l) => (
          <button
            key={l}
            onClick={() => setFilter(l)}
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              border: filter === l
                ? `1px solid ${l === "ALL" ? "#00f5a0" : LEVEL_COLOR[l]}`
                : "1px solid rgba(255,255,255,0.1)",
              background: filter === l ? "rgba(255,255,255,0.07)" : "transparent",
              color: l === "ALL" ? (filter === "ALL" ? "#00f5a0" : "rgba(255,255,255,0.45)") : (filter === l ? LEVEL_COLOR[l] : "rgba(255,255,255,0.35)"),
              cursor: "pointer",
              fontSize: 11,
              fontFamily: "inherit",
            }}
          >
            {l}
          </button>
        ))}

        {/* Search */}
        <input
          type="text"
          placeholder="Filter…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            marginLeft: "auto",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 4,
            color: "#fff",
            padding: "2px 8px",
            fontSize: 12,
            fontFamily: "inherit",
            outline: "none",
            width: 180,
          }}
        />

        {/* Count */}
        <span style={{ color: "rgba(255,255,255,0.3)", minWidth: 60, textAlign: "right" }}>
          {visible.length}/{entries.length}
        </span>

        {/* Auto-scroll indicator */}
        <button
          onClick={() => {
            setAutoScroll(true);
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
          }}
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            border: `1px solid ${autoScroll ? "rgba(0,245,160,0.3)" : "rgba(255,255,255,0.1)"}`,
            background: autoScroll ? "rgba(0,245,160,0.07)" : "transparent",
            color: autoScroll ? "#00f5a0" : "rgba(255,255,255,0.3)",
            cursor: "pointer",
            fontSize: 11,
            fontFamily: "inherit",
          }}
          title="Scroll to bottom / follow"
        >
          ↓ Follow
        </button>

        {/* Export */}
        <button
          onClick={handleExport}
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            border: "1px solid rgba(96,165,250,0.3)",
            background: "transparent",
            color: "rgba(96,165,250,0.7)",
            cursor: "pointer",
            fontSize: 11,
            fontFamily: "inherit",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "#60a5fa"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "rgba(96,165,250,0.7)"; }}
          title="Save all logs to a .txt file"
        >
          Export
        </button>

        {/* Clear */}
        <button
          onClick={handleClear}
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            border: "1px solid rgba(255,100,100,0.2)",
            background: "transparent",
            color: "rgba(255,100,100,0.6)",
            cursor: "pointer",
            fontSize: 11,
            fontFamily: "inherit",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "#ff6b6b"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "rgba(255,100,100,0.6)"; }}
        >
          Clear
        </button>
      </div>

      {/* Log list */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "4px 0",
        }}
      >
        {visible.length === 0 && (
          <div style={{ padding: "24px 16px", color: "rgba(255,255,255,0.2)", textAlign: "center" }}>
            No log entries yet
          </div>
        )}
        {visible.map((e, i) => (
          <div
            key={i}
            style={{
              display: "grid",
              gridTemplateColumns: "86px 52px 1fr",
              gap: "0 10px",
              padding: "1.5px 12px",
              lineHeight: "1.6",
              borderBottom: "1px solid rgba(255,255,255,0.02)",
            }}
          >
            <span style={{ color: "rgba(255,255,255,0.25)", whiteSpace: "nowrap" }}>
              {fmt(e.ts)}
            </span>
            <span
              style={{
                color: LEVEL_COLOR[e.level] ?? "#fff",
                fontWeight: LEVEL_WEIGHT[e.level] ?? "400",
                whiteSpace: "nowrap",
              }}
            >
              {e.level}
            </span>
            <span style={{ color: "rgba(255,255,255,0.85)", wordBreak: "break-word" }}>
              <span style={{ color: "rgba(255,255,255,0.3)" }}>[{e.target}] </span>
              {e.message}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
