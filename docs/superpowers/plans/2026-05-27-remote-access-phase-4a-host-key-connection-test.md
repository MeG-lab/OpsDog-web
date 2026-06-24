# Remote Access Phase 4-A: Host Key Trust and SSH Connection Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human operator probe an SSH server key, explicitly trust a first-seen fingerprint, reject a changed key, and test authenticated SSH/SFTP availability without opening an interactive terminal.

**Architecture:** Use `ssh2` only as the SSH protocol implementation. A transport adapter captures server host keys and performs authenticated capability checks, while a separate SQLite-backed trust service owns trust decisions and safe audit records. A short-lived in-memory challenge store binds the exact probed public key to the user's approval request so the browser cannot invent a trusted key. HTTP routes and a small profile-card UI expose probe/trust/test operations; terminal WebSocket and SFTP file operations remain out of this phase.

**Tech Stack:** Node.js 24 LTS, `ssh2@1.17.0`, existing SQLite adapter/schema, existing OS-vault `SecretStore`, Node `node:crypto`/`node:test`, React/Vite runtime facade.

**Development Gate:** macOS may connect only to an operator-approved test SSH endpoint and may use disposable local profile data. No password, private key, terminal stream, or SSH debug output may enter SQLite, API responses, logs, test output, tracked files, or package artifacts.

**Release Gate:** `NO-GO-RELEASE-WINDOWS` remains active. Windows SSH dependency loading, Credential Manager lifecycle, packaging policy and host-key behavior must be verified before release claims.

---

## Security Contract

1. SSH is implemented by `ssh2`; the application does not implement protocol negotiation, cryptography, authentication packets or SFTP wire behavior.
2. `probe` performs handshake-only key observation without reading credentials or opening shell/SFTP sessions.
3. First-seen keys return `HOST_KEY_CONFIRMATION_REQUIRED` with host, port, key type and SHA-256 fingerprint plus a short-lived opaque approval token.
4. `trust` consumes the token once, persists the exact observed public key and writes an allow-listed `host_key.approved` audit event.
5. If a trusted host/key type presents another fingerprint, `probe` and `test` return `HOST_KEY_MISMATCH`; no credential lookup, authentication or automatic replacement is permitted.
6. `test` reads a password from `SecretStore` only after host-key trust succeeds, verifies the same trusted key again during authenticated connection, checks whether the SSH SFTP subsystem is available, closes immediately and records only safe capability metadata.
7. P4-A exposes no terminal input/output path, no SFTP file operation and no host-key replacement UI.

## Task 1: Add SSH Transport and Host-Key Fingerprint Utilities

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `server/src/remote/sshTransport.js`
- Create: `server/test/database/sshTransport.test.js`

- [x] **Step 1: Write RED utility/transport tests**

Create tests that define the transport boundary:

```js
import { fingerprintHostKey, readHostKeyType } from '../../src/remote/sshTransport.js';

test('host-key utility derives the algorithm and OpenSSH SHA256 fingerprint from an SSH public blob', () => {
  const blob = Buffer.concat([lengthPrefixed('ssh-ed25519'), Buffer.from('disposable-public-key')]);
  assert.equal(readHostKeyType(blob), 'ssh-ed25519');
  assert.match(fingerprintHostKey(blob), /^SHA256:[A-Za-z0-9+/]+$/);
});
```

Also test an injected client factory:

```js
const transport = createSshTransport({ createClient: () => new FakeProbeClient(hostKeyBlob) });
const result = await transport.probeHostKey({ host: '10.0.0.1', port: 22, timeoutMs: 1000 });
assert.deepEqual(result, {
  host: '10.0.0.1',
  port: 22,
  keyType: 'ssh-ed25519',
  fingerprintSha256: fingerprintHostKey(hostKeyBlob),
  publicKeyBase64: hostKeyBlob.toString('base64'),
});
```

- [x] **Step 2: Run RED verification**

