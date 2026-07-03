// @ts-strict-ignore
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRenderer } from 'electron';

import type {
  GetBootstrapDataPayload,
  OpenFileDialogPayload,
  SaveFileDialogPayload,
} from './index';

const { version: VERSION, isDev: IS_DEV }: GetBootstrapDataPayload =
  ipcRenderer.sendSync('get-bootstrap-data');

// Auto-update state, mirrored from the main process. Main fires
// 'update-downloaded' once electron-updater has a newer release staged; the
// renderer's existing update banner reads these to offer "Update now".
let updateReady = false;
const updateReadyWaiters: Array<() => void> = [];
ipcRenderer.on('update-downloaded', () => {
  updateReady = true;
  updateReadyWaiters.splice(0).forEach(resolve => resolve());
});

contextBridge.exposeInMainWorld('Actual', {
  IS_DEV,
  ACTUAL_VERSION: VERSION,
  logToTerminal: console.log,
  ipcConnect: (
    func: (payload: {
      on: IpcRenderer['on'];
      emit: (name: string, data: unknown) => void;
    }) => void,
  ) => {
    func({
      on(name, handler) {
        return ipcRenderer.on(name, (_event, value) => handler(value));
      },
      emit(name, data) {
        return ipcRenderer.send('message', { name, args: data });
      },
    });
  },

  startSyncServer: () => ipcRenderer.invoke('start-sync-server'),

  stopSyncServer: () => ipcRenderer.invoke('stop-sync-server'),

  isSyncServerRunning: () => ipcRenderer.invoke('is-sync-server-running'),

  startOAuthServer: () => ipcRenderer.invoke('start-oauth-server'),

  relaunch: () => {
    void ipcRenderer.invoke('relaunch');
  },

  restartElectronServer: () => {
    void ipcRenderer.invoke('restart-server');
  },

  openFileDialog: (opts: OpenFileDialogPayload) => {
    return ipcRenderer.invoke('open-file-dialog', opts);
  },

  saveFile: async (
    contents: SaveFileDialogPayload['fileContents'],
    filename: SaveFileDialogPayload['defaultPath'],
    dialogTitle: SaveFileDialogPayload['title'],
  ) => {
    await ipcRenderer.invoke('save-file-dialog', {
      title: dialogTitle,
      defaultPath: filename,
      fileContents: contents,
    });
  },

  openURLInBrowser: (url: string) => {
    void ipcRenderer.invoke('open-external-url', url);
  },

  openInFileManager: (filepath: string) => {
    void ipcRenderer.invoke('open-in-file-manager', filepath);
  },

  openPathInDefaultApp: (filepath: string) => {
    return ipcRenderer.invoke('open-path-in-default-app', filepath);
  },

  onEventFromMain: (type: string, handler: (...args: unknown[]) => void) => {
    ipcRenderer.on(type, handler);
  },

  // Driven by electron-updater in the main process.
  isUpdateReadyForDownload: () => updateReady,
  waitForUpdateReadyForDownload: () =>
    new Promise<void>(resolve => {
      if (updateReady) {
        resolve();
      } else {
        updateReadyWaiters.push(resolve);
      }
    }),

  getServerSocket: async () => {
    return null;
  },

  setTheme: (theme: string) => {
    ipcRenderer.send('set-theme', theme);
  },

  moveBudgetDirectory: (
    currentBudgetDirectory: string,
    newDirectory: string,
  ) => {
    return ipcRenderer.invoke(
      'move-budget-directory',
      currentBudgetDirectory,
      newDirectory,
    );
  },

  reload: async () => {
    throw new Error('Reload not implemented in electron app');
  },

  applyAppUpdate: async () => {
    await ipcRenderer.invoke('apply-app-update');
  },
} satisfies typeof global.Actual);
