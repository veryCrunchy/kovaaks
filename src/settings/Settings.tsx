import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, MonitorInfo } from "../types/settings";
import type { FriendProfile } from "../types/friends";
import { FriendManager } from "./FriendManager";
import { useUpdater } from "../hooks/useUpdater";
import { Btn, FieldGroup, GlassCard, Toggle } from "../design/ui";
import { C } from "../design/tokens";

const StatsWindowEmbed = lazy(() =>
  import("../analytics/StatsWindow").then(m => ({ default: m.StatsWindow }))
);
const DEFAULT_HUB_API_BASE_URL = "https://aimmod.app";

type Tab = "general" | "friends" | "stats";

interface SettingsProps {
  onClose?: () => void;
  onLayoutHUDs?: () => void;
  initialTab?: Tab;
  hideStatsTab?: boolean;
  embeddedInStats?: boolean;
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "general",    label: "General",       icon: "⚙" },
  { id: "friends",    label: "Friends",        icon: "◎" },
  { id: "stats",      label: "Session Stats",  icon: "▦" },
];

const LOADING_PLACEHOLDER = (
  <div className="p-8" style={{ color: C.textFaint, fontFamily: "'JetBrains Mono', monospace" }}>
    Loading…
  </div>
);

export function Settings({
  onClose,
  onLayoutHUDs,
  initialTab = "general",
  hideStatsTab = false,
  embeddedInStats = false,
}: SettingsProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loadedSettings, setLoadedSettings] = useState<AppSettings | null>(null);
  const [appVersionLabel, setAppVersionLabel] = useState("");
  const availableTabs = useMemo(
    () => TABS.filter((tab) => !(hideStatsTab && tab.id === "stats")),
    [hideStatsTab],
  );
  const [activeTab, setActiveTab] = useState<Tab>(() =>
    hideStatsTab && initialTab === "stats" ? "general" : initialTab,
  );
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const saveSequence = useRef(0);
  const { status: updateStatus, checkForUpdate, installUpdate } = useUpdater();

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((loaded) => {
        setSettings(loaded);
        setLoadedSettings(loaded);
      })
      .catch((e) => setError(String(e)));

    invoke<string>("get_app_version_label")
      .then(setAppVersionLabel)
      .catch(() => setAppVersionLabel(""));
  }, []);

  const dirty = useMemo(() => {
    if (!settings || !loadedSettings) return false;
    return JSON.stringify(settings) !== JSON.stringify(loadedSettings);
  }, [loadedSettings, settings]);

  const handleReset = useCallback(async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      window.setTimeout(() => setConfirmReset(false), 3000);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const defaults = await invoke<AppSettings>("reset_settings");
      setSettings(defaults);
      setLoadedSettings(defaults);
      setConfirmReset(false);
      setSaved(true);
      setLastSavedAt(new Date());
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [confirmReset]);

  useEffect(() => {
    if (!settings || !loadedSettings) return;
    const nextSerialized = JSON.stringify(settings);
    const loadedSerialized = JSON.stringify(loadedSettings);
    if (nextSerialized === loadedSerialized) return;

    const sequence = ++saveSequence.current;
    setSaving(true);
    setSaved(false);
    setError(null);

    const timeout = window.setTimeout(async () => {
      try {
        await invoke("save_settings", { newSettings: settings });
        if (saveSequence.current !== sequence) return;
        setLoadedSettings(settings);
        setLastSavedAt(new Date());
        setSaved(true);
        window.setTimeout(() => {
          if (saveSequence.current === sequence) {
            setSaved(false);
          }
        }, 2000);
      } catch (e) {
        if (saveSequence.current !== sequence) return;
        setError(String(e));
      } finally {
        if (saveSequence.current === sequence) {
          setSaving(false);
        }
      }
    }, 450);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [loadedSettings, settings]);

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
          <div className="flex flex-col gap-0.5">
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.18em", color: C.accent }}>
              AIMMOD
            </span>
            {appVersionLabel && (
              <span style={{ fontSize: 9, letterSpacing: "0.08em", color: C.textDisabled }}>
                {`AimMod • ${appVersionLabel}`}
              </span>
              )}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              title="Close (F8)"
              className="am-btn am-btn-ghost"
              style={{ width: 22, height: 22, padding: 0, borderRadius: 6, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              ×
            </button>
          )}
        </div>

        {/* Navigation tabs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {availableTabs.map((tab) => (
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
        {!embeddedInStats && (
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
        )}

        {/* Bottom actions */}
        <div
          className="flex flex-col gap-1.5 mt-auto pt-3"
          style={{ borderTop: embeddedInStats ? "none" : `1px solid ${C.borderSub}` }}
        >
          {/* Hotkey hints */}
          {!embeddedInStats && (
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
          )}

          {onLayoutHUDs && (
            <Btn variant="accent" size="xs" onClick={onLayoutHUDs} className="w-full justify-start">
              ✥ Reposition HUDs
            </Btn>
          )}

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

          {!embeddedInStats && (
            <Btn variant="danger" size="xs" onClick={() => invoke("quit_app")} className="w-full justify-start">
              ✕ Quit App
            </Btn>
          )}
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <div className="flex-1" style={{ overflow: activeTab === "stats" ? "hidden" : "auto", minWidth: 0 }}>
        {activeTab === "general" && (
          <GeneralSettings
            settings={settings}
            onChange={setSettings}
            onCommittedSettings={(next) => {
              setSettings(next);
              setLoadedSettings(next);
            }}
            onReset={handleReset}
            saving={saving}
            saved={saved}
            error={error}
            dirty={dirty}
            lastSavedAt={lastSavedAt}
            confirmReset={confirmReset}
          />
        )}
        {activeTab === "friends" && <FriendManager settings={settings} onChange={setSettings} />}
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
  onCommittedSettings: (s: AppSettings) => void;
  onReset: () => void;
  saving: boolean;
  saved: boolean;
  error: string | null;
  dirty: boolean;
  lastSavedAt: Date | null;
  confirmReset: boolean;
}

