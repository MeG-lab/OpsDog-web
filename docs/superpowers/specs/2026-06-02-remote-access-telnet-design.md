# OpsDog TELNET Remote Terminal Design

- Status: draft for user review; implement only after this design is accepted
- Date: 2026-06-02
- Product shape: local single-user OpsDog Web
- Scope: human-operated TELNET connection test and interactive terminal
- Non-scope: SFTP, file editing, automated command execution, AI/MCP remote execution, Windows release claim

## 1. Decision Summary

TELNET support is a compatibility feature for legacy devices. It must not weaken the SSH/SFTP work that is already accepted.

The recommended direction is:

```text
Device asset
  -> connection profile with protocol = telnet
  -> system credential reference when password auth is used
  -> explicit plaintext-risk UI warning
  -> TELNET connection test
  -> shared browser terminal WebSocket and xterm UI
  -> metadata-only session/audit records
```

Key decisions:

| Area | Decision |
| --- | --- |
| Protocol implementation | Use an existing TELNET npm component; do not hand-code TELNET option negotiation. |
| Default state | SSH remains default. TELNET is opt-in and presented as a legacy/plaintext protocol. |
| Credential storage | Passwords stay in the OS credential store. SQLite stores only credential references and metadata. |
| Network security | TELNET has no encryption and no host-key trust. The UI and audit must say that plainly. |
| Terminal UI | Reuse existing xterm.js terminal modal, resize flow, close flow and WebSocket frame contract. |
| Backend boundary | Add a TELNET transport/service behind the same terminal adapter shape used by SSH. |
| SFTP | Always disabled for TELNET profiles. TELNET does not expose SFTP actions. |
| Automation | Human-only in this phase. Chat, AI, MCP, scheduled jobs and workflows must not open TELNET sessions. |
| Windows | Development can proceed on macOS; Windows remains `NO-GO-RELEASE-WINDOWS` until real validation. |

## 2. Why TELNET Is Separate From SSH

SSH has host-key trust, encrypted authentication, encrypted terminal data and SFTP. TELNET has none of those security properties. Treating TELNET as "SSH with another port" would create misleading UI and unsafe assumptions.

TELNET therefore gets a separate transport and service layer. It may reuse shared terminal plumbing only after the protocol-specific risk has already been handled:

- profile validation must know the profile is TELNET;
- SFTP and host-key confirmation must be unavailable;
- the user must see a plaintext-risk warning before saving or opening a TELNET profile;
- audit records must use `protocol = telnet`;
- terminal output and input must still be metadata-only and never persisted.

## 3. Open-Source Component Choice

The component decision should be finalized in P7-A before coding the full feature.

