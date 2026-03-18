import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Btn, GlassCard, Toggle } from "../design/ui";
import { C } from "../design/tokens";
import { OverlayRenderer } from "../overlay-system/OverlayRenderer";
import {
  OVERLAY_WIDGET_IDS,
  clonePreset,
  getAssignedPreset,
  makePresetExport,
} from "../overlay-system/presetUtils";
import type { OverlayStateEnvelope } from "../types/overlayRuntime";
import type {
  OverlayPreset,
  OverlayPresetExport,
  OverlaySurfaceId,
  OverlayWidgetPlacement,
} from "../types/overlayPresets";
import type { AppSettings } from "../types/settings";

const OBS_URL = "http://127.0.0.1:43115/browser-overlay.html?surface=obs";
const OBS_STATE_URL = "http://127.0.0.1:43115/api/streamer-overlay/state";
const OBS_EVENTS_URL = "http://127.0.0.1:43115/api/streamer-overlay/events";
const PREVIEW_BASE_WIDTH = 1920;
const PREVIEW_BASE_HEIGHT = 1080;
const BENCHMARK_CATALOG_MAX_ATTEMPTS = 4;
const BENCHMARK_CATALOG_RETRY_DELAYS_MS = [500, 1200, 2400] as const;
const SURFACES: OverlaySurfaceId[] = ["obs", "desktop_private", "in_game"];
const TEMPLATE_VARIABLES = [
  "player_name",
  "scenario_name",
  "scenario_type",
  "score",
  "accuracy",
  "spm",
  "kps",
  "pb_score",
  "pb_delta",
  "friend_name",
  "friend_score",
  "smoothness",
  "feedback_message",
  "feedback_metric",
  "last_score",
  "last_accuracy",
  "last_duration",
  "benchmark_name",
  "benchmark_rank",
  "benchmark_score",
] as const;

interface OverlayStudioProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}

interface BenchmarkListItem {
  benchmarkId: number;
  benchmarkName: string;
  benchmarkIconUrl: string;
  benchmarkAuthor: string;
  benchmarkType: string;
  playerCount: number;
}

interface BenchmarkListResponse {
  benchmarks: BenchmarkListItem[];
}

function surfaceLabel(surface: OverlaySurfaceId): string {
  switch (surface) {
    case "desktop_private":
      return "Private Desktop";
    case "in_game":
      return "In-Game";
    default:
      return "OBS";
  }
}

function newPresetId() {
  return `preset_${Date.now().toString(36)}`;
}

type SidebarTab = "widgets" | "colors" | "style" | "templates" | "benchmarks" | "obs";

const SIDEBAR_TABS: { id: SidebarTab; label: string }[] = [
  { id: "widgets", label: "Widgets" },
  { id: "colors", label: "Colors" },
  { id: "style", label: "Style" },
  { id: "templates", label: "Templates" },
  { id: "benchmarks", label: "Benchmarks" },
  { id: "obs", label: "OBS" },
];

