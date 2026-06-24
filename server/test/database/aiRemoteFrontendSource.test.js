import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('frontend wires active chat terminal sessions into AI remote command execution', async () => {
  const [
    contracts,
    runtimeTypes,
    runtimeIndex,
    webRuntime,
    planner,
    app,
    chatArea,
    inputArea,
    shell,
    terminalWorkspace,
  ] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/services/contracts.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/runtime/types.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/runtime/index.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/runtime/webRuntime.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/aiRemote/commandPlanner.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/App.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/components/Chat/ChatArea.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/components/Chat/InputArea.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/components/Chat/ChatRemotePermissionShell.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/components/Remote/TerminalWorkspace.tsx'), 'utf8'),
  ]);

  for (const symbol of ['AiRemoteExecuteRequest', 'AiRemoteExecuteResponse']) {
    assert.match(contracts, new RegExp(`export interface ${symbol}`));
  }
  assert.match(runtimeTypes, /executeAiRemoteCommands\(/);
  assert.match(runtimeIndex, /export const executeAiRemoteCommands/);
  assert.match(webRuntime, /executeAiRemoteCommands:\s*async/);
  assert.match(webRuntime, /\/remote\/ai\/execute/);

  assert.match(planner, /buildAiRemoteCommandPlan/);
  assert.match(planner, /summarizeAiRemoteCommandResult/);
  assert.match(planner, /commands/);
  assert.match(planner, /完全控制当前可见终端/);
  assert.match(planner, /不要输出 Markdown/);
  assert.match(planner, /精准回答用户原问题/);

  assert.match(chatArea, /remoteTerminalSessionId/);
  assert.match(chatArea, /remoteTerminalOutputTail/);
  assert.match(chatArea, /remoteTerminalOutputRef/);
  assert.match(chatArea, /waitForRemoteTerminalOutput/);
  assert.match(chatArea, /completionMarker/);
  assert.match(chatArea, /remoteTerminalConnectionState/);
  assert.match(chatArea, /onSessionReady/);
  assert.match(chatArea, /onSessionClosed/);
  assert.match(chatArea, /onOutput/);
  assert.match(chatArea, /remoteTerminalContext/);

  assert.match(app, /workspace-pane chat/);
  assert.match(app, /aria-hidden=\{activeWorkspace !== 'chat'\}/);
  assert.doesNotMatch(app, /activeWorkspace === 'chat'\s*\?\s*<ChatArea \/>/);

  assert.match(inputArea, /remoteTerminalContext/);
  assert.match(inputArea, /buildAiRemoteCommandPlan/);
  assert.match(inputArea, /summarizeAiRemoteCommandResult/);
  assert.match(inputArea, /waitForOutput/);
  assert.match(inputArea, /completionMarker/);
  assert.match(inputArea, /OPSDOG_AI_DONE/);
  assert.match(inputArea, /printf/);
  assert.match(inputArea, /executeAiRemoteCommands/);
  assert.match(inputArea, /AI 已下发到/);
  assert.match(inputArea, /执行结果概要/);

  assert.match(shell, /onSessionReady/);
  assert.match(shell, /onSessionClosed/);
  assert.match(shell, /onConnectionStateChange/);
  assert.match(shell, /连接已断开/);
  assert.match(shell, /onOutput/);
  assert.match(shell, /SHOW_AI_PERMISSION_LEVELS\s*=\s*false/);
  assert.match(shell, /autoFocus=\{false\}/);
  assert.doesNotMatch(shell, /onFocusTerminal/);
  assert.doesNotMatch(chatArea, /onFocusTerminal/);
  assert.doesNotMatch(inputArea, /textareaRef\.current\?\.blur\(\)/);
  assert.match(terminalWorkspace, /onReady/);
  assert.match(terminalWorkspace, /onOutput/);
  assert.match(terminalWorkspace, /onStatusChange/);
  assert.match(terminalWorkspace, /autoFocus\s*=\s*true/);
  assert.match(terminalWorkspace, /if \(autoFocus\)/);
});
