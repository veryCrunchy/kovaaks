#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
TARGET_TRIPLE="x86_64-pc-windows-msvc"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'
  C_RED=$'\033[31m'
  C_YELLOW=$'\033[33m'
  C_GREEN=$'\033[32m'
  C_CYAN=$'\033[36m'
  C_BOLD=$'\033[1m'
else
  C_RESET=''
  C_RED=''
  C_YELLOW=''
  C_GREEN=''
  C_CYAN=''
  C_BOLD=''
fi

print_highlighted_line() {
  local line="$1"
  local lower
  lower="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"

  if [[ "$line" == *"========== BUILD STEP FAILED =========="* ]] || [[ "$line" == *"========== PIPELINE FAILED =========="* ]]; then
    printf '%s%s%s%s\n' "$C_BOLD" "$C_RED" "$line" "$C_RESET"
    return 0
  fi
  if [[ "$lower" == *"error:"* ]] || [[ "$lower" == *"fatal"* ]] || [[ "$lower" == *"failed"* ]] || [[ "$lower" == *"exception"* ]]; then
    printf '%s%s%s\n' "$C_RED" "$line" "$C_RESET"
    return 0
  fi
  if [[ "$lower" == *"warning"* ]] || [[ "$lower" == *"warn:"* ]]; then
    printf '%s%s%s\n' "$C_YELLOW" "$line" "$C_RESET"
    return 0
  fi
  if [[ "$line" == *"==>"* ]]; then
    printf '%s%s%s\n' "$C_CYAN" "$line" "$C_RESET"
    return 0
  fi
  if [[ "$line" == *"Pipeline complete"* ]]; then
    printf '%s%s%s\n' "$C_GREEN" "$line" "$C_RESET"
    return 0
  fi

  printf '%s\n' "$line"
}

highlight_stream() {
  local line
  while IFS= read -r line; do
    print_highlighted_line "$line"
  done
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/dev-pipeline.sh \
    --ue4ss-sdk-dir "<path-to-UE4SS-cppsdk>" \
    [--runtime-dir "<extracted-ue4ss-runtime-dir>"] \
    [--runtime-local-dir "external/ue4ss-runtime/current"] \
    [--runtime-zips-dir "external/ue4ss-runtime"] \
    [--runtime-profile minimal|full] \
    [--settings-profile auto|development|production] \
    [--configuration Release|Debug] \
    [--mod-configuration Release|Debug] \
    [--no-cache] [--clear-cache] \
    [--force-mingw-mod-build] \
    [--stripped-mod-build|--full-mod-build] \
    [--install-system-deps] \
    [--skip-setup] [--skip-frontend-install] [--skip-rust-core-build] \
    [--skip-mod-build] [--skip-stage] [--skip-overlay-build] \
    [--dev-overlay-build]
EOF
}

fail() {
  echo -e "${C_RED}error: $*${C_RESET}" >&2
  exit 1
}

warn() {
  echo -e "${C_YELLOW}warn: $*${C_RESET}" >&2
}

run() {
  echo -e "${C_CYAN}==> $*${C_RESET}"
  "$@"
}

print_error_summary() {
  local logfile="$1"
  local pattern='error|fatal|failed|undefined reference|unresolved external|LNK[0-9]{4}|CMake Error|cannot find|No such file'
  if [[ ! -f "$logfile" ]]; then
    return 0
  fi
  echo -e "${C_YELLOW}---- Error Summary (last 40 matching lines) ----${C_RESET}"
  if command -v rg >/dev/null 2>&1; then
    rg -n -i -e "$pattern" "$logfile" | tail -n 40 | highlight_stream || true
  else
    grep -nEi "$pattern" "$logfile" | tail -n 40 | highlight_stream || true
  fi
  echo -e "${C_YELLOW}------------------------------------------------${C_RESET}"
}

run_logged_step() {
  local step_name="$1"
  shift
  mkdir -p "$PIPELINE_LOG_DIR"
  local ts logfile cmd_str status errexit_was_set
  ts="$(date -u +%Y%m%d-%H%M%S)"
  logfile="$PIPELINE_LOG_DIR/${step_name}-${ts}.log"
  cmd_str="$(printf '%q ' "$@")"

  echo -e "${C_CYAN}==> [$step_name] $cmd_str${C_RESET}"
  errexit_was_set=0
  [[ $- == *e* ]] && errexit_was_set=1
  set +e
  if [[ -t 1 ]]; then
    "$@" 2>&1 | tee "$logfile" | highlight_stream
    local -a step_status=("${PIPESTATUS[@]}")
    status="${step_status[0]}"
  else
    "$@" > >(tee "$logfile") 2>&1
    status=$?
  fi
  if [[ "$errexit_was_set" -eq 1 ]]; then
    set -e
  fi
  if [[ "$status" -ne 0 ]]; then
    echo
    echo -e "${C_BOLD}${C_RED}========== BUILD STEP FAILED ==========${C_RESET}"
    echo -e "${C_RED}Step: $step_name${C_RESET}"
    echo -e "${C_RED}Exit code: $status${C_RESET}"
    echo -e "${C_RED}Command: $cmd_str${C_RESET}"
    print_error_summary "$logfile"
    echo -e "${C_RED}Full log: $logfile${C_RESET}"
    echo -e "${C_BOLD}${C_RED}=======================================${C_RESET}"
    return "$status"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

hash_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
    return 0
  fi
  fail "Missing sha256sum/shasum for cache hashing"
}

hash_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
    return 0
  fi
  fail "Missing sha256sum/shasum for cache hashing"
}

