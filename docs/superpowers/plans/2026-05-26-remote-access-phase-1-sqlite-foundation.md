# Remote Access Phase 1 SQLite Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested SQLite database foundation that can safely import the current asset and monitoring JSON state while preserving the Windows release-validation blocker.

**Architecture:** Phase 1 adds a synchronous SQLite adapter around `node:sqlite`, a two-version migration runner for the complete remote-access schema, focused foundation repositories, and an initial JSON importer with backup and issue isolation. It does not switch existing HTTP APIs or `deviceWatcher` away from JSON yet; that compatibility cutover belongs to Phase 2 after the database/import boundary is verified.

**Tech Stack:** Node.js ESM targeting Node.js 24 LTS, built-in `node:sqlite`, Node test runner, existing JSON asset files, SQLite WAL and foreign-key enforcement.

---

## Approved Boundaries

- `GO-DEV` is recorded in `docs/superpowers/research/2026-05-26-remote-access-p0-results.md`; cross-platform implementation may proceed.
- `NO-GO-RELEASE-WINDOWS` remains active. Phase 1 must not state that Windows support has passed, package remote dependencies into a Windows release, or remove the Windows validation matrix.
- The development binding is `node:sqlite` behind `sqliteAdapter.js`. No caller outside `server/src/database/` directly imports `node:sqlite`.
- The current JSON stores remain the running application's source of truth in this plan. Phase 1 creates/imports the database only through explicit initialization calls and tests.
- Secrets are out of scope for import. Schema may contain credential reference metadata, but tests and importer must never write a password, private key, or passphrase.
- The observed orphan `device.meta.json` entries with no device row are recorded in `data_import_issues`; they must not abort the import transaction.

## Planned File Boundary

| Path | Responsibility |
| --- | --- |
| `package.json` | Add an explicit database-test command only; do not yet change shipped runtime claims |
| `server/src/database/sqliteAdapter.js` | Own the only `node:sqlite` import; enforce WAL, foreign keys, busy timeout, transactions and close |
| `server/src/database/migrations.js` | Load ordered SQL resources, apply each version once and expose applied versions |
| `server/src/database/sql/001-core-assets-monitor.sql` | Import tracking, asset, tag and monitor tables/indexes |
| `server/src/database/sql/002-remote-access-audit.sql` | Credential references, profiles, host keys, sessions, SFTP and audit tables/indexes |
| `server/src/database/foundationRepositories.js` | Parameterized SQL for import runs, issues, sources, devices, tags and monitor snapshots |
| `server/src/database/jsonAssetImporter.js` | Backup source JSON and perform one-time transactional import with orphan isolation |
| `server/src/database/index.js` | Small public factory for opening/migrating a Phase 1 database and optionally importing JSON |
| `server/test/database/sqliteAdapter.test.js` | Adapter/WAL/foreign-key/transaction tests |
| `server/test/database/migrations.test.js` | Schema completeness, constraints and migration idempotency tests |
| `server/test/database/jsonAssetImporter.test.js` | Backup, mapped import, orphan issue, idempotency and rollback tests |

## Task 1: Establish Database Tests And SQLite Adapter

**Files:**
- Modify: `package.json`
- Create: `server/test/database/sqliteAdapter.test.js`
- Create: `server/src/database/sqliteAdapter.js`

- [x] **Step 1: Add a database test command**

Add the following script without changing existing build or packaging scripts:

```json
"test:database": "node --test --test-concurrency=1 server/test/database/*.test.js"
```

- [x] **Step 2: Write the failing adapter tests**

Create tests using a fresh `mkdtempSync()` directory and import the desired API before it exists:

```js
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';

test('adapter creates a WAL database with foreign keys enabled', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-db-adapter-'));
  const db = openSqliteAdapter({ databasePath: path.join(root, 'opsdog.db') });
  try {
    assert.equal(String(db.get('PRAGMA journal_mode').journal_mode).toLowerCase(), 'wal');
    assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1);
    db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (parent_id TEXT REFERENCES parent(id));');
    assert.throws(() => db.run("INSERT INTO child (parent_id) VALUES ('missing')"), /FOREIGN KEY/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('adapter transaction rolls back failed work', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-db-transaction-'));
  const db = openSqliteAdapter({ databasePath: path.join(root, 'opsdog.db') });
  try {
    db.exec('CREATE TABLE values_table (value TEXT NOT NULL);');
    assert.throws(() => db.transaction(() => {
      db.run('INSERT INTO values_table (value) VALUES (?)', 'discard-me');
      throw new Error('rollback requested');
    }), /rollback requested/);
    assert.deepEqual(db.all('SELECT value FROM values_table'), []);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [x] **Step 3: Run the test to verify RED**

Run:

```bash
npm run test:database
```

Expected: FAIL because `server/src/database/sqliteAdapter.js` cannot be imported.

- [x] **Step 4: Implement the minimal adapter**

Create `sqliteAdapter.js` with a single binding boundary:

```js
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DATABASE_PATH = path.resolve(process.cwd(), 'server/data/opsdog/opsdog.db');

