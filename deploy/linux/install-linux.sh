#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
export LANG=C

APP_NAME="OpsDog"
MIN_NODE_MAJOR=22
NODE_TARBALL_VERSION="${NODE_TARBALL_VERSION:-22.22.3}"
HOST="0.0.0.0"
PORT="8788"
CHECK_ONLY=0
START_AFTER_INSTALL=1
SKIP_SYSTEM_PACKAGES=0
SKIP_NODE_INSTALL=0
RESET_ASSETS=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Usage: ./install-linux.sh [options]

Options:
  --check-only             Only check the environment, do not install.
  --no-start               Install dependencies but do not start OpsDog.
  --reset-assets           Reset device inventory to empty JSON files.
  --skip-system-packages   Do not install OS packages.
  --skip-node-install      Do not attempt to install Node.js.
  --host <host>            Bind host, default 0.0.0.0.
  --port <port>            Bind port, default 8788.
  -y, --yes                Non-interactive mode.
  -h, --help               Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-only) CHECK_ONLY=1 ;;
    --no-start) START_AFTER_INSTALL=0 ;;
    --reset-assets) RESET_ASSETS=1 ;;
    --skip-system-packages) SKIP_SYSTEM_PACKAGES=1 ;;
    --skip-node-install) SKIP_NODE_INSTALL=1 ;;
    --host)
      HOST="${2:-}"
      shift
      ;;
    --port)
      PORT="${2:-}"
      shift
      ;;
    -y|--yes) ASSUME_YES=1 ;;
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
  printf '[%s] %s\n' "$APP_NAME" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$APP_NAME" "$*" >&2
  exit 1
}

confirm() {
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    return 0
  fi
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]]
}

find_app_dir() {
  local current
  current="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [[ "$current" != "/" ]]; do
    if [[ -f "$current/package.json" && -f "$current/server/src/index.js" ]]; then
      printf '%s\n' "$current"
      return 0
    fi
    current="$(dirname "$current")"
  done
  return 1
}

APP_DIR="$(find_app_dir)" || fail "Cannot locate OpsDog package root."
cd "$APP_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "This installer only supports Linux."
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|aarch64|arm64) ;;
  *) fail "Unsupported architecture: $ARCH" ;;
esac

SUDO=()
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO=(sudo)
  else
    SUDO=()
  fi
fi

run_root() {
  if [[ "${#SUDO[@]}" -gt 0 ]]; then
    "${SUDO[@]}" "$@"
  elif [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  else
    fail "Root privileges are required for: $*"
  fi
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

node_major() {
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

node_runtime_ok() {
  has_cmd node && has_cmd npm && [[ "$(node_major)" -ge "$MIN_NODE_MAJOR" ]]
}

install_os_packages() {
  [[ "$SKIP_SYSTEM_PACKAGES" -eq 1 ]] && return 0
  local manager
  manager="$(detect_pkg_manager)"
  case "$manager" in
    apt)
      run_root apt-get update
      run_root apt-get install -y ca-certificates curl git openssh-client python3 python3-pip iputils-ping build-essential xz-utils
      ;;
    dnf)
      run_root dnf install -y ca-certificates curl git openssh-clients python3 python3-pip iputils gcc gcc-c++ make xz
      ;;
    yum)
      run_root yum install -y ca-certificates curl git openssh-clients python3 python3-pip iputils gcc gcc-c++ make xz
      ;;
    pacman)
      run_root pacman -Sy --needed --noconfirm ca-certificates curl git openssh python python-pip iputils base-devel xz
      ;;
    apk)
      run_root apk add --no-cache ca-certificates curl git openssh-client python3 py3-pip iputils build-base xz
      ;;
    none)
      log "No supported package manager found; skipping OS package installation."
      ;;
  esac
}

node_tarball_arch() {
  case "$ARCH" in
    x86_64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) fail "Unsupported Node.js tarball architecture: $ARCH" ;;
  esac
}

