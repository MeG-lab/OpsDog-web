import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeFoundationDatabase } from '../../src/database/index.js';
import { importJsonAssets } from '../../src/database/jsonAssetImporter.js';
import { applyMigrations } from '../../src/database/migrations.js';
import { openSqliteAdapter } from '../../src/database/sqliteAdapter.js';

const FIXED_NOW = '2026-05-26T08:00:00.000Z';

const writeJson = async (filePath, value) => {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, content, 'utf8');
  return content;
};

const createIdFactory = () => {
  let index = 0;
  return () => `generated-${++index}`;
};

const createFixture = async ({ invalidPort = false } = {}) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-db-import-'));
  const assetsDir = path.join(root, 'assets');
  const backupRoot = path.join(root, 'backups');
  await mkdir(assetsDir, { recursive: true });

  const originalLocalJson = await writeJson(path.join(assetsDir, 'devices.local.json'), {
    devices: [{
      id: 'local-1',
      name: 'Local Server',
      assetId: 'A-1',
      deviceType: 'server',
      ipAddress: '10.0.0.10',
      manufacturer: 'Acme',
      model: 'Model-1',
      serialNumber: 'SN-1',
      organization: 'Ops',
      owner: 'Admin',
      location: 'Lab',
      remark: 'Managed locally',
      status: 'healthy',
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    }],
  });
  await writeJson(path.join(assetsDir, 'device.remote.json'), { code: 0, data: [] });
  await writeJson(path.join(assetsDir, 'device.meta.json'), {
    items: [
      {
        source: 'local',
        deviceId: 'local-1',
        tags: ['用户添加'],
        monitorEnabled: true,
        checkType: 'ping+tcp',
        checkTarget: '10.0.0.10',
        checkPort: invalidPort ? 70000 : 22,
        intervalSec: 5,
        timeoutMs: 3000,
        failThreshold: 3,
        notifyVoice: false,
        notifyAlert: true,
        comment: 'Local monitor',
      },
      {
        source: 'remote',
        deviceId: 'orphan-remote',
        tags: ['远端资产'],
        monitorEnabled: true,
        checkType: 'ping',
        checkTarget: '10.0.0.20',
      },
    ],
  });
  await writeJson(path.join(assetsDir, 'device.status.json'), {
    items: [{
      source: 'local',
      deviceId: 'local-1',
      status: 'healthy',
      online: true,
      lastCheckAt: FIXED_NOW,
      lastSuccessAt: FIXED_NOW,
      lastFailureAt: null,
      latencyMs: 3,
      failCount: 0,
      lastError: '',
      message: 'ping normal',
    }],
  });
  const originalMergedJson = await writeJson(path.join(assetsDir, 'device.merged.json'), {
    generatedAt: FIXED_NOW,
    total: 0,
    items: [],
  });

  const database = openSqliteAdapter({ databasePath: path.join(root, 'opsdog.db') });
  applyMigrations(database, { now: () => FIXED_NOW });

  return {
    root,
    assetsDir,
    backupRoot,
    database,
    originalLocalJson,
    originalMergedJson,
  };
};

const cleanupFixture = ({ database, root }) => {
  database.close();
  rmSync(root, { recursive: true, force: true });
};

test('asset JSON import maps valid records and isolates orphan monitor metadata', async () => {
  const fixture = await createFixture();
  try {
    const result = await importJsonAssets({
      database: fixture.database,
      assetsDir: fixture.assetsDir,
      backupRoot: fixture.backupRoot,
      now: () => FIXED_NOW,
      createId: createIdFactory(),
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM devices').count, 1);
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM monitor_profiles').count, 1);
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM monitor_current_status').count, 1);
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM data_import_issues').count, 1);
    assert.equal(
      fixture.database.get('SELECT issue_code FROM data_import_issues').issue_code,
      'orphan_monitor_metadata',
    );
    assert.equal(
      fixture.database.get("SELECT setting_value_json FROM app_settings WHERE setting_key = 'assets.initial_import.completed'").setting_value_json,
      'true',
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test('asset JSON import backs up files and runs only once', async () => {
  const fixture = await createFixture();
  try {
    const first = await importJsonAssets({
      database: fixture.database,
      assetsDir: fixture.assetsDir,
      backupRoot: fixture.backupRoot,
      now: () => FIXED_NOW,
      createId: createIdFactory(),
    });
    const second = await importJsonAssets({
      database: fixture.database,
      assetsDir: fixture.assetsDir,
      backupRoot: fixture.backupRoot,
      now: () => FIXED_NOW,
      createId: createIdFactory(),
    });

    assert.match(first.sourceBackupPath, /assets-backup-/);
    assert.equal(
      await readFile(path.join(first.sourceBackupPath, 'devices.local.json'), 'utf8'),
      fixture.originalLocalJson,
    );
    assert.equal(
      await readFile(path.join(first.sourceBackupPath, 'device.merged.json'), 'utf8'),
      fixture.originalMergedJson,
    );
    assert.equal(second.status, 'already_imported');
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM data_import_runs').count, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test('asset JSON import retains a failed run and rolls back imported data', async () => {
  const fixture = await createFixture({ invalidPort: true });
  try {
    await assert.rejects(
      importJsonAssets({
        database: fixture.database,
        assetsDir: fixture.assetsDir,
        backupRoot: fixture.backupRoot,
        now: () => FIXED_NOW,
        createId: createIdFactory(),
      }),
      /CHECK constraint failed/,
    );

    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM devices').count, 0);
    assert.equal(fixture.database.get('SELECT status FROM data_import_runs').status, 'failed');
    assert.equal(
      fixture.database.get("SELECT COUNT(*) AS count FROM app_settings WHERE setting_key = 'assets.initial_import.completed'").count,
      0,
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test('asset JSON import records malformed source JSON as a failed run after backup', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(path.join(fixture.assetsDir, 'device.meta.json'), '{ malformed-json', 'utf8');

    await assert.rejects(
      importJsonAssets({
        database: fixture.database,
        assetsDir: fixture.assetsDir,
        backupRoot: fixture.backupRoot,
        now: () => FIXED_NOW,
        createId: createIdFactory(),
      }),
      /JSON/,
    );

    assert.equal(fixture.database.get('SELECT status FROM data_import_runs').status, 'failed');
    assert.equal(fixture.database.get('SELECT COUNT(*) AS count FROM devices').count, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test('foundation initializer migrates and imports through one public entry point', async () => {
  const fixture = await createFixture();
  fixture.database.close();

  try {
    const result = await initializeFoundationDatabase({
      databasePath: path.join(fixture.root, 'initialized.db'),
      assetsDir: fixture.assetsDir,
      now: () => FIXED_NOW,
      createId: createIdFactory(),
    });

    try {
      assert.equal(result.importResult.status, 'succeeded');
      assert.equal(
        result.database.get('SELECT COUNT(*) AS count FROM schema_migrations').count,
        3,
      );
      assert.equal(result.database.get('SELECT COUNT(*) AS count FROM devices').count, 1);
      assert.match(result.importResult.sourceBackupPath, /backups/);
    } finally {
      result.database.close();
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
