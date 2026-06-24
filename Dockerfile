FROM node:22-slim AS builder
WORKDIR /app

# 安装 Python3（构建时可能不需要，但先保留）
RUN apt-get update && apt-get install -y python3 python3-pip --no-install-recommends && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# --- Runtime ---
FROM node:22-slim
WORKDIR /app

RUN apt-get update && \
    apt-get install -y python3 python3-pip openssh-client git curl iputils-ping --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# 复制构建产物和运行时依赖
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/tools ./tools
COPY --from=builder /app/package.json ./
COPY --from=builder /app/appConfig.js ./appConfig.js
COPY --from=builder /app/appConfig.d.ts ./appConfig.d.ts

# 数据目录挂载点
RUN mkdir -p /app/server/data

ENV OPSDOG_SERVER_ORIGIN=http://0.0.0.0:8788
ENV OPSDOG_WEB_ORIGIN=http://0.0.0.0:8788
ENV NODE_ENV=production

EXPOSE 8788

CMD ["node", "server/src/index.js"]