find_local_node_archive() {
  local archive_name="$1"
  local candidate
  for candidate in \
    "$APP_DIR/$archive_name" \
    "$APP_DIR/deploy/linux/$archive_name" \
    "$APP_DIR/deploy/linux/vendor/$archive_name"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

install_node_tarball_archive() {
  local base_url="$1"
  local archive_name="$2"
  local temp_dir node_install_dir local_archive
  temp_dir="$(mktemp -d)"
  node_install_dir="/opt/nodejs-${NODE_TARBALL_VERSION}-${archive_name%.tar.xz}"

  if local_archive="$(find_local_node_archive "$archive_name")"; then
    log "Using local Node.js archive: $local_archive"
    cp "$local_archive" "${temp_dir}/${archive_name}"
  else
    log "Downloading Node.js archive: ${base_url}/${archive_name}"
    curl -fsSL "${base_url}/${archive_name}" -o "${temp_dir}/${archive_name}"
  fi
  run_root mkdir -p "$node_install_dir"
  run_root tar -xJf "${temp_dir}/${archive_name}" -C "$node_install_dir" --strip-components=1
  run_root ln -sfn "$node_install_dir" "/opt/nodejs"
  run_root ln -sfn "/opt/nodejs/bin/node" "/usr/local/bin/node"
  run_root ln -sfn "/opt/nodejs/bin/npm" "/usr/local/bin/npm"
  run_root ln -sfn "/opt/nodejs/bin/npx" "/usr/local/bin/npx"
  printf 'export PATH="/opt/nodejs/bin:$PATH"\n' | run_root tee /etc/profile.d/opsdog-node.sh >/dev/null
  export PATH="/opt/nodejs/bin:$PATH"
  rm -rf "$temp_dir"
}

install_node_from_tarball() {
  local node_tarball_arch archive_name base_url
  node_tarball_arch="$(node_tarball_arch)"
  archive_name="node-v${NODE_TARBALL_VERSION}-linux-${node_tarball_arch}.tar.xz"
  base_url="https://nodejs.org/dist/v${NODE_TARBALL_VERSION}"
  install_node_tarball_archive "$base_url" "$archive_name"
}

install_node_from_unofficial_glibc217() {
  if [[ "$ARCH" != "x86_64" ]]; then
    return 1
  fi

  local archive_name base_url
  archive_name="node-v${NODE_TARBALL_VERSION}-linux-x64-glibc-217.tar.xz"
  base_url="https://unofficial-builds.nodejs.org/download/release/v${NODE_TARBALL_VERSION}"
  install_node_tarball_archive "$base_url" "$archive_name"
}

install_node_from_local_glibc217_if_available() {
  if [[ "$ARCH" != "x86_64" ]]; then
    return 1
  fi

  local archive_name
  archive_name="node-v${NODE_TARBALL_VERSION}-linux-x64-glibc-217.tar.xz"
  find_local_node_archive "$archive_name" >/dev/null || return 1
  install_node_tarball_archive "local" "$archive_name"
}

ensure_node_runtime_after_install() {
  if node_runtime_ok; then
    return 0
  fi

  if [[ "$ARCH" == "x86_64" ]]; then
    log "Installed Node.js cannot run on this system; trying the linux-x64-glibc-217 build."
    install_node_from_unofficial_glibc217
  fi

  node_runtime_ok || fail "Node.js ${MIN_NODE_MAJOR}+ is required, but automatic installation did not produce a usable runtime."
}

install_node() {
  [[ "$SKIP_NODE_INSTALL" -eq 1 ]] && return 0
  if node_runtime_ok; then
    return 0
  fi

  install_node_from_local_glibc217_if_available && return 0

  local manager
  manager="$(detect_pkg_manager)"
  case "$manager" in
    apt)
      run_root apt-get update
      run_root apt-get install -y ca-certificates curl gnupg
      curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | run_root bash -
      run_root apt-get install -y nodejs || install_node_from_tarball
      ;;
    dnf|yum)
      curl -fsSL "https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | run_root bash -
      run_root "$manager" install -y nodejs || install_node_from_tarball
      ;;
    *)
      install_node_from_tarball
      ;;
  esac

  ensure_node_runtime_after_install
}

