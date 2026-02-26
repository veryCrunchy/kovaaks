import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, MonitorInfo } from "../types/settings";
import type { FriendProfile } from "../types/friends";
import { FriendManager } from "./FriendManager";
import { useUpdater } from "../hooks/useUpdater";

const SmoothnessReport = lazy(() =>
  import("../analytics/SmoothnessReport").then(m => ({ default: m.SmoothnessReport }))
);
const StatsWindowEmbed = lazy(() =>
  import("../analytics/StatsWindow").then(m => ({ default: m.StatsWindow }))
);

type Tab = "general" | "friends" | "smoothness" | "stats";

interface SettingsProps {
  onClose: () => void;
  onPickRegions: () => void;
  onLayoutHUDs: () => void;
  onAutoSetup: () => void;
}

export function Settings({ onClose, onPickRegions, onLayoutHUDs, onAutoSetup }: SettingsProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("general");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { status: updateStatus, checkForUpdate, installUpdate } = useUpdater();

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }, []);

  const handleSave = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("save_settings", { newSettings: settings });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [settings]);

  if (!settings) {
    return (
      <div
        className="flex items-center justify-center h-full"
        style={{ background: "#0a0a0f", color: "rgba(255,255,255,0.4)", fontFamily: "'JetBrains Mono', monospace" }}
      >
        {error ? `Error: ${error}` : "Loading…"}
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "general", label: "General" },
    { id: "friends", label: "Friends" },
    { id: "smoothness", label: "Smoothness" },
    { id: "stats", label: "Session Stats" },
  ];

  return (
    <div
      className="flex h-full"
      style={{ background: "#0a0a0f", color: "#fff", fontFamily: "'JetBrains Mono', monospace" }}
    >
      {/* Sidebar */}
      <div
        className="flex flex-col py-8 px-4"
        style={{
          width: 180,
          borderRight: "1px solid rgba(255,255,255,0.06)",
          background: "rgba(0,0,0,0.5)",
          flexShrink: 0,
        }}
      >
        <div className="flex items-start justify-between mb-8 px-3">
          <div
            className="text-xs font-bold tracking-widest"
            style={{ color: "#00f5a0" }}
          >
            KOVAAK'S
            <br />
            OVERLAY
          </div>
          {/* Close button */}
          <button
            onClick={onClose}
            className="rounded-lg flex items-center justify-center"
            style={{
              width: 24,
              height: 24,
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "rgba(255,255,255,0.5)",
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
            }}
            title="Close (F8)"
          >
            ×
          </button>
        </div>

        <nav className="flex flex-col gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="text-left px-2.5 py-1.5 rounded text-xs transition-all"
              style={{
                background: activeTab === tab.id ? "rgba(0,245,160,0.1)" : "transparent",
                color: activeTab === tab.id ? "#00f5a0" : "rgba(255,255,255,0.45)",
                border: activeTab === tab.id
                  ? "1px solid rgba(0,245,160,0.2)"
                  : "1px solid transparent",
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div
          className="mt-auto flex flex-col gap-1.5 px-3 pt-3"
          style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}
        >
          <div className="flex flex-col gap-0.5" style={{ color: "rgba(255,255,255,0.2)" }}>
            {[
              { key: "F8", label: "Toggle settings" },
              { key: "F9", label: "Region picker" },
              { key: "F10", label: "Reposition HUDs" },
            ].map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between text-xs">
                <span style={{ color: "rgba(255,255,255,0.15)" }}>{label}</span>
                <span
                  style={{
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 4,
                    padding: "0 5px",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: "rgba(255,255,255,0.3)",
                  }}
                >
                  {key}
                </span>
              </div>
            ))}
          </div>
          <button
            onClick={onLayoutHUDs}
            className="text-left px-2.5 py-1.5 rounded text-xs transition-all"
            style={{
              background: "transparent",
              color: "rgba(0,245,160,0.6)",
              border: "1px solid rgba(0,245,160,0.15)",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,245,160,0.08)";
              (e.currentTarget as HTMLButtonElement).style.color = "#00f5a0";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = "rgba(0,245,160,0.6)";
            }}
          >
            Reposition HUDs
          </button>
          <button
            onClick={() => invoke("open_stats_window").catch(console.error)}
            className="text-left px-2.5 py-1.5 rounded text-xs transition-all"
            style={{
              background: "transparent",
              color: "rgba(255,255,255,0.45)",
              border: "1px solid rgba(255,255,255,0.07)",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)";
              (e.currentTarget as HTMLButtonElement).style.color = "#fff";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.45)";
            }}
          >
            Session Stats
          </button>
          <button
            onClick={() => invoke("open_logs_window").catch(console.error)}
            className="text-left px-2.5 py-1.5 rounded text-xs transition-all"
            style={{
              background: "transparent",
              color: "rgba(255,255,255,0.45)",
              border: "1px solid rgba(255,255,255,0.07)",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)";
              (e.currentTarget as HTMLButtonElement).style.color = "#fff";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.45)";
            }}
          >
            View Logs
          </button>
          <button
            onClick={() => {
              if (updateStatus.state === "available") installUpdate(updateStatus.update);
              else checkForUpdate();
            }}
            disabled={updateStatus.state === "checking" || updateStatus.state === "downloading" || updateStatus.state === "ready"}
            className="text-left px-2.5 py-1.5 rounded text-xs transition-all"
            style={{
              background:
                updateStatus.state === "available" ? "rgba(0,245,160,0.12)" : "transparent",
              color:
                updateStatus.state === "available"
                  ? "#00f5a0"
                  : updateStatus.state === "up-to-date"
                  ? "rgba(0,245,160,0.5)"
                  : updateStatus.state === "error"
                  ? "rgba(255,100,100,0.7)"
                  : "rgba(255,255,255,0.45)",
              border:
                updateStatus.state === "available"
                  ? "1px solid rgba(0,245,160,0.3)"
                  : "1px solid rgba(255,255,255,0.07)",
              cursor:
                updateStatus.state === "checking" || updateStatus.state === "downloading" || updateStatus.state === "ready"
                  ? "default"
                  : "pointer",
              opacity: updateStatus.state === "checking" || updateStatus.state === "downloading" ? 0.6 : 1,
            }}
            onMouseEnter={(e) => {
              if (updateStatus.state === "checking" || updateStatus.state === "downloading") return;
              (e.currentTarget as HTMLButtonElement).style.background =
                updateStatus.state === "available" ? "rgba(0,245,160,0.18)" : "rgba(255,255,255,0.06)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                updateStatus.state === "available" ? "rgba(0,245,160,0.12)" : "transparent";
            }}
          >
            {updateStatus.state === "idle" && "Check for Updates"}
            {updateStatus.state === "checking" && "Checking…"}
            {updateStatus.state === "up-to-date" && "Up to date ✓"}
            {updateStatus.state === "available" && `Update ${updateStatus.update.version}`}
            {updateStatus.state === "downloading" && `Downloading ${updateStatus.progress}%`}
            {updateStatus.state === "ready" && "Restarting…"}
            {updateStatus.state === "error" && "Update failed"}
          </button>
          <button
            onClick={() => invoke("quit_app")}
            className="text-left px-2.5 py-1.5 rounded text-xs transition-all"
            style={{
              background: "transparent",
              color: "rgba(255,100,100,0.6)",
              border: "1px solid rgba(255,100,100,0.15)",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,100,100,0.08)";
              (e.currentTarget as HTMLButtonElement).style.color = "#ff6b6b";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,100,100,0.6)";
            }}
          >
            Quit App
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1" style={{ overflow: activeTab === "stats" ? "hidden" : "auto" }}>
        {activeTab === "general" && (
          <GeneralSettings
            settings={settings}
            onChange={setSettings}
            onSave={handleSave}
            onPickRegions={onPickRegions}
            onAutoSetup={onAutoSetup}
            saving={saving}
            saved={saved}
            error={error}
          />
        )}
        {activeTab === "friends" && <FriendManager settings={settings} onChange={setSettings} />}
        {activeTab === "smoothness" && (
          <Suspense fallback={
            <div className="p-8" style={{ color: "rgba(255,255,255,0.35)", fontFamily: "'JetBrains Mono', monospace" }}>
              Loading…
            </div>
          }>
            <SmoothnessReport />
          </Suspense>
        )}
        {activeTab === "stats" && (
          <Suspense fallback={
            <div className="p-8" style={{ color: "rgba(255,255,255,0.35)", fontFamily: "'JetBrains Mono', monospace" }}>
              Loading…
            </div>
          }>
            <div style={{ height: "100%", overflow: "hidden" }}>
              <StatsWindowEmbed embedded />
            </div>
          </Suspense>
        )}
      </div>
    </div>
  );
}

