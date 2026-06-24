# Remote Access Phase 7 TELNET Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, human-operated TELNET connection testing and interactive terminal support without weakening existing SSH/SFTP security boundaries.

**Architecture:** Keep SSH/SFTP services unchanged and add TELNET behind a narrow terminal adapter. A protocol-aware remote terminal facade dispatches one-time terminal tokens to the existing SSH terminal service or a new TELNET terminal service, while the existing WebSocket frame contract and xterm UI stay stable. TELNET profiles are explicit legacy/plaintext profiles with SFTP and host-key trust forced off.

**Tech Stack:** Node.js 24 LTS, React + TypeScript + Vite, SQLite metadata audit, existing OS-vault `SecretStore`, existing `ws` and xterm terminal UI, `telnetlib@1.0.2` for TELNET option negotiation, Node `node:test`.

**Design Reference:** `docs/superpowers/specs/2026-06-02-remote-access-telnet-design.md`.

**Component Decision:** Use `telnetlib@1.0.2` because it is MIT-licensed and exposes RFC1143 negotiation plus NAWS resize support. Do not use `telnet-client` in P7 because its npm metadata and repository README/LICENSE disagree.

---

## File Map

| File | Responsibility |
| --- | --- |
| `package.json`, `package-lock.json` | Pin `telnetlib@1.0.2`. |
| `server/src/remote/telnetTransport.js` | Wrap `telnetlib` and expose only `{ onData, onClose, write, resize, close }`. |
| `server/src/remote/telnetConnectionTestService.js` | Validate TELNET profiles, read credentials only after profile checks, connect/login, audit metadata only. |
| `server/src/remote/telnetTerminalService.js` | Consume terminal tokens, open TELNET sessions, write session/audit rows, manage active sessions. |
| `server/src/remote/remoteTerminalService.js` | Protocol-aware facade for token issuance/open/write/resize/close/closeAll. |
| `server/src/remote/terminalWebSocket.js` | Keep route/frame validation and add TELNET stable open error codes. |
| `server/src/remote/connectionProfileService.js` | Allow TELNET profile create/update with plaintext acknowledgement, forced no-SFTP, no host key. |
| `server/src/index.js` | Wire TELNET transport/services/facade and add protocol-aware connection test route. |
| `src/services/contracts.ts` | Add `telnet` protocol and protocol-aware connection test / terminal token contract aliases. |
| `src/services/runtime/types.ts`, `src/services/runtime/index.ts`, `src/services/runtime/webRuntime.ts` | Add protocol-aware `testRemoteConnection`, `createRemoteTerminalToken`, `createRemoteTerminalSocket`. |
| `src/components/Remote/TerminalWorkspace.tsx` | Accept protocol/footer note and use protocol-aware socket factory. |
| `src/components/Servers/ServersWorkspace.tsx` | Add protocol selector, TELNET warning, TELNET profile card behavior, hide SFTP/host-key UI for TELNET. |
| `src/index.css` | Style compact TELNET warning/badge if existing classes are insufficient. |

## Task 1: Pin And Verify TELNET Component

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] **Step 1: Verify package metadata before installing**

Run:

```bash
npm view telnetlib@1.0.2 version license repository.url
```

Expected:

```text
version = '1.0.2'
license = 'MIT'
repository.url = 'git+https://github.com/cadpnq/telnetlib.git'
```

- [x] **Step 2: Install the pinned dependency**

Run:

```bash
npm install --save-exact telnetlib@1.0.2
```

Expected: `package.json` contains `"telnetlib": "1.0.2"` and `package-lock.json` records the package.

- [x] **Step 3: Verify Node 24 ESM import behavior**

Run:

```bash
node -e "import('telnetlib').then((m)=>{ if (!m.default?.createConnection) throw new Error('missing createConnection'); console.log('telnetlib import ok') })"
```

Expected:

```text
telnetlib import ok
```

- [x] **Step 4: Commit dependency gate**

```bash
git add package.json package-lock.json
git commit -m "chore: pin telnet protocol library"
```

## Task 2: Allow Explicit TELNET Profiles

**Files:**
- Modify: `server/src/remote/connectionProfileService.js`
- Modify: `server/test/database/connectionProfileService.test.js`
- Modify: `src/services/contracts.ts`

