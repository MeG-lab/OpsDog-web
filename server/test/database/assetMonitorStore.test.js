import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeFoundationDatabase } from '../../src/database/index.js';
import { createSqliteAssetMonitorStore } from '../../src/database/assetMonitorStore.js';

const FIXED_NOW = '2026-05-26T09:00:00.000Z';

const writeJson = async (filePath, value) => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const createFixture = async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opsdog-asset-store-'));
  const assetsDir = path.join(root, 'assets');
  await mkdir(assetsDir, { recursive: true });
  await writeJson(path.join(assetsDir, 'devices.local.json'), {
    devices: [{
      id: 'local-1',
      name: 'Local Server',
      assetId: 'LOCAL-1',
      deviceType: 'server',
      status: 'healthy',
      ipAddress: '10.0.0.10',
      organization: 'Operations',
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    }],
  });
  await writeJson(path.join(assetsDir, 'device.remote.json'), {
    code: 0,
    data: [{
      id: 'remote-1',
      name: 'Remote Firewall',
      assetType: 3,
      useStatus: 13,
      ipAddr: '10.0.0.20',
      deviceBrand: 'Vendor',
      deviceModel: 'FW-1',
      productSn: 'SN-R',
      customerName: 'Customer',
      providerName: 'Provider',
      jfName: 'Room A',
      manageUser: 'Operator',
      manageUserPhone: '10086',
      openPort: '443',
    }],
  });
  await writeJson(path.join(assetsDir, 'device.meta.json'), {
    items: [{
      source: 'local',
      deviceId: 'local-1',
      tags: ['用户添加'],
      monitorEnabled: true,
      checkType: 'ping+tcp',
      checkTarget: '10.0.0.10',
      checkPort: 22,
      intervalSec: 5,
      timeoutMs: 3000,
      failThreshold: 3,
      notifyVoice: false,
      notifyAlert: true,
      comment: 'Local monitor',
    }, {
      source: 'remote',
      deviceId: 'remote-1',
      tags: ['远端资产', '安全设备'],
      monitorEnabled: true,
      checkType: 'tcp',
      checkTarget: '10.0.0.20',
      checkPort: 443,
      intervalSec: 5,
      timeoutMs: 3000,
      failThreshold: 2,
      notifyVoice: true,
      notifyAlert: true,
      comment: 'Remote monitor',
    }],
  });
  await writeJson(path.join(assetsDir, 'device.status.json'), {
    items: [{
      source: 'local',
      deviceId: 'local-1',
      status: 'attention',
      online: false,
      checkType: 'ping+tcp',
      lastCheckAt: FIXED_NOW,
      lastSuccessAt: null,
      lastFailureAt: FIXED_NOW,
      latencyMs: null,
      failCount: 1,
      lastError: 'unreachable',
      message: 'ping 失败 / tcp 失败',
    }],
  });

  const initialized = await initializeFoundationDatabase({
    databasePath: path.join(root, 'opsdog.db'),
    assetsDir,
    backupRoot: path.join(root, 'backups'),
    now: () => FIXED_NOW,
    createId: (() => {
      let index = 0;
      return () => `import-${++index}`;
    })(),
  });
  let nextId = 0;
  const store = createSqliteAssetMonitorStore(initialized.database, {
    now: () => FIXED_NOW,
    createId: () => `created-${++nextId}`,
  });
  return { root, database: initialized.database, store };
};

const cleanupFixture = ({ database, root }) => {
  database.close();
  rmSync(root, { recursive: true, force: true });
};

