# Remote Access Phase 0 Results

- Date: 2026-05-26
- Branch: `codex/remote-access-p0`
- Scope: Runtime, dependency, credential-vault, SSH/SFTP, terminal, and delivery validation
- Design reference: `docs/superpowers/specs/2026-05-26-remote-terminal-sftp-design.md`
- Plan reference: `docs/superpowers/plans/2026-05-26-remote-access-phase-0-capability-validation.md`

## Baseline

| Check | Observation | Result |
| --- | --- | --- |
| Current Node/npm | Node `v23.11.0`, npm `10.9.2` | Recorded local probe runtime |
| `npm run build` | Exit code `0`; Vite reports existing large-chunk warnings for PDF worker and application bundle | Pass with existing warning |
| Initial `npm run package:test` in clean worktree | Failed with `ENOENT` copying `DEPLOY.md`; `DEPLOY.md` is ignored by `*.md` and is not tracked; `device_status.py` is also an untracked/nonexistent required copy target | Pre-existing delivery defect found |
| Retested `npm run package:test` after `4466556` | Exit code `0`; fresh verification generated `releases/OpsDog-test-20260526-064406.zip` | Pass for tracked-file baseline |
| Runtime dependency packaging | ZIP contains `start-windows.cmd`, `server/src/index.js`, and `package.json`; ZIP listing contains no `node_modules` | Constraint: new backend packages cannot work in the current direct-start ZIP until delivery policy changes |

The prerequisite fix in commit `4466556` removes missing mandatory copy targets from `scripts/package-test-bundle.mjs` and changes the generated test-bundle instruction link from absent `DEPLOY.md` to bundled `README.md`. The separate broken link in the repository root `README.md` is an existing documentation issue and was not expanded into this prerequisite fix.

## Dependency Probes

All dependencies below were installed only under `/private/tmp/opsdog-remote-p0`; no candidate remote-access runtime dependency has been added to the product package manifest.

| Component | Version tested | Observation | Decision |
| --- | --- | --- | --- |
| Built-in SQLite | `node:sqlite` supplied by local Node `v23.11.0`; target runtime Node.js 24 LTS | File-backed database successfully enables WAL and enforces a foreign key; the local probe emits `ExperimentalWarning: SQLite is an experimental feature`, and the Node.js 24 API is accepted with its release-candidate stability status for this development stage | Selected for Phase 1 behind a narrow database adapter; Windows and Node.js 24 runtime validation remains a release gate |
| Native SQLite alternative | `better-sqlite3@12.10.0` | npm metadata requires Node `20.x` or later; standalone temporary installation remained idle without adding the package to the lockfile and was terminated | Rejected for this local P0 run; not eligible without a reproducible supported-runtime/Windows install result |
| System keyring | `@napi-rs/keyring@1.3.0` | On macOS arm64, test created, read, replaced, deleted, and then confirmed absence of a disposable `opsdog.remote.p0` entry | Pass locally; Windows Credential Manager behavior remains required |
| SSH/SFTP client | `ssh2@1.17.0` | Client class loads. Against an approved SSH/SFTP test endpoint, the probe completed an interactive PTY shell marker and resize, SFTP `/tmp` listing, temporary upload, download comparison, and remote deletion with exit code `0`. Its optional `cpu-features` native optimization previously failed to download Node headers because of a local issuer certificate error, while `ssh2` remained usable through fallback behavior | Pass for SSH/SFTP capability against the approved target; production host-key verification is still a Phase 1 security requirement |
| WebSocket terminal transport | `ws@8.21.0` | A `resize` frame round trip over a loopback WebSocket server passed when executed outside the filesystem/network sandbox | Pass locally |
| Browser terminal bundle | `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0` | A disposable Vite entry importing the terminal, fit addon, and CSS bundled successfully | Pass for browser bundling |

## Commands And Evidence

The material successful commands were:

```bash
npm run build
npm run package:test
OPSDOG_RUN_SECRET_PROBE=1 npm --prefix /private/tmp/opsdog-remote-p0 test
/Users/meteor/Code/AI-ops/.worktrees/remote-access-p0/node_modules/.bin/vite build --outDir /private/tmp/opsdog-remote-p0/dist --emptyOutDir
node --check /private/tmp/opsdog-remote-p0/ssh-target-probe.mjs
node /private/tmp/opsdog-remote-p0/ssh-target-probe.mjs
```

The completed local probe reported five passing tests:

```text
node sqlite persists a WAL database and enforces remote-data foreign keys
server-side transport modules required by the proposed architecture load
websocket transport can carry a terminal resize frame over loopback
the system-vault candidate exposes its documented entry API
the system-vault candidate round trips and removes a disposable secret
```

The approved endpoint probe reported:

```text
SSH shell and SFTP probe passed.
```

## Development And Delivery Decision

- Remote-access target runtime: Node.js 24 LTS. Phase 2 updates `package.json.engines.node` and the generated test-bundle instructions to this runtime; Windows execution evidence is still required before release.
- SQLite development policy: implement Phase 1 with `node:sqlite` behind a small adapter/repository boundary. It passed the local WAL/foreign-key probe; its Windows runtime behavior must be verified before Windows remote-access release.
- Windows bundle policy: selection remains deferred until a Windows test machine is available. The current ZIP cannot carry future `ssh2`, `ws`, or keyring backend imports because it deliberately omits `node_modules`.
- Gate split approved by user on 2026-05-26: missing Windows evidence no longer blocks cross-platform implementation, but it remains an explicit blocker for Windows remote-access release or completion claims.

## Windows Release Validation Matrix

| Area | Windows-only or Windows-critical verification | Required outcome before release |
| --- | --- | --- |
| Runtime | Start the backend on Node.js 24 LTS and load SQLite, SSH, WebSocket and keyring modules | Startup and health endpoint pass without missing-module or architecture errors |
| SQLite and filesystem | Create, migrate, use WAL/foreign keys, restart/read and back up the database under the chosen application data directory, including paths with spaces and Chinese characters | Data persists correctly and all migrations/tests pass |
| Credential Manager | Create, read, overwrite, delete and read after application restart through `SecretStore` | Secret is usable only through the vault and absent from SQLite, logs and API output |
| Packaging and launcher | Build or extract the selected Windows package, start with `start-windows.cmd`, stop and restart | Dependencies are present by documented policy and health check passes |
| Remote session | Connect to a test SSH/SFTP server, resize terminal, transfer and clean a temporary file | Same capability probe as macOS passes from the Windows distribution |
| Host-key security | Confirm first-use fingerprint and reject a changed saved host key | Changed keys block the session rather than being silently accepted |

## Security Checks

| Check | Result |
| --- | --- |
| Secret absent from committed changes | Pass: tracked test-bundle and planning/evidence document changes do not contain a target credential or private-key material |
| Disposable keyring entry removed | Pass: the probe reads the entry after deletion and receives no stored password |
| Probe credentials stored in repository | Pass: SSH/SFTP probe accepts credentials only through environment variables and remains under `/private/tmp`; no target credential is included in this note or tracked changes |
| SSH test-target cleanup completed | Pass: the approved endpoint probe returned exit code `0` after its SFTP temporary upload, download comparison, and remote unlink completed |

## Phase 1 Development Evidence

| Check | Observation | Result |
| --- | --- | --- |
| Target Node runtime database tests | `npx --yes node@24 --test --test-concurrency=1 server/test/database/*.test.js` resolved Node `v24.16.0` and reported `9` passing tests with `0` failures | Pass for development runtime |
| Current JSON import rehearsal | Explicit initialization into a temporary database returned `status = succeeded`, `devices = 0`, `issues = 5`, `imports = 1`; temporary files were removed after the check | Pass: existing orphan monitor metadata is isolated rather than aborting initialization |
| Product build | `npm run build` exited `0`, retaining existing Vite large-chunk warnings | Pass with existing warning |
| Existing test bundle | `npm run package:test` exited `0` and generated a fresh ZIP bundle | Pass for current JSON-backed application; not Windows remote-access evidence |