- [x] **Step 1: Write failing profile service tests**

Add tests proving:

```js
const created = await service.createProfile('local:one', profilePayload({
  name: 'Legacy TELNET',
  protocol: 'telnet',
  port: 23,
  username: 'operator',
  sftpEnabled: true,
  plaintextAcknowledged: true,
}));
assert.equal(created.protocol, 'telnet');
assert.equal(created.strictHostKeyChecking, false);
assert.equal(created.sftpEnabled, false);
assert.equal(created.port, 23);
assert.equal(vault.setCalls[0].secret, SECRET_MARKER);

await assert.rejects(
  service.createProfile('local:one', profilePayload({ protocol: 'telnet', plaintextAcknowledged: false })),
  /明文/,
);
```

Also update the existing invalid-profile test so TELNET is no longer rejected merely for being TELNET.

- [x] **Step 2: Run RED verification**

```bash
node --test --test-concurrency=1 server/test/database/connectionProfileService.test.js
```

Expected: FAIL because TELNET profiles are still rejected.

- [x] **Step 3: Implement TELNET validation**

Implement protocol helpers:

```js
const normalizeProtocol = (value) => {
  const protocol = String(value || 'ssh').toLowerCase();
  if (protocol !== 'ssh' && protocol !== 'telnet') throw buildValidationError('远程协议必须是 SSH 或 TELNET。');
  return protocol;
};
const protocolLabel = (protocol) => protocol === 'telnet' ? 'TELNET' : 'SSH';
```

Rules:
- SSH remains default, requires password auth and username as before.
- TELNET requires `plaintextAcknowledged === true` on create.
- TELNET supports `authMethod = 'password'` first; keep `none` out unless a later task adds tests.
- TELNET password auth still requires a password and vault credential.
- TELNET inserts `protocol = 'telnet'`, `strict_host_key_checking = 0`, `sftp_enabled = 0`, default port 23.
- Update summaries to say `TELNET profile ...` for TELNET and preserve `SSH profile ...` for SSH.

Update contracts:

```ts
export type RemoteConnectionProtocol = 'ssh' | 'telnet';
export interface ConnectionProfile { protocol: RemoteConnectionProtocol; ... }
export interface ConnectionProfileCreateRequest { protocol: RemoteConnectionProtocol; plaintextAcknowledged?: boolean; ... }
```

- [x] **Step 4: Run GREEN verification and commit**

```bash
node --test --test-concurrency=1 server/test/database/connectionProfileService.test.js
git diff --check
git add server/src/remote/connectionProfileService.js server/test/database/connectionProfileService.test.js src/services/contracts.ts
git commit -m "feat: allow explicit telnet profiles"
```

## Task 3: Add TELNET Transport Adapter

**Files:**
- Create: `server/src/remote/telnetTransport.js`
- Create: `server/test/database/telnetTransport.test.js`

- [x] **Step 1: Write failing transport tests**

Use an injected fake `createConnection` for unit coverage and a local `net` server for prompt-flow behavior. Required assertions:

```js
const terminal = await transport.openTerminal(PROFILE, {
  password: PASSWORD_MARKER,
  cols: 100,
  rows: 30,
});
assert.deepEqual(Object.keys(terminal).sort(), ['close', 'onClose', 'onData', 'resize', 'write']);
terminal.write('show version\r\n');
terminal.resize({ cols: 120, rows: 40 });
terminal.close();
```

Tests must prove:
- password login writes username/password only to the socket, not to any returned adapter property;
- `onData` receives post-login output;
- `resize` calls NAWS `sendResize` when available;
- connection timeout maps to `TELNET_CONNECTION_FAILED`;
- login timeout maps to `TELNET_LOGIN_FAILED`;
- close/error callbacks fire once.

- [x] **Step 2: Run RED verification**

```bash
node --test --test-concurrency=1 server/test/database/telnetTransport.test.js
```

Expected: FAIL because `telnetTransport.js` does not exist.

- [x] **Step 3: Implement minimal transport**

Implement:

```js
export const createTelnetTransport = ({
  createConnection = defaultCreateConnection,
  now = () => Date.now(),
} = {}) => ({
  async testConnection(profile, credentials) { ... },
  async openTerminal(profile, credentials, dimensions) { ... },
});
```

