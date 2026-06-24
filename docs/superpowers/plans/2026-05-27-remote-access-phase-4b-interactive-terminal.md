# Remote Access Phase 4-B: Interactive SSH Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a human operator to open a browser-based interactive SSH terminal from a trusted connection profile, exchange PTY input/output, resize and close it safely, and retain metadata-only session audit evidence.

**Architecture:** Continue using `ssh2` as the only SSH protocol implementation. A SQLite-backed terminal service performs a fresh host-key check before it reads a system-vault password, opens a PTY shell through an extended SSH transport adapter, and owns session metadata; a short-lived one-time token authorizes a single WebSocket upgrade without exposing credentials. The React UI lazy-loads `@xterm/xterm` and `@xterm/addon-fit` only when the operator opens a terminal, then exchanges framed terminal messages through `ws`.

**Tech Stack:** Node.js 24 LTS, `ssh2@1.17.0`, `ws@8.21.0`, `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`, existing SQLite adapter/schema, existing OS-vault `SecretStore`, Node `node:test`, React/Vite.

**Design Reference:** `docs/superpowers/specs/2026-05-26-remote-terminal-sftp-design.md` is the approved parent design. P4-A has already delivered SSH profile management, first-seen host-key trust, mismatch blocking, and authenticated connectivity testing.

**Development Gate:** macOS may use only the operator-approved SSH test endpoint and local disposable acceptance state. The terminal is strictly human-operated; it is not callable from Chat, MCP, skills, workflows or automation.

**Release Gate:** `NO-GO-RELEASE-WINDOWS` remains active. Windows Node.js dependency loading, Credential Manager, WebSocket/terminal UI, packaging/launcher and SSH behavior must pass on a Windows host before a Windows-ready statement or release.

---

## Delivered Boundary And P4-B Scope

P4-A already provides:

1. `ssh2` host-key observation and trusted authentication checks.
2. A system-vault-backed password profile with no secret in SQLite or frontend state.
3. `ssh_host_keys`, `remote_sessions` and `audit_events` tables.
4. UI confirmation for first-seen fingerprints and blocking display for mismatches.

P4-B adds only:

1. A PTY shell transport operation based on `ssh2.shell()`.
2. A one-time WebSocket authorization token and server-side active-terminal lifecycle.
3. Browser terminal rendering, input, output, resize and explicit disconnect.
4. Metadata-only terminal session and audit records.

P4-B explicitly excludes SFTP file operations, terminal transcript recording, private-key/agent authentication, host-key replacement, Telnet, AI execution, automation and Windows release completion.

## Security Contract

1. The REST terminal-token operation performs a fresh host-key probe and returns pending/mismatch responses without reading a password or creating a session.
2. A token is opaque, random, bound to one profile, short-lived, consumed exactly once at WebSocket connection time, and held only in transient browser component state.
3. On token consumption the terminal service probes the key again; only a currently trusted result allows password retrieval from `SecretStore`.
4. The authenticated PTY connection independently verifies the trusted fingerprint through the `ssh2` `hostVerifier`; a changed key never reaches a usable shell.
5. Input and output streams are never written to SQLite, audit JSON, application logs, HTTP responses, test snapshots or evidence documents.
6. Stored session/audit fields are allow-listed metadata: profile/device/session ids, trusted host-key id, lifecycle timestamps, terminal dimensions if needed, stable outcome and stable failure code.
7. WebSocket messages are bounded and validated. Input is human keyboard data only; resize accepts finite integer dimensions in configured limits; malformed frames close the channel safely.
8. Closing the UI, WebSocket, SSH stream, backend process or remote peer ends the active session once and records its final metadata outcome.

## Protocol Contract

### REST Token Request

```http
POST /api/remote/profiles/:profileId/terminal-token
Content-Type: application/json

{"cols":120,"rows":32}
```

The response is one of the existing safe host-key responses or:

```json
{
  "status": "ready",
  "token": "short-lived-opaque-token",
  "expiresAt": "2026-05-27T08:00:30.000Z",
  "hostKey": {
    "code": "HOST_KEY_TRUSTED",
    "id": "trusted-key-id",
    "host": "safe-host-label",
    "port": 22,
    "keyType": "ssh-ed25519",
    "fingerprintSha256": "SHA256:safe-fingerprint",
    "trustStatus": "trusted"
  }
}
```

### WebSocket Frames

The UI opens `/api/remote/terminal?token=<encoded-token>` on the same backend origin. JSON messages are:

```ts
type ClientTerminalFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'close' };

type ServerTerminalFrame =
  | { type: 'ready'; sessionId: string }
  | { type: 'output'; data: string }
  | { type: 'closed'; reason: string }
  | { type: 'error'; code: string; message: string };
```

The token must be rejected after its first upgrade attempt, even if SSH authentication later fails. The socket must not echo the password, raw public host key or SSH library error object.

## File Map

| File | Responsibility |
| --- | --- |
| `package.json`, `package-lock.json` | Pin WebSocket and terminal display dependencies |
| `server/src/remote/sshTransport.js` | Add authenticated PTY shell open/write/resize/close adapter method |
| `server/src/remote/terminalTokenStore.js` | Issue/consume short-lived one-use token records in memory |
| `server/src/remote/sshTerminalService.js` | Trusted terminal orchestration, session rows, audit rows and active session cleanup |
| `server/src/remote/terminalWebSocket.js` | Upgrade routing, frame validation and stream-to-socket bridging |
| `server/src/index.js` | Compose active terminal services and expose token route/upgrade handler |
| `server/test/database/sshTransport.test.js` | PTY transport unit tests |
| `server/test/database/terminalTokenStore.test.js` | Expiry and single-use token tests |
| `server/test/database/sshTerminalService.test.js` | Trust, vault, session and non-transcript service tests |
| `server/test/database/terminalWebSocket.test.js` | WebSocket frames, validation, disconnect and token rejection tests |
| `server/test/database/remoteProfilesApi.integration.test.js` | REST token route fails safely before any live terminal |
| `src/services/contracts.ts` | Token and terminal frame TypeScript contracts |
| `src/services/runtime/types.ts`, `src/services/runtime/index.ts`, `src/services/runtime/webRuntime.ts` | Token REST facade and backend WebSocket URL construction |
| `src/components/Remote/TerminalWorkspace.tsx` | Lazy terminal UI lifecycle and xterm/WebSocket binding |
| `src/components/Servers/ServersWorkspace.tsx` | Open-terminal action and modal selection state |
| `src/index.css` | Terminal panel/status styling |
| `vite.config.ts` | WebSocket dev proxy support for `/api` |
| `docs/superpowers/research/2026-05-26-remote-access-p0-results.md` | Safe P4-B macOS evidence and remaining Windows gate |

## Task 1: Add Dependencies And PTY Transport Boundary

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `server/src/remote/sshTransport.js`
- Modify: `server/test/database/sshTransport.test.js`

- [x] **Step 1: Write the failing PTY transport tests**

Extend the fake authenticated `ssh2` client with a fake stream and tests for the desired method:

```js
test('authenticated terminal verifies the trusted key and opens a PTY shell', async () => {
  const client = new FakeShellClient(HOST_KEY);
  const transport = createSshTransport({ createClient: () => client });

  const terminal = await transport.openTerminal(
    PROFILE,
    'disposable-terminal-password',
    { fingerprintSha256: fingerprintHostKey(HOST_KEY) },
    { term: 'xterm-256color', cols: 120, rows: 32 },
  );

  assert.deepEqual(client.shellOptions, { term: 'xterm-256color', cols: 120, rows: 32 });
  terminal.write('printf test\n');
  terminal.resize({ cols: 140, rows: 40 });
  terminal.close();
  assert.deepEqual(client.stream.writes, ['printf test\n']);
  assert.deepEqual(client.stream.windows, [{ rows: 40, cols: 140, height: 0, width: 0 }]);
});

test('authenticated terminal refuses a changed host key before shell creation', async () => {
  const transport = createSshTransport({ createClient: () => new FakeShellClient(CHANGED_HOST_KEY) });
  await assert.rejects(
    transport.openTerminal(PROFILE, 'disposable-terminal-password',
      { fingerprintSha256: fingerprintHostKey(HOST_KEY) }, { cols: 80, rows: 24 }),
    (error) => error.code === 'HOST_KEY_MISMATCH',
  );
});
```