export const openSqliteAdapter = ({ databasePath = DEFAULT_DATABASE_PATH } = {}) => {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const nativeDatabase = new DatabaseSync(databasePath);
  nativeDatabase.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return {
    databasePath,
    exec: (sql) => nativeDatabase.exec(sql),
    run: (sql, ...values) => nativeDatabase.prepare(sql).run(...values),
    get: (sql, ...values) => nativeDatabase.prepare(sql).get(...values),
    all: (sql, ...values) => nativeDatabase.prepare(sql).all(...values),
    transaction: (work) => {
      nativeDatabase.exec('BEGIN IMMEDIATE;');
      try {
        const result = work();
        nativeDatabase.exec('COMMIT;');
        return result;
      } catch (error) {
        nativeDatabase.exec('ROLLBACK;');
        throw error;
      }
    },
    close: () => nativeDatabase.close(),
  };
};
```

- [x] **Step 5: Run GREEN verification and commit**

Run:

```bash
npm run test:database
git add package.json server/src/database/sqliteAdapter.js server/test/database/sqliteAdapter.test.js
git commit -m "feat: add sqlite database adapter"
```

Expected: two adapter tests pass. On the current local Node `v23.11.0`, the known `node:sqlite` experimental warning may appear; release testing targets Node.js 24 LTS.

## Task 2: Add Complete Ordered Schema Migrations

**Files:**
- Create: `server/test/database/migrations.test.js`
- Create: `server/src/database/migrations.js`
- Create: `server/src/database/sql/001-core-assets-monitor.sql`
- Create: `server/src/database/sql/002-remote-access-audit.sql`

- [x] **Step 1: Write failing migration tests**

The test must open a temporary adapter, call `applyMigrations(db)`, and assert:

```js
assert.deepEqual(
  db.all('SELECT version, name FROM schema_migrations ORDER BY version'),
  [
    { version: 1, name: 'core-assets-monitor' },
    { version: 2, name: 'remote-access-audit' },
  ],
);
assert.deepEqual(
  db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name),
  [
    'app_settings', 'asset_sources', 'audit_events', 'connection_profiles',
    'credential_refs', 'data_import_issues', 'data_import_runs', 'device_tags',
    'devices', 'monitor_current_status', 'monitor_profiles', 'monitor_results',
    'remote_sessions', 'schema_migrations', 'sftp_operations', 'sftp_transfers',
    'ssh_host_keys', 'terminal_transcript_chunks',
  ],
);
```

Add constraint assertions:

```js
assert.throws(
  () => db.run("INSERT INTO asset_sources (id,name,source_type,read_only,created_at,updated_at) VALUES ('bad','bad','invalid',0,'t','t')"),
  /CHECK constraint failed/,
);
assert.throws(
  () => db.run("INSERT INTO credential_refs (id,credential_type,vault_provider,vault_service,vault_account,label,created_at,updated_at) VALUES ('c','raw_secret','p','s','a','l','t','t')"),
  /CHECK constraint failed/,
);
applyMigrations(db);
assert.equal(db.get('SELECT COUNT(*) AS count FROM schema_migrations').count, 2);
```

- [x] **Step 2: Run the migration test to verify RED**

Run:

```bash
npm run test:database
```

Expected: FAIL because `migrations.js` and SQL files do not exist.

- [x] **Step 3: Implement `001-core-assets-monitor.sql`**

The canonical SQL has already been reviewed in `docs/superpowers/specs/2026-05-26-remote-terminal-sftp-design.md`. Copy the complete SQL statements from the committed blocks at lines 253-281, 289-334 and 349-396 into `001-core-assets-monitor.sql`, in that order. Do not copy `schema_migrations`, because `migrations.js` creates its ledger before applying versioned SQL. This gives the file these complete tables and indexes:

```text
app_settings
data_import_runs
data_import_issues -> data_import_runs ON DELETE CASCADE
asset_sources
devices -> asset_sources, UNIQUE(asset_source_id, external_id)
device_tags -> devices ON DELETE CASCADE
monitor_profiles -> devices ON DELETE CASCADE
monitor_current_status -> monitor_profiles ON DELETE CASCADE
monitor_results -> monitor_profiles ON DELETE CASCADE
idx_devices_type_status
idx_devices_name
idx_devices_ip
idx_monitor_results_profile_time
```

- [x] **Step 4: Implement `002-remote-access-audit.sql`**

Copy the complete committed SQL blocks at design-spec lines 404-459, 472-491, 504-543, 556-596 and 609-628 into `002-remote-access-audit.sql`, in that order. The reviewed source is intentionally referenced instead of duplicating a second editable copy of security-sensitive constraints inside this execution plan. The resulting resource defines:

```text
credential_refs
connection_profiles
idx_connection_profiles_default_device
idx_connection_profiles_device
ssh_host_keys
idx_ssh_host_keys_active_trust
remote_sessions
terminal_transcript_chunks, with direction CHECK(direction = 'output')
idx_remote_sessions_device_time
idx_transcript_chunks_session_seq
sftp_operations
sftp_transfers
idx_sftp_operations_device_time
idx_sftp_transfers_device_time
audit_events
idx_audit_events_time
idx_audit_events_device_time
idx_audit_events_session_time
```

This phase creates schema only; it does not store a credential or open a remote session.

- [x] **Step 5: Implement ordered transactional migrations**

`migrations.js` must create only the migration ledger directly, read the two SQL resources, and apply missing migrations in individual transactions:

```js
import { readFileSync } from 'node:fs';

