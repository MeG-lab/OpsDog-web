# Remote Access Phase 6 SFTP Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P5 只读 SFTP 真实验收完成后，安全地增加受确认保护的 SFTP 变更能力。

**Architecture:** P6 不修改 SSH/SFTP 协议实现，继续复用 `ssh2`、连接预设、主机密钥信任、系统凭据库和 SQLite 审计。所有变更操作必须经过后端策略校验、前端显式确认和元数据审计；文件正文仍不得写入 SQLite、审计 JSON 或应用日志。

**Tech Stack:** React + TypeScript + Vite、Node.js HTTP 服务、`ssh2` SFTP、SQLite 元数据审计、Node test runner。

---

## 0. Hard Gates Before Any Code

P6 包含远端变更操作，不能因为 UI 已有入口就提前开放。

- [x] P5 macOS 真实 SFTP 验收已记录：会话打开、列表、属性、下载、关闭、异常路径、metadata-only 审计。
- [x] 用户已明确批准 P6 操作矩阵：允许哪些操作、是否允许覆盖、是否允许目录递归删除。
- [x] Windows 仍保持 `NO-GO-RELEASE-WINDOWS`，直到 Windows Credential Manager、路径、下载和 SFTP 行为完成实机验收。
- [x] P6 第一版不实现远程文件直接编辑器，不实现拖放目录，不实现递归删除，不实现自动化/AI 调用 SFTP 变更。

## 1. P6 Operation Matrix

第一版建议只开放这四类人工操作：

| Operation | Default | Confirmation | Audit Event | Notes |
| --- | --- | --- | --- | --- |
| `upload` | Off until user approves | Required for every file | `sftp.upload.*` | No overwrite unless confirmed separately |
| `mkdir` | Allowed after confirmation | Required | `sftp.mkdir.*` | Single directory only |
| `rename` | Allowed after confirmation | Required | `sftp.rename.*` | Same session only |
| `delete` | File-only first | Required | `sftp.delete.*` | No recursive directory delete in first P6 |

## 2. Files To Touch

- Modify: `server/src/remote/sshTransport.js`
  - Add a separate mutation-capable SFTP adapter surface only when P6 service calls it.
- Modify: `server/src/remote/sftpService.js`
  - Add policy-checked `upload`, `mkdir`, `rename`, and `deleteFile` methods.
- Modify: `server/src/remote/sftpHttpApi.js`
  - Add mutation routes only after service tests exist.
- Modify: `src/services/contracts.ts`
  - Add typed request/response contracts for mutation operations.
- Modify: `src/services/runtime/types.ts`
  - Add runtime methods for mutation operations.
- Modify: `src/services/runtime/webRuntime.ts`
  - Add HTTP calls using existing `safeFetch`/`postJson`/`deleteJson` patterns.
- Modify: `src/services/runtime/index.ts`
  - Export P6 runtime methods and types.
- Modify: `src/components/Remote/SftpWorkspace.tsx`
  - Add controlled UI actions with confirmation dialogs.
- Modify: `src/components/Servers/ServersWorkspace.tsx`
  - Keep launch behavior unchanged; do not add profile-level write toggles until policy exists.
- Modify: `src/index.css`
  - Add compact mutation controls and confirmation modal styles.
- Add or modify tests under `server/test/database/*.test.js`
  - Keep source-level frontend tests plus service/API tests.

## 3. Task 1: Extend Transport With A Narrow Mutation Adapter

**Files:**

- Modify: `server/src/remote/sshTransport.js`
- Modify: `server/test/database/sshTransport.test.js`

- [x] **Step 1: Write failing transport tests**

Add tests proving P5 read-only adapter stays unchanged and a separate P6 adapter exposes only approved mutation methods:

```js
test('authenticated SFTP mutation adapter exposes only approved write operations', async () => {
  const client = new FakeSftpClient({ publicKey: TRUSTED_KEY.publicKeyBuffer });
  const transport = createSshTransport({ Client: client.Client });
  const adapter = await transport.openSftpMutations(PROFILE, PASSWORD, TRUSTED_KEY_VIEW);

  assert.deepEqual(Object.keys(adapter).sort(), [
    'close',
    'deleteFile',
    'mkdir',
    'rename',
    'uploadStream',
  ]);
  assert.equal(adapter.rmdir, undefined);
  assert.equal(adapter.recursiveDelete, undefined);
  assert.equal(adapter.createWriteStream, undefined);
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 server/test/database/sshTransport.test.js
```

