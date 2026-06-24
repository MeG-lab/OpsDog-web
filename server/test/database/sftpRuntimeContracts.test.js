import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('frontend runtime exposes read-only and confirmed mutation SFTP operations', async () => {
  const [contracts, runtimeTypes, webRuntime, runtimeIndex] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/services/contracts.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/runtime/types.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/runtime/webRuntime.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/runtime/index.ts'), 'utf8'),
  ]);

  for (const symbol of [
    'SftpSessionReady',
    'SftpSessionResponse',
    'SftpDirectoryEntry',
    'SftpListResponse',
    'SftpStatResponse',
    'SftpUploadRequest',
    'SftpMutationResponse',
  ]) {
    assert.match(contracts, new RegExp(`\\b${symbol}\\b`));
    assert.match(runtimeIndex, new RegExp(`\\b${symbol}\\b`));
  }

  for (const method of [
    'createSftpSession',
    'listSftpEntries',
    'statSftpEntry',
    'getSftpDownloadUrl',
    'closeSftpSession',
    'uploadSftpFile',
    'createSftpDirectory',
    'renameSftpEntry',
    'deleteSftpFile',
  ]) {
    assert.match(runtimeTypes, new RegExp(`\\b${method}\\b`));
    assert.match(webRuntime, new RegExp(`\\b${method}\\b`));
    assert.match(runtimeIndex, new RegExp(`\\b${method}\\b`));
  }

  assert.match(webRuntime, /new URLSearchParams\(\)/);
  assert.match(webRuntime, /\/remote\/profiles\/\$\{encodeURIComponent\(profileId\)\}\/sftp-sessions/);
  assert.match(webRuntime, /\/remote\/sftp-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/list/);
  assert.match(webRuntime, /\/remote\/sftp-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/stat/);
  assert.match(webRuntime, /\/remote\/sftp-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/download/);
  assert.match(webRuntime, /\/remote\/sftp-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/upload/);
  assert.match(webRuntime, /\/remote\/sftp-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/mkdir/);
  assert.match(webRuntime, /\/remote\/sftp-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/rename/);
  assert.match(webRuntime, /\/remote\/sftp-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/entries/);
  assert.match(webRuntime, /FormData/);
  assert.match(webRuntime, /confirmOverwrite/);

  for (const forbidden of [
    'editSftpFile',
    'recursiveDeleteSftp',
  ]) {
    assert.doesNotMatch(`${runtimeTypes}\n${webRuntime}\n${runtimeIndex}`, new RegExp(`\\b${forbidden}\\b`, 'i'));
  }
});
