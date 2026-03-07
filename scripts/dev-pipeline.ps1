param(
  [string]$Ue4ssSdkDir = $env:UE4SS_SDK_DIR,
  [string]$RuntimeDir = "",
  [string]$RuntimeLocalDir = "external/ue4ss-runtime/current",
  [string]$RuntimeZipsDir = "external/ue4ss-runtime",
  [ValidateSet("minimal", "full")]
  [string]$RuntimeProfile = "minimal",
  [ValidateSet("auto", "development", "production")]
  [string]$SettingsProfile = "auto",
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Release",
  [ValidateSet("Debug", "Release")]
  [string]$ModConfiguration,
  [object]$StrippedModBuild = $null,
  [switch]$NoCache,
  [switch]$ClearCache,
  [switch]$SkipSetup,
  [switch]$SkipFrontendInstall,
  [switch]$SkipRustCoreBuild,
  [switch]$SkipModBuild,
  [switch]$SkipStage,
  [switch]$SkipOverlayBuild,
  [switch]$DevOverlayBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$ErrorView = "CategoryView"

function Write-DetailedErrorRecord(
  [System.Management.Automation.ErrorRecord]$ErrorRecord,
  [string]$Header = "PIPELINE ERROR"
) {
  if ($null -eq $ErrorRecord) {
    return
  }

  Write-Host ""
  Write-Host "========== $Header ==========" -ForegroundColor Red
  Write-Host "Error: $($ErrorRecord.Exception.Message)" -ForegroundColor Red
  Write-Host "Type: $($ErrorRecord.Exception.GetType().FullName)" -ForegroundColor Red

  $info = $ErrorRecord.InvocationInfo
  if ($null -ne $info) {
    if (-not [string]::IsNullOrWhiteSpace($info.ScriptName) -and $info.ScriptLineNumber -gt 0) {
      Write-Host "Location: $($info.ScriptName):$($info.ScriptLineNumber)" -ForegroundColor Yellow
    }
    if (-not [string]::IsNullOrWhiteSpace($info.Line)) {
      Write-Host "Command: $($info.Line.Trim())" -ForegroundColor Yellow
    } elseif (-not [string]::IsNullOrWhiteSpace($info.MyCommand.Name)) {
      Write-Host "Command: $($info.MyCommand.Name)" -ForegroundColor Yellow
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($ErrorRecord.ScriptStackTrace)) {
    Write-Host "Script stack:" -ForegroundColor Yellow
    Write-Host $ErrorRecord.ScriptStackTrace -ForegroundColor Yellow
  }

  if ($null -ne $ErrorRecord.Exception.InnerException) {
    Write-Host "Inner: $($ErrorRecord.Exception.InnerException.Message)" -ForegroundColor Yellow
  }

  if ($null -ne $ErrorRecord.ErrorDetails -and -not [string]::IsNullOrWhiteSpace($ErrorRecord.ErrorDetails.Message)) {
    Write-Host "Details: $($ErrorRecord.ErrorDetails.Message)" -ForegroundColor Yellow
  }

  Write-Host "=======================================" -ForegroundColor Red
}

trap {
  Write-DetailedErrorRecord -ErrorRecord $_ -Header "PIPELINE FAILED"
  exit 1
}

if (Get-Variable -Name IsWindows -Scope Global -ErrorAction SilentlyContinue) {
  $runningOnWindows = [bool]$IsWindows
} else {
  $runningOnWindows = ($env:OS -eq "Windows_NT")
}

if (-not $runningOnWindows) {
  throw "scripts/dev-pipeline.ps1 is Windows-host only. Use scripts/dev-pipeline.sh on WSL/Linux."
}

function Resolve-NativePath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $Path
  }
  try {
    return [System.IO.Path]::GetFullPath($Path)
  } catch {
    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    return $resolved.ProviderPath
  }
}

function Convert-ToMappedRepoPath([string]$PathValue, [string]$OriginalRepoRoot, [string]$MappedRepoRoot) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return $PathValue
  }

  if (-not $PathValue.StartsWith($OriginalRepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $PathValue
  }

  $suffix = $PathValue.Substring($OriginalRepoRoot.Length).TrimStart('\')
  if ([string]::IsNullOrWhiteSpace($suffix)) {
    return $MappedRepoRoot
  }

  return (Join-Path $MappedRepoRoot $suffix)
}

$repoRoot = Resolve-NativePath (Join-Path $PSScriptRoot "..")
$originalRepoRoot = $repoRoot
if ($repoRoot.StartsWith("\\")) {
  $driveCandidates = @("W", "V", "U", "T", "S")
  $mappedDrive = $null
  foreach ($drive in $driveCandidates) {
    if (-not (Get-PSDrive -Name $drive -ErrorAction SilentlyContinue)) {
      $mappedDrive = $drive
      break
    }
  }

  if ($null -eq $mappedDrive) {
    throw "Unable to map UNC repo path to a temporary drive letter."
  }

  New-PSDrive -Name $mappedDrive -PSProvider FileSystem -Root $repoRoot -Scope Global | Out-Null
  $repoRoot = "$mappedDrive`:\"

  if (-not [string]::IsNullOrWhiteSpace($Ue4ssSdkDir)) {
    $Ue4ssSdkDir = Convert-ToMappedRepoPath -PathValue $Ue4ssSdkDir -OriginalRepoRoot $originalRepoRoot -MappedRepoRoot $repoRoot
  }
  if (-not [string]::IsNullOrWhiteSpace($RuntimeDir)) {
    $RuntimeDir = Convert-ToMappedRepoPath -PathValue $RuntimeDir -OriginalRepoRoot $originalRepoRoot -MappedRepoRoot $repoRoot
  }
  if (-not [string]::IsNullOrWhiteSpace($RuntimeLocalDir)) {
    $RuntimeLocalDir = Convert-ToMappedRepoPath -PathValue $RuntimeLocalDir -OriginalRepoRoot $originalRepoRoot -MappedRepoRoot $repoRoot
  }
  if (-not [string]::IsNullOrWhiteSpace($RuntimeZipsDir)) {
    $RuntimeZipsDir = Convert-ToMappedRepoPath -PathValue $RuntimeZipsDir -OriginalRepoRoot $originalRepoRoot -MappedRepoRoot $repoRoot
  }
}

Set-Location $repoRoot
$target = "x86_64-pc-windows-msvc"
$script:UseCache = -not [bool]$NoCache
$script:PipelineCacheDir = Join-Path $repoRoot ".cache\pipeline"

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Get-CommandVersion([string]$Name, [string[]]$Args = @("--version")) {
  try {
    $out = & $Name @Args 2>$null
    if ($LASTEXITCODE -ne 0 -or $null -eq $out) {
      return "unknown"
    }
    return ($out | Select-Object -First 1).ToString().Trim()
  } catch {
    return "unknown"
  }
}

function Get-GitHead([string]$RepoPath) {
  if ([string]::IsNullOrWhiteSpace($RepoPath)) {
    return $null
  }
  $gitPath = Join-Path $RepoPath ".git"
  if (-not (Test-Path $gitPath)) {
    return $null
  }
  try {
    $head = & git -C $RepoPath rev-parse HEAD 2>$null | Select-Object -First 1
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($head)) {
      return $head.Trim()
    }
  } catch {
  }
  return $null
}