Behavior:
- Dynamically import `telnetlib`, then call `telnetlib.createConnection`.
- Use `localOptions: [telnetlib.options.NAWS, telnetlib.options.SGA]` and `remoteOptions: [telnetlib.options.SGA]`.
- Wait for socket connect and negotiated events with `connectTimeoutMs`.
- For password auth, wait for `/login[: ]*$/i`, write `${username}\r\n`, wait for `/password[: ]*$/i`, write `${password}\r\n`, then mark ready when the next prompt/output chunk arrives.
- For interactive mode, forward all post-login data through `onData` without buffering transcripts.
- `resize` gets `socket.getOption(telnetlib.options.NAWS)?.sendResize(cols, rows)` if present.
- `close` uses `end()` and then `destroy()` if needed.
- Never expose raw socket, library instance, password, accumulated output or remote error text.

- [x] **Step 4: Run GREEN verification and commit**

```bash
node --test --test-concurrency=1 server/test/database/telnetTransport.test.js
git diff --check
git add server/src/remote/telnetTransport.js server/test/database/telnetTransport.test.js
git commit -m "feat: add telnet terminal transport"
```

## Task 4: Add TELNET Connection Test Service And API Route

**Files:**
- Create: `server/src/remote/telnetConnectionTestService.js`
- Create: `server/test/database/telnetConnectionTestService.test.js`
- Modify: `server/src/index.js`
- Modify: `server/test/database/remoteProfilesApi.integration.test.js`
- Modify: `src/services/contracts.ts`
- Modify: `src/services/runtime/types.ts`
- Modify: `src/services/runtime/index.ts`
- Modify: `src/services/runtime/webRuntime.ts`

- [x] **Step 1: Write failing service tests**

Tests must cover:

```js
const result = await service.testConnection(TELNET_PROFILE_ID);
assert.deepEqual(result, {
  status: 'connected',
  protocol: 'telnet',
  profileId: TELNET_PROFILE_ID,
  host: 'host.test',
  port: 23,
  authenticated: true,
  sftpAvailable: false,
  checkedAt: FIXED_NOW,
});
```

Also assert disabled profile -> `TELNET_CONNECTION_DISABLED`, missing vault secret -> `TELNET_CREDENTIAL_UNAVAILABLE`, SSH profile -> `TELNET_UNSUPPORTED`, failed transport -> stable error code, and audit rows contain no password/input/output marker.

- [x] **Step 2: Write failing API/runtime tests**

Extend API integration or source tests so:
- `POST /api/remote/profiles/:id/test-connection` dispatches TELNET profiles to TELNET and SSH profiles to existing SSH test behavior;
- old `POST /api/remote/profiles/:id/test` remains for SSH compatibility;
- frontend runtime exposes `testRemoteConnection(profileId)`;
- contracts include `TelnetConnectionTestResult`.

- [x] **Step 3: Run RED verification**

```bash
node --test --test-concurrency=1 server/test/database/telnetConnectionTestService.test.js server/test/database/remoteProfilesApi.integration.test.js
```

Expected: FAIL because the TELNET service/route does not exist.

- [x] **Step 4: Implement service and route**

Service rules:
- Query `connection_profiles` joined to non-deleted password credential.
- Require `protocol = 'telnet'`, `auth_method = 'password'`, profile enabled.
- Read password only after profile validation.
- Call `transport.testConnection(profile, { password })`.
- Insert `telnet.connection.tested` audit row with metadata only.
- Return `status: 'connected'`, `protocol: 'telnet'`, `authenticated: true`, `sftpAvailable: false`, `checkedAt`.

Route rules:
- Add `POST /api/remote/profiles/:profileId/test-connection`.
- If profile is SSH, call existing SSH test service.
- If profile is TELNET, call TELNET test service.
- Keep old `/test` route unchanged except optional delegation to the same SSH branch.

Runtime rules:
- Add `testRemoteConnection`.
- Keep `testSshConnection` as a compatibility wrapper.

- [x] **Step 5: Run GREEN verification and commit**

