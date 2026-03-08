import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, MonitorInfo } from "../types/settings";
import type { FriendProfile } from "../types/friends";
import { FriendManager } from "./FriendManager";
import { useUpdater } from "../hooks/useUpdater";
import { Btn, FieldGroup, GlassCard, Toggle } from "../design/ui";
import { C } from "../design/tokens";

const SmoothnessReport = lazy(() =>
  import("../analytics/SmoothnessReport").then(m => ({ default: m.SmoothnessReport }))
);
const StatsWindowEmbed = lazy(() =>
  import("../analytics/StatsWindow").then(m => ({ default: m.StatsWindow }))
);

type Tab = "general" | "friends" | "smoothness" | "stats";

interface SettingsProps {
  onClose: () => void;
  onLayoutHUDs: () => void;
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "general",    label: "General",       icon: "⚙" },
  { id: "friends",    label: "Friends",        icon: "◎" },
  { id: "smoothness", label: "Smoothness",     icon: "〜" },
  { id: "stats",      label: "Session Stats",  icon: "▦" },
];

const LOADING_PLACEHOLDER = (
  <div className="p-8" style={{ color: C.textFaint, fontFamily: "'JetBrains Mono', monospace" }}>
    Loading…
  </div>
);

export function Settings({ onClose, onLayoutHUDs }: SettingsProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("general");
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const [error, setError]         = useState<string | null>(null);
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
        style={{ background: C.bg, color: C.textFaint, fontFamily: "'JetBrains Mono', monospace" }}
      >
        {error ? `Error: ${error}` : "Loading…"}
      </div>
    );
  }

  return (
    <div
      className="flex h-full"
      style={{ background: C.bg, color: C.text, fontFamily: "'JetBrains Mono', monospace" }}
    >
      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <div
        className="flex flex-col"
        style={{
          width:        176,
          borderRight:  `1px solid ${C.border}`,
          background:   "rgba(0,0,0,0.35)",
          flexShrink:   0,
          overflowY:    "auto",
          padding:      "20px 10px",
          gap:          4,
        }}
      >
        {/* Logo + close */}
        <div className="flex items-center justify-between px-2 mb-4">
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.18em", color: C.accent }}>
            AIMMOD
          </span>
          <button
            onClick={onClose}
            title="Close (F8)"
            className="am-btn am-btn-ghost"
            style={{ width: 22, height: 22, padding: 0, borderRadius: 6, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            ×
          </button>
        </div>

        {/* Navigation tabs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`am-nav-item ${activeTab === tab.id ? "active" : ""}`}
            >
              <span style={{ fontSize: 10, opacity: 0.7 }}>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tools section */}
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              fontSize:      9,
              fontWeight:    700,
              letterSpacing: "0.12em",
              color:         C.textDisabled,
              textTransform: "uppercase",
              padding:       "0 10px 6px",
            }}
          >
            Tools
          </div>
          {[
            { label: "Session Stats", cmd: "open_stats_window" },
            { label: "View Logs",     cmd: "open_logs_window" },
          ].map(({ label, cmd }) => (
            <button
              key={cmd}
              onClick={() => invoke(cmd).catch(console.error)}
              className="am-nav-item"
            >
              <span style={{ fontSize: 10, opacity: 0.5 }}>↗</span>
              {label}
            </button>
          ))}
        </div>

        {/* Bottom actions */}
        <div
          className="flex flex-col gap-1.5 mt-auto pt-3"
          style={{ borderTop: `1px solid ${C.borderSub}` }}
        >
          {/* Hotkey hints */}
          <div
            className="flex flex-col gap-1 px-2 pb-1"
            style={{ color: C.textDisabled }}
          >
            {[
              { key: "F8",  label: "Toggle settings" },
              { key: "F10", label: "Reposition HUDs" },
            ].map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between text-xs">
                <span style={{ fontSize: 9, color: C.textFaint }}>{label}</span>
                <span
                  style={{
                    background:    "rgba(255,255,255,0.06)",
                    border:        `1px solid ${C.border}`,
                    borderRadius:  3,
                    padding:       "1px 5px",
                    fontSize:      9,
                    color:         C.textDisabled,
                  }}
                >
                  {key}
                </span>
              </div>
            ))}
          </div>

          <Btn variant="accent" size="xs" onClick={onLayoutHUDs} className="w-full justify-start">
            ✥ Reposition HUDs
          </Btn>

          {/* Updates */}
          <Btn
            variant={updateStatus.state === "available" ? "primary" : "ghost"}
            size="xs"
            disabled={updateStatus.state === "checking" || updateStatus.state === "downloading" || updateStatus.state === "ready"}
            onClick={() => {
              if (updateStatus.state === "available") installUpdate(updateStatus.update);
              else checkForUpdate();
            }}
            className="w-full justify-start"
          >
            {updateStatus.state === "idle"        && "Check for Updates"}
            {updateStatus.state === "checking"    && "Checking…"}
            {updateStatus.state === "up-to-date"  && "✓ Up to date"}
            {updateStatus.state === "available"   && `↓ Update ${updateStatus.update.version}`}
            {updateStatus.state === "downloading" && `↓ ${updateStatus.progress}%`}
            {updateStatus.state === "ready"       && "Restarting…"}
            {updateStatus.state === "error"       && "Update failed"}
          </Btn>

          <Btn variant="danger" size="xs" onClick={() => invoke("quit_app")} className="w-full justify-start">
            ✕ Quit App
          </Btn>
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <div className="flex-1" style={{ overflow: activeTab === "stats" ? "hidden" : "auto", minWidth: 0 }}>
        {activeTab === "general" && (
          <GeneralSettings
            settings={settings}
            onChange={setSettings}
            onSave={handleSave}
            saving={saving}
            saved={saved}
            error={error}
          />
        )}
        {activeTab === "friends" && <FriendManager settings={settings} onChange={setSettings} />}
        {activeTab === "smoothness" && (
          <Suspense fallback={LOADING_PLACEHOLDER}>
            <SmoothnessReport />
          </Suspense>
        )}
        {activeTab === "stats" && (
          <Suspense fallback={LOADING_PLACEHOLDER}>
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
  saving: boolean;
  saved: boolean;
  error: string | null;
}

function GeneralSettings({ settings, onChange, onSave, saving, saved, error }: GeneralSettingsProps) {
  const [monitors,      setMonitors]      = useState<MonitorInfo[]>([]);
  const [detectingUser, setDetectingUser] = useState(false);
  const [detectError,   setDetectError]   = useState<string | null>(null);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    onChange({ ...settings, [key]: value });

  useEffect(() => {
    invoke<MonitorInfo[]>("get_monitors").then(setMonitors).catch(console.error);
  }, []);

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

  const handleMonitorChange = async (index: number) => {
    update("monitor_index", index);
    await invoke("set_overlay_monitor", { index }).catch(console.error);
  };

  return (
    <div style={{ padding: "28px 32px", maxWidth: 640 }}>
      <h1
        style={{
          fontSize:      16,
          fontWeight:    700,
          letterSpacing: "0.06em",
          color:         C.textSub,
          marginBottom:  28,
        }}
      >
        General Settings
      </h1>

      <div className="flex flex-col gap-7">

        {/* ── Username ──────────────────────────────────────────────── */}
        <FieldGroup label="Display Name" description="Your KovaaK's username — used for VS-mode score comparison">
          <div className="flex gap-2">
            <input
              type="text"
              value={settings.username}
              onChange={(e) => update("username", e.target.value)}
              placeholder="KovaaK's username"
              className="am-input flex-1"
            />
            <Btn
              variant="ghost"
              size="sm"
              onClick={handleDetectSteamUser}
              disabled={detectingUser}
              title="Auto-detect from the active Steam account"
              style={{ whiteSpace: "nowrap", borderColor: "rgba(23,144,255,0.3)", color: detectingUser ? "rgba(23,144,255,0.35)" : "#1790ff" }}
            >
              {detectingUser ? "Detecting…" : "Detect from Steam"}
            </Btn>
          </div>
          {detectError && <p className="text-xs mt-1" style={{ color: C.danger }}>{detectError}</p>}
        </FieldGroup>

        {/* ── Monitor ───────────────────────────────────────────────── */}
        <FieldGroup label="AimMod Display" description="Which screen to show AimMod on">
          <div className="flex flex-col gap-1.5">
            {monitors.length === 0 ? (
              <span className="text-sm" style={{ color: C.textFaint }}>Loading monitors…</span>
            ) : (
              monitors.map((m) => {
                const active = settings.monitor_index === m.index;
                return (
                  <label
                    key={m.index}
                    onClick={() => handleMonitorChange(m.index)}
                    className="flex items-center gap-3 rounded-lg cursor-pointer"
                    style={{
                      padding:     "9px 12px",
                      background:  active ? "rgba(0,245,160,0.08)" : C.surface,
                      border:      `1px solid ${active ? C.accentBorder : C.border}`,
                      transition:  "background 0.15s ease, border-color 0.15s ease",
                    }}
                  >
                    <div
                      style={{
                        width:       13,
                        height:      13,
                        borderRadius: "50%",
                        border:      `2px solid ${active ? C.accent : "rgba(255,255,255,0.25)"}`,
                        background:  active ? C.accent : "transparent",
                        flexShrink:  0,
                        transition:  "all 0.15s ease",
                      }}
                    />
                    <div>
                      <div className="text-sm" style={{ color: C.text }}>{m.name}</div>
                      <div className="text-xs" style={{ color: C.textFaint }}>
                        {m.width}×{m.height} at ({m.x}, {m.y})
                      </div>
                    </div>
                  </label>
                );
              })
            )}
          </div>
        </FieldGroup>

        {/* ── Stats directory ───────────────────────────────────────── */}
        <FieldGroup
          label="KovaaK's Stats Directory"
          description="Path where KovaaK's writes session CSV files after each scenario"
        >
          <input
            type="text"
            value={settings.stats_dir}
            onChange={(e) => update("stats_dir", e.target.value)}
            className="am-input w-full font-mono"
          />
        </FieldGroup>

        {/* ── Mouse DPI ─────────────────────────────────────────────── */}
        <FieldGroup
          label="Mouse DPI / CPI"
          description="Your mouse sensor CPI. Used to normalise smoothness metrics across sensitivities."
        >
          <div className="flex items-center gap-2 flex-wrap">
            {[400, 800, 1600, 3200].map((preset) => {
              const active = settings.mouse_dpi === preset;
              return (
                <button
                  key={preset}
                  onClick={() => update("mouse_dpi", preset)}
                  className="am-btn tabular-nums"
                  style={{
                    padding:    "5px 12px",
                    borderRadius: 8,
                    fontSize:   12,
                    background: active ? C.accentDim : C.surface,
                    border:     `1px solid ${active ? C.accentBorder : C.border}`,
                    color:      active ? C.accent : C.textMuted,
                    fontFamily: "inherit",
                  }}
                >
                  {preset}
                </button>
              );
            })}
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
              className="am-input w-24 tabular-nums"
              placeholder="Custom"
            />
            <span className="text-xs" style={{ color: C.textFaint }}>DPI</span>
          </div>
        </FieldGroup>

        {/* ── Live Coaching ─────────────────────────────────────────── */}
        <FieldGroup
          label="Live Coaching"
          description="Real-time on-screen tips based on your mouse movement and stats."
        >
          <GlassCard style={{ padding: "12px 14px" }}>
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: C.textSub }}>Enable coaching tips</span>
                <Toggle
                  checked={settings.live_feedback_enabled}
                  onChange={(v) => update("live_feedback_enabled", v)}
                />
              </div>

              {settings.live_feedback_enabled && (
                <div className="flex items-center gap-3">
                  <span className="text-xs" style={{ color: C.textFaint, minWidth: 64 }}>Verbosity</span>
                  {([0, 1, 2] as const).map((level) => {
                    const labels = ["Minimal", "Standard", "Verbose"];
                    const active = settings.live_feedback_verbosity === level;
                    return (
                      <button
                        key={level}
                        onClick={() => update("live_feedback_verbosity", level)}
                        className="am-btn"
                        style={{
                          padding:    "4px 10px",
                          borderRadius: 7,
                          fontSize:   11,
                          background: active ? C.accentDim : C.surface,
                          border:     `1px solid ${active ? C.accentBorder : C.border}`,
                          color:      active ? C.accent : C.textMuted,
                          fontFamily: "inherit",
                        }}
                      >
                        {labels[level]}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </GlassCard>
        </FieldGroup>

        {/* ── Overlay visibility ────────────────────────────────────── */}
        <FieldGroup label="AimMod" description="Show or hide AimMod in-game">
          <div className="flex items-center gap-3">
            <Toggle
              checked={settings.overlay_visible}
              onChange={(v) => update("overlay_visible", v)}
            />
            <span className="text-sm" style={{ color: C.textMuted }}>
              {settings.overlay_visible ? "Visible" : "Hidden"}
            </span>
          </div>
        </FieldGroup>

        {/* ── HUD visibility ────────────────────────────────────────── */}
        <FieldGroup label="Visible HUDs" description="Show or hide individual overlay elements">
          <GlassCard style={{ padding: "12px 14px" }}>
            <div className="flex flex-col gap-3">
              {(
                [
                  ["VS Mode",      "hud_vsmode_visible"],
                  ["Smoothness",   "hud_smoothness_visible"],
                  ["Stats Panel",  "hud_stats_visible"],
                  ["Coaching Tips","hud_feedback_visible"],
                  ["Post-Session", "hud_post_session_visible"],
                ] as const
              ).map(([label, key]) => (
                <div key={key} className="flex items-center justify-between">
                  <span className="text-sm" style={{ color: C.textSub }}>{label}</span>
                  <Toggle
                    checked={settings[key]}
                    onChange={(v) => update(key, v)}
                  />
                </div>
              ))}
            </div>
          </GlassCard>
        </FieldGroup>
      </div>

      {/* ── Save bar ──────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-4 mt-10 pt-6"
        style={{ borderTop: `1px solid ${C.borderSub}` }}
      >
        <Btn
          variant={saved ? "accent" : "primary"}
          size="md"
          onClick={onSave}
          disabled={saving}
        >
          {saving ? "Saving…" : saved ? "✓ Saved" : "Save Settings"}
        </Btn>
        {error && <span className="text-sm" style={{ color: C.danger }}>{error}</span>}
      </div>
    </div>
  );
}

// ─── Voice Picker ─────────────────────────────────────────────────────────────
// Kept for future use when SAPI wiring is re-enabled.

interface VoicePickerProps {
  selectedVoice: string | null;
  onSelect: (voiceName: string | null) => void;
}

// @ts-ignore -- kept for future use
function NeuralVoiceInstaller({ selectedVoice, onSelect }: VoicePickerProps) {
  const [voices,     setVoices]     = useState<string[] | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);

  useEffect(() => {
    invoke<string[]>("list_sapi_voices")
      .then(setVoices)
      .catch(() => setVoices([]));
  }, []);

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
      setTimeout(() => setPreviewing((p) => (p === voiceName ? null : p)), 4000);
    });
  };

  if (voices === null) return <div className="text-xs" style={{ color: C.textFaint }}>Loading voices…</div>;

  if (voices.length === 0) {
    return (
      <GlassCard style={{ padding: "14px 16px" }}>
        <span className="text-xs font-semibold" style={{ color: C.textSub }}>No voices found</span>
        <p className="text-xs mt-1.5 leading-relaxed" style={{ color: C.textFaint }}>
          Install neural voices via <strong style={{ color: C.textMuted }}>Accessibility → Narrator → Add more voices</strong> then restart.
        </p>
        <Btn
          variant="primary"
          size="sm"
          onClick={() => invoke("open_natural_voices_store").catch(console.error)}
          className="mt-3"
        >
          Open Accessibility → Narrator ↗
        </Btn>
      </GlassCard>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: C.textFaint }}>Voice</span>
        <Btn
          variant="ghost"
          size="xs"
          onClick={() => invoke("open_natural_voices_store").catch(console.error)}
        >
          Install more ↗
        </Btn>
      </div>

      <div className="flex flex-col gap-1">
        <div
          className="flex items-center px-3 py-2 rounded-lg cursor-pointer"
          style={{
            background: !selectedVoice ? C.accentDim : C.surface,
            border:     `1px solid ${!selectedVoice ? C.accentBorder : C.border}`,
          }}
          onClick={() => onSelect(null)}
        >
          <span className="text-xs" style={{ color: !selectedVoice ? C.accent : C.textMuted }}>
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
                background: active ? C.accentDim : C.surface,
                border:     `1px solid ${active ? C.accentBorder : C.border}`,
              }}
              onClick={() => onSelect(voiceName)}
            >
              <div>
                <span className="text-xs" style={{ color: active ? C.accent : C.textSub }}>
                  {displayName(voiceName)}
                </span>
                <div className="text-xs" style={{ color: C.textDisabled, fontSize: 10 }}>{voiceName}</div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); previewVoice(voiceName); }}
                className="am-btn am-btn-ghost shrink-0 ml-2"
                style={{
                  padding:     "2px 8px",
                  borderRadius: 5,
                  fontSize:    10,
                  ...(previewing === voiceName ? {
                    background:  C.accentDim,
                    borderColor: C.accentBorder,
                    color:       C.accent,
                  } : {}),
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
