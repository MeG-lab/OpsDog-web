import { app, BrowserWindow, dialog, ipcMain, Menu, shell, utilityProcess } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKEND_ORIGIN,
  startBackendProcess,
  stopBackendProcess,
} from './backendProcess.mjs';
import { prepareRuntimeWorkspace } from './runtimeWorkspace.mjs';
import { createMainWindowOptions } from './windowOptions.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.resolve(moduleDirectory, '../preload/index.cjs');
const WINDOWS_APP_USER_MODEL_ID = 'com.opsdog.desktop';
const DESKTOP_WINDOW_COMMAND_CHANNEL = 'desktop-window-command';
const DESKTOP_WINDOW_STATE_CHANNEL = 'desktop-window-state-changed';

let backendProcess = null;
let mainWindow = null;

const sourceRoot = () => (
  app.isPackaged
    ? path.join(process.resourcesPath, 'runtime-template')
    : path.resolve(moduleDirectory, '../..')
);

const serverEntry = () => (
  app.isPackaged
    ? path.join(app.getAppPath(), 'server/src/index.js')
    : path.resolve(moduleDirectory, '../../server/src/index.js')
);

const runtimeRoot = () => path.join(app.getPath('userData'), app.isPackaged ? 'runtime' : 'runtime-dev');

const isLocalReportDownload = (url) => (
  url.startsWith(`${BACKEND_ORIGIN}/api/reports/`) && url.includes('/download')
);

const windowStatePayload = (window) => ({
  maximized: window?.isMaximized?.() ?? false,
  focused: window?.isFocused?.() ?? false,
});

const emitWindowState = (window) => {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(DESKTOP_WINDOW_STATE_CHANNEL, windowStatePayload(window));
};

const registerWindowStateEvents = (window) => {
  for (const eventName of ['maximize', 'unmaximize', 'restore', 'focus', 'blur']) {
    window.on(eventName, () => emitWindowState(window));
  }
};

const registerDesktopWindowCommands = () => {
  ipcMain.handle(DESKTOP_WINDOW_COMMAND_CHANNEL, async (event, command) => {
    const window = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (!window || window.isDestroyed()) return { ok: false, error: '窗口不可用。' };

    if (command === 'minimize') {
      window.minimize();
      return { ok: true, state: windowStatePayload(window) };
    }

    if (command === 'toggle-maximize') {
      if (window.isMaximized()) {
        window.unmaximize();
      } else {
        window.maximize();
      }
      emitWindowState(window);
      return { ok: true, state: windowStatePayload(window) };
    }

    if (command === 'close') {
      window.close();
      return { ok: true };
    }

    return { ok: false, error: `未知桌面窗口命令：${String(command)}` };
  });
};

const createMainWindow = async () => {
  const window = new BrowserWindow(createMainWindowOptions({
    preloadPath,
  }));

  registerWindowStateEvents(window);
  window.once('ready-to-show', () => {
    emitWindowState(window);
    window.show();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalReportDownload(url)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== BACKEND_ORIGIN) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  await window.loadURL(BACKEND_ORIGIN);
  return window;
};

const launch = async () => {
  try {
    const preparedRuntimeRoot = await prepareRuntimeWorkspace({
      sourceRoot: sourceRoot(),
      runtimeRoot: runtimeRoot(),
    });
    backendProcess = await startBackendProcess({
      runtimeRoot: preparedRuntimeRoot,
      serverEntry: serverEntry(),
      forkProcess: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
      onLog: (message) => console.log(`[backend] ${message.trimEnd()}`),
    });
    mainWindow = await createMainWindow();
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'OpsDog 启动失败',
      message: error instanceof Error ? error.message : String(error),
    });
    app.quit();
  }
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerDesktopWindowCommands();

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
      Menu.setApplicationMenu(null);
    }
    return launch();
  });

  app.on('activate', () => {
    if (!mainWindow && backendProcess) void createMainWindow().then((window) => { mainWindow = window; });
  });

  app.on('before-quit', () => {
    stopBackendProcess(backendProcess);
    backendProcess = null;
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
