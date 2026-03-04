param(
  [Parameter(Mandatory=$true)]
  [string]$RuntimeDir,

  [Parameter(Mandatory=$true)]
  [string]$ModMainDll,

  [Parameter(Mandatory=$true)]
  [string]$RustCoreDll,

  [ValidateSet("minimal", "full")]
  [string]$RuntimeProfile = "minimal",

  [ValidateSet("auto", "development", "production")]
  [string]$SettingsProfile = "auto",

  [string]$DestDir = "src-tauri/ue4ss"
)

$ErrorActionPreference = "Stop"

function Resolve-FullPath([string]$PathInput) {
  $resolved = Resolve-Path -Path $PathInput
  return $resolved.Path
}

$runtime = Resolve-FullPath $RuntimeDir
$modMain = Resolve-FullPath $ModMainDll
$rustCore = Resolve-FullPath $RustCoreDll

if (-not (Test-Path $runtime -PathType Container)) {
  throw "RuntimeDir is not a directory: $runtime"
}
if (-not (Test-Path $modMain -PathType Leaf)) {
  throw "ModMainDll not found: $modMain"
}
if (-not (Test-Path $rustCore -PathType Leaf)) {
  throw "RustCoreDll not found: $rustCore"
}

New-Item -ItemType Directory -Path $DestDir -Force | Out-Null

# Start clean for deterministic updates.
Get-ChildItem -Path $DestDir -Force | ForEach-Object {
  Remove-Item -Path $_.FullName -Recurse -Force
}

function Copy-RelativeFile([string]$RelativePath, [bool]$Required = $true) {
  $src = Join-Path $runtime $RelativePath
  $dst = Join-Path $DestDir $RelativePath
  if (-not (Test-Path $src -PathType Leaf)) {
    if ($Required) {
      throw "Required runtime file missing: $src"
    }
    return
  }
  $targetDir = Split-Path -Parent $dst
  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  Copy-Item -Path $src -Destination $dst -Force
}

function Copy-RelativeDir([string]$RelativePath) {
  $srcDir = Join-Path $runtime $RelativePath
  if (-not (Test-Path $srcDir -PathType Container)) {
    return
  }
  Get-ChildItem -Path $srcDir -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($runtime.Length).TrimStart('\', '/')
    $target = Join-Path $DestDir $relative
    $targetDir = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    Copy-Item -Path $_.FullName -Destination $target -Force
  }
}

if ($RuntimeProfile -eq "full") {
  # Copy runtime payload recursively, excluding archives.
  Get-ChildItem -Path $runtime -Recurse -File |
    Where-Object { $_.Extension -notin @('.zip', '.7z', '.rar') } |
    ForEach-Object {
      $relative = $_.FullName.Substring($runtime.Length).TrimStart('\', '/')
      $relativeLower = $relative.ToLowerInvariant()
      if (
        $relativeLower.StartsWith("mods/") -or
        $relativeLower -eq "dwmapi.dll" -or
        $relativeLower -eq "readme.md" -or
        $relativeLower -eq "readme.txt" -or
        $relativeLower -eq "changelog.md" -or
        $relativeLower -eq "api.txt" -or
        $relativeLower -eq "ue4ss.pdb" -or
        $relativeLower.EndsWith(".pdb")
      ) {
        return
      }
      $target = Join-Path $DestDir $relative
      $targetDir = Split-Path -Parent $target
      New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
      Copy-Item -Path $_.FullName -Destination $target -Force
    }
} else {
  # Minimal profile: only core runtime + generic templates/signatures.
  Copy-RelativeFile -RelativePath "UE4SS.dll" -Required $true
  Copy-RelativeFile -RelativePath "UE4SS-settings.ini" -Required $false
  Copy-RelativeDir -RelativePath "UE4SS_Signatures"
  Copy-RelativeDir -RelativePath "VTableLayoutTemplates"
  Copy-RelativeDir -RelativePath "MemberVarLayoutTemplates"
}

# Persist profile marker so runtime deploy can enforce copy policy.
Set-Content -Path (Join-Path $DestDir ".kovaaks_overlay_profile") -Value $RuntimeProfile -Encoding utf8

$effectiveSettingsProfile = $SettingsProfile
if ($effectiveSettingsProfile -eq "auto") {
  if ($RuntimeProfile -eq "full") {
    $effectiveSettingsProfile = "development"
  } else {
    $effectiveSettingsProfile = "production"
  }
}

$settingsTemplate = Join-Path $PSScriptRoot "ue4ss-settings/production.ini"
if ($effectiveSettingsProfile -eq "development") {
  $settingsTemplate = Join-Path $PSScriptRoot "ue4ss-settings/development.ini"
}
if (-not (Test-Path $settingsTemplate -PathType Leaf)) {
  throw "UE4SS settings template not found: $settingsTemplate"
}
Copy-Item -Path $settingsTemplate -Destination (Join-Path $DestDir "UE4SS-settings.ini") -Force
Set-Content -Path (Join-Path $DestDir ".kovaaks_overlay_settings_profile") -Value $effectiveSettingsProfile -Encoding utf8

# Install managed mod payload.
$managedModDir = Join-Path $DestDir "Mods/KovaaksBridgeMod"
$dllDir = Join-Path $managedModDir "dlls"
New-Item -ItemType Directory -Path $dllDir -Force | Out-Null

Copy-Item -Path "ue4ss-mod/mod.json" -Destination (Join-Path $managedModDir "mod.json") -Force
Copy-Item -Path $modMain -Destination (Join-Path $dllDir "main.dll") -Force
Copy-Item -Path $rustCore -Destination (Join-Path $DestDir "kovaaks_rust_core.dll") -Force
New-Item -ItemType File -Path (Join-Path $managedModDir "enabled.txt") -Force | Out-Null

$modsTxt = Join-Path $DestDir "Mods/mods.txt"
New-Item -ItemType Directory -Path (Split-Path -Parent $modsTxt) -Force | Out-Null
@(
  "; Managed by kovaaks pipeline.",
  "; C++ mods are enabled via per-mod enabled.txt only."
) | Set-Content -Path $modsTxt -Encoding utf8

Write-Host "UE4SS payload staged at $DestDir (profile=$RuntimeProfile settings=$effectiveSettingsProfile)"
