/// Steam integration — no SDK required.
///
/// Uses three sources, tried in order:
///   1. Windows registry  →  active Steam user + install path (instant, offline)
///   2. Local `localconfig.vdf`  →  friends list from disk (works even when list is private)
///   3. Steam community XML  →  public friends list fallback
///
/// Source 2 is the preferred friends source because it is always available regardless
/// of the user's privacy settings, reads in <1 ms, and needs no network.
use once_cell::sync::Lazy;

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent("aimmod/1.0")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("failed to build reqwest client")
});

// ─── Registry helpers (Windows only) ─────────────────────────────────────────

/// Returns the Steam install directory from the registry, e.g. `C:\Program Files (x86)\Steam`.
pub fn get_steam_path() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::RegKey;
        use winreg::enums::*;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu.open_subkey("Software\\Valve\\Steam").ok()?;
        key.get_value("SteamPath").ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Returns the Steam 64-bit ID of the currently logged-in Steam account.
///
/// Reads `HKCU\Software\Valve\Steam\ActiveProcess\ActiveUser` (32-bit account ID)
/// and converts it to the standard Steam64 format. Returns `None` when Steam is
/// not running, the registry key is absent, or the platform is not Windows.
pub fn get_active_steam_id() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::RegKey;
        use winreg::enums::*;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu
            .open_subkey("Software\\Valve\\Steam\\ActiveProcess")
            .ok()?;
        let account_id: u32 = key.get_value("ActiveUser").ok()?;
        if account_id == 0 {
            // Steam not running or no user logged in.
            return None;
        }
        // Steam 64-bit ID = universe base (76561197960265728) + 32-bit account ID
        Some((76_561_197_960_265_728u64 + account_id as u64).to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Returns the 32-bit Steam account ID for the currently active user.
/// This is what Steam uses in the `userdata\<id32>` directory name.
fn get_active_account_id32() -> Option<u32> {
    #[cfg(target_os = "windows")]
    {
        use winreg::RegKey;
        use winreg::enums::*;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu
            .open_subkey("Software\\Valve\\Steam\\ActiveProcess")
            .ok()?;
        let account_id: u32 = key.get_value("ActiveUser").ok()?;
        if account_id == 0 {
            None
        } else {
            Some(account_id)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

// ─── Local friends list (localconfig.vdf) ────────────────────────────────────

/// Convert a Steam 32-bit account ID to a Steam 64-bit ID.
fn id32_to_id64(id32: u32) -> String {
    (76_561_197_960_265_728u64 + id32 as u64).to_string()
}

/// Read the Steam friends list from the local `localconfig.vdf` file.
///
/// This file is written by the Steam client and is always present regardless of
/// whether the user has set their friends list to public or private.  It lives at:
///   `<SteamPath>\userdata\<account_id32>\config\localconfig.vdf`
///
/// Returns an empty `Vec` if the file is missing, unreadable, or has no friends.
pub fn get_local_friend_ids() -> Vec<String> {
    let steam_path = match get_steam_path() {
        Some(p) => p,
        None => return vec![],
    };
    let account_id = match get_active_account_id32() {
        Some(id) => id,
        None => return vec![],
    };

    // Try the primary localconfig path.
    let vdf_path = std::path::Path::new(&steam_path)
        .join("userdata")
        .join(account_id.to_string())
        .join("config")
        .join("localconfig.vdf");

    let content = match std::fs::read_to_string(&vdf_path) {
        Ok(c) => c,
        Err(e) => {
            log::debug!("localconfig.vdf not found at {:?}: {}", vdf_path, e);
            return vec![];
        }
    };

    let ids = parse_vdf_friend_ids(&content);
    log::info!(
        "get_local_friend_ids: found {} friends in {:?}",
        ids.len(),
        vdf_path
    );
    ids
}

/// Extract Steam friend Steam64 IDs from `localconfig.vdf`.
///
/// The `friends` section uses **32-bit account IDs** (not Steam64) as keys:
/// ```vdf
/// "friends"
/// {
///     "889003437"      ← owner's own ID32 (skip)
///     { … }
///     "PersonaName"    "veryCrunchy"   ← plain key-value (skip)
///     "254996711"      ← friend's ID32
///     { … }
///     "103582791429883409"  ← Steam group ID, not a personal friend (skip)
///     { … }
/// }
/// ```
/// Rules:
///   - Key is purely numeric AND followed by `{` → it's a user/group entry.
///   - 8–10 digit number → ID32 → convert to Steam64 by adding 76561197960265728.
///   - 17-digit number starting with `7656119` → already Steam64 personal account.
///   - Anything else (group IDs, etc.) → skip.
///   - Skip the owner's own ID32.
fn parse_vdf_friend_ids(content: &str) -> Vec<String> {
    let owner_id32 = get_active_account_id32().unwrap_or(0);

    let friends_start = match find_vdf_section(content, "friends") {
        Some(pos) => pos,
        None => return vec![],
    };
    let section = &content[friends_start..];
    let brace_pos = match section.find('{') {
        Some(pos) => pos,
        None => return vec![],
    };
    let inner = &section[brace_pos + 1..];
    let bytes = inner.as_bytes();

    let mut ids = Vec::new();
    let mut depth = 1usize;
    let mut i = 0usize;

    while i < bytes.len() {
        match bytes[i] {
            b'{' => {
                depth += 1;
                i += 1;
            }
            b'}' => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
                if depth == 0 {
                    break;
                }
                i += 1;
            }
            b'"' if depth == 1 => {
                // Read quoted key.
                i += 1;
                let key_start = i;
                while i < bytes.len() && bytes[i] != b'"' {
                    i += 1;
                }
                let key = &inner[key_start..i];
                if i < bytes.len() {
                    i += 1;
                } // skip closing quote

                // Skip whitespace after key.
                while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\r' | b'\n') {
                    i += 1;
                }

                if i < bytes.len() && bytes[i] == b'{' {
                    // Sub-block key — classify it.
                    if key.bytes().all(|b| b.is_ascii_digit()) && !key.is_empty() {
                        let len = key.len();
                        if (8..=10).contains(&len) {
                            if let Ok(id32) = key.parse::<u32>() {
                                if id32 != owner_id32 {
                                    ids.push(id32_to_id64(id32));
                                }
                            }
                        } else if crate::steam_api::is_steam64_id(key) {
                            ids.push(key.to_string());
                        }
                        // else: group ID — skip.
                    }
                    // Don't advance; '{' consumed on next iteration as depth++.
                } else if i < bytes.len() && bytes[i] == b'"' {
                    // Plain string value — skip it.
                    i += 1;
                    while i < bytes.len() && bytes[i] != b'"' {
                        i += 1;
                    }
                    if i < bytes.len() {
                        i += 1;
                    }
                }
            }
            _ => {
                i += 1;
            }
        }
    }

    ids
}

/// Find the byte position just after the `"<section_name>"` token in a VDF string.
fn find_vdf_section(content: &str, section: &str) -> Option<usize> {
    let needle = format!("\"{}\"", section);
    content.find(&needle).map(|pos| pos + needle.len())
}

// ─── Public XML fallback ──────────────────────────────────────────────────────

/// Fetch the public Steam friends list via the community XML API.
///
/// Only works when the user's friends list is set to public.
/// Prefer `get_local_friend_ids()` when the caller has access to the local disk.
pub async fn get_steam_friend_ids_xml(steam_id: &str) -> anyhow::Result<Vec<String>> {
    let url = format!(
        "https://steamcommunity.com/profiles/{}/friends/?xml=1",
        steam_id
    );

    let body = CLIENT.get(&url).send().await?.text().await?;

    if body.contains("<error>") || body.contains("<friendsPrivate>") {
        log::info!(
            "get_steam_friend_ids_xml: friends list is private for {}",
            steam_id
        );
        return Ok(vec![]);
    }

    Ok(parse_xml_friend_ids(&body))
}

/// Get friend Steam IDs: local VDF first; fall back to public XML if local returns nothing.
///
/// This covers both private-list users (local VDF always works) and
/// cases where the Steam install path is unavailable (network fallback).
pub async fn get_friend_ids(steam_id: &str) -> Vec<String> {
    let local = get_local_friend_ids();
    if !local.is_empty() {
        log::info!(
            "get_friend_ids: {} friends from localconfig.vdf",
            local.len()
        );
        return local;
    }

    log::info!(
        "get_friend_ids: local VDF empty, trying public XML for {}",
        steam_id
    );
    get_steam_friend_ids_xml(steam_id).await.unwrap_or_default()
}

// ─── XML parsing ──────────────────────────────────────────────────────────────

/// Extract all `<steamID64>` values inside `<friend>` blocks from the community XML.
fn parse_xml_friend_ids(xml: &str) -> Vec<String> {
    // Find the <friends> block to skip the owner's own <steamID64>.
    let friends_section = match xml.find("<friends>") {
        Some(pos) => &xml[pos..],
        None => return vec![],
    };

    let mut ids = Vec::new();
    let mut remaining = friends_section;

    while let Some(start) = remaining.find("<steamID64>") {
        remaining = &remaining[start + "<steamID64>".len()..];
        if let Some(end) = remaining.find("</steamID64>") {
            let id = remaining[..end].trim().to_string();
            if crate::steam_api::is_steam64_id(&id) {
                ids.push(id);
            }
            remaining = &remaining[end + "</steamID64>".len()..];
        } else {
            break;
        }
    }

    ids
}
