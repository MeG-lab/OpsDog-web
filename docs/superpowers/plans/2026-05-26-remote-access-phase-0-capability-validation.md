# Remote Access Phase 0 Capability Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the runtime, dependency, credential-vault, SSH/SFTP, terminal, and delivery assumptions required before OpsDog persists remote-access data or exposes remote UI.

**Architecture:** Phase 0 is intentionally isolated from product behavior. It runs reproducible probes in `/private/tmp/opsdog-remote-p0`, records evidence in a committed research note, and allows production database work only after the delivery and Windows-runtime gates have an explicit outcome. The currently shipped asset APIs and frontend are not changed in this phase.

**Tech Stack:** Node.js ESM, Node test runner, SQLite (`node:sqlite` and `better-sqlite3` comparison), `ssh2`, `ws`, `@xterm/xterm`, `@xterm/addon-fit`, `@napi-rs/keyring`, existing Vite build and ZIP test-bundle tooling.

---

## Why This Is a Separate Phase

The approved design spans data storage, remote protocol sessions, browser terminal transport, and file transfer. These subsystems should not be committed together without proving that the current local-first distribution can carry their dependencies.

The repository inspection on 2026-05-26 found two constraints that make this gate necessary:

- `scripts/package-test-bundle.mjs` deletes bundled `node_modules`; today that works because the backend relies on Node built-ins, but it will not launch once `ssh2`, `ws`, or a keyring/native SQLite binding becomes a runtime dependency.
- The package README currently promises Node.js 18+, while npm metadata for `better-sqlite3@12.10.0` declares Node `20.x || 22.x || 23.x || 24.x || 25.x || 26.x`, and the current local Node `v23.11.0` loads `node:sqlite` with an experimental-feature warning.

Phase 0 therefore produces a written runtime/dependency decision instead of making an implicit platform break.

## Approved Gate Amendment: 2026-05-26

After the SSH/SFTP target probe passed, the user confirmed that no Windows test environment is currently available but Windows support remains required. The delivery gate is therefore split without treating absent Windows evidence as a pass:

- `GO-DEV`: local dependency, vault, browser transport, and approved SSH/SFTP target evidence may release Phase 1 SQLite and cross-platform remote-access development.
- `NO-GO-RELEASE-WINDOWS`: no Windows remote-access release or completed-support claim may be made until Node.js 24 LTS, SQLite, Credential Manager, runtime packaging, launcher, host-key handling, and SSH/SFTP pass on Windows.

This amendment supersedes the earlier instruction that Windows execution must occur before any Phase 1 database work. It does not remove or weaken the Windows release verification requirement.

## Planned File Boundary

Phase 0 does not add production runtime modules. It creates only:

| Path | Responsibility |
| --- | --- |
| `/private/tmp/opsdog-remote-p0/package.json` | Disposable dependency lab; never committed |
| `/private/tmp/opsdog-remote-p0/runtime-probe.test.mjs` | Executable local dependency/SQLite/keyring checks; never committed |
| `/private/tmp/opsdog-remote-p0/ssh-target-probe.mjs` | Explicitly invoked real SSH/SFTP verification against a user-approved test endpoint; never committed |
| `docs/superpowers/research/2026-05-26-remote-access-p0-results.md` | Committed evidence, decisions, blockers, and the go/no-go conclusion for Phase 1 |

No password, private key, passphrase, SSH terminal output, or downloaded test-file contents may be committed or written to the result note.

## Success Criteria

Phase 0 is complete only when the result note contains evidence for each item:

| Gate | Pass condition |
| --- | --- |
| Existing build baseline | `npm run build` succeeds before production edits |
| Test-package behavior | Existing ZIP bundle behavior is documented, including whether server runtime dependencies are included |
| SQLite decision | One binding and a supported Node-version policy are selected with probe evidence |
| Credential store | A temporary secret can be created, read, overwritten, and removed via the chosen OS vault adapter without entering SQLite or logs |
| Package loading | `ssh2`, `ws`, xterm packages, and the selected SQLite/keyring packages import on the development host |
| SSH/SFTP target | An approved OpenSSH target completes shell, resize, list, upload, download, and cleanup checks without committing target secrets |
| Windows/delivery gate | The Windows validation matrix is recorded as a release blocker until run on Windows; its absence does not block Phase 1 development after explicit user approval |

## Task 1: Establish the Baseline and Delivery Constraint