- [x] **Step 2: Run RED verification**

Run:

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/sshTransport.test.js
```

Expected: FAIL because `openTerminal()` does not exist.

- [x] **Step 3: Pin dependencies and implement the minimal PTY adapter**

Install exact production dependencies:

```bash
npm install --save-exact ws@8.21.0 @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0
```

Implement an additional transport method while retaining the existing P4-A methods:

```js
openTerminal: async (profile, password, trustedKey, options) => {
  // Create ssh2 Client; authenticate only with trusted hostVerifier.
  // On "ready", call client.shell({ term, cols, rows }, callback).
  // Resolve an adapter with stream event subscription, write, resize and close.
  // Map pre-ready failures to stable terminal codes; never log raw errors or password.
}
```

The returned adapter must expose only terminal controls and clean disposal:

```js
{
  onData(listener),
  onClose(listener),
  write(data),
  resize({ cols, rows }),
  close()
}
```

- [x] **Step 4: Run GREEN verification and commit**

Run:

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/sshTransport.test.js
```

Commit only task files:

```bash
git add package.json package-lock.json server/src/remote/sshTransport.js server/test/database/sshTransport.test.js
git commit -m "feat: add ssh terminal transport adapter"
```

## Task 2: Implement One-Time Terminal Tokens

**Files:**
- Create: `server/src/remote/terminalTokenStore.js`
- Create: `server/test/database/terminalTokenStore.test.js`

- [x] **Step 1: Write RED token lifecycle tests**

```js
test('terminal token is bound to one profile and consumed once before expiry', () => {
  const store = createTerminalTokenStore({
    now: () => now,
    createToken: () => 'terminal-token-one',
    ttlMs: 30_000,
  });
  const issued = store.issue({ profileId: 'profile-one', cols: 120, rows: 32 });
  assert.equal(issued.token, 'terminal-token-one');
  assert.deepEqual(store.consume(issued.token), {
    profileId: 'profile-one',
    cols: 120,
    rows: 32,
  });
  assert.throws(() => store.consume(issued.token), (error) => error.code === 'TERMINAL_TOKEN_INVALID');
});
```

Add expiry and dimension normalization tests: columns are restricted to `20..500`, rows to `5..200`, and absent values default to `80 x 24`.

- [x] **Step 2: Run RED verification**

Run:

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/terminalTokenStore.test.js
```

Expected: FAIL because the token store module is missing.

- [x] **Step 3: Implement the in-memory token store**

```js
export const createTerminalTokenStore = ({
  now = () => Date.now(),
  createToken = () => randomUUID(),
  ttlMs = 30_000,
} = {}) => ({
  issue({ profileId, cols, rows }) {
    // Store only profile id, normalized dimensions and expiration.
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  },
  consume(token) {
    // Delete before returning; invalid/expired tokens throw TERMINAL_TOKEN_INVALID (401).
  },
});
```

- [x] **Step 4: Run GREEN verification and commit**

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/terminalTokenStore.test.js
git add server/src/remote/terminalTokenStore.js server/test/database/terminalTokenStore.test.js
git commit -m "feat: add one-time terminal tokens"
```

## Task 3: Implement Trusted Terminal Session Orchestration

**Files:**
- Create: `server/src/remote/sshTerminalService.js`
- Create: `server/test/database/sshTerminalService.test.js`

- [x] **Step 1: Write RED orchestration tests with injected transport and vault**

Build fixtures following `sshConnectionTestService.test.js`. Required behavior:

```js
test('token issuance requires a trusted key and never reads the password', async () => {
  const pending = await service.issueTerminalToken(PROFILE_ID, { cols: 100, rows: 30 });
  assert.equal(pending.code, 'HOST_KEY_CONFIRMATION_REQUIRED');
  assert.equal(secretStore.getCalls.length, 0);

  hostKeyService.approveFirstSeen(profile, pending.challengeToken);
  const ready = await service.issueTerminalToken(PROFILE_ID, { cols: 100, rows: 30 });
  assert.equal(ready.status, 'ready');
  assert.equal(secretStore.getCalls.length, 0);
});

test('opening a consumed token records metadata only and closes the session once', async () => {
  const opened = await service.openTerminal('terminal-token-one');
  assert.equal(opened.sessionId, 'session-one');
  opened.write('sensitive-user-input');
  opened.emitOutput('sensitive-remote-output');
  opened.close('operator_closed');

  const stored = database.get('SELECT * FROM remote_sessions WHERE id = ?', 'session-one');
  assert.equal(stored.state, 'closed');
  const databaseText = JSON.stringify(database.all('SELECT * FROM audit_events'));
  assert.equal(databaseText.includes('sensitive-user-input'), false);
  assert.equal(databaseText.includes('sensitive-remote-output'), false);
});
```

Also assert that a changed key observed during WebSocket open consumes the token, rejects before any vault read, creates no active terminal, and records no terminal content.

- [x] **Step 2: Run RED verification**

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/sshTerminalService.test.js
```

Expected: FAIL because `sshTerminalService.js` does not exist.

- [x] **Step 3: Implement the terminal service**

Export:

```js
createSshTerminalService(database, secretStore, transport, hostKeyService, tokenStore, {
  now,
  createId,
})
  .issueTerminalToken(profileId, { cols, rows })
  .openTerminal(token)
  .write(sessionId, data)
  .resize(sessionId, { cols, rows })
  .close(sessionId, reason)
  .closeAll(reason)
```

Implementation rules:

1. Resolve enabled SSH password profiles with the same validation as the connection-test service.
2. `issueTerminalToken()` performs `probeHostKey()` and `evaluateObservedKey()` and returns pending/mismatch without reading the vault; a trusted result issues a token.
3. `openTerminal()` consumes the token, probes/evaluates the host key again, reads the password only after `HOST_KEY_TRUSTED`, calls `transport.openTerminal()`, inserts one `remote_sessions` row with `session_kind='terminal'`, `protocol='ssh'`, `actor_type='human'` and `transcript_policy='metadata_only'`, then writes `terminal.session.opened`.
4. The in-memory active map holds only the live terminal adapter and identifiers; terminal bytes never enter stored details.
5. Failure/close paths update the session at most once and emit allow-listed `terminal.session.failed` or `terminal.session.closed` audit detail.

- [x] **Step 4: Run GREEN verification and commit**

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/sshTerminalService.test.js
git add server/src/remote/sshTerminalService.js server/test/database/sshTerminalService.test.js
git commit -m "feat: orchestrate trusted ssh terminal sessions"
```

## Task 4: Add Terminal REST And WebSocket Server Surface

**Files:**
- Create: `server/src/remote/terminalWebSocket.js`
- Create: `server/test/database/terminalWebSocket.test.js`
- Modify: `server/src/index.js`
- Modify: `server/test/database/remoteProfilesApi.integration.test.js`

- [x] **Step 1: Write RED WebSocket gateway and REST route tests**

Use a loopback HTTP server with `ws` client for the gateway test and an injected fake terminal service:

```js
test('websocket accepts one token and forwards validated terminal frames', async () => {
  const socket = await connect(`/api/remote/terminal?token=one-use-token`);
  assert.deepEqual(await nextFrame(socket), { type: 'ready', sessionId: 'session-one' });
  socket.send(JSON.stringify({ type: 'input', data: 'whoami\n' }));
  socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 32 }));
  assert.deepEqual(service.writes, [{ sessionId: 'session-one', data: 'whoami\n' }]);
  assert.deepEqual(service.resizes, [{ sessionId: 'session-one', cols: 120, rows: 32 }]);
});
```

Assert malformed JSON, oversized input, invalid dimensions and absent/expired token produce safe `error`/closure behavior. Extend REST integration tests so an untrusted/unreachable profile cannot produce a token and never exposes credentials.