function Write-CommandBannerLine([string]$Label, [string]$CommandPath, [string[]]$Args = @()) {
  if ([string]::IsNullOrWhiteSpace($CommandPath) -or -not (Test-Path $CommandPath)) {
    return
  }
  try {
    $line = & $CommandPath @Args 2>&1 |
      ForEach-Object { $_.ToString().Trim() } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      Select-Object -First 1
    if (-not [string]::IsNullOrWhiteSpace($line)) {
      Write-Host ("==> {0}: {1}" -f $Label, $line)
    }
  } catch {
  }
}

function Write-FileHashLine([string]$Label, [string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue) -or -not (Test-Path $PathValue -PathType Leaf)) {
    return
  }
  try {
    $hashObj = Get-FileHash -LiteralPath $PathValue -Algorithm SHA256 -ErrorAction Stop
    if ($null -ne $hashObj -and -not [string]::IsNullOrWhiteSpace($hashObj.Hash)) {
      Write-Host ("==> {0} sha256: {1}" -f $Label, $hashObj.Hash.ToLowerInvariant())
    }
  } catch {
  }
}

function Write-VisualStudioToolchainSummary() {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) {
    return
  }

  try {
    $installPath = & $vswhere -latest -products * -property installationPath 2>$null | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($installPath)) {
      return
    }
    $installPath = $installPath.Trim()
    Write-Host "==> Visual Studio: $installPath"

    $msbuildExe = Join-Path $installPath "MSBuild\Current\Bin\MSBuild.exe"
    Write-CommandBannerLine -Label "MSBuild" -CommandPath $msbuildExe -Args @("-version", "-nologo")

    $msvcRoot = Join-Path $installPath "VC\Tools\MSVC"
    if (Test-Path $msvcRoot) {
      $toolsetDir = Get-ChildItem -Path $msvcRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name |
        Select-Object -Last 1
      if ($null -ne $toolsetDir) {
        Write-Host "==> MSVC toolset dir: $($toolsetDir.Name)"
        Write-CommandBannerLine -Label "cl" -CommandPath (Join-Path $toolsetDir.FullName "bin\Hostx64\x64\cl.exe")
        Write-CommandBannerLine -Label "lib" -CommandPath (Join-Path $toolsetDir.FullName "bin\Hostx64\x64\lib.exe")
        Write-CommandBannerLine -Label "link" -CommandPath (Join-Path $toolsetDir.FullName "bin\Hostx64\x64\link.exe")
      }
    }
  } catch {
  }
}

function Write-Ue4ssSdkRevisionSummary([string]$SdkDir) {
  if ([string]::IsNullOrWhiteSpace($SdkDir)) {
    return
  }

  Write-Host "==> UE4SS SDK: $SdkDir"

  $reUe4ssRoot = Resolve-NativePath (Join-Path $SdkDir "..")
  $templateRoot = Resolve-NativePath (Join-Path $reUe4ssRoot "..")

  $templateHead = Get-GitHead $templateRoot
  if (-not [string]::IsNullOrWhiteSpace($templateHead)) {
    Write-Host "==> UE4SSCPPTemplate HEAD: $templateHead"
  }

  $reUe4ssHead = Get-GitHead $reUe4ssRoot
  if (-not [string]::IsNullOrWhiteSpace($reUe4ssHead)) {
    Write-Host "==> RE-UE4SS HEAD: $reUe4ssHead"
  }

  $uePseudoHead = Get-GitHead (Join-Path $reUe4ssRoot "deps\first\Unreal")
  if (-not [string]::IsNullOrWhiteSpace($uePseudoHead)) {
    Write-Host "==> UEPseudo HEAD: $uePseudoHead"
  }

  $patternsleuthHead = Get-GitHead (Join-Path $reUe4ssRoot "deps\first\patternsleuth")
  if (-not [string]::IsNullOrWhiteSpace($patternsleuthHead)) {
    Write-Host "==> patternsleuth HEAD: $patternsleuthHead"
  }
}

function Get-StringSha256([string]$Value) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
  $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  return ([BitConverter]::ToString($hash).Replace("-", "").ToLowerInvariant())
}

function Convert-ToBoolOrDefault([object]$Value, [bool]$DefaultValue) {
  if ($null -eq $Value) {
    return $DefaultValue
  }
  if ($Value -is [bool]) {
    return [bool]$Value
  }
  if ($Value -is [System.SByte] -or
      $Value -is [System.Byte] -or
      $Value -is [System.Int16] -or
      $Value -is [System.UInt16] -or
      $Value -is [System.Int32] -or
      $Value -is [System.UInt32] -or
      $Value -is [System.Int64]) {
    return ([int64]$Value) -ne 0
  }
  if ($Value -is [System.UInt64]) {
    return ([uint64]$Value) -ne 0
  }

  $text = $Value.ToString().Trim().ToLowerInvariant()
  switch ($text) {
    "1" { return $true }
    "true" { return $true }
    "`$true" { return $true }
    "yes" { return $true }
    "on" { return $true }
    "0" { return $false }
    "false" { return $false }
    "`$false" { return $false }
    "no" { return $false }
    "off" { return $false }
    default {
      throw "Invalid value for -StrippedModBuild: '$Value'. Use true/false, `$true/`$false, or 1/0."
    }
  }
}

function Get-StableMsvcStagingRoot([string]$RepoIdentityPath) {
  $override = $env:KOVAAKS_MSVC_STAGING_ROOT
  if (-not [string]::IsNullOrWhiteSpace($override)) {
    return (Resolve-NativePath $override)
  }

  $baseRoot = $null
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $baseRoot = Join-Path $env:LOCALAPPDATA "kovaaks-wsl-msvc"
  } elseif (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    $baseRoot = Join-Path $env:USERPROFILE ".kovaaks-wsl-msvc"
  } else {
    throw "Unable to determine a stable staging root. Set KOVAAKS_MSVC_STAGING_ROOT."
  }

  $repoHash = Get-StringSha256 $RepoIdentityPath
  $repoSuffix = $repoHash.Substring(0, 12)
  return (Join-Path $baseRoot $repoSuffix)
}

