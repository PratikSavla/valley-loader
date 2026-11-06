// SPDX-License-Identifier: AGPL-3.0-only
// ipcMain handlers for every channel in IPC (src/shared/ipc.ts). Arguments are validated with zod and
// errors are rethrown as plain Error(message) so the renderer shows a readable message.
import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { PROJECT_LINK_PREFIXES } from '@shared/about';
import { resolve } from 'node:path';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import type { AppSnapshot, NexusUser, ProfileState } from '@shared/types';
import { normaliseGamePath } from './game/detect';
import type { Runner } from './install/runner';
import type { UpdateService } from './install/runner-updates';
import type { NexusAuth } from './nexus/auth';
import type { Store } from './state/store';

export interface IpcContext {
  store: Store;
  auth: NexusAuth;
  runner: Runner;
  updates: UpdateService;
  getMainWindow: () => BrowserWindow | undefined;
  /** file:// URL of the packaged renderer's index.html; the only page allowed to call IPC in production. */
  appUrl: string;
  /** Origin the renderer is served from in dev (ELECTRON_RENDERER_URL), else undefined (file://). */
  devOrigin?: string;
}

const EXTERNAL_HOSTS = ['nexusmods.com', 'smapi.io', 'stardewvalleywiki.com'];

function isProjectLink(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  return PROJECT_LINK_PREFIXES.some(
    (p) => url.hostname.toLowerCase() === p.host && (path === p.path.replace(/\/$/, '') || path.startsWith(p.path.endsWith('/') ? p.path : `${p.path}/`)),
  );
}

/** https URLs on nexusmods.com, smapi.io, stardewvalleywiki.com (or their subdomains), plus the project's own source/license pages. */
export function isAllowedExternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  return EXTERNAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) || isProjectLink(url);
}

const slug = z.string().trim().min(1).max(64);
const modKey = z.string().min(1).max(2048);

function parseArgs<T>(schema: z.ZodType<T>, args: unknown[], channel: string): T {
  const result = schema.safeParse(args);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`Invalid arguments for ${channel}: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'unknown'}`);
  }
  return result.data;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function registerNxm(): Promise<boolean> {
  // In dev (electron .) the OS must re-launch electron with our app path.
  if (process.defaultApp) {
    const entry = process.argv[1];
    if (entry === undefined) return false;
    return app.setAsDefaultProtocolClient('nxm', process.execPath, [resolve(entry)]);
  }
  return app.setAsDefaultProtocolClient('nxm');
}

export function isNxmRegistered(): boolean {
  if (process.defaultApp) {
    const entry = process.argv[1];
    return entry !== undefined && app.isDefaultProtocolClient('nxm', process.execPath, [resolve(entry)]);
  }
  return app.isDefaultProtocolClient('nxm');
}

async function pickGameFolder(ctx: IpcContext): Promise<string | undefined> {
  const win = ctx.getMainWindow();
  const options: Electron.OpenDialogOptions = {
    title: 'Choose your Stardew Valley folder',
    message: 'Pick "Stardew Valley" (or "Stardew Valley.app") — Valley Loader finds the right folder inside it.',
    properties: ['openDirectory', 'treatPackageAsDirectory'],
  };
  const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  const picked = res.filePaths[0];
  if (res.canceled || picked === undefined) return undefined;
  const gamePath = await normaliseGamePath(picked);
  if (gamePath === undefined) {
    // Thrown (not a sticky lastError) so every attempt shows the reason; undefined only ever means "cancelled".
    throw new Error(`"${picked}" doesn't contain Stardew Valley. Pick the "Stardew Valley" folder in your Steam library.`);
  }
  ctx.store.updateSettings({ gamePath });
  await ctx.runner.refreshGame();
  return gamePath;
}

async function setApiKey(ctx: IpcContext, key: string): Promise<NexusUser> {
  const user = await ctx.auth.setApiKey(key);
  ctx.store.setTransient({ hasApiKey: true, user, lastError: undefined, apiKeyError: undefined });
  return user;
}

async function clearApiKey(ctx: IpcContext): Promise<void> {
  await ctx.auth.clearApiKey();
  ctx.store.setTransient({ hasApiKey: false, user: undefined, rateLimit: undefined, apiKeyError: undefined });
}

const resolveOpts = z.object({ allowDowngrade: z.boolean().optional() }).strict();

function resolveCollection(ctx: IpcContext, args: unknown[]): Promise<ProfileState> {
  const [input, opts] = parseArgs(z.tuple([z.string().max(2048)]).rest(resolveOpts), args, IPC.resolveCollection);
  if (args.length > 2) throw new Error(`Invalid arguments for ${IPC.resolveCollection}: too many`);
  return ctx.runner.resolveCollection(input, opts?.allowDowngrade === true ? { allowDowngrade: true } : {});
}

/** checkForUpdates([] | [slug]) → the slug, or undefined for every profile. */
export function parseCheckForUpdatesArgs(args: unknown[]): string | undefined {
  const parsed = parseArgs(z.union([z.tuple([]), z.tuple([slug])]), args, IPC.checkForUpdates);
  return parsed.length === 0 ? undefined : parsed[0];
}

