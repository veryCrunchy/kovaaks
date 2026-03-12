import type { FriendProfile } from "./friends";

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
  username: string;
  monitor_index: number;
  friends: FriendProfile[];
  selected_friend: string | null;
  mouse_dpi: number;
  /** Whether live coaching notifications are shown during sessions. */
  live_feedback_enabled: boolean;
  /** Verbosity: 0=minimal, 1=standard, 2=verbose. */
  live_feedback_verbosity: number;
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
  /** How many non-favorited replays to keep locally. Zero means unlimited. */
  replay_keep_count: number;
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
  /** Overlay HUD opacity (0–1). Default 1.0. */
  hud_opacity: number;
}

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
}
