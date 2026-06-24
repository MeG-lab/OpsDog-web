const { contextBridge, ipcRenderer } = require('electron');

const windowStateListeners = new Set();
let desktopWindowState = { maximized: false, focused: true };

const applyWindowState = (state) => {
  if (!state || typeof state !== 'object') return;
  desktopWindowState = {
    maximized: Boolean(state.maximized),
    focused: state.focused !== false,
  };
  for (const listener of [...windowStateListeners]) listener(desktopWindowState);
};

const invokeWindowCommand = (command) => ipcRenderer.invoke('desktop-window-command', command);

ipcRenderer.on('desktop-window-state-changed', (_event, state) => {
  applyWindowState(state);
});

const desktopInfo = Object.freeze({
  platform: process.platform,
  minimizeWindow: () => invokeWindowCommand('minimize'),
  toggleMaximizeWindow: () => invokeWindowCommand('toggle-maximize'),
  closeWindow: () => invokeWindowCommand('close'),
  getWindowState: () => desktopWindowState,
  onWindowStateChanged: (listener) => {
    if (typeof listener !== 'function') return () => undefined;
    windowStateListeners.add(listener);
    listener(desktopWindowState);
    return () => windowStateListeners.delete(listener);
  },
});

contextBridge.exposeInMainWorld('opsdogDesktop', desktopInfo);

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.setAttribute('data-desktop', 'electron');
  document.body.setAttribute('data-desktop', 'electron');
});