const MIGRATIONS = [
  { version: 1, name: 'core-assets-monitor', sql: readFileSync(new URL('./sql/001-core-assets-monitor.sql', import.meta.url), 'utf8') },
  { version: 2, name: 'remote-access-audit', sql: readFileSync(new URL('./sql/002-remote-access-audit.sql', import.meta.url), 'utf8') },
];

export const applyMigrations = (database, { now = () => new Date().toISOString() } = {}) => {
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);');
  for (const migration of MIGRATIONS) {
    if (database.get('SELECT version FROM schema_migrations WHERE version = ?', migration.version)) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      database.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', migration.version, migration.name, now());
    });
  }
  return database.all('SELECT version, name, applied_at FROM schema_migrations ORDER BY version');
};
```

- [x] **Step 6: Run GREEN verification and commit**

Run:

```bash
npm run test:database
git add server/src/database/migrations.js server/src/database/sql server/test/database/migrations.test.js
git commit -m "feat: add remote access sqlite schema"
```

Expected: adapter and migration tests pass; a second `applyMigrations()` call leaves two applied versions.

## Task 3: Build Foundation Repositories And JSON Import

**Files:**
- Create: `server/test/database/jsonAssetImporter.test.js`
- Create: `server/src/database/foundationRepositories.js`
- Create: `server/src/database/jsonAssetImporter.js`

- [x] **Step 1: Write a failing mapped-import and orphan-isolation test**

Use a fixture directory containing:

```js
await writeJson(path.join(assetsDir, 'devices.local.json'), {
  devices: [{ id: 'local-1', name: 'Local Server', deviceType: 'server', ipAddress: '10.0.0.10', assetId: 'A-1', status: 'healthy' }],
});
await writeJson(path.join(assetsDir, 'device.remote.json'), { code: 0, data: [] });
await writeJson(path.join(assetsDir, 'device.meta.json'), {
  items: [
    { source: 'local', deviceId: 'local-1', tags: ['用户添加'], monitorEnabled: true, checkType: 'ping+tcp', checkTarget: '10.0.0.10', checkPort: 22 },
    { source: 'remote', deviceId: 'orphan-remote', tags: ['远端资产'], monitorEnabled: true, checkType: 'ping', checkTarget: '10.0.0.20' },
  ],
});
await writeJson(path.join(assetsDir, 'device.status.json'), { items: [] });
```

After `importJsonAssets({ database: db, assetsDir, backupRoot, now, createId })`, assert:

```js
assert.equal(result.status, 'succeeded');
assert.equal(db.get('SELECT COUNT(*) AS count FROM devices').count, 1);
assert.equal(db.get('SELECT COUNT(*) AS count FROM monitor_profiles').count, 1);
assert.equal(db.get('SELECT COUNT(*) AS count FROM data_import_issues').count, 1);
assert.equal(db.get('SELECT issue_code FROM data_import_issues').issue_code, 'orphan_monitor_metadata');
assert.equal(db.get("SELECT setting_value_json FROM app_settings WHERE setting_key = 'assets.initial_import.completed'").setting_value_json, 'true');
```

- [x] **Step 2: Write failing backup and idempotency tests**

Assert that the first import creates a backup directory containing each JSON input and that a second call returns `already_imported` without inserting a second import run:

```js
const first = await importJsonAssets({ database: db, assetsDir, backupRoot, now, createId });
const second = await importJsonAssets({ database: db, assetsDir, backupRoot, now, createId });
assert.match(first.sourceBackupPath, /assets-backup-/);
assert.equal(await readFile(path.join(first.sourceBackupPath, 'devices.local.json'), 'utf8'), originalLocalJson);
assert.equal(second.status, 'already_imported');
assert.equal(db.get('SELECT COUNT(*) AS count FROM data_import_runs').count, 1);
```

Add a rollback assertion using metadata for the valid local fixture device with `checkPort: 70000`, which violates the approved monitor port CHECK constraint:

```js
await assert.rejects(
  importJsonAssets({ database: failedDb, assetsDir: invalidAssetsDir, backupRoot, now, createId }),
  /CHECK constraint failed/,
);
assert.equal(failedDb.get('SELECT COUNT(*) AS count FROM devices').count, 0);
assert.equal(failedDb.get('SELECT status FROM data_import_runs').status, 'failed');
assert.equal(failedDb.get("SELECT COUNT(*) AS count FROM app_settings WHERE setting_key = 'assets.initial_import.completed'").count, 0);
```

- [x] **Step 3: Run importer tests to verify RED**

Run:

```bash
npm run test:database
```

Expected: FAIL because repository and importer modules do not exist.

- [x] **Step 4: Implement parameterized foundation repositories**

Implement `createFoundationRepositories(database)` with the following exact write contracts. Each listed property is a positional bound parameter in the listed order; no JSON value is concatenated into SQL.

| Method | Insert/update columns in binding order | Conflict/update behavior |
| --- | --- | --- |
| `startImportRun(run)` | `id`, `import_kind`, `source_backup_path`, `status`, `started_at` | insert a `started` run only |
| `completeImportRun(run)` | `status`, `imported_devices`, `imported_monitor_profiles`, `issue_count`, `ended_at`, `error_message`, followed by lookup `id` | update one existing run |
| `upsertSource(source)` | `id`, `name`, `source_type`, `read_only`, `config_json`, `created_at`, `updated_at` | on `id`, update name/type/read-only/config/updated time |
| `upsertDevice(device)` | `id`, `asset_source_id`, `external_id`, `name`, `asset_id`, `device_type`, `asset_status`, `ip_address`, `management_ip`, `manufacturer`, `model`, `serial_number`, `organization`, `owner`, `location`, `remark`, `source_payload_json`, `created_at`, `updated_at`, `synced_at` | on `(asset_source_id, external_id)`, update imported display/source fields and updated/synced time |
| `replaceTags(deviceId, tags, at)` | delete by `device_id`; insert `device_id`, `tag`, `created_at` for every unique non-empty tag | full replacement for the imported device |
| `upsertMonitorProfile(profile)` | `id`, `device_id`, `enabled`, `check_ping`, `check_tcp`, `target_host`, `target_port`, `interval_seconds`, `timeout_ms`, `failure_threshold`, `notify_voice`, `notify_alert`, `comment`, `created_at`, `updated_at` | on `device_id`, update imported monitor settings and updated time |
| `upsertMonitorStatus(status)` | `monitor_profile_id`, `status`, `online`, `last_check_at`, `last_success_at`, `last_failure_at`, `latency_ms`, `failure_count`, `last_error`, `message` | on `monitor_profile_id`, update current status fields |
| `recordIssue(issue)` | `id`, `import_run_id`, `source_file`, `source_record_key`, `issue_code`, `issue_summary`, `source_record_json`, `created_at` | insert one isolated issue |

Also implement these fixed setting queries:

```js
isInitialImportComplete: () => database.get(
  "SELECT setting_value_json FROM app_settings WHERE setting_key = 'assets.initial_import.completed'",
)?.setting_value_json === 'true'