type Handler = (args: unknown[]) => unknown;

function handlers(ctx: IpcContext): Record<keyof typeof IPC, Handler | undefined> {
  const { store, runner, updates } = ctx;
  const oneSlug = (c: string, a: unknown[]): string => parseArgs(z.tuple([slug]), a, c)[0];
  const slugKey = (c: string, a: unknown[]): [string, string] => parseArgs(z.tuple([slug, modKey]), a, c);
  return {
    snapshot: (): AppSnapshot => store.snapshot(),
    snapshotPush: undefined,
    runPrereqChecks: () => runner.runPrereqChecks(),
    completeOnboarding: () => store.updateSettings({ onboardingComplete: true }),
    dismissHint: (a) => {
      const [id] = parseArgs(z.tuple([z.string().trim().min(1).max(100)]), a, IPC.dismissHint);
      const hints = store.settings.dismissedHints;
      if (!hints.includes(id)) store.updateSettings({ dismissedHints: [...hints, id] });
    },
    setApiKey: (a) => setApiKey(ctx, parseArgs(z.tuple([z.string().max(4096)]), a, IPC.setApiKey)[0]),
    clearApiKey: () => clearApiKey(ctx),
    pickGameFolder: () => pickGameFolder(ctx),
    registerNxmHandler: () => registerNxm(),
    openNexusLogin: () => runner.openNexusLogin(),
    resolveCollection: (a) => resolveCollection(ctx, a),
    dismissPendingCollection: () => runner.dismissPendingCollection(),
    setActiveProfile: (a) => store.setActive(oneSlug(IPC.setActiveProfile, a)),
    setModSelected: (a) => {
      const [s, k, sel] = parseArgs(z.tuple([slug, modKey, z.boolean()]), a, IPC.setModSelected);
      return runner.setModSelected(s, k, sel);
    },
    startInstall: (a) => runner.startInstall(oneSlug(IPC.startInstall, a)),
    pauseInstall: (a) => runner.pauseInstall(oneSlug(IPC.pauseInstall, a)),
    focusNexusWindow: () => runner.focusNexusWindow(),
    pickManualFile: (a) => runner.pickManualFile(...slugKey(IPC.pickManualFile, a)),
    retryMod: (a) => runner.retryMod(...slugKey(IPC.retryMod, a)),
    removeProfile: (a) => runner.removeProfile(oneSlug(IPC.removeProfile, a)),
    launchGame: (a) => runner.launchGame(oneSlug(IPC.launchGame, a)),
    revealProfile: (a) => runner.revealProfile(oneSlug(IPC.revealProfile, a)),
    checkForUpdates: (a) => updates.checkForUpdates(parseCheckForUpdatesArgs(a)),
    applyUpdate: (a) => updates.applyUpdate(oneSlug(IPC.applyUpdate, a)),
    openExternal: async (a) => {
      const [url] = parseArgs(z.tuple([z.string().max(2048)]), a, IPC.openExternal);
      if (!isAllowedExternalUrl(url)) throw new Error('Only Nexus Mods, SMAPI, Stardew wiki and Valley Loader project links can be opened.');
      await shell.openExternal(url);
    },
  };
}

/**
 * True when `url` is the file:// page `appUrl` (query/hash ignored). Paths are compared decoded, so a
 * percent-encoding difference (e.g. "Valley%20Loader.app") can't lock the app out of its own IPC.
 */
export function isSameFilePage(url: string, appUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(appUrl);
    return a.protocol === 'file:' && b.protocol === 'file:' && a.host === b.host && decodeURIComponent(a.pathname) === decodeURIComponent(b.pathname);
  } catch {
    return false;
  }
}

/**
 * Only the app's own page, in the main frame, may call IPC: in production exactly the packaged index.html (any
 * other file:// page, e.g. an HTML file dropped on the window, is refused); in dev the renderer's origin.
 */
export function isTrustedFrame(url: string, isMainFrame: boolean, ctx: Pick<IpcContext, 'appUrl' | 'devOrigin'>): boolean {
  if (!isMainFrame) return false;
  if (ctx.devOrigin !== undefined) {
    try {
      return new URL(url).origin === ctx.devOrigin;
    } catch {
      return false;
    }
  }
  return isSameFilePage(url, ctx.appUrl);
}

function isTrustedSender(event: IpcMainInvokeEvent, ctx: IpcContext): boolean {
  const frame = event.senderFrame;
  return frame !== null && isTrustedFrame(frame.url, frame === event.sender.mainFrame, ctx);
}

export function registerIpc(ctx: IpcContext): void {
  const table = handlers(ctx);
  for (const [name, fn] of Object.entries(table) as [keyof typeof IPC, Handler | undefined][]) {
    if (fn === undefined) continue;
    const channel = IPC[name];
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedSender(event, ctx)) throw new Error(`Blocked ${channel} from an untrusted page`);
      try {
        return await fn(args);
      } catch (err) {
        console.error(`[ipc] ${channel} failed`, err);
        throw new Error(errorMessage(err));
      }
    });
  }
}
