#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
export LANG=C

APP_NAME="OpsDog"
INSTALL_DIR="${OPSDOG_DOCKER_DIR:-/opt/opsdog-docker}"
HOST="${OPSDOG_HOST:-0.0.0.0}"
PORT="${OPSDOG_PORT:-8788}"
CONTAINER_NAME="${OPSDOG_CONTAINER_NAME:-opsdog}"
IMAGE_NAME="${OPSDOG_IMAGE_NAME:-opsdog:local}"
PACKAGE_PATH=""
RESET_DATA=0
NO_CACHE=0
TEMP_DIR=""

usage() {
  cat <<'EOF'
Usage: ./one-click-docker-deploy.sh [options]

Put this script beside OpsDog-docker-*.tar.gz, then run:

  chmod +x one-click-docker-deploy.sh
  ./one-click-docker-deploy.sh

Options:
  --package <path>     Use a specific OpsDog-docker-*.tar.gz package.
  --dir <path>         Install directory, default /opt/opsdog-docker.
  --host <host>        Server origin host, default 0.0.0.0.
  --port <port>        Host port, default 8788.
  --name <name>        Docker container name, default opsdog.
  --image <name>       Docker image tag, default opsdog:local.
  --reset-data         Reset persisted server data to empty package templates.
  --no-cache           Build Docker image without cache.
  -h, --help           Show this help.
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
    --name)
      CONTAINER_NAME="${2:-}"
      shift
      ;;
    --image)
      IMAGE_NAME="${2:-}"
      shift
      ;;
    --reset-data) RESET_DATA=1 ;;
    --no-cache) NO_CACHE=1 ;;
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
  printf '[%s docker] %s\n' "$APP_NAME" "$*"
}

fail() {
  printf '[%s docker] ERROR: %s\n' "$APP_NAME" "$*" >&2
  exit 1
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
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

detect_pkg_manager() {
  if has_cmd apt-get; then echo apt; return; fi
  if has_cmd dnf; then echo dnf; return; fi
  if has_cmd yum; then echo yum; return; fi
  if has_cmd pacman; then echo pacman; return; fi
  if has_cmd apk; then echo apk; return; fi
  echo none
}

install_preflight_tools() {
  has_cmd tar && has_cmd gzip && has_cmd curl && return 0

  local manager
  manager="$(detect_pkg_manager)"
  case "$manager" in
    apt)
      run_root apt-get update
      run_root apt-get install -y ca-certificates curl gzip tar
      ;;
    dnf)
      run_root dnf install -y ca-certificates curl gzip tar
      ;;
    yum)
      run_root yum install -y ca-certificates curl gzip tar
      ;;
    pacman)
      run_root pacman -Sy --needed --noconfirm ca-certificates curl gzip tar
      ;;
    apk)
      run_root apk add --no-cache ca-certificates curl gzip tar
      ;;
    *)
      fail "tar, gzip and curl are required, and no supported package manager was found."
      ;;
  esac
}

install_docker() {
  if has_cmd docker && docker info >/dev/null 2>&1; then
    return 0
  fi

  local manager
  manager="$(detect_pkg_manager)"
  log "Installing Docker..."
  case "$manager" in
    apt)
      run_root apt-get update
      run_root apt-get install -y ca-certificates curl gnupg
      curl -fsSL https://get.docker.com | run_root sh
      ;;
    dnf)
      run_root dnf install -y dnf-plugins-core ca-certificates curl
      run_root dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo || true
      run_root dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || curl -fsSL https://get.docker.com | run_root sh
      ;;
    yum)
      run_root yum install -y yum-utils device-mapper-persistent-data lvm2 ca-certificates curl
      run_root yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo || true
      run_root yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || curl -fsSL https://get.docker.com | run_root sh
      ;;
    pacman)
      run_root pacman -Sy --needed --noconfirm docker
      ;;
    apk)
      run_root apk add --no-cache docker
      ;;
    *)
      curl -fsSL https://get.docker.com | run_root sh
      ;;
  esac

  if has_cmd systemctl; then
    run_root systemctl enable --now docker
  elif has_cmd service; then
    run_root service docker start
  fi

  docker info >/dev/null 2>&1 || fail "Docker is installed but not running."
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
  local candidates=("$script_dir"/OpsDog-docker-*.tar.gz "$PWD"/OpsDog-docker-*.tar.gz)
  shopt -u nullglob
  [[ "${#candidates[@]}" -gt 0 ]] || fail "No OpsDog-docker-*.tar.gz package found beside this script."
  printf '%s\n' "${candidates[@]}" | sort -r | head -n 1
}

stop_legacy_install() {
  if [[ -x /opt/opsdog/stop-linux.sh ]]; then
    log "Stopping legacy non-Docker OpsDog install."
    run_root bash /opt/opsdog/stop-linux.sh || true
  elif [[ -f /opt/opsdog/opsdog.pid ]]; then
    local legacy_pid
    legacy_pid="$(cat /opt/opsdog/opsdog.pid 2>/dev/null || true)"
    if [[ -n "$legacy_pid" ]] && kill -0 "$legacy_pid" >/dev/null 2>&1; then
      log "Stopping legacy non-Docker OpsDog process: $legacy_pid"
      run_root kill "$legacy_pid" || true
    fi
  fi
}