At the Phase 1 checkpoint, only the SQLite adapter, schema, importer and explicit initializer were active, while HTTP routes and `deviceWatcher` remained JSON-backed. Phase 2 below records the completed compatibility cutover.

## Phase 2 SQLite API Compatibility Evidence

| Check | Observation | Result |
| --- | --- | --- |
| Target Node runtime test suite | `npx --yes node@24 --version` reported `v24.16.0`; `npx --yes node@24 --test --test-concurrency=1 server/test/database/*.test.js` reported `16` passing tests with `0` failures | Pass for P2 development runtime |
| SQLite asset/monitor store | Tests cover merged asset fields and filters, joined monitor metadata/status, local create/update/delete, default profiles, status writes, and remote-asset read-only protection | Pass: local/merged persistence contract is database-backed |
| Watcher persistence boundary | Store-injected tests cover success reset and failure threshold transitions without network calls; the production watcher accepts either SQLite or legacy JSON store contracts | Pass: watcher can write SQLite status without filesystem coupling |
| HTTP API activation | A Node 24 subprocess test initializes an isolated SQLite database from JSON, performs asset create/update/status/delete requests, and verifies source JSON is not rewritten | Pass: existing local/merged API contract now selects SQLite after activation |
| JSON fallback | A subprocess test forces SQLite activation failure while `OPSDOG_ASSETS_DIR` is separate from `process.cwd()`, then verifies legacy JSON CRUD remains operational | Pass: initialization failure preserves prior persistence behavior |
| Runtime/package declaration | `package.json` declares Node `>=24.0.0`; the generated ZIP instructions state Node.js 24 LTS | Pass for declared SQLite runtime |
| Product package sanitation | `npm run package:test` generated `releases/OpsDog-test-20260526-095650.zip`; archive inspection found `0` entries matching `server/data/opsdog/`, import backups, `.db`, `.db-wal` or `.db-shm` | Pass: no developer SQLite state is shipped |
| Product build | The packaging build exited `0`; Vite retained the existing large-chunk warnings | Pass with existing warning |

Phase 2 adds `createSqliteAssetMonitorStore`, store-driven monitoring checks, startup activation before HTTP listening, `OPSDOG_DATABASE_PATH`/`OPSDOG_ASSETS_DIR` isolation hooks, and a JSON fallback when database activation fails. It does not add SSH credentials, host-key decisions, SFTP operations or Windows release evidence.

## Phase 3 Secure Connection Profile Evidence

| Check | Observation | Result |
| --- | --- | --- |
| Target Node runtime test suite | `npx --yes node@24 --test --test-concurrency=1 server/test/database/*.test.js` reported `31` passing tests with `0` failures | Pass for P3 development runtime |
| Secret-store boundary | The service stores only vault locators and fingerprints in SQLite; tests cover sanitized create/list/update/delete, compensation on database failure, active-session delete rejection, unavailable vault behavior and native-operation error normalization | Pass: submitted passwords are not API or SQLite fields |
| HTTP API activation | Isolated subprocess tests cover profile CRUD through `/api/remote/...`, real macOS keyring use with disposable credentials, and a disabled-vault runtime that returns `SECRET_STORE_UNAVAILABLE` without persistence | Pass locally; Windows Credential Manager remains unverified |
| Device profile UI | Browser validation created, metadata-edited and deleted a disposable SSH profile; editing showed an empty password field, a remotely sourced device exposed the local profile editor, and disabled-vault saving displayed an error with the password input cleared | Pass for password-authentication UI scope |
| Product build and package | `npm run package:test` exited `0` with existing Vite large-chunk warnings and generated `releases/OpsDog-test-20260526-152431.zip` | Pass with existing warning |
| Product package sanitation | Final ZIP inspection matched no SQLite database/WAL/backup paths, `node_modules`, or disposable credential markers; its generated README explicitly marks remote credential support as development-only pending Windows-verified native dependencies | Pass for non-release development bundle |
| Disposable cleanup | Temporary SQLite/package scans matched no submitted credential marker, and the final keyring cleanup check removed `0` residual disposable entries | Pass |