Run:

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/sshTransport.test.js
```

Expected: FAIL because `server/src/remote/sshTransport.js` does not exist.

- [x] **Step 3: Add the pinned dependency and minimal transport adapter**

Pin `ssh2@1.17.0` and implement:

```js
export const readHostKeyType = (key) => {
  const algorithmLength = key.readUInt32BE(0);
  if (algorithmLength < 1 || algorithmLength > key.length - 4) {
    throw new Error('Invalid SSH host key blob.');
  }
  return key.subarray(4, 4 + algorithmLength).toString('ascii');
};
export const fingerprintHostKey = (key) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
```

Also export `createSshTransport({ createClient = () => new Client() } = {})`. Its `probeHostKey(profile)` connects with a `hostVerifier` that captures the key and rejects before authentication; it returns the four safe/required observed-key fields shown by the RED test plus `publicKeyBase64` for backend trust persistence. Its `testPasswordConnection(profile, password, trustedKey)` supplies the vault password only to `ssh2`, accepts the host only when its computed fingerprint equals `trustedKey.fingerprintSha256`, requests `sftp()` after `ready`, returns `{ sftpAvailable: true }` after a successful subsystem open, and always calls `end()`/`destroy()` on exit. The adapter must not log profile passwords, raw SSH errors or debug traces.

- [x] **Step 4: Run GREEN verification and commit**

Run the focused test and the full Node 24 database suite, then commit:

```bash
git add package.json package-lock.json server/src/remote/sshTransport.js server/test/database/sshTransport.test.js
git commit -m "feat: add ssh host key transport adapter"
```

## Task 2: Implement Host-Key Trust and One-Time Challenge Services

**Files:**
- Create: `server/src/remote/hostKeyChallengeStore.js`
- Create: `server/src/remote/hostKeyService.js`
- Create: `server/test/database/hostKeyService.test.js`

- [x] **Step 1: Write RED trust-policy tests**

Use the existing SQLite fixture pattern and assert:

```js
const result = service.evaluateObservedKey(profile, observedKey);
assert.equal(result.code, 'HOST_KEY_CONFIRMATION_REQUIRED');
assert.equal(result.fingerprintSha256, observedKey.fingerprintSha256);
assert.equal(JSON.stringify(result).includes(observedKey.publicKeyBase64), false);

const trusted = service.approveFirstSeen(profile, challengeStore.consume(result.challengeToken));
assert.equal(trusted.trustStatus, 'trusted');
assert.equal(database.get('SELECT event_type FROM audit_events').event_type, 'host_key.approved');
```

Additional tests must prove:

1. A trusted identical fingerprint evaluates as `trusted`.
2. A different fingerprint for the same host, port and key type evaluates as `HOST_KEY_MISMATCH` and does not modify the trusted row.
3. Challenge tokens expire and are single-use.
4. Audit/API-safe outputs include fingerprints but not the raw public key.

- [x] **Step 2: Run RED verification**

Run:

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/hostKeyService.test.js
```

Expected: FAIL because the host-key services do not exist.

- [x] **Step 3: Implement minimal services**

Implement:

```js
createHostKeyChallengeStore({ now, createToken, ttlMs })
  .issue({ profileId, observedKey })
  .consume(token, profileId);

createHostKeyService(database, challengeStore, { now, createId })
  .evaluateObservedKey(profile, observedKey);
  .approveFirstSeen(profile, challengeToken);
  .listHostKeys(profileId);
```

Trust is keyed by the profile's `host` and `port` plus server key type. P4-A rejects changed fingerprints and deliberately exposes no replacement method.

- [x] **Step 4: Run GREEN verification and commit**

Run the focused and complete Node 24 database suites, then commit:

```bash
git add server/src/remote/hostKeyChallengeStore.js server/src/remote/hostKeyService.js server/test/database/hostKeyService.test.js
git commit -m "feat: add ssh host key trust policy"
```

## Task 3: Add Connection-Test Orchestration and Safe HTTP API

**Files:**
- Create: `server/src/remote/sshConnectionTestService.js`
- Modify: `server/src/index.js`
- Create: `server/test/database/sshConnectionTestService.test.js`
- Modify: `server/test/database/remoteProfilesApi.integration.test.js`

- [x] **Step 1: Write RED orchestration and HTTP tests**

With injected fake transport and fake vault, assert the orchestration sequence:

```js
const probe = await service.probeHostKey(profileId);
assert.equal(probe.code, 'HOST_KEY_CONFIRMATION_REQUIRED');
assert.equal(vault.getCalls.length, 0);

await service.trustHostKey(profileId, { challengeToken: probe.challengeToken });
const tested = await service.testConnection(profileId);
assert.deepEqual(tested, { status: 'succeeded', authentication: 'password', sftpAvailable: true, hostKey: expectedSafeKey });
```

Add API assertions for:

```text
POST /api/remote/profiles/:profileId/host-key/probe
POST /api/remote/profiles/:profileId/host-key/trust
GET  /api/remote/profiles/:profileId/host-keys
POST /api/remote/profiles/:profileId/test
```