| Component | Current finding on 2026-06-02 | Fit | Decision |
| --- | --- | --- | --- |
| [`telnet-client`](https://www.npmjs.com/package/telnet-client) / [GitHub](https://github.com/mkozjak/node-telnet-client) | npm latest `2.2.13`; README exposes `connect`, login prompts, `shell()`, `write()`, `terminalWidth`, `terminalHeight`, encoding options. npm metadata says MIT, while the repository README/LICENSE says LGPLv3. | Best API fit for interactive login and shell. | Preferred only if the license discrepancy is accepted or resolved. |
| [`telnetlib`](https://www.npmjs.com/package/telnetlib) / [GitHub](https://github.com/cadpnq/telnetlib) | npm latest `1.0.2`; MIT; supports RFC1143 option negotiation and NAWS resize through `TelnetSocket`. | Good protocol-negotiation fit, but login prompt handling would be product-side logic. | Fallback if `telnet-client` licensing is not acceptable. |
| [`telnet-stream`](https://www.npmjs.com/package/telnet-stream) / [GitHub](https://github.com/blinkdog/telnet-stream) | npm latest `1.1.0`; AGPL-3.0. | Technically useful but licensing is not a good default for this product. | Do not use unless product/legal explicitly accepts AGPL obligations. |

Recommended P7-A gate:

1. Install the candidate in a scratch branch or disposable local test.
2. Verify Node.js 24 ESM import behavior.
3. Verify connect, login prompt handling, interactive shell stream, close, timeout and resize behavior.
4. Verify license metadata and repository license are acceptable before pinning it in `package.json`.

## 4. Functional Scope

### 4.1 Supported In P7

1. Create and edit TELNET connection profiles from a device.
2. Store TELNET password credentials in the same OS vault abstraction used by SSH.
3. Support `authMethod = password` and optionally `authMethod = none` for devices that open directly to a prompt.
4. Test a TELNET connection with stable success/failure codes.
5. Open an interactive browser terminal through the existing terminal modal.
6. Send keyboard input, receive output, resize the terminal and disconnect.
7. Record metadata-only `remote_sessions` and `audit_events` entries.
8. Keep TELNET terminal access human-only.

### 4.2 Not Supported In P7

1. SFTP, SCP, upload, download, remote file editing or file browsing.
2. Host-key verification or TOFU trust for TELNET.
3. Secure transport claims. TELNET traffic is plaintext on the network.
4. Command automation, command approval workflow, AI execution or scheduled TELNET jobs.
5. Transcript storage.
6. Jump hosts, port forwarding or proxy chaining.
7. Windows release readiness.

## 5. Database Design

The current remote-access schema already anticipates TELNET:

- `connection_profiles.protocol` allows `ssh` and `telnet`.
- `remote_sessions.protocol` allows `ssh` and `telnet`.
- `connection_profiles` already requires TELNET rows to have `sftp_enabled = 0` and `strict_host_key_checking = 0`.
- `remote_sessions.host_key_id` is nullable, which fits TELNET.

P7 should not add new tables unless implementation proves a concrete need.

Expected TELNET profile shape:

| Field | TELNET rule |
| --- | --- |
| `protocol` | `telnet` |
| `port` | default `23`, still editable |
| `username` | optional for `authMethod = none`; required for `password` if the selected component needs it |
| `auth_method` | `password` first; `none` may be allowed if tests cover it |
| `password_credential_ref_id` | required only for password auth |
| `strict_host_key_checking` | always `0` |
| `sftp_enabled` | always `0` |
| `encoding` | default `utf-8`; allow future profile-level override if legacy devices need `latin1` |

Expected TELNET session shape:

| Field | TELNET rule |
| --- | --- |
| `session_kind` | `terminal` |
| `protocol` | `telnet` |
| `host_key_id` | `NULL` |
| `transcript_policy` | `metadata_only` |
| `negotiated_algorithms_json` | may store safe TELNET option names such as NAWS/terminal-type; never store credentials or output |
| `error_code` | stable TELNET error code, not raw socket/library text |

## 6. Backend Architecture

### 6.1 Module Boundaries

Recommended file map:

| File | Responsibility |
| --- | --- |
| `server/src/remote/telnetTransport.js` | Wrap the selected TELNET component and expose a narrow terminal adapter. |
| `server/src/remote/telnetConnectionTestService.js` | Connect/login test with stable result objects and metadata-only audit. |
| `server/src/remote/telnetTerminalService.js` | TELNET terminal lifecycle, credential lookup, session rows and audit rows. |
| `server/src/remote/remoteTerminalService.js` | Protocol-aware facade that keeps the existing WebSocket gateway stable and dispatches SSH/TELNET by profile protocol. |
| `server/src/remote/terminalWebSocket.js` | Keep the same WebSocket path and frame validation; add TELNET safe error codes. |
| `server/src/remote/connectionProfileService.js` | Allow TELNET profile creation/update with strict TELNET validation. |
| `server/src/index.js` | Wire services and routes; keep protocol details out of route handlers. |

The TELNET transport must return the same adapter shape as SSH terminal transport:

```js
{
  onData(listener),
  onClose(listener),
  write(data),
  resize({ cols, rows }),
  close(),
}
```

It must not expose a raw socket, raw library instance, credential, transcript buffer or protocol parser to callers.

### 6.2 Connection Test Contract

Add or extend the existing connection-test route so the UI can test by profile protocol:

```http
POST /api/remote/profiles/:profileId/test-connection
```

Successful TELNET response:

```json
{
  "status": "connected",
  "protocol": "telnet",
  "profileId": "profile-id",
  "host": "192.0.2.10",
  "port": 23,
  "authenticated": true,
  "sftpAvailable": false,
  "checkedAt": "2026-06-02T00:00:00.000Z"
}
```

Failure response details should use stable codes:

| Code | Meaning |
| --- | --- |
| `TELNET_CONNECTION_DISABLED` | Profile is disabled. |
| `TELNET_CONNECTION_FAILED` | TCP connect or TELNET negotiation failed. |
| `TELNET_LOGIN_FAILED` | Login prompt flow rejected or timed out. |
| `TELNET_CREDENTIAL_UNAVAILABLE` | Password reference exists but the OS vault did not return a secret. |
| `TELNET_UNSUPPORTED` | Profile shape is not allowed for TELNET. |

### 6.3 Terminal Token And WebSocket Contract

Keep the browser WebSocket protocol unchanged:

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

The existing path can remain:

```text
/api/remote/terminal?token=<one-time-token>
```

Internally, the terminal token should become protocol-aware through the profile row or token metadata. The WebSocket gateway should not care whether the session is SSH or TELNET; it only talks to `remoteTerminalService`.

TELNET-specific open errors should be safe-listed:

- `TELNET_CONNECTION_DISABLED`
- `TELNET_CREDENTIAL_UNAVAILABLE`
- `TELNET_CONNECTION_FAILED`
- `TELNET_LOGIN_FAILED`
- `TELNET_TERMINAL_OPEN_FAILED`
- `TELNET_UNSUPPORTED`
- `TERMINAL_TOKEN_INVALID`

## 7. Frontend Design

### 7.1 Profile Form

The connection profile form should add a protocol selector:

- default: `SSH`;
- optional advanced choice: `TELNET (legacy/plaintext)`;
- port defaults to `22` for SSH and `23` for TELNET;
- SFTP preset is hidden or forced off for TELNET;
- host-key confirmation UI is hidden for TELNET;
- saving TELNET requires a visible warning that password and terminal traffic are plaintext.

Suggested warning copy:

```text
TELNET 是明文协议。用户名、密码和终端内容可能被同网段监听。
仅在受控内网、隔离网络或历史设备兼容场景下使用。
```

### 7.2 Device Profile Card

For TELNET profiles:

- show badge `TELNET`;
- show `明文协议` warning copy;
- show `测试连接` and `打开终端`;
- hide or disable `SFTP 文件`;
- do not show SSH host-key confirmation state.

### 7.3 Terminal Modal

Reuse `src/components/Remote/TerminalWorkspace.tsx` with small label changes:

- header target label should show `user@host:port` when username exists, otherwise `host:port`;
- footer for TELNET should say `TELNET 终端内容不写入审计或数据库，但网络传输为明文。`;
- disconnect, close, resize and reconnect behavior should match SSH.

## 8. Security And Audit Rules

1. TELNET credentials are stored only in the OS credential vault.
2. TELNET passwords are sent to the remote host in plaintext because the protocol requires it; the UI must not imply otherwise.
3. TELNET terminal input/output is never written to SQLite, audit JSON, logs, screenshots, test snapshots or docs.
4. Audit records may store safe metadata only: device id, profile id, protocol, host, port, actor type, session id, outcome, stable error code and timestamps.
5. TELNET access is human-only. Any API used by AI, MCP, automation or scheduled jobs must be unable to request a TELNET terminal token.
6. The same loopback origin policy and WebSocket frame validation used for SSH must apply to TELNET.
7. Malformed WebSocket frames close the session and record a safe ended reason.

Recommended audit events:

| Event | Risk level | Detail |
| --- | --- | --- |
| `telnet.connection.tested` | `read-only` | host, port, authenticated boolean, stable outcome |
| `telnet.session.opened` | `read-only` | profile id, session id, dimensions, auth method |
| `telnet.session.closed` | `read-only` | reason and duration metadata |
| `telnet.session.failed` | `read-only` | stable error code only |

## 9. Testing And Acceptance

### 9.1 Automated Tests

Add tests before implementation:

| Test file | Coverage |
| --- | --- |
| `server/test/database/telnetTransport.test.js` | adapter shape, connect/login success, timeout, write, resize, close, safe errors |
| `server/test/database/telnetConnectionTestService.test.js` | profile validation, OS-vault lookup, metadata-only audit, stable failure codes |
| `server/test/database/telnetTerminalService.test.js` | token consumption, active session lifecycle, close reasons, no transcript persistence |
| `server/test/database/remoteProfilesApi.integration.test.js` | TELNET profile validation and route responses |
| `server/test/database/terminalWebSocket.test.js` | TELNET error safe-list and unchanged frame behavior |
| `server/test/database/remoteTerminalUiSource.test.js` | no SFTP button for TELNET, plaintext warning exists |

The test fixture may use the selected TELNET component to create a local disposable TELNET-like server. The fixture must not require a real production TELNET server.

### 9.2 macOS Acceptance

On macOS development host:

1. Build and database tests pass.
2. Create a TELNET profile with default port 23 and verify SFTP is forced off.
3. Store a password in the OS credential store and verify SQLite does not contain the secret.
4. Run connection test against a disposable TELNET target.
5. Open terminal, type input, receive output, resize, disconnect and reconnect.
6. Confirm audit rows contain metadata only.
7. Confirm existing SSH terminal and SFTP P5/P6 flows still pass after any shared terminal refactor.

### 9.3 Windows Release Gate

TELNET does not release on Windows until these pass on a Windows host:

1. Node.js 24 starts the backend and imports the selected TELNET component.
2. Windows Credential Manager stores, reads, overwrites and deletes TELNET passwords.
3. TELNET connection test works against a known reachable target.
4. Interactive terminal input/output/resize/disconnect/reconnect works in the packaged app.
5. Encoding and line endings are acceptable for common Windows test cases.
6. SSH terminal and SFTP flows still work after the TELNET changes.

## 10. Phased Implementation Plan

P7 should be split so the risky parts are isolated:

| Phase | Goal | Exit criteria |
| --- | --- | --- |
| P7-A | Component proof and profile validation | Selected component imported on Node 24; license decision recorded; TELNET profile validation tests pass. |
| P7-B | TELNET connection test | TELNET test route works with password/none auth and safe audit. |
| P7-C | Interactive TELNET terminal | WebSocket terminal opens, streams, resizes, closes and records metadata only. |
| P7-D | UI polish and regression acceptance | TELNET warning/UI complete; SSH/SFTP regressions pass; macOS acceptance recorded. |
| P7-E | Windows validation | Windows gate passes before any Windows-ready release statement. |

## 11. Implementation Guardrails

1. Do not edit the selected TELNET component source.
2. Do not expose raw TELNET sockets outside `telnetTransport.js`.
3. Do not merge TELNET behavior into `sshTransport.js`.
4. Do not add SFTP controls to TELNET profiles.
5. Do not add automated TELNET execution APIs.
6. Do not store terminal transcripts.
7. Do not claim secure transport for TELNET.
8. Do not mark Windows ready from macOS-only evidence.

## 12. Self-Review

- Scope is limited to TELNET profile, connection test and human interactive terminal.
- Database impact is intentionally small because the existing schema already allows TELNET.
- The component decision is explicit and gated by license/runtime verification.
- Security differences from SSH are visible in UI, service rules and audit.
- P7 phases can be converted into a detailed implementation plan after user review.
