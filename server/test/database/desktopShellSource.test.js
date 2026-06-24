import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createMainWindowOptions } from '../../../desktop/main/windowOptions.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

test('desktop shell uses a frameless app-themed title strip with window controls', async () => {
  const [appSource, titlebarSource, cssSource, preloadSource, mainSource] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/App.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/components/DesktopTitleBar.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/index.css'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'desktop/preload/index.cjs'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'desktop/main/index.mjs'), 'utf8'),
  ]);
  const options = createMainWindowOptions({ preloadPath: '/preload/index.cjs' });

  assert.equal(options.title, 'OpsDog');
  assert.equal(options.frame, false);
  assert.equal(options.thickFrame, true);
  assert.equal(options.titleBarStyle, undefined);
  assert.equal(options.titleBarOverlay, undefined);
  assert.equal(options.autoHideMenuBar, true);
  assert.equal(options.webPreferences.preload, '/preload/index.cjs');

  assert.match(appSource, /<DesktopTitleBar \/>/);
  assert.match(titlebarSource, /window\.opsdogDesktop/);
  assert.match(titlebarSource, /useAppStore/);
  assert.match(titlebarSource, /opsdogDesktopIcon/);
  assert.match(titlebarSource, /minimizeWindow/);
  assert.match(titlebarSource, /toggleMaximizeWindow/);
  assert.match(titlebarSource, /closeWindow/);
  assert.match(titlebarSource, /onWindowStateChanged/);
  assert.match(titlebarSource, /OpsDog/);
  assert.match(cssSource, /\.desktop-titlebar/);
  assert.match(cssSource, /-webkit-app-region:\s*drag/);
  assert.match(cssSource, /background:\s*var\(--bg-sidebar\)/);
  assert.match(cssSource, /\.desktop-titlebar-controls/);
  assert.match(cssSource, /\.desktop-titlebar-control\.close:hover/);
  assert.doesNotMatch(cssSource, /--desktop-titlebar-bg/);
  assert.match(preloadSource, /data-desktop/);
  assert.match(preloadSource, /platform:\s*process\.platform/);
  assert.match(preloadSource, /ipcRenderer\.invoke\('desktop-window-command'/);
  assert.match(preloadSource, /onWindowStateChanged/);
  assert.match(mainSource, /ipcMain/);
  assert.match(mainSource, /desktop-window-command/);
  assert.match(mainSource, /window-state-changed/);
  assert.match(mainSource, /WINDOWS_APP_USER_MODEL_ID = 'com\.opsdog\.desktop'/);
  assert.match(mainSource, /setAppUserModelId\(WINDOWS_APP_USER_MODEL_ID\)/);
  assert.doesNotMatch(mainSource, /setTitleBarOverlay/);
});

test('remote access workspace stacks above the device editor modal', async () => {
  const cssSource = await readFile(path.join(PROJECT_ROOT, 'src/index.css'), 'utf8');
  const zIndexFor = (className) => {
    const match = cssSource.match(new RegExp(`\\.${className}\\s*\\{[\\s\\S]*?z-index:\\s*(\\d+)`));
    assert.ok(match, `missing z-index for ${className}`);
    return Number(match[1]);
  };

  const editorBackdropZIndex = zIndexFor('scripts-upload-modal-backdrop');
  assert.ok(zIndexFor('remote-access-overlay-backdrop') > editorBackdropZIndex);
});

test('sidebar brand uses the shield terminal logo and does not navigate workspaces', async () => {
  const sidebarSource = await readFile(path.join(PROJECT_ROOT, 'src/components/Sidebar.tsx'), 'utf8');
  const brandMark = sidebarSource.slice(
    sidebarSource.indexOf('className="sidebar-brand-mark"'),
    sidebarSource.indexOf('className="sidebar-brand-copy"'),
  );

  assert.match(sidebarSource, /Shield/);
  assert.match(sidebarSource, /SquareTerminal/);
  assert.match(brandMark, /Shield/);
  assert.match(brandMark, /SquareTerminal/);
  assert.doesNotMatch(sidebarSource, /handleGoHome/);
  assert.doesNotMatch(sidebarSource, /title="返回主页"/);
  assert.doesNotMatch(brandMark, /onClick/);
  assert.doesNotMatch(brandMark, /setActiveWorkspace\('chat'\)/);
  assert.doesNotMatch(brandMark, /MessageSquare/);
});

