import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('SFTP workspace UI exposes confirmation-first mutation controls without direct editing', async () => {
  const [workspace, serversWorkspace, styles] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/components/Remote/SftpWorkspace.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/components/Servers/ServersWorkspace.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/index.css'), 'utf8'),
  ]);

  for (const symbol of [
    'listSftpEntries',
    'statSftpEntry',
    'getSftpDownloadUrl',
    'uploadSftpFile',
    'createSftpDirectory',
    'renameSftpEntry',
    'deleteSftpFile',
  ]) {
    assert.match(workspace, new RegExp(`\\b${symbol}\\b`));
  }

  for (const label of [
    '确认操作',
    '上传文件',
    '新建目录',
    '重命名',
    '删除文件',
    '覆盖已有文件',
  ]) {
    assert.match(workspace, new RegExp(label));
  }

  assert.match(workspace, /getSftpEntryIcon/);
  assert.match(workspace, /FileCode/);
  assert.match(workspace, /FileImage/);
  assert.match(workspace, /FileArchive/);
  assert.match(workspace, /remote-sftp-file-icon/);
  assert.match(workspace, /remote-sftp-file-picker/);
  assert.match(workspace, /remote-sftp-open-btn/);
  assert.match(styles, /\.remote-sftp-file-icon/);
  assert.match(styles, /\.remote-sftp-file-picker/);
  assert.match(styles, /\.remote-sftp-open-btn/);
  assert.match(styles, /\.remote-sftp-cell-size/);
  assert.match(styles, /\.remote-sftp-cell-date/);

  assert.match(serversWorkspace, /React\.lazy\(\(\) => import\('\.\.\/Remote\/SftpWorkspace'\)\)/);
  assert.match(serversWorkspace, /\bcreateSftpSession\b/);
  assert.match(serversWorkspace, /打开文件/);
  assert.match(serversWorkspace, /kind: 'sftp'/);
  assert.match(serversWorkspace, /remote-access-overlay/);
  assert.doesNotMatch(serversWorkspace, /sftpSession\s*&&\s*typeof document !== 'undefined'/);
  assert.match(styles, /\.remote-access-overlay/);
  assert.match(styles, /\.remote-sftp-browser/);
  assert.match(styles, /\.remote-sftp-mutation-panel/);
  assert.match(styles, /\.remote-sftp-confirm/);

  for (const forbidden of [
    '直接编辑',
    'editSftpFile',
    'recursiveDeleteSftp',
  ]) {
    assert.doesNotMatch(workspace, new RegExp(forbidden, 'i'));
  }
});