Phase 3 adds an operating-system vault-backed SSH password profile service, safe HTTP CRUD endpoints and device-detail profile management UI. It deliberately does not open terminal or SFTP sessions, implement host-key trust decisions, or claim a Windows-ready remote-access distribution.

## Phase 4A Trusted SSH Handshake And Connection-Test Evidence

| Check | Observation | Result |
| --- | --- | --- |
| Target Node runtime suite | `npx --yes node@24 --test --test-concurrency=1 server/test/database/*.test.js` reported `42` passing tests with `0` failures | Pass for P4-A development runtime |
| Open-source SSH boundary | Product dependencies now pin `ssh2@1.17.0`; `sshTransport` delegates SSH negotiation, host-key delivery, password authentication and SFTP subsystem opening to that library, and returns stable failures when a peer closes before key observation or readiness | Pass: the application does not implement SSH protocol or cryptography |
| Host-key trust policy | Node tests cover first-seen confirmation, one-time/expired approval challenges, safe trust persistence, trusted-key repeat evaluation and changed-key blocking without replacing the stored key | Pass: unknown or changed keys cannot silently authenticate |
| Credential sequencing | Injected-transport tests prove first-seen and mismatched host keys return safe fingerprint state without reading SecretStore; password retrieval occurs only after the server key is trusted | Pass: credentials are not offered before host verification |
| Safe HTTP surface | Routes for probe, trust, host-key history and connection testing are covered by service and HTTP tests; unreachable endpoint failures return stable safe codes | Pass locally |
| macOS UI acceptance | Against the approved test endpoint, the device profile UI displayed first-seen algorithm/fingerprint confirmation, succeeded after explicit trust and password authentication, reported SFTP subsystem availability, and succeeded again without a second trust prompt | Pass without recording endpoint details or credentials |
| Cleanup and audit | The disposable UI profile was removed after acceptance; its system-vault lookup was empty afterward. The temporary audit stream recorded credential creation/deletion, host-key approval and two successful connection tests without a raw-host-key field | Pass |
| Product build | `npm run build` completed successfully after the trusted-handshake UI changes, retaining existing Vite large-chunk warnings | Pass with existing warning |
| Test ZIP boundary | `npm run package:test` generated a clean-content ZIP with no SQLite state, import backups, `node_modules` or disposable markers; because the server now imports `ssh2` while the ZIP still omits dependencies, this ZIP is not a remote-access release artifact | Pass for sanitation; no-go for remote-access delivery |

Phase 4A adds `ssh2`-backed host-key probing and authenticated connection testing, a short-lived approval challenge, safe trust/audit storage, four HTTP routes, and the connection-profile UI workflow. It does not deliver interactive terminal WebSocket/xterm sessions (P4-B), SFTP file operations (P5/P6), Telnet, host-key replacement, or Windows release evidence.

## Phase 4B Interactive SSH Terminal Implementation Status

