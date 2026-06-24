import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('terminal controls use the approved compact header and quiet status rail', async () => {
  const [component, workspace, css] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/components/Remote/TerminalWorkspace.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/components/Servers/ServersWorkspace.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/index.css'), 'utf8'),
  ]);

  const header = component.slice(component.indexOf('<header'), component.indexOf('</header>'));
  const footer = component.slice(component.indexOf('<footer'), component.indexOf('</footer>'));

  assert.match(header, /remote-terminal-actions/);
  assert.match(header, /remote-terminal-session-title/);
  assert.match(header, /\{profileLabel\} \(\{protocolLabel\}\)/);
  assert.match(header, /aria-label="断开连接"/);
  assert.match(header, /aria-label="关闭终端窗口"/);
  assert.match(header, /remote-terminal-icon-btn/);
  assert.doesNotMatch(header, />断开连接<\/button>/);
  assert.doesNotMatch(header, />关闭窗口<\/button>/);
  assert.doesNotMatch(footer, /断开连接/);
  assert.match(footer, /终端内容不写入审计或数据库/);
  assert.match(component, /visible\?: boolean/);
  assert.match(component, /active\?: boolean/);
  assert.match(component, /fitAddonRef/);
  assert.match(component, /visible[\s\S]{0,240}fitAddonRef\.current\.fit\(\)/);
  assert.match(css, /\.remote-terminal-actions/);
  assert.match(css, /\.remote-terminal-workspace\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.remote-terminal-canvas\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(workspace, /import\s+\{\s*createPortal\s*\}\s+from\s+'react-dom';/);
  assert.match(workspace, /RemoteAccessOverlay/);
  assert.match(workspace, /remoteTabs\.length > 0\s*&&\s*typeof document !== 'undefined'\s*\?\s*createPortal\([\s\S]*?<RemoteAccessOverlay[\s\S]*?document\.body/s);
  assert.match(workspace, /className=\{`remote-access-overlay-backdrop/);
  assert.doesNotMatch(workspace, /remote-terminal-backdrop[\s\S]{0,240}<TerminalWorkspace/);
});
