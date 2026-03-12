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
  path_used: string | null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function applyAccent(hex: string) {
  const rgb = hexToRgb(hex);
  if (!rgb) return;
  const { r, g, b } = rgb;
  const root = document.documentElement;
  root.style.setProperty("--am-accent", hex);
  root.style.setProperty("--am-accent-rgb", `${r}, ${g}, ${b}`);
  root.style.setProperty("--am-accent-dim", `rgba(${r}, ${g}, ${b}, 0.12)`);
  root.style.setProperty("--am-accent-border", `rgba(${r}, ${g}, ${b}, 0.25)`);
  root.style.setProperty("--am-accent-glow", `rgba(${r}, ${g}, ${b}, 0.30)`);
}

async function loadAndApplyTheme() {
  let settings: AppSettings | null = null;
  try {
    settings = await invoke<AppSettings>("get_settings");
  } catch {
    applyAccent(DEFAULT_ACCENT);
    return;
  }

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

  // mode === "kovaaks" — read from Palette.ini
  try {
    const palette = await invoke<KovaaksPalette>("read_kovaaks_palette");
    applyAccent(palette.primary_hex ?? DEFAULT_ACCENT);
  } catch {
    applyAccent(DEFAULT_ACCENT);
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
