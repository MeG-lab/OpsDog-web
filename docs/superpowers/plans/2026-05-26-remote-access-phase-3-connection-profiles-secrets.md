# Remote Access Phase 3: Connection Profiles and SecretStore Implementation Plan

> **Execution rule:** Implement in order with failing tests before production changes. This phase creates SSH configuration and secret-storage boundaries only; it does not open SSH sessions or relax the Windows release gate.

**Goal:** Let a device own SSH connection profiles while passwords/passphrases are stored through an OS-vault `SecretStore` and never returned from APIs or written to SQLite, logs, audit detail, browser persistence, or packages.

**Architecture:** Add a `SecretStore` interface with a keyring-backed adapter loaded only at runtime, then add a SQLite connection-profile service using existing `credential_refs`, `connection_profiles`, and `audit_events` tables. The HTTP server exposes profile CRUD only when SQLite is active and fails closed when a system vault is unavailable. The frontend adds a remote-access profile editor only after backend non-leakage tests pass. SSH authentication, host-key probing, terminal, and SFTP stay in later phases.

**Tech Stack:** Node.js 24 LTS, built-in `node:crypto`/`node:test`, SQLite adapter from P1, `@napi-rs/keyring@1.3.0` selected by P0 for system-vault development, React/Vite existing UI.

**Development Gate:** macOS disposable keyring round-trip evidence from P0 permits adapter development. Tests must use an injected fake `SecretStore`, never actual user credentials.

**Release Gate:** `NO-GO-RELEASE-WINDOWS` remains active. The generated ZIP currently omits `node_modules`; Windows keyring loading, Credential Manager lifecycle, and a verified dependency-distribution policy are required before profile credentials may be described as Windows-ready or release-ready.

---

## Security Contract

1. Password and private-key passphrase fields exist only in an incoming request and the `SecretStore.setSecret()` call.
2. SQLite stores only a generated vault locator, label, provider/service metadata, and an irreversible SHA-256 update fingerprint.
3. Profile responses expose booleans such as `hasPasswordCredential`, never secret text, `vault_account`, `secret_fingerprint`, or system-vault data.
4. Audit event summaries/details use allow-listed identifiers and labels only; no request body or thrown vault payload is serialized.
5. First implemented protocol is `ssh`; creation of `telnet` profiles is denied despite the future-compatible schema.
6. `strict_host_key_checking` remains enabled for SSH profiles and is not an ordinary UI toggle.
7. When the vault adapter is unavailable, secret-bearing create/update operations fail without inserting a profile or credential reference.

## Task 1: Add SecretStore Boundary and Non-Leakage Service Tests

**Files:**
- Create: `server/src/remote/secretStore.js`
- Create: `server/src/remote/connectionProfileService.js`
- Create: `server/test/database/connectionProfileService.test.js`

- [x] **Step 1: Write RED tests with an injected fake vault**

Use an imported SQLite fixture device and a fake store that records `setSecret`, `getSecret`, and `deleteSecret` calls in test memory. Assert:

1. Creating an SSH/password profile calls the fake vault with the supplied password.
2. The profile list/create response does not contain password text, vault locator, or fingerprint and reports only credential presence.
3. A recursive string scan over SQLite text columns and audit fields cannot find the supplied secret.
4. A remote synchronized device can own a local connection profile.
5. `telnet`, missing password, invalid port, and vault failure reject creation without profile/ref rows.

- [x] **Step 2: Run RED verification**

