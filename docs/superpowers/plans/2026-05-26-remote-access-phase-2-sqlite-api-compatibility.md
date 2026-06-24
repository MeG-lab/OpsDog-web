# Remote Access Phase 2: SQLite Asset API Compatibility Implementation Plan

> **Execution rule:** Execute this plan task by task with tests written before production changes. Windows verification remains a release gate, not a blocker for local development.

**Goal:** Switch the current local/merged asset and monitor HTTP behavior from JSON persistence to the Phase 1 SQLite database while preserving frontend response contracts and retaining a JSON fallback when database activation fails.

**Architecture:** Add a SQLite asset/monitor store that owns local CRUD, merged reads, monitor status reads/writes, and monitor target selection. Keep the existing JSON stores as a startup fallback. Refactor the watcher to use an injected store contract, then make `server/src/index.js` choose SQLite after successful initialization and otherwise continue with the legacy JSON path. The running service now depends on the `node:sqlite` adapter, so Node.js 24 LTS becomes the declared backend runtime.

**Tech Stack:** Node.js 24 LTS ESM, built-in `node:sqlite`, built-in `node:test`, existing HTTP server and Vite packaging workflow.

**Development Gate:** `GO-DEV` remains satisfied by the completed local Node 24 SQLite verification and SSH/SFTP target validation evidence.

**Release Gate:** `NO-GO-RELEASE-WINDOWS` remains active until the Windows Node 24, SQLite/filesystem, Credential Manager, packaging/launcher, SSH/SFTP, and host-key validation matrix passes.

---

## Compatibility Contract

The SQLite path must preserve these existing endpoint behaviors:

| Endpoint | Required SQLite behavior |
| --- | --- |
| `GET /api/assets/devices` in `local` or `merged` mode | Return `{ code, msg, data, items }`; `items` keeps the current `AssetDevice` field mapping. |
| `GET /api/assets/merged` | Return `{ generatedAt, total, filteredTotal, items }` with current merged asset fields, monitor metadata, and current monitor status. |
| `POST /api/assets/rebuild` | Return the same merged response shape; SQLite treats it as a fresh materialized read rather than writing JSON. |
| `POST/PATCH/DELETE /api/assets/devices/:id` | Persist local devices and default monitor configuration in SQLite; reject `remote:` edits as before. |
| `GET /api/monitor/status` | Return the current monitor status rows in the existing JSON-compatible shape and support `status`/`source` filters. |
| Watcher cycle | Read targets and prior state through the selected store, then write updated status through that store. |

The legacy JSON modules remain available only for startup fallback in this phase. A failed SQLite migration/import/activation must log the failure and retain the prior JSON-backed API and watcher behavior.

## Task 1: Declare Runtime and Persistence Boundaries

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `scripts/package-test-bundle.mjs`
- Modify: `README.md` only if it advertises a backend Node runtime
- Test: package script and runtime smoke checks later in this plan

- [x] **Step 1: Write the expected runtime/package assertions**

Before changing runtime declarations, add assertions in the relevant test or smoke-test command that a generated test package declares Node.js 24 LTS and excludes runtime SQLite data under `server/data/opsdog/`.

- [x] **Step 2: Run RED verification**

Run the new assertion against the current bundle generation or package source. It must fail because the generated bundle still advertises Node.js 18+.

- [x] **Step 3: Implement runtime boundaries**

1. Add `server/data/opsdog/` to `.gitignore`.
2. Set `package.json.engines.node` to `>=24.0.0`.
3. Change the generated bundle instructions to require Node.js 24 LTS.
4. Preserve the package sanitizer behavior that rebuilds `server/data/` only from intended baseline data; the generated bundle must not contain a developer database or backup directory.

- [x] **Step 4: Run GREEN verification and commit**

Run the focused package assertion and commit the runtime declaration changes.

## Task 2: Add SQLite Asset/Monitor Store Contract

**Files:**
- Create: `server/src/database/assetMonitorStore.js`
- Create: `server/test/database/assetMonitorStore.test.js`
- Modify: `package.json` only if the database test glob must include a new location

- [x] **Step 1: Write failing merged-read and CRUD tests**

Use a temporary migrated/imported SQLite database with deterministic clock and ID providers. Tests must assert:

1. Imported local and remote devices are returned in the existing merged response shape.
2. Monitor metadata/status join onto merged rows and status overrides asset status only when it is not `unknown`.
3. Filters for `name`, `ipAddr`, `assetType`, and `source` retain current behavior.
4. Creating a local device returns an `id` prefixed with `local:`, creates its default monitor profile/status, and appears in merged reads.
5. Updating a local device retains its monitor settings where legacy code retained them and refreshes default target/port from the changed device.
6. Deleting a local device removes its monitor profile/status by foreign-key cascade.
7. Editing or deleting a `remote:` device is rejected with the existing read-only error.

- [x] **Step 2: Run RED verification**