**Files:**
- Read: `package.json`
- Read: `scripts/package-test-bundle.mjs`
- Read: `README.md`
- Read: `docs/superpowers/specs/2026-05-26-remote-terminal-sftp-design.md`
- Create later in Task 6: `docs/superpowers/research/2026-05-26-remote-access-p0-results.md`

- [ ] **Step 1: Capture clean source status and supported runtime statements**

Run:

```bash
git status --short --branch --untracked-files=normal
node --version
npm --version
rg -n "Node.js|package:test|start-windows|node_modules|server/src|dist" README.md package.json scripts/package-test-bundle.mjs
```

Expected:

```text
The output records the active branch, unrelated generated artifacts if present, local Node/npm versions, README runtime claim, and the bundle script's removal of node_modules.
```

- [ ] **Step 2: Run the unmodified frontend/backend build baseline**

Run:

```bash
npm run build
```

Expected:

```text
Exit code 0. If it fails, record the exact failure and stop Phase 0 feature probing until the pre-existing build issue is resolved or explicitly accepted.
```

- [ ] **Step 3: Build the current test ZIP and inspect its runtime contents**

Run:

```bash
npm run package:test
find releases -name 'OpsDog-test-*.zip' -type f -print
unzip -l "$(find releases -name 'OpsDog-test-*.zip' -type f | sort | tail -n 1)" | rg "start-windows.cmd|server/src/index.js|node_modules|package.json"
```

Expected:

```text
The ZIP contains the launcher, server entry, and package manifest. Under the current script it contains no node_modules, which must be recorded as a delivery constraint before runtime packages are introduced.
```

- [ ] **Step 4: Do not commit generated package artifacts**

Run:

```bash
git status --short --untracked-files=normal
```

Expected:

```text
Only pre-existing or generated release artifacts appear as untracked/ignored files; none is staged.
```

## Task 2: Create a Disposable Dependency Lab

**Files:**
- Create: `/private/tmp/opsdog-remote-p0/package.json`
- Create: `/private/tmp/opsdog-remote-p0/runtime-probe.test.mjs`

- [ ] **Step 1: Create the disposable package manifest**

Create `/private/tmp/opsdog-remote-p0/package.json` with:

```json
{
  "name": "opsdog-remote-access-p0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test --test-concurrency=1 runtime-probe.test.mjs"
  }
}
```

- [ ] **Step 2: Install exact probe dependencies outside the repository**

Run:

```bash
npm --prefix /private/tmp/opsdog-remote-p0 install --save-exact ssh2@1.17.0 ws@8.21.0 @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 @napi-rs/keyring@1.3.0 better-sqlite3@12.10.0
```

Expected:

```text
Exit code 0 on the development host. If a native dependency fails to install, record its package name, platform, Node version, and build/prebuild error as a selection failure.
```

- [ ] **Step 3: Write a probe that initially fails until all selected packages are installed**

Create `/private/tmp/opsdog-remote-p0/runtime-probe.test.mjs` with:

```js
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync as NativeDatabaseSync } from 'node:sqlite';
import BetterSqlite3 from 'better-sqlite3';
import { Client as SshClient } from 'ssh2';
import { WebSocketServer } from 'ws';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Entry } from '@napi-rs/keyring';

const workDir = mkdtempSync(path.join(os.tmpdir(), 'opsdog-remote-p0-'));

test.after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const verifyDatabase = (database) => {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE parent (id TEXT PRIMARY KEY);
    CREATE TABLE child (parent_id TEXT NOT NULL REFERENCES parent(id));
    INSERT INTO parent (id) VALUES ('device-1');
    INSERT INTO child (parent_id) VALUES ('device-1');
  `);
  assert.throws(
    () => database.exec("INSERT INTO child (parent_id) VALUES ('missing')"),
    /FOREIGN KEY constraint failed/,
  );
};

test('node sqlite can enforce remote database foreign keys in a file database', () => {
  const database = new NativeDatabaseSync(path.join(workDir, 'native.db'));
  const journalMode = database.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
  verifyDatabase(database);
  database.close();
  assert.equal(String(journalMode).toLowerCase(), 'wal');
});

test('better-sqlite3 can enforce the same remote database contract', () => {
  const databasePath = path.join(workDir, 'better.db');
  const database = new BetterSqlite3(databasePath);
  const journalMode = database.pragma('journal_mode = WAL', { simple: true });
  database.pragma('foreign_keys = ON');
  verifyDatabase(database);
  database.close();
  assert.equal(String(journalMode).toLowerCase(), 'wal');
  assert.ok(readFileSync(databasePath).length > 0);
});

