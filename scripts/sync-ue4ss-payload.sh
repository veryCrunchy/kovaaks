#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/sync-ue4ss-payload.sh \
    --runtime-dir "<extracted-ue4ss-runtime-dir>" \
    --mod-main-dll "<path-to-main.dll>" \
    --rust-core-dll "<path-to-kovaaks_rust_core.dll>" \
    [--runtime-profile minimal|full] \
    [--settings-profile auto|development|production] \
    [--dest-dir "<repo>/src-tauri/ue4ss"]
EOF
}

RUNTIME_DIR=""
MOD_MAIN_DLL=""
RUST_CORE_DLL=""
DEST_DIR="$REPO_ROOT/src-tauri/ue4ss"
RUNTIME_PROFILE="minimal"
SETTINGS_PROFILE="auto"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-dir)
      RUNTIME_DIR="${2:-}"; shift 2 ;;
    --mod-main-dll)
      MOD_MAIN_DLL="${2:-}"; shift 2 ;;
    --rust-core-dll)
      RUST_CORE_DLL="${2:-}"; shift 2 ;;
    --runtime-profile)
      RUNTIME_PROFILE="${2:-}"; shift 2 ;;
    --settings-profile)
      SETTINGS_PROFILE="${2:-}"; shift 2 ;;
    --dest-dir)
      DEST_DIR="${2:-}"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1 ;;
  esac
done

if [[ -z "$RUNTIME_DIR" || -z "$MOD_MAIN_DLL" || -z "$RUST_CORE_DLL" ]]; then
  echo "Missing required args." >&2
  usage
  exit 1
fi

if [[ "$RUNTIME_PROFILE" != "minimal" && "$RUNTIME_PROFILE" != "full" ]]; then
  echo "Invalid --runtime-profile: $RUNTIME_PROFILE (expected minimal or full)" >&2
  exit 1
fi
if [[ "$SETTINGS_PROFILE" != "auto" && "$SETTINGS_PROFILE" != "development" && "$SETTINGS_PROFILE" != "production" ]]; then
  echo "Invalid --settings-profile: $SETTINGS_PROFILE (expected auto, development, or production)" >&2
  exit 1
fi

RUNTIME_DIR="$(realpath "$RUNTIME_DIR")"
MOD_MAIN_DLL="$(realpath "$MOD_MAIN_DLL")"
RUST_CORE_DLL="$(realpath "$RUST_CORE_DLL")"
DEST_DIR="$(realpath -m "$DEST_DIR")"

if [[ ! -d "$RUNTIME_DIR" ]]; then
  echo "Runtime directory not found: $RUNTIME_DIR" >&2
  exit 1
fi
if [[ ! -f "$MOD_MAIN_DLL" ]]; then
  echo "Mod main DLL not found: $MOD_MAIN_DLL" >&2
  exit 1
fi
if [[ ! -f "$RUST_CORE_DLL" ]]; then
  echo "Rust core DLL not found: $RUST_CORE_DLL" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

