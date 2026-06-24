# Remote Access Phase 5 Read-Only SFTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已完成的 SSH 连接测试与交互式终端能力基础上，交付安全、可审计、仅只读的 SFTP 文件浏览和下载能力，并保持 Windows 发布门禁不提前解除。

**Architecture:** 复用现有连接预设、主机密钥信任、系统凭据库、`ssh2` 传输与审计模型；新增 SFTP 会话服务和只读 API/UI。远程文件内容只通过流响应传给前端，不写入 SQLite 或服务端业务存储。由于 P5 首次引入远程文件内容返回，远程 API 与终端 WebSocket 的来源校验必须在开放下载前完成。

**Tech Stack:** React + TypeScript + Vite、Node.js HTTP/WebSocket 服务、`ssh2`、SQLite 元数据审计、macOS Keychain/现有 Secret Store、Node test runner。

**Design Reference:** `docs/superpowers/specs/2026-05-26-remote-terminal-sftp-design.md` 是经批准的整体设计；`docs/superpowers/research/2026-05-26-remote-access-p0-results.md` 是现有阶段验收证据和后续追加记录的位置。

**Development Gate:** P4-B 交互式 SSH 终端已经完成 macOS 真实验收，允许进入 P5 的 macOS 开发与验收。P5 只能连接操作方批准的目标，不在文档、日志或提交内容中记录目标详情、凭据、文件正文或敏感远程路径。

**Release Gate:** `NO-GO-RELEASE-WINDOWS` 继续有效。Windows 凭据、运行时、打包、SSH/SFTP 和路径/下载行为通过实机验收前，不得表述为 Windows 已验证或可发布。

---

## 1. Scope And Exit Criteria

### Included In P5

- [ ] 打开只读 SFTP 会话，且仅对配置了 SSH 凭据并启用 SFTP 的连接预设开放。
- [ ] 浏览目录：`list`。
- [ ] 查询文件或目录元数据：`stat`。
- [ ] 下载远程文件：`download`，服务端流式转发，不落盘、不入库文件内容。
- [ ] 浏览、查询、下载和会话生命周期审计。
- [ ] 前端只读文件浏览器：面包屑、返回上级、刷新、目录进入、文件下载、会话关闭和错误提示。
- [ ] 对远程功能入口应用明确来源校验，防止新增下载能力处于通配 CORS 边界之下。
- [ ] 在 macOS 上完成真实 SFTP 验收；记录 Windows 后续必须验证的项目。

### Explicitly Excluded From P5

- 上传、创建目录、重命名、删除、覆盖文件。
- SCP、端口转发、跳板机、文件编辑器、拖放上传。
- 将远程文件内容、下载正文或终端输出持久化到 SQLite。
- 宣称 Windows 已完成验证或可发布。

### Definition Of Done

- [ ] API 仅提供会话创建、目录浏览、元数据查询、下载和关闭。
- [ ] 前端不存在上传、删除、创建目录、重命名入口。
- [ ] 不受信任或变化后的 SSH 主机密钥不能进入 SFTP 会话或读取凭据。
- [ ] 下载响应在浏览器场景下受允许来源控制；不再依赖远程路由上的通配来源响应。
- [ ] `sftp_operations` / `sftp_transfers` / `remote_sessions` / `audit_events` 仅保存元数据与结果状态。
- [ ] 自动化测试、构建打包、macOS 真实会话验收通过。
- [ ] Windows 仍保持 `NO-GO-RELEASE-WINDOWS`，直到单独验收完成。

## 2. Security Correction Before Implementation

现有总设计把 Origin/CORS 收紧放在较后阶段。P5 将首次通过 HTTP 返回远程服务器上的文件内容，因此该顺序需要调整：**远程功能来源校验是 P5 的前置安全项，而不是可推迟的优化。**

决策：

- [ ] 仅对 `/api/remote/*` 与远程终端 WebSocket 边界引入来源校验，避免无关 API 改造扩大本阶段风险。
- [ ] 允许配置中的前端来源和同服务来源；浏览器发来的其他非空 `Origin` 一律拒绝。
- [ ] 允许没有 `Origin` 的本地非浏览器调用，用于 CLI/自动测试，但这些调用仍需正常的身份、凭据和信任边界。
- [ ] `OPTIONS` 只为允许来源返回明确的 CORS 响应，远程接口不得回退到 `Access-Control-Allow-Origin: *`。
- [ ] WebSocket 升级在建立终端或未来会话通道之前执行同样的来源判断。

