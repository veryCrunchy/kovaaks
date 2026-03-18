export type OverlaySurfaceId = "obs" | "desktop_private" | "in_game";

export type OverlayWidgetId =
  | "header"
  | "live_stats"
  | "progress_bar"
  | "pb_pace"
  | "vsmode"
  | "smoothness"
  | "coaching_toast"
  | "post_run_summary"
  | "benchmark_current"
  | "benchmark_page"
  | "mouse_path";

export interface OverlaySurfaceAssignments {
  obs: string;
  desktop_private: string;
  in_game: string;
}

export interface OverlayTheme {
  color_sync_mode: "app" | "preset";
  font_family: string;
  font_weight_scale: number;
  text_transform_mode: string;
  primary_color: string;
  accent_color: string;
  danger_color: string;
  warning_color: string;
  info_color: string;
  text_color: string;
  muted_text_color: string;
  background_color: string;
  background_gradient_start: string;
  background_gradient_end: string;
  surface_color: string;
  border_color: string;
  glow_color: string;
  background_opacity: number;
  border_opacity: number;
  corner_radius: number;
  shadow_strength: number;
  glass_blur: number;
  spacing_scale: number;
  animation_preset: string;
}

export interface OverlayWidgetStyle {
  show_background: boolean;
  show_border: boolean;
  show_glow: boolean;
  opacity: number;
  padding: number;
  font_scale: number;
}

export interface OverlayAnimationOverride {
  enabled: boolean;
  preset: string;
}

export interface OverlayWidgetConfig {
  id: string;
  widget_type: string;
  enabled: boolean;
  content_mode: string;
  group_id: string;
  data_bindings: Record<string, string>;
  style_overrides: OverlayWidgetStyle;
  animation_overrides: OverlayAnimationOverride;
}

export interface OverlayWidgetPlacement {
  visible: boolean;
  x: number;
  y: number;
  width: number;
  scale: number;
  z_index: number;
  anchor: string;
  opacity: number;
}

export interface SurfaceVariantConfig {
  surface_id: string;
  safe_area_padding: number;
  widget_layouts: Record<string, OverlayWidgetPlacement>;
}

export interface OverlayPreset {
  id: string;
  name: string;
  description: string;
  version: number;
  author_name: string;
  preview_accent: string;
  preview_image_path: string;
  tags: string[];
  theme: OverlayTheme;
  widgets: Record<string, OverlayWidgetConfig>;
  surface_variants: Record<string, SurfaceVariantConfig>;
}

export interface OverlayPresetExport {
  schema_version: number;
  exported_at: string;
  preset: OverlayPreset;
  assets_manifest: string[];
}