interface HubSyncStatus {
  syncInProgress: boolean;
  pendingCount: number;
  lastSuccessAtUnixMs: number | null;
  lastError: string | null;
  lastErrorAtUnixMs: number | null;
  lastUploadedSessionId: string | null;
  lastReplayMediaUploadAtUnixMs: number | null;
  lastReplayMediaError: string | null;
  lastReplayMediaErrorAtUnixMs: number | null;
  lastReplayMediaSessionId: string | null;
}

interface HubSyncOverview {
  configured: boolean;
  enabled: boolean;
  accountLabel: string | null;
  status: HubSyncStatus;
}

interface HubDeviceLinkSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSecs: number;
  intervalSecs: number;
}

interface HubDeviceLinkPollStatus {
  status: string;
  accountLabel: string | null;
}

interface FfmpegStatus {
  available: boolean;
  source: string;
  path: string | null;
}

function formatHubUserError(message: string | null | undefined): string | null {
  const raw = message?.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (
    lower.includes("error sending request")
    || lower.includes("connection refused")
    || lower.includes("failed to connect")
    || lower.includes("dns error")
    || lower.includes("timeout")
    || lower.includes("timed out")
    || lower.includes("network")
    || lower.includes("certificate")
    || lower.includes("tls")
  ) {
    return "Could not connect to AimMod Hub. Retry later.";
  }
  return raw;
}

type GeneralSection = "basics" | "overlay" | "replay" | "hub" | "hud";

const GENERAL_SETTING_SECTIONS: { id: GeneralSection; label: string }[] = [
  { id: "basics", label: "Basics" },
  { id: "overlay", label: "Overlay" },
  { id: "replay", label: "Replay" },
  { id: "hub", label: "Hub" },
  { id: "hud", label: "HUD / Post-Run" },
];