## 3. Existing Building Blocks To Reuse

| Concern | Existing Component | P5 Usage |
| --- | --- | --- |
| SSH implementation | `server/src/remote/sshTransport.js` using `ssh2` | Add SFTP adapter only; do not implement SSH/SFTP protocol manually |
| Profile storage | Current remote connection profile service | Read SFTP-enabled SSH profile |
| Credential handling | Existing secret store / OS secure storage | Read secret only after host trust passes |
| Host trust | Existing SSH host key service | Reuse probe/trust/mismatch behavior for every new SFTP session |
| Session/audit schema | `remote_sessions`, `sftp_operations`, `sftp_transfers`, `audit_events` | Persist metadata and lifecycle status; no migration expected |
| Frontend entry | `src/components/Servers/ServersWorkspace.tsx` | Add read-only SFTP launch entry next to terminal |
| Runtime APIs | `src/services/runtime/*` and `src/services/contracts.ts` | Add typed SFTP requests and responses |

## 4. API Contract

### Create Session

`POST /api/remote/profiles/:profileId/sftp-sessions`

Successful response:

```json
{
  "status": "ready",
  "session": {
    "id": "session-id",
    "profileId": "profile-id",
    "openedAt": "2026-05-27T00:00:00.000Z"
  }
}
```

Host trust responses continue to use the established host-key view contract, so the UI can require user trust or report mismatch without inventing a second flow.

### Browse Directory

`GET /api/remote/sftp-sessions/:id/list?path=<encoded-posix-path>`

```json
{
  "path": "/var/log",
  "entries": [
    {
      "name": "app.log",
      "path": "/var/log/app.log",
      "kind": "file",
      "size": 1204,
      "modifiedAt": "2026-05-27T00:00:00.000Z",
      "mode": 420
    }
  ]
}
```

### Stat Entry

`GET /api/remote/sftp-sessions/:id/stat?path=<encoded-posix-path>`

Response uses the same entry shape as directory browsing plus available SFTP metadata.

### Download File

`GET /api/remote/sftp-sessions/:id/download?path=<encoded-posix-path>`

- [ ] Set a safely encoded `Content-Disposition: attachment` filename derived only from the final POSIX basename.
- [ ] Set `Content-Type: application/octet-stream` unless a later explicitly reviewed MIME policy is added.
- [ ] Stream from `ssh2` SFTP to the HTTP response without buffering full content.
- [ ] On client abort, terminate the remote read stream and record `cancelled` or safe failure state.
- [ ] Do not put file bytes, partial contents, secrets, or raw server messages in logs or database records.

### Close Session

`DELETE /api/remote/sftp-sessions/:id`

Closes the SFTP handle and underlying SSH connection, updates session state, and is idempotent from the UI perspective.

## 5. Data And Audit Rules

No database migration is planned for P5 because the existing schema already supports SFTP sessions, operations and transfers.

| Action | Table(s) | Stored Metadata |
| --- | --- | --- |
| Session open/close/fail | `remote_sessions`, `audit_events` | profile/session IDs, protocol, timestamps, status, safe reason code |
| Directory list | `sftp_operations`, `audit_events` | normalized remote path, `list`, status, timestamps |
| Metadata query | `sftp_operations`, `audit_events` | normalized remote path, `stat`, status, timestamps |
| Download | `sftp_transfers`, `audit_events` | normalized remote path, display filename, expected/transferred byte count if available, status |

Rules:

- [ ] Normalize and validate remote paths as POSIX paths; reject NUL and malformed input.
- [ ] Preserve absolute/relative SFTP semantics deliberately: UI starts at a configured/default directory and sends normalized paths only.
- [ ] Store no downloaded file bytes or preview bodies.
- [ ] Store no credential values and no terminal text.
- [ ] Convert transport errors into stable safe error codes before exposing or auditing them.

## 6. Task 1: Protect The Remote HTTP And WebSocket Boundary

**Files:**

- Create: `server/src/remote/remoteOriginPolicy.js`
- Create: `server/test/database/remoteOriginPolicy.test.js`
- Modify: `server/src/index.js`
- Modify: `server/test/database/remoteProfilesApi.integration.test.js`