check_runtime() {
  has_cmd node || fail "node is missing."
  has_cmd npm || fail "npm is missing."
  local major
  major="$(node_major)"
  [[ "$major" -ge "$MIN_NODE_MAJOR" ]] || fail "Node.js ${MIN_NODE_MAJOR}+ is required; current major version is ${major}."
  has_cmd python3 || fail "python3 is missing."
  has_cmd git || log "git is missing; some runtime tools may be unavailable."
  has_cmd ssh || log "ssh client is missing; SSH/SFTP features may be unavailable."
  if ! has_cmd ping; then
    log "ping is missing; device monitor ping checks may be unavailable."
  fi
  log "Environment OK: node $(node -v), npm $(npm -v), python $(python3 --version 2>&1)"
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

configure_firewall() {
  if ! has_cmd firewall-cmd; then
    return 0
  fi
  if ! firewall-cmd --state >/dev/null 2>&1; then
    return 0
  fi
  if firewall-cmd --query-port="${PORT}/tcp" >/dev/null 2>&1; then
    log "Firewall already allows ${PORT}/tcp."
    return 0
  fi

  log "Opening firewalld port ${PORT}/tcp."
  if run_root firewall-cmd --add-port="${PORT}/tcp" --permanent; then
    run_root firewall-cmd --reload || log "firewalld reload failed; run manually: firewall-cmd --reload"
  else
    log "Could not update firewalld; open ${PORT}/tcp manually if the web UI is unreachable."
  fi
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  python3 - "$file" "$key" "$value" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
updated = False
prefix = f"{key}="
for index, line in enumerate(lines):
    if line.startswith(prefix) or line.startswith(f"# {prefix}") or line.startswith(f"#{prefix}"):
        lines[index] = f"{key}={value}"
        updated = True
        break
if not updated:
    lines.append(f"{key}={value}")
path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
PY
}

write_empty_assets() {
  mkdir -p server/data/assets/templates
  cat > server/data/assets/device.remote.json <<'JSON'
{
  "code": 0,
  "data": [],
  "msg": ""
}
JSON
  cat > server/data/assets/devices.local.json <<'JSON'
{
  "devices": []
}
JSON
  cat > server/data/assets/device.meta.json <<'JSON'
{
  "items": []
}
JSON
  cat > server/data/assets/device.status.json <<'JSON'
{
  "items": []
}
JSON
  cat > server/data/assets/device.merged.json <<'JSON'
{
  "generatedAt": null,
  "total": 0,
  "items": []
}
JSON
  cp server/data/assets/device.remote.json server/data/assets/templates/device.remote.json
  cp server/data/assets/devices.local.json server/data/assets/templates/devices.local.json
  cp server/data/assets/device.meta.json server/data/assets/templates/device.meta.json
  cp server/data/assets/device.status.json server/data/assets/templates/device.status.json
  cp server/data/assets/device.merged.json server/data/assets/templates/device.merged.json
}

ensure_data_layout() {
  mkdir -p server/data/assets server/data/mcp server/data/opsdog server/data/reports server/data/servers server/data/ticketing logs
  if [[ "$RESET_ASSETS" -eq 1 || ! -f server/data/assets/device.remote.json || ! -f server/data/assets/devices.local.json ]]; then
    write_empty_assets
  fi
}

write_env_file() {
  if [[ ! -f .env ]]; then
    if [[ -f .env.example ]]; then
      cp .env.example .env
    else
      touch .env
    fi
  fi
  set_env_value .env OPSDOG_SERVER_ORIGIN "http://${HOST}:${PORT}"
  set_env_value .env OPSDOG_WEB_ORIGIN "http://${HOST}:${PORT}"
  set_env_value .env VITE_API_BASE_URL "/api"
  set_env_value .env ASSET_API_MODE "local"
}

install_node_dependencies() {
  if [[ -d node_modules ]]; then
    log "node_modules already exists; running npm install --omit=dev to reconcile runtime dependencies."
  fi

  if [[ -f dist/index.html ]]; then
    if [[ -f package-lock.json ]]; then
      npm ci --omit=dev
    else
      npm install --omit=dev
    fi
  else
    log "dist/ is missing; installing dev dependencies and building frontend."
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
    npm run build
    npm prune --omit=dev
  fi
}

write_runtime_scripts() {
  cat > start-linux.sh <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"
mkdir -p logs
if [[ -f opsdog.pid ]] && kill -0 "$(cat opsdog.pid)" >/dev/null 2>&1; then
  echo "OpsDog is already running: PID $(cat opsdog.pid)"
  exit 0
fi
nohup node server/src/index.js > logs/opsdog.log 2>&1 &
echo $! > opsdog.pid
echo "OpsDog started: PID $(cat opsdog.pid)"
echo "Log: $APP_DIR/logs/opsdog.log"
EOF

  cat > stop-linux.sh <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"
if [[ ! -f opsdog.pid ]]; then
  echo "OpsDog PID file not found."
  exit 0
fi
PID="$(cat opsdog.pid)"
if kill -0 "$PID" >/dev/null 2>&1; then
  kill "$PID"
  echo "OpsDog stopped: PID $PID"
else
  echo "OpsDog process is not running: PID $PID"
fi
rm -f opsdog.pid
EOF

  cat > status-linux.sh <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "\$APP_DIR"
if [[ -f opsdog.pid ]] && kill -0 "\$(cat opsdog.pid)" >/dev/null 2>&1; then
  echo "OpsDog running: PID \$(cat opsdog.pid)"
else
  echo "OpsDog not running"
fi
if command -v curl >/dev/null 2>&1; then
  curl -fsS "http://127.0.0.1:${PORT}/api/health" || true
  echo
fi
EOF

  chmod +x start-linux.sh stop-linux.sh status-linux.sh
}

start_app() {
  ./start-linux.sh
  sleep 2
  if has_cmd curl; then
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
      log "Health check OK: http://127.0.0.1:${PORT}/"
    else
      log "Health check did not pass yet. Check logs/opsdog.log."
    fi
  fi
}

log "Package root: $APP_DIR"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  check_runtime
  exit 0
fi

install_os_packages
install_node
check_runtime
write_env_file
ensure_data_layout
install_node_dependencies
write_runtime_scripts
configure_firewall

if [[ "$START_AFTER_INSTALL" -eq 1 ]]; then
  start_app
else
  log "Install complete. Start later with ./start-linux.sh"
fi

log "Open: http://$(display_host):${PORT}/"
