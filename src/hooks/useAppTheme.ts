import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings } from "../types/settings";

const DEFAULT_ACCENT = "#00f5a0";

interface KovaaksPalette {
  primary_hex: string | null;
  secondary_hex: string | null;
  background_hex: string | null;
  special_call_to_action_hex: string | null;
  hud_enemy_health_bar_hex: string | null;
  hud_team_health_bar_hex: string | null;
  hud_health_bar_hex: string | null;
  hud_speed_bar_hex: string | null;
  hud_jet_pack_bar_hex: string | null;
  hud_weapon_ammo_bar_hex: string | null;
  hud_weapon_change_bar_hex: string | null;
  hud_background_hex: string | null;
  hud_bar_background_hex: string | null;
  special_text_hex: string | null;
  info_dodge_hex: string | null;
  info_weapon_hex: string | null;
  hud_countdown_timer_hex: string | null;
  challenge_graph_hex: string | null;
  path_used: string | null;
}

/** Parses 6-char (#RRGGBB) or 8-char (#RRGGBBAA) hex. Alpha defaults to 1. */
function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } | null {
  const clean = hex.replace("#", "");
  if (clean.length !== 6 && clean.length !== 8) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
    a: clean.length === 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 1,
  };
}

/**
 * Sets a CSS color var plus its companion -rgb var.
 * Always uses the solid RGB — KovaaK's alpha is for the game renderer only
 * and would make our UI look washed out if applied to backgrounds.
 */
function setVar(root: HTMLElement, name: string, hex: string) {
  const rgba = hexToRgba(hex);
  if (!rgba) return;
  const { r, g, b } = rgba;
  const solidHex = `#${hex.replace("#", "").slice(0, 6)}`;
  root.style.setProperty(name, solidHex);
  root.style.setProperty(`${name}-rgb`, `${r}, ${g}, ${b}`);
}

/** Accent is always fully opaque — alpha from Palette.ini is stripped. */
function applyAccent(hex: string) {
  const rgba = hexToRgba(hex);
  if (!rgba) return;
  const { r, g, b } = rgba;
  const solidHex = `#${hex.replace("#", "").slice(0, 6)}`;
  const root = document.documentElement;
  root.style.setProperty("--am-accent", solidHex);
  root.style.setProperty("--am-accent-rgb", `${r}, ${g}, ${b}`);
  root.style.setProperty("--am-accent-dim", `rgba(${r}, ${g}, ${b}, 0.12)`);
  root.style.setProperty("--am-accent-border", `rgba(${r}, ${g}, ${b}, 0.25)`);
  root.style.setProperty("--am-accent-glow", `rgba(${r}, ${g}, ${b}, 0.30)`);
}

function applyPalette(palette: KovaaksPalette) {
  const root = document.documentElement;
  if (palette.primary_hex)              applyAccent(palette.primary_hex);
  if (palette.secondary_hex)            setVar(root, "--am-surface",      palette.secondary_hex);
  if (palette.background_hex)           setVar(root, "--am-bg-deep",      palette.background_hex);
  if (palette.special_call_to_action_hex) setVar(root, "--am-success",    palette.special_call_to_action_hex);
  if (palette.hud_enemy_health_bar_hex) setVar(root, "--am-danger",       palette.hud_enemy_health_bar_hex);
  if (palette.hud_team_health_bar_hex)  setVar(root, "--am-team",         palette.hud_team_health_bar_hex);
  if (palette.hud_health_bar_hex)       setVar(root, "--am-health",       palette.hud_health_bar_hex);
  if (palette.hud_speed_bar_hex)        setVar(root, "--am-speed",        palette.hud_speed_bar_hex);
  if (palette.hud_jet_pack_bar_hex)     setVar(root, "--am-gold",         palette.hud_jet_pack_bar_hex);
  if (palette.hud_weapon_ammo_bar_hex)  setVar(root, "--am-teal",         palette.hud_weapon_ammo_bar_hex);
  if (palette.hud_weapon_change_bar_hex) setVar(root, "--am-teal-bright", palette.hud_weapon_change_bar_hex);
  if (palette.hud_background_hex)       setVar(root, "--am-hud-bg",       palette.hud_background_hex);
  if (palette.hud_bar_background_hex)   setVar(root, "--am-bar-bg",       palette.hud_bar_background_hex);
  if (palette.special_text_hex)         setVar(root, "--am-text-sub",     palette.special_text_hex);
  if (palette.info_dodge_hex)           setVar(root, "--am-info-dodge",   palette.info_dodge_hex);
  if (palette.info_weapon_hex)          setVar(root, "--am-info-weapon",  palette.info_weapon_hex);
  if (palette.hud_countdown_timer_hex)  setVar(root, "--am-countdown",    palette.hud_countdown_timer_hex);
  if (palette.challenge_graph_hex)      setVar(root, "--am-graph",        palette.challenge_graph_hex);
}