function Get-PathsHash([string[]]$Paths) {
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($pathValue in $Paths) {
    if ([string]::IsNullOrWhiteSpace($pathValue)) {
      continue
    }
    if (Test-Path $pathValue -PathType Container) {
      Get-ChildItem -Path $pathValue -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object FullName |
        ForEach-Object {
          $hashObj = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256 -ErrorAction SilentlyContinue
          if ($null -eq $hashObj -or [string]::IsNullOrWhiteSpace($hashObj.Hash)) {
            throw "Failed to hash file '$($_.FullName)'."
          }
          $hash = $hashObj.Hash.ToLowerInvariant()
          $full = $_.FullName
          if ($full.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $full = $full.Substring($repoRoot.Length).TrimStart('\')
          }
          $lines.Add("F $full $hash")
        }
      continue
    }
    if (Test-Path $pathValue -PathType Leaf) {
      $hashObj = Get-FileHash -LiteralPath $pathValue -Algorithm SHA256 -ErrorAction SilentlyContinue
      if ($null -eq $hashObj -or [string]::IsNullOrWhiteSpace($hashObj.Hash)) {
        throw "Failed to hash file '$pathValue'."
      }
      $hash = $hashObj.Hash.ToLowerInvariant()
      $full = (Resolve-NativePath $pathValue)
      if ($full.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $full = $full.Substring($repoRoot.Length).TrimStart('\')
      }
      $lines.Add("F $full $hash")
      continue
    }
    $lines.Add("MISSING $pathValue")
  }

  return (Get-StringSha256 (($lines -join "`n")))
}

function Get-CacheStampPath([string]$StepName) {
  return (Join-Path $script:PipelineCacheDir "$StepName.key")
}

function Write-ErrorSummaryFromLog([string]$LogPath) {
  if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) {
    return
  }
  $pattern = "error|fatal|failed|undefined reference|unresolved external|LNK\d{4}|CMake Error|cannot find|No such file"
  $matches = Select-String -Path $LogPath -Pattern $pattern -CaseSensitive:$false -ErrorAction SilentlyContinue
  if ($null -eq $matches) {
    return
  }
  Write-Host "---- Error Summary (last 40 matching lines) ----" -ForegroundColor Yellow
  $matches | Select-Object -Last 40 | ForEach-Object {
    Write-Host ("{0}:{1}" -f $_.LineNumber, $_.Line)
  }
  Write-Host "------------------------------------------------" -ForegroundColor Yellow
}

function Invoke-LoggedCommand([string]$StepName, [string]$Exe, [string[]]$CommandArgs = @()) {
  $logDir = Join-Path $script:PipelineCacheDir "logs"
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $logPath = Join-Path $logDir "$StepName-$stamp.log"
  $argText = ($CommandArgs -join " ")
  Write-Host "==> [$StepName] $Exe $argText"

  $exitCode = 0
  $previousErrorActionPreference = $ErrorActionPreference
  $hasNativeErrorPreference = $null -ne (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue)
  $previousNativeErrorPreference = $false
  if ($hasNativeErrorPreference) {
    $previousNativeErrorPreference = $PSNativeCommandUseErrorActionPreference
  }
  try {
    # Native tools frequently emit warnings on stderr; treat them as log output.
    # We determine failure from process exit code.
    $ErrorActionPreference = "Continue"
    if ($hasNativeErrorPreference) {
      $PSNativeCommandUseErrorActionPreference = $false
    }
    & $Exe @CommandArgs 2>&1 | Tee-Object -FilePath $logPath
    $exitCode = $LASTEXITCODE
  } catch {
    Write-DetailedErrorRecord -ErrorRecord $_ -Header "BUILD STEP FAILED"
    Write-Host "Step: $StepName" -ForegroundColor Red
    Write-Host "Command: $Exe $argText" -ForegroundColor Red
    Write-ErrorSummaryFromLog -LogPath $logPath
    Write-Host "Full log: $logPath" -ForegroundColor Red
    throw
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($hasNativeErrorPreference) {
      $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
    }
  }
  if ($exitCode -ne 0) {
    Write-Host ""
    Write-Host "========== BUILD STEP FAILED ==========" -ForegroundColor Red
    Write-Host "Step: $StepName" -ForegroundColor Red
    Write-Host "Exit code: $exitCode" -ForegroundColor Red
    Write-Host "Command: $Exe $argText" -ForegroundColor Red
    Write-ErrorSummaryFromLog -LogPath $logPath
    Write-Host "Full log: $logPath" -ForegroundColor Red
    Write-Host "=======================================" -ForegroundColor Red
    throw "$StepName failed (exit code $exitCode)."
  }
}

function Test-CacheHit([string]$StepName, [string]$Key, [string[]]$Outputs = @()) {
  if (-not $script:UseCache) {
    return $false
  }
  $stamp = Get-CacheStampPath $StepName
  if (-not (Test-Path -LiteralPath $stamp -PathType Leaf)) {
    return $false
  }
  $existing = (Get-Content -LiteralPath $stamp -Raw -ErrorAction SilentlyContinue).Trim()
  if ($existing -ne $Key) {
    return $false
  }
  foreach ($output in $Outputs) {
    if (-not (Test-Path $output)) {
      return $false
    }
  }
  return $true
}

function Set-CacheStamp([string]$StepName, [string]$Key) {
  if (-not $script:UseCache) {
    return
  }
  $stamp = Get-CacheStampPath $StepName
  $stampParent = Split-Path -Parent $stamp
  New-Item -ItemType Directory -Path $stampParent -Force | Out-Null
  Set-Content -LiteralPath $stamp -Value $Key -Encoding utf8
}

function Invoke-RobocopyMirror([string]$SourceDir, [string]$DestinationDir, [string[]]$ExtraArgs = @()) {
  New-Item -ItemType Directory -Path $DestinationDir -Force | Out-Null
  $args = @(
    $SourceDir,
    $DestinationDir,
    "/MIR",
    "/NFL",
    "/NDL",
    "/NJH",
    "/NJS",
    "/NP",
    "/R:2",
    "/W:1"
  ) + $ExtraArgs
  & robocopy @args | Out-Null
  $robocopyExitCode = $LASTEXITCODE
  if ($robocopyExitCode -gt 7) {
    throw "robocopy failed while mirroring '$SourceDir' to '$DestinationDir' (exit code $robocopyExitCode)."
  }

  # Robocopy uses non-zero codes (0-7) for successful copy states.
  # Reset process exit code so CI pwsh wrapper doesn't treat success as failure.
  $global:LASTEXITCODE = 0
}

function Sync-Ue4ssPayloadToTauriTargets([string]$RepoRoot, [string]$TargetTriple) {
  $src = Join-Path $RepoRoot "src-tauri/ue4ss"
  if (-not (Test-Path $src -PathType Container)) {
    return
  }
  $targetRoot = Join-Path $RepoRoot "src-tauri/target/$TargetTriple"
  foreach ($profile in @("dev-windows", "release", "debug")) {
    $profileRoot = Join-Path $targetRoot $profile
    if (-not (Test-Path $profileRoot -PathType Container)) {
      continue
    }
    $dst = Join-Path $profileRoot "ue4ss"
    Invoke-RobocopyMirror -SourceDir $src -DestinationDir $dst
    Write-Host "==> Mirrored UE4SS payload to $dst"
  }
}

function Test-SdkHeaders([string]$SdkDir) {
  $hasCppUserMod = Test-Path (Join-Path $SdkDir "include/Mod/CppUserModBase.hpp") -PathType Leaf
  $hasHooks = (Test-Path (Join-Path $SdkDir "include/Unreal/Hooks.hpp") -PathType Leaf) -or
    (Test-Path (Join-Path $SdkDir "../deps/first/Unreal/include/Unreal/Hooks.hpp") -PathType Leaf)
  $hasUObjectGlobals = (Test-Path (Join-Path $SdkDir "include/Unreal/UObjectGlobals.hpp") -PathType Leaf) -or
    (Test-Path (Join-Path $SdkDir "../deps/first/Unreal/include/Unreal/UObjectGlobals.hpp") -PathType Leaf)
  $hasDynamicOutput = (Test-Path (Join-Path $SdkDir "include/DynamicOutput/Output.hpp") -PathType Leaf) -or
    (Test-Path (Join-Path $SdkDir "../deps/first/DynamicOutput/include/DynamicOutput/Output.hpp") -PathType Leaf)

  return ($hasCppUserMod -and $hasHooks -and $hasUObjectGlobals -and $hasDynamicOutput)
}

$script:PreferredReUe4ssRef = if (-not [string]::IsNullOrWhiteSpace($env:KOVAAKS_RE_UE4SS_REF)) { $env:KOVAAKS_RE_UE4SS_REF.Trim() } else { "733e59695ec01e8ae74590e33345a5e8f4e12808" }
$script:PreferredUePseudoRef = if (-not [string]::IsNullOrWhiteSpace($env:KOVAAKS_UEPSEUDO_REF)) { $env:KOVAAKS_UEPSEUDO_REF.Trim() } else { "f55ddc76b79c32e175ba7cb34095cbf752e9028d" }
$script:PreferredPatternsleuthRef = if (-not [string]::IsNullOrWhiteSpace($env:KOVAAKS_PATTERNSLEUTH_REF)) { $env:KOVAAKS_PATTERNSLEUTH_REF.Trim() } else { "75b124983ec08fc2e32d53af1388d3cb3b5d31b8" }

function Get-Ue4ssGithubToken() {
  $candidates = @(
    $env:UE4SS_GITHUB_TOKEN,
    $env:GH_TOKEN,
    $env:GITHUB_TOKEN
  )

  foreach ($candidate in $candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
      return $candidate.Trim()
    }
  }

  return $null
}