test('terminal and transport modules required by the planned architecture load', () => {
  assert.equal(typeof SshClient, 'function');
  assert.equal(typeof WebSocketServer, 'function');
  assert.equal(typeof Terminal, 'function');
  assert.equal(typeof FitAddon, 'function');
});

test('the system-vault candidate exposes its documented entry API', () => {
  const entry = new Entry('opsdog.remote.p0', 'api-surface-only');
  assert.equal(typeof entry.setPassword, 'function');
  assert.equal(typeof entry.getPassword, 'function');
  assert.equal(typeof entry.deletePassword, 'function');
});

test('the system-vault candidate round trips a disposable secret when explicitly enabled', {
  skip: process.env.OPSDOG_RUN_SECRET_PROBE !== '1',
}, () => {
  const account = `probe-${Date.now()}`;
  const entry = new Entry('opsdog.remote.p0', account);
  const firstSecret = `first-${Date.now()}`;
  const secondSecret = `second-${Date.now()}`;
  try {
    entry.setPassword(firstSecret);
    assert.equal(entry.getPassword(), firstSecret);
    entry.setPassword(secondSecret);
    assert.equal(entry.getPassword(), secondSecret);
  } finally {
    entry.deletePassword();
  }
});
```

- [ ] **Step 4: Run the probe without writing a system credential**

Run:

```bash
npm --prefix /private/tmp/opsdog-remote-p0 test
```

Expected:

```text
SQLite and package-load tests pass. The keyring round-trip test is reported as skipped because it intentionally requires explicit authorization.
```

- [ ] **Step 5: Run the disposable system-vault round trip with authorization**

Run:

```bash
OPSDOG_RUN_SECRET_PROBE=1 npm --prefix /private/tmp/opsdog-remote-p0 test
```

Expected:

```text
All tests pass and the disposable keyring entry is deleted in the finally block. If the platform prompts for keychain access or rejects access, record that behavior as part of the chosen adapter decision.
```

## Task 3: Decide the SQLite and Node Runtime Policy

**Files:**
- Modify later in Task 6: `docs/superpowers/research/2026-05-26-remote-access-p0-results.md`

- [ ] **Step 1: Record registry metadata for runtime-sensitive candidates**

Run:

```bash
npm view better-sqlite3 version engines license time.modified
npm view @napi-rs/keyring version engines license time.modified
npm view ssh2 version engines license time.modified
npm view ws version engines license time.modified
npm view @xterm/xterm version license time.modified
npm view @xterm/addon-fit version license time.modified
```

Expected:

```text
The output includes exact resolved versions and declared Node engine requirements. The result note must quote only the selected version and compatibility conclusion, not large package READMEs.
```

- [ ] **Step 2: Select one SQLite policy using the probe output**

Use this decision rule:

```text
Choose node:sqlite only if the supported deployment runtime is explicitly raised to a Node version where the project accepts its stability status and all supported packages run there.

Choose better-sqlite3 only if the product runtime is explicitly raised to Node >=20 and the Windows delivery path successfully carries the native addon.

Do not keep the README Node 18+ statement while selecting a runtime dependency that cannot run under Node 18.
```

Expected:

```text
The result note states one selected policy or states "no-go" with the exact unpassed gate. It never leaves both alternatives as an implicit implementation choice.
```

## Task 4: Verify SSH/SFTP Against an Approved Test Target

**Files:**
- Create: `/private/tmp/opsdog-remote-p0/ssh-target-probe.mjs`

This task requires a test SSH account or disposable OpenSSH container/device approved for testing. It must not use a production credential or place a password/private key in shell history, source control, or the result note.

- [ ] **Step 1: Write the target probe using environment-only credentials**

Create `/private/tmp/opsdog-remote-p0/ssh-target-probe.mjs` with:

```js
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'ssh2';

const host = process.env.OPSDOG_SSH_TEST_HOST;
const port = Number(process.env.OPSDOG_SSH_TEST_PORT || '22');
const username = process.env.OPSDOG_SSH_TEST_USERNAME;
const password = process.env.OPSDOG_SSH_TEST_PASSWORD;
const privateKeyPath = process.env.OPSDOG_SSH_TEST_PRIVATE_KEY_PATH;

assert.ok(host, 'OPSDOG_SSH_TEST_HOST is required');
assert.ok(username, 'OPSDOG_SSH_TEST_USERNAME is required');
assert.ok(password || privateKeyPath, 'Password or private key path is required');

