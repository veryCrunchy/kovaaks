# KovaaKs Overlay

Your personal KovaaK's coach — a lightweight, anti-cheat-safe overlay for KovaaK's Aim Trainer.

> No DLL injection · No memory reading · No game process involvement

---

## Screenshots

**Smoothness HUD — live score, rating, and mouse metrics**

![Smoothness HUD](public/70t7eyHAaC.png)

**Post-session popup — final score, accuracy, and smoothness summary**

![Post-session overview](public/tdycIGunQH.png)

**Session stats — overview tab (score over time, recent runs)**

![Stats overview](public/lmRETnbKyZ.png)

**Session stats — mouse tab (smoothness trend, error metrics, insights)**

![Stats mouse tab](public/Jnw9kPg9WJ.png)

**Insights panel — actionable coaching tips based on your mouse data**

![Insights](public/rkyCMr1JbT.png)

**Region picker — each stat field needs its own region drawn around it in KovaaK's**

![Region picker setup](public/3lUYSQVhtw.png)

---

## Demo

<!-- demo gif / video here -->

---

## Features

- **VS Mode** — live score bar vs a friend's personal best fetched from the KovaaK's API. Your score is projected against their pace in real time; final delta shown after the session
- **Stats HUD** — per-field OCR reads kills, accuracy, and other stats directly from regions you define around the in-game UI
- **Smoothness HUD** — real-time mouse smoothness score (0–100), jitter, and overshoot from a global OS mouse hook; DPI-normalised so it's comparable across sensitivity setups
- **Live coaching tips** — auto-dismissing toast notifications during sessions based on your mouse metrics and stats; three verbosity levels
- **Post-session overview** — auto-detected from KovaaK's results CSV; shows final score, accuracy, and smoothness summary
- **Smoothness report** — full post-session graphs: velocity curve, jitter histogram, overshoot rate, and actionable advice
- **Friend manager** — search and add friends by KovaaK's username; profiles and most-played scenarios fetched from the KovaaK's public API
- **Layout mode** — press F10 to drag and scale every HUD independently; positions and scales persist across restarts
- **Per-HUD visibility** — toggle VS Mode, Smoothness, Stats Panel, Coaching Tips, and Post-Session overview individually
- **Multi-monitor** — pick which monitor the overlay covers

---

## Installation

Download the latest installer from the [Releases](https://github.com/veryCrunchy/kovaaks/releases/latest) page and run it.

**Requirements:** Windows 10/11 · KovaaK's installed via Steam

---

## Quick start

1. Install and launch the app
2. Right-click the system tray icon → **Open Settings**
3. Set your **KovaaK's username** and pick your **Overlay Monitor**
4. Click **Pick Region** to draw a box around the live score number in KovaaK's
5. Optionally add a friend under **Friends** and set them as your battle opponent
6. Play — the overlay is fully click-through

**Hotkeys**

| Key | Action |
|-----|--------|
| F8 | Toggle Settings panel |
| F9 | Jump to region picker |
| F10 | Toggle HUD layout mode (drag / resize) |

---

## Building from source

```bash
# Prerequisites: Rust stable, Node.js ≥ 18, pnpm
pnpm install
pnpm tauri build
```

Cross-compiling from Linux/WSL2 to Windows (uses cargo-xwin):

```bash
pnpm build:win
```

| Command | Description |
|---------|-------------|
| `pnpm tauri dev` | Dev server + Rust hot-reload (Linux/WSL2, mock OCR) |
| `pnpm build:win:dev` | Fast dev build for Windows (no LTO, incremental) |
| `pnpm build:win` | Full release build for Windows (LTO, stripped) |
| `pnpm check` | Fast Rust type-check on Linux host |

---

## Anti-cheat safety

Uses only standard OS-level APIs — the same ones used by OBS, Windows Game Bar, and accessibility software:

- **Screen capture** — Windows DXGI Desktop Duplication API (OCR only; no framebuffer stored)
- **Mouse hook** — `SetWindowsHookEx` (OS hook, not attached to any game process)
- **File watching** — reads CSV files KovaaK's writes to disk itself