// ─── General Settings Panel ────────────────────────────────────────────────────

interface GeneralSettingsProps {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  onSave: () => void;
  onPickRegions: () => void;
  onAutoSetup: () => void;
  saving: boolean;
  saved: boolean;
  error: string | null;
}

function GeneralSettings({
  settings,
  onChange,
  onSave,
  onPickRegions,
  onAutoSetup,
  saving,
  saved,
  error,
}: GeneralSettingsProps) {
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [detectingUser, setDetectingUser] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  const handleDetectSteamUser = async () => {
    setDetectingUser(true);
    setDetectError(null);
    try {
      const profile = await invoke<FriendProfile>("detect_current_user");
      const name =
        profile.username && !profile.username.startsWith("765611")
          ? profile.username
          : profile.steam_account_name || profile.username;
      onChange({ ...settings, username: name });
    } catch (e) {
      setDetectError(String(e));
      setTimeout(() => setDetectError(null), 4000);
    } finally {
      setDetectingUser(false);
    }
  };

  // Revoke object URL when preview is dismissed or component unmounts
  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [previewUrl]);

  const handlePreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewUrl(null);
    try {
      const bytes = await invoke<number[] | null>("get_capture_preview");
      if (!bytes || bytes.length === 0) {
        setPreviewLoading(false);
        alert("No capture available yet — start a KovaaK's scenario first so OCR can grab a frame.");
        return;
      }
      const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (e) {
      console.error(e);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    invoke<MonitorInfo[]>("get_monitors").then(setMonitors).catch(console.error);
  }, []);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    onChange({ ...settings, [key]: value });

  const handleMonitorChange = async (index: number) => {
    update("monitor_index", index);
    await invoke("set_overlay_monitor", { index }).catch(console.error);
  };

  return (
    <div className="p-8 max-w-2xl">
      <h1
        className="text-lg font-bold mb-8 tracking-wider"
        style={{ color: "rgba(255,255,255,0.9)" }}
      >
        General Settings
      </h1>

      <div className="flex flex-col gap-6">
        {/* Username */}
        <FieldGroup label="Display Name" description="Your KovaaK's username — used for VS-mode score comparison">
          <div className="flex gap-2">
            <input
              type="text"
              value={settings.username}
              onChange={(e) => update("username", e.target.value)}
              className="flex-1 rounded-lg px-3 py-2 text-sm"
              style={inputStyle}
              placeholder="KovaaK's username"
            />
            <button
              onClick={handleDetectSteamUser}
              disabled={detectingUser}
              title="Auto-detect from the active Steam account"
              className="px-3 py-2 rounded-lg text-xs font-semibold flex-shrink-0"
              style={{
                background: detectingUser ? "rgba(23,144,255,0.05)" : "rgba(23,144,255,0.12)",
                border: "1px solid rgba(23,144,255,0.3)",
                color: detectingUser ? "rgba(23,144,255,0.35)" : "#1790ff",
                cursor: detectingUser ? "not-allowed" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {detectingUser ? "Detecting…" : "Detect from Steam"}
            </button>
          </div>
          {detectError && (
            <p className="text-xs mt-1.5" style={{ color: "#ff6b6b" }}>{detectError}</p>
          )}
        </FieldGroup>

        {/* Monitor */}
        <FieldGroup
          label="Overlay Monitor"
          description="Which screen to show the overlay on"
        >
          <div className="flex flex-col gap-2">
            {monitors.length === 0 ? (
              <span className="text-sm" style={{ color: "rgba(255,255,255,0.35)" }}>
                Loading monitors…
              </span>
            ) : (
              monitors.map((m) => (
                <label
                  key={m.index}
                  className="flex items-center gap-3 cursor-pointer rounded-lg px-3 py-2"
                  style={{
                    background: settings.monitor_index === m.index
                      ? "rgba(0,245,160,0.08)"
                      : "rgba(255,255,255,0.03)",
                    border: settings.monitor_index === m.index
                      ? "1px solid rgba(0,245,160,0.25)"
                      : "1px solid rgba(255,255,255,0.07)",
                    cursor: "pointer",
                  }}
                  onClick={() => handleMonitorChange(m.index)}
                >
                  <div
                    className="w-3.5 h-3.5 rounded-full border-2 flex-shrink-0"
                    style={{
                      borderColor: settings.monitor_index === m.index ? "#00f5a0" : "rgba(255,255,255,0.25)",
                      background: settings.monitor_index === m.index ? "#00f5a0" : "transparent",
                    }}
                  />
                  <div>
                    <div className="text-sm" style={{ color: "#fff" }}>
                      {m.name}
                    </div>
                    <div className="text-xs" style={{ color: "rgba(255,255,255,0.35)" }}>
                      {m.width}×{m.height} at ({m.x}, {m.y})
                    </div>
                  </div>
                </label>
              ))
            )}
          </div>
        </FieldGroup>

        {/* Stats directory */}
        <FieldGroup
          label="KovaaK's Stats Directory"
          description="Path where KovaaK's writes session CSV files after each scenario"
        >
          <input
            type="text"
            value={settings.stats_dir}
            onChange={(e) => update("stats_dir", e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm font-mono"
            style={inputStyle}
          />
        </FieldGroup>

        {/* OCR Regions */}
        <FieldGroup
          label="OCR Regions"
          description="Screen regions for SPM, scenario name, and live stats. Auto Setup detects them while you play."
        >
          {(() => {
            const allDefs = [
              { key: "spm",      label: "SPM",          color: "#00f5a0", rect: settings.stats_field_regions?.spm },
              { key: "scenario", label: "Scenario Name", color: "#00b4ff", rect: settings.scenario_region },
              { key: "kills",    label: "Kill Count",    color: "#f87171", rect: settings.stats_field_regions?.kills },
              { key: "kps",      label: "KPS",           color: "#fb923c", rect: settings.stats_field_regions?.kps },
              { key: "accuracy", label: "Accuracy",      color: "#fbbf24", rect: settings.stats_field_regions?.accuracy },
              { key: "damage",   label: "Damage",        color: "#a78bfa", rect: settings.stats_field_regions?.damage },
              { key: "ttk",      label: "Avg TTK",       color: "#34d399", rect: settings.stats_field_regions?.ttk },
            ];
            const configured = allDefs.filter(d => d.rect).length;
            return (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  {allDefs.map(d => (
                    <div
                      key={d.key}
                      className="text-xs px-2.5 py-1 rounded-md"
                      style={{
                        background: d.rect ? `${d.color}14` : "rgba(255,255,255,0.04)",
                        border: `1px solid ${d.rect ? `${d.color}44` : "rgba(255,255,255,0.1)"}`,
                        color: d.rect ? d.color : "rgba(255,255,255,0.3)",
                        fontFamily: "'JetBrains Mono', monospace",
                      }}
                    >
                      <span style={{ marginRight: 5 }}>{d.rect ? "●" : "○"}</span>
                      {d.label}
                      {d.rect && (
                        <span style={{ opacity: 0.5, marginLeft: 5 }}>
                          {d.rect.width}×{d.rect.height}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-xs" style={{ color: "rgba(255,255,255,0.35)" }}>
                    {configured}/{allDefs.length} configured
                  </span>
                  <button
                    onClick={onAutoSetup}
                    className="px-4 py-1.5 rounded-lg text-sm"
                    style={{
                      background: configured === 0 ? "rgba(251,191,36,0.12)" : "rgba(251,191,36,0.07)",
                      border: configured === 0 ? "1px solid rgba(251,191,36,0.45)" : "1px solid rgba(251,191,36,0.22)",
                      color: configured === 0 ? "#fbbf24" : "rgba(251,191,36,0.7)",
                      cursor: "pointer",
                      fontWeight: configured === 0 ? 700 : undefined,
                    }}
                  >
                    {configured === 0 ? "Auto Setup" : "Re-run Auto Setup"}
                  </button>
                  <button
                    onClick={onPickRegions}
                    className="px-4 py-1.5 rounded-lg text-sm"
                    style={{
                      background: "rgba(255,255,255,0.07)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      color: "rgba(255,255,255,0.6)",
                      cursor: "pointer",
                    }}
                  >
                    {configured === 0 ? "Manual Setup" : "Edit Regions"}
                  </button>
                </div>
              </div>
            );
          })()}
        </FieldGroup>

        {/* OCR poll rate */}
        <FieldGroup
          label="OCR Poll Rate"
          description="How often to read the SPM (ms). Lower = more CPU."
        >
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={50}
              max={500}
              step={50}
              value={settings.ocr_poll_ms}
              onChange={(e) => update("ocr_poll_ms", parseInt(e.target.value))}
              style={{ accentColor: "#00f5a0" }}
            />
            <span className="text-sm tabular-nums" style={{ color: "rgba(255,255,255,0.6)", minWidth: 50 }}>
              {settings.ocr_poll_ms}ms
            </span>
          </div>
        </FieldGroup>

        {/* Mouse DPI */}
        <FieldGroup
          label="Mouse DPI / CPI"
          description="Your mouse sensor CPI. Used to normalise smoothness metrics so scores are comparable regardless of sensitivity. Set this to match your mouse software (e.g. 800, 1600, 3200)."
        >
          <div className="flex items-center gap-3 flex-wrap">
            {[400, 800, 1600, 3200].map((preset) => (
              <button
                key={preset}
                onClick={() => update("mouse_dpi", preset)}
                className="px-3 py-1.5 rounded-lg text-xs tabular-nums"
                style={{
                  background:
                    settings.mouse_dpi === preset
                      ? "rgba(0,245,160,0.15)"
                      : "rgba(255,255,255,0.05)",
                  border:
                    settings.mouse_dpi === preset
                      ? "1px solid rgba(0,245,160,0.35)"
                      : "1px solid rgba(255,255,255,0.08)",
                  color:
                    settings.mouse_dpi === preset
                      ? "#00f5a0"
                      : "rgba(255,255,255,0.55)",
                  cursor: "pointer",
                }}
              >
                {preset}
              </button>
            ))}
            <input
              type="number"
              min={100}
              max={32000}
              step={100}
              value={settings.mouse_dpi}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                if (!isNaN(v) && v >= 100 && v <= 32000) update("mouse_dpi", v);
              }}
              className="rounded-lg px-3 py-1.5 text-sm w-24 tabular-nums"
              style={inputStyle}
              placeholder="Custom"
            />
            <span className="text-xs" style={{ color: "rgba(255,255,255,0.3)" }}>DPI</span>
          </div>
        </FieldGroup>

        {/* Live coaching feedback */}
        <FieldGroup
          label="Live Coaching"
          description="Real-time on-screen tips based on your mouse movement and stats panel data."
        >
          <div className="flex flex-col gap-4">
            {/* Enabled toggle */}
            <label className="flex items-center gap-3 cursor-pointer">
              <div
                onClick={() => update("live_feedback_enabled", !settings.live_feedback_enabled)}
                className="relative rounded-full transition-all"
                style={{
                  width: 40,
                  height: 22,
                  background: settings.live_feedback_enabled ? "#00f5a0" : "rgba(255,255,255,0.15)",
                  cursor: "pointer",
                }}
              >
                <div
                  className="absolute rounded-full transition-all"
                  style={{
                    width: 16,
                    height: 16,
                    top: 3,
                    left: settings.live_feedback_enabled ? 21 : 3,
                    background: "#fff",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
                  }}
                />
              </div>
              <span className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
                {settings.live_feedback_enabled ? "Enabled" : "Disabled"}
              </span>
            </label>

            {/* Verbosity */}
            {settings.live_feedback_enabled && (
              <div className="flex items-center gap-3">
                <span className="text-xs" style={{ color: "rgba(255,255,255,0.4)", minWidth: 70 }}>Verbosity</span>
                {([0, 1, 2] as const).map((level) => {
                  const labels = ["Minimal", "Standard", "Verbose"];
                  const active = settings.live_feedback_verbosity === level;
                  return (
                    <button
                      key={level}
                      onClick={() => update("live_feedback_verbosity", level)}
                      className="px-3 py-1 rounded-lg text-xs"
                      style={{
                        background: active ? "rgba(0,245,160,0.15)" : "rgba(255,255,255,0.05)",
                        border: active ? "1px solid rgba(0,245,160,0.35)" : "1px solid rgba(255,255,255,0.08)",
                        color: active ? "#00f5a0" : "rgba(255,255,255,0.55)",
                        cursor: "pointer",
                      }}
                    >
                      {labels[level]}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Text-to-speech toggle and voice picker are temporarily hidden.
                 The SAPI backend (sapi.rs, list_sapi_voices, speak_with_sapi) is
                 preserved for future use once a reliable voice source is confirmed.
            */}
          </div>
        </FieldGroup>

        {/* Overlay toggle */}
        <FieldGroup label="Overlay" description="Show or hide the in-game overlay">
          <label className="flex items-center gap-3 cursor-pointer">
            <div
              onClick={() => update("overlay_visible", !settings.overlay_visible)}
              className="relative rounded-full transition-all"
              style={{
                width: 40,
                height: 22,
                background: settings.overlay_visible ? "#00f5a0" : "rgba(255,255,255,0.15)",
                cursor: "pointer",
              }}
            >
              <div
                className="absolute rounded-full transition-all"
                style={{
                  width: 16,
                  height: 16,
                  top: 3,
                  left: settings.overlay_visible ? 21 : 3,
                  background: "#fff",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
                }}
              />
            </div>
            <span className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
              {settings.overlay_visible ? "Visible" : "Hidden"}
            </span>
          </label>
        </FieldGroup>

        {/* HUD visibility */}
        <FieldGroup label="Visible HUDs" description="Show or hide individual overlay elements">
          {(
            [
              ["VS Mode", "hud_vsmode_visible"],
              ["Smoothness", "hud_smoothness_visible"],
              ["Stats Panel", "hud_stats_visible"],
              ["Coaching Tips", "hud_feedback_visible"],
              ["Post-Session", "hud_post_session_visible"],
            ] as const
          ).map(([label, key]) => (
            <label key={key} className="flex items-center gap-3 cursor-pointer mb-2">
              <div
                onClick={() => update(key, !settings[key])}
                className="relative rounded-full transition-all"
                style={{
                  width: 40,
                  height: 22,
                  background: settings[key] ? "#00f5a0" : "rgba(255,255,255,0.15)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                <div
                  className="absolute rounded-full transition-all"
                  style={{
                    width: 16,
                    height: 16,
                    top: 3,
                    left: settings[key] ? 21 : 3,
                    background: "#fff",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
                  }}
                />
              </div>
              <span className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
                {label}
              </span>
            </label>
          ))}
        </FieldGroup>
      </div>

      {/* Save bar */}
      <div
        className="mt-10 pt-6 flex items-center gap-4"
        style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
      >
        <button
          onClick={onSave}
          disabled={saving}
          className="px-6 py-2 rounded-lg text-sm font-semibold"
          style={{
            background: saved ? "rgba(0,245,160,0.2)" : "#00f5a0",
            color: saved ? "#00f5a0" : "#000",
            cursor: saving ? "not-allowed" : "pointer",
            border: saved ? "1px solid rgba(0,245,160,0.4)" : "none",
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? "Saving…" : saved ? "Saved!" : "Save Settings"}
        </button>
        {error && (
          <span className="text-sm" style={{ color: "#ff6b6b" }}>
            {error}
          </span>
        )}
      </div>

      {/* ── Capture preview modal ─────────────────────────────────────────── */}
      {previewUrl && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center"
          style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(6px)" }}
          onClick={() => setPreviewUrl(null)}
        >
          <div
            className="flex flex-col items-center gap-4"
            style={{ maxWidth: "90vw" }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between w-full">
              <span
                className="text-xs tracking-widest"
                style={{ color: "#00f5a0", fontFamily: "'JetBrains Mono', monospace" }}
              >
                CAPTURE PREVIEW — what OCR sees
              </span>
              <div className="flex gap-2">
                <button
                  onClick={handlePreview}
                  disabled={previewLoading}
                  style={{
                    background: "rgba(0,245,160,0.1)",
                    border: "1px solid rgba(0,245,160,0.25)",
                    borderRadius: 6,
                    color: "#00f5a0",
                    cursor: previewLoading ? "not-allowed" : "pointer",
                    fontSize: 11,
                    padding: "3px 10px",
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  {previewLoading ? "Refreshing…" : "Refresh"}
                </button>
                <button
                  onClick={() => setPreviewUrl(null)}
                  style={{
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 6,
                    color: "rgba(255,255,255,0.5)",
                    cursor: "pointer",
                    fontSize: 14,
                    padding: "2px 8px",
                    lineHeight: 1,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  ×
                </button>
              </div>
            </div>

            {/* Render the tiny OCR region with pixelated scaling — shows each pixel clearly */}
            <img
              src={previewUrl}
              alt="OCR capture preview"
              style={{
                imageRendering: "pixelated",
                maxWidth: "min(90vw, 1200px)",
                maxHeight: "60vh",
                minWidth: 300,
                border: "2px solid rgba(0,245,160,0.4)",
                borderRadius: 6,
                boxShadow: "0 0 40px rgba(0,245,160,0.15)",
                background: "#000",
              }}
            />

            <p className="text-xs" style={{ color: "rgba(255,255,255,0.3)", fontFamily: "'JetBrains Mono', monospace" }}>
              Click outside or × to close · Refresh to grab a new frame
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Voice Picker ─────────────────────────────────────────────────────────────
// Lists all voices installed on Windows (SAPI5 + OneCore neural) via the
// Rust `list_sapi_voices` command which reads the registry directly.
// Speaks through `speak_with_sapi` (PowerShell + System.Speech) so every
// installed voice — including offline neural voices from Narrator — works.

interface VoicePickerProps {
  selectedVoice: string | null;
  onSelect: (voiceName: string | null) => void;
}

// @ts-ignore -- kept for future use when SAPI wiring is re-enabled
function NeuralVoiceInstaller({ selectedVoice, onSelect }: VoicePickerProps) {
  const [voices, setVoices] = useState<string[] | null>(null); // null = loading
  const [previewing, setPreviewing] = useState<string | null>(null);

  useEffect(() => {
    invoke<string[]>("list_sapi_voices")
      .then(setVoices)
      .catch(() => setVoices([]));
  }, []);

  /** "Microsoft Aria Online (Natural) - English (United States)" → "Aria" */
  const displayName = (v: string) =>
    v.replace(/^Microsoft\s+/i, "")
     .replace(/\s*Online.*/i, "")
     .replace(/\s*\(Natural\).*/i, "")
     .replace(/\s*-\s*.+$/, "")
     .trim();

  const previewVoice = (voiceName: string) => {
    setPreviewing(voiceName);
    invoke("speak_with_sapi", {
      text: "Great shot — your accuracy is improving. Stay relaxed.",
      voiceName,
    }).finally(() => {
      // Clear preview indicator after a reasonable speech duration
      setTimeout(() => setPreviewing((p) => (p === voiceName ? null : p)), 4000);
    });
  };

  // ── Loading ────────────────────────────────────────────────────────────────
  if (voices === null) {
    return (
      <div className="text-xs" style={{ color: "rgba(255,255,255,0.3)" }}>Loading voices…</div>
    );
  }

  // ── No voices found ────────────────────────────────────────────────────────
  if (voices.length === 0) {
    return (
      <div
        className="flex flex-col gap-3 rounded-xl p-4"
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <span className="text-xs font-semibold" style={{ color: "rgba(255,255,255,0.7)" }}>
          No voices found
        </span>
        <span className="text-xs" style={{ color: "rgba(255,255,255,0.35)", lineHeight: 1.5 }}>
          Install neural voices via{" "}
          <strong style={{ color: "rgba(255,255,255,0.55)" }}>Accessibility → Narrator → Add more voices</strong>{" "}
          then restart the app.
        </span>
        <button
          onClick={() => invoke("open_natural_voices_store").catch(console.error)}
          className="px-4 py-2 rounded-lg text-xs font-semibold self-start"
          style={{ background: "#00f5a0", color: "#000", cursor: "pointer", border: "none" }}
        >
          Open Accessibility → Narrator ↗
        </button>
      </div>
    );
  }

  // ── Voice selector ─────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: "rgba(255,255,255,0.4)" }}>Voice</span>
        <button
          onClick={() => invoke("open_natural_voices_store").catch(console.error)}
          className="text-xs px-2 py-1 rounded"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.3)",
            cursor: "pointer",
          }}
        >
          Install more ↗
        </button>
      </div>

      <div className="flex flex-col gap-1">
        {/* Auto option */}
        <div
          className="flex items-center px-3 py-2 rounded-lg cursor-pointer"
          style={{
            background: !selectedVoice ? "rgba(0,245,160,0.08)" : "rgba(255,255,255,0.03)",
            border: !selectedVoice ? "1px solid rgba(0,245,160,0.25)" : "1px solid rgba(255,255,255,0.07)",
          }}
          onClick={() => onSelect(null)}
        >
          <span className="text-xs" style={{ color: !selectedVoice ? "#00f5a0" : "rgba(255,255,255,0.5)" }}>
            Auto (best available)
          </span>
        </div>

        {voices.map((voiceName) => {
          const active = selectedVoice === voiceName;
          return (
            <div
              key={voiceName}
              className="flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer"
              style={{
                background: active ? "rgba(0,245,160,0.08)" : "rgba(255,255,255,0.03)",
                border: active ? "1px solid rgba(0,245,160,0.25)" : "1px solid rgba(255,255,255,0.07)",
              }}
              onClick={() => onSelect(voiceName)}
            >
              <div className="flex flex-col">
                <span className="text-xs" style={{ color: active ? "#00f5a0" : "rgba(255,255,255,0.7)" }}>
                  {displayName(voiceName)}
                </span>
                <span className="text-xs" style={{ color: "rgba(255,255,255,0.2)", fontSize: 10 }}>
                  {voiceName}
                </span>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); previewVoice(voiceName); }}
                className="flex-shrink-0 ml-2 px-2 py-0.5 rounded text-xs"
                style={{
                  background: previewing === voiceName ? "rgba(0,245,160,0.15)" : "rgba(255,255,255,0.06)",
                  border: previewing === voiceName ? "1px solid rgba(0,245,160,0.3)" : "1px solid rgba(255,255,255,0.1)",
                  color: previewing === voiceName ? "#00f5a0" : "rgba(255,255,255,0.4)",
                  cursor: "pointer",
                }}
              >
                {previewing === voiceName ? "●" : "▶"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FieldGroup({
  label,
  description,
  children,
}: {
  label: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5">
        <span className="text-sm font-medium" style={{ color: "rgba(255,255,255,0.8)" }}>
          {label}
        </span>
        {description && (
          <p className="text-xs mt-0.5" style={{ color: "rgba(255,255,255,0.35)" }}>
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "#fff",
  outline: "none",
};
