# OpsDog Web

一个面向运维场景的智能工作台，支持对话式任务编排、技能管理、工具集成与托管任务控制。

This repository is a Web-first React + TypeScript application.

## Primary development path

```bash
npm install
npm run dev:server
npm run dev
```

`dev:server` 当前直接用 `node server/src/index.js` 启动，避免部分机器上 `node --watch` 的文件监听数限制。

Or start both together:

```bash
npm run dev:all
```

Default local address:

- `http://127.0.0.1:4173/`
- Backend API: `http://127.0.0.1:8787/`

## Unified local address config

Copy `.env.example` to `.env`, then adjust these values in one place:

```bash
OPSDOG_WEB_ORIGIN=http://127.0.0.1:4173
OPSDOG_SERVER_ORIGIN=http://127.0.0.1:8787
VITE_API_BASE_URL=/api
```

- `vite.config.ts` uses them for the dev server and proxy target
- `server/src/index.js` uses them for backend listen host/port
- `src/services/runtime/webRuntime.ts` uses `VITE_API_BASE_URL`

## Build

```bash
npm run build
```

## Frontend / backend split

- `src/` is the React frontend.
- `server/` is the Node backend bridge.
- Chat and model-list requests now go through the local backend instead of calling providers directly from the browser.
- MCP now supports `streamable-http` and `stdio` through the local backend.
- Managed tasks and instant skill execution now have a first backend runner and continue to evolve in `server/`.