hash_paths() {
  (
    local p=""
    for p in "$@"; do
      [[ -n "$p" ]] || continue
      if [[ -d "$p" ]]; then
        while IFS= read -r -d '' f; do
          local rel="$f"
          if [[ "$f" == "$REPO_ROOT/"* ]]; then
            rel="${f#$REPO_ROOT/}"
          fi
          printf 'F %s %s\n' "$rel" "$(hash_file "$f")"
        done < <(find "$p" -type f -print0 | sort -z)
      elif [[ -f "$p" ]]; then
        local rel="$p"
        if [[ "$p" == "$REPO_ROOT/"* ]]; then
          rel="${p#$REPO_ROOT/}"
        fi
        printf 'F %s %s\n' "$rel" "$(hash_file "$p")"
      else
        printf 'MISSING %s\n' "$p"
      fi
    done
  ) | hash_stream
}

cache_stamp_path() {
  local step="$1"
  printf '%s/%s.key\n' "$PIPELINE_CACHE_DIR" "$step"
}

is_cache_hit() {
  local step="$1"
  local key="$2"
  shift 2

  [[ "$USE_CACHE" -eq 1 ]] || return 1
  local stamp
  stamp="$(cache_stamp_path "$step")"
  [[ -f "$stamp" ]] || return 1
  [[ "$(cat "$stamp" 2>/dev/null)" == "$key" ]] || return 1

  local out=""
  for out in "$@"; do
    [[ -e "$out" ]] || return 1
  done
  return 0
}

write_cache_stamp() {
  local step="$1"
  local key="$2"
  mkdir -p "$PIPELINE_CACHE_DIR"
  printf '%s\n' "$key" >"$(cache_stamp_path "$step")"
}

ensure_mingw_toolchain() {
  if command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 \
    && command -v x86_64-w64-mingw32-g++ >/dev/null 2>&1 \
    && command -v x86_64-w64-mingw32-windres >/dev/null 2>&1; then
    return 0
  fi

  warn "mingw-w64 toolchain missing; attempting automatic install."
  if ! command -v apt-get >/dev/null 2>&1; then
    fail "Missing mingw-w64 toolchain and apt-get is unavailable. Install x86_64-w64-mingw32 tools manually."
  fi

  if command -v sudo >/dev/null 2>&1; then
    run sudo apt-get update
    run sudo apt-get install -y mingw-w64
  else
    run apt-get update
    run apt-get install -y mingw-w64
  fi

  command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 \
    && command -v x86_64-w64-mingw32-g++ >/dev/null 2>&1 \
    && command -v x86_64-w64-mingw32-windres >/dev/null 2>&1 \
    || fail "mingw-w64 install completed but x86_64-w64-mingw32 tools are still unavailable."
}

extract_zip() {
  local zip_path="$1"
  local dest_dir="$2"
  python3 - "$zip_path" "$dest_dir" <<'PY'
import pathlib
import sys
import zipfile

zip_path = pathlib.Path(sys.argv[1])
dest_dir = pathlib.Path(sys.argv[2])
dest_dir.mkdir(parents=True, exist_ok=True)

with zipfile.ZipFile(zip_path) as zf:
    zf.extractall(dest_dir)
PY
}

resolve_mod_dll() {
  local build_dir="$1"
  local config="$2"
  local c1="$build_dir/$config/main.dll"
  local c2="$build_dir/main.dll"
  if [[ -f "$c1" ]]; then
    printf '%s\n' "$(realpath "$c1")"
    return 0
  fi
  if [[ -f "$c2" ]]; then
    printf '%s\n' "$(realpath "$c2")"
    return 0
  fi
  return 1
}

mod_output_exists() {
  local build_dir="$1"
  local config="$2"
  resolve_mod_dll "$build_dir" "$config" >/dev/null 2>&1
}

mirror_tauri_profile_payloads() {
  local src="$REPO_ROOT/src-tauri/ue4ss"
  [[ -d "$src" ]] || return 0

  local target_root="$REPO_ROOT/src-tauri/target/$TARGET_TRIPLE"
  local profile=""
  for profile in dev-windows release debug; do
    local profile_root="$target_root/$profile"
    local dst="$profile_root/ue4ss"
    if [[ ! -d "$profile_root" ]]; then
      continue
    fi
    rm -rf "$dst"
    mkdir -p "$dst"
    cp -a "$src"/. "$dst"/
    echo "==> Mirrored UE4SS payload to $dst"
  done
}

is_wsl() {
  if [[ -f /proc/sys/kernel/osrelease ]] && grep -qi microsoft /proc/sys/kernel/osrelease; then
    return 0
  fi
  if [[ -f /proc/version ]] && grep -qi microsoft /proc/version; then
    return 0
  fi
  return 1
}

build_mod_with_windows_msvc() {
  local sdk_dir="$1"
  local pipeline_config="$2"
  local mod_config="$3"
  local stripped_mod_build="$4"

  require_cmd powershell.exe
  require_cmd wslpath

  local ps1_path
  local win_sdk_dir
  local stripped_ps_bool
  ps1_path="$(wslpath -w "$REPO_ROOT/scripts/dev-pipeline.ps1")"
  win_sdk_dir="$(wslpath -w "$sdk_dir")"
  if [[ "$stripped_mod_build" -eq 1 ]]; then
    stripped_ps_bool='1'
  else
    stripped_ps_bool='0'
  fi

  local -a ps_args=(
    -NoProfile -ExecutionPolicy Bypass -File "$ps1_path"
    -Ue4ssSdkDir "$win_sdk_dir"
    -Configuration "$pipeline_config"
    -ModConfiguration "$mod_config"
    -StrippedModBuild "$stripped_ps_bool"
    -NoCache
    -SkipSetup
    -SkipFrontendInstall
    -SkipRustCoreBuild
    -SkipStage
    -SkipOverlayBuild
  )

  run_logged_step "msvc-mod-build" powershell.exe "${ps_args[@]}"
}