export function OverlayStudio({ settings, onChange }: OverlayStudioProps) {
  const [surface, setSurface] = useState<OverlaySurfaceId>("obs");
  const [selectedWidget, setSelectedWidget] = useState<string>("header");
  const [liveState, setLiveState] = useState<OverlayStateEnvelope | null>(null);
  const [obsUrl, setObsUrl] = useState(OBS_URL);
  const [sourceSurface, setSourceSurface] = useState<OverlaySurfaceId>("obs");
  const [customSourceWidgets, setCustomSourceWidgets] = useState<string[]>(["header", "live_stats"]);
  const [benchmarkCatalog, setBenchmarkCatalog] = useState<BenchmarkListItem[]>([]);
  const [benchmarkFilter, setBenchmarkFilter] = useState("");
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkReloadNonce, setBenchmarkReloadNonce] = useState(0);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("widgets");
  const [previewViewport, setPreviewViewport] = useState({ width: 960, height: 540 });
  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef(settings);
  const surfaceRef = useRef(surface);
  const dragRef = useRef<{ widgetId: string; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const previewScaleX = Math.max(0.2, previewViewport.width / PREVIEW_BASE_WIDTH);
  const previewScaleY = Math.max(0.2, previewViewport.height / PREVIEW_BASE_HEIGHT);

  useEffect(() => {
    invoke<string>("get_obs_overlay_url").then(setObsUrl).catch(() => setObsUrl(OBS_URL));
  }, []);

  useEffect(() => {
    let cancelled = false;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });

    const loadBenchmarks = async () => {
      setBenchmarkLoading(true);
      setBenchmarkError(null);

      let lastError: unknown = null;
      for (let attempt = 0; attempt < BENCHMARK_CATALOG_MAX_ATTEMPTS; attempt += 1) {
        try {
          const payload = await invoke<BenchmarkListResponse>("hub_list_benchmarks");
          if (cancelled) return;
          setBenchmarkCatalog(payload.benchmarks ?? []);
          setBenchmarkError(null);
          setBenchmarkLoading(false);
          return;
        } catch (error) {
          lastError = error;
          if (cancelled) return;
          if (attempt + 1 < BENCHMARK_CATALOG_MAX_ATTEMPTS) {
            await sleep(BENCHMARK_CATALOG_RETRY_DELAYS_MS[attempt] ?? 2000);
          }
        }
      }

      if (cancelled) return;
      setBenchmarkError(
        `Benchmark catalog request failed after ${BENCHMARK_CATALOG_MAX_ATTEMPTS} attempts: ${String(lastError)}`,
      );
      setBenchmarkLoading(false);
    };

    void loadBenchmarks();
    return () => {
      cancelled = true;
    };
  }, [benchmarkReloadNonce]);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;

    fetch(OBS_STATE_URL, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: OverlayStateEnvelope) => {
        if (!cancelled) setLiveState(payload);
      })
      .catch(() => {});

    try {
      source = new EventSource(OBS_EVENTS_URL);
      source.onmessage = (event) => {
        if (cancelled) return;
        try {
          setLiveState(JSON.parse(event.data) as OverlayStateEnvelope);
        } catch {}
      };
    } catch {}

    return () => {
      cancelled = true;
      source?.close();
    };
  }, []);

  useEffect(() => {
    const node = previewHostRef.current;
    if (!node) return;

    const syncSize = () => {
      const width = Math.max(320, node.clientWidth);
      const height = Math.max(180, node.clientHeight);
      setPreviewViewport((current) =>
        current.width === width && current.height === height ? current : { width, height }
      );
    };

    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(node);
    window.addEventListener("resize", syncSize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncSize);
    };
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    surfaceRef.current = surface;
  }, [surface]);

  const activePreset = useMemo(
    () => getAssignedPreset(settings, surface),
    [settings, surface],
  );
  const sourcePreset = useMemo(
    () => getAssignedPreset(settings, sourceSurface),
    [settings, sourceSurface],
  );

  const buildOverlayUrl = (nextSurface: OverlaySurfaceId, widgetIds?: string[]) => {
    let url: URL;
    try {
      url = new URL(obsUrl);
    } catch {
      url = new URL(OBS_URL);
    }
    url.searchParams.set("surface", nextSurface);
    url.searchParams.delete("widget");
    url.searchParams.delete("widgets");
    if (widgetIds?.length === 1) {
      url.searchParams.set("widget", widgetIds[0]);
    } else if (widgetIds && widgetIds.length > 1) {
      url.searchParams.set("widgets", widgetIds.join(","));
    }
    return url.toString();
  };

  const toggleCustomSourceWidget = (widgetId: string) => {
    setCustomSourceWidgets((current) =>
      current.includes(widgetId)
        ? current.filter((entry) => entry !== widgetId)
        : [...current, widgetId]
    );
  };

  const filteredBenchmarks = useMemo(() => {
    const query = benchmarkFilter.trim().toLowerCase();
    const sorted = [...benchmarkCatalog].sort((left, right) => {
      const leftSelected = settings.overlay_selected_benchmark_ids.includes(left.benchmarkId) ? 1 : 0;
      const rightSelected = settings.overlay_selected_benchmark_ids.includes(right.benchmarkId) ? 1 : 0;
      if (leftSelected !== rightSelected) return rightSelected - leftSelected;
      return left.benchmarkName.localeCompare(right.benchmarkName);
    });
    if (!query) return sorted;
    return sorted.filter((item) =>
      [item.benchmarkName, item.benchmarkAuthor, item.benchmarkType]
        .join(" ")
        .toLowerCase()
        .includes(query)
    );
  }, [benchmarkCatalog, benchmarkFilter, settings.overlay_selected_benchmark_ids]);

  const updateBenchmarkSelection = (benchmarkId: number, enabled: boolean) => {
    const next = enabled
      ? Array.from(new Set([...settings.overlay_selected_benchmark_ids, benchmarkId])).sort((a, b) => a - b)
      : settings.overlay_selected_benchmark_ids.filter((id) => id !== benchmarkId);
    onChange({
      ...settings,
      overlay_selected_benchmark_ids: next,
      overlay_primary_benchmark_id: next.includes(settings.overlay_primary_benchmark_id ?? -1)
        ? settings.overlay_primary_benchmark_id
        : (next[0] ?? null),
    });
  };

  const updateBinding = (key: string, value: string) => {
    if (!activePreset) return;
    updatePreset({
      ...activePreset,
      widgets: {
        ...activePreset.widgets,
        [selectedWidget]: {
          ...activePreset.widgets[selectedWidget],
          data_bindings: {
            ...activePreset.widgets[selectedWidget].data_bindings,
            [key]: value,
          },
        },
      },
    });
  };

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {}
  };

  const currentPresetForSurface = (nextSettings = settingsRef.current, nextSurface = surfaceRef.current) =>
    getAssignedPreset(nextSettings, nextSurface);

  const updatePreset = (nextPreset: OverlayPreset) => {
    const currentSettings = settingsRef.current;
    onChange({
      ...currentSettings,
      overlay_presets: currentSettings.overlay_presets.map((preset) =>
        preset.id === nextPreset.id ? nextPreset : preset,
      ),
    });
  };

  const replaceAssignments = (nextSurface: OverlaySurfaceId, presetId: string) => {
    const currentSettings = settingsRef.current;
    onChange({
      ...currentSettings,
      active_surface_assignments: {
        ...currentSettings.active_surface_assignments,
        [nextSurface]: presetId,
      },
    });
  };

  const duplicatePreset = () => {
    const currentSettings = settingsRef.current;
    const currentSurface = surfaceRef.current;
    const currentPreset = currentPresetForSurface(currentSettings, currentSurface);
    if (!currentPreset) return;
    const copy = clonePreset(currentPreset);
    copy.id = newPresetId();
    copy.name = `${currentPreset.name} Copy`;
    onChange({
      ...currentSettings,
      overlay_presets: [...currentSettings.overlay_presets, copy],
      active_overlay_preset_id: copy.id,
      active_surface_assignments: {
        ...currentSettings.active_surface_assignments,
        [currentSurface]: copy.id,
      },
    });
  };

  const createPreset = () => {
    const currentSettings = settingsRef.current;
    const currentSurface = surfaceRef.current;
    const base = clonePreset(currentSettings.overlay_presets[0]);
    base.id = newPresetId();
    base.name = "New Overlay";
    onChange({
      ...currentSettings,
      overlay_presets: [...currentSettings.overlay_presets, base],
      active_overlay_preset_id: base.id,
      active_surface_assignments: {
        ...currentSettings.active_surface_assignments,
        [currentSurface]: base.id,
      },
    });
  };

  const deletePreset = () => {
    const currentSettings = settingsRef.current;
    const currentPreset = currentPresetForSurface(currentSettings);
    if (!currentPreset || currentSettings.overlay_presets.length <= 1) return;
    const remaining = currentSettings.overlay_presets.filter((preset) => preset.id !== currentPreset.id);
    const fallbackId = remaining[0]?.id || currentSettings.active_overlay_preset_id;
    onChange({
      ...currentSettings,
      overlay_presets: remaining,
      active_overlay_preset_id: fallbackId,
      active_surface_assignments: {
        obs: currentSettings.active_surface_assignments.obs === currentPreset.id ? fallbackId : currentSettings.active_surface_assignments.obs,
        desktop_private: currentSettings.active_surface_assignments.desktop_private === currentPreset.id ? fallbackId : currentSettings.active_surface_assignments.desktop_private,
        in_game: currentSettings.active_surface_assignments.in_game === currentPreset.id ? fallbackId : currentSettings.active_surface_assignments.in_game,
      },
    });
  };

  const exportPreset = () => {
    if (!activePreset) return;
    const blob = new Blob([JSON.stringify(makePresetExport(activePreset), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activePreset.id}.aimmod-overlay.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importPreset = async (file: File | null) => {
    if (!file) return;
    const currentSettings = settingsRef.current;
    const currentSurface = surfaceRef.current;
    const raw = await file.text();
    const parsed = JSON.parse(raw) as OverlayPreset | OverlayPresetExport;
    const preset = "preset" in parsed ? parsed.preset : parsed;
    const imported = clonePreset(preset);
    if (!imported.id) imported.id = newPresetId();
    onChange({
      ...currentSettings,
      overlay_presets: [...currentSettings.overlay_presets, imported],
      active_overlay_preset_id: imported.id,
      active_surface_assignments: {
        ...currentSettings.active_surface_assignments,
        [currentSurface]: imported.id,
      },
    });
  };

  const updateTheme = <K extends keyof OverlayPreset["theme"]>(
    key: K,
    value: OverlayPreset["theme"][K],
  ) => {
    if (!activePreset) return;
    updatePreset({
      ...activePreset,
      theme: {
        ...activePreset.theme,
        [key]: value,
      },
    });
  };

  const updatePlacement = (widgetId: string, patch: Partial<OverlayWidgetPlacement>) => {
    const currentSettings = settingsRef.current;
    const currentSurface = surfaceRef.current;
    const currentPreset = currentPresetForSurface(currentSettings, currentSurface);
    if (!currentPreset) return;
    updatePreset({
      ...currentPreset,
      surface_variants: {
        ...currentPreset.surface_variants,
        [currentSurface]: {
          ...currentPreset.surface_variants[currentSurface],
          widget_layouts: {
            ...currentPreset.surface_variants[currentSurface].widget_layouts,
            [widgetId]: {
              ...currentPreset.surface_variants[currentSurface].widget_layouts[widgetId],
              ...patch,
            },
          },
        },
      },
    });
  };

  const updateWidgetEnabled = (widgetId: string, enabled: boolean) => {
    const currentSettings = settingsRef.current;
    const currentSurface = surfaceRef.current;
    const currentPreset = currentPresetForSurface(currentSettings, currentSurface);
    if (!currentPreset) return;
    updatePreset({
      ...currentPreset,
      widgets: {
        ...currentPreset.widgets,
        [widgetId]: {
          ...currentPreset.widgets[widgetId],
          enabled,
        },
      },
      surface_variants: {
        ...currentPreset.surface_variants,
        [currentSurface]: {
          ...currentPreset.surface_variants[currentSurface],
          widget_layouts: {
            ...currentPreset.surface_variants[currentSurface].widget_layouts,
            [widgetId]: {
              ...currentPreset.surface_variants[currentSurface].widget_layouts[widgetId],
              visible: enabled,
            },
          },
        },
      },
    });
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = (event.clientX - dragRef.current.startX) / previewScaleX;
      const dy = (event.clientY - dragRef.current.startY) / previewScaleY;
      updatePlacement(dragRef.current.widgetId, {
        x: Math.round(dragRef.current.originX + dx),
        y: Math.round(dragRef.current.originY + dy),
      });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [previewScaleX, previewScaleY]);

  if (!activePreset) {
    return (
      <div style={{ padding: "28px 32px", color: C.textFaint }}>
        No overlay preset available.
      </div>
    );
  }

  const selectedPlacement = activePreset.surface_variants[surface].widget_layouts[selectedWidget];
  const selectedConfig = activePreset.widgets[selectedWidget];
  const fullSourceUrl = buildOverlayUrl(sourceSurface);
  const customSourceUrl = buildOverlayUrl(sourceSurface, customSourceWidgets);
  const previewState = liveState ?? {
    generated_at_unix_ms: Date.now(),
    active_overlay_preset_id: activePreset.id,
    active_surface_assignments: settings.active_surface_assignments,
    overlay_presets: settings.overlay_presets,
    friends: settings.friends,
    selected_friend: settings.selected_friend,
    current_user: null,
    stats_panel: null,
    mouse_metrics: null,
    session_result: null,
    live_feedback: null,
    personal_best_score: null,
    friend_scores: null,
    benchmark_state: {
      loading: false,
      last_error: null,
      selected_benchmark_ids: settings.overlay_selected_benchmark_ids,
      primary_benchmark_id: settings.overlay_primary_benchmark_id,
      scenario_name: null,
      player_steam_id: null,
      pages: [],
      matching_pages: [],
      current_scenario_matches: [],
    },
    runtime_notice: { visible: false, kind: "warning", title: "", message: "" },
    runtime_health: {
      game_running: false,
      runtime_loaded: false,
      bridge_connected: false,
      has_recent_stats: false,
      restart_required: false,
    },
  };

  return (
    <div style={{ padding: "16px 24px", width: "100%", display: "flex", flexDirection: "column", gap: 12 }}>

      {/* ── Top bar: surface tabs + preset selector + actions ── */}
      <GlassCard style={{ padding: "8px 12px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 5 }}>
          {SURFACES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setSurface(candidate)}
              className="am-btn"
              style={{
                padding: "4px 10px",
                borderRadius: 7,
                background: surface === candidate ? C.accentDim : C.surface,
                border: `1px solid ${surface === candidate ? C.accentBorder : C.border}`,
                color: surface === candidate ? C.accent : C.textMuted,
              }}
            >
              {surfaceLabel(candidate)}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <select
            className="am-input"
            value={settings.active_surface_assignments[surface]}
            onChange={(e) => replaceAssignments(surface, e.target.value)}
            style={{ width: "100%" }}
          >
            {settings.overlay_presets.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.name}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          <Btn variant="ghost" size="sm" onClick={createPreset}>New</Btn>
          <Btn variant="ghost" size="sm" onClick={duplicatePreset}>Duplicate</Btn>
          <Btn variant="ghost" size="sm" onClick={exportPreset}>Export</Btn>
          <label className="am-btn am-btn-ghost" style={{ padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>
            Import
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={(e) => {
                void importPreset(e.target.files?.[0] ?? null);
                e.currentTarget.value = "";
              }}
            />
          </label>
          <Btn variant="ghost" size="sm" onClick={deletePreset} disabled={settings.overlay_presets.length <= 1}>Delete</Btn>
        </div>
      </GlassCard>

      {/* ── Main editor: preview left, tabbed sidebar right ── */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 290px", gap: 12, alignItems: "start" }}>

        {/* Left: preview canvas */}
        <GlassCard style={{ padding: 8 }}>
          <div
            ref={previewHostRef}
            style={{
              position: "relative",
              width: "100%",
              borderRadius: 10,
              overflow: "hidden",
              background: "linear-gradient(135deg, rgba(5,10,16,0.95), rgba(8,24,19,0.95))",
              border: `1px solid ${C.border}`,
              aspectRatio: "16/9",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: PREVIEW_BASE_WIDTH,
                height: PREVIEW_BASE_HEIGHT,
                transform: `scale(${previewScaleX}, ${previewScaleY})`,
                transformOrigin: "top left",
              }}
            >
                <div
                  style={{
                    position: "absolute",
                  inset: 0,
                  backgroundImage: "linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px)",
                  backgroundSize: "48px 48px",
                  pointerEvents: "none",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  inset: "32px",
                  border: "1px dashed rgba(255,255,255,0.14)",
                  borderRadius: 10,
                  pointerEvents: "none",
                }}
              />
              <OverlayRenderer
                preset={activePreset}
                surface={surface}
                state={previewState}
                preview
                compatibilityMode={surface === "obs" ? "obs" : "default"}
                style={{ width: PREVIEW_BASE_WIDTH, height: PREVIEW_BASE_HEIGHT }}
                renderWidgetChrome={({ widgetId, placement, element }) => (
                  <div
                    key={widgetId}
                    onPointerDown={(event) => {
                      setSelectedWidget(widgetId);
                      dragRef.current = {
                        widgetId,
                        startX: event.clientX,
                        startY: event.clientY,
                        originX: placement.x,
                        originY: placement.y,
                      };
                    }}
                    style={{
                      cursor: "grab",
                      outline: widgetId === selectedWidget ? `2px solid ${C.accent}` : "none",
                      outlineOffset: 2,
                    }}
                  >
                    {element}
                  </div>
                )}
              />
            </div>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: C.textFaint, textAlign: "center" }}>
            Click or drag widgets to select and reposition
          </div>
        </GlassCard>

        {/* Right: sticky tabbed sidebar */}
        <div style={{ position: "sticky", top: 16, display: "flex", flexDirection: "column", gap: 0 }}>
          {/* Tab strip */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${SIDEBAR_TABS.length}, 1fr)`,
              background: C.surface,
              borderRadius: "10px 10px 0 0",
              border: `1px solid ${C.border}`,
              borderBottom: "none",
              overflow: "hidden",
            }}
          >
            {SIDEBAR_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSidebarTab(tab.id)}
                className="am-btn"
                style={{
                  padding: "7px 2px",
                  borderRadius: 0,
                  fontSize: 10.5,
                  fontWeight: sidebarTab === tab.id ? 700 : 400,
                  background: sidebarTab === tab.id ? C.accentDim : "transparent",
                  border: "none",
                  borderRight: `1px solid ${C.border}`,
                  borderBottom: sidebarTab === tab.id ? `2px solid ${C.accent}` : "2px solid transparent",
                  color: sidebarTab === tab.id ? C.accent : C.textMuted,
                  transition: "background 0.12s, color 0.12s",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content — scrollable */}
          <GlassCard
            style={{
              borderRadius: "0 0 10px 10px",
              padding: "10px 10px",
              maxHeight: "calc(100vh - 160px)",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {/* ── WIDGETS tab ── */}
            {sidebarTab === "widgets" && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, letterSpacing: "0.06em", textTransform: "uppercase" }}>All widgets</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {OVERLAY_WIDGET_IDS.map((widgetId) => (
                    <button
                      key={widgetId}
                      type="button"
                      onClick={() => setSelectedWidget(widgetId)}
                      className="am-btn"
                      style={{
                        justifyContent: "space-between",
                        width: "100%",
                        padding: "6px 8px",
                        borderRadius: 7,
                        background: widgetId === selectedWidget ? C.accentDim : C.surface,
                        border: `1px solid ${widgetId === selectedWidget ? C.accentBorder : C.border}`,
                        color: widgetId === selectedWidget ? C.text : C.textMuted,
                      }}
                    >
                      <span style={{ fontSize: 12 }}>{widgetId.replace(/_/g, " ")}</span>
                      <Toggle
                        checked={activePreset.widgets[widgetId].enabled}
                        onChange={(value) => updateWidgetEnabled(widgetId, value)}
                      />
                    </button>
                  ))}
                </div>

                <div style={{ borderTop: `1px solid ${C.borderSub}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                    {selectedWidget.replace(/_/g, " ")}
                  </div>
                  <div className="flex items-center justify-between">
                    <span style={{ color: C.textSub, fontSize: 12 }}>Visible on {surfaceLabel(surface)}</span>
                    <Toggle
                      checked={selectedPlacement.visible}
                      onChange={(value) => updatePlacement(selectedWidget, { visible: value })}
                    />
                  </div>
                  {([
                    ["x", 0, 1920],
                    ["y", 0, 1080],
                    ["width", 180, 760],
                    ["scale", 0.5, 1.6],
                    ["z_index", 0, 12],
                    ["opacity", 0.1, 1],
                  ] as const).map(([key, min, max]) => (
                    <div key={key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.textSub }}>
                        <span>{key}</span>
                        <span>{Number(selectedPlacement[key]).toFixed(key === "scale" || key === "opacity" ? 2 : 0)}</span>
                      </div>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={key === "scale" || key === "opacity" ? 0.01 : 1}
                        value={Number(selectedPlacement[key])}
                        onChange={(e) => updatePlacement(selectedWidget, { [key]: Number(e.target.value) })}
                      />
                    </div>
                  ))}
                  <div className="flex items-center justify-between" style={{ marginTop: 4 }}>
                    <span style={{ color: C.textSub, fontSize: 12 }}>Card background</span>
                    <Toggle
                      checked={selectedConfig.style_overrides.show_background}
                      onChange={(value) => updatePreset({ ...activePreset, widgets: { ...activePreset.widgets, [selectedWidget]: { ...selectedConfig, style_overrides: { ...selectedConfig.style_overrides, show_background: value } } } })}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span style={{ color: C.textSub, fontSize: 12 }}>Border</span>
                    <Toggle
                      checked={selectedConfig.style_overrides.show_border}
                      onChange={(value) => updatePreset({ ...activePreset, widgets: { ...activePreset.widgets, [selectedWidget]: { ...selectedConfig, style_overrides: { ...selectedConfig.style_overrides, show_border: value } } } })}
                    />
                  </div>
                </div>
              </>
            )}

            {/* ── COLORS tab ── */}
            {sidebarTab === "colors" && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, letterSpacing: "0.06em", textTransform: "uppercase" }}>Theme colors</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {([
                    ["app", "Sync App Colors"],
                    ["preset", "Use Preset Colors"],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => updateTheme("color_sync_mode", mode)}
                      className="am-btn"
                      style={{
                        padding: "5px 9px",
                        borderRadius: 7,
                        background: activePreset.theme.color_sync_mode === mode ? C.accentDim : C.surface,
                        border: `1px solid ${activePreset.theme.color_sync_mode === mode ? C.accentBorder : C.border}`,
                        color: activePreset.theme.color_sync_mode === mode ? C.accent : C.textMuted,
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: C.textFaint, lineHeight: 1.5 }}>
                  {activePreset.theme.color_sync_mode === "app"
                    ? "Uses the app color mode from General settings, including KovaaK's palette sync, custom accent, and default accent."
                    : "Uses the color values stored in this overlay preset."}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {([
                    ["primary_color", "Primary"],
                    ["accent_color", "Accent"],
                    ["danger_color", "Danger"],
                    ["background_color", "Background"],
                    ["border_color", "Border"],
                    ["glow_color", "Glow"],
                  ] as const).map(([key, label]) => (
                    <div key={key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <span style={{ fontSize: 11, color: C.textSub }}>{label}</span>
                      <input
                        type="color"
                        value={(activePreset.theme[key] as string) || "#00f5a0"}
                        onChange={(e) => updateTheme(key, e.target.value)}
                        disabled={activePreset.theme.color_sync_mode === "app"}
                        style={{ width: "100%", height: 32, borderRadius: 6, border: `1px solid ${C.border}`, cursor: "pointer" }}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* ── STYLE tab ── */}
            {sidebarTab === "style" && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, letterSpacing: "0.06em", textTransform: "uppercase" }}>Visual style</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {([
                    ["background_opacity", "Background opacity", 0.2, 1, 0.05],
                    ["corner_radius", "Corner radius", 6, 32, 1],
                    ["glass_blur", "Glass blur", 0, 24, 1],
                    ["shadow_strength", "Shadow strength", 0, 1, 0.05],
                    ["spacing_scale", "Spacing scale", 0.7, 1.6, 0.05],
                    ["font_weight_scale", "Font scale", 0.8, 1.4, 0.05],
                  ] as const).map(([key, label, min, max, step]) => (
                    <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.textSub }}>
                        <span>{label}</span>
                        <span style={{ color: C.text }}>{Number(activePreset.theme[key]).toFixed(step < 1 ? 2 : 0)}</span>
                      </div>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={step}
                        value={Number(activePreset.theme[key])}
                        onChange={(e) => updateTheme(key, Number(e.target.value))}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* ── TEMPLATES tab ── */}
            {sidebarTab === "templates" && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                  {selectedWidget.replace(/_/g, " ")} — templates
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ color: C.textSub, fontSize: 12 }}>Title</span>
                    <input className="am-input" value={selectedConfig.data_bindings.title_template || ""} placeholder="{{player_name}}" onChange={(e) => updateBinding("title_template", e.target.value)} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ color: C.textSub, fontSize: 12 }}>Subtitle</span>
                    <input className="am-input" value={selectedConfig.data_bindings.subtitle_template || ""} placeholder="{{scenario_name}}" onChange={(e) => updateBinding("subtitle_template", e.target.value)} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ color: C.textSub, fontSize: 12 }}>Body</span>
                    <textarea className="am-input" value={selectedConfig.data_bindings.body_template || ""} placeholder="PB {{pb_delta}} | ACC {{accuracy}}" onChange={(e) => updateBinding("body_template", e.target.value)} rows={4} style={{ resize: "vertical", minHeight: 72 }} />
                  </div>
                  <div style={{ fontSize: 11, color: C.textFaint, lineHeight: 1.7 }}>
                    <div style={{ marginBottom: 4, color: C.textSub }}>Available variables:</div>
                    {TEMPLATE_VARIABLES.map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => void copyText(`{{${key}}}`)}
                        className="am-btn"
                        style={{
                          display: "inline-flex",
                          padding: "1px 6px",
                          margin: "2px 3px 2px 0",
                          borderRadius: 4,
                          fontSize: 10.5,
                          background: C.surface,
                          border: `1px solid ${C.border}`,
                          color: C.textSub,
                          fontFamily: "monospace",
                          minHeight: 0,
                        }}
                        title="Click to copy"
                      >
                        {`{{${key}}}`}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* ── BENCHMARKS tab ── */}
            {sidebarTab === "benchmarks" && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, letterSpacing: "0.06em", textTransform: "uppercase" }}>Benchmarks</div>
                <input
                  className="am-input"
                  value={benchmarkFilter}
                  onChange={(e) => setBenchmarkFilter(e.target.value)}
                  placeholder="Search benchmarks…"
                />
                <select
                  className="am-input"
                  value={settings.overlay_primary_benchmark_id ?? ""}
                  onChange={(e) => onChange({ ...settings, overlay_primary_benchmark_id: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">Auto-pick first match</option>
                  {settings.overlay_selected_benchmark_ids.map((benchmarkId) => {
                    const match = benchmarkCatalog.find((entry) => entry.benchmarkId === benchmarkId);
                    return (
                      <option key={`primary-${benchmarkId}`} value={benchmarkId}>
                        {match?.benchmarkName || `Benchmark ${benchmarkId}`}
                      </option>
                    );
                  })}
                </select>
                {benchmarkLoading ? (
                  <div style={{ fontSize: 12, color: C.textFaint }}>Loading benchmark catalog...</div>
                ) : null}
                {benchmarkError ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 12, color: "#ff9cae" }}>{benchmarkError}</div>
                    <div>
                      <Btn
                        variant="ghost"
                        size="sm"
                        onClick={() => setBenchmarkReloadNonce((value) => value + 1)}
                      >
                        Retry
                      </Btn>
                    </div>
                  </div>
                ) : null}
                {settings.overlay_selected_benchmark_ids.length > 0 ? (
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {settings.overlay_selected_benchmark_ids.map((benchmarkId) => {
                      const match = benchmarkCatalog.find((entry) => entry.benchmarkId === benchmarkId);
                      const primary = settings.overlay_primary_benchmark_id === benchmarkId;
                      return (
                        <button
                          key={`selected-benchmark-${benchmarkId}`}
                          type="button"
                          onClick={() => updateBenchmarkSelection(benchmarkId, false)}
                          className="am-btn"
                          style={{
                            padding: "3px 8px",
                            minHeight: 0,
                            borderRadius: 999,
                            fontSize: 11,
                            background: primary ? C.accentDim : C.surface,
                            border: `1px solid ${primary ? C.accentBorder : C.border}`,
                            color: primary ? C.accent : C.textMuted,
                          }}
                        >
                          {match?.benchmarkName || `Benchmark ${benchmarkId}`} ×
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: C.textFaint }}>No benchmarks selected yet.</div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {filteredBenchmarks.map((benchmark) => {
                    const selected = settings.overlay_selected_benchmark_ids.includes(benchmark.benchmarkId);
                    return (
                      <button
                        key={`benchmark-${benchmark.benchmarkId}`}
                        type="button"
                        onClick={() => updateBenchmarkSelection(benchmark.benchmarkId, !selected)}
                        className="am-btn"
                        style={{
                          width: "100%",
                          textAlign: "left",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "7px 8px",
                          borderRadius: 8,
                          background: selected ? C.accentDim : C.surface,
                          border: `1px solid ${selected ? C.accentBorder : C.border}`,
                          color: selected ? C.text : C.textMuted,
                        }}
                      >
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                          <span style={{ fontSize: 11.5, fontWeight: 700, lineHeight: 1.3 }}>{benchmark.benchmarkName}</span>
                          <span style={{ fontSize: 10, color: C.textFaint }}>
                            {[benchmark.benchmarkType, benchmark.benchmarkAuthor].filter(Boolean).join(" · ")}
                          </span>
                        </div>
                        <span style={{ fontSize: 10, color: C.textFaint, whiteSpace: "nowrap", marginLeft: 6 }}>
                          {benchmark.playerCount.toLocaleString()}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {/* ── OBS tab ── */}
            {sidebarTab === "obs" && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.textFaint, letterSpacing: "0.06em", textTransform: "uppercase" }}>Browser sources</div>
                <div style={{ display: "flex", gap: 5 }}>
                  {SURFACES.map((candidate) => (
                    <button
                      key={`source-${candidate}`}
                      type="button"
                      onClick={() => setSourceSurface(candidate)}
                      className="am-btn"
                      style={{
                        flex: 1,
                        padding: "4px 6px",
                        fontSize: 11,
                        borderRadius: 7,
                        background: sourceSurface === candidate ? C.accentDim : C.surface,
                        border: `1px solid ${sourceSurface === candidate ? C.accentBorder : C.border}`,
                        color: sourceSurface === candidate ? C.accent : C.textMuted,
                      }}
                    >
                      {surfaceLabel(candidate)}
                    </button>
                  ))}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, color: C.textSub }}>Full surface URL</span>
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 6 }}>
                    <input className="am-input" readOnly value={fullSourceUrl} style={{ fontSize: 10 }} />
                    <Btn variant="ghost" size="sm" onClick={() => void copyText(fullSourceUrl)}>Copy</Btn>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: 11, color: C.textSub }}>Custom source</span>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {OVERLAY_WIDGET_IDS.map((widgetId) => {
                      const visible = sourcePreset?.widgets[widgetId]?.enabled
                        && sourcePreset?.surface_variants?.[sourceSurface]?.widget_layouts?.[widgetId]?.visible !== false;
                      const active = customSourceWidgets.includes(widgetId);
                      return (
                        <button
                          key={`builder-${widgetId}`}
                          type="button"
                          onClick={() => toggleCustomSourceWidget(widgetId)}
                          className="am-btn"
                          style={{
                            padding: "3px 7px",
                            minHeight: 0,
                            borderRadius: 999,
                            fontSize: 10.5,
                            background: active ? C.accentDim : C.surface,
                            border: `1px solid ${active ? C.accentBorder : C.border}`,
                            color: active ? C.accent : visible ? C.textMuted : C.textFaint,
                            opacity: visible ? 1 : 0.65,
                          }}
                        >
                          {widgetId.replace(/_/g, " ")}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 6 }}>
                    <input className="am-input" readOnly value={customSourceUrl} style={{ fontSize: 10 }} />
                    <Btn variant="ghost" size="sm" onClick={() => void copyText(customSourceUrl)} disabled={customSourceWidgets.length === 0}>Copy</Btn>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: 11, color: C.textSub }}>Per-widget URLs</span>
                  {OVERLAY_WIDGET_IDS.map((widgetId) => {
                    const widgetUrl = buildOverlayUrl(sourceSurface, [widgetId]);
                    return (
                      <div key={`url-${widgetId}`} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 11, color: C.textSub }}>{widgetId.replace(/_/g, " ")}</span>
                          <Btn variant="ghost" size="sm" onClick={() => void copyText(widgetUrl)}>Copy</Btn>
                        </div>
                        <input className="am-input" readOnly value={widgetUrl} style={{ fontSize: 10 }} />
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
