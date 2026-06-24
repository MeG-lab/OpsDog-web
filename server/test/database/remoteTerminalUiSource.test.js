import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const readSource = (relativePath) => readFileSync(
  path.resolve(import.meta.dirname, '../../..', relativePath),
  'utf8',
);

test('remote profile UI keeps TELNET simple without warnings or SFTP controls', () => {
  const source = readSource('src/components/Servers/ServersWorkspace.tsx');

  assert.match(source, /protocol: 'ssh' \| 'telnet'/);
  assert.match(source, /createRemoteTerminalToken/);
  assert.match(source, /testRemoteConnection/);
  assert.match(source, /profile\.protocol === 'ssh' && profile\.sftpEnabled/);
  assert.match(source, /TELNET.*用户名.*可留空/s);
  assert.match(source, /TELNET.*密码.*可留空/s);
  assert.doesNotMatch(source, /plaintextAcknowledged/);
  assert.doesNotMatch(source, /TELNET 是明文协议/);
  assert.doesNotMatch(source, /我已确认 TELNET/);
  assert.doesNotMatch(source, /明文风险/);
  assert.doesNotMatch(source, /profile\.protocol === 'telnet'[\s\S]{0,240}openSftp/);
});

test('remote profile feedback stays concise and remote password avoids browser password generators', () => {
  const source = readSource('src/components/Servers/ServersWorkspace.tsx');
  const successBlock = source.slice(
    source.indexOf('{sshResult ?'),
    source.indexOf('{telnetResult ?'),
  );
  const passwordBlock = source.slice(
    source.indexOf('className="profile-panel-field remote-profile-password"'),
    source.indexOf('className="remote-profile-options"'),
  );

  assert.match(source, /认证成功/);
  assert.match(source, /认证失败，请检查用户名或密码/);
  assert.doesNotMatch(source, /SSH 密码认证成功/);
  assert.doesNotMatch(source, /TELNET 密码认证成功/);
  assert.doesNotMatch(successBlock, /fingerprintSha256/);
  assert.doesNotMatch(successBlock, /SFTP 子系统/);
  assert.match(passwordBlock, /type="text"/);
  assert.match(passwordBlock, /autoComplete="off"/);
  assert.match(passwordBlock, /autoCorrect="off"/);
  assert.match(passwordBlock, /autoCapitalize="off"/);
  assert.match(passwordBlock, /spellCheck=\{false\}/);
  assert.match(passwordBlock, /remote-profile-secret-input/);
  assert.doesNotMatch(passwordBlock, /type="password"/);
});

test('server device cards do not nest action buttons inside native buttons', () => {
  const source = readSource('src/components/Servers/ServersWorkspace.tsx');

  assert.doesNotMatch(source, /<button[\s\S]{0,180}className="server-device-card"/);
  assert.match(source, /className="server-device-edit-btn"/);
});