generate_ue4ss_import_lib() {
  local runtime_root="$1"
  local dll_path="$runtime_root/UE4SS.dll"
  local out_dir="$REPO_ROOT/ue4ss-mod/third_party"
  local def_path="$out_dir/UE4SS.def"
  local lib_path="$out_dir/UE4SS.lib"

  [[ -f "$dll_path" ]] || fail "UE4SS.dll not found at $dll_path for import library generation."
  require_cmd x86_64-w64-mingw32-objdump
  require_cmd llvm-dlltool
  require_cmd python3

  mkdir -p "$out_dir"

  python3 - "$dll_path" "$def_path" <<'PY'
import re
import subprocess
import sys

dll_path = sys.argv[1]
def_path = sys.argv[2]

dump = subprocess.check_output(
    ["x86_64-w64-mingw32-objdump", "-p", dll_path],
    text=True,
    errors="ignore",
)

names = []
seen = set()
pattern = re.compile(r"^\s*\[\s*\d+\]\s+\+base\[\s*\d+\]\s+[0-9A-Fa-f]+\s+(\S+)\s*$")
for line in dump.splitlines():
    match = pattern.match(line)
    if not match:
        continue
    name = match.group(1).strip()
    if not name or name in seen:
        continue
    seen.add(name)
    names.append(name)

if not names:
    raise SystemExit("No exports found in UE4SS.dll")

with open(def_path, "w", encoding="utf-8", newline="\n") as f:
    f.write("LIBRARY UE4SS.dll\n")
    f.write("EXPORTS\n")
    for name in names:
        f.write(f"  {name}\n")
PY

  run llvm-dlltool -d "$def_path" -D UE4SS.dll -m i386:x86-64 -l "$lib_path"
  [[ -f "$lib_path" ]] || fail "Failed to generate UE4SS import library at $lib_path"
}

sdk_headers_present() {
  local sdk_root="$1"
  local has_cpp_user_mod=0
  local has_hooks=0
  local has_uobj_globals=0
  local has_dyn_output=0

  if [[ -f "$sdk_root/include/Mod/CppUserModBase.hpp" ]]; then
    has_cpp_user_mod=1
  fi
  if [[ -f "$sdk_root/include/Unreal/Hooks.hpp" || -f "$sdk_root/../deps/first/Unreal/include/Unreal/Hooks.hpp" ]]; then
    has_hooks=1
  fi
  if [[ -f "$sdk_root/include/Unreal/UObjectGlobals.hpp" || -f "$sdk_root/../deps/first/Unreal/include/Unreal/UObjectGlobals.hpp" ]]; then
    has_uobj_globals=1
  fi
  if [[ -f "$sdk_root/include/DynamicOutput/Output.hpp" || -f "$sdk_root/../deps/first/DynamicOutput/include/DynamicOutput/Output.hpp" ]]; then
    has_dyn_output=1
  fi

  [[ "$has_cpp_user_mod" -eq 1 && "$has_hooks" -eq 1 && "$has_uobj_globals" -eq 1 && "$has_dyn_output" -eq 1 ]]
}

PREFERRED_RE_UE4SS_REF="${KOVAAKS_RE_UE4SS_REF:-733e59695ec01e8ae74590e33345a5e8f4e12808}"
PREFERRED_UEPSEUDO_REF="${KOVAAKS_UEPSEUDO_REF:-f55ddc76b79c32e175ba7cb34095cbf752e9028d}"
PREFERRED_PATTERNSLEUTH_REF="${KOVAAKS_PATTERNSLEUTH_REF:-75b124983ec08fc2e32d53af1388d3cb3b5d31b8}"

