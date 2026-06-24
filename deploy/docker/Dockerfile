FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV OPSDOG_SERVER_ORIGIN=http://0.0.0.0:8788
ENV OPSDOG_WEB_ORIGIN=http://0.0.0.0:8788
ENV VITE_API_BASE_URL=/api
ENV ASSET_API_MODE=local

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      iputils-ping \
      openssh-client \
      python3 \
      python3-pip && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY appConfig.js appConfig.d.ts ./
COPY .env.example README.md ./
COPY dist ./dist
COPY server ./server
COPY tools ./tools

RUN mkdir -p /app/server/data /app/logs

EXPOSE 8788

CMD ["node", "server/src/index.js"]
