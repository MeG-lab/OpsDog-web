#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
export LANG=C

APP_NAME="OpsDog"
INSTALL_DIR="${OPSDOG_INSTALL_DIR:-/opt/opsdog}"
FORCE=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Usage: ./uninstall-linux.sh [options]

Options:
  --dir <path>    Install directory to remove, default /opt/opsdog.
  -f, --force     Force kill all processes without confirmation.
  -y, --yes       Non-interactive mode, skip confirmation.
  -h, --help      Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      INSTALL_DIR="${2:-}"
      shift
      ;;
    -f|--force) FORCE=1 ;;
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
  printf '[%s uninstall] %s\n' "$APP_NAME" "$*"
}

fail() {
  printf '[%s uninstall] ERROR: %s\n' "$APP_NAME" "$*" >&2
  exit 1
}

confirm() {
  if [[ "$ASSUME_YES" -eq 1 || "$FORCE" -eq 1 ]]; then
    return 0
  fi
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]]
}

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "This uninstaller only supports Linux."
fi

SUDO=()
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO=(sudo)
  else
    fail "Root privileges are required. Run as root or install sudo."
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

log "开始卸载 ${APP_NAME}..."

# ── 1. 停止所有 opsdog 进程 ──
log "正在停止 ${APP_NAME} 进程..."

# 先尝试优雅停止
if [[ -f "$INSTALL_DIR/stop-linux.sh" && -x "$INSTALL_DIR/stop-linux.sh" ]]; then
  run_root bash "$INSTALL_DIR/stop-linux.sh" 2>/dev/null || true
  sleep 1
fi

# 强制杀掉所有相关进程
OPSDOG_PIDS=$(ps aux | grep -iE "opsdog|$INSTALL_DIR" | grep -v grep | grep -v uninstall | awk '{print $2}' || true)
if [[ -n "$OPSDOG_PIDS" ]]; then
  log "发现残留进程: $OPSDOG_PIDS"
  echo "$OPSDOG_PIDS" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# 杀掉占用 8788 端口的进程
PORT_PID=$(ss -tlnp 2>/dev/null | awk '/:8788 /{print $NF}' | grep -oP 'pid=\K[0-9]+' || true)
if [[ -z "$PORT_PID" ]]; then
  PORT_PID=$(netstat -tlnp 2>/dev/null | awk '/:8788 /{print $NF}' | grep -oP '[0-9]+(?=/)' || true)
fi
if [[ -n "$PORT_PID" ]]; then
  log "发现占用 8788 端口的进程: $PORT_PID"
  kill -9 "$PORT_PID" 2>/dev/null || true
  sleep 1
fi

# 再次确认
REMAINING=$(ps aux | grep -iE "opsdog|$INSTALL_DIR" | grep -v grep | grep -v uninstall | wc -l)
if [[ "$REMAINING" -gt 0 ]]; then
  log "仍有残留进程，强制清理..."
  pkill -9 -f opsdog 2>/dev/null || true
  pkill -9 -f "$INSTALL_DIR" 2>/dev/null || true
fi

log "${APP_NAME} 进程已停止"

# ── 2. 删除安装目录 ──
if [[ -d "$INSTALL_DIR" ]]; then
  log "删除安装目录: $INSTALL_DIR"
  run_root rm -rf "$INSTALL_DIR"
fi

# ── 3. 删除备份目录 ──
for backup in /opt/opsdog.previous-*; do
  if [[ -d "$backup" ]]; then
    log "删除备份目录: $backup"
    run_root rm -rf "$backup"
  fi
done

# ── 4. 删除 opsdog nodejs ──
for nodejs_dir in /opt/nodejs-*-glibc-* /opt/nodejs-*-node-v*-linux-x64 /opt/nodejs-*-node-v*-linux-arm64; do
  if [[ -d "$nodejs_dir" ]]; then
    log "删除 Node.js: $nodejs_dir"
    run_root rm -rf "$nodejs_dir"
  fi
done

# 删除 /opt/nodejs 软链
if [[ -L /opt/nodejs ]]; then
  log "删除 /opt/nodejs 软链"
  run_root rm -f /opt/nodejs
fi

# ── 5. 清理全局 node 软链 ──
for symlink in /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx; do
  if [[ -L "$symlink" ]]; then
    target=$(readlink "$symlink" 2>/dev/null || true)
    if [[ "$target" == /opt/nodejs/* ]]; then
      log "删除 $symlink -> $target"
      run_root rm -f "$symlink"
    fi
  fi
done

# ── 6. 删除 profile.d 配置 ──
if [[ -f /etc/profile.d/opsdog-node.sh ]]; then
  log "删除 /etc/profile.d/opsdog-node.sh"
  run_root rm -f /etc/profile.d/opsdog-node.sh
fi

# ── 7. 清理 npm 缓存 ──
if [[ -d /root/.npm/_npx ]]; then
  log "清理 npm npx 缓存"
  run_root rm -rf /root/.npm/_npx
fi

# ── 8. 清理临时文件 ──
for tmp in /tmp/opsdog-* /tmp/tmp.*OpsDog*; do
  if [[ -e "$tmp" ]]; then
    log "清理临时文件: $tmp"
    run_root rm -rf "$tmp"
  fi
done

# ── 验证 ──
echo ""
log "========================================="
log "卸载完成，验证结果:"

if [[ -d "$INSTALL_DIR" ]]; then
  log "⚠  $INSTALL_DIR 仍然存在"
else
  log "✓ $INSTALL_DIR 已删除"
fi

if ss -tlnp 2>/dev/null | grep -q ':8788 '; then
  log "⚠  端口 8788 仍被占用"
else
  log "✓ 端口 8788 已释放"
fi

REMAINING_PROCS=$(ps aux | grep -iE "opsdog" | grep -v grep | grep -v uninstall | wc -l || echo 0)
if [[ "$REMAINING_PROCS" -gt 0 ]]; then
  log "⚠  仍有 $REMAINING_PROCS 个 opsdog 进程"
else
  log "✓ 无 opsdog 残留进程"
fi

log "========================================="