find_port_pids() {
  local pids=""
  if has_cmd ss; then
    pids="$(ss -ltnp 2>/dev/null | awk -v port=":${PORT}" '$4 ~ port {print $NF}' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
  fi
  if [[ -z "$pids" ]] && has_cmd netstat; then
    pids="$(netstat -ltnp 2>/dev/null | awk -v port=":${PORT}" '$4 ~ port {print $NF}' | grep -oE '^[0-9]+' | sort -u || true)"
  fi
  printf '%s\n' "$pids" | sed '/^$/d'
}

is_legacy_opsdog_pid() {
  local pid="$1"
  local args cwd
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"

  [[ "$args" == *"server/src/index.js"* ]] || return 1
  [[ "$cwd" == /opt/opsdog* || "$args" == *"/opt/opsdog"* || "$args" == *"node server/src/index.js"* ]]
}

stop_legacy_port_conflicts() {
  local pid args
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if is_legacy_opsdog_pid "$pid"; then
      log "Stopping legacy OpsDog process on port $PORT: $pid"
      run_root kill "$pid" 2>/dev/null || true
      sleep 2
      if kill -0 "$pid" >/dev/null 2>&1; then
        run_root kill -9 "$pid" 2>/dev/null || true
      fi
      continue
    fi

    args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    fail "Port $PORT is occupied by PID $pid: ${args:-unknown process}. Stop it or pass --port <port>."
  done < <(find_port_pids)
}

stop_container() {
  if docker ps -a --format '{{.Names}}' | grep -Fx "$CONTAINER_NAME" >/dev/null; then
    log "Removing existing container: $CONTAINER_NAME"
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi
}

prepare_data_dir() {
  local source_data="$1"
  local data_dir="$2"
  local logs_dir="$3"

  if [[ "$RESET_DATA" -eq 1 ]]; then
    run_root rm -rf "$data_dir"
  fi

  run_root mkdir -p "$data_dir" "$logs_dir"
  if [[ ! -f "$data_dir/assets/devices.local.json" ]]; then
    run_root cp -a "$source_data"/. "$data_dir"/
  fi
}

main() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    fail "This deployment script only supports Linux."
  fi

  install_preflight_tools
  install_docker

  local package_file extracted_dir app_dir data_dir logs_dir
  package_file="$(find_package)"
  TEMP_DIR="$(mktemp -d)"
  trap '[[ -n "${TEMP_DIR:-}" ]] && rm -rf "$TEMP_DIR"' EXIT

  log "Using package: $package_file"
  tar -xzf "$package_file" -C "$TEMP_DIR"
  extracted_dir="$(find "$TEMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [[ -n "$extracted_dir" && -f "$extracted_dir/Dockerfile" ]] || fail "Invalid OpsDog Docker package: Dockerfile is missing."

  app_dir="$INSTALL_DIR/app"
  data_dir="$INSTALL_DIR/data"
  logs_dir="$INSTALL_DIR/logs"

  stop_legacy_install
  stop_container
  stop_legacy_port_conflicts

  log "Installing Docker build context to $app_dir"
  run_root rm -rf "$app_dir"
  run_root mkdir -p "$app_dir"
  run_root cp -a "$extracted_dir"/. "$app_dir"/
  prepare_data_dir "$app_dir/server/data" "$data_dir" "$logs_dir"

  log "Building Docker image: $IMAGE_NAME"
  if [[ "$NO_CACHE" -eq 1 ]]; then
    docker build --no-cache -t "$IMAGE_NAME" "$app_dir"
  else
    docker build -t "$IMAGE_NAME" "$app_dir"
  fi

  log "Starting container: $CONTAINER_NAME"
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    -p "${PORT}:8788" \
    -v "$DATA_DIR:/app/server/data" \
    -v "$LOGS_DIR:/app/logs" \
    -e NODE_ENV=production \
    -e ASSET_API_MODE=local \
    -e OPSDOG_SERVER_ORIGIN="http://${HOST}:${PORT}" \
    -e OPSDOG_WEB_ORIGIN="http://${HOST}:${PORT}" \
    -e VITE_API_BASE_URL=/api \
    "$IMAGE_NAME" >/dev/null

  log "Waiting for health check..."
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      log "Health check OK: http://127.0.0.1:${PORT}/"
      log "Deployment finished."
      return 0
    fi
    sleep 1
  done

  docker logs --tail 120 "$CONTAINER_NAME" >&2 || true
  fail "Health check failed: http://127.0.0.1:${PORT}/api/health"
}

DATA_DIR="$INSTALL_DIR/data"
LOGS_DIR="$INSTALL_DIR/logs"

main