const privateKey = privateKeyPath ? await readFile(privateKeyPath) : undefined;
const remoteFile = `/tmp/opsdog-remote-p0-${Date.now()}.txt`;
const localFile = path.join(os.tmpdir(), `opsdog-remote-p0-${Date.now()}.txt`);
const content = `opsdog-p0-${Date.now()}\n`;

const connect = () => new Promise((resolve, reject) => {
  const connection = new Client();
  connection.once('ready', () => resolve(connection));
  connection.once('error', reject);
  connection.connect({
    host,
    port,
    username,
    password,
    privateKey,
    readyTimeout: 10000,
    keepaliveInterval: 5000,
  });
});

const shellCheck = (connection) => new Promise((resolve, reject) => {
  connection.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (error, stream) => {
    if (error) return reject(error);
    let output = '';
    stream.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    stream.on('close', () => {
      assert.match(output, /OPSDOG_P0_TERMINAL_OK/);
      resolve();
    });
    stream.setWindow(36, 120, 0, 0);
    stream.end('printf "OPSDOG_P0_TERMINAL_OK\\n"\nexit\n');
  });
});

const sftpCheck = (connection) => new Promise((resolve, reject) => {
  connection.sftp(async (error, sftp) => {
    if (error) return reject(error);
    try {
      await writeFile(localFile, content, 'utf8');
      await new Promise((res, rej) => sftp.fastPut(localFile, remoteFile, (err) => err ? rej(err) : res()));
      const list = await new Promise((res, rej) => sftp.readdir('/tmp', (err, value) => err ? rej(err) : res(value)));
      assert.ok(list.some((entry) => entry.filename === path.basename(remoteFile)));
      const downloaded = `${localFile}.downloaded`;
      await new Promise((res, rej) => sftp.fastGet(remoteFile, downloaded, (err) => err ? rej(err) : res()));
      assert.equal(await readFile(downloaded, 'utf8'), content);
      await rm(downloaded, { force: true });
      await new Promise((res, rej) => sftp.unlink(remoteFile, (err) => err ? rej(err) : res()));
      resolve();
    } catch (probeError) {
      reject(probeError);
    }
  });
});

const connection = await connect();
try {
  await shellCheck(connection);
  await sftpCheck(connection);
  process.stdout.write('SSH shell and SFTP probe passed.\n');
} finally {
  connection.end();
  await rm(localFile, { force: true });
}
```

- [ ] **Step 2: Run the probe only with a disposable approved endpoint**

Export credentials in an interactive local shell or other approved secret-bearing environment, then run the script without placing their values in this plan, source control, or command logs:

```bash
node /private/tmp/opsdog-remote-p0/ssh-target-probe.mjs
```

Expected:

```text
SSH shell and SFTP probe passed.
```

If private key authentication is used, set `OPSDOG_SSH_TEST_PRIVATE_KEY_PATH` rather than embedding key content.

- [ ] **Step 3: Clean the test target and record only non-secret evidence**

Run:

```bash
git status --short --untracked-files=normal
```

Expected:

```text
No test credential, downloaded file, or temporary probe file exists in the repository.
```

## Task 5: Verify the Windows Delivery Path Before Product Dependencies

**Files:**
- Read: `scripts/package-test-bundle.mjs`
- Modify only after selecting a delivery approach: `scripts/package-test-bundle.mjs`
- Modify only after selecting a runtime baseline: `README.md`
- Modify only after selecting a runtime baseline: `package.json`

This task is a gate, not permission to silently change distribution policy. The selected outcome must be recorded before product dependencies are committed.

- [ ] **Step 1: Select exactly one delivery approach**

Evaluate these concrete options and choose one in the results note:

```text
A. Ship production node_modules in the Windows-built bundle. This supports native keyring/SQLite modules only if the bundle is produced on Windows for Windows.
B. Require npm ci --omit=dev on the target before start-windows.cmd launches. This is simpler but requires registry/build-tool access at installation time.
C. Introduce a desktop packaging/runtime pipeline that bundles the Node backend and native addons. This is only acceptable if that pipeline is made part of the tracked repository and CI.
```

Expected:

```text
One selected delivery policy, with its build host requirement and user installation requirement stated explicitly.
```

- [ ] **Step 2: Test the selected approach on Windows**

For option A, the Windows verification must run:

```powershell
npm ci
npm run build
npm run package:test
$bundle = Get-ChildItem .\releases -Directory -Filter 'OpsDog-test-*' | Sort-Object LastWriteTime | Select-Object -Last 1
& (Join-Path $bundle.FullName 'start-windows.cmd')
```

For option B, the Windows verification must run inside the extracted bundle:

```powershell
npm ci --omit=dev
.\start-windows.cmd
```

Expected:

```text
The bundled backend starts, serves the web app, and runs the database/keyring/SSH probe under the selected Node runtime. The result note records the date, Node version, selected approach, and pass/fail outcome without credentials.
```

- [ ] **Step 3: Apply only the documentation/runtime-minimum update supported by evidence**

If the selected binding requires Node 20 or later, update the documented minimum version; if a different result is selected, update it to the chosen minimum. Do not change the claim before Windows verification supplies evidence.

Expected:

```text
README and package engine metadata, when eventually changed, agree with the SQLite/keyring/runtime dependency selection.
```

## Task 6: Record Phase 0 Evidence and Gate Phase 1

**Files:**
- Create: `docs/superpowers/research/2026-05-26-remote-access-p0-results.md`

- [ ] **Step 1: Write the evidence note from observed output**

Create the file with these sections and fill every table cell with an actual non-secret observation from Tasks 1 through 5:

```markdown
# Remote Access Phase 0 Results