- [x] **Step 2: Run RED verification**

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/terminalWebSocket.test.js server/test/database/remoteProfilesApi.integration.test.js
```

Expected: FAIL because the gateway and `/terminal-token` route are absent.

- [x] **Step 3: Implement REST composition and the gateway**

Create a `WebSocketServer({ noServer: true })` gateway attached to the existing HTTP server's `upgrade` event. It accepts only:

```text
GET /api/remote/terminal?token=<one-time-token>
```

Safe gateway behavior:

```js
socket.send(JSON.stringify({ type: 'ready', sessionId }));
terminal.onData((data) => socket.send(JSON.stringify({ type: 'output', data })));
// input -> service.write(), resize -> service.resize(), close/socket close -> service.close()
```

Add:

```http
POST /api/remote/profiles/:profileId/terminal-token
```

Create one shared `hostKeyService` and `sshTransport` during SQLite activation so connection tests and terminal sessions use the same trust policy. If SQLite/SecretStore activation fails, both terminal REST and WebSocket operations fail closed.

- [x] **Step 4: Run GREEN verification and commit**

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/terminalWebSocket.test.js server/test/database/remoteProfilesApi.integration.test.js
git add server/src/remote/terminalWebSocket.js server/test/database/terminalWebSocket.test.js server/src/index.js server/test/database/remoteProfilesApi.integration.test.js
git commit -m "feat: expose ssh terminal websocket gateway"
```

## Task 5: Add Typed Runtime And Lazy Xterm Workspace

**Files:**
- Modify: `src/services/contracts.ts`
- Modify: `src/services/runtime/types.ts`
- Modify: `src/services/runtime/index.ts`
- Modify: `src/services/runtime/webRuntime.ts`
- Create: `src/components/Remote/TerminalWorkspace.tsx`
- Modify: `src/components/Servers/ServersWorkspace.tsx`
- Modify: `src/index.css`
- Modify: `vite.config.ts`

- [x] **Step 1: Define safe frontend contracts and REST/WebSocket runtime methods**

Add:

```ts
export interface SshTerminalTokenReady {
  status: 'ready';
  token: string;
  expiresAt: string;
  hostKey: SshHostKeyView;
}
export type SshTerminalTokenResponse = SshHostKeyView | SshTerminalTokenReady;
export type SshTerminalClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'close' };
export type SshTerminalServerFrame =
  | { type: 'ready'; sessionId: string }
  | { type: 'output'; data: string }
  | { type: 'closed'; reason: string }
  | { type: 'error'; code: string; message: string };
```

Expose:

```ts
createSshTerminalToken(profileId: string, dimensions: { cols: number; rows: number }): Promise<SshTerminalTokenResponse>;
createSshTerminalSocket(token: string): WebSocket;
```

`webRuntime` constructs the `ws:`/`wss:` backend URL from its existing API base and includes only the encoded one-time token.

- [x] **Step 2: Add a lazily loaded terminal workspace**

`ServersWorkspace.tsx` must not import terminal bundles at page load. Use:

```tsx
const TerminalWorkspace = React.lazy(() => import('../Remote/TerminalWorkspace'));
```

`TerminalWorkspace.tsx` imports `@xterm/xterm`, its CSS, and `@xterm/addon-fit`; it:

1. Constructs one `Terminal` and one `FitAddon` while mounted.
2. Fits once on connect and on a `ResizeObserver`, sending bounded resize frames.
3. Sends xterm keyboard data as `{ type: 'input', data }`.
4. Writes only incoming `{ type: 'output' }` bytes to xterm.
5. Shows connection/closed/error status outside the terminal.
6. Closes the socket and disposes terminal/addon/listeners on unmount.

Add an `打开终端` profile-card action. It requests a terminal token; pending/mismatch results reuse the existing safe fingerprint warning; a ready token opens a modal containing the lazy workspace. Do not place the token, terminal content or socket in Zustand/local storage.

- [x] **Step 3: Enable development WebSocket proxy and build**

Set `ws: true` on the Vite `/api` proxy target and run:

```bash
npm run build
```

Expected: TypeScript/Vite build succeeds and terminal bundles are emitted as lazy chunks rather than being executed until the terminal modal opens.

