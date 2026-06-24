import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { handleSftpHttpRoute } from '../../src/remote/sftpHttpApi.js';

const listen = async (server) => await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve(`http://127.0.0.1:${address.port}`);
  });
});

const createHarness = async () => {
  const calls = [];
  const stream = new PassThrough();
  const sftpService = {
    async openSession(profileId) {
      calls.push(['openSession', profileId]);
      return { status: 'ready', session: { id: 'sftp-session-one', profileId, openedAt: '2026-06-01T08:00:00.000Z' } };
    },
    async list(sessionId, remotePath) {
      calls.push(['list', sessionId, remotePath]);
      return { path: remotePath, entries: [] };
    },
    async stat(sessionId, remotePath) {
      calls.push(['stat', sessionId, remotePath]);
      return { path: remotePath, entry: { name: 'app.log', path: remotePath, kind: 'file', size: 4 } };
    },
    async download(sessionId, remotePath) {
      calls.push(['download', sessionId, remotePath]);
      return { transferId: 'transfer-one', remotePath, displayFileName: 'app.log', stream };
    },
    async upload(sessionId, request) {
      const chunks = [];
      for await (const chunk of request.stream) chunks.push(Buffer.from(chunk));
      calls.push([
        'upload',
        sessionId,
        request.remotePath,
        request.fileName,
        Buffer.concat(chunks).toString('utf8'),
        request.sizeBytes,
        request.confirmOverwrite,
      ]);
      return { transferId: 'upload-one', remotePath: request.remotePath, status: 'succeeded' };
    },
    async mkdir(sessionId, remotePath) {
      calls.push(['mkdir', sessionId, remotePath]);
      return { path: remotePath, status: 'succeeded' };
    },
    async rename(sessionId, fromPath, toPath) {
      calls.push(['rename', sessionId, fromPath, toPath]);
      return { fromPath, toPath, status: 'succeeded' };
    },
    async deleteFile(sessionId, remotePath) {
      calls.push(['deleteFile', sessionId, remotePath]);
      return { path: remotePath, status: 'succeeded' };
    },
    closeSession(sessionId, reason) {
      calls.push(['closeSession', sessionId, reason]);
      return true;
    },
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const handled = await handleSftpHttpRoute({
      req,
      res,
      url,
      segments: url.pathname.split('/').filter(Boolean),
      sftpService,
      corsHeaders: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:4175' },
    });
    if (!handled && !res.writableEnded) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  const origin = await listen(server);
  return {
    calls,
    origin,
    stream,
    close: async () => await new Promise((resolve) => server.close(resolve)),
  };
};

test('SFTP HTTP routes expose read-only operations and gated mutations', async () => {
  const harness = await createHarness();
  try {
    const session = await fetch(`${harness.origin}/api/remote/profiles/profile-one/sftp-sessions`, { method: 'POST' });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).session.id, 'sftp-session-one');

    const listed = await fetch(`${harness.origin}/api/remote/sftp-sessions/sftp-session-one/list?path=%2Fvar%2Flog`);
    assert.deepEqual(await listed.json(), { path: '/var/log', entries: [] });

    const stat = await fetch(`${harness.origin}/api/remote/sftp-sessions/sftp-session-one/stat?path=%2Fvar%2Flog%2Fapp.log`);
    assert.equal((await stat.json()).entry.size, 4);

    const downloadPromise = fetch(`${harness.origin}/api/remote/sftp-sessions/sftp-session-one/download?path=%2Fvar%2Flog%2Fapp.log`);
    await once(harness.stream, 'resume');
    harness.stream.end('body');
    const download = await downloadPromise;
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition') || '', /attachment/);
    assert.equal(await download.text(), 'body');

    const closed = await fetch(`${harness.origin}/api/remote/sftp-sessions/sftp-session-one`, { method: 'DELETE' });
    assert.deepEqual(await closed.json(), { ok: true });

    const form = new FormData();
    form.set('path', '/tmp/upload.txt');
    form.set('confirmOverwrite', 'true');
    form.set('file', new Blob(['upload-body'], { type: 'text/plain' }), 'upload.txt');
    const upload = await fetch(`${harness.origin}/api/remote/sftp-sessions/sftp-session-one/upload`, {
      method: 'POST',
      body: form,
    });
    assert.equal(upload.status, 200);
    assert.equal((await upload.json()).transferId, 'upload-one');

    const mkdir = await fetch(`${harness.origin}/api/remote/sftp-sessions/sftp-session-one/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/new-dir' }),
    });
    assert.deepEqual(await mkdir.json(), { path: '/tmp/new-dir', status: 'succeeded' });

    const rename = await fetch(`${harness.origin}/api/remote/sftp-sessions/sftp-session-one/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromPath: '/tmp/a.txt', toPath: '/tmp/b.txt' }),
    });
    assert.deepEqual(await rename.json(), { fromPath: '/tmp/a.txt', toPath: '/tmp/b.txt', status: 'succeeded' });

    const deleted = await fetch(`${harness.origin}/api/remote/sftp-sessions/sftp-session-one/entries?path=%2Ftmp%2Fb.txt`, {
      method: 'DELETE',
    });
    assert.deepEqual(await deleted.json(), { path: '/tmp/b.txt', status: 'succeeded' });

    assert.deepEqual(harness.calls, [
      ['openSession', 'profile-one'],
      ['list', 'sftp-session-one', '/var/log'],
      ['stat', 'sftp-session-one', '/var/log/app.log'],
      ['download', 'sftp-session-one', '/var/log/app.log'],
      ['closeSession', 'sftp-session-one', 'operator_closed'],
      ['upload', 'sftp-session-one', '/tmp/upload.txt', 'upload.txt', 'upload-body', 11, true],
      ['mkdir', 'sftp-session-one', '/tmp/new-dir'],
      ['rename', 'sftp-session-one', '/tmp/a.txt', '/tmp/b.txt'],
      ['deleteFile', 'sftp-session-one', '/tmp/b.txt'],
    ]);
  } finally {
    await harness.close();
  }
});

test('SFTP mutation HTTP routes reject malformed bodies with stable errors', async () => {
  const harness = await createHarness();
  try {
    const badUpload = await fetch(`${harness.origin}/api/remote/sftp-sessions/sftp-session-one/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not multipart',
    });
    assert.equal(badUpload.status, 415);
    assert.deepEqual(await badUpload.json(), {
      error: 'SFTP upload requires multipart form data.',
      details: { code: 'SFTP_UPLOAD_BODY_UNSUPPORTED' },
    });

    const badMkdir = await fetch(`${harness.origin}/api/remote/sftp-sessions/sftp-session-one/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(badMkdir.status, 400);
    assert.equal((await badMkdir.json()).details.code, 'SFTP_PATH_REQUIRED');

    const badRename = await fetch(`${harness.origin}/api/remote/sftp-sessions/sftp-session-one/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromPath: '/tmp/a.txt' }),
    });
    assert.equal(badRename.status, 400);
    assert.equal((await badRename.json()).details.code, 'SFTP_RENAME_PATHS_REQUIRED');

    const badDelete = await fetch(`${harness.origin}/api/remote/sftp-sessions/sftp-session-one/entries`, {
      method: 'DELETE',
    });
    assert.equal(badDelete.status, 400);
    assert.equal((await badDelete.json()).details.code, 'SFTP_PATH_REQUIRED');

    assert.deepEqual(harness.calls, []);
  } finally {
    await harness.close();
  }
});
