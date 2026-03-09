fn raw_env_version() -> &'static str {
    option_env!("AIMMOD_DISPLAY_VERSION")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(env!("CARGO_PKG_VERSION"))
}

fn format_prerelease_label(prerelease: &str) -> String {
    let prerelease = prerelease.split('+').next().unwrap_or(prerelease).trim();
    if prerelease.is_empty() {
        return "preview".to_string();
    }

    let mut parts = prerelease.split('.');
    let channel = parts.next().unwrap_or("preview").trim().to_ascii_lowercase();
    let build_number = parts.find(|part| part.chars().all(|ch| ch.is_ascii_digit()));

    match build_number {
        Some(number) if !channel.is_empty() => format!("{channel}-{number}"),
        _ => prerelease.replace('.', "-"),
    }
}

pub fn raw_version() -> &'static str {
    raw_env_version()
}

pub fn display_version_label() -> String {
    let normalized = raw_version()
        .trim()
        .trim_start_matches(|ch| ch == 'v' || ch == 'V');

    if normalized.is_empty() {
        return "v0.0.0".to_string();
    }

    match normalized.split_once('-') {
        Some((_base, prerelease)) => format_prerelease_label(prerelease),
        None => format!("v{normalized}"),
    }
}

pub fn app_name_with_version() -> String {
    format!("AimMod • {}", display_version_label())
}