function GeneralSettings({
  settings,
  onChange,
  onCommittedSettings,
  onReset,
  saving,
  saved,
  error,
  dirty,
  lastSavedAt,
  confirmReset,
}: GeneralSettingsProps) {
  const [monitors,      setMonitors]      = useState<MonitorInfo[]>([]);
  const [detectingUser, setDetectingUser] = useState(false);
  const [detectError,   setDetectError]   = useState<string | null>(null);
  const [hubStatus, setHubStatus] = useState<HubSyncOverview | null>(null);
  const [hubLinkSession, setHubLinkSession] = useState<HubDeviceLinkSession | null>(null);
  const [hubLinkBusy, setHubLinkBusy] = useState(false);
  const [hubResyncBusy, setHubResyncBusy] = useState(false);
  const [hubLinkError, setHubLinkError] = useState<string | null>(null);
  const [showHubApiField, setShowHubApiField] = useState(false);
  const [ffmpegStatus, setFfmpegStatus] = useState<FfmpegStatus | null>(null);
  const [ffmpegBusy, setFfmpegBusy] = useState(false);
  const [ffmpegError, setFfmpegError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<GeneralSection>("basics");

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    onChange({ ...settings, [key]: value });

  const refreshHubStatus = useCallback(async () => {
    try {
      const next = await invoke<HubSyncOverview>("get_hub_sync_status");
      setHubStatus(next);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const refreshFfmpegStatus = useCallback(async () => {
    try {
      const next = await invoke<FfmpegStatus>("get_ffmpeg_status");
      setFfmpegStatus(next);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    invoke<MonitorInfo[]>("get_monitors").then(setMonitors).catch(console.error);
  }, []);

  useEffect(() => {
    void refreshFfmpegStatus();
  }, [refreshFfmpegStatus]);

  useEffect(() => {
    const current = settings.hub_api_base_url.trim();
    setShowHubApiField(Boolean(current && current !== DEFAULT_HUB_API_BASE_URL));
  }, [settings.hub_api_base_url]);

  useEffect(() => {
    void refreshHubStatus();
    const interval = window.setInterval(() => {
      void refreshHubStatus();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [refreshHubStatus]);

  useEffect(() => {
    if (!hubLinkSession) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const result = await invoke<HubDeviceLinkPollStatus>("hub_poll_device_link", {
          baseUrl: settings.hub_api_base_url,
          deviceCode: hubLinkSession.deviceCode,
        });
        if (cancelled) return;

        if (result.status === "approved") {
          const latest = await invoke<AppSettings>("get_settings");
          if (cancelled) return;
          onCommittedSettings(latest);
          setHubLinkSession(null);
          setHubLinkBusy(false);
          setHubLinkError(null);
          await refreshHubStatus();
          return;
        }
        if (result.status === "expired") {
          setHubLinkSession(null);
          setHubLinkBusy(false);
          setHubLinkError("This connection code expired. Start the link again from AimMod.");
          await refreshHubStatus();
        }
      } catch (err) {
        if (cancelled) return;
        setHubLinkSession(null);
        setHubLinkBusy(false);
        setHubLinkError(err instanceof Error ? err.message : String(err));
        await refreshHubStatus();
      }
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, Math.max(hubLinkSession.intervalSecs, 2) * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [hubLinkSession, onChange, refreshHubStatus, settings.hub_api_base_url]);

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

  const handleStartHubLink = async () => {
    setHubLinkBusy(true);
    setHubLinkError(null);
    try {
      const session = await invoke<HubDeviceLinkSession>("hub_start_device_link", {
        baseUrl: settings.hub_api_base_url,
      });
      setHubLinkSession(session);
    } catch (err) {
      setHubLinkBusy(false);
      setHubLinkError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDisconnectHub = async () => {
    setHubLinkBusy(true);
    setHubLinkError(null);
    try {
      await invoke("hub_disconnect");
      const latest = await invoke<AppSettings>("get_settings");
      onCommittedSettings(latest);
      setHubLinkSession(null);
      await refreshHubStatus();
    } catch (err) {
      setHubLinkError(err instanceof Error ? err.message : String(err));
    } finally {
      setHubLinkBusy(false);
    }
  };

  const handleForceHubResync = async () => {
    setHubResyncBusy(true);
    setHubLinkError(null);
    try {
      await invoke("hub_force_full_resync");
      await refreshHubStatus();
    } catch (err) {
      setHubLinkError(err instanceof Error ? err.message : String(err));
    } finally {
      setHubResyncBusy(false);
    }
  };

  const handleInstallFfmpeg = async () => {
    setFfmpegBusy(true);
    setFfmpegError(null);
    try {
      const next = await invoke<FfmpegStatus>("install_ffmpeg_for_replays");
      setFfmpegStatus(next);
    } catch (err) {
      setFfmpegError(err instanceof Error ? err.message : String(err));
    } finally {
      setFfmpegBusy(false);
    }
  };

  const formatHubTime = (unixMs: number | null) =>
    unixMs ? new Date(unixMs).toLocaleString() : "Not yet";

  const ffmpegSourceLabel = ffmpegStatus?.source === "system"
    ? "System install"
    : ffmpegStatus?.source === "aimmod"
      ? "Installed for AimMod"
      : ffmpegStatus?.source === "custom"
        ? "Custom path"
        : "Not found";

  return (
    <div style={{ padding: "28px 32px", maxWidth: 640 }}>
      <div
        style={{
          marginBottom: 18,
          padding: "12px 14px",
          borderRadius: 12,
          background: error ? `${C.danger}10` : saving ? `${C.warn}10` : `${C.accent}10`,
          border: `1px solid ${error ? `${C.danger}40` : saving ? `${C.warn}40` : C.accentBorder}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: error ? C.danger : saving ? C.warn : C.accent }}>
              {error ? "Save failed" : saving ? "Saving changes" : saved ? "Saved" : "Changes save automatically"}
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: C.textSub, lineHeight: 1.6 }}>
              Most settings apply immediately and save automatically. You only need to step in if something fails.
            </div>
          </div>
          <div style={{ fontSize: 11, color: C.textFaint, whiteSpace: "nowrap" }}>
            {lastSavedAt ? `Last saved ${lastSavedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "No changes saved yet"}
          </div>
        </div>
        {error ? (
          <div style={{ marginTop: 8, fontSize: 11, color: C.danger, lineHeight: 1.6 }}>
            {error}
          </div>
        ) : null}
      </div>

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

      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          marginBottom: 22,
          paddingBottom: 10,
          background: `linear-gradient(180deg, ${C.bg} 0%, ${C.bg} 78%, rgba(0,0,0,0) 100%)`,
        }}
      >
        <div
          className="flex flex-wrap gap-2"
          style={{
            padding: "10px 0 2px",
            backdropFilter: "blur(10px)",
          }}
        >
          {GENERAL_SETTING_SECTIONS.map((section) => {
            const active = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className="am-btn"
                style={{
                  padding: "6px 10px",
                  minHeight: 0,
                  borderRadius: 8,
                  fontSize: 11,
                  background: active ? C.accentDim : C.surface,
                  border: `1px solid ${active ? C.accentBorder : C.border}`,
                  color: active ? C.accent : C.textMuted,
                  fontFamily: "inherit",
                }}
              >
                {section.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-7">

        {/* ── Username ──────────────────────────────────────────────── */}
        {activeSection === "basics" && (
        <FieldGroup label="Display Name" description="Optional local label for the app UI. Live VS mode and hub uploads now use the active in-game identity directly.">
          <div className="flex gap-2">
            <input
              type="text"
              value={settings.username}
              onChange={(e) => update("username", e.target.value)}
              placeholder="Shown locally in the desktop app"
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
        )}

        {/* ── Monitor ───────────────────────────────────────────────── */}
        {activeSection === "overlay" && (
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
        )}

        {/* ── Stats directory ───────────────────────────────────────── */}
        {activeSection === "basics" && (
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
          <p className="text-xs mt-2" style={{ color: C.textFaint }}>
            Saving restarts the CSV watcher immediately so new sessions import from the updated folder.
          </p>
        </FieldGroup>
        )}

        {/* ── Mouse DPI ─────────────────────────────────────────────── */}
        {activeSection === "basics" && (
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
        )}

        {/* ── Live Coaching ─────────────────────────────────────────── */}
        {activeSection === "overlay" && (
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
        )}

        {/* ── Overlay visibility ────────────────────────────────────── */}
        {activeSection === "overlay" && (
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
        )}

        {activeSection === "replay" && (
        <FieldGroup
          label="Replay Recording"
          description="Control replay capture smoothness and how many local replays AimMod keeps before pruning older non-favorited ones."
        >
          <GlassCard style={{ padding: "12px 14px" }}>
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-sm" style={{ color: C.textSub }}>Replay framerate</span>
                  <div className="flex items-center gap-2 flex-wrap">
                    {[12, 24, 30, 60].map((preset) => {
                      const active = settings.replay_capture_fps === preset;
                      return (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => update("replay_capture_fps", preset)}
                          className="am-btn tabular-nums"
                          style={{
                            padding: "4px 10px",
                            minHeight: 0,
                            borderRadius: 7,
                            fontSize: 11,
                            background: active ? C.accentDim : C.surface,
                            border: `1px solid ${active ? C.accentBorder : C.border}`,
                            color: active ? C.accent : C.textMuted,
                            fontFamily: "inherit",
                          }}
                        >
                          {preset} fps
                        </button>
                      );
                    })}
                    <input
                      type="number"
                      min={6}
                      max={60}
                      step={1}
                      value={settings.replay_capture_fps}
                      onChange={(e) => {
                        const next = parseInt(e.target.value, 10);
                        if (!Number.isNaN(next)) {
                          update("replay_capture_fps", Math.min(60, Math.max(6, next)));
                        }
                      }}
                      className="am-input w-24 tabular-nums"
                    />
                  </div>
                </div>
                <p className="text-xs" style={{ color: C.textFaint, lineHeight: 1.6 }}>
                  Higher framerates make replay video smoother, but they also increase replay size and capture work.
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-sm" style={{ color: C.textSub }}>Keep local replays</span>
                  <div className="flex items-center gap-2 flex-wrap">
                    {[50, 150, 300, 0].map((preset) => {
                      const active = settings.replay_keep_count === preset;
                      return (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => update("replay_keep_count", preset)}
                          className="am-btn tabular-nums"
                          style={{
                            padding: "4px 10px",
                            minHeight: 0,
                            borderRadius: 7,
                            fontSize: 11,
                            background: active ? C.accentDim : C.surface,
                            border: `1px solid ${active ? C.accentBorder : C.border}`,
                            color: active ? C.accent : C.textMuted,
                            fontFamily: "inherit",
                          }}
                        >
                          {preset === 0 ? "Unlimited" : preset}
                        </button>
                      );
                    })}
                    <input
                      type="number"
                      min={0}
                      max={5000}
                      step={1}
                      value={settings.replay_keep_count}
                      onChange={(e) => {
                        const next = parseInt(e.target.value, 10);
                        if (!Number.isNaN(next)) {
                          update("replay_keep_count", Math.min(5000, Math.max(0, next)));
                        }
                      }}
                      className="am-input w-24 tabular-nums"
                    />
                  </div>
                </div>
                <p className="text-xs" style={{ color: C.textFaint, lineHeight: 1.6 }}>
                  Favorited replays are never pruned. Set this to 0 if you want AimMod to keep every replay locally.
                </p>

                <div
                  style={{
                    borderTop: `1px solid ${C.borderSub}`,
                    paddingTop: 12,
                  }}
                  className="flex flex-col gap-3"
                >
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex flex-col gap-1">
                      <span className="text-sm" style={{ color: C.textSub }}>ffmpeg for replay export</span>
                      <span className="text-xs" style={{ color: C.textFaint, lineHeight: 1.55 }}>
                        AimMod uses an existing system ffmpeg first. If none is available, it can install a local copy into AimMod&apos;s data folder.
                      </span>
                    </div>
                    {!ffmpegStatus?.available || ffmpegStatus.source === "aimmod" ? (
                      <Btn
                        variant="ghost"
                        size="sm"
                        onClick={handleInstallFfmpeg}
                        disabled={ffmpegBusy}
                      >
                        {ffmpegBusy
                          ? "Installing…"
                          : ffmpegStatus?.available
                            ? "Reinstall local copy"
                            : "Install locally"}
                      </Btn>
                    ) : null}
                  </div>

                  <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
                    <div className="rounded-lg border p-3" style={{ borderColor: C.borderSub, background: "rgba(255,255,255,0.02)" }}>
                      <div className="text-[10px] uppercase" style={{ color: C.textFaint, letterSpacing: "0.1em" }}>Status</div>
                      <div className="text-sm mt-1" style={{ color: ffmpegStatus?.available ? C.text : C.warn }}>
                        {ffmpegStatus?.available ? ffmpegSourceLabel : "Missing"}
                      </div>
                    </div>
                    <div className="rounded-lg border p-3" style={{ borderColor: C.borderSub, background: "rgba(255,255,255,0.02)" }}>
                      <div className="text-[10px] uppercase" style={{ color: C.textFaint, letterSpacing: "0.1em" }}>Location</div>
                      <div className="text-xs mt-1 leading-relaxed break-all" style={{ color: C.textSub }}>
                        {ffmpegStatus?.path ?? "AimMod will install ffmpeg only if replay export or upload needs it."}
                      </div>
                    </div>
                  </div>

                  {ffmpegError ? (
                    <p className="text-xs leading-relaxed" style={{ color: C.danger }}>
                      {ffmpegError}
                    </p>
                  ) : null}
                </div>

                <div
                  style={{
                    borderTop: `1px solid ${C.borderSub}`,
                    paddingTop: 12,
                  }}
                  className="flex flex-col gap-3"
                >
                  <div className="flex flex-col gap-1">
                    <span className="text-sm" style={{ color: C.textSub }}>AimMod Hub replay media uploads</span>
                    <p className="text-xs" style={{ color: C.textFaint, lineHeight: 1.55 }}>
                      Summary data always stays lightweight. Replay video uploads can stay off, upload only favorites, or later use higher-quality tiers for Plus users.
                    </p>
                  </div>

                  <div className="grid gap-3 xl:grid-cols-2">
                    <div className="flex flex-col gap-2">
                      <span className="text-xs" style={{ color: C.textFaint }}>What to upload</span>
                      <div className="flex flex-wrap gap-2">
                        {([
                          ["off", "Off"],
                          ["favorites", "Favorites"],
                          ["favorites_and_pb", "Favorites + PBs"],
                          ["all", "All"],
                        ] as const).map(([value, label]) => {
                          const active = settings.replay_media_upload_mode === value;
                          return (
                            <button
                              key={value}
                              type="button"
                              onClick={() => update("replay_media_upload_mode", value)}
                              className="am-btn am-btn-ghost"
                              style={{
                                padding: "6px 10px",
                                minHeight: 0,
                                fontSize: 11,
                                background: active ? C.accentDim : C.surface,
                                border: `1px solid ${active ? C.accentBorder : C.border}`,
                                color: active ? C.accent : C.textMuted,
                                fontFamily: "inherit",
                              }}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <span className="text-xs" style={{ color: C.textFaint }}>Upload quality</span>
                      <div className="flex flex-wrap gap-2">
                        {([
                          ["standard", "Standard"],
                          ["high", "High"],
                          ["ultra", "Ultra"],
                        ] as const).map(([value, label]) => {
                          const active = settings.replay_media_upload_quality === value;
                          return (
                            <button
                              key={value}
                              type="button"
                              onClick={() => update("replay_media_upload_quality", value)}
                              className="am-btn am-btn-ghost"
                              style={{
                                padding: "6px 10px",
                                minHeight: 0,
                                fontSize: 11,
                                background: active ? C.accentDim : C.surface,
                                border: `1px solid ${active ? C.accentBorder : C.border}`,
                                color: active ? C.accent : C.textMuted,
                                fontFamily: "inherit",
                              }}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-xs" style={{ color: C.textFaint, lineHeight: 1.55 }}>
                        Higher quality means bigger files. AimMod can later unlock higher presets automatically for Plus subscriptions.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </GlassCard>
        </FieldGroup>
        )}

        {/* ── AimMod Hub ───────────────────────────────────────────── */}
        {activeSection === "hub" && (
        <FieldGroup
          label="AimMod Hub Sync"
          description="Link the desktop app to your AimMod Hub account and keep local runs synced automatically."
        >
          <GlassCard style={{ padding: "12px 14px" }}>
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: C.textSub }}>Enable authenticated sync</span>
                <Toggle
                  checked={settings.hub_sync_enabled}
                  onChange={(v) => update("hub_sync_enabled", v)}
                />
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs" style={{ color: C.textFaint }}>Hub API</span>
                    <span className="text-xs" style={{ color: C.textSub }}>
                      {(settings.hub_api_base_url || DEFAULT_HUB_API_BASE_URL).replace(/^https?:\/\//, "")}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowHubApiField((value) => !value)}
                    className="am-btn am-btn-ghost"
                    style={{
                      padding: "4px 8px",
                      minHeight: 0,
                      fontSize: 10,
                      opacity: 0.72,
                    }}
                  >
                    {showHubApiField ? "Hide" : "Change"}
                  </button>
                </div>
                {showHubApiField ? (
                  <input
                    type="text"
                    value={settings.hub_api_base_url || DEFAULT_HUB_API_BASE_URL}
                    onChange={(e) => update("hub_api_base_url", e.target.value)}
                    placeholder={DEFAULT_HUB_API_BASE_URL}
                    className="am-input w-full font-mono"
                  />
                ) : null}
              </div>

              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.03)",
                  border: `1px solid ${C.borderSub}`,
                }}
              >
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs" style={{ color: C.textFaint }}>Linked account</span>
                    <span className="text-sm" style={{ color: C.text }}>
                      {settings.hub_account_label?.trim() || hubStatus?.accountLabel || "Not connected"}
                    </span>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {settings.hub_upload_token.trim() ? (
                      <>
                        <Btn
                          variant="ghost"
                          size="sm"
                          onClick={handleForceHubResync}
                          disabled={hubLinkBusy || hubResyncBusy}
                        >
                          {hubResyncBusy ? "Queueing resync…" : "Resync all runs"}
                        </Btn>
                        <Btn variant="ghost" size="sm" onClick={handleDisconnectHub} disabled={hubLinkBusy || hubResyncBusy}>
                          Disconnect
                        </Btn>
                      </>
                    ) : (
                      <Btn
                        variant="primary"
                        size="sm"
                        onClick={handleStartHubLink}
                        disabled={hubLinkBusy || hubResyncBusy || !settings.hub_api_base_url.trim()}
                      >
                        {hubLinkBusy ? "Opening browser…" : "Connect account"}
                      </Btn>
                    )}
                  </div>
                </div>
              </div>

              {hubLinkSession ? (
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    background: `${C.accent}10`,
                    border: `1px solid ${C.accentBorder}`,
                  }}
                >
                  <div className="text-xs mb-1" style={{ color: C.textFaint }}>Connection code</div>
                  <div className="text-lg tabular-nums" style={{ color: C.accent, letterSpacing: "0.12em" }}>
                    {hubLinkSession.userCode}
                  </div>
                  <p className="text-xs mt-2 leading-relaxed" style={{ color: C.textFaint }}>
                    Your browser was opened to AimMod Hub. Sign in there if needed, approve this device, and AimMod will finish linking automatically.
                  </p>
                </div>
              ) : null}

              <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
                <div className="rounded-lg border p-3" style={{ borderColor: C.borderSub, background: "rgba(255,255,255,0.02)" }}>
                  <div className="text-[10px] uppercase" style={{ color: C.textFaint, letterSpacing: "0.1em" }}>Pending uploads</div>
                  <div className="text-lg mt-1" style={{ color: C.text }}>{hubStatus?.status.pendingCount ?? 0}</div>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: C.borderSub, background: "rgba(255,255,255,0.02)" }}>
                  <div className="text-[10px] uppercase" style={{ color: C.textFaint, letterSpacing: "0.1em" }}>Last successful sync</div>
                  <div className="text-xs mt-1 leading-relaxed" style={{ color: C.textSub }}>
                    {formatHubTime(hubStatus?.status.lastSuccessAtUnixMs ?? null)}
                  </div>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: C.borderSub, background: "rgba(255,255,255,0.02)" }}>
                  <div className="text-[10px] uppercase" style={{ color: C.textFaint, letterSpacing: "0.1em" }}>Last replay upload</div>
                  <div className="text-xs mt-1 leading-relaxed" style={{ color: C.textSub }}>
                    {formatHubTime(hubStatus?.status.lastReplayMediaUploadAtUnixMs ?? null)}
                  </div>
                </div>
              </div>

              {formatHubUserError(hubStatus?.status.lastError) ? (
                <p className="text-xs leading-relaxed" style={{ color: C.warn }}>
                  Last sync issue: {formatHubUserError(hubStatus?.status.lastError)}
                </p>
              ) : null}

              {formatHubUserError(hubStatus?.status.lastReplayMediaError) ? (
                <p className="text-xs leading-relaxed" style={{ color: C.warn }}>
                  Last replay upload issue: {formatHubUserError(hubStatus?.status.lastReplayMediaError)}
                </p>
              ) : null}

              {formatHubUserError(hubLinkError) ? (
                <p className="text-xs leading-relaxed" style={{ color: C.danger }}>
                  {formatHubUserError(hubLinkError)}
                </p>
              ) : null}

              <p className="text-xs leading-relaxed" style={{ color: C.textFaint }}>
                AimMod keeps track of what is already uploaded, retries anything that did not go through, and can send older runs again when needed.
              </p>

              <div
                style={{
                  borderTop: `1px solid ${C.borderSub}`,
                  paddingTop: 12,
                }}
                className="flex flex-col gap-3"
              >
                <div className="flex flex-col gap-1">
                  <span className="text-sm" style={{ color: C.textSub }}>Replay media uploads</span>
                  <p className="text-xs" style={{ color: C.textFaint, lineHeight: 1.55 }}>
                    Choose which replays get uploaded to AimMod Hub and at what quality. These are the same replay-upload settings available under the Replay tab.
                  </p>
                </div>

                <div className="grid gap-3 xl:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <span className="text-xs" style={{ color: C.textFaint }}>What to upload</span>
                    <div className="flex flex-wrap gap-2">
                      {([
                        ["off", "Off"],
                        ["favorites", "Favorites"],
                        ["favorites_and_pb", "Favorites + PBs"],
                        ["all", "All"],
                      ] as const).map(([value, label]) => {
                        const active = settings.replay_media_upload_mode === value;
                        return (
                          <button
                            key={value}
                            type="button"
                            onClick={() => update("replay_media_upload_mode", value)}
                            className="am-btn am-btn-ghost"
                            style={{
                              padding: "6px 10px",
                              minHeight: 0,
                              fontSize: 11,
                              background: active ? C.accentDim : C.surface,
                              border: `1px solid ${active ? C.accentBorder : C.border}`,
                              color: active ? C.accent : C.textMuted,
                              fontFamily: "inherit",
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-xs" style={{ color: C.textFaint }}>Upload quality</span>
                    <div className="flex flex-wrap gap-2">
                      {([
                        ["standard", "Standard"],
                        ["high", "High"],
                        ["ultra", "Ultra"],
                      ] as const).map(([value, label]) => {
                        const active = settings.replay_media_upload_quality === value;
                        return (
                          <button
                            key={value}
                            type="button"
                            onClick={() => update("replay_media_upload_quality", value)}
                            className="am-btn am-btn-ghost"
                            style={{
                              padding: "6px 10px",
                              minHeight: 0,
                              fontSize: 11,
                              background: active ? C.accentDim : C.surface,
                              border: `1px solid ${active ? C.accentBorder : C.border}`,
                              color: active ? C.accent : C.textMuted,
                              fontFamily: "inherit",
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-xs" style={{ color: C.textFaint, lineHeight: 1.55 }}>
                      Higher quality means bigger files. AimMod can later unlock higher presets automatically for Plus subscriptions.
                    </p>
                  </div>
                </div>

                <div
                  style={{
                    borderTop: `1px solid ${C.borderSub}`,
                    paddingTop: 12,
                  }}
                  className="flex flex-col gap-3"
                >
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex flex-col gap-1">
                      <span className="text-sm" style={{ color: C.textSub }}>ffmpeg for replay uploads</span>
                      <span className="text-xs" style={{ color: C.textFaint, lineHeight: 1.55 }}>
                        AimMod uses system ffmpeg first. If none is available, it can install a local copy just for AimMod so replay uploads and exports work.
                      </span>
                    </div>
                    {!ffmpegStatus?.available || ffmpegStatus.source === "aimmod" ? (
                      <Btn
                        variant="ghost"
                        size="sm"
                        onClick={handleInstallFfmpeg}
                        disabled={ffmpegBusy}
                      >
                        {ffmpegBusy
                          ? "Installing…"
                          : ffmpegStatus?.available
                            ? "Reinstall local copy"
                            : "Install locally"}
                      </Btn>
                    ) : null}
                  </div>

                  <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
                    <div className="rounded-lg border p-3" style={{ borderColor: C.borderSub, background: "rgba(255,255,255,0.02)" }}>
                      <div className="text-[10px] uppercase" style={{ color: C.textFaint, letterSpacing: "0.1em" }}>Status</div>
                      <div className="text-sm mt-1" style={{ color: ffmpegStatus?.available ? C.text : C.warn }}>
                        {ffmpegStatus?.available ? ffmpegSourceLabel : "Missing"}
                      </div>
                    </div>
                    <div className="rounded-lg border p-3" style={{ borderColor: C.borderSub, background: "rgba(255,255,255,0.02)" }}>
                      <div className="text-[10px] uppercase" style={{ color: C.textFaint, letterSpacing: "0.1em" }}>Location</div>
                      <div className="text-xs mt-1 leading-relaxed break-all" style={{ color: C.textSub }}>
                        {ffmpegStatus?.path ?? "AimMod will install ffmpeg only if replay export or upload needs it."}
                      </div>
                    </div>
                  </div>

                  {ffmpegError ? (
                    <p className="text-xs leading-relaxed" style={{ color: C.danger }}>
                      {ffmpegError}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </GlassCard>
        </FieldGroup>
        )}

        {/* ── HUD visibility ────────────────────────────────────────── */}
        {activeSection === "hud" && (
        <FieldGroup label="Visible HUDs" description="Show or hide individual overlay elements">
          <GlassCard style={{ padding: "12px 14px" }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              {(
                [
                  ["VS Mode", settings.hud_vsmode_visible],
                  ["Smoothness", settings.hud_smoothness_visible],
                  ["Stats", settings.hud_stats_visible],
                  ["Coaching", settings.hud_feedback_visible],
                  ["Post-session", settings.hud_post_session_visible],
                ] as const
              ).map(([label, enabled]) => (
                <span
                  key={label}
                  style={{
                    fontSize: 10,
                    padding: "4px 8px",
                    borderRadius: 999,
                    background: enabled ? `${C.accent}16` : "rgba(255,255,255,0.04)",
                    border: `1px solid ${enabled ? C.accentBorder : C.borderSub}`,
                    color: enabled ? C.accent : C.textFaint,
                  }}
                >
                  {label} {enabled ? "on" : "off"}
                </span>
              ))}
            </div>
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
        )}

        {activeSection === "hud" && (
        <FieldGroup
          label="Post-Run Flow"
          description="Control what AimMod shows after a scenario ends."
        >
          <GlassCard style={{ padding: "12px 14px" }}>
            <div className="flex flex-col gap-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-sm" style={{ color: C.textSub }}>Open Session Stats after each run</span>
                  <span className="text-xs" style={{ color: C.textFaint, lineHeight: 1.55 }}>
                    Useful if you want the deep stats window immediately after finishing. Disabled by default.
                  </span>
                </div>
                <Toggle
                  checked={settings.open_stats_window_on_session_complete}
                  onChange={(value) => update("open_stats_window_on_session_complete", value)}
                />
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-sm" style={{ color: C.textSub }}>Post-session summary duration</span>
                  <div className="flex items-center gap-2 flex-wrap">
                    {[10, 20, 30, 45, 60, 0].map((preset) => {
                      const active = settings.post_session_summary_duration_secs === preset;
                      return (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => update("post_session_summary_duration_secs", preset)}
                          className="am-btn tabular-nums"
                          style={{
                            padding: "4px 10px",
                            minHeight: 0,
                            borderRadius: 7,
                            fontSize: 11,
                            background: active ? C.accentDim : C.surface,
                            border: `1px solid ${active ? C.accentBorder : C.border}`,
                            color: active ? C.accent : C.textMuted,
                            fontFamily: "inherit",
                          }}
                        >
                          {preset === 0 ? "Until dismissed" : `${preset}s`}
                        </button>
                      );
                    })}
                    <input
                      type="number"
                      min={0}
                      max={600}
                      step={1}
                      value={settings.post_session_summary_duration_secs}
                      onChange={(e) => {
                        const next = parseInt(e.target.value, 10);
                        if (!Number.isNaN(next)) {
                          update("post_session_summary_duration_secs", Math.min(600, Math.max(0, next)));
                        }
                      }}
                      className="am-input w-24 tabular-nums"
                    />
                  </div>
                </div>
                <p className="text-xs" style={{ color: C.textFaint, lineHeight: 1.6 }}>
                  Set this to 0 if you want the summary to stay up until you dismiss it manually.
                </p>
              </div>
            </div>
          </GlassCard>
        </FieldGroup>
        )}
      </div>

      {/* ── Footer actions ───────────────────────────────────────────── */}
      <div
        className="flex items-center gap-4 mt-10 pt-6"
        style={{ borderTop: `1px solid ${C.borderSub}` }}
      >
        <Btn
          variant={confirmReset ? "danger" : "ghost"}
          size="md"
          onClick={onReset}
          disabled={saving}
        >
          {confirmReset ? "Confirm reset" : "Reset defaults"}
        </Btn>
        <span className="text-xs" style={{ color: error ? C.danger : saved ? C.accent : saving || dirty ? C.warn : C.textFaint }}>
          {error
            ? error
            : saving
              ? "Saving automatically…"
              : saved
                ? "Saved"
                : dirty
                  ? "Waiting to save…"
                  : "Changes save automatically"}
        </span>
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