Run:

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/connectionProfileService.test.js
```

Expected: FAIL because remote service modules do not exist.

- [x] **Step 3: Implement the boundary and minimum create/list behavior**

`secretStore.js` exports the store contract error type and test-safe constructor utilities. `connectionProfileService.js` exports:

```js
createConnectionProfileService(database, secretStore, { now, createId })
```

with:

```js
listProfiles(deviceId)
createProfile(deviceId, payload)
```

Create behavior must be compensating: write the vault value first, commit references/profile/audit transaction second, and delete the just-created vault value if database insertion fails.

- [x] **Step 4: Run GREEN verification and commit**

Run all database tests under Node 24 and commit the service boundary.

## Task 2: Complete Profile Update/Delete and Audit Behavior

**Files:**
- Modify: `server/src/remote/connectionProfileService.js`
- Modify: `server/test/database/connectionProfileService.test.js`

- [x] **Step 1: Write RED update/delete tests**

Assert:

1. Updating connection display fields does not read or overwrite an existing secret.
2. Providing a replacement password updates the vault and changes only the irreversible fingerprint metadata.
3. Default-profile uniqueness is maintained when a second profile becomes default.
4. Delete soft-deletes the profile, optionally deletes/soft-deletes its credential reference, and records safe audit detail.
5. Delete refuses a profile with an active `remote_sessions` row.

- [x] **Step 2: Implement transactional update/delete behavior**

Keep external vault calls outside database transactions and add compensation where previous secret state is available. Only profile metadata and allow-listed audit detail enter SQL.

- [x] **Step 3: Run GREEN verification and commit**

Run the focused and complete Node 24 database test suite, then commit.

## Task 3: Expose HTTP API with Fail-Closed Runtime Vault Activation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `server/src/remote/secretStore.js`
- Modify: `server/src/index.js`
- Create: `server/test/database/remoteProfilesApi.integration.test.js`

- [x] **Step 1: Write RED API tests**

Start an isolated Node 24 backend. Use dependency injection or an explicit test-only runtime constructor to supply a fake `SecretStore`; do not expose a general environment switch that stores secrets in memory in product runtime. Assert the routes:

```text
GET    /api/remote/devices/:deviceId/profiles
POST   /api/remote/devices/:deviceId/profiles
PATCH  /api/remote/profiles/:profileId
DELETE /api/remote/profiles/:profileId
```

return sanitized responses and never write submitted secrets into the temporary database or JSON source files. Also assert a runtime with unavailable keyring rejects password creation without persistence.

- [x] **Step 2: Implement runtime adapter and routes**

1. Add pinned `@napi-rs/keyring@1.3.0` as the P0-selected backend dependency.
2. Load `Entry` dynamically behind `createKeyringSecretStore()`; if it cannot load or initialize, construct an unavailable store that throws a stable `SECRET_STORE_UNAVAILABLE` error only on secret operations.
3. Activate profile routes only alongside an active SQLite database.
4. Map validation/unavailable/conflict conditions to safe HTTP responses with no request-body logging.

- [x] **Step 3: Record delivery limitation and commit**

The source/development runtime may load the installed keyring package. The generated ZIP must remain marked non-release-ready for remote credential operations until a verified Windows package includes the required platform native dependency.

## Task 4: Add Device Remote-Access Profile UI

**Files:**
- Modify: `src/services/contracts.ts`
- Modify: `src/services/runtime/types.ts`
- Modify: `src/services/runtime/index.ts`
- Modify: `src/services/runtime/webRuntime.ts`
- Modify: `src/components/Servers/ServersWorkspace.tsx`
- Modify: `src/index.css`

- [x] **Step 1: Add typed frontend API contract**

Define sanitized `ConnectionProfile`, create/update requests with write-only password/passphrase input fields, and runtime calls for profile CRUD.

- [x] **Step 2: Implement profile editor within device details**

Add a “远程访问” section for both local and remote assets. It may list, create, edit and delete SSH profiles; it must never persist a submitted secret in Zustand or rehydrate it into a form. Hide terminal/SFTP actions until P4/P5.

- [x] **Step 3: Build and manually verify UI behavior**

Verify profile forms clear secret inputs after submit, remote assets may receive local profiles, and backend unavailable-vault errors are shown without leaking submitted values.

P3 UI follows the currently implemented SSH password-authentication scope; passphrase entry remains hidden until key authentication is implemented and verified.

## Task 5: Security Verification and Evidence

**Files:**
- Modify: `docs/superpowers/research/2026-05-26-remote-access-p0-results.md`
- Modify: this plan checklist

- [x] **Step 1: Run Node 24, build and package checks**

Run:

```bash
npx --yes node@24 --test --test-concurrency=1 server/test/database/*.test.js
npm run package:test
```

- [x] **Step 2: Run non-leakage inspection**

Create only disposable test secrets. Scan the temporary database, API response fixtures, tracked diffs and generated package for those disposable secret markers and assert no match. Never use or scan for a real test-server password in tracked output.

- [x] **Step 3: Record result and retain Windows gate**

Record automated test coverage, macOS development adapter status, dependency packaging limitation, and outstanding Windows Credential Manager/package verification. Do not record secret values or remote target addresses.
