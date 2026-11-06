// SPDX-License-Identifier: AGPL-3.0-only
// Sandboxed preload (built as CommonJS: out/preload/index.cjs). Exposes ValleyApi as window.valley;
// every call is an ipcRenderer.invoke on a channel from IPC. Nothing else from Electron leaks out.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type ValleyApi } from '@shared/ipc';
import type { AppSnapshot } from '@shared/types';

const api: ValleyApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  onSnapshot: (listener) => {
    const wrapped = (_event: IpcRendererEvent, snapshot: AppSnapshot): void => listener(snapshot);
    ipcRenderer.on(IPC.snapshotPush, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC.snapshotPush, wrapped);
    };
  },
  runPrereqChecks: () => ipcRenderer.invoke(IPC.runPrereqChecks),
  completeOnboarding: () => ipcRenderer.invoke(IPC.completeOnboarding),
  dismissHint: (id) => ipcRenderer.invoke(IPC.dismissHint, id),
  setApiKey: (key) => ipcRenderer.invoke(IPC.setApiKey, key),
  clearApiKey: () => ipcRenderer.invoke(IPC.clearApiKey),
  pickGameFolder: () => ipcRenderer.invoke(IPC.pickGameFolder),
  registerNxmHandler: () => ipcRenderer.invoke(IPC.registerNxmHandler),
  openNexusLogin: () => ipcRenderer.invoke(IPC.openNexusLogin),
  resolveCollection: (input, opts) =>
    opts === undefined ? ipcRenderer.invoke(IPC.resolveCollection, input) : ipcRenderer.invoke(IPC.resolveCollection, input, opts),
  dismissPendingCollection: () => ipcRenderer.invoke(IPC.dismissPendingCollection),
  setActiveProfile: (slug) => ipcRenderer.invoke(IPC.setActiveProfile, slug),
  setModSelected: (slug, key, selected) => ipcRenderer.invoke(IPC.setModSelected, slug, key, selected),
  startInstall: (slug) => ipcRenderer.invoke(IPC.startInstall, slug),
  pauseInstall: (slug) => ipcRenderer.invoke(IPC.pauseInstall, slug),
  focusNexusWindow: () => ipcRenderer.invoke(IPC.focusNexusWindow),
  pickManualFile: (slug, key) => ipcRenderer.invoke(IPC.pickManualFile, slug, key),
  retryMod: (slug, key) => ipcRenderer.invoke(IPC.retryMod, slug, key),
  removeProfile: (slug) => ipcRenderer.invoke(IPC.removeProfile, slug),
  launchGame: (slug) => ipcRenderer.invoke(IPC.launchGame, slug),
  revealProfile: (slug) => ipcRenderer.invoke(IPC.revealProfile, slug),
  checkForUpdates: (slug) => (slug === undefined ? ipcRenderer.invoke(IPC.checkForUpdates) : ipcRenderer.invoke(IPC.checkForUpdates, slug)),
  applyUpdate: (slug) => ipcRenderer.invoke(IPC.applyUpdate, slug),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
};

contextBridge.exposeInMainWorld('valley', api);
