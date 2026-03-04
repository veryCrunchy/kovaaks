#[cfg(target_os = "windows")]
use once_cell::sync::Lazy;
/// Windows TTS via SAPI / OneCore voices.
///
/// Voice listing reads both the classic SAPI5 registry hive
/// (`Speech\Voices`) and the newer OneCore hive (`Speech_OneCore\Voices`)
/// so that offline-installed neural voices (installed through Narrator in
/// Accessibility settings) are returned alongside legacy voices.
///
/// Speech synthesis uses PowerShell + `System.Speech.Synthesis` which on
/// Windows 10 1703+ can access all OneCore voices through the SAPI
/// compatibility bridge.  The PowerShell process is spawned
/// asynchronously so the Tauri command returns immediately; any already-
/// running speech process is killed first so messages never pile up.

#[cfg(target_os = "windows")]
use std::sync::Mutex;

/// The currently-running speech process (if any).  Stored so we can kill
/// it before starting new speech, mirroring `speechSynthesis.cancel()`.
#[cfg(target_os = "windows")]
static CURRENT_SPEECH: Lazy<Mutex<Option<std::process::Child>>> = Lazy::new(|| Mutex::new(None));

// ─── Voice listing ─────────────────────────────────────────────────────────────

/// Return display names of every TTS voice installed on the system.
///
/// Uses PowerShell to enumerate voices from two sources:
///   1. `System.Speech.Synthesis.SpeechSynthesizer.GetInstalledVoices()` — the
///      same API used for synthesis, so the list is guaranteed to be usable.
///   2. The OneCore/Neural registry hives (both HKLM and HKCU) — catches
///      Narrator-installed neural voices that are not bridged to SAPI5.
///
/// Results are de-duplicated and sorted.
/// On non-Windows platforms returns an empty list.
pub fn list_voices() -> Vec<String> {
    #[cfg(not(target_os = "windows"))]
    return vec![];

    #[cfg(target_os = "windows")]
    {
        // Single PowerShell script that combines both sources.
        let script = r#"
$voices = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

# Source 1: System.Speech (SAPI5 + any bridged OneCore voices)
try {
    Add-Type -AssemblyName System.Speech -EA Stop
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    foreach ($v in $s.GetInstalledVoices()) { $null = $voices.Add($v.VoiceInfo.Name) }
} catch {}

# Source 2: OneCore registry hives (Narrator-installed neural voices)
$hives = @(
    'HKLM:\SOFTWARE\Microsoft\Speech_OneCore\Voices\Tokens',
    'HKCU:\SOFTWARE\Microsoft\Speech_OneCore\Voices\Tokens'
)
foreach ($hive in $hives) {
    if (-not (Test-Path $hive)) { continue }
    foreach ($token in Get-ChildItem $hive -EA SilentlyContinue) {
        $attrPath = Join-Path $token.PSPath 'Attributes'
        if (Test-Path $attrPath) {
            $n = (Get-ItemProperty $attrPath -Name Name -EA SilentlyContinue).Name
            if ($n) { $null = $voices.Add($n.Trim()) }
        } else {
            # Fallback: use the token's default (unnamed) value
            $n = (Get-ItemProperty $token.PSPath -Name '(default)' -EA SilentlyContinue).'(default)'
            if ($n) { $null = $voices.Add($n.Trim()) }
        }
    }
}

$voices | Sort-Object
"#;

        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ])
            .output();

        match out {
            Ok(o) => String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect(),
            Err(e) => {
                log::error!("list_voices PowerShell failed: {e}");
                vec![]
            }
        }
    }
}

// ─── Speech synthesis ─────────────────────────────────────────────────────────

/// Speak `text` using the named voice (or the system default if `None`).
///
/// Spawns a hidden PowerShell process and returns immediately.  If a
/// previous speech process is still running it is killed first.
pub fn speak(text: &str, voice_name: Option<&str>) {
    #[cfg(not(target_os = "windows"))]
    let _ = (text, voice_name);

    #[cfg(target_os = "windows")]
    {
        let text_safe = text.replace('\'', "''");
        let voice_part = match voice_name {
            Some(name) => format!("$s.SelectVoice('{}'); ", name.replace('\'', "''")),
            None => String::new(),
        };

        // rate = 0 (default) feels natural; volume = 100
        let script = format!(
            "Add-Type -AssemblyName System.Speech; \
             $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
             {voice_part}\
             $s.Rate = 0; \
             $s.Volume = 100; \
             $s.SetOutputToDefaultAudioDevice(); \
             $s.Speak('{text_safe}')"
        );

        let child = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &script,
            ])
            .spawn();

        // Replace (and kill) any previous child process.
        if let Ok(mut guard) = CURRENT_SPEECH.lock() {
            if let Some(mut prev) = guard.take() {
                let _ = prev.kill();
            }
            *guard = child.ok();
        }
    }
}

/// Kill any currently-running speech process immediately.
pub fn cancel() {
    #[cfg(target_os = "windows")]
    if let Ok(mut guard) = CURRENT_SPEECH.lock() {
        if let Some(mut prev) = guard.take() {
            let _ = prev.kill();
        }
    }
}