markInitialImportComplete: (at) => database.run(
  "INSERT INTO app_settings (setting_key, setting_value_json, updated_at) VALUES ('assets.initial_import.completed', 'true', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value_json = excluded.setting_value_json, updated_at = excluded.updated_at",
  at,
)
```

- [x] **Step 5: Implement transactional importer with backup-first behavior**

`jsonAssetImporter.js` must:

1. Return `{ status: 'already_imported' }` when the completion setting already exists.
2. Copy the full `assetsDir` directory recursively into `backupRoot/assets-backup-<timestamp>/` before database writes.
3. Create source rows `local-default` and `remote-default`.
4. Map local and remote asset fields into `devices`.
5. Link metadata/status only after its device exists.
6. Write `orphan_monitor_metadata` or `orphan_monitor_status` issues rather than failing for unmatched records.
7. Perform imports and completion marker within one adapter transaction, while marking an unexpected failed run outside the rolled-back transaction.

Expose the signature `importJsonAssets({ database, assetsDir, backupRoot, now, createId })`; default `now` to `() => new Date().toISOString()` and `createId` to `() => randomUUID()` so tests can supply deterministic values.

- [x] **Step 6: Run GREEN verification and commit**

Run:

```bash
npm run test:database
git add server/src/database/foundationRepositories.js server/src/database/jsonAssetImporter.js server/test/database/jsonAssetImporter.test.js
git commit -m "feat: import asset json into sqlite foundation"
```

Expected: JSON fixture imports one device and profile, isolates one orphan issue, creates backup copies and refuses a second initial import.

## Task 4: Provide An Explicit Initialization Entry Point

**Files:**
- Create: `server/src/database/index.js`
- Modify: `server/test/database/jsonAssetImporter.test.js`

- [x] **Step 1: Write a failing initialization test**

Add a test that uses only the intended public entry point:

```js
import { initializeFoundationDatabase } from '../../src/database/index.js';

