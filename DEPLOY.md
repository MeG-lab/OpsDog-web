# Deployment Guide

## 1. Requirements

- Node.js 18+
- npm 9+

## 2. Start

Run in the project root:

```bash
npm install

# macOS / Linux
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env

npm run dev:all
```

Default addresses:

- Web: `http://127.0.0.1:4175`
- API: `http://127.0.0.1:8788`

## 3. Build

```bash
npm run build
npm run start:server
```

## 4. Minimum `.env` settings

```bash
OPSDOG_WEB_ORIGIN=http://127.0.0.1:4175
OPSDOG_SERVER_ORIGIN=http://127.0.0.1:8788
VITE_API_BASE_URL=/api
VITE_OPSDOG_FILESYSTEM_ROOT=.
```

Notes:

- `VITE_OPSDOG_FILESYSTEM_ROOT=.` means the filesystem MCP uses the project root.
- Do not replace it with a developer machine absolute path.

If ticketing is needed, also set:

```bash
TICKETING_CREATE_URL=
TICKETING_API_KEY=
```

If remote assets are needed, also set:

```bash
ASSET_API_MODE=remote
ASSET_API_BASE_URL=
ASSET_API_LIST_PATH=
ASSET_API_TOKEN=
```

## 5. Troubleshooting

Port already in use:

```bash
lsof -i:4173
lsof -i:8787
```

Frontend cannot reach backend:

- Confirm backend is running
- Confirm `OPSDOG_SERVER_ORIGIN` is correct

System server path errors:

- Delete `server/data/servers/*.server.json`
- Restart backend
- The system will regenerate them for the current machine