resolve_ue4ss_github_token() {
  local candidate=""
  for candidate in "${UE4SS_GITHUB_TOKEN:-}" "${GH_TOKEN:-}" "${GITHUB_TOKEN:-}"; do
    if [[ -n "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

set_git_repo_exact_ref() {
  local repo_path="$1"
  local ref="$2"
  shift 2 || true
  local -a git_auth_args=("$@")

  [[ -n "$repo_path" && -n "$ref" && -d "$repo_path/.git" || -f "$repo_path/.git" ]] || return 0

  local current=""
  current="$(git -C "$repo_path" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$current" == "$ref" ]]; then
    return 0
  fi

  echo "==> Pinning $(basename "$repo_path") to $ref"
  git "${git_auth_args[@]}" -C "$repo_path" fetch --depth 1 origin "$ref"
  git "${git_auth_args[@]}" -C "$repo_path" checkout --force FETCH_HEAD
}

apply_ue4ss_pinned_revisions() {
  local template_root="$1"
  shift || true
  local -a git_auth_args=("$@")

  [[ -d "$template_root" ]] || return 0
  set_git_repo_exact_ref "$template_root" "$PREFERRED_RE_UE4SS_REF" "${git_auth_args[@]}"
  set_git_repo_exact_ref "$template_root/deps/first/Unreal" "$PREFERRED_UEPSEUDO_REF" "${git_auth_args[@]}"
  set_git_repo_exact_ref "$template_root/deps/first/patternsleuth" "$PREFERRED_PATTERNSLEUTH_REF" "${git_auth_args[@]}"
}

maybe_init_template_submodules() {
  local template_parent="$REPO_ROOT/external/UE4SSCPPTemplate"
  local template_root="$template_parent/RE-UE4SS"
  require_cmd git
  local github_token=""
  local is_ci=0
  local -a git_auth_args=()

  if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    is_ci=1
  fi

  if github_token="$(resolve_ue4ss_github_token 2>/dev/null)"; then
    local auth_b64=""
    auth_b64="$(printf 'x-access-token:%s' "$github_token" | base64 | tr -d '\r\n')"
    git_auth_args+=(
      -c credential.interactive=never
      -c core.askPass=
      -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth_b64"
    )
  elif [[ "$is_ci" -eq 1 ]]; then
    git_auth_args+=(
      -c credential.interactive=never
      -c core.askPass=
    )
    warn "UE4SS_GITHUB_TOKEN is not set in CI. Private UEPseudo submodule access is expected to fail."
  fi

  if [[ ! -d "$template_root" ]]; then
    echo "==> UE4SSCPPTemplate missing; cloning into external/UE4SSCPPTemplate"
    rm -rf "$template_parent"
    git clone --depth 1 https://github.com/UE4SS-RE/UE4SSCPPTemplate.git "$template_parent" || {
      warn "Unable to clone UE4SSCPPTemplate automatically."
      return 0
    }
  fi

  [[ -d "$template_root/.git" || -f "$template_root/.git" ]] || return 0

  echo "==> Attempting to initialize UE4SS template submodules"
  (
    set -e
    if [[ "$is_ci" -eq 1 ]]; then
      GIT_TERMINAL_PROMPT=0 git "${git_auth_args[@]}" -C "$template_root" submodule sync --recursive
      GIT_TERMINAL_PROMPT=0 git "${git_auth_args[@]}" -C "$template_root" submodule update --init --recursive --depth 1
    else
      git "${git_auth_args[@]}" -C "$template_root" submodule sync --recursive
      git "${git_auth_args[@]}" -C "$template_root" submodule update --init --recursive --depth 1
    fi
    apply_ue4ss_pinned_revisions "$template_root" "${git_auth_args[@]}"
  ) && return 0

  warn "Submodule init via repo defaults failed; trying HTTPS URL overrides."
  (
    set -e
    if [[ "$is_ci" -eq 1 ]]; then
      GIT_TERMINAL_PROMPT=0 git "${git_auth_args[@]}" -C "$template_root" submodule sync --recursive
      GIT_TERMINAL_PROMPT=0 git "${git_auth_args[@]}" -C "$template_root" \
        -c submodule.deps/first/Unreal.url=https://github.com/Re-UE4SS/UEPseudo.git \
        -c submodule.deps/first/patternsleuth.url=https://github.com/trumank/patternsleuth.git \
        submodule update --init --recursive --depth 1
    else
      git "${git_auth_args[@]}" -C "$template_root" submodule sync --recursive
      git "${git_auth_args[@]}" -C "$template_root" \
        -c submodule.deps/first/Unreal.url=https://github.com/Re-UE4SS/UEPseudo.git \
        -c submodule.deps/first/patternsleuth.url=https://github.com/trumank/patternsleuth.git \
        submodule update --init --recursive --depth 1
    fi
    apply_ue4ss_pinned_revisions "$template_root" "${git_auth_args[@]}"
  ) && return 0

  warn "Submodule init failed. Continuing to probe existing SDK paths."
}

resolve_ue4ss_sdk_dir() {
  local from_arg="${1:-}"
  if [[ -n "$from_arg" ]]; then
    [[ -d "$from_arg" ]] || fail "UE4SS SDK dir not found: $from_arg"
    sdk_headers_present "$from_arg" || fail "UE4SS SDK dir is missing required headers: $from_arg"
    printf '%s\n' "$(realpath "$from_arg")"
    return 0
  fi

  local -a candidates=(
    "$REPO_ROOT/external/ue4ss-cppsdk"
    "$REPO_ROOT/external/UE4SSCPPTemplate/RE-UE4SS/UE4SS"
  )

  local c=""
  for c in "${candidates[@]}"; do
    if [[ -d "$c" ]] && sdk_headers_present "$c"; then
      printf '%s\n' "$(realpath "$c")"
      return 0
    fi
  done

  # Try to bootstrap missing template submodules, then probe again.
  maybe_init_template_submodules >&2
  for c in "${candidates[@]}"; do
    if [[ -d "$c" ]] && sdk_headers_present "$c"; then
      printf '%s\n' "$(realpath "$c")"
      return 0
    fi
  done

  fail $'UE4SS SDK not found in external/.\nTo compile the C++ mod, you need UE4SS C++ prerequisites (private UEPseudo access via Epic-linked GitHub).\nOptions:\n  1) Clone template and init submodules:\n     git clone --depth 1 https://github.com/UE4SS-RE/UE4SSCPPTemplate.git external/UE4SSCPPTemplate\n     git -C external/UE4SSCPPTemplate/RE-UE4SS submodule update --init --recursive\n  2) Place a complete SDK at: external/ue4ss-cppsdk\n  3) Set --ue4ss-sdk-dir / UE4SS_SDK_DIR to an existing SDK path.\n  4) In CI, set UE4SS_GITHUB_TOKEN (PAT from an Epic-linked GitHub account with access to Re-UE4SS/UEPseudo).'
}

