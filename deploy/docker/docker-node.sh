#!/usr/bin/env bash
# ============================================================
# Docker Node 运行时包装脚本
# 无需在宿主机安装 Node，通过 Docker 运行所有 Node 命令
# 专治 CentOS 7 无法安装 Node 18+ 的问题
#
# 用法:
#   ./docker-node.sh npm install          # 安装依赖
#   ./docker-node.sh npm run build        # 构建前端
#   ./docker-node.sh node server/src/index.js  # 启动服务
#   ./docker-node.sh bash                 # 进入容器 shell
# ============================================================
set -Eeuo pipefail

APP_NAME="OpsDog"
APP_DIR="${OPSDOG_APP_DIR:-$(pwd)}"
IMAGE="${OPSDOG_NODE_IMAGE:-node:22-bookworm-slim}"
CONTAINER_PREFIX="opsdog-node-run"

log() {
  printf '[%s docker-node] %s\n' "$APP_NAME" "$*"
}

fail() {
  printf '[%s docker-node] ERROR: %s\n' "$APP_NAME" "$*" >&2
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
    fail "需要 root 权限，请用 root 运行或安装 sudo。"
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

install_docker() {
  if has_cmd docker && docker info >/dev/null 2>&1; then
    log "Docker 已安装并运行。"
    return 0
  fi

  local manager
  manager="$(detect_pkg_manager)"
  log "安装 Docker..."

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
    *)
      curl -fsSL https://get.docker.com | run_root sh
      ;;
  esac

  # 启动 Docker
  if has_cmd systemctl; then
    run_root systemctl enable --now docker
  elif has_cmd service; then
    run_root service docker start
  fi

  # 验证
  docker info >/dev/null 2>&1 || fail "Docker 已安装但未能启动，请检查。"
  log "Docker 安装完成。"
}

pull_image() {
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "拉取镜像: $IMAGE"
    docker pull "$IMAGE"
  fi
}

run_in_docker() {
  local container_name="${CONTAINER_PREFIX}-$$-$(date +%s)"

  docker run --rm \
    --name "$container_name" \
    -v "$APP_DIR:/app" \
    -w /app \
    -p "${OPSDOG_PORT:-8788}:8788" \
    -e NODE_ENV="${NODE_ENV:-development}" \
    -e OPSDOG_SERVER_ORIGIN="${OPSDOG_SERVER_ORIGIN:-http://0.0.0.0:8788}" \
    -e OPSDOG_WEB_ORIGIN="${OPSDOG_WEB_ORIGIN:-http://0.0.0.0:8788}" \
    -e VITE_API_BASE_URL="${VITE_API_BASE_URL:-/api}" \
    -e ASSET_API_MODE="${ASSET_API_MODE:-local}" \
    "$IMAGE" \
    "$@"
}

usage() {
  cat <<'EOF'
用法: docker-node.sh <命令> [参数...]

通过 Docker 容器执行 Node.js 命令，无需在宿主机安装 Node。

示例:
  ./docker-node.sh node --version           # 查看 Node 版本
  ./docker-node.sh npm install              # 安装依赖
  ./docker-node.sh npm run build            # 构建前端
  ./docker-node.sh npm ci --omit=dev        # 生产环境安装
  ./docker-node.sh node server/src/index.js # 启动服务（后台加 &）
  ./docker-node.sh bash                     # 进入容器调试

环境变量:
  OPSDOG_APP_DIR    项目根目录 (默认当前目录)
  OPSDOG_NODE_IMAGE Node 镜像 (默认 node:22-bookworm-slim)
  OPSDOG_PORT       服务端口 (默认 8788)
EOF
}

main() {
  if [[ $# -eq 0 || "$1" == "-h" || "$1" == "--help" ]]; then
    usage
    exit 0
  fi

  install_docker
  pull_image

  if [[ ! -f "$APP_DIR/package.json" ]]; then
    fail "在 $APP_DIR 下找不到 package.json，请设置 OPSDOG_APP_DIR 环境变量指向项目根目录。"
  fi

  run_in_docker "$@"
}

main "$@"
