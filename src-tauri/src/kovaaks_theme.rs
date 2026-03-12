use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KovaaksPalette {
    /// Primary UI accent color, e.g. "#ED6816".
    pub primary_hex: Option<String>,
    /// Secondary surface / card color.
    pub secondary_hex: Option<String>,
    /// Background color.
    pub background_hex: Option<String>,
    /// SpecialCallToAction — green CTA / success.
    pub special_call_to_action_hex: Option<String>,
    /// HudEnemyHealthBar — danger / enemy red.
    pub hud_enemy_health_bar_hex: Option<String>,
    /// HudTeamHealthBar — team / friendly green.
    pub hud_team_health_bar_hex: Option<String>,
    /// HudHealthBar — player health bar.
    pub hud_health_bar_hex: Option<String>,
    /// HudSpeedBar — speed indicator.
    pub hud_speed_bar_hex: Option<String>,
    /// HudJetPackBar — jetpack / gold.
    pub hud_jet_pack_bar_hex: Option<String>,
    /// HudWeaponAmmoBar — ammo teal.
    pub hud_weapon_ammo_bar_hex: Option<String>,
    /// HudWeaponChangeBar — weapon change teal-bright.
    pub hud_weapon_change_bar_hex: Option<String>,
    /// HudBackground (may include alpha).
    pub hud_background_hex: Option<String>,
    /// HudBarBackground (may include alpha).
    pub hud_bar_background_hex: Option<String>,
    /// SpecialText — muted/sub text color.
    pub special_text_hex: Option<String>,
    /// InfoDodge — dodge info color.
    pub info_dodge_hex: Option<String>,
    /// InfoWeapon — weapon info color.
    pub info_weapon_hex: Option<String>,
    /// HudCountdownTimer color.
    pub hud_countdown_timer_hex: Option<String>,
    /// ChallengeGraph color.
    pub challenge_graph_hex: Option<String>,
    /// Path that was successfully read (for diagnostics).
    pub path_used: Option<String>,
}

pub fn default_palette_path() -> String {
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        if !local.is_empty() {
            return format!(
                r"{}\FPSAimTrainer\Saved\Config\WindowsNoEditor\Palette.ini",
                local
            );
        }
    }
    String::new()
}

fn parse_component(inner: &str, key: &str) -> Option<u8> {
    let prefix = format!("{}=", key);
    let pos = inner.find(&prefix)?;
    let rest = &inner[pos + prefix.len()..];
    let end = rest
        .find(|c: char| c == ',' || c == ')' || c.is_whitespace())
        .unwrap_or(rest.len());
    rest[..end].trim().parse().ok()
}

/// Encodes RGBA as `#RRGGBBAA`. When alpha is 255 the AA suffix is still included
/// so callers can always rely on a fixed-length 9-char string.
fn bgra_to_hex(r: u8, g: u8, b: u8, a: u8) -> String {
    format!("#{:02X}{:02X}{:02X}{:02X}", r, g, b, a)
}

/// Accepts `#RRGGBB` (6 hex digits) or `#RRGGBBAA` (8 hex digits).
/// Returns (r, g, b) only — used by the write-back path which always keeps
/// the existing alpha from Palette.ini.
fn hex_to_rgb(hex: &str) -> Option<(u8, u8, u8)> {
    let clean = hex.trim_start_matches('#');
    if clean.len() < 6 {
        return None;
    }
    let r = u8::from_str_radix(&clean[0..2], 16).ok()?;
    let g = u8::from_str_radix(&clean[2..4], 16).ok()?;
    let b = u8::from_str_radix(&clean[4..6], 16).ok()?;
    Some((r, g, b))
}

/// Rewrites named entries in a mPalette= line, preserving alpha and key order.
fn update_mpalette_line(line: &str, colors: &std::collections::HashMap<String, String>) -> String {
    let mut result = line.to_string();
    for (name, hex) in colors {
        let Some((r, g, b)) = hex_to_rgb(hex) else {
            continue;
        };
        let entry_prefix = format!("({},", name);
        let Some(entry_pos) = result.find(&entry_prefix) else {
            continue;
        };
        let inner_search_start = entry_pos + entry_prefix.len();
        let Some(rel_paren) = result[inner_search_start..].find('(') else {
            continue;
        };
        let paren_pos = inner_search_start + rel_paren;
        let Some(rel_close) = result[paren_pos + 1..].find(')') else {
            continue;
        };
        let close_pos = paren_pos + 1 + rel_close;
        let inner = result[paren_pos + 1..close_pos].to_string();
        let a = parse_component(&inner, "A").unwrap_or(255);
        let new_inner = format!("(B={},G={},R={},A={})", b, g, r, a);
        result.replace_range(paren_pos..=close_pos, &new_inner);
    }
    result
}

