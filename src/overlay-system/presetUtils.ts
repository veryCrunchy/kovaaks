import type { AppSettings } from "../types/settings";
import type {
  OverlayPreset,
  OverlaySurfaceId,
  OverlayWidgetId,
} from "../types/overlayPresets";

export const OVERLAY_WIDGET_IDS: OverlayWidgetId[] = [
  "header",
  "live_stats",
  "progress_bar",
  "pb_pace",
  "vsmode",
  "smoothness",
  "coaching_toast",
  "post_run_summary",
  "benchmark_current",
  "benchmark_page",
  "mouse_path",
];

export function getAssignedPreset(
  settings: Pick<AppSettings, "overlay_presets" | "active_overlay_preset_id" | "active_surface_assignments">,
  surface: OverlaySurfaceId,
): OverlayPreset | null {
  const assignedId = settings.active_surface_assignments?.[surface] || settings.active_overlay_preset_id;
  return (
    settings.overlay_presets.find((preset) => preset.id === assignedId)
    ?? settings.overlay_presets.find((preset) => preset.id === settings.active_overlay_preset_id)
    ?? settings.overlay_presets[0]
    ?? null
  );
}

export function clonePreset<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function makePresetExport(preset: OverlayPreset) {
  return {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    preset,
    assets_manifest: [] as string[],
  };
}

export function normalizeTextTransform(mode: string | undefined): "none" | "uppercase" | "capitalize" {
  switch (mode) {
    case "none":
    case "capitalize":
      return mode;
    default:
      return "uppercase";
  }
}