test('system settings workspace is reachable from sidebar and topbar shortcuts', async () => {
  const [sidebarSource, topbarSource, appSource, storeSource] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/components/Sidebar.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/components/TopBar.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/App.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/stores/index.ts'), 'utf8'),
  ]);

  assert.match(sidebarSource, /系统设置/);
  assert.match(sidebarSource, /setActiveWorkspace\('settings'\)/);
  assert.match(topbarSource, /openSettingsSection\('ai-model'\)/);
  assert.match(topbarSource, /openSettingsSection\('profile'\)/);
  assert.match(topbarSource, /openSettingsSection\('tools'\)/);
  assert.match(topbarSource, /setActiveSettingsSection\(section\)/);
  assert.match(topbarSource, /setActiveWorkspace\('settings'\)/);
  assert.match(appSource, /SystemSettingsWorkspace/);
  assert.match(appSource, /activeWorkspace === 'settings'/);
  assert.match(storeSource, /activeSettingsSection/);
});

test('more features workspace exposes mask calculator with disabled placeholders', async () => {
  const [sidebarSource, topbarSource, appSource, storeSource, persistenceSource, packageText] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/components/Sidebar.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/components/TopBar.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/App.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/stores/index.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/services/persistence.ts'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.match(sidebarSource, /更多功能/);
  assert.match(sidebarSource, /workspace-switch-btn-wide/);
  assert.match(sidebarSource, /setActiveWorkspace\('more'\)/);
  assert.match(sidebarSource, /disabled=\{feature\.disabled\}/);
  assert.match(sidebarSource, /aria-disabled=\{feature\.disabled/);
  assert.match(sidebarSource, /敬请期待/);
  assert.doesNotMatch(sidebarSource, /<small>可用<\/small>/);
  assert.doesNotMatch(sidebarSource, /预留/);
  ['掩码计算器', '智能巡检', '配置备份', '安全审查', '漏洞扫描', '知识库', '日志管理'].forEach((label) => {
    assert.match(sidebarSource, new RegExp(label));
  });
  ['智能巡检', '配置备份', '安全审查', '漏洞扫描', '知识库', '日志管理'].forEach((label) => {
    assert.match(sidebarSource, new RegExp(`label:\\s*'${label}'[\\s\\S]*?disabled:\\s*true`));
  });

  assert.match(appSource, /MaskCalculatorWorkspace/);
  assert.match(appSource, /activeWorkspace === 'more'/);
  assert.match(topbarSource, /更多功能/);
  assert.match(storeSource, /activeWorkspace:\s*'chat' \| 'scripts' \| 'overview' \| 'servers' \| 'settings' \| 'more'/);
  assert.match(persistenceSource, /value === 'more'/);
  assert.ok(packageJson.dependencies['ipaddr.js']);
});

test('desktop packaging scripts and builder config include the runtime template', async () => {
  const [packageText, builderText] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'electron-builder.yml'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(packageJson.main, 'desktop/main/index.mjs');
  assert.equal(packageJson.scripts['desktop:install-win-optionals'], 'npm install --include optional --os=win32 --cpu=x64 --ignore-scripts --force');
  assert.equal(packageJson.scripts['desktop:installers'], 'node scripts/prepare-desktop-installers.mjs');
  assert.equal(packageJson.scripts['desktop:prepare'], 'npm run desktop:icons && npm run desktop:installers && npm run build && node scripts/prepare-desktop-runtime.mjs');
  assert.equal(packageJson.scripts['package:windows'], 'npm run desktop:install-win-optionals && npm run desktop:prepare && electron-builder --win nsis --x64 && node scripts/clean-windows-release.mjs');
  assert.equal(packageJson.devDependencies.electron, '42.3.2');
  assert.equal(packageJson.devDependencies['electron-builder'], '26.8.1');
  assert.equal(packageJson.devDependencies['@electron/asar'], '4.2.0');
  assert.equal(packageJson.optionalDependencies['@napi-rs/keyring-win32-x64-msvc'], '^1.3.0');

  assert.match(builderText, /appId:\s*com\.opsdog\.desktop/);
  assert.match(builderText, /icon:\s*build\/icons\/opsdog\.ico/);
  assert.match(builderText, /from:\s*\.desktop-runtime/);
  assert.match(builderText, /to:\s*runtime-template/);
  assert.match(builderText, /from:\s*\.desktop-installers/);
  assert.match(builderText, /to:\s*installers/);
  assert.match(builderText, /asarUnpack:/);
  assert.match(builderText, /\*\*\/\*\.node/);
  assert.match(builderText, /npmRebuild:\s*false/);
  assert.match(builderText, /artifactName:\s*opsDog-\$\{version\}-\$\{arch\}\.\$\{ext\}/);
  assert.match(builderText, /include:\s*build\/installer\.nsh/);
  assert.doesNotMatch(builderText, /target:\s*portable/);
  assert.doesNotMatch(builderText, /^portable:/m);
});

test('desktop Windows installer assets are downloaded before packaging', async () => {
  const installerPrepareScript = await readFile(path.join(PROJECT_ROOT, 'scripts/prepare-desktop-installers.mjs'), 'utf8');

  assert.match(installerPrepareScript, /\.desktop-installers/);
  assert.match(installerPrepareScript, /node-lts-x64\.msi/);
  assert.match(installerPrepareScript, /python-x64\.exe/);
  assert.match(installerPrepareScript, /OPSDOG_NODE_INSTALLER_URL/);
  assert.match(installerPrepareScript, /OPSDOG_PYTHON_INSTALLER_URL/);
  assert.match(installerPrepareScript, /nodejs\.org\/dist\/index\.json/);
  assert.match(installerPrepareScript, /python\.org\/downloads\/windows/);
});

test('linux installer falls back to a CentOS 7 compatible Node tarball when rpm packages are incompatible', async () => {
  const [installScript, oneClickScript, packageScript] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'deploy/linux/install-linux.sh'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'deploy/linux/one-click-deploy-linux.sh'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'scripts/package-linux-deploy.mjs'), 'utf8'),
  ]);

  assert.match(installScript, /MIN_NODE_MAJOR=22/);
  assert.match(installScript, /NODE_TARBALL_VERSION="\$\{NODE_TARBALL_VERSION:-22\.22\.3\}"/);
  assert.match(installScript, /install_node_from_tarball\(\)/);
  assert.match(installScript, /node-v\$\{NODE_TARBALL_VERSION\}-linux-\$\{node_tarball_arch\}\.tar\.xz/);
  assert.match(installScript, /https:\/\/nodejs\.org\/dist\/v\$\{NODE_TARBALL_VERSION\}/);
  assert.match(installScript, /unofficial-builds\.nodejs\.org\/download\/release\/v\$\{NODE_TARBALL_VERSION\}/);
  assert.match(installScript, /linux-x64-glibc-217/);
  assert.match(installScript, /find_local_node_archive\(\)/);
  assert.match(installScript, /local_archive="\$\(find_local_node_archive "\$archive_name"\)"/);
  assert.match(installScript, /Using local Node\.js archive/);
  assert.match(installScript, /cp "\$local_archive" "\$\{temp_dir\}\/\$\{archive_name\}"/);
  assert.match(installScript, /install_node_from_local_glibc217_if_available\(\)/);
  assert.match(installScript, /install_node_from_local_glibc217_if_available && return 0/);
  assert.match(installScript, /configure_firewall\(\)/);
  assert.match(installScript, /firewall-cmd --state/);
  assert.match(installScript, /firewall-cmd --add-port="\$\{PORT\}\/tcp" --permanent/);
  assert.match(installScript, /firewall-cmd --reload/);
  assert.match(installScript, /configure_firewall/);
  assert.match(installScript, /export PATH="\/opt\/nodejs\/bin:\$PATH"/);
  assert.match(installScript, /run_root ln -sfn "\$node_install_dir" "\/opt\/nodejs"/);
  assert.match(installScript, /run_root "\$manager" install -y nodejs \|\| install_node_from_tarball/);
  assert.match(oneClickScript, /TEMP_DIR=""/);
  assert.match(oneClickScript, /trap '\[\[ -n "\$\{TEMP_DIR:-\}" \]\] && rm -rf "\$TEMP_DIR"' EXIT/);
  assert.match(oneClickScript, /copy_local_node_archives\(\)/);
  assert.match(oneClickScript, /node-v\*-linux-\*\.tar\.xz/);
  assert.match(oneClickScript, /cp -f "\$archive" "\$extracted_dir\/"/);
  assert.match(oneClickScript, /display_host\(\)/);
  assert.match(oneClickScript, /log "URL: http:\/\/\$\(display_host\):\$PORT\/"/);
  assert.doesNotMatch(oneClickScript, /log "URL: http:\/\/\$HOST:\$PORT\/"/);
  assert.doesNotMatch(oneClickScript, /local package_file temp_dir/);
  assert.match(packageScript, /node:\s*'>=22\.22\.0'/);
  assert.match(packageScript, /COPYFILE_DISABLE:\s*'1'/);
  assert.match(packageScript, /xattr', \['-cr', bundleDir\]/);
  assert.match(packageScript, /\['--no-xattrs', '-czf', tarPath, packageName\]/);
});