| Check | Observation | Result |
| --- | --- | --- |
| Product dependencies | Product dependencies pin `ssh2@1.17.0`, `ws@8.21.0`, `@xterm/xterm@6.0.0` and `@xterm/addon-fit@0.11.0`; SSH wire behavior and PTY shell creation remain delegated to `ssh2` | Pass for implementation boundary |
| Target Node runtime suite | `node --test --test-concurrency=1 server/test/database/*.test.js` was executed with Node `v24.16.0` and reported `56` passing tests with `0` failures | Pass for automated P4-B behavior |
| Terminal security lifecycle | Tests cover trusted-token issuance without vault reads, one-time/expired tokens, host-key mismatch before vault reads, PTY input/output/resize bridging, invalid WebSocket frame rejection, terminal-open failure metadata, PTY stream-error shutdown, React development lifecycle token safety, bounded client resize frames and metadata-only storage | Pass: terminal bytes and secrets are excluded from SQLite/audit assertions |
| Browser bundle boundary | The Vite build emits separate `TerminalWorkspace` JavaScript and CSS chunks after the React lazy-load boundary; the terminal library is loaded only after the operator opens a terminal surface | Pass for UI integration/build |
| Package sanitation | `npm run package:test` produces a ZIP that matches no SQLite/WAL/import-backup, `node_modules` or disposable-marker paths; as before, a ZIP omitting runtime dependencies is not a remote-access release artifact | Pass for sanitation; no-go for remote-access delivery |
| macOS acceptance corrections | Live acceptance exposed development lifecycle disposal of a single-use connection token and out-of-range client resize frames; the terminal now defers cancellable startup, waits for server readiness before sending frames and bounds resize frames to the protocol contract | Pass: both regressions covered by automated tests |
| macOS real-terminal acceptance | Through an approved configured SSH profile, fresh terminal sessions connected successfully, returned a benign input/output marker, reflected a window-size change, closed through the operator control and reconnected successfully. Metadata inspection found two final successful sessions closed by the operator and no terminal transcript rows or acceptance markers in SQLite/WAL | Pass without recording endpoint, credential, fingerprint, command or terminal output details |

Phase 4B implementation adds a short-lived one-time terminal token, a bounded WebSocket terminal gateway, `ssh2` PTY shell transport, metadata-only terminal session lifecycle auditing, and a lazy-loaded xterm terminal modal. Real macOS terminal acceptance is complete; P5 read-only SFTP planning and development may proceed without claiming Windows release readiness.

## Remaining Windows Release Gates

1. Execute the Windows validation matrix when a Windows environment becomes available, recording Node version, package policy and pass/fail results without credentials.
2. Before any Windows remote-access release, validate the Node.js 24 test package on Windows and extend the delivery policy for later SSH/keyring dependencies according to the verified results.

## Gate Decision

`GO-DEV: P4-B interactive SSH terminal behavior is verified on macOS under Node.js v24.16.0; P5 read-only SFTP development may proceed without claiming Windows release readiness.`

`NO-GO-RELEASE-WINDOWS: Windows remote-access release remains blocked until Windows runtime, SQLite/filesystem, Credential Manager, packaging/launcher, SSH/SFTP, and host-key validation results are recorded as passing.`

## Phase 5 Read-Only SFTP Evidence

| Check | Observation | Result |
| --- | --- | --- |
| Target Node runtime suite | `node --test --test-concurrency=1 server/test/database/*.test.js` was executed with Node `v24.16.0` and reported `72` passing tests with `0` failures | Pass for automated P5 behavior |
| Product build | `npm run build` completed successfully with the existing Vite large-chunk warning | Pass |
| macOS real SFTP acceptance | Through an approved configured SSH profile, a read-only SFTP session opened successfully, listed the remote starting directory, read metadata for one benign file, downloaded that benign file, and closed through the API | Pass without recording endpoint details, credentials, fingerprint, terminal output, or file body |
| Metadata-only audit | SQLite rows for the accepted session showed `session_kind = 'sftp'`, `transcript_policy = 'metadata_only'`, successful `list` and `stat` operation rows, one successful `download` transfer row, and a closed session reason. Inspection confirmed the downloaded file body was not stored in `remote_sessions`, `sftp_operations`, `sftp_transfers`, or `audit_events` | Pass |
| Windows release gate | Windows Credential Manager, path/download behavior, package startup, and SSH/SFTP acceptance remain unverified on Windows | `NO-GO-RELEASE-WINDOWS` remains active |