function Get-GitHubAuthGitConfigArgs([string]$Token, [bool]$ForceNonInteractive) {
  $args = @()

  if ($ForceNonInteractive -or -not [string]::IsNullOrWhiteSpace($Token)) {
    $args += @("-c", "credential.interactive=never")
    $args += @("-c", "core.askPass=")
  }

  if (-not [string]::IsNullOrWhiteSpace($Token)) {
    $authPayload = "x-access-token:$Token"
    $basicAuth = [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes($authPayload))
    $args += @("-c", "http.https://github.com/.extraheader=AUTHORIZATION: basic $basicAuth")
  }

  return $args
}

function Set-GitRepoExactRef([string]$RepoPath, [string]$Ref, [string[]]$GitAuthArgs = @()) {
  if ([string]::IsNullOrWhiteSpace($RepoPath) -or [string]::IsNullOrWhiteSpace($Ref) -or -not (Test-Path $RepoPath -PathType Container)) {
    return
  }

  $current = Get-GitHead $RepoPath
  if ($current -eq $Ref) {
    return
  }

  Write-Host "==> Pinning $(Split-Path -Leaf $RepoPath) to $Ref"
  & git @GitAuthArgs -C $RepoPath fetch --depth 1 origin $Ref
  if ($LASTEXITCODE -ne 0) { throw "git fetch failed for $RepoPath @ $Ref" }
  & git @GitAuthArgs -C $RepoPath checkout --force FETCH_HEAD
  if ($LASTEXITCODE -ne 0) { throw "git checkout failed for $RepoPath @ $Ref" }
}

function Apply-Ue4ssPinnedRevisions([string]$TemplateParent, [string]$TemplateRoot, [string[]]$GitAuthArgs = @()) {
  if ([string]::IsNullOrWhiteSpace($TemplateParent) -or [string]::IsNullOrWhiteSpace($TemplateRoot)) {
    return
  }
  if (-not (Test-Path $TemplateRoot -PathType Container)) {
    return
  }

  Set-GitRepoExactRef -RepoPath $TemplateRoot -Ref $script:PreferredReUe4ssRef -GitAuthArgs $GitAuthArgs

  $unrealRepo = Join-Path $TemplateRoot "deps/first/Unreal"
  $patternsleuthRepo = Join-Path $TemplateRoot "deps/first/patternsleuth"
  Set-GitRepoExactRef -RepoPath $unrealRepo -Ref $script:PreferredUePseudoRef -GitAuthArgs $GitAuthArgs
  Set-GitRepoExactRef -RepoPath $patternsleuthRepo -Ref $script:PreferredPatternsleuthRef -GitAuthArgs $GitAuthArgs
}