test('desktop Windows package cleanup keeps only the distributable installer exe', async () => {
  const cleanupScript = await readFile(path.join(PROJECT_ROOT, 'scripts/clean-windows-release.mjs'), 'utf8');

  assert.match(cleanupScript, /opsDog-\$\{packageJson\.version\}-x64\.exe/);
  assert.match(cleanupScript, /release-desktop/);
  assert.match(cleanupScript, /rm\(path\.join\(releaseDirectory, entry\.name\)/);
  assert.match(cleanupScript, /withFileTypes:\s*true/);
  assert.match(cleanupScript, /entry\.name !== installerName/);
});

test('desktop Windows installer exposes optional Node and Python runtime setup', async () => {
  const installerScript = await readFile(path.join(PROJECT_ROOT, 'build/installer.nsh'), 'utf8');

  assert.match(installerScript, /customPageAfterChangeDir/);
  assert.match(installerScript, /MUI_PAGE_COMPONENTS/);
  assert.match(installerScript, /Section \/o "安装 Node\.js LTS"/);
  assert.match(installerScript, /Section \/o "安装 Python 3"/);
  assert.match(installerScript, /安装 Node\.js LTS/);
  assert.match(installerScript, /安装 Python 3/);
  assert.match(installerScript, /\$INSTDIR\\resources\\installers\\node-lts-x64\.msi/);
  assert.match(installerScript, /\$INSTDIR\\resources\\installers\\python-x64\.exe/);
  assert.match(installerScript, /ExecWait 'msiexec\.exe \/i/);
  assert.match(installerScript, /ExecWait '"\$INSTDIR\\resources\\installers\\python-x64\.exe"'/);
  assert.doesNotMatch(installerScript, /winget install/);
  assert.doesNotMatch(installerScript, /nodejs\.org\/en\/download/);
  assert.doesNotMatch(installerScript, /单独弹出|安装向导|卸载 OpsDog 时不会卸载|稍后从 OpsDog 安装目录/);
  assert.doesNotMatch(installerScript, /Page custom|nsDialogs::Create|NSD_CreateCheckbox|NSD_GetState/);
});

test('desktop settings do not expose an app uninstaller shortcut', async () => {
  const [settingsSource, preloadSource, mainSource, viteEnvSource] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'src/components/panels/SettingsPanel.tsx'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'desktop/preload/index.cjs'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'desktop/main/index.mjs'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'src/vite-env.d.ts'), 'utf8'),
  ]);

  assert.doesNotMatch(settingsSource, /openUninstaller|卸载 OpsDog|settings-desktop-card|settings-desktop-message/);
  assert.doesNotMatch(preloadSource, /openUninstaller|open-uninstaller/);
  assert.doesNotMatch(mainSource, /Uninstall OpsDog\.exe|openWindowsUninstaller|open-uninstaller/);
  assert.doesNotMatch(viteEnvSource, /openUninstaller/);
});

test('desktop icon assets provide a unified Windows app icon', async () => {
  const [svgSource, icoBuffer] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, 'build/icons/opsdog.svg'), 'utf8'),
    readFile(path.join(PROJECT_ROOT, 'build/icons/opsdog.ico')),
  ]);

  assert.match(svgSource, /opsdog-desktop-icon/);
  assert.match(svgSource, /shield/);
  assert.match(svgSource, /terminal/);
  assert.equal(icoBuffer.readUInt16LE(0), 0);
  assert.equal(icoBuffer.readUInt16LE(2), 1);
  assert.ok(icoBuffer.readUInt16LE(4) >= 4);
});
