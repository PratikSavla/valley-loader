// SPDX-License-Identifier: AGPL-3.0-only
// App lifecycle: single instance, nxm open-url routing, store/auth/runner wiring, snapshot push.
import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { IPC } from '@shared/ipc';
import { detectGame } from './game/detect';
import { isSteamRunning, launchSmapi } from './game/launch';
import { Runner, type RunnerDeps } from './install/runner';
import { UpdateService } from './install/runner-updates';
import { isNxmRegistered, registerIpc } from './ipc';
import { APP_URL, createMainWindow } from './main-window';
import { ApiKeyVault, NexusAuth } from './nexus/auth';
import { NexusWindow } from './nexus/browser';
import { Store } from './state/store';

const run = promisify(execFile);

process.on('unhandledRejection', (reason) => console.error('[main] unhandled promise rejection', reason));
process.on('uncaughtException', (err) => console.error('[main] uncaught exception', err));

let mainWindow: BrowserWindow | undefined;
let runner: Runner | undefined;
let updates: UpdateService | undefined;
const pendingLinks: string[] = [];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    mainWindow.on('closed', () => (mainWindow = undefined));
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/** Mod links go to the runner; collection links become a proposal the main window asks the user about. */
function routeLink(url: string): void {
  if (!runner) {
    pendingLinks.push(url);
    return;
  }
  if (/^nxm:\/\/[^/]+\/collections\//i.test(url)) showMainWindow();
  runner.handleNxmUrl(url).catch((err: unknown) => {
    console.error('[main] could not handle nxm link', err);
    Store.get().setTransient({ lastError: errorMessage(err) });
  });
}

// macOS delivers nxm:// links (and files) via open-url, possibly before 'ready'.
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (/^nxm:/i.test(url)) routeLink(url);
});

function runnerDeps(store: Store, auth: NexusAuth, nexusWindow: NexusWindow, userData: string): RunnerDeps {
  return {
    store,
    userDataDir: userData,
    client: () => auth.client(),
    nexusWindow,
    home: app.getPath('home'),
    pickArchive: async (title) => {
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ['openFile'],
        filters: [
          { name: 'Mod archives', extensions: ['zip', '7z', 'rar'] },
          { name: 'All files', extensions: ['*'] },
        ],
      };
      const res = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      return res.canceled ? undefined : res.filePaths[0];
    },
    showItemInFolder: (path) => shell.showItemInFolder(path),
    openSteam: async () => {
      await run('/usr/bin/open', ['-a', 'Steam']);
    },
    isSteamRunning: () => isSteamRunning(),
    launchSmapi: (opts) => launchSmapi(opts),
    detectGame,
    macosVersion: async () => (await run('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim() || undefined,
    isNxmHandlerRegistered: () => isNxmRegistered(),
  };
}

/** Validate the saved key and detect the game in the background after the window is up. */
async function startupChecks(store: Store, auth: NexusAuth, r: Runner): Promise<void> {
  const game = r.refreshGame().catch((err: unknown) => {
    console.error('[main] game detection failed', err);
    store.setTransient({ lastError: `Could not look for Stardew Valley: ${errorMessage(err)}` });
  });
  if (auth.hasApiKey) {
    // A 401/403 lands in the snapshot's apiKeyError; anything else is retried by the setup check and by Start.
    const unreachable = await r.ensureUser();
    if (unreachable !== undefined) store.setTransient({ lastError: `Couldn't reach Nexus Mods to check your key: ${unreachable}` });
  }
  await game;
}

async function loadKey(store: Store, auth: NexusAuth): Promise<string | undefined> {
  try {
    store.setTransient({ hasApiKey: await auth.init() });
    return undefined;
  } catch (err) {
    console.error('[main] could not load the saved API key', err);
    store.setTransient({ hasApiKey: false, lastError: errorMessage(err) });
    return errorMessage(err);
  }
}

function installQuitFlush(store: Store): void {
  let flushed = false;
  app.on('before-quit', (event) => {
    if (flushed) return;
    event.preventDefault();
    updates?.dispose();
    runner?.dispose();
    store
      .flush()
      .catch((err: unknown) => console.error('[main] could not save state on quit', err))
      .finally(() => {
        flushed = true;
        app.quit();
      });
  });
}

async function main(): Promise<void> {
  const userData = app.getPath('userData');
  const store = await Store.init(userData);
  const auth = new NexusAuth(new ApiKeyVault(userData, safeStorage), { appVersion: app.getVersion() });
  const keyError = await loadKey(store, auth);
  const nexusWindow = new NexusWindow(join(userData, 'downloads'));
  nexusWindow.session();
  const r = new Runner(runnerDeps(store, auth, nexusWindow, userData));
  if (keyError !== undefined) store.setTransient({ apiKeyError: keyError });
  const u = new UpdateService({
    store,
    client: () => auth.client(),
    resolve: (input) => r.resolveCollection(input),
    isBusy: (slug) => r.hasWorkInFlight(slug),
    downloadsDir: r.downloadsDir,
  });
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  registerIpc({
    store,
    auth,
    runner: r,
    updates: u,
    getMainWindow: () => mainWindow,
    appUrl: APP_URL,
    ...(devUrl ? { devOrigin: new URL(devUrl).origin } : {}),
  });
  store.subscribe((snap) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.snapshotPush, snap);
  });
  installQuitFlush(store);
  showMainWindow();
  runner = r;
  updates = u;
  u.start();
  for (const url of pendingLinks.splice(0)) routeLink(url);
  await startupChecks(store, auth, r);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    showMainWindow();
    for (const arg of argv) if (/^nxm:\/\//i.test(arg)) routeLink(arg);
  });
  app.on('activate', () => {
    if (runner) showMainWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app
    .whenReady()
    .then(main)
    .catch((err: unknown) => {
      console.error('[main] startup failed', err);
      dialog.showErrorBox('Valley Loader could not start', errorMessage(err));
      app.exit(1);
    });
}
