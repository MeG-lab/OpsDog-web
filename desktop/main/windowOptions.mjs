export const createMainWindowOptions = ({ preloadPath }) => ({
  title: 'OpsDog',
  width: 1440,
  height: 960,
  minWidth: 1100,
  minHeight: 720,
  autoHideMenuBar: true,
  show: false,
  frame: false,
  thickFrame: true,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    preload: preloadPath,
    sandbox: true,
  },
});