Run:

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/assetMonitorStore.test.js
```

Expected: FAIL because `assetMonitorStore.js` does not exist.

- [x] **Step 3: Implement the store**

Create `createSqliteAssetMonitorStore(database, { now, createId } = {})` with these application-facing methods:

```js
listMergedDevices(query)
rebuildMergedDevices()
readDeviceStatus()
listMonitorTargets()
writeDeviceStatus(items)
syncLocalDevicesMonitorDefaults()
createLocalManagedAssetDevice(payload)
updateLocalManagedAssetDevice(deviceId, payload)
deleteLocalManagedAssetDevice(deviceId)
```

Implementation requirements:

1. All writes are parameter-bound SQL and local CRUD plus default monitoring changes are transactional.
2. `devices.id` remains the merged key (`local:<externalId>` or `remote:<externalId>`); API CRUD returns the current local `AssetDevice` shape.
3. Merged reads join `asset_sources`, `devices`, `device_tags`, `monitor_profiles`, and `monitor_current_status`, and map remote `source_payload_json` fields needed by the legacy merged response.
4. New local monitoring defaults match the existing JSON behavior: storage uses `ping`, security uses `tcp:443`, other device types use `ping+tcp:22`; the initial message is `等待首次检测`.
5. Status writes update `monitor_current_status` only for an existing matching profile and do not write JSON files.

- [x] **Step 4: Run GREEN verification and commit**

Run:

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/*.test.js
```

Commit the tested SQLite store and tests.

## Task 3: Make the Device Watcher Store-Driven

**Files:**
- Modify: `server/src/deviceWatcher.js`
- Create: `server/test/database/deviceWatcher.test.js`

- [x] **Step 1: Write failing watcher tests**

Create a fake store and injected target checker. Assert one cycle:

1. Reads targets and previous status through the store contract.
2. Writes a healthy status and resets failure count after a successful check.
3. Writes an attention/critical progression according to `failThreshold` after failed checks.
4. Does not require filesystem JSON reads or real network/ping execution under test.

- [x] **Step 2: Run RED verification**

Run:

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/deviceWatcher.test.js
```

Expected: FAIL because the watcher does not expose a store-driven cycle.

- [x] **Step 3: Refactor without changing default legacy behavior**

Export a testable cycle function and a configuration function for the active store. When no SQLite store is configured, adapt the existing JSON files and `rebuildMergedDevices()` behind the same contract. Keep the existing timer behavior and ping/TCP implementations for production checks.

- [x] **Step 4: Run GREEN verification and commit**

Run all database/watcher tests under Node 24, then commit the watcher refactor.

## Task 4: Activate SQLite in the HTTP Server with JSON Fallback

**Files:**
- Modify: `server/src/index.js`
- Create: `server/test/database/assetApi.integration.test.js`

- [x] **Step 1: Write failing HTTP integration tests**

Start the server subprocess under Node.js 24 with:

```text
OPSDOG_SERVER_ORIGIN=http://127.0.0.1:<test-port>
ASSET_API_MODE=local
OPSDOG_DATABASE_PATH=<temporary database file>
OPSDOG_ASSETS_DIR=<temporary JSON fixture directory>
```

Assert SQLite-backed create/list/status/update/delete response compatibility and that the temporary database receives the changes while source JSON files remain unchanged.

- [x] **Step 2: Run RED verification**

Run:

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/assetApi.integration.test.js
```

Expected: FAIL because the server has not activated the SQLite store or accepted isolated persistence paths.

- [x] **Step 3: Implement activation and fallback**

1. Initialize `initializeFoundationDatabase()` before accepting HTTP requests, using `OPSDOG_DATABASE_PATH` and `OPSDOG_ASSETS_DIR` when present and current application defaults otherwise.
2. On success, build `createSqliteAssetMonitorStore()` and route asset/monitor calls plus watcher setup through it.
3. On database initialization failure, log a clear warning and configure the existing JSON asset/monitor stores and watcher path.
4. Keep the remote upstream asset API mode unchanged; only the existing `local`/`merged` behavior and local CRUD use SQLite.
5. Close the active database during process termination if shutdown handling exists; otherwise keep lifecycle ownership explicit for a later shutdown task.

- [x] **Step 4: Run GREEN verification and commit**

Run the integration test and all database tests under Node 24, then commit server activation.

## Task 5: Verify Packaging, Record Evidence, and Preserve Windows Gate

**Files:**
- Modify: `docs/superpowers/research/2026-05-26-remote-access-p0-results.md`
- Modify: this plan checklist as tasks complete

- [x] **Step 1: Run supported-runtime tests**

Run:

```bash
npx --yes node@24 --version
npx --yes node@24 --test --test-concurrency=1 server/test/database/*.test.js
npm run package:test
```

Expected: Node reports v24.x, all SQLite/API/watcher tests pass, and packaging succeeds.

- [x] **Step 2: Inspect the generated package**

Verify that its instructions say Node.js 24 LTS and that it contains no `server/data/opsdog/` database, WAL/SHM file, or import backup directory.

- [x] **Step 3: Update validation evidence**

Record P2 test commands, results, response compatibility coverage, declared Node 24 runtime, and the fact that `NO-GO-RELEASE-WINDOWS` is still active. Do not record test target addresses or credentials.

- [x] **Step 4: Commit documentation and report next work**

Commit the checked-off plan and evidence update. Report that Windows validation is still required before any Windows-ready or release-ready statement, and propose P3 credential/profile work only after the P2 evidence is clean.