- [x] **Step 4: Commit**

```bash
git add src/services/contracts.ts src/services/runtime/types.ts src/services/runtime/index.ts src/services/runtime/webRuntime.ts src/components/Remote/TerminalWorkspace.tsx src/components/Servers/ServersWorkspace.tsx src/index.css vite.config.ts
git commit -m "feat: add interactive ssh terminal ui"
```

## Task 6: Complete Automated Verification And MacOS Acceptance

**Files:**
- Modify: `docs/superpowers/research/2026-05-26-remote-access-p0-results.md`
- Modify: this plan checklist

- [x] **Step 1: Run complete automated verification**

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/*.test.js
npm run build
npm run package:test
git diff --check
```

Expected: all tests and builds pass. The generated ZIP remains a sanitation test artifact and is not called a Windows remote-access release while its dependency-distribution policy remains unverified.

- [x] **Step 2: Inspect automated stored/test/package material for terminal leakage**

Use disposable marker strings only in automated fixtures and inspect the generated package plus automated isolated database assertions. When Step 3 becomes possible, additionally inspect its isolated acceptance database before marking real-terminal acceptance complete. Required result for this automated checkpoint:

1. No submitted password appears in SQLite, HTTP/WebSocket payload snapshots, audit detail or package files.
2. No terminal input/output marker appears in `remote_sessions`, `audit_events` or `terminal_transcript_chunks`.
3. `terminal_transcript_chunks` remains empty because P4-B is metadata-only.

- [x] **Step 3: Run Browser-based macOS acceptance against the approved SSH endpoint**

> Completed on 2026-05-27 after an approved configured SSH target became available. Acceptance first exposed and then verified fixes for React development lifecycle reuse of a one-time token and unbounded client resize frames. The existing operator-configured profile was retained rather than deleted; storage inspection confirmed that benign terminal acceptance markers were not persisted.

Start an isolated backend/Vite instance with an isolated SQLite database and system-vault entry, unless the operator explicitly requests validation of an existing configured profile. In the latter case, retain the approved profile and perform the same post-acceptance metadata/content inspection without recording target details. In the UI:

1. Open the SSH profile and confirm any required first-seen fingerprint.
2. Open the terminal and verify the terminal reaches connected state.
3. Type a benign marker command, observe its terminal-only output, and do not include its content in tracked evidence.
4. Resize the terminal panel/window and verify a subsequent shell interaction remains properly rendered.
5. Disconnect, reconnect once, and close the modal; verify sessions end without storing terminal content.
6. Delete the disposable profile/vault record after acceptance, or retain an operator-approved existing profile when it was the requested validation target.

- [x] **Step 4: Record safe evidence and preserve the Windows gate**

Append only pass/fail outcomes, dependency versions, session/audit non-transcript findings and packaging limitation to the research note. Do not record password, endpoint address, terminal command/output, raw key or fingerprint.

```text
GO-DEV: P4-B interactive SSH terminal behavior is verified on macOS under Node.js 24 LTS; P5 read-only SFTP development may proceed without claiming Windows release readiness.
NO-GO-RELEASE-WINDOWS: Windows remote-access release remains blocked until Windows runtime, SQLite/filesystem, Credential Manager, packaging/launcher, SSH terminal/SFTP, and host-key validation results are recorded as passing.
```

- [x] **Step 5: Commit evidence**

```bash
git add docs/superpowers/research/2026-05-26-remote-access-p0-results.md docs/superpowers/plans/2026-05-27-remote-access-phase-4b-interactive-terminal.md
git commit -m "docs: record interactive ssh terminal verification"
```

## Review Checkpoints

After Tasks 1-2: confirm dependency selection, PTY adapter disposal and token single-use behavior before adding a live WebSocket surface.

After Tasks 3-4: confirm vault access happens only after trusted probes, frames are bounded, and no transcript reaches stored/audit data.

After Tasks 5-6: confirm terminal interaction and cleanup in the real macOS UI, then proceed only to P5 read-only SFTP planning; Telnet and Windows release remain deferred.