test('SQLite asset store returns JSON-compatible merged assets, filters and statuses', async () => {
  const fixture = await createFixture();
  try {
    const merged = await fixture.store.listMergedDevices();
    assert.equal(merged.total, 2);
    assert.equal(merged.filteredTotal, 2);

    const local = merged.items.find((item) => item.id === 'local:local-1');
    assert.equal(local.source, 'local');
    assert.equal(local.status, 'attention');
    assert.deepEqual(local.tags, ['用户添加']);
    assert.equal(local.checkType, 'ping+tcp');

    const remote = merged.items.find((item) => item.id === 'remote:remote-1');
    assert.equal(remote.editable, false);
    assert.equal(remote.providerName, 'Provider');
    assert.equal(remote.deviceBrand, 'Vendor');
    assert.deepEqual(remote.tags, ['安全设备', '远端资产']);

    assert.equal((await fixture.store.listMergedDevices({ name: 'fire' })).filteredTotal, 1);
    assert.equal((await fixture.store.listMergedDevices({ ipAddr: '10.0.0.10' })).items[0].id, 'local:local-1');
    assert.equal((await fixture.store.listMergedDevices({ assetType: '3' })).items[0].id, 'remote:remote-1');
    assert.equal((await fixture.store.listMergedDevices({ source: 'remote' })).filteredTotal, 1);

    const status = (await fixture.store.readDeviceStatus()).find((item) => item.deviceId === 'local-1');
    assert.equal(status.source, 'local');
    assert.equal(status.failCount, 1);

    await fixture.store.writeDeviceStatus([{
      source: 'local',
      deviceId: 'local-1',
      status: 'healthy',
      online: true,
      lastCheckAt: FIXED_NOW,
      lastSuccessAt: FIXED_NOW,
      lastFailureAt: null,
      latencyMs: 4,
      failCount: 0,
      lastError: '',
      message: 'ping 正常 / tcp 正常',
    }]);
    const refreshed = (await fixture.store.listMergedDevices({ source: 'local' })).items[0];
    assert.equal(refreshed.status, 'healthy');
    assert.equal(refreshed.online, true);
  } finally {
    cleanupFixture(fixture);
  }
});

test('SQLite asset store persists local CRUD and default monitoring without editing remote devices', async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.createLocalManagedAssetDevice({
      id: 'new-security',
      name: 'New Security Device',
      deviceType: 'security',
      ipAddress: '10.0.0.30',
      status: 'healthy',
    });
    assert.equal(created.id, 'local:new-security');

    let merged = (await fixture.store.listMergedDevices({ source: 'local' })).items
      .find((item) => item.id === created.id);
    assert.equal(merged.checkType, 'tcp');
    assert.equal(merged.checkPort, 443);
    assert.equal(merged.monitorStatus, 'unknown');
    assert.deepEqual(merged.tags, ['用户添加']);

    const updated = await fixture.store.updateLocalManagedAssetDevice(created.id, {
      id: 'cannot-rewrite-id',
      assetId: '',
      createdAt: '1999-01-01T00:00:00.000Z',
      deviceType: 'server',
      ipAddress: '10.0.0.31',
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.assetId, created.assetId);
    assert.equal(updated.createdAt, FIXED_NOW);
    merged = (await fixture.store.listMergedDevices({ source: 'local' })).items
      .find((item) => item.id === created.id);
    assert.equal(merged.checkType, 'ping+tcp');
    assert.equal(merged.checkTarget, '10.0.0.31');
    assert.equal(merged.checkPort, 22);
    let monitorTarget = (await fixture.store.listMonitorTargets())
      .find((item) => item.deviceId === 'new-security');
    assert.equal(monitorTarget.checkPort, 22);
    assert.deepEqual(monitorTarget.fallbackTcpPorts, [23]);

    fixture.database.run(
      `
        INSERT INTO connection_profiles
          (id, device_id, name, protocol, host, port, username, auth_method,
           strict_host_key_checking, sftp_enabled, created_at, updated_at)
        VALUES ('profile:new-security', ?, 'TELNET', 'telnet', '10.0.0.31', 23, '',
                'none', 0, 0, ?, ?)
      `,
      created.id,
      FIXED_NOW,
      FIXED_NOW,
    );
    monitorTarget = (await fixture.store.listMonitorTargets())
      .find((item) => item.deviceId === 'new-security');
    assert.equal(monitorTarget.checkTarget, '10.0.0.31');
    assert.equal(monitorTarget.checkPort, 23);
    assert.deepEqual(monitorTarget.fallbackTcpPorts, []);

    await assert.rejects(
      fixture.store.updateLocalManagedAssetDevice('remote:remote-1', { name: 'Nope' }),
      /远端资产当前为只读/,
    );
    await assert.rejects(
      fixture.store.deleteLocalManagedAssetDevice('remote:remote-1'),
      /远端资产当前为只读/,
    );

    await fixture.store.deleteLocalManagedAssetDevice(created.id);
    assert.equal((await fixture.store.listMergedDevices({ source: 'local' })).items.some((item) => item.id === created.id), false);
    assert.equal((await fixture.store.readDeviceStatus()).some((item) => item.deviceId === 'new-security'), false);
    assert.equal(
      fixture.database.get('SELECT deleted_at FROM devices WHERE id = ?', created.id).deleted_at,
      FIXED_NOW,
    );
    assert.equal(
      fixture.database.get("SELECT COUNT(*) AS count FROM monitor_profiles WHERE device_id = 'local:new-security' AND enabled = 1").count,
      0,
    );
  } finally {
    cleanupFixture(fixture);
  }
});
