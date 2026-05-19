# Deployment Guide

## 1. Supported Environment

Recommended:

- Windows 10/11, macOS 13+, or mainstream Linux
- Node.js 18+ LTS
- npm 9+
- Python 3.9+ if managed Python scripts are used
- Network access during `npm install`

System commands used by optional features:

- `ping`: device availability checks
- `curl`: fallback for some HTTP requests
- `npx`: built-in filesystem MCP server
- `lsof`: macOS/Linux troubleshooting only

Windows notes:

- Run commands in PowerShell.
- `npm run dev:all` uses `npm.cmd` automatically on Windows.
- If Python is installed as `py` instead of `python3`, adjust script runtime in the UI or install Python with `python3` on PATH.

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

## 3. Production-style Start

```bash
npm run build
npm run start:server
```

The web build is written to `dist/`. The local backend still needs to run with `npm run start:server`.

## 4. Minimum `.env` Settings

```bash
OPSDOG_WEB_ORIGIN=http://127.0.0.1:4175
OPSDOG_SERVER_ORIGIN=http://127.0.0.1:8788
VITE_API_BASE_URL=/api
VITE_OPSDOG_FILESYSTEM_ROOT=.
```

Notes:

- `VITE_OPSDOG_FILESYSTEM_ROOT=.` means the filesystem MCP uses the project root.
- Do not replace it with a developer machine absolute path.
- Keep `VITE_API_BASE_URL=/api` for local testing.

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

## 5. Runtime Data

The package includes a clean runtime baseline:

- `server/data/assets/`: device asset and status files
- `server/data/mcp/`: MCP records
- `server/data/ticketing/asset-mappings.json`: asset mapping baseline

The package intentionally does not include:

- `.env`
- `node_modules/`
- `server/data/servers/*.server.json`
- historical reports
- ticket creation history

`server/data/servers/*.server.json` is machine-specific and is regenerated on first backend start.

## 6. Troubleshooting

Port already in use:

```bash
# macOS / Linux
lsof -i:4175
lsof -i:8788

# Windows PowerShell
Get-NetTCPConnection -LocalPort 4175
Get-NetTCPConnection -LocalPort 8788
```

Frontend cannot reach backend:

- Confirm backend is running
- Confirm `OPSDOG_SERVER_ORIGIN` is correct

System server path errors:

- Delete `server/data/servers/*.server.json`
- Restart backend
- The system will regenerate them for the current machine

Python scripts fail to start:

- Confirm Python 3 is installed
- Confirm `python3 --version` works, or change script runtime in the UI

Device status does not update:

- Confirm backend is running
- Confirm target device IP and port are reachable from the test machine
- Confirm the OS allows `ping`