### Test First

- [ ] Add tests for permitted configured web origin.
- [ ] Add tests for permitted same-server origin where applicable in packaged mode.
- [ ] Add tests proving an unrelated non-empty browser origin is rejected with a stable remote-origin error.
- [ ] Add tests proving requests without `Origin` remain usable for local integration tests and non-browser clients.
- [ ] Extend API integration coverage so a remote route does not return wildcard CORS for a rejected/accepted browser origin.
- [ ] Cover WebSocket upgrade origin validation without opening a terminal session for a rejected origin.

Run the new failing tests:

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 \
  server/test/database/remoteOriginPolicy.test.js \
  server/test/database/remoteProfilesApi.integration.test.js
```

### Implement

- [ ] Introduce a small policy module accepting `webOrigin` and `serverOrigin` from `getAppConfig(process.env)`.
- [ ] Apply it at the `/api/remote/*` HTTP boundary before route work starts.
- [ ] Return explicit allowed-origin headers only for allowed browser origins.
- [ ] Apply the same policy before accepting `/api/remote/terminal` WebSocket upgrades.
- [ ] Leave unrelated HTTP APIs unchanged in this task.

### Verify And Commit

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 \
  server/test/database/remoteOriginPolicy.test.js \
  server/test/database/remoteProfilesApi.integration.test.js
git diff --check
git add server/src/remote/remoteOriginPolicy.js server/src/index.js \
  server/test/database/remoteOriginPolicy.test.js \
  server/test/database/remoteProfilesApi.integration.test.js
git commit -m "fix: restrict remote access browser origins"
```

## 7. Task 2: Add The Read-Only `ssh2` SFTP Adapter

**Files:**

- Modify: `server/src/remote/sshTransport.js`
- Modify: `server/test/database/sshTransport.test.js`

### Test First

- [ ] Test `openSftp` creates an SSH connection with existing trusted host-key verification.
- [ ] Test successful SFTP acquisition returns only read-only adapter operations: `list`, `stat`, `createReadStream`, `close`.
- [ ] Test host key rejection terminates before SFTP becomes usable.
- [ ] Test connection/SFTP channel errors and explicit close are surfaced exactly once.
- [ ] Assert no adapter method for write, mkdir, rename or delete exists in P5.

Run the failing transport tests:

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 \
  server/test/database/sshTransport.test.js
```

### Implement

- [ ] Add `openSftp(profile, password, trustedHostKey)` using the existing `ssh2.Client`.
- [ ] Use the existing host-verifier behavior and connection timeout patterns.
- [ ] Wrap the returned `sftp` handle in a narrow read-only adapter.
- [ ] Ensure stream and client close paths do not leak connections or double-report closure.
- [ ] Do not add write-capable methods merely because the underlying library supports them.

### Verify And Commit

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 \
  server/test/database/sshTransport.test.js
git diff --check
git add server/src/remote/sshTransport.js server/test/database/sshTransport.test.js
git commit -m "feat: add read-only sftp transport adapter"
```

## 8. Task 3: Add SFTP Session And Audit Service

**Files:**

- Create: `server/src/remote/sftpService.js`
- Create: `server/test/database/sftpService.test.js`

### Test First

- [ ] Test session opening refuses disabled/non-SFTP profiles.
- [ ] Test untrusted or mismatched host key returns the established trust result before reading the saved secret.
- [ ] Test successful session records an active `remote_sessions` row with `session_kind = 'sftp'`.
- [ ] Test `list` and `stat` invoke only read operations and write success/failure metadata.
- [ ] Test download returns a stream and writes transfer lifecycle metadata without storing bytes.
- [ ] Test stream completion, abort, transport error, explicit close and `closeAll` finalize status safely.
- [ ] Test safe error mapping avoids passing raw remote messages to API/audit responses.

Run the failing service tests:

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 \
  server/test/database/sftpService.test.js
```

### Implement

- [ ] Reuse existing database, secret store, host-key service and transport dependencies.
- [ ] Maintain in-memory active session handles keyed by session ID.
- [ ] Perform trust checking before resolving the secret and before opening SFTP.
- [ ] Add operations `openSession`, `list`, `stat`, `download`, `closeSession`, `closeAll`.
- [ ] Update database rows and audits at completion/failure/cancellation points only with metadata.
- [ ] Use stable internal result/error codes suitable for UI display mapping.

### Verify And Commit

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 \
  server/test/database/sftpService.test.js \
  server/test/database/sshTransport.test.js
git diff --check
git add server/src/remote/sftpService.js server/test/database/sftpService.test.js
git commit -m "feat: manage audited read-only sftp sessions"
```

## 9. Task 4: Expose Streaming SFTP HTTP Routes

**Files:**

- Modify: `server/src/index.js`
- Create: `server/test/database/sftpApi.integration.test.js`

### Test First

- [ ] Test session creation delegates to the SFTP service and supports host-key trust responses.
- [ ] Test `list` and `stat` encode/decode normalized POSIX paths correctly.
- [ ] Test download streams bytes from a fake adapter and sends safe download headers.
- [ ] Test response cancellation closes the stream and finalizes transfer status.
- [ ] Test missing/closed sessions and unsafe paths fail with stable errors.
- [ ] Test no upload, mkdir, rename or delete endpoint is exposed by P5.
- [ ] Test remote origin guard applies to all new SFTP routes.

Run the failing API tests:

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 \
  server/test/database/sftpApi.integration.test.js
```

### Implement

- [ ] Construct `activeSftpService` beside the existing terminal and connection-test services.
- [ ] Add `requireSftpService()` behavior aligned with existing service availability errors.
- [ ] Add the five read-only routes documented in the API contract.
- [ ] Stream download output directly and dispose stream/session resources on abort or error.
- [ ] Keep body/error logging free of remote file contents.
- [ ] Ensure shutdown/test teardown closes active SFTP handles.

### Verify And Commit

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 \
  server/test/database/sftpApi.integration.test.js \
  server/test/database/remoteProfilesApi.integration.test.js
git diff --check
git add server/src/index.js server/test/database/sftpApi.integration.test.js
git commit -m "feat: expose read-only sftp http api"
```

## 10. Task 5: Add Typed Frontend Runtime Support

**Files:**

- Modify: `src/services/contracts.ts`
- Modify: `src/services/runtime/types.ts`
- Modify: `src/services/runtime/webRuntime.ts`
- Create or modify relevant runtime tests if present in the repository at implementation time.

### Test First

- [ ] Add runtime tests for creating/closing SFTP sessions.
- [ ] Add runtime tests for encoded list/stat paths.
- [ ] Add runtime tests proving download URL creation cannot inject extra query/header data.

### Implement

- [ ] Define typed session-ready, directory-entry, list and stat response models.
- [ ] Add runtime methods:

```ts
createSftpSession(profileId: string)
listSftpEntries(sessionId: string, path: string)
statSftpEntry(sessionId: string, path: string)
getSftpDownloadUrl(sessionId: string, path: string)
closeSftpSession(sessionId: string)
```

- [ ] Reuse the established host-key trust union response instead of creating parallel trust behavior.
- [ ] Encode URL query components through platform URL APIs.

### Verify And Commit

```bash
PATH="/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH" npm run build
git diff --check
git add src/services/contracts.ts src/services/runtime/types.ts src/services/runtime/webRuntime.ts
git commit -m "feat: add sftp frontend runtime contracts"
```

## 11. Task 6: Build The Read-Only SFTP Workspace UI

**Files:**

- Create: `src/components/Remote/SftpWorkspace.tsx`
- Modify: `src/components/Servers/ServersWorkspace.tsx`
- Modify: `src/index.css`
- Create or modify UI tests following the existing source/test approach used for `TerminalWorkspace`.

### UI Behavior

- [ ] Add `浏览文件` only where the profile has SFTP enabled.
- [ ] Lazy-load `SftpWorkspace` from the server workspace, matching the terminal workspace loading boundary.
- [ ] Open a session, resolve established host-key trust states, and display a read-only browser.
- [ ] Provide current path breadcrumb, `上一级`, `刷新`, directory navigation and `下载` action for files.
- [ ] Show safe progress/state messages: connecting, listing, downloading/triggered, closed, failed.
- [ ] Always expose a visible close action and release the backend session when modal closes.
- [ ] Do not render upload, new directory, rename, delete, chmod or editor interactions.
- [ ] Keep long filenames and wide listings contained within the modal, using the lesson from the terminal width fix.

### Test First

- [ ] Add tests that the entry action is conditioned on SFTP-enabled profiles.
- [ ] Add tests that the workspace includes browsing/download controls.
- [ ] Add tests that forbidden mutation labels/actions are absent.
- [ ] Add tests for long-name containment styling.

### Verify And Commit

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 \
  server/test/database/*.test.js
PATH="/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH" npm run build
git diff --check
git add src/components/Remote/SftpWorkspace.tsx src/components/Servers/ServersWorkspace.tsx \
  src/index.css server/test/database
git commit -m "feat: add read-only sftp file browser"
```

## 12. Task 7: End-To-End Verification And Evidence

**Files:**

- Update: `docs/superpowers/plans/2026-05-27-remote-access-phase-5-read-only-sftp.md`
- Update: the existing remote access research/acceptance document used by prior phases.

### Automated Verification

- [ ] Run the complete backend test suite:

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 \
  server/test/database/*.test.js
```

- [ ] Run package verification:

```bash
PATH="/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH" npm run package:test
```

- [ ] Inspect the generated archive for forbidden runtime/database content:

```bash
zipinfo -1 releases/OpsDog-test-*.zip | \
  rg -n "node_modules|server/data/opsdog|\.db($|-wal$|-shm$)|import-backup|disposable" || true
git diff --check
```

The archive scan passes only when it prints no forbidden matches; `|| true` preserves an empty successful inspection transcript because `rg` reports no match with exit code `1`.

### macOS Real SFTP Acceptance

Use only an approved test server and a benign readable test file. Do not record server credentials, remote file contents or sensitive paths in the plan/evidence document.

- [ ] Establish a new SFTP session from a trusted SSH profile on macOS.
- [ ] Browse a known non-sensitive directory and confirm directory/file entries render.
- [ ] Navigate into and back out of a directory; refresh the listing.
- [ ] Download one benign known test file and verify local received content out of band.
- [ ] Close the workspace and confirm the session is marked closed.
- [ ] Confirm failure/abort behavior records status without saving the file body.
- [ ] Confirm the UI and API offer no upload, create-directory, rename or delete behavior.
- [ ] Confirm audit rows contain metadata only.
- [ ] Confirm remote browser requests with an unapproved `Origin` are rejected.

### Windows Deferred Validation Gate

P5 may be developed and accepted on macOS, but it must not be released as Windows-ready until the following are tested on an actual Windows environment:

- [ ] Credential save/read/delete behavior through the Windows secure credential backend.
- [ ] SSH host trust and SFTP session creation under packaged Windows runtime.
- [ ] Directory names and downloaded filenames containing Chinese characters, spaces and Windows-reserved filename characters.
- [ ] Download destination behavior and browser-triggered save flow on Windows.
- [ ] SFTP session close on modal close, app exit and connection interruption.
- [ ] Packaged artifact sanitation and audit database behavior.

Record the gate as:

```text
NO-GO-RELEASE-WINDOWS until Windows credential, packaging and SFTP acceptance checks pass.
```

### Final Documentation Commit

```bash
git add -f docs/superpowers/plans/2026-05-27-remote-access-phase-5-read-only-sftp.md
git add -f docs/superpowers/research/2026-05-26-remote-access-p0-results.md
git commit -m "docs: record read-only sftp acceptance"
```

## 13. Planned Delivery Sequence

| Order | Deliverable | Risk Reduced |
| --- | --- | --- |
| 1 | Origin policy for remote boundary | Prevent file download exposure through broad browser origins |
| 2 | Narrow read-only SFTP transport | Keeps `ssh2` usage constrained and testable |
| 3 | Session/audit service | Prevents UI/routes from bypassing trust and metadata rules |
| 4 | Streaming API | Delivers file data without storage leakage |
| 5 | Frontend runtime contracts | Preserves typed API boundary |
| 6 | Read-only workspace UI | Enables the operator workflow without mutation capabilities |
| 7 | Automated and real macOS acceptance | Produces release evidence while retaining Windows gate |

## 14. Decision Point After P5

Only after P5 meets every exit criterion and macOS acceptance is documented should P6 be considered. P6 would require a separate approval and plan for mutation operations (`upload`, `mkdir`, `rename`, `delete`), including explicit confirmation UX, authorization policy and stronger audit review. P5 deliberately does not create those capabilities in anticipation.