prepare_runtime_dir() {
  local runtime_dir_arg="$1"
  local runtime_local_dir="$2"
  local runtime_zips_dir="$3"
  local extract_dir="$4"

  if [[ -n "$runtime_dir_arg" ]]; then
    [[ -d "$runtime_dir_arg" ]] || fail "Runtime dir not found: $runtime_dir_arg"
    printf '%s\n' "$(realpath "$runtime_dir_arg")"
    return 0
  fi

  if [[ -d "$runtime_local_dir" ]]; then
    local curated_dll
    curated_dll="$(find "$runtime_local_dir" -type f -name 'UE4SS.dll' | head -n 1 || true)"
    if [[ -n "$curated_dll" ]]; then
      echo "==> Using curated local UE4SS runtime: $(dirname "$curated_dll")" >&2
      printf '%s\n' "$(dirname "$curated_dll")"
      return 0
    fi
    warn "Curated runtime dir exists but UE4SS.dll was not found in $runtime_local_dir; falling back to ZIP extraction."
  fi

  [[ -d "$runtime_zips_dir" ]] || fail "Runtime zips dir not found: $runtime_zips_dir"
  mkdir -p "$extract_dir"

  local -a zip_files=()
  local -a core_candidates=()
  local zip=""

  # Prefer explicit experimental-latest UE4SS runtime packs when present.
  while IFS= read -r -d '' zip; do
    core_candidates+=("$zip")
  done < <(find "$runtime_zips_dir" -maxdepth 1 -type f -iname '*.zip' -iname '*experimental*latest*' -print0 | sort -z)

  # Otherwise use the newest-named UE4SS core runtime archive.
  if [[ "${#core_candidates[@]}" -eq 0 ]]; then
    while IFS= read -r -d '' zip; do
      core_candidates+=("$zip")
    done < <(find "$runtime_zips_dir" -maxdepth 1 -type f \( -iname 'UE4SS*.zip' -o -iname 'zDEV-UE4SS*.zip' \) -print0 | sort -z)
  fi

  if [[ "${#core_candidates[@]}" -gt 0 ]]; then
    zip_files+=("${core_candidates[$((${#core_candidates[@]} - 1))]}")
  fi

  local -a addons=(
    "$runtime_zips_dir/zCustomGameConfigs.zip"
    "$runtime_zips_dir/zMapGenBP.zip"
  )
  local a=""
  for a in "${addons[@]}"; do
    if [[ -f "$a" ]]; then
      zip_files+=("$a")
    fi
  done

  # Fallback: include all zips if no known UE4SS core archive pattern matched.
  if [[ "${#zip_files[@]}" -eq 0 ]]; then
    while IFS= read -r -d '' zip; do
      zip_files+=("$zip")
    done < <(find "$runtime_zips_dir" -maxdepth 1 -type f -name '*.zip' -print0 | sort -z)
  fi

  [[ "${#zip_files[@]}" -gt 0 ]] || fail "No zip files found in $runtime_zips_dir"

  local zips_hash
  zips_hash="$(hash_paths "${zip_files[@]}")"
  local zips_stamp="$extract_dir/.runtime_zips.hash"
  if [[ -f "$zips_stamp" ]] && [[ "$(cat "$zips_stamp")" == "$zips_hash" ]]; then
    local cached_dll
    cached_dll="$(find "$extract_dir" -type f -name 'UE4SS.dll' | head -n 1 || true)"
    if [[ -n "$cached_dll" ]]; then
      echo "==> Reusing cached extracted UE4SS runtime at $(dirname "$cached_dll")" >&2
      printf '%s\n' "$(dirname "$cached_dll")"
      return 0
    fi
  fi

  find "$extract_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  echo "==> Preparing UE4SS runtime from ZIPs" >&2
  local z=""
  for z in "${zip_files[@]}"; do
    echo "    extracting $(basename "$z")" >&2
    extract_zip "$z" "$extract_dir"
  done
  printf '%s\n' "$zips_hash" >"$zips_stamp"

  local nested_dll
  nested_dll="$(find "$extract_dir" -type f -name 'UE4SS.dll' | head -n 1 || true)"
  if [[ -n "$nested_dll" ]]; then
    printf '%s\n' "$(dirname "$nested_dll")"
    return 0
  fi

  fail "UE4SS.dll not found after extracting runtime ZIPs."
}

UE4SS_SDK_DIR="${UE4SS_SDK_DIR:-}"
RUNTIME_DIR=""
RUNTIME_LOCAL_DIR="$REPO_ROOT/external/ue4ss-runtime/current"
RUNTIME_ZIPS_DIR="$REPO_ROOT/external/ue4ss-runtime"
RUNTIME_PROFILE="minimal"
SETTINGS_PROFILE="auto"
CONFIGURATION="Release"
MOD_CONFIGURATION=""
INSTALL_SYSTEM_DEPS=0
SKIP_SETUP=0
SKIP_FRONTEND_INSTALL=0
SKIP_RUST_CORE_BUILD=0
SKIP_MOD_BUILD=0
SKIP_STAGE=0
SKIP_OVERLAY_BUILD=0
DEV_OVERLAY_BUILD=0
FORCE_MINGW_MOD_BUILD=0
MOD_BUILD_PROFILE="auto"
USE_CACHE=1
CLEAR_CACHE=0
PIPELINE_CACHE_DIR="$REPO_ROOT/.cache/pipeline"
PIPELINE_LOG_DIR="$PIPELINE_CACHE_DIR/logs"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ue4ss-sdk-dir)
      UE4SS_SDK_DIR="${2:-}"; shift 2 ;;
    --runtime-dir)
      RUNTIME_DIR="${2:-}"; shift 2 ;;
    --runtime-local-dir)
      RUNTIME_LOCAL_DIR="${2:-}"; shift 2 ;;
    --runtime-zips-dir)
      RUNTIME_ZIPS_DIR="${2:-}"; shift 2 ;;
    --runtime-profile)
      RUNTIME_PROFILE="${2:-}"; shift 2 ;;
    --settings-profile)
      SETTINGS_PROFILE="${2:-}"; shift 2 ;;
    --configuration)
      CONFIGURATION="${2:-}"; shift 2 ;;
    --mod-configuration)
      MOD_CONFIGURATION="${2:-}"; shift 2 ;;
    --install-system-deps)
      INSTALL_SYSTEM_DEPS=1; shift ;;
    --force-mingw-mod-build)
      FORCE_MINGW_MOD_BUILD=1; shift ;;
    --stripped-mod-build)
      MOD_BUILD_PROFILE="stripped"; shift ;;
    --full-mod-build)
      MOD_BUILD_PROFILE="full"; shift ;;
    --skip-setup)
      SKIP_SETUP=1; shift ;;
    --skip-frontend-install)
      SKIP_FRONTEND_INSTALL=1; shift ;;
    --skip-rust-core-build)
      SKIP_RUST_CORE_BUILD=1; shift ;;
    --skip-mod-build)
      SKIP_MOD_BUILD=1; shift ;;
    --skip-stage)
      SKIP_STAGE=1; shift ;;
    --skip-overlay-build)
      SKIP_OVERLAY_BUILD=1; shift ;;
    --dev-overlay-build)
      DEV_OVERLAY_BUILD=1; shift ;;
    --no-cache)
      USE_CACHE=0; shift ;;
    --clear-cache)
      CLEAR_CACHE=1; shift ;;
    -h|--help)
      usage
      exit 0 ;;
    *)
      fail "Unknown argument: $1" ;;
  esac