const KEY_TO_VAR: Record<string, string> = {
  Primary:             "--am-accent",
  Background:          "--am-bg-deep",
  Secondary:           "--am-surface",
  SpecialCallToAction: "--am-success",
  SpecialText:         "--am-text-sub",
  HudBackground:       "--am-hud-bg",
  HudBarBackground:    "--am-bar-bg",
  HudEnemyHealthBar:   "--am-danger",
  HudTeamHealthBar:    "--am-team",
  HudHealthBar:        "--am-health",
  HudSpeedBar:         "--am-speed",
  HudJetPackBar:       "--am-gold",
  HudWeaponAmmoBar:    "--am-teal",
  HudWeaponChangeBar:  "--am-teal-bright",
  HudCountdownTimer:   "--am-countdown",
  ChallengeGraph:      "--am-graph",
  InfoDodge:           "--am-info-dodge",
  InfoWeapon:          "--am-info-weapon",
};

function applyHudOpacity(settings: AppSettings) {
  const opacity = typeof settings.hud_opacity === "number"
    ? Math.min(1, Math.max(0, settings.hud_opacity))
    : 1;
  document.documentElement.style.setProperty("--am-hud-opacity", String(opacity));
}

async function loadAndApplyTheme() {
  let settings: AppSettings | null = null;
  try {
    settings = await invoke<AppSettings>("get_settings");
  } catch {
    applyAccent(DEFAULT_ACCENT);
    return;
  }

  applyHudOpacity(settings);
  const mode = settings.color_mode ?? "kovaaks";

  if (mode === "default") {
    applyAccent(DEFAULT_ACCENT);
    return;
  }

  if (mode === "custom") {
    const custom = settings.custom_accent_color?.trim();
    applyAccent(custom && /^#[0-9a-fA-F]{6}$/.test(custom) ? custom : DEFAULT_ACCENT);
    return;
  }

  // mode === "kovaaks" — read palette then layer overrides on top
  try {
    const palette = await invoke<KovaaksPalette>("read_kovaaks_palette");
    applyPalette(palette);
    if (!palette.primary_hex) applyAccent(DEFAULT_ACCENT);
  } catch {
    applyAccent(DEFAULT_ACCENT);
  }

  // Per-color overrides (6-char hex from picker, always solid — no alpha)
  const overrides = settings.palette_color_overrides ?? {};
  const root = document.documentElement;
  for (const [key, hex] of Object.entries(overrides)) {
    if (!hex || !/^#[0-9a-fA-F]{6,8}$/.test(hex)) continue;
    const cssVar = KEY_TO_VAR[key];
    if (!cssVar) continue;
    if (cssVar === "--am-accent") {
      applyAccent(hex);
    } else {
      setVar(root, cssVar, hex);
    }
  }
}

/**
 * Loads the user's KovaaK's palette (or custom/default color) and injects
 * it as CSS custom properties on :root. Re-runs whenever settings change.
 * Call once at the app root.
 */
export function useAppTheme() {
  useEffect(() => {
    void loadAndApplyTheme();
    const unlisten = listen("settings-changed", () => {
      void loadAndApplyTheme();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
