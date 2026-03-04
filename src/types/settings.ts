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
}

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
}
