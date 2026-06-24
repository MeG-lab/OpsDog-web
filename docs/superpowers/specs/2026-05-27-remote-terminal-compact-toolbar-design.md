# OpsDog SSH Terminal Compact Toolbar Design

- Status: Approved by operator visual selection on 2026-05-27
- Scope: P4-B terminal modal UI refinement only
- Selected option: A - compact single-row toolbar

## Goal

Make the verified interactive SSH terminal easier to use by increasing the visible terminal area and clarifying session actions without changing connection, authentication, token, WebSocket, PTY or audit behavior.

## Approved Layout

The terminal modal keeps its existing three-region structure:

1. A compact header contains the profile name, target label, live status badge, `断开` action and `关闭` action.
2. The xterm canvas remains the dominant central surface.
3. A quiet status rail at the bottom shows the metadata-only safety notice, or a terminal connection error when one exists.

The `断开` action remains disabled until the terminal reaches connected state. Closing the window still disposes the terminal surface using the existing session cleanup path.
The grid workspace and terminal canvas are width-contained inside the modal so xterm measurement cannot push visible toolbar controls outside the modal boundary.

## Boundaries

This change may modify:

- `src/components/Remote/TerminalWorkspace.tsx`
- `src/index.css`
- A lightweight UI structure test

This change must not modify:

- SSH transport, authentication or host-key trust behavior
- One-time token or WebSocket frame protocol behavior
- SQLite session/audit persistence
- SFTP functionality

## Validation

1. A source-level UI contract test verifies that `断开连接` is rendered within the terminal header, the bottom rail contains only safety/error feedback, and the xterm canvas cannot expand the modal layout horizontally.
2. The frontend build must succeed under Node.js v24.16.0.
3. Browser inspection verifies that the toolbar is compact, controls remain available, and a real SSH session can still open and disconnect.

## Follow-On

After this UI refinement, the next product increment is P5 read-only SFTP browsing. It must reuse the existing SSH trust and credential rules, remain separate from terminal content, and retain the Windows release gate.