done

if [[ -z "$MOD_CONFIGURATION" ]]; then
  MOD_CONFIGURATION="$CONFIGURATION"
fi

if [[ "$CONFIGURATION" != "Release" && "$CONFIGURATION" != "Debug" ]]; then
  fail "--configuration must be Release or Debug"
fi
if [[ "$MOD_CONFIGURATION" != "Release" && "$MOD_CONFIGURATION" != "Debug" ]]; then
  fail "--mod-configuration must be Release or Debug"
fi
if [[ "$RUNTIME_PROFILE" != "minimal" && "$RUNTIME_PROFILE" != "full" ]]; then
  fail "--runtime-profile must be minimal or full"
fi
if [[ "$SETTINGS_PROFILE" != "auto" && "$SETTINGS_PROFILE" != "development" && "$SETTINGS_PROFILE" != "production" ]]; then
  fail "--settings-profile must be auto, development, or production"
fi
if [[ "$MOD_BUILD_PROFILE" != "auto" && "$MOD_BUILD_PROFILE" != "stripped" && "$MOD_BUILD_PROFILE" != "full" ]]; then
  fail "--stripped-mod-build/--full-mod-build conflict"
fi
if [[ "$SETTINGS_PROFILE" == "auto" ]]; then
  if [[ "$DEV_OVERLAY_BUILD" -eq 1 || "$CONFIGURATION" == "Debug" ]]; then
    SETTINGS_PROFILE="development"
  else
    SETTINGS_PROFILE="production"
  fi
fi

STRIPPED_MOD_BUILD=0
if [[ "$MOD_BUILD_PROFILE" == "auto" ]]; then
  if [[ "$SETTINGS_PROFILE" == "production" ]]; then
    STRIPPED_MOD_BUILD=1
  fi
elif [[ "$MOD_BUILD_PROFILE" == "stripped" ]]; then
  STRIPPED_MOD_BUILD=1
fi

echo "==> Repo: $REPO_ROOT"
echo "==> Config: $CONFIGURATION"
echo "==> Mod config: $MOD_CONFIGURATION"
echo "==> Runtime profile: $RUNTIME_PROFILE"
echo "==> UE4SS settings profile: $SETTINGS_PROFILE"
if [[ "$STRIPPED_MOD_BUILD" -eq 1 ]]; then
  echo "==> Mod source profile: stripped production"
else
  echo "==> Mod source profile: full development"
fi
if [[ "$USE_CACHE" -eq 1 ]]; then
  echo "==> Cache: enabled ($PIPELINE_CACHE_DIR)"
else
  echo "==> Cache: disabled"
fi

if [[ "$CLEAR_CACHE" -eq 1 ]]; then
  echo "==> Clearing pipeline cache at $PIPELINE_CACHE_DIR"
  rm -rf "$PIPELINE_CACHE_DIR"
fi

if [[ "$SKIP_SETUP" -eq 0 ]]; then
  echo "==> Setup tooling"
  require_cmd pnpm
  require_cmd cargo
  require_cmd rustup
  require_cmd cmake
  require_cmd python3

  if [[ "$INSTALL_SYSTEM_DEPS" -eq 1 ]]; then
    if command -v apt-get >/dev/null 2>&1; then
      run sudo apt-get update
      run sudo apt-get install -y build-essential cmake mingw-w64 python3
    else
      fail "--install-system-deps is only implemented for apt-based systems"
    fi
  fi

  run rustup target add "$TARGET_TRIPLE"
  if ! cargo xwin --version >/dev/null 2>&1; then
    run cargo install cargo-xwin --locked
  fi
fi

if [[ "$SKIP_FRONTEND_INSTALL" -eq 0 ]]; then
  frontend_key="$(
    {
      printf 'step=pnpm-install\n'
      printf 'node=%s\n' "$(node -v 2>/dev/null || echo unknown)"
      printf 'pnpm=%s\n' "$(pnpm -v 2>/dev/null || echo unknown)"
      printf 'src=%s\n' "$(hash_paths "$REPO_ROOT/package.json" "$REPO_ROOT/pnpm-lock.yaml")"
    } | hash_stream
  )"
  if is_cache_hit "pnpm-install" "$frontend_key" "$REPO_ROOT/node_modules"; then
    echo "==> Skipping pnpm install (cache hit)"
  else
    run pnpm install
    write_cache_stamp "pnpm-install" "$frontend_key"
  fi
fi

if [[ "$SKIP_MOD_BUILD" -eq 0 ]]; then
  UE4SS_SDK_DIR="$(resolve_ue4ss_sdk_dir "$UE4SS_SDK_DIR")"
  echo "==> UE4SS SDK: $UE4SS_SDK_DIR"
fi

PROFILE_DIR="debug"
if [[ "$CONFIGURATION" == "Release" ]]; then
  PROFILE_DIR="release"