`GO-DEV: P5 read-only SFTP behavior is verified on macOS under Node.js v24.16.0; P6 SFTP mutation development may proceed behind explicit confirmation and metadata-only audit gates.`

## Phase 6 SFTP Mutation Evidence

| Check | Observation | Result |
| --- | --- | --- |
| Target Node runtime suite | `node --test --test-concurrency=1 server/test/database/*.test.js` was executed with Node `v24.16.0` and reported `79` passing tests with `0` failures | Pass for automated P6 behavior |
| Product build | `npm run build` completed successfully with the existing Vite large-chunk warning | Pass |
| Browser UI sanity check | The local SFTP workspace rendered the file-management panel with upload, new-directory, rename, delete-file and confirmation copy. The screenshot capture API timed out, so this check used the browser DOM state rather than a saved screenshot | Pass for visible control presence |
| macOS real SFTP mutation acceptance | Through an approved configured SSH profile, the system uploaded one benign scratch file with overwrite disabled, created one scratch directory, renamed the scratch file, deleted the renamed scratch file and closed the SFTP session through the P6 HTTP API | Pass without recording endpoint details, credentials, fingerprint, terminal output, scratch path, or file body |
| Metadata-only audit | SQLite rows for the accepted session showed a closed `sftp` session with `metadata_only`, one successful upload transfer, successful `mkdir`, `rename` and `delete` operations, and audit events with `state-change` / `destructive` risk levels as appropriate. Inspection confirmed the uploaded file body was not stored in `remote_sessions`, `sftp_operations`, `sftp_transfers`, or `audit_events` | Pass |
| Windows release gate | Windows Credential Manager, path/upload/download behavior, package startup, and SSH/SFTP acceptance remain unverified on Windows | `NO-GO-RELEASE-WINDOWS` remains active |

`GO-DEV: P6 SFTP mutation behavior is verified on macOS under Node.js v24.16.0 for upload, mkdir, rename and file delete behind explicit confirmation and metadata-only audit gates.`

## Phase 7 TELNET Terminal Evidence

| Check | Observation | Result |
| --- | --- | --- |
| Component decision | `telnetlib@1.0.2` is pinned as the TELNET protocol component after metadata verification showed version `1.0.2`, MIT license and repository `git+https://github.com/cadpnq/telnetlib.git`; `telnet-client` was not selected because its package metadata and repository license signals disagree | Pass for component gate |
| Target Node runtime suite | `npx --yes node@24 --version` reported `v24.16.0`; `npx --yes node@24 --test --test-concurrency=1 server/test/database/*.test.js` reported `93` passing tests with `0` failures | Pass for automated P7 behavior |
| Product build | `npx --yes node@24 ./node_modules/typescript/bin/tsc && npx --yes node@24 ./node_modules/vite/bin/vite.js build` completed successfully with the existing Vite large-chunk warning | Pass |
| TELNET profile and UI boundary | Tests cover explicit TELNET profile creation with plaintext acknowledgement, forced no-SFTP/no-host-key behavior, protocol-aware connection tests and terminal tokens, TELNET UI warning copy, hidden SFTP controls and plaintext terminal footer | Pass: TELNET is opt-in and protocol scoped |
| TELNET transport/session boundary | Tests cover prompt-based password login through the TELNET socket, NAWS resize forwarding, stable failure codes, metadata-only terminal session lifecycle and no exposed password/transcript fields | Pass |
| Manual real-device TELNET acceptance | No real-device TELNET endpoint was exercised in this session | Pending |
| Windows release gate | Windows Credential Manager, package startup, path behavior and remote SSH/SFTP/TELNET acceptance remain unverified on Windows | `NO-GO-RELEASE-WINDOWS` remains active |

`GO-DEV: P7 TELNET automated behavior is verified on macOS under Node.js v24.16.0 with explicit plaintext acknowledgement, no SFTP capability and metadata-only terminal auditing. Manual real-device TELNET acceptance remains pending before claiming live TELNET coverage.`
