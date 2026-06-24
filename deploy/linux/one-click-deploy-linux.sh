#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
export LANG=C

APP_NAME="OpsDog"
DEFAULT_INSTALL_DIR="/opt/opsdog"
INSTALL_DIR="${OPSDOG_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
HOST="${OPSDOG_HOST:-0.0.0.0}"
PORT="${OPSDOG_PORT:-8788}"
PACKAGE_PATH=""
START_AFTER_INSTALL=1
RESET_ASSETS=0
SKIP_SYSTEM_PACKAGES=0
SKIP_NODE_INSTALL=0
TEMP_DIR=""

usage() {
  cat <<'EOF'
Usage: ./one-click-deploy-linux.sh [options]

Put this script beside OpsDog-linux-*.tar.gz, then run:

  chmod +x one-click-deploy-linux.sh
  ./one-click-deploy-linux.sh

Options:
  --package <path>          Use a specific OpsDog-linux-*.tar.gz package.
  --dir <path>              Install directory, default /opt/opsdog.
  --host <host>             Bind host, default 0.0.0.0.
  --port <port>             Bind port, default 8788.
  --no-start                Install but do not start OpsDog.
  --reset-assets            Reset device inventory to empty JSON files.
  --skip-system-packages    Do not install OS packages.
  --skip-node-install       Do not attempt to install Node.js.
  -h, --help                Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package)
      PACKAGE_PATH="${2:-}"
      shift
      ;;
    --dir)
      INSTALL_DIR="${2:-}"
      shift
      ;;
    --host)
      HOST="${2:-}"
      shift
      ;;
    --port)
      PORT="${2:-}"
      shift
      ;;
    --no-start) START_AFTER_INSTALL=0 ;;
    --reset-assets) RESET_ASSETS=1 ;;
    --skip-system-packages) SKIP_SYSTEM_PACKAGES=1 ;;
    --skip-node-install) SKIP_NODE_INSTALL=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

log() {
  printf '[%s deploy] %s\n' "$APP_NAME" "$*"
}

fail() {
  printf '[%s deploy] ERROR: %s\n' "$APP_NAME" "$*" >&2
  exit 1
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

detect_pkg_manager() {
  if has_cmd apt-get; then echo apt; return; fi
  if has_cmd dnf; then echo dnf; return; fi
  if has_cmd yum; then echo yum; return; fi
  if has_cmd pacman; then echo pacman; return; fi
  if has_cmd apk; then echo apk; return; fi
  echo none
}

run_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  elif has_cmd sudo; then
    sudo "$@"
  else
    fail "Root privileges are required. Run as root or install sudo."
  fi
}

install_preflight_tools() {
  has_cmd tar && has_cmd gzip && return 0

  local manager
  manager="$(detect_pkg_manager)"
  case "$manager" in
    apt)
      run_root apt-get update
      run_root apt-get install -y tar gzip ca-certificates
      ;;
    dnf)
      run_root dnf install -y tar gzip ca-certificates
      ;;
    yum)
      run_root yum install -y tar gzip ca-certificates
      ;;
    pacman)
      run_root pacman -Sy --needed --noconfirm tar gzip ca-certificates
      ;;
    apk)
      run_root apk add --no-cache tar gzip ca-certificates
      ;;
    *)
      fail "tar and gzip are required, and no supported package manager was found."
      ;;
  esac
}