function Initialize-TemplateSubmodules([string]$RepoRoot) {
  $templateParent = Join-Path $RepoRoot "external/UE4SSCPPTemplate"
  $templateRoot = Join-Path $RepoRoot "external/UE4SSCPPTemplate/RE-UE4SS"
  Assert-Command git

  $isCi = ($env:CI -eq "true") -or ($env:GITHUB_ACTIONS -eq "true")
  $githubToken = Get-Ue4ssGithubToken
  $gitAuthArgs = Get-GitHubAuthGitConfigArgs -Token $githubToken -ForceNonInteractive:$isCi

  if ($isCi -and [string]::IsNullOrWhiteSpace($githubToken)) {
    Write-Warning "UE4SS_GITHUB_TOKEN is not set in CI. Private UEPseudo submodule access is expected to fail."
  }

  if (-not (Test-Path $templateRoot -PathType Container)) {
    Write-Host "==> UE4SSCPPTemplate missing; cloning into external/UE4SSCPPTemplate"
    if (Test-Path $templateParent) {
      Remove-Item -Path $templateParent -Recurse -Force
    }
    & git clone --depth 1 "https://github.com/UE4SS-RE/UE4SSCPPTemplate.git" $templateParent
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Unable to clone UE4SSCPPTemplate automatically."
      return
    }
  }

  if (-not (Test-Path $templateRoot -PathType Container)) {
    return
  }

  $hadGitTerminalPrompt = Test-Path Env:GIT_TERMINAL_PROMPT
  $previousGitTerminalPrompt = $env:GIT_TERMINAL_PROMPT
  if ($isCi) {
    $env:GIT_TERMINAL_PROMPT = "0"
  }

  try {
    Write-Host "==> Attempting to initialize UE4SS template submodules"
    try {
      & git @gitAuthArgs -C $templateRoot submodule sync --recursive
      if ($LASTEXITCODE -ne 0) { throw "git submodule sync failed" }
      & git @gitAuthArgs -C $templateRoot submodule update --init --recursive --depth 1
      if ($LASTEXITCODE -ne 0) { throw "git submodule update failed" }
      Apply-Ue4ssPinnedRevisions -TemplateParent $templateParent -TemplateRoot $templateRoot -GitAuthArgs $gitAuthArgs
      return
    } catch {
      Write-Warning "Submodule init via repo defaults failed; trying HTTPS URL overrides."
    }

    try {
      & git @gitAuthArgs -C $templateRoot submodule sync --recursive
      if ($LASTEXITCODE -ne 0) { throw "git submodule sync failed" }
      & git @gitAuthArgs -C $templateRoot `
        -c "submodule.deps/first/Unreal.url=https://github.com/Re-UE4SS/UEPseudo.git" `
        -c "submodule.deps/first/patternsleuth.url=https://github.com/trumank/patternsleuth.git" `
        submodule update --init --recursive --depth 1
      if ($LASTEXITCODE -ne 0) { throw "git submodule update failed" }
      Apply-Ue4ssPinnedRevisions -TemplateParent $templateParent -TemplateRoot $templateRoot -GitAuthArgs $gitAuthArgs
      return
    } catch {
      Write-Warning "Submodule init with public HTTPS failed."
    }

    Write-Warning "Submodule init failed. Continuing with existing SDK paths."
  } finally {
    if ($isCi) {
      if ($hadGitTerminalPrompt) {
        $env:GIT_TERMINAL_PROMPT = $previousGitTerminalPrompt
      } else {
        Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
      }
    }
  }
}

function Resolve-Ue4ssSdkDir([string]$ExplicitSdkDir, [string]$RepoRoot) {
  if (-not [string]::IsNullOrWhiteSpace($ExplicitSdkDir)) {
    if (-not (Test-Path $ExplicitSdkDir -PathType Container)) {
      throw "UE4SS SDK directory not found: $ExplicitSdkDir"
    }
    if (-not (Test-SdkHeaders $ExplicitSdkDir)) {
      throw "UE4SS SDK missing required headers: $ExplicitSdkDir"
    }
    return (Resolve-NativePath $ExplicitSdkDir)
  }

  $candidates = @(
    (Join-Path $RepoRoot "external/ue4ss-cppsdk"),
    (Join-Path $RepoRoot "external/UE4SSCPPTemplate/RE-UE4SS/UE4SS")
  )

  foreach ($c in $candidates) {
    if ((Test-Path $c -PathType Container) -and (Test-SdkHeaders $c)) {
      return (Resolve-NativePath $c)
    }
  }

  Initialize-TemplateSubmodules -RepoRoot $RepoRoot | Out-Host
  foreach ($c in $candidates) {
    if ((Test-Path $c -PathType Container) -and (Test-SdkHeaders $c)) {
      return (Resolve-NativePath $c)
    }
  }

  throw @"
UE4SS SDK not found in external/.
To compile the C++ mod, you need UE4SS C++ prerequisites (private UEPseudo access via Epic-linked GitHub).
Options:
  1) Clone template and init submodules:
     git clone --depth 1 https://github.com/UE4SS-RE/UE4SSCPPTemplate.git external/UE4SSCPPTemplate
     git -C external/UE4SSCPPTemplate/RE-UE4SS submodule update --init --recursive
  2) Place a complete SDK at: external/ue4ss-cppsdk
  3) Set -Ue4ssSdkDir / UE4SS_SDK_DIR to an existing SDK path.
  4) In CI, set UE4SS_GITHUB_TOKEN (PAT from an Epic-linked GitHub account with access to Re-UE4SS/UEPseudo).
"@
}

function Resolve-ModDllPath([string]$BuildDir, [string]$Config) {
  $candidates = @(
    (Join-Path $BuildDir "$Config/main.dll"),
    (Join-Path $BuildDir "main.dll")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate -PathType Leaf) {
      return (Resolve-NativePath $candidate)
    }
  }
  throw "Could not locate main.dll in $BuildDir (checked $($candidates -join ', '))."
}

function Resolve-VcToolPath([string[]]$CommandNames, [string]$ToolFileName) {
  foreach ($name in $CommandNames) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -ne $cmd) {
      return $cmd.Source
    }
  }

  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    return $null
  }

  $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($installPath)) {
    return $null
  }

  $toolMatches = @(Get-ChildItem -Path (Join-Path $installPath "VC\Tools\MSVC") -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object {
      Join-Path $_.FullName (Join-Path "bin\Hostx64\x64" $ToolFileName)
    } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })

  if ($toolMatches.Count -gt 0) {
    return $toolMatches[0]
  }

  return $null
}

function Generate-Ue4ssImportLib([string]$RuntimeRoot, [string]$RepoRoot) {
  $dllPath = Join-Path $RuntimeRoot "UE4SS.dll"
  if (-not (Test-Path $dllPath -PathType Leaf)) {
    throw "UE4SS.dll not found at $dllPath for import library generation."
  }

  $outDir = Join-Path $RepoRoot "ue4ss-mod/third_party"
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  $defPath = Join-Path $outDir "UE4SS.def"
  $importLibPath = Join-Path $outDir "UE4SS.lib"

  $outDirResolved = Resolve-Path -LiteralPath $outDir -ErrorAction Stop
  $nativeOutDir = $outDirResolved.ProviderPath
  $nativeDefPath = Join-Path $nativeOutDir "UE4SS.def"
  $nativeImportLibPath = Join-Path $nativeOutDir "UE4SS.lib"

  $dumpbinPath = Resolve-VcToolPath -CommandNames @("dumpbin.exe", "dumpbin") -ToolFileName "dumpbin.exe"
  $linkPath = Resolve-VcToolPath -CommandNames @("link.exe", "link") -ToolFileName "link.exe"
  if ([string]::IsNullOrWhiteSpace($dumpbinPath) -and [string]::IsNullOrWhiteSpace($linkPath)) {
    throw "Missing required command: dumpbin/link (needed to parse UE4SS.dll exports for UE4SS.lib generation)"
  }

  $libToolPath = Resolve-VcToolPath -CommandNames @("lib.exe", "lib") -ToolFileName "lib.exe"
  if ([string]::IsNullOrWhiteSpace($libToolPath)) {
    throw "Missing required command: lib.exe (needed to generate UE4SS.lib)"
  }

  $dumpOutput = @()
  if (-not [string]::IsNullOrWhiteSpace($dumpbinPath)) {
    $dumpOutput = & $dumpbinPath /exports $dllPath 2>$null
  } else {
    $dumpOutput = & $linkPath /dump /exports $dllPath 2>$null
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to read exports from $dllPath"
  }

  $seen = New-Object System.Collections.Generic.HashSet[string]
  $exports = New-Object System.Collections.Generic.List[string]
  foreach ($line in $dumpOutput) {
    if ($line -match '^\s*\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+(\S+)\s*$') {
      $name = $Matches[1].Trim()
      if ([string]::IsNullOrWhiteSpace($name) -or $name -eq '[NONAME]') {
        continue
      }
      if ($seen.Add($name)) {
        $exports.Add($name)
      }
    }
  }

  if ($exports.Count -eq 0) {
    throw "No exports found in UE4SS.dll"
  }

  $defLines = New-Object System.Collections.Generic.List[string]
  $defLines.Add("LIBRARY UE4SS.dll") | Out-Null
  $defLines.Add("EXPORTS") | Out-Null
  foreach ($name in $exports) {
    $defLines.Add("  $name") | Out-Null
  }
  $defContent = [string]::Join([Environment]::NewLine, $defLines)
  [System.IO.File]::WriteAllText($nativeDefPath, $defContent, [System.Text.UTF8Encoding]::new($false))

  Invoke-LoggedCommand -StepName "ue4ss-import-lib" -Exe $libToolPath -CommandArgs @(
    "/def:$nativeDefPath",
    "/machine:x64",
    "/out:$nativeImportLibPath"
  )

  if (-not (Test-Path $importLibPath -PathType Leaf) -and -not (Test-Path $nativeImportLibPath -PathType Leaf)) {
    throw "Failed to generate UE4SS import library at $importLibPath"
  }
}

function Resolve-Ue4ssRuntimeDir([string]$RuntimeDir, [string]$RuntimeLocalDir, [string]$RuntimeZipsDir, [string]$ExtractDir) {
  if (-not [string]::IsNullOrWhiteSpace($RuntimeDir)) {
    if (-not (Test-Path $RuntimeDir -PathType Container)) {
      throw "RuntimeDir not found: $RuntimeDir"
    }
    return (Resolve-NativePath $RuntimeDir)
  }

  if (Test-Path $RuntimeLocalDir -PathType Container) {
    $curatedDll = Get-ChildItem -Path $RuntimeLocalDir -Recurse -File -Filter UE4SS.dll -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($null -ne $curatedDll) {
      Write-Host "==> Using curated local UE4SS runtime: $($curatedDll.DirectoryName)"
      return $curatedDll.DirectoryName
    }
    Write-Warning "Curated runtime dir exists but UE4SS.dll was not found in $RuntimeLocalDir; falling back to ZIP extraction."
  }

  return (Expand-Ue4ssRuntimeFromZips -ZipDir $RuntimeZipsDir -DestDir $ExtractDir)
}

function Expand-Ue4ssRuntimeFromZips([string]$ZipDir, [string]$DestDir) {
  if (-not (Test-Path $ZipDir -PathType Container)) {
    throw "Runtime zip directory not found: $ZipDir"
  }

  New-Item -ItemType Directory -Path $DestDir -Force | Out-Null

  $allZipFiles = @(Get-ChildItem -Path $ZipDir -Filter *.zip -File | Sort-Object Name)
  $zipFiles = @()

  if ($allZipFiles.Count -gt 0) {
    $experimentalCore = @($allZipFiles | Where-Object {
      $_.Name -match '(?i)experimental[-_ ]*latest|latest[-_ ]*experimental'
    })
    $coreCandidates = $experimentalCore
    if ($coreCandidates.Count -eq 0) {
      $coreCandidates = @($allZipFiles | Where-Object {
        $_.Name -match '(?i)^(zdev-)?ue4ss.*\.zip$'
      })
    }

    if ($coreCandidates.Count -gt 0) {
      $selectedCore = $coreCandidates | Sort-Object LastWriteTime, Name | Select-Object -Last 1
      $zipFiles += (Resolve-NativePath $selectedCore.FullName)
    }

    foreach ($addonName in @("zCustomGameConfigs.zip", "zMapGenBP.zip")) {
      $addon = Join-Path $ZipDir $addonName
      if (Test-Path $addon -PathType Leaf) {
        $zipFiles += (Resolve-NativePath $addon)
      }
    }
  }

  if ($zipFiles.Count -eq 0) {
    $zipFiles = @($allZipFiles | ForEach-Object { $_.FullName })
  }

  if ($zipFiles.Count -eq 0) {
    throw "No .zip files found in $ZipDir"
  }

  $zipsHash = Get-PathsHash $zipFiles
  $zipsStamp = Join-Path $DestDir ".runtime_zips.hash"
  if ((Test-Path $zipsStamp -PathType Leaf) -and ((Get-Content -Path $zipsStamp -Raw).Trim() -eq $zipsHash)) {
    $cachedDll = Get-ChildItem -Path $DestDir -Recurse -File -Filter UE4SS.dll -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($null -ne $cachedDll) {
      Write-Host "==> Reusing cached extracted UE4SS runtime at $($cachedDll.DirectoryName)"
      return $cachedDll.DirectoryName
    }
  }

  Get-ChildItem -Path $DestDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item -Path $_.FullName -Recurse -Force
  }

  Write-Host "==> Preparing UE4SS runtime from ZIPs"
  foreach ($zip in $zipFiles) {
    Write-Host "    extracting $(Split-Path -Leaf $zip)"
    Expand-Archive -Path $zip -DestinationPath $DestDir -Force
  }
  Set-Content -Path $zipsStamp -Value $zipsHash -Encoding utf8

  $nested = Get-ChildItem -Path $DestDir -Recurse -File -Filter UE4SS.dll -ErrorAction SilentlyContinue |
    Select-Object -First 1

  if ($null -ne $nested) {
    return $nested.DirectoryName
  }

  throw "UE4SS.dll not found after extraction in $DestDir"
}

Write-Host "==> Repo: $repoRoot"
if (-not $PSBoundParameters.ContainsKey("ModConfiguration") -or [string]::IsNullOrWhiteSpace($ModConfiguration)) {
  $ModConfiguration = $Configuration
}
Write-Host "==> Config: $Configuration"
Write-Host "==> Mod config: $ModConfiguration"
Write-Host "==> Runtime profile: $RuntimeProfile"
if ($SettingsProfile -eq "auto") {
  if ($DevOverlayBuild -or $Configuration -eq "Debug") {
    $SettingsProfile = "development"
  } else {
    $SettingsProfile = "production"
  }
}
$StrippedModBuild = Convert-ToBoolOrDefault -Value $StrippedModBuild -DefaultValue ($SettingsProfile -eq "production")
Write-Host "==> UE4SS settings profile: $SettingsProfile"
if ($StrippedModBuild) {
  Write-Host "==> Mod source profile: stripped production"
} else {
  Write-Host "==> Mod source profile: full development"
}
Write-VisualStudioToolchainSummary
if ($script:UseCache) {
  Write-Host "==> Cache: enabled ($script:PipelineCacheDir)"
} else {
  Write-Host "==> Cache: disabled"
}
if ($ClearCache) {
  Write-Host "==> Clearing pipeline cache at $script:PipelineCacheDir"
  if (Test-Path $script:PipelineCacheDir) {
    Remove-Item -Path $script:PipelineCacheDir -Recurse -Force
  }
  if ($originalRepoRoot.StartsWith("\\")) {
    $stableStagingRoot = Get-StableMsvcStagingRoot -RepoIdentityPath $originalRepoRoot
    if (Test-Path $stableStagingRoot) {
      Write-Host "==> Clearing stable MSVC staging root at $stableStagingRoot"
      Remove-Item -Path $stableStagingRoot -Recurse -Force
    }
  }
}

if (-not $SkipSetup) {
  Write-Host "==> Setup tooling"
  Assert-Command pnpm
  Assert-Command cargo
  Assert-Command rustup
  Assert-Command cmake

  & rustup target add $target
  if ($LASTEXITCODE -ne 0) { throw "rustup target add failed" }

  & cargo xwin --version 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) {
    & cargo install cargo-xwin --locked
    if ($LASTEXITCODE -ne 0) { throw "cargo install cargo-xwin failed" }
  }
}

if (-not $SkipFrontendInstall) {
  $pnpmKeyInput = @(
    "step=pnpm-install",
    "pnpm=$(Get-CommandVersion -Name 'pnpm' -Args @('-v'))",
    "node=$(Get-CommandVersion -Name 'node' -Args @('-v'))",
    "src=$(Get-PathsHash @((Join-Path $repoRoot 'package.json'), (Join-Path $repoRoot 'pnpm-lock.yaml')))"
  ) -join "`n"
  $pnpmKey = Get-StringSha256 $pnpmKeyInput
  if (Test-CacheHit -StepName "pnpm-install" -Key $pnpmKey -Outputs @((Join-Path $repoRoot "node_modules"))) {
    Write-Host "==> Skipping pnpm install (cache hit)"
  } else {
    Write-Host "==> Installing frontend dependencies"
    & pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
    Set-CacheStamp -StepName "pnpm-install" -Key $pnpmKey
  }
}

if (-not $SkipModBuild) {
  $Ue4ssSdkDir = ((Resolve-Ue4ssSdkDir -ExplicitSdkDir $Ue4ssSdkDir -RepoRoot $repoRoot | Select-Object -Last 1) -as [string]).Trim()
  if ($repoRoot -match '^[A-Za-z]:\\' -and $Ue4ssSdkDir.StartsWith("\\") -and $originalRepoRoot.StartsWith("\\")) {
    $Ue4ssSdkDir = Convert-ToMappedRepoPath -PathValue $Ue4ssSdkDir -OriginalRepoRoot $originalRepoRoot -MappedRepoRoot $repoRoot
  }
  Write-Ue4ssSdkRevisionSummary -SdkDir $Ue4ssSdkDir
}

$profileDir = if ($Configuration -eq "Release") { "release" } else { "debug" }
$rustCoreDll = $null
$rustCoreCandidate = Join-Path $repoRoot "ue4ss-rust-core/target/$target/$profileDir/ue4ss_rust_core.dll"
if (Test-Path $rustCoreCandidate -PathType Leaf) {
  $rustCoreDll = Resolve-NativePath $rustCoreCandidate
}

if (-not $SkipRustCoreBuild) {
  $rustKeyInput = @(
    "step=rust-core",
    "config=$Configuration",
    "target=$target",
    "src=$(Get-PathsHash @((Join-Path $repoRoot 'ue4ss-rust-core/Cargo.toml'), (Join-Path $repoRoot 'ue4ss-rust-core/Cargo.lock'), (Join-Path $repoRoot 'ue4ss-rust-core/src')))"
  ) -join "`n"
  $rustKey = Get-StringSha256 $rustKeyInput
  if (Test-CacheHit -StepName "rust-core-$Configuration" -Key $rustKey -Outputs @($rustCoreCandidate)) {
    Write-Host "==> Skipping ue4ss-rust-core build (cache hit)"
  } else {
    Write-Host "==> Building ue4ss-rust-core ($Configuration)"
    $cargoArgs = @(
      "xwin", "build",
      "--manifest-path", "ue4ss-rust-core/Cargo.toml",
      "--target", $target
    )
    if ($Configuration -eq "Release") {
      $cargoArgs += "--release"
    }
    & cargo @cargoArgs
    if ($LASTEXITCODE -ne 0) { throw "ue4ss-rust-core build failed" }
    Set-CacheStamp -StepName "rust-core-$Configuration" -Key $rustKey
  }
  $rustCoreDll = Resolve-NativePath "ue4ss-rust-core/target/$target/$profileDir/ue4ss_rust_core.dll"
}
Write-FileHashLine -Label "ue4ss_rust_core.dll" -PathValue $rustCoreDll

$modBuildDir = Join-Path (Join-Path $repoRoot "ue4ss-mod") "build"
$modMainDll = $null
$preparedRuntimeForMod = $null
if (-not $SkipModBuild) {
  $preparedRuntimeForMod = Resolve-Ue4ssRuntimeDir `
    -RuntimeDir $RuntimeDir `
    -RuntimeLocalDir $RuntimeLocalDir `
    -RuntimeZipsDir $RuntimeZipsDir `
    -ExtractDir (Join-Path $repoRoot ".cache/ue4ss-runtime")
  $runtimeHashForMod = Get-PathsHash @((Join-Path $preparedRuntimeForMod "UE4SS.dll"))

  $repoModBuildDir = $modBuildDir
  $cachedModDll = $null
  try {
    $cachedModDll = Resolve-ModDllPath -BuildDir $repoModBuildDir -Config $ModConfiguration
  } catch {
    $cachedModDll = $null
  }

  $modKeyInput = @(
    "step=ue4ss-mod",
    "mod_config=$ModConfiguration",
    "stripped_mod=$StrippedModBuild",
    "sdk=$Ue4ssSdkDir",
    "runtime=$runtimeHashForMod",
    "cmake=$(Get-CommandVersion -Name 'cmake' -Args @('--version'))",
    "src=$(Get-PathsHash @((Join-Path $repoRoot 'ue4ss-mod/CMakeLists.txt'), (Join-Path $repoRoot 'ue4ss-mod/src'), (Join-Path $repoRoot 'ue4ss-mod/mod.json')))"
  ) -join "`n"
  $modKey = Get-StringSha256 $modKeyInput
  $modCacheOutputs = @()
  if ($cachedModDll) {
    $modCacheOutputs += $cachedModDll
  } else {
    $modCacheOutputs += (Join-Path $repoRoot "ue4ss-mod/__missing_main_dll__")
  }

  if (Test-CacheHit -StepName "ue4ss-mod-$ModConfiguration" -Key $modKey -Outputs $modCacheOutputs) {
    Write-Host "==> Skipping ue4ss-mod build (cache hit)"
    $modMainDll = $cachedModDll
  } else {
    Write-Host "==> Building ue4ss-mod ($ModConfiguration)"
    Generate-Ue4ssImportLib -RuntimeRoot $preparedRuntimeForMod -RepoRoot $repoRoot

    $modSourceDir = Join-Path $repoRoot "ue4ss-mod"
    $sdkDirForBuild = $Ue4ssSdkDir
    $buildRootForMod = $repoRoot
    $copyBackToRepo = $false

    if ($originalRepoRoot.StartsWith("\\")) {
      $stagingRoot = Get-StableMsvcStagingRoot -RepoIdentityPath $originalRepoRoot
      $buildRootForMod = Join-Path $stagingRoot "repo"
      $modSourceDir = Join-Path $buildRootForMod "ue4ss-mod"
      $modBuildDir = Join-Path $modSourceDir "build"

      New-Item -ItemType Directory -Path $buildRootForMod -Force | Out-Null
      Write-Host "==> Using stable MSVC staging root: $stagingRoot"

      $sourceRepoForCopy = $originalRepoRoot
      $sdkSourceForCopy = Convert-ToMappedRepoPath -PathValue $Ue4ssSdkDir -OriginalRepoRoot $repoRoot -MappedRepoRoot $originalRepoRoot
      $sdkRootSource = Split-Path -Parent $sdkSourceForCopy
      $sdkRootDest = Join-Path $buildRootForMod "external\\ue4ss-sdk-root"
      $sdkLeaf = Split-Path -Leaf $sdkSourceForCopy

      Invoke-RobocopyMirror -SourceDir (Join-Path $sourceRepoForCopy "ue4ss-mod") -DestinationDir $modSourceDir -ExtraArgs @("/XD", "build", "build-w64")
      Invoke-RobocopyMirror -SourceDir $sdkRootSource -DestinationDir $sdkRootDest
      $sdkDirForBuild = Join-Path $sdkRootDest $sdkLeaf
      $copyBackToRepo = $true
    } else {
      New-Item -ItemType Directory -Path $modBuildDir -Force | Out-Null
    }

    Push-Location $buildRootForMod
    $strippedModCMakeValue = if ($StrippedModBuild) { "ON" } else { "OFF" }
    $cmakeConfigureArgs = @(
      "-S", $modSourceDir,
      "-B", $modBuildDir,
      "-A", "x64",
      "-DUE4SS_SDK_DIR=$sdkDirForBuild",
      "-DKOVAAKS_BUILD_STRIPPED_PRODUCTION=$strippedModCMakeValue"
    )
    Invoke-LoggedCommand -StepName "cmake-configure" -Exe "cmake" -CommandArgs $cmakeConfigureArgs
    Invoke-LoggedCommand -StepName "cmake-build" -Exe "cmake" -CommandArgs @("--build", $modBuildDir, "--config", $ModConfiguration)
    Pop-Location

    $modMainDll = Resolve-ModDllPath -BuildDir $modBuildDir -Config $ModConfiguration

    if ($copyBackToRepo) {
      $targetModDir = Join-Path (Join-Path $repoRoot "ue4ss-mod") "build\$ModConfiguration"
      New-Item -ItemType Directory -Path $targetModDir -Force | Out-Null
      Copy-Item -Path $modMainDll -Destination (Join-Path $targetModDir "main.dll") -Force
      $modMainDll = Join-Path $targetModDir "main.dll"
      $modBuildDir = $repoModBuildDir
    }

    Set-CacheStamp -StepName "ue4ss-mod-$ModConfiguration" -Key $modKey
  }
}
Write-FileHashLine -Label "main.dll" -PathValue $modMainDll

if (-not $SkipStage) {
  if (-not $rustCoreDll -or -not (Test-Path $rustCoreDll -PathType Leaf)) {
    throw "Rust core DLL missing. Build it first or pass -SkipStage."
  }
  if (-not $modMainDll) {
    if ($SkipModBuild) {
      $modMainDll = Resolve-ModDllPath -BuildDir $modBuildDir -Config $ModConfiguration
    } else {
      throw "main.dll missing for staging."
    }
  }

  $preparedRuntime = $preparedRuntimeForMod
  if ($null -eq $preparedRuntime -or -not (Test-Path (Join-Path $preparedRuntime "UE4SS.dll") -PathType Leaf)) {
    $preparedRuntime = Resolve-Ue4ssRuntimeDir `
      -RuntimeDir $RuntimeDir `
      -RuntimeLocalDir $RuntimeLocalDir `
      -RuntimeZipsDir $RuntimeZipsDir `
      -ExtractDir (Join-Path $repoRoot ".cache/ue4ss-runtime")
  }

  $stageKeyInput = @(
    "step=stage",
    "profile=$RuntimeProfile",
    "settings_profile=$SettingsProfile",
    "runtime=$(Get-PathsHash @($preparedRuntime))",
    "mod=$(Get-PathsHash @($modMainDll))",
    "rust=$(Get-PathsHash @($rustCoreDll))",
    "sync=$(Get-PathsHash @((Join-Path $repoRoot 'scripts/sync-ue4ss-payload.ps1'), (Join-Path $repoRoot 'scripts/ue4ss-settings/development.ini'), (Join-Path $repoRoot 'scripts/ue4ss-settings/production.ini'), (Join-Path $repoRoot 'ue4ss-mod/mod.json')))"
  ) -join "`n"
  $stageKey = Get-StringSha256 $stageKeyInput
  $stageOutputs = @(
    (Join-Path $repoRoot "src-tauri/ue4ss/UE4SS.dll"),
    (Join-Path $repoRoot "src-tauri/ue4ss/Mods/KovaaksBridgeMod/dlls/main.dll"),
    (Join-Path $repoRoot "src-tauri/ue4ss/kovaaks_rust_core.dll")
  )

  if (Test-CacheHit -StepName "stage-$RuntimeProfile" -Key $stageKey -Outputs $stageOutputs) {
    Write-Host "==> Skipping UE4SS payload staging (cache hit)"
  } else {
    Write-Host "==> Staging UE4SS payload"
    & (Join-Path $repoRoot "scripts/sync-ue4ss-payload.ps1") `
      -RuntimeDir $preparedRuntime `
      -ModMainDll $modMainDll `
      -RustCoreDll $rustCoreDll `
      -RuntimeProfile $RuntimeProfile `
      -SettingsProfile $SettingsProfile
    if ($LASTEXITCODE -ne 0) { throw "UE4SS payload staging failed" }
    Set-CacheStamp -StepName "stage-$RuntimeProfile" -Key $stageKey
  }

  # The running dev/release app syncs from target profile payload folders.
  # Keep those in sync with src-tauri/ue4ss even when stage is a cache hit.
  Sync-Ue4ssPayloadToTauriTargets -RepoRoot $repoRoot -TargetTriple $target

  Write-FileHashLine -Label "staged UE4SS.dll" -PathValue (Join-Path $repoRoot "src-tauri/ue4ss/UE4SS.dll")
  Write-FileHashLine -Label "staged main.dll" -PathValue (Join-Path $repoRoot "src-tauri/ue4ss/Mods/KovaaksBridgeMod/dlls/main.dll")
  Write-FileHashLine -Label "staged kovaaks_rust_core.dll" -PathValue (Join-Path $repoRoot "src-tauri/ue4ss/kovaaks_rust_core.dll")
}

if (-not $SkipOverlayBuild) {
  $overlayMode = if ($DevOverlayBuild) { "dev" } else { "release" }
  $overlayKeyInput = @(
    "step=overlay",
    "mode=$overlayMode",
    "src=$(Get-PathsHash @((Join-Path $repoRoot 'src'), (Join-Path $repoRoot 'src-tauri/src'), (Join-Path $repoRoot 'src-tauri/ue4ss'), (Join-Path $repoRoot 'scripts/ue4ss-settings'), (Join-Path $repoRoot 'src-tauri/Cargo.toml'), (Join-Path $repoRoot 'src-tauri/Cargo.lock'), (Join-Path $repoRoot 'src-tauri/tauri.conf.json'), (Join-Path $repoRoot 'package.json'), (Join-Path $repoRoot 'pnpm-lock.yaml'), (Join-Path $repoRoot 'vite.config.ts'), (Join-Path $repoRoot 'tsconfig.json')))"
  ) -join "`n"
  $overlayKey = Get-StringSha256 $overlayKeyInput
  $overlayMarker = Join-Path $script:PipelineCacheDir "overlay-$overlayMode.ok"

  if (Test-CacheHit -StepName "overlay-$overlayMode" -Key $overlayKey -Outputs @($overlayMarker)) {
    Write-Host "==> Skipping overlay build (cache hit)"
  } else {
    Write-Host "==> Building overlay app"
    if ($DevOverlayBuild) {
      & pnpm run build:win:dev
    } else {
      & pnpm run build:win
    }
    if ($LASTEXITCODE -ne 0) { throw "Overlay build failed" }
    New-Item -ItemType Directory -Path $script:PipelineCacheDir -Force | Out-Null
    Set-Content -Path $overlayMarker -Value (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ") -Encoding utf8
    Set-CacheStamp -StepName "overlay-$overlayMode" -Key $overlayKey
  }
}

Write-Host "==> Pipeline complete"
$global:LASTEXITCODE = 0