```bash
node --test --test-concurrency=1 server/test/database/telnetConnectionTestService.test.js server/test/database/remoteProfilesApi.integration.test.js
git diff --check
git add server/src/remote/telnetConnectionTestService.js server/src/index.js \
  server/test/database/telnetConnectionTestService.test.js server/test/database/remoteProfilesApi.integration.test.js \
  src/services/contracts.ts src/services/runtime/types.ts src/services/runtime/index.ts src/services/runtime/webRuntime.ts
git commit -m "feat: add telnet connection testing"
```

## Task 5: Add Protocol-Aware Terminal Facade And TELNET Sessions

**Files:**
- Create: `server/src/remote/telnetTerminalService.js`
- Create: `server/src/remote/remoteTerminalService.js`
- Create: `server/test/database/telnetTerminalService.test.js`
- Modify: `server/src/remote/terminalWebSocket.js`
- Modify: `server/test/database/terminalWebSocket.test.js`
- Modify: `server/src/index.js`
- Modify: `src/services/contracts.ts`
- Modify: `src/services/runtime/types.ts`
- Modify: `src/services/runtime/index.ts`
- Modify: `src/services/runtime/webRuntime.ts`

- [x] **Step 1: Write failing TELNET terminal service tests**

Tests must prove:
- `issueTerminalToken` for TELNET profile returns `{ status: 'ready', token, expiresAt, protocol: 'telnet', plaintext: true }` without reading password.
- `openTerminal(token)` consumes token once, reads vault password once, inserts `remote_sessions` with `protocol = 'telnet'`, `host_key_id IS NULL`, `transcript_policy = 'metadata_only'`.
- `write`, `resize`, `close`, remote close and `closeAll` finish exactly once with safe reasons.
- open failure stores only stable `TELNET_*` error code and no secret/input/output.
- SSH terminal tests still pass through the new facade.

- [x] **Step 2: Write failing WebSocket safe-code test**

Extend `terminalWebSocket.test.js` fake service to throw `TELNET_LOGIN_FAILED`; assert the socket sends:

```json
{"type":"error","code":"TELNET_LOGIN_FAILED","message":"Unable to open the terminal connection."}
```

- [x] **Step 3: Run RED verification**

```bash
node --test --test-concurrency=1 server/test/database/telnetTerminalService.test.js server/test/database/terminalWebSocket.test.js
```

Expected: FAIL because TELNET terminal service/facade does not exist and the WebSocket safe-list lacks TELNET codes.

- [x] **Step 4: Implement TELNET terminal service**

Mirror `sshTerminalService` with TELNET-specific rules:
- require TELNET password profile and enabled state;
- no host-key probe or host-key id;
- use shared `terminalTokenStore`;
- session insert uses `protocol = 'telnet'`;
- audit event names are `telnet.session.opened`, `telnet.session.closed`, `telnet.session.failed`;
- active session map stores only profile and terminal adapter;
- no transcript storage.

- [x] **Step 5: Implement protocol-aware facade**

`remoteTerminalService` should expose:

```js
issueTerminalToken(profileId, dimensions)
openTerminal(token)
write(sessionId, data)
resize(sessionId, dimensions)
close(sessionId, reason)
closeAll(reason)
```

Token issuance should inspect profile protocol and call SSH or TELNET service. Open/write/resize/close should delegate by the session id returned from the protocol service.

- [x] **Step 6: Wire WebSocket and runtime**

Rules:
- `createTerminalWebSocket` receives `remoteTerminalService`, not `sshTerminalService`.
- Add TELNET safe error codes.
- Add protocol-aware runtime `createRemoteTerminalToken` and `createRemoteTerminalSocket`.
- Keep old `createSshTerminalToken` and `createSshTerminalSocket` as wrappers for compatibility.

- [x] **Step 7: Run GREEN verification and commit**

```bash
node --test --test-concurrency=1 server/test/database/telnetTerminalService.test.js server/test/database/terminalWebSocket.test.js server/test/database/sshTerminalService.test.js
git diff --check
git add server/src/remote/telnetTerminalService.js server/src/remote/remoteTerminalService.js \
  server/src/remote/terminalWebSocket.js server/src/index.js \
  server/test/database/telnetTerminalService.test.js server/test/database/terminalWebSocket.test.js \
  src/services/contracts.ts src/services/runtime/types.ts src/services/runtime/index.ts src/services/runtime/webRuntime.ts
git commit -m "feat: add telnet interactive terminal sessions"
```

