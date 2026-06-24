# Remote Terminal Compact Toolbar UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved compact toolbar layout to the P4-B interactive SSH terminal without changing its verified session behavior.

**Architecture:** Preserve the existing `TerminalWorkspace` session lifecycle and xterm canvas. Move the existing disconnect control into the header action group, keep feedback in a low-height status rail, and express the structural expectation with a lightweight repository test because this project does not currently include a frontend component-test runner.

**Tech Stack:** React 19, TypeScript, xterm.js, Vite CSS, Node.js 24 built-in test runner.

---

## Task 1: Lock The Approved Terminal Header Contract

**Files:**
- Create: `server/test/database/terminalWorkspaceUi.test.js`
- Read: `src/components/Remote/TerminalWorkspace.tsx`
- Read: `src/index.css`

- [x] **Step 1: Write the failing source-contract test**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('terminal controls use the approved compact header and quiet status rail', async () => {
  const [component, css] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/components/Remote/TerminalWorkspace.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/index.css'), 'utf8'),
  ]);

  const header = component.slice(component.indexOf('<header'), component.indexOf('</header>'));
  const footer = component.slice(component.indexOf('<footer'), component.indexOf('</footer>'));

  assert.match(header, /remote-terminal-actions/);
  assert.match(header, /断开连接/);
  assert.doesNotMatch(footer, /断开连接/);
  assert.match(footer, /终端内容不写入审计或数据库/);
  assert.match(css, /\.remote-terminal-actions/);
  assert.match(css, /\.remote-terminal-workspace\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.remote-terminal-canvas\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run:

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 server/test/database/terminalWorkspaceUi.test.js
```

Expected: FAIL because the current disconnect button is still rendered in the footer and `.remote-terminal-actions` does not exist.

## Task 2: Implement The Compact Toolbar Layout

**Files:**
- Modify: `src/components/Remote/TerminalWorkspace.tsx`
- Modify: `src/index.css`
- Test: `server/test/database/terminalWorkspaceUi.test.js`

- [x] **Step 1: Move the action into the header without changing handlers**

Change the header and footer shape to:

```tsx
<header className="remote-terminal-head">
  <div className="remote-terminal-identity">
    <strong>{profileLabel}</strong>
    <span>{targetLabel}</span>
  </div>
  <div className={`remote-terminal-status ${status}`}>
    <i />
    {statusLabel[status]}
  </div>
  <div className="remote-terminal-actions">
    <button type="button" className="btn btn-ghost danger" onClick={disconnect} disabled={status !== 'connected'}>
      断开连接
    </button>
    <button type="button" className="btn btn-ghost" onClick={onClose}>关闭窗口</button>
  </div>
</header>
<div ref={containerRef} className="remote-terminal-canvas" />
<footer className={`remote-terminal-foot${error ? ' has-error' : ''}`}>
  {error ? <span className="remote-terminal-error">{error}</span> : <span>终端内容不写入审计或数据库。</span>}
</footer>
```

- [x] **Step 2: Apply compact header and rail CSS**

Add or adjust rules for:

```css
.remote-terminal-identity {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 3px;
}

.remote-terminal-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.remote-terminal-foot {
  min-height: 34px;
  padding-block: 8px;
}

.remote-terminal-workspace,
.remote-terminal-canvas {
  min-width: 0;
  overflow: hidden;
}
```

Retain the existing terminal canvas, modal size, status color and danger button behavior. The width containment is required because xterm must not expand the header/canvas grid beyond the modal width.

- [x] **Step 3: Run focused and build verification**

Run:

```bash
/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin/node --test --test-concurrency=1 server/test/database/terminalWorkspaceUi.test.js
PATH="/Users/meteor/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH" npm run build:web
git diff --check
```

Expected: the UI contract test and build pass without diff whitespace errors.

- [x] **Step 4: Verify visually in Browser**

Open the known local application URL, open a configured SSH terminal, and verify:

1. Status, disconnect and close controls are visible together in the header.
2. The status rail does not compete with the terminal canvas.
3. The terminal reaches connected state and can disconnect normally.

- [x] **Step 5: Commit**

```bash
git add server/test/database/terminalWorkspaceUi.test.js src/components/Remote/TerminalWorkspace.tsx src/index.css docs/superpowers/specs/2026-05-27-remote-terminal-compact-toolbar-design.md docs/superpowers/plans/2026-05-27-remote-terminal-compact-toolbar-ui.md
git commit -m "fix: compact ssh terminal toolbar layout"
```