/// Writes one or more palette color overrides back into Palette.ini.
/// Preserves the existing alpha channel and all other colors untouched.
pub fn write_palette_colors(
    path: &str,
    colors: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    if path.is_empty() || colors.is_empty() {
        return Ok(());
    }
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("could not read {path}: {e}"))?;
    let trailing_newline = content.ends_with('\n');
    let new_lines: Vec<String> = content
        .lines()
        .map(|line| {
            if line.trim().starts_with("mPalette=") {
                update_mpalette_line(line, colors)
            } else {
                line.to_string()
            }
        })
        .collect();
    let mut new_content = new_lines.join("\n");
    if trailing_newline {
        new_content.push('\n');
    }
    std::fs::write(path, new_content).map_err(|e| format!("could not write {path}: {e}"))?;
    log::info!(
        "kovaaks_theme: wrote {} color override(s) to {path}",
        colors.len()
    );
    Ok(())
}

/// Parses a single palette entry like `Primary, (B=22,G=104,R=237,A=255)`.
fn parse_entry(entry: &str) -> Option<(String, u8, u8, u8, u8)> {
    let comma = entry.find(',')?;
    let name = entry[..comma].trim().to_string();
    let paren = entry.find('(')?;
    let inner = &entry[paren + 1..];
    let r = parse_component(inner, "R")?;
    let g = parse_component(inner, "G")?;
    let b = parse_component(inner, "B")?;
    let a = parse_component(inner, "A").unwrap_or(255);
    Some((name, r, g, b, a))
}

/// Parses all `(Name, (B=xx,G=xx,R=xx,A=xx))` entries from the mPalette line.
fn parse_mpalette_line(line: &str) -> Vec<(String, u8, u8, u8, u8)> {
    let mut entries = Vec::new();
    // Find the outer double-paren start: mPalette=((…))
    let Some(start_idx) = line.find("((") else {
        return entries;
    };
    let content = &line[start_idx + 1..]; // skip one '(' so we start at '('
    let chars: Vec<char> = content.chars().collect();
    let mut depth = 0i32;
    let mut entry_start = 0;

    for (i, &ch) in chars.iter().enumerate() {
        match ch {
            '(' => {
                if depth == 0 {
                    entry_start = i;
                }
                depth += 1;
            }
            ')' => {
                depth -= 1;
                if depth == 0 {
                    let entry_str: String = chars[entry_start + 1..i].iter().collect();
                    if let Some((name, r, g, b, a)) = parse_entry(&entry_str) {
                        entries.push((name, r, g, b, a));
                    }
                }
            }
            _ => {}
        }
    }

    entries
}

pub fn read_palette(path: &str) -> KovaaksPalette {
    if path.is_empty() {
        return KovaaksPalette::default();
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            log::debug!("kovaaks_theme: could not read palette at {path}: {e}");
            return KovaaksPalette::default();
        }
    };

    let mut palette = KovaaksPalette {
        path_used: Some(path.to_string()),
        ..Default::default()
    };

    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("mPalette=") {
            continue;
        }
        for (name, r, g, b, a) in parse_mpalette_line(trimmed) {
            let hex = bgra_to_hex(r, g, b, a);
            match name.as_str() {
                "Primary" => palette.primary_hex = Some(hex),
                "Secondary" => palette.secondary_hex = Some(hex),
                "Background" => palette.background_hex = Some(hex),
                "SpecialCallToAction" => palette.special_call_to_action_hex = Some(hex),
                "HudEnemyHealthBar" => palette.hud_enemy_health_bar_hex = Some(hex),
                "HudTeamHealthBar" => palette.hud_team_health_bar_hex = Some(hex),
                "HudHealthBar" => palette.hud_health_bar_hex = Some(hex),
                "HudSpeedBar" => palette.hud_speed_bar_hex = Some(hex),
                "HudJetPackBar" => palette.hud_jet_pack_bar_hex = Some(hex),
                "HudWeaponAmmoBar" => palette.hud_weapon_ammo_bar_hex = Some(hex),
                "HudWeaponChangeBar" => palette.hud_weapon_change_bar_hex = Some(hex),
                "HudBackground" => palette.hud_background_hex = Some(hex),
                "HudBarBackground" => palette.hud_bar_background_hex = Some(hex),
                "SpecialText" => palette.special_text_hex = Some(hex),
                "InfoDodge" => palette.info_dodge_hex = Some(hex),
                "InfoWeapon" => palette.info_weapon_hex = Some(hex),
                "HudCountdownTimer" => palette.hud_countdown_timer_hex = Some(hex),
                "ChallengeGraph" => palette.challenge_graph_hex = Some(hex),
                _ => {}
            }
        }
        break; // only one mPalette line
    }

    log::info!(
        "kovaaks_theme: palette loaded primary={:?} secondary={:?} cta={:?}",
        palette.primary_hex,
        palette.secondary_hex,
        palette.special_call_to_action_hex,
    );
    palette
}
