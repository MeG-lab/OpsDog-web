import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('chat remote shell keeps terminal collapsed without visible permission controls or autofocus', async () => {
  const [shellSource, chatAreaSource, inputAreaSource, terminalSource, styles] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/components/Chat/ChatRemotePermissionShell.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/components/Chat/ChatArea.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/components/Chat/InputArea.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/components/Remote/TerminalWorkspace.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/index.css'), 'utf8'),
  ]);

  assert.match(inputAreaSource, /onOpenRemoteDeviceTerminal/);
  assert.match(inputAreaSource, /devicePickerOpen/);
  assert.match(inputAreaSource, /deviceSearch/);
  assert.match(inputAreaSource, /fetchAssetDevicesExample/);
  assert.match(inputAreaSource, /loadRemoteDevices/);
  assert.match(inputAreaSource, /setAssetDevices/);
  assert.match(inputAreaSource, /listConnectionProfiles/);
  assert.match(inputAreaSource, /pickDefaultRemoteProfile/);
  assert.match(inputAreaSource, /remoteDevices/);
  assert.match(inputAreaSource, /filteredRemoteDevices/);
  assert.match(inputAreaSource, /chat-remote-picker-list/);
  assert.match(inputAreaSource, /chat-remote-picker-title/);
  assert.match(inputAreaSource, /chat-remote-picker-device-name/);
  assert.doesNotMatch(inputAreaSource, /CHAT_REMOTE_DEMO_DEVICES/);
  assert.doesNotMatch(inputAreaSource, /createDemoDevice/);
  assert.doesNotMatch(inputAreaSource, /isUsingDemoRemoteDevices/);
  assert.doesNotMatch(inputAreaSource, /chat-remote-picker-grid/);
  assert.doesNotMatch(inputAreaSource, /chat-remote-picker-card-kicker/);
  assert.doesNotMatch(inputAreaSource, /未填写 IP/);
  assert.doesNotMatch(inputAreaSource, /chat-remote-picker-demo-note/);
  assert.doesNotMatch(inputAreaSource, /当前使用演示设备/);
  assert.doesNotMatch(inputAreaSource, /<strong>设备功能<\/strong>/);
  assert.doesNotMatch(inputAreaSource, /<strong>\{device\.name/);
  assert.match(inputAreaSource, /搜索设备/);
  assert.match(inputAreaSource, /MonitorUp/);
  assert.match(chatAreaSource, /ChatRemotePermissionShell/);
  assert.match(chatAreaSource, /remoteTerminalSelection/);
  assert.match(chatAreaSource, /ChatRemoteTerminalSelection/);
  assert.match(chatAreaSource, /isSystemConversation/);

  for (const text of [
    '设备已连接',
    '可见终端',
    '断开连接',
    'L1 只读',
    'L2 执行时审批',
    'L3 完全自主',
  ]) {
    assert.match(shellSource, new RegExp(text));
  }

  assert.match(shellSource, /device: AssetDevice/);
  assert.match(shellSource, /profile: ConnectionProfile/);
  assert.match(shellSource, /createRemoteTerminalToken/);
  assert.match(shellSource, /trustSshHostKey/);
  assert.match(shellSource, /TerminalWorkspace/);
  assert.match(shellSource, /isExpanded/);
  assert.match(shellSource, /setIsExpanded/);
  assert.match(shellSource, /React\.useState\(false\)/);
  assert.match(shellSource, /remoteConnectionState/);
  assert.match(shellSource, /chat-remote-collapse-bar/);
  assert.match(shellSource, /chat-remote-connection-dot/);
  assert.match(shellSource, /chat-remote-terminal-panel/);
  assert.match(shellSource, /aria-expanded=\{isExpanded\}/);
  assert.match(shellSource, /SHOW_AI_PERMISSION_LEVELS\s*=\s*false/);
  assert.match(shellSource, /permissionLevel/);
  assert.match(shellSource, /setPermissionLevel/);
  assert.match(shellSource, /chat-remote-terminal-slide/);
  assert.doesNotMatch(shellSource, /onFocusTerminal/);
  assert.doesNotMatch(chatAreaSource, /onFocusTerminal/);
  assert.doesNotMatch(chatAreaSource, /handleRemoteTerminalFocus/);
  assert.doesNotMatch(inputAreaSource, /textareaRef\.current\?\.blur\(\)/);
  assert.match(shellSource, /autoFocus=\{false\}/);
  assert.match(terminalSource, /autoFocus\s*=\s*true/);
  assert.match(terminalSource, /if \(autoFocus\)/);
  assert.doesNotMatch(shellSource, /选择设备/);
  assert.doesNotMatch(shellSource, /chat-remote-device-sheet/);
  assert.doesNotMatch(shellSource, /chat-remote-device-grid/);
  assert.doesNotMatch(shellSource, /listConnectionProfiles/);
  assert.doesNotMatch(shellSource, /\bL0\b/);

  for (const className of [
    'chat-remote-shell',
    'chat-remote-collapse-bar',
    'chat-remote-connection-dot',
    'chat-remote-terminal-panel',
    'chat-remote-permission-levels',
    'chat-remote-permission-option',
    'chat-remote-hostkey-card',
    'chat-remote-picker-menu',
    'chat-remote-picker-title',
    'chat-remote-picker-search',
    'chat-remote-picker-list',
    'chat-remote-picker-card',
    'chat-remote-picker-device-name',
    'chat-remote-terminal-slide',
    'chat-remote-terminal-frame',
  ]) {
    assert.match(styles, new RegExp(`\\.${className}`));
  }
  assert.match(styles, /\.chat-remote-picker-list\s*{[^}]*flex-direction:\s*column/s);
  assert.match(styles, /\.chat-remote-picker-list\s*{[^}]*max-height:\s*156px/s);
  assert.match(styles, /\.chat-remote-picker-card\s*{[^}]*height:\s*54px/s);
  assert.match(styles, /\.chat-remote-picker-menu\s*{[^}]*width:\s*min\(440px,/s);
  assert.match(styles, /\.chat-remote-picker-card\s*{[^}]*display:\s*flex/s);
  assert.match(styles, /\.chat-remote-picker-device-name\s*{[^}]*font-weight:\s*500/s);
  assert.match(styles, /\.chat-remote-connection-dot\.connected\s*{[^}]*background:\s*#22c55e/s);
  assert.match(styles, /\.input-remote-btn\.connected\s*{[^}]*color:\s*#16a34a/s);
  assert.match(styles, /\.chat-remote-terminal-panel\.is-collapsed\s*{[^}]*height:\s*0/s);
  assert.doesNotMatch(styles, /chat-remote-picker-grid/);
  assert.doesNotMatch(styles, /chat-remote-picker-card-kicker/);
  assert.doesNotMatch(styles, /chat-remote-picker-demo-note/);
});
