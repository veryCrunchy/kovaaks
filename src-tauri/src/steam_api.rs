/// Steam community profile resolver — no API key required.
///
/// Uses the public Steam community XML endpoint:
///   https://steamcommunity.com/profiles/<steam64id>/?xml=1
///   https://steamcommunity.com/id/<vanityurl>/?xml=1
///
/// Accepts Steam 64-bit IDs, vanity URL slugs, or full steamcommunity.com URLs.

use once_cell::sync::Lazy;

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent("kovaaks-overlay/0.1")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("failed to build reqwest client")
});

/// A resolved Steam user profile.
#[derive(Debug, Clone)]
pub struct SteamProfile {
    pub steam_id: String,
    pub display_name: String,
    pub avatar_url: String,
    /// Vanity URL slug when set (e.g. "aimicantaim"), otherwise empty.
    pub custom_url: String,
}

/// Resolve any Steam input to a `SteamProfile`. No API key required.
///
/// Accepts:
/// - Steam 64-bit ID:              `76561199417870483`
/// - Steam vanity URL slug:        `aimicantaim`
/// - Full steamcommunity.com URL:  `https://steamcommunity.com/id/aimicantaim`
///                                 `https://steamcommunity.com/profiles/76561199417870483`
pub async fn resolve_steam_user(input: &str) -> anyhow::Result<SteamProfile> {
    let input = input.trim();

    // Strip full steamcommunity.com URLs to their last path segment.
    let slug = if input.contains("steamcommunity.com") {
        input.trim_end_matches('/').rsplit('/').next().unwrap_or(input)
    } else {
        input
    };

    let url = if is_steam64_id(slug) {
        format!("https://steamcommunity.com/profiles/{}/?xml=1", slug)
    } else {
        format!("https://steamcommunity.com/id/{}/?xml=1", slug)
    };

    let body = CLIENT.get(&url).send().await?.text().await?;

    if body.contains("<error>") {
        let msg = extract_cdata(&body, "error").unwrap_or_else(|| "Profile not found".into());
        anyhow::bail!("{}", msg);
    }

    let steam_id = extract_tag(&body, "steamID64")
        .ok_or_else(|| anyhow::anyhow!("Steam profile not found or is private"))?;
    let display_name = extract_cdata(&body, "steamID").unwrap_or_else(|| slug.to_string());
    // avatarFull can appear again inside group blocks — take only the first occurrence.
    let avatar_url = extract_cdata(&body, "avatarFull").unwrap_or_default();
    let custom_url = extract_cdata(&body, "customURL").unwrap_or_default();

    Ok(SteamProfile { steam_id, display_name, avatar_url, custom_url })
}

/// Returns `true` if `s` is a Steam 64-bit ID (17 digits, starts with 7656119).
pub fn is_steam64_id(s: &str) -> bool {
    s.len() == 17 && s.starts_with("7656119") && s.chars().all(|c| c.is_ascii_digit())
}

// ─── XML helpers ──────────────────────────────────────────────────────────────

/// Extract plain-text tag content: `<tag>value</tag>`
fn extract_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)?;
    Some(xml[start..start + end].trim().to_string())
}

/// Extract CDATA content: `<tag><![CDATA[value]]></tag>`
/// Falls back to plain-text if CDATA wrapper is absent.
fn extract_cdata(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)?;
    let inner = xml[start..start + end].trim();
    if let Some(s) = inner.strip_prefix("<![CDATA[") {
        Some(s.strip_suffix("]]>").unwrap_or(s).to_string())
    } else {
        Some(inner.to_string())
    }
}