fi

RUST_CORE_DLL="$REPO_ROOT/ue4ss-rust-core/target/$TARGET_TRIPLE/$PROFILE_DIR/ue4ss_rust_core.dll"
if [[ "$SKIP_RUST_CORE_BUILD" -eq 0 ]]; then
  rust_key="$(
    {
      printf 'step=rust-core\n'
      printf 'config=%s\n' "$CONFIGURATION"
      printf 'target=%s\n' "$TARGET_TRIPLE"
      printf 'cargo=%s\n' "$(cargo -V 2>/dev/null || echo unknown)"
      printf 'xwin=%s\n' "$(cargo xwin --version 2>/dev/null || echo unknown)"
      printf 'src=%s\n' "$(hash_paths "$REPO_ROOT/ue4ss-rust-core/Cargo.toml" "$REPO_ROOT/ue4ss-rust-core/Cargo.lock" "$REPO_ROOT/ue4ss-rust-core/src")"
    } | hash_stream
  )"
  if is_cache_hit "rust-core-$CONFIGURATION" "$rust_key" "$RUST_CORE_DLL"; then
    echo "==> Skipping ue4ss-rust-core build (cache hit)"
  else
    if [[ "$CONFIGURATION" == "Release" ]]; then
      run cargo xwin build --manifest-path ue4ss-rust-core/Cargo.toml --target "$TARGET_TRIPLE" --release
    else
      run cargo xwin build --manifest-path ue4ss-rust-core/Cargo.toml --target "$TARGET_TRIPLE"
    fi
    write_cache_stamp "rust-core-$CONFIGURATION" "$rust_key"
  fi
fi

MOD_BUILD_DIR="$REPO_ROOT/ue4ss-mod/build-w64"
if [[ "$SKIP_MOD_BUILD" -eq 0 ]]; then
  PREPARED_RUNTIME_DIR="$(prepare_runtime_dir "$RUNTIME_DIR" "$RUNTIME_LOCAL_DIR" "$RUNTIME_ZIPS_DIR" "$REPO_ROOT/.cache/ue4ss-runtime")"
  runtime_hash_for_mod="$(hash_paths "$PREPARED_RUNTIME_DIR/UE4SS.dll")"
  if [[ "$FORCE_MINGW_MOD_BUILD" -eq 0 ]] && is_wsl && command -v powershell.exe >/dev/null 2>&1; then
    echo "==> Detected WSL; building ue4ss-mod with Windows MSVC toolchain"
    MOD_BUILD_DIR="$REPO_ROOT/ue4ss-mod/build"
    mod_key="$(
      {
        printf 'step=ue4ss-mod\n'
        printf 'builder=msvc-via-powershell\n'
        printf 'mod_config=%s\n' "$MOD_CONFIGURATION"
        printf 'sdk=%s\n' "$UE4SS_SDK_DIR"
        printf 'stripped_mod=%s\n' "$STRIPPED_MOD_BUILD"
        printf 'runtime=%s\n' "$runtime_hash_for_mod"
        printf 'src=%s\n' "$(hash_paths "$REPO_ROOT/ue4ss-mod/CMakeLists.txt" "$REPO_ROOT/ue4ss-mod/src" "$REPO_ROOT/ue4ss-mod/mod.json")"
      } | hash_stream
    )"
    if is_cache_hit "ue4ss-mod-$MOD_CONFIGURATION" "$mod_key" && mod_output_exists "$REPO_ROOT/ue4ss-mod/build" "$MOD_CONFIGURATION"; then
      echo "==> Skipping ue4ss-mod build (cache hit)"
    else
      generate_ue4ss_import_lib "$PREPARED_RUNTIME_DIR"
      build_mod_with_windows_msvc "$UE4SS_SDK_DIR" "$CONFIGURATION" "$MOD_CONFIGURATION" "$STRIPPED_MOD_BUILD"
      write_cache_stamp "ue4ss-mod-$MOD_CONFIGURATION" "$mod_key"
    fi
  else
    ensure_mingw_toolchain

    mod_key="$(
      {
        printf 'step=ue4ss-mod\n'
        printf 'builder=mingw\n'
        printf 'mod_config=%s\n' "$MOD_CONFIGURATION"
        printf 'sdk=%s\n' "$UE4SS_SDK_DIR"
        printf 'stripped_mod=%s\n' "$STRIPPED_MOD_BUILD"
        printf 'runtime=%s\n' "$runtime_hash_for_mod"
        printf 'cmake=%s\n' "$(cmake --version | head -n 1)"
        printf 'src=%s\n' "$(hash_paths "$REPO_ROOT/ue4ss-mod/CMakeLists.txt" "$REPO_ROOT/ue4ss-mod/src" "$REPO_ROOT/ue4ss-mod/mod.json")"
      } | hash_stream
    )"

    if is_cache_hit "ue4ss-mod-$MOD_CONFIGURATION" "$mod_key" && mod_output_exists "$REPO_ROOT/ue4ss-mod/build-w64" "$MOD_CONFIGURATION"; then
      echo "==> Skipping ue4ss-mod build (cache hit)"
    else
      generate_ue4ss_import_lib "$PREPARED_RUNTIME_DIR"
      cmake_args=(
        -S ue4ss-mod
        -B "$MOD_BUILD_DIR"
        -DUE4SS_SDK_DIR="$UE4SS_SDK_DIR"
        -DCMAKE_SYSTEM_NAME=Windows
        -DCMAKE_C_COMPILER=x86_64-w64-mingw32-gcc
        -DCMAKE_CXX_COMPILER=x86_64-w64-mingw32-g++
        -DCMAKE_RC_COMPILER=x86_64-w64-mingw32-windres
        -DCMAKE_BUILD_TYPE="$MOD_CONFIGURATION"
        -DKOVAAKS_BUILD_STRIPPED_PRODUCTION="$([[ "$STRIPPED_MOD_BUILD" -eq 1 ]] && echo ON || echo OFF)"
      )
      run_logged_step "cmake-configure" cmake "${cmake_args[@]}"
      run_logged_step "cmake-build" cmake --build "$MOD_BUILD_DIR" --config "$MOD_CONFIGURATION"
      write_cache_stamp "ue4ss-mod-$MOD_CONFIGURATION" "$mod_key"
    fi
  fi
