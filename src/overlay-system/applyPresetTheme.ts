import type { OverlayPreset } from "../types/overlayPresets";

function setVar(root: HTMLElement, key: string, value: string | number) {
  root.style.setProperty(key, String(value));
}

function setColorVar(root: HTMLElement, key: string, value: string) {
  const clean = value.trim().replace("#", "");
  if (!(clean.length === 6 && /^[0-9a-fA-F]{6}$/.test(clean))) {
    root.style.setProperty(key, value);
    return;
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  root.style.setProperty(key, `#${clean}`);
  root.style.setProperty(`${key}-rgb`, `${r}, ${g}, ${b}`);
}

export function applyPresetTheme(preset: OverlayPreset | null | undefined) {
  if (!preset || typeof document === "undefined") return;
  if (preset.theme.color_sync_mode === "app") return;
  const root = document.documentElement;
  const theme = preset.theme;
  setColorVar(root, "--am-accent", theme.primary_color);
  setVar(root, "--am-accent-dim", `${theme.primary_color}18`);
  setVar(root, "--am-accent-border", `${theme.primary_color}55`);
  setVar(root, "--am-accent-glow", `${theme.glow_color}55`);
  setColorVar(root, "--am-danger", theme.danger_color);
  setColorVar(root, "--am-text-sub", theme.muted_text_color);
  setColorVar(root, "--am-surface", theme.surface_color);
  setColorVar(root, "--am-bg-deep", theme.background_color);
  setVar(root, "--font-mono", theme.font_family);
}