const result = await initializeFoundationDatabase({ databasePath, assetsDir, backupRoot, now, createId });
try {
  assert.equal(result.importResult.status, 'succeeded');
  assert.equal(result.database.get('SELECT COUNT(*) AS count FROM schema_migrations').count, 2);
  assert.equal(result.database.get('SELECT COUNT(*) AS count FROM devices').count, 1);
} finally {
  result.database.close();
}
```

- [x] **Step 2: Run the initialization test to verify RED**

Run:

```bash
npm run test:database
```

Expected: FAIL because `server/src/database/index.js` does not exist.

- [x] **Step 3: Implement the public factory**

Keep the public boundary deliberately small:

```js
import { openSqliteAdapter } from './sqliteAdapter.js';
import { applyMigrations } from './migrations.js';
import { importJsonAssets } from './jsonAssetImporter.js';

export const initializeFoundationDatabase = async (options = {}) => {
  const database = openSqliteAdapter({ databasePath: options.databasePath });
  try {
    const migrations = applyMigrations(database, { now: options.now });
    const importResult = options.assetsDir
      ? await importJsonAssets({ database, assetsDir: options.assetsDir, backupRoot: options.backupRoot, now: options.now, createId: options.createId })
      : null;
    return { database, migrations, importResult };
  } catch (error) {
    database.close();
    throw error;
  }
};
```

- [x] **Step 4: Run GREEN verification and commit**

Run:

```bash
npm run test:database
git add server/src/database/index.js server/test/database/jsonAssetImporter.test.js
git commit -m "feat: expose sqlite foundation initializer"
```

Expected: all Phase 1 database tests pass. No existing server route invokes the initializer yet.

## Task 5: Verify The Foundation Without Claiming Windows Release

**Files:**
- Modify: `docs/superpowers/research/2026-05-26-remote-access-p0-results.md` only if a new non-secret development observation must be recorded

- [x] **Step 1: Run database and existing product verification**

Run:

```bash
npm run test:database
npm run build
npm run package:test
```

Expected: database tests pass; frontend build and existing test-bundle build pass. The package still does not represent a validated Windows remote-access release.

- [x] **Step 2: Scan tracked work for prohibited secret material**

Run:

```bash
git diff --check
git diff --name-only
rg -n "BEGIN .*PRIVATE KEY|OPSDOG_SSH_TEST_PASSWORD|password\\s*[:=]|privateKey\\s*[:=]|passphrase\\s*[:=]" server/src/database server/test/database docs/superpowers/research/2026-05-26-remote-access-p0-results.md || true
```

Expected: no credential, host address or private-key material appears in implementation, tests or the result record.

- [x] **Step 3: Record the still-open Windows publication checks in the handoff**

The completion report must state that these remain untested and block Windows remote-access release:

```text
Node.js 24 LTS runtime/module loading on Windows
SQLite database path, WAL, migration, restart and backup behavior on Windows
Credential Manager round trip through SecretStore
Windows dependency packaging and start-windows.cmd startup
Windows SSH/SFTP and host-key security behavior
```

Expected: Phase 1 may be described as implemented and locally verified only; Windows compatibility may not be described as passing.