is_dest_inside_repo=0
case "$DEST_DIR" in
  "$REPO_ROOT"|"$REPO_ROOT"/*)
    is_dest_inside_repo=1
    ;;
esac

cleanup_managed_payload_only() {
  local managed_paths=(
    "$DEST_DIR/UE4SS.dll"
    "$DEST_DIR/UE4SS-settings.ini"
    "$DEST_DIR/UE4SS_Signatures"
    "$DEST_DIR/VTableLayoutTemplates"
    "$DEST_DIR/MemberVarLayoutTemplates"
    "$DEST_DIR/.kovaaks_overlay_profile"
    "$DEST_DIR/.kovaaks_overlay_settings_profile"
    "$DEST_DIR/kovaaks_rust_core.dll"
    "$DEST_DIR/Mods/KovaaksBridgeMod"
    "$DEST_DIR/Mods/mods.txt"
  )
  local path=""
  for path in "${managed_paths[@]}"; do
    if [[ -e "$path" ]]; then
      rm -rf "$path"
    fi
  done
}

# Start clean for deterministic updates, but never wipe non-repo destinations.
if [[ "$is_dest_inside_repo" -eq 1 ]]; then
  find "$DEST_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
else
  echo "Notice: external destination detected; cleaning managed UE4SS payload files only." >&2
  cleanup_managed_payload_only
fi

copy_rel_file() {
  local rel="$1"
  local required="${2:-1}"
  local src="$RUNTIME_DIR/$rel"
  local dst="$DEST_DIR/$rel"
  if [[ ! -f "$src" ]]; then
    if [[ "$required" -eq 1 ]]; then
      echo "Required runtime file missing: $src" >&2
      exit 1
    fi
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  cp -f "$src" "$dst"
}

copy_rel_dir() {
  local rel="$1"
  local src="$RUNTIME_DIR/$rel"
  if [[ ! -d "$src" ]]; then
    return 0
  fi
  while IFS= read -r -d '' file; do
    local file_rel="${file#"$RUNTIME_DIR"/}"
    local dst="$DEST_DIR/$file_rel"
    mkdir -p "$(dirname "$dst")"
    cp -f "$file" "$dst"
  done < <(find "$src" -type f -print0)
}

if [[ "$RUNTIME_PROFILE" == "full" ]]; then
  # Copy runtime recursively, excluding archives.
  while IFS= read -r -d '' file; do
    rel="${file#"$RUNTIME_DIR"/}"
    rel_lc="${rel,,}"
    if [[ "$rel_lc" == "dwmapi.dll" ]] \
      || [[ "$rel_lc" == "readme.md" ]] \
      || [[ "$rel_lc" == "readme.txt" ]] \
      || [[ "$rel_lc" == "changelog.md" ]] \
      || [[ "$rel_lc" == "api.txt" ]] \
      || [[ "$rel_lc" == "ue4ss.pdb" ]] \
      || [[ "$rel_lc" == *.pdb ]]; then
      continue
    fi
    # Keep "full" profile curated: do not ship upstream sample game packs/mods.
    if [[ "$rel_lc" == mods/* ]] \
      || [[ "$rel_lc" == customgameconfigs/* ]] \
      || [[ "$rel_lc" == mapgenbp/* ]] \
      || [[ "$rel_lc" == content/mapgen/* ]] \
      || [[ "$rel_lc" == atomic\ heart/* ]] \
      || [[ "$rel_lc" == borderlands\ 3/* ]] \
      || [[ "$rel_lc" == final\ fantasy\ 7\ remake/* ]] \
      || [[ "$rel_lc" == fuser/* ]] \
      || [[ "$rel_lc" == ghost\ wire\ tokyo/* ]] \
      || [[ "$rel_lc" == kingdom\ hearts\ 3/* ]] \
      || [[ "$rel_lc" == like\ a\ dragon\ ishin\!/* ]] \
      || [[ "$rel_lc" == returnal/* ]] \
      || [[ "$rel_lc" == scp\ 5k/* ]] \
      || [[ "$rel_lc" == satisfactory/* ]] \
      || [[ "$rel_lc" == star\ wars\ jedi\ fallen\ order/* ]] \
      || [[ "$rel_lc" == star\ wars\ jedi\ survivor/* ]] \
      || [[ "$rel_lc" == the\ outer\ worlds/* ]] \
      || [[ "$rel_lc" == walking\ dead\ saints\ \&\ sinners/* ]] \
      ; then
      continue
    fi
    dst="$DEST_DIR/$rel"
    mkdir -p "$(dirname "$dst")"
    cp -f "$file" "$dst"
  done < <(
    find "$RUNTIME_DIR" -type f \
      ! -iname '*.zip' \
      ! -iname '*.7z' \
      ! -iname '*.rar' \
      -print0
  )
else
  # Minimal profile: only core runtime + generic templates/signatures.
  copy_rel_file "UE4SS.dll" 1
  copy_rel_file "UE4SS-settings.ini" 0
  copy_rel_dir "UE4SS_Signatures"
  copy_rel_dir "VTableLayoutTemplates"
  copy_rel_dir "MemberVarLayoutTemplates"
fi

# Persist profile marker so runtime deploy can enforce copy policy.
printf '%s\n' "$RUNTIME_PROFILE" >"$DEST_DIR/.kovaaks_overlay_profile"

EFFECTIVE_SETTINGS_PROFILE="$SETTINGS_PROFILE"
if [[ "$EFFECTIVE_SETTINGS_PROFILE" == "auto" ]]; then
  if [[ "$RUNTIME_PROFILE" == "full" ]]; then
    EFFECTIVE_SETTINGS_PROFILE="development"
  else
    EFFECTIVE_SETTINGS_PROFILE="production"
  fi
fi

SETTINGS_TEMPLATE="$REPO_ROOT/scripts/ue4ss-settings/production.ini"
if [[ "$EFFECTIVE_SETTINGS_PROFILE" == "development" ]]; then
  SETTINGS_TEMPLATE="$REPO_ROOT/scripts/ue4ss-settings/development.ini"
fi
if [[ ! -f "$SETTINGS_TEMPLATE" ]]; then
  echo "UE4SS settings template not found: $SETTINGS_TEMPLATE" >&2
  exit 1
fi
cp -f "$SETTINGS_TEMPLATE" "$DEST_DIR/UE4SS-settings.ini"
printf '%s\n' "$EFFECTIVE_SETTINGS_PROFILE" >"$DEST_DIR/.kovaaks_overlay_settings_profile"

# Install managed mod payload.
MANAGED_MOD_DIR="$DEST_DIR/Mods/KovaaksBridgeMod"
DLL_DIR="$MANAGED_MOD_DIR/dlls"
mkdir -p "$DLL_DIR"

cp -f "$REPO_ROOT/ue4ss-mod/mod.json" "$MANAGED_MOD_DIR/mod.json"
cp -f "$MOD_MAIN_DLL" "$DLL_DIR/main.dll"
cp -f "$RUST_CORE_DLL" "$DEST_DIR/kovaaks_rust_core.dll"
touch "$MANAGED_MOD_DIR/enabled.txt"

MODS_TXT="$DEST_DIR/Mods/mods.txt"
mkdir -p "$(dirname "$MODS_TXT")"
# Use enabled.txt as the single source of truth to avoid duplicate C++ mod startup
# across UE4SS load passes.
cat >"$MODS_TXT" <<'EOF'
; Managed by kovaaks pipeline.
; C++ mods are enabled via per-mod enabled.txt only.
EOF

echo "UE4SS payload staged at $DEST_DIR (profile=$RUNTIME_PROFILE settings=$EFFECTIVE_SETTINGS_PROFILE)"