resolve_script_dir() {
  local source="${BASH_SOURCE[0]}"
  while [[ -L "$source" ]]; do
    local dir
    dir="$(cd -P "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    [[ "$source" != /* ]] && source="$dir/$source"
  done
  cd -P "$(dirname "$source")" && pwd
}

find_package() {
  if [[ -n "$PACKAGE_PATH" ]]; then
    [[ -f "$PACKAGE_PATH" ]] || fail "Package not found: $PACKAGE_PATH"
    cd "$(dirname "$PACKAGE_PATH")" && printf '%s\n' "$(pwd)/$(basename "$PACKAGE_PATH")"
    return 0
  fi

  local script_dir
  script_dir="$(resolve_script_dir)"
  shopt -s nullglob
  local candidates=("$script_dir"/OpsDog-linux-*.tar.gz "$PWD"/OpsDog-linux-*.tar.gz)
  shopt -u nullglob
  [[ "${#candidates[@]}" -gt 0 ]] || fail "No OpsDog-linux-*.tar.gz package found beside this script."
  printf '%s\n' "${candidates[@]}" | sort -r | head -n 1
}

display_host() {
  if [[ "$HOST" != "0.0.0.0" && "$HOST" != "::" ]]; then
    printf '%s\n' "$HOST"
    return 0
  fi

  local detected
  detected="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -n "$detected" ]]; then
    printf '%s\n' "$detected"
    return 0
  fi

  printf '127.0.0.1\n'
}

copy_local_node_archives() {
  local extracted_dir="$1"
  local script_dir archive
  script_dir="$(resolve_script_dir)"

  shopt -s nullglob
  for archive in "$script_dir"/node-v*-linux-*.tar.xz "$PWD"/node-v*-linux-*.tar.xz; do
    [[ -f "$archive" ]] || continue
    log "Including local Node.js archive: $archive"
    cp -f "$archive" "$extracted_dir/"
  done
  shopt -u nullglob
}

main() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    fail "This deployment script only supports Linux."
  fi

  case "$(uname -m)" in
    x86_64|aarch64|arm64) ;;
    *) fail "Unsupported architecture: $(uname -m)" ;;
  esac

  install_preflight_tools

  local package_file extracted_dir previous_dir install_args
  package_file="$(find_package)"
  TEMP_DIR="$(mktemp -d)"
  trap '[[ -n "${TEMP_DIR:-}" ]] && rm -rf "$TEMP_DIR"' EXIT

  log "Using package: $package_file"
  log "Extracting package..."
  tar -xzf "$package_file" -C "$TEMP_DIR"
  extracted_dir="$(find "$TEMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [[ -n "$extracted_dir" && -f "$extracted_dir/install-linux.sh" ]] || fail "Invalid OpsDog package: install-linux.sh is missing."
  copy_local_node_archives "$extracted_dir"

  previous_dir=""
  if [[ -d "$INSTALL_DIR" ]]; then
    previous_dir="${INSTALL_DIR}.previous-$(date +%Y%m%d-%H%M%S)"
    log "Existing install found; moving it to $previous_dir"
    if [[ -x "$INSTALL_DIR/stop-linux.sh" ]]; then
      run_root bash "$INSTALL_DIR/stop-linux.sh" || true
    fi
    run_root mv "$INSTALL_DIR" "$previous_dir"
  fi

  log "Installing to $INSTALL_DIR"
  run_root mkdir -p "$INSTALL_DIR"
  run_root cp -a "$extracted_dir"/. "$INSTALL_DIR"/

  if [[ -n "$previous_dir" ]]; then
    if [[ -f "$previous_dir/.env" ]]; then
      run_root cp -a "$previous_dir/.env" "$INSTALL_DIR/.env"
    fi
    if [[ -d "$previous_dir/server/data" && "$RESET_ASSETS" -eq 0 ]]; then
      run_root rm -rf "$INSTALL_DIR/server/data"
      run_root mkdir -p "$INSTALL_DIR/server"
      run_root cp -a "$previous_dir/server/data" "$INSTALL_DIR/server/data"
    fi
  fi

  run_root chmod +x "$INSTALL_DIR/install-linux.sh"

  install_args=(-y --host "$HOST" --port "$PORT")
  [[ "$START_AFTER_INSTALL" -eq 0 ]] && install_args+=(--no-start)
  [[ "$RESET_ASSETS" -eq 1 ]] && install_args+=(--reset-assets)
  [[ "$SKIP_SYSTEM_PACKAGES" -eq 1 ]] && install_args+=(--skip-system-packages)
  [[ "$SKIP_NODE_INSTALL" -eq 1 ]] && install_args+=(--skip-node-install)

  log "Running installer..."
  (
    cd "$INSTALL_DIR"
    run_root bash ./install-linux.sh "${install_args[@]}"
  )

  log "Deployment finished."
  log "Install dir: $INSTALL_DIR"
  log "URL: http://$(display_host):$PORT/"
}

main
