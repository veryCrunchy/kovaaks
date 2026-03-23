import type { FriendProfile } from "./friends";
import type {
  OverlayPreset,
  OverlaySurfaceAssignments,
} from "./overlayPresets";

// ─── Screen regions ────────────────────────────────────────────────────────────

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─── App settings ──────────────────────────────────────────────────────────────

export interface AppSettings {
  stats_dir: string;
  overlay_visible: boolean;
  monitor_index: number;
  friends: FriendProfile[];
  selected_friend: string | null;
  mouse_dpi: number;
  /** Whether live coaching notifications are shown during sessions. */
  live_feedback_enabled: boolean;
  /** Verbosity: 0=minimal, 1=standard, 2=verbose. */
  live_feedback_verbosity: number;
  /** Which coaching lane should get extra emphasis in recommendations. */
  coaching_focus_area: "balanced" | "precision" | "speed" | "control" | "consistency" | "endurance" | "transfer";
  /** How hard the coaching should push progression versus stability. */
  coaching_challenge_preference: "steady" | "balanced" | "aggressive";
  /** Whether coaching should bias toward next-session actions or longer-term structure. */
  coaching_time_preference: "next_session" | "this_week" | "long_term";
  /** Whether live coaching messages are read aloud via text-to-speech. */
  live_feedback_tts_enabled: boolean;
  /** Name of the selected TTS voice (SpeechSynthesisVoice.name). Null = auto. */
  live_feedback_tts_voice: string | null;
  /** Per-HUD visibility toggles. */
  hud_vsmode_visible: boolean;
  hud_smoothness_visible: boolean;
  hud_stats_visible: boolean;
  hud_feedback_visible: boolean;
  /** Whether the post-session overview card is shown after each run. */
  hud_post_session_visible: boolean;
  /** Whether AimMod should open the Session Stats window after a run finishes. */
  open_stats_window_on_session_complete: boolean;
  /** How long the post-session summary should stay on screen. Zero keeps it open until dismissed. */
  post_session_summary_duration_secs: number;
  /** Whether authenticated AimMod Hub sync is enabled. */
  hub_sync_enabled: boolean;
  /** Base URL for the AimMod Hub API. */
  hub_api_base_url: string;
  /** Upload credential issued automatically by AimMod Hub device linking. */
  hub_upload_token: string;
  /** Display label for the linked AimMod Hub account. */
  hub_account_label: string;
  /** Target replay capture framerate for recorded screen frames. */
  replay_capture_fps: number;
  /** Target width for encoded replay frames after downscaling. */
  replay_capture_width: number;
  /** Capture quality preset for encoded replay frames. */
  replay_capture_quality: "balanced" | "high" | "ultra";
  /** How many non-favorited replays to keep locally. Zero means unlimited. */
  replay_keep_count: number;
  /** Whether replay video captures the full game window or a center crop. */
  replay_capture_framing: "cropped" | "fullscreen";
  /** Which replays should upload replay media to AimMod Hub. */
  replay_media_upload_mode: "off" | "favorites" | "favorites_and_pb" | "all";
  /** Replay media upload quality preset. Higher presets can later be reserved for Plus tiers. */
  replay_media_upload_quality: "standard" | "high" | "ultra";
  /** Accent color source: "kovaaks" | "custom" | "default". */
  color_mode: "kovaaks" | "custom" | "default";
  /** Custom accent hex (used when color_mode is "custom"), e.g. "#ED6816". */
  custom_accent_color: string;
  /** Override path for KovaaK's Palette.ini. Empty = auto-detect. */
  kovaaks_palette_path: string;
  /** Per-color overrides applied on top of KovaaK's palette (key = palette name, value = "#RRGGBB"). */
  palette_color_overrides: Record<string, string>;
  /** Overlay HUD opacity (0–1). Default 1.0. */
  hud_opacity: number;
  /** Shared overlay presets used for OBS and the in-game overlay surface. */
  overlay_presets: OverlayPreset[];
  /** Active fallback preset when a specific surface does not choose its own preset. */
  active_overlay_preset_id: string;
  /** Per-surface preset selections. */
  active_surface_assignments: OverlaySurfaceAssignments;
  /** Benchmarks selected for benchmark overlay widgets. */
  overlay_selected_benchmark_ids: number[];
  /** Preferred benchmark for the full benchmark widget. */
  overlay_primary_benchmark_id: number | null;
}

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
}