Expected: fail because `openSftpMutations` does not exist.

- [x] **Step 3: Implement minimal transport surface**

Add `openSftpMutations(profile, password, trustedKey)` next to `openSftp`. It must reuse the same host-key verification and connection setup, but return only:

```js
{
  uploadStream(remotePath, readableStream),
  mkdir(remotePath),
  rename(fromPath, toPath),
  deleteFile(remotePath),
  close(),
}
```

Do not expose raw `sftp`, `createWriteStream`, `unlink`, `rmdir`, `fastPut`, or recursive helpers to callers.

- [x] **Step 4: Verify and commit**

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 server/test/database/sshTransport.test.js
git diff --check
git add server/src/remote/sshTransport.js server/test/database/sshTransport.test.js
git commit -m "feat: add gated sftp mutation transport"
```

## 4. Task 2: Add Policy-Gated Mutation Service

**Files:**

- Modify: `server/src/remote/sftpService.js`
- Modify: `server/test/database/sftpService.test.js`

- [x] **Step 1: Write failing service tests**

Add tests for:

- `upload` refuses overwrite unless `confirmOverwrite === true`.
- `mkdir` normalizes POSIX paths and records metadata only.
- `rename` rejects empty source/target and records both safe paths.
- `deleteFile` refuses directories and records file-only deletion.
- All operations fail when session is not active.
- Error responses contain stable codes and not raw server output.

Use assertions like:

```js
assert.equal(
  fixture.database.get("SELECT COUNT(*) AS count FROM audit_events WHERE detail_json LIKE '%secret%'").count,
  0,
);
assert.equal(fixture.transport.sftp.recursiveDeleteCalled, false);
```

- [x] **Step 2: Run test to verify it fails**

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 server/test/database/sftpService.test.js
```

Expected: fail because mutation service methods do not exist.

- [x] **Step 3: Implement minimal service methods**

Add methods:

```js
upload(sessionId, { remotePath, fileName, stream, sizeBytes, confirmOverwrite })
mkdir(sessionId, remotePath)
rename(sessionId, fromPath, toPath)
deleteFile(sessionId, remotePath)
```

Rules:

- Reuse active trusted SFTP sessions; do not re-read credentials per operation.
- Reject NUL paths and malformed paths using the P5 normalizer.
- Record operation rows and audit rows with metadata only.
- Do not store file bytes, local file names beyond display metadata, or raw remote errors.
- First P6 does not support recursive directory deletion.

- [x] **Step 4: Verify and commit**

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 server/test/database/sftpService.test.js
git diff --check
git add server/src/remote/sftpService.js server/test/database/sftpService.test.js
git commit -m "feat: gate audited sftp mutation service"
```

## 5. Task 3: Expose Mutation HTTP Routes

**Files:**

- Modify: `server/src/remote/sftpHttpApi.js`
- Modify: `server/test/database/sftpApi.integration.test.js`

- [x] **Step 1: Write failing API tests**

Routes to add only after tests:

```text
POST /api/remote/sftp-sessions/:id/upload
POST /api/remote/sftp-sessions/:id/mkdir
POST /api/remote/sftp-sessions/:id/rename
DELETE /api/remote/sftp-sessions/:id/entries?path=<path>
```

Tests must assert:

- Unapproved origin is rejected by existing remote origin policy.
- Request body validation rejects missing path fields.
- Upload requires `multipart/form-data` or a reviewed streaming body.
- Delete route is file-only and not recursive.
- P5 list/stat/download/close routes still pass.

- [x] **Step 2: Run test to verify it fails**

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 server/test/database/sftpApi.integration.test.js
```

- [x] **Step 3: Implement minimal routes**

Use existing `sendJson` behavior and stable HTTP statuses. Do not add wildcard CORS. Do not accept mutation requests from generic `/api` helpers outside `/api/remote/*`.