- Date: 2026-05-26
- Scope: Runtime, dependency, credential-vault, SSH/SFTP, terminal, and delivery validation
- Design reference: `docs/superpowers/specs/2026-05-26-remote-terminal-sftp-design.md`

## Baseline

Include a three-column table named `Check | Observation | Result` with rows for:

- Current Node/npm versions.
- `npm run build`.
- `npm run package:test`.
- Runtime dependency packaging inspection.

## Dependency Probes

Include a four-column table named `Component | Version tested | Observation | Decision` with rows for SQLite binding, system keyring, SSH/SFTP, and WebSocket/xterm.

## Delivery Decision

State one supported Node minimum, one Windows bundle policy selected from A/B/C, and how native addons are delivered.

## Security Checks

Include a result table for secret absence, keyring cleanup, and SSH test-target cleanup.

## Gate Decision

End the note with both approved dual-gate outcomes:

`GO-DEV: write and execute the Phase 1 SQLite foundation plan using Node.js 24 LTS and a node:sqlite adapter boundary; approved local and SSH/SFTP evidence is sufficient for cross-platform development.`

`NO-GO-RELEASE-WINDOWS: Windows remote-access release remains blocked until Windows runtime, SQLite/filesystem, Credential Manager, packaging/launcher, SSH/SFTP, and host-key validation results are recorded as passing.`
```

- [ ] **Step 2: Scan the results note for secret leakage and unresolved placeholders**

Run:

```bash
rg -n "temporary-password|OPSDOG_SSH_TEST_PASSWORD|BEGIN .*PRIVATE KEY|topS3cr3t|\\[observed|\\[pass|\\[selected|\\[GO|\\[NO-GO" docs/superpowers/research/2026-05-26-remote-access-p0-results.md
```

Expected:

```text
No matches. If any match is present, redact or complete the note before staging it.
```

- [ ] **Step 3: Verify, stage, and commit only the completed Phase 0 record**

Run:

```bash
git diff --check
git add -f docs/superpowers/research/2026-05-26-remote-access-p0-results.md
git diff --cached --check
git commit -m "docs: record remote access phase zero validation"
```

Expected:

```text
One commit containing the completed results note and no temporary lab, credentials, test downloads, or generated release artifacts.
```

## Task 7: Transition Only After the Gate

**Files:**
- Create after a `GO` decision: `docs/superpowers/plans/2026-05-26-remote-access-phase-1-sqlite-foundation.md`

- [ ] **Step 1: Check the recorded decision**

Run:

```bash
rg -n "^`GO-DEV:|^`NO-GO-RELEASE-WINDOWS:" docs/superpowers/research/2026-05-26-remote-access-p0-results.md
```

Expected:

```text
Both the development release and Windows publication blocker decisions are present.
```

- [ ] **Step 2: Proceed according to the recorded decision**

```text
For `GO-DEV`, invoke writing-plans again and write the Phase 1 database/migration plan before adding production database code; retain `NO-GO-RELEASE-WINDOWS` until Windows evidence exists.
For a full `NO-GO`, perform only the remediation named in the result note and repeat the failed Phase 0 test; do not start database migration code.
```

Expected:

```text
Production implementation starts only from a verified, committed Phase 0 decision.
```