## Task 6: Add TELNET UI And Source-Level Regression Tests

**Files:**
- Modify: `src/components/Servers/ServersWorkspace.tsx`
- Modify: `src/components/Remote/TerminalWorkspace.tsx`
- Modify: `src/index.css`
- Create: `server/test/database/remoteTerminalUiSource.test.js`
- Modify: `server/test/database/terminalConnectionLifecycle.test.js`

- [x] **Step 1: Write failing UI source tests**

Add source-level tests asserting:

```js
assert.match(serversWorkspace, /TELNET 是明文协议/);
assert.match(serversWorkspace, /protocol.*telnet/s);
assert.match(serversWorkspace, /createRemoteTerminalToken/);
assert.doesNotMatch(serversWorkspace, /profile\\.protocol === 'telnet'[\\s\\S]*openSftp/);
assert.match(terminalWorkspace, /plaintext/);
```

Also assert `TerminalWorkspace` accepts a protocol/plaintext prop and still uses the frame helpers.

- [x] **Step 2: Run RED verification**

```bash
node --test --test-concurrency=1 server/test/database/remoteTerminalUiSource.test.js server/test/database/terminalConnectionLifecycle.test.js
```

Expected: FAIL because UI still only names SSH.

- [x] **Step 3: Implement UI changes**

Rules:
- Add `protocol: 'ssh' | 'telnet'` to `RemoteProfileDraft`.
- Default create form stays SSH, port 22, SFTP enabled.
- When protocol changes to TELNET: port defaults to 23 if current value is 22, SFTP forced false, plaintext acknowledgement reset/required.
- Add protocol selector with TELNET warning copy exactly:

```text
TELNET 是明文协议。用户名、密码和终端内容可能被同网段监听。
仅在受控内网、隔离网络或历史设备兼容场景下使用。
```

- Hide SFTP checkbox and SFTP button for TELNET.
- Hide SSH host-key pending/mismatch UI for TELNET.
- Card shows protocol badge and plaintext warning for TELNET.
- Use `testRemoteConnection` and `createRemoteTerminalToken`.
- `TerminalWorkspace` footer says TELNET is plaintext when protocol is TELNET.

- [x] **Step 4: Run GREEN verification and commit**

```bash
node --test --test-concurrency=1 server/test/database/remoteTerminalUiSource.test.js server/test/database/terminalConnectionLifecycle.test.js
npm run build
git diff --check
git add src/components/Servers/ServersWorkspace.tsx src/components/Remote/TerminalWorkspace.tsx src/index.css \
  server/test/database/remoteTerminalUiSource.test.js server/test/database/terminalConnectionLifecycle.test.js
git commit -m "feat: expose opt-in telnet terminal UI"
```

## Task 7: Full Regression Verification And Acceptance Notes

**Files:**
- Modify: `docs/superpowers/research/2026-05-26-remote-access-p0-results.md`

- [x] **Step 1: Run full database/source test suite**

```bash
npm run test:database
```

Expected: all tests pass, including SSH/SFTP regressions.

- [x] **Step 2: Run build**

```bash
npm run build
```

Expected: TypeScript and Vite build succeed.

- [x] **Step 3: Record macOS acceptance status**

Append a concise P7 section documenting:
- `telnetlib@1.0.2` MIT component decision;
- automated test/build results;
- Windows remains `NO-GO-RELEASE-WINDOWS`;
- manual real-device TELNET acceptance is still pending unless it has been performed.

- [x] **Step 4: Commit notes**

```bash
git add docs/superpowers/research/2026-05-26-remote-access-p0-results.md
git commit -m "docs: record telnet terminal acceptance gate"
```

## Self-Review

- Spec coverage: P7-A through P7-D are covered; P7-E remains a Windows gate, not implementation work in this macOS session.
- Placeholder scan: no `TBD`, `TODO`, or unbounded "add tests" steps remain.
- Type consistency: protocol-aware names are `testRemoteConnection`, `createRemoteTerminalToken`, `createRemoteTerminalSocket`; SSH compatibility wrappers remain.
- Risk boundary: TELNET has no SFTP, no host-key UI, no transcript storage, no automation path, and no Windows-ready claim.