- [x] **Step 4: Verify and commit**

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 server/test/database/sftpApi.integration.test.js server/test/database/remoteProfilesApi.integration.test.js
git diff --check
git add server/src/remote/sftpHttpApi.js server/test/database/sftpApi.integration.test.js
git commit -m "feat: expose gated sftp mutation api"
```

## 6. Task 4: Add Frontend Runtime Contracts

**Files:**

- Modify: `src/services/contracts.ts`
- Modify: `src/services/runtime/types.ts`
- Modify: `src/services/runtime/webRuntime.ts`
- Modify: `src/services/runtime/index.ts`
- Modify: `server/test/database/sftpRuntimeContracts.test.js`

- [x] **Step 1: Write failing source-level runtime test**

Assert these methods exist and no direct edit method exists:

```js
for (const method of [
  'uploadSftpFile',
  'createSftpDirectory',
  'renameSftpEntry',
  'deleteSftpFile',
]) {
  assert.match(runtimeTypes, new RegExp(`\\b${method}\\b`));
}
assert.doesNotMatch(webRuntime, /editSftpFile|recursiveDeleteSftp/i);
```

- [x] **Step 2: Run test to verify it fails**

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 server/test/database/sftpRuntimeContracts.test.js
```

- [x] **Step 3: Implement minimal runtime methods**

Add typed methods with request objects:

```ts
uploadSftpFile(sessionId: string, request: SftpUploadRequest): Promise<SftpMutationResponse>;
createSftpDirectory(sessionId: string, path: string): Promise<SftpMutationResponse>;
renameSftpEntry(sessionId: string, fromPath: string, toPath: string): Promise<SftpMutationResponse>;
deleteSftpFile(sessionId: string, path: string): Promise<SftpMutationResponse>;
```

No `editSftpFile`, no recursive delete, no hidden overwrite default.

- [x] **Step 4: Verify and commit**

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 server/test/database/sftpRuntimeContracts.test.js
PATH="/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH" npm run build
git diff --check
git add src/services/contracts.ts src/services/runtime/types.ts src/services/runtime/webRuntime.ts src/services/runtime/index.ts server/test/database/sftpRuntimeContracts.test.js
git commit -m "feat: add sftp mutation runtime contracts"
```

## 7. Task 5: Add Confirmation-First UI

**Files:**

- Modify: `src/components/Remote/SftpWorkspace.tsx`
- Modify: `src/index.css`
- Modify: `server/test/database/sftpWorkspaceUi.test.js`

- [x] **Step 1: Write failing UI source test**

Assert the UI contains confirmation labels and still excludes direct editing:

```js
assert.match(workspace, /确认操作/);
assert.match(workspace, /deleteSftpFile/);
assert.match(workspace, /renameSftpEntry/);
assert.doesNotMatch(workspace, /直接编辑|editSftpFile|recursive/i);
```

- [x] **Step 2: Run test to verify it fails**

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 server/test/database/sftpWorkspaceUi.test.js
```

- [x] **Step 3: Implement UI controls**

Add buttons only in the SFTP workspace:

- Upload file: file picker plus confirmation summary showing remote path and overwrite state.
- New directory: path input plus confirmation.
- Rename: source path and target path confirmation.
- Delete file: file-only confirmation with remote path shown.

Each operation must refresh the listing after success and show a safe error message after failure.

- [x] **Step 4: Verify and commit**

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 server/test/database/sftpWorkspaceUi.test.js
PATH="/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH" npm run build
git diff --check
git add src/components/Remote/SftpWorkspace.tsx src/index.css server/test/database/sftpWorkspaceUi.test.js
git commit -m "feat: add confirmed sftp mutation ui"
```

## 8. Task 6: Acceptance And Release Gate

- [x] Run all database tests:

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 server/test/database/*.test.js
```

- [x] Run production build:

```bash
PATH="/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH" npm run build
```

- [x] macOS real SFTP acceptance on an approved test target:
  - Upload one benign file to a non-sensitive scratch directory.
  - Create one scratch directory.
  - Rename one scratch file.
  - Delete one scratch file.
  - Confirm audit rows contain metadata only.
  - Confirm no file body, password, terminal transcript or raw server error appears in SQLite.

- [x] Windows remains blocked:

```text
NO-GO-RELEASE-WINDOWS until Windows credential, packaging and SSH/SFTP acceptance checks pass.
```

## 9. Do Not Implement In P6

- Direct remote file editor.
- Recursive directory deletion.
- AI/MCP/automation access to SSH or SFTP mutations.
- Silent overwrite.
- Raw SFTP handle exposure.
- Storage of remote file bytes in SQLite, audit JSON or logs.
