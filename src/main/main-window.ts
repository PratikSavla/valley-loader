// SPDX-License-Identifier: AGPL-3.0-only
// The main app window: sandboxed renderer + CJS preload; no navigation away from the app, no popups
// (allow-listed https links open in the default browser instead).
import { BrowserWindow, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAllowedExternalUrl, isSameFilePage } from './ipc';

const PRELOAD = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));
const RENDERER_HTML = fileURLToPath(new URL('../renderer/index.html', import.meta.url));
/** The packaged renderer page: the only file:// URL the main window may show (and the only IPC sender). */
export const APP_URL = pathToFileURL(RENDERER_HTML).href;

/** The app is a single page loaded once, so any navigation except to itself (e.g. a dropped HTML file) is refused. */
export function isAppUrl(url: string, devUrl: string | undefined, appUrl: string = APP_URL): boolean {
  try {
    if (devUrl !== undefined) return new URL(url).origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
  return isSameFilePage(url, appUrl);
}

function openAllowedExternal(url: string): void {
  if (!isAllowedExternalUrl(url)) {
    console.warn(`[main-window] blocked external link to ${url.replace(/[?#].*$/, '')}`);
    return;
  }
  shell.openExternal(url).catch((err: unknown) => console.error(`[main-window] could not open ${url}`, err));
}

export function createMainWindow(): BrowserWindow {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    title: 'Valley Loader',
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  // The app's own page needs no web permissions (camera, notifications, …): refuse them all.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => {
    if (isAppUrl(event.url, devUrl)) return;
    event.preventDefault();
    openAllowedExternal(event.url);
  });
  const load = devUrl !== undefined ? win.loadURL(devUrl) : win.loadFile(RENDERER_HTML);
  load.catch((err: unknown) => console.error('[main-window] failed to load the renderer', err));
  return win;
}