fi

if [[ "$SKIP_STAGE" -eq 0 ]]; then
  [[ -f "$RUST_CORE_DLL" ]] || fail "Rust core DLL not found: $RUST_CORE_DLL"
  MOD_MAIN_DLL=""
  if MOD_MAIN_DLL="$(resolve_mod_dll "$MOD_BUILD_DIR" "$MOD_CONFIGURATION")"; then
    :
  elif MOD_MAIN_DLL="$(resolve_mod_dll "$REPO_ROOT/ue4ss-mod/build" "$MOD_CONFIGURATION")"; then
    MOD_BUILD_DIR="$REPO_ROOT/ue4ss-mod/build"
  elif MOD_MAIN_DLL="$(resolve_mod_dll "$REPO_ROOT/ue4ss-mod/build-w64" "$MOD_CONFIGURATION")"; then
    MOD_BUILD_DIR="$REPO_ROOT/ue4ss-mod/build-w64"
  else
    fail "Could not find main.dll in ue4ss-mod/build or ue4ss-mod/build-w64"
  fi
  PREPARED_RUNTIME_DIR="${PREPARED_RUNTIME_DIR:-$(prepare_runtime_dir "$RUNTIME_DIR" "$RUNTIME_LOCAL_DIR" "$RUNTIME_ZIPS_DIR" "$REPO_ROOT/.cache/ue4ss-runtime")}"
  stage_key="$(
    {
      printf 'step=stage\n'
      printf 'profile=%s\n' "$RUNTIME_PROFILE"
      printf 'settings_profile=%s\n' "$SETTINGS_PROFILE"
      printf 'runtime=%s\n' "$(hash_paths "$PREPARED_RUNTIME_DIR")"
      printf 'mod=%s\n' "$(hash_paths "$MOD_MAIN_DLL")"
      printf 'rust=%s\n' "$(hash_paths "$RUST_CORE_DLL")"
      printf 'sync=%s\n' "$(hash_paths "$REPO_ROOT/scripts/sync-ue4ss-payload.sh" "$REPO_ROOT/scripts/ue4ss-settings/development.ini" "$REPO_ROOT/scripts/ue4ss-settings/production.ini" "$REPO_ROOT/ue4ss-mod/mod.json")"
    } | hash_stream
  )"
  if is_cache_hit "stage-$RUNTIME_PROFILE" "$stage_key" "$REPO_ROOT/src-tauri/ue4ss/UE4SS.dll" "$REPO_ROOT/src-tauri/ue4ss/Mods/KovaaksBridgeMod/dlls/main.dll" "$REPO_ROOT/src-tauri/ue4ss/kovaaks_rust_core.dll"; then
    echo "==> Skipping UE4SS payload staging (cache hit)"
  else
    run "$REPO_ROOT/scripts/sync-ue4ss-payload.sh" \
      --runtime-dir "$PREPARED_RUNTIME_DIR" \
      --mod-main-dll "$MOD_MAIN_DLL" \
      --rust-core-dll "$RUST_CORE_DLL" \
      --runtime-profile "$RUNTIME_PROFILE" \
      --settings-profile "$SETTINGS_PROFILE"
    write_cache_stamp "stage-$RUNTIME_PROFILE" "$stage_key"
  fi

  # The running dev/release app syncs from target profile payload folders.
  # Keep those in sync with src-tauri/ue4ss even when stage is a cache hit.
  mirror_tauri_profile_payloads
fi

if [[ "$SKIP_OVERLAY_BUILD" -eq 0 ]]; then
  overlay_mode="release"
  if [[ "$DEV_OVERLAY_BUILD" -eq 1 ]]; then
    overlay_mode="dev"
  fi
  overlay_key="$(
    {
      printf 'step=overlay\n'
      printf 'mode=%s\n' "$overlay_mode"
      printf 'src=%s\n' "$(hash_paths "$REPO_ROOT/src" "$REPO_ROOT/src-tauri/src" "$REPO_ROOT/src-tauri/ue4ss" "$REPO_ROOT/scripts/ue4ss-settings" "$REPO_ROOT/src-tauri/Cargo.toml" "$REPO_ROOT/src-tauri/Cargo.lock" "$REPO_ROOT/src-tauri/tauri.conf.json" "$REPO_ROOT/package.json" "$REPO_ROOT/pnpm-lock.yaml" "$REPO_ROOT/vite.config.ts" "$REPO_ROOT/tsconfig.json")"
    } | hash_stream
  )"
  overlay_marker="$PIPELINE_CACHE_DIR/overlay-$overlay_mode.ok"
  if is_cache_hit "overlay-$overlay_mode" "$overlay_key" "$overlay_marker"; then
    echo "==> Skipping overlay build (cache hit)"
  else
    if [[ "$DEV_OVERLAY_BUILD" -eq 1 ]]; then
      run pnpm run build:win:dev
    else
      run pnpm run build:win
    fi
    mkdir -p "$PIPELINE_CACHE_DIR"
    date -u +"%Y-%m-%dT%H:%M:%SZ" >"$overlay_marker"
    write_cache_stamp "overlay-$overlay_mode" "$overlay_key"
  fi
fi

echo "==> Pipeline complete"