Tests must verify an unknown key returns a challenge without vault reads, a mismatch returns `HOST_KEY_MISMATCH` without vault reads, authenticated success returns no password/raw public key, and all audit detail is secret-free.

- [x] **Step 2: Run RED verification**

Run:

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/sshConnectionTestService.test.js server/test/database/remoteProfilesApi.integration.test.js
```

Expected: FAIL because the orchestrator and routes are absent.

- [x] **Step 3: Implement orchestration and routes**

Create an active service only alongside the active SQLite/profile/SecretStore services:

```js
activeSshConnectionTestService = createSshConnectionTestService(
  initialized.database,
  secretStore,
  createSshTransport(),
  createHostKeyService(initialized.database, createHostKeyChallengeStore()),
);
```

Route operations must only call service methods and map stable codes to safe HTTP errors/responses. No request body, raw key material, password or SSH error object may be logged or returned.

- [x] **Step 4: Run GREEN verification and commit**

Run focused/API/full Node 24 tests and commit:

```bash
git add server/src/remote/sshConnectionTestService.js server/src/index.js server/test/database/sshConnectionTestService.test.js server/test/database/remoteProfilesApi.integration.test.js
git commit -m "feat: expose ssh host key and connection test api"
```

## Task 4: Add Trusted-Handshake UI to Connection Profile Cards

**Files:**
- Modify: `src/services/contracts.ts`
- Modify: `src/services/runtime/types.ts`
- Modify: `src/services/runtime/index.ts`
- Modify: `src/services/runtime/webRuntime.ts`
- Modify: `src/components/Servers/ServersWorkspace.tsx`
- Modify: `src/index.css`

- [x] **Step 1: Add typed API contract and runtime calls**

Define:

```ts
export interface SshHostKeyView {
  host: string;
  port: number;
  keyType: string;
  fingerprintSha256: string;
  trustStatus: 'pending' | 'trusted' | 'mismatch';
  challengeToken?: string;
  previousFingerprintSha256?: string;
}

export interface SshConnectionTestResult {
  status: 'succeeded';
  authentication: 'password';
  sftpAvailable: boolean;
  hostKey: SshHostKeyView;
}
```

Expose runtime methods for probe, trust, history and connection test routes.

- [x] **Step 2: Implement UI trust confirmation and test feedback**

Each existing SSH profile card gains `测试连接`. The UI:

1. Shows first-seen host, port, key type and fingerprint with `确认信任并测试`.
2. Shows success status and SFTP capability after authentication succeeds.
3. Shows mismatch as a blocking warning containing old/new fingerprints, with no accept-replacement action in P4-A.
4. Never stores password or raw public key in component/global state.

- [x] **Step 3: Build and browser-verify on macOS**

Run:

```bash
npm run build
```

Against an approved SSH test endpoint, verify first probe, explicit trust, authenticated test, repeated trusted test, and mismatch simulation through an isolated test fixture. Do not record endpoint credentials, addresses or raw keys in tracked evidence.

- [x] **Step 4: Commit**

```bash
git add src/services/contracts.ts src/services/runtime/types.ts src/services/runtime/index.ts src/services/runtime/webRuntime.ts src/components/Servers/ServersWorkspace.tsx src/index.css
git commit -m "feat: add ssh trusted connection test ui"
```

## Task 5: Verification Evidence and P4-B Boundary

**Files:**
- Modify: `docs/superpowers/research/2026-05-26-remote-access-p0-results.md`
- Modify: this plan checklist

- [x] **Step 1: Run complete verification**

Run:

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/*.test.js
npm run build
npm run package:test
```

- [x] **Step 2: Run safe-content inspection**

Scan tracked diffs, generated ZIP and disposable temporary SQLite state only for disposable marker values created during P4-A. Confirm no password/raw host-key payload is returned from API tests or written to audit detail.

- [x] **Step 3: Record results without sensitive target data**

Document `ssh2` version, macOS first-trust/authentication behavior, mismatch blocking evidence, package limitation and remaining Windows release gate. State explicitly that P4-B terminal WebSocket/xterm and P5 SFTP file operations are not yet delivered.

- [x] **Step 4: Commit evidence**

```bash
git add docs/superpowers/research/2026-05-26-remote-access-p0-results.md docs/superpowers/plans/2026-05-27-remote-access-phase-4a-host-key-connection-test.md
git commit -m "docs: record ssh trust verification"
```