test('server device cards open the detail drawer while edit remains explicit', () => {
  const source = readSource('src/components/Servers/ServersWorkspace.tsx');
  const styles = readSource('src/index.css');
  const drawerStyleBlock = styles.match(/\.server-device-drawer\s*\{[^}]*\}/)?.[0] || '';

  assert.match(source, /selectedDevice/);
  assert.match(source, /openDeviceDetails/);
  assert.match(source, /has-device-drawer/);
  assert.match(source, /className="servers-main-panel"/);
  assert.match(source, /className="server-device-drawer/);
  assert.match(source, /onClick=\{\(\) => openDeviceDetails\(device\)\}/);
  assert.match(source, /className="server-device-edit-btn"/);
  assert.match(source, /event\.stopPropagation\(\);[\s\S]{0,260}openEdit\(device\)/);
  assert.doesNotMatch(source, /const openDeviceDetails = \(device: AssetDevice\) => \{[\s\S]{0,240}openEdit\(device\)/);
  assert.doesNotMatch(source, /server-device-drawer[\s\S]{0,240}createPortal/);
  assert.doesNotMatch(source, /className="server-device-drawer-backdrop/);
  assert.match(styles, /\.server-device-drawer/);
  assert.notEqual(drawerStyleBlock, '');
  assert.match(styles, /\.servers-workspace\.has-device-drawer/);
  assert.match(styles, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(420px,\s*520px\)/);
  assert.match(styles, /@keyframes server-device-drawer-slide-in/);
  assert.doesNotMatch(styles, /\.server-device-drawer-backdrop/);
  assert.doesNotMatch(drawerStyleBlock, /backdrop-filter/);
});

test('remote access workspace opens terminal and SFTP sessions as tabs with simple split support', () => {
  const source = readSource('src/components/Servers/ServersWorkspace.tsx');
  const styles = readSource('src/index.css');
  const workspaceBlock = source.slice(
    source.indexOf('const ServersWorkspace'),
    source.indexOf('const DeviceDetailsDrawer'),
  );
  const profilesBlock = source.slice(
    source.indexOf('const RemoteAccessProfiles'),
    source.indexOf('const getRemoteAccessTabLabel'),
  );

  assert.match(source, /type RemoteAccessTab/);
  assert.match(source, /deviceId: string/);
  assert.match(source, /profileId: string/);
  assert.match(source, /profileLabel: string/);
  assert.match(source, /targetLabel: string/);
  assert.match(workspaceBlock, /const \[remoteTabs, setRemoteTabs\]/);
  assert.match(workspaceBlock, /const \[activeRemoteTabId, setActiveRemoteTabId\]/);
  assert.match(workspaceBlock, /const \[splitTabId, setSplitTabId\]/);
  assert.match(workspaceBlock, /const \[remoteAccessMinimized, setRemoteAccessMinimized\]/);
  assert.match(workspaceBlock, /renderRemoteTabContent/);
  assert.match(workspaceBlock, /RemoteAccessOverlay/);
  assert.match(workspaceBlock, /remote-access-session-dock/);
  assert.match(workspaceBlock, /await closeRemoteTabsForDevice\(deviceId\);[\s\S]{0,240}await deleteAssetDeviceRecord\(deviceId\)/);
  assert.doesNotMatch(profilesBlock, /const \[remoteTabs, setRemoteTabs\]/);
  assert.doesNotMatch(profilesBlock, /const \[activeRemoteTabId, setActiveRemoteTabId\]/);
  assert.doesNotMatch(profilesBlock, /const \[splitTabId, setSplitTabId\]/);
  assert.doesNotMatch(profilesBlock, /closeAllRemoteTabs\(\)/);
  assert.match(profilesBlock, /onOpenTerminal/);
  assert.match(profilesBlock, /onOpenSftp/);
  assert.match(profilesBlock, /onCloseProfileTabs/);
  assert.match(profilesBlock, /await onCloseProfileTabs\(profile\.id\);[\s\S]{0,240}await deleteConnectionProfile\(profile\.id\)/);
  assert.match(source, /RemoteAccessOverlay/);
  assert.match(source, /remote-access-tabbar/);
  assert.match(source, /remote-access-overlay/);
  assert.match(source, /onMinimize/);
  assert.match(source, /remote-access-icon-btn/);
  assert.match(source, /aria-label="最小化远程工作区"/);
  assert.match(source, /aria-label="关闭全部远程会话"/);
  assert.doesNotMatch(source, />最小化<\/button>/);
  assert.doesNotMatch(source, />关闭全部<\/button>/);
  assert.doesNotMatch(source, /<i>\{tab\.kind === 'sftp'/);
  assert.match(source, /createClientId\('remote-tab'\)/);
  assert.doesNotMatch(source, /crypto\.randomUUID\(\)/);
  assert.match(source, /remote-access-split/);
  assert.match(source, /kind: 'terminal'/);
  assert.match(source, /kind: 'sftp'/);
  assert.match(styles, /\.remote-access-overlay/);
  assert.match(styles, /\.remote-access-tabbar/);
  assert.match(styles, /\.remote-access-split/);
  assert.match(styles, /\.remote-access-session-dock/);
});

test('terminal workspace keeps protocol-neutral safety copy without changing frame helpers', () => {
  const source = readSource('src/components/Remote/TerminalWorkspace.tsx');

  assert.match(source, /protocol: 'ssh' \| 'telnet'/);
  assert.match(source, /createRemoteTerminalSocket/);
  assert.match(source, /终端内容不写入审计或数据库/);
  assert.doesNotMatch(source, /网络传输为明文/);
  assert.match(source, /sendTerminalFrameWhenReady/);
  assert.match(source, /createTerminalResizeFrame/);
});
