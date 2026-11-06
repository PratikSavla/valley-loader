// SPDX-License-Identifier: AGPL-3.0-only
// The built-in Nexus Mods window. The user browses and clicks here themselves: we never inject scripts
// into Nexus pages or click anything (see CLAUDE.md). We only *observe* nxm:// links and downloads.
//
// nxm capture — what we chose and why (Electron 45):
// - `session.protocol.handle('nxm', …)` on the 'persist:nexus' partition session makes nxm a handled
//   scheme for that session only, so a Slow download click is served by our handler (empty 204) instead
//   of being handed to macOS. protocol.handle works for any scheme on a session; we do NOT call
//   protocol.registerSchemesAsPrivileged: nxm only needs to be intercepted, never to load content,
//   use storage/fetch/CORS or resolve relative URLs, so standard/secure privileges would add nothing.
// - Belt and braces: 'will-navigate' / 'will-frame-navigate' cancel any navigation to nxm:// (and to
//   other non-web schemes) and capture it, and setWindowOpenHandler denies nxm popups and captures them.
//   The same link can arrive through two of these paths, so identical links are de-duplicated for 2 s.
//
// Login heuristic (isLoggedIn): we read the partition's cookies for nexusmods.com and treat the user as
// signed in when there is a non-expired, non-empty cookie whose name looks like a session/auth cookie
// (contains "session", "auth", "member", "pass_hash", "jwt" or "token") and is not a known analytics /
// consent cookie. Anonymous visitors only get analytics/consent/cf cookies. This is a hint, not proof:
// the setup check shows it as a warning, never a hard failure.
//
// Hardening: the window shows third-party content (ads, a collection's 'browse' pages), so web permissions are
// denied except a tiny allowlist for Nexus itself, frames may only navigate to https, and popups to other sites
// only open in the system browser after the user agrees (or right away for the app's own help hosts).
import { BrowserWindow, dialog, session, shell, type Session, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { GAME_DOMAIN } from '@shared/types';
import { redactUrl, sanitizeFileName } from '../download/queue';
import { isAllowedExternalUrl } from '../ipc';
import { CAPTURED_DIR_NAME, type CapturedDownload, type NexusWindowLike, type ShowModArgs } from '../install/runner-types';
import { nexusFilePageUrl } from './nxm';

export const NEXUS_PARTITION = 'persist:nexus';
export const LOGIN_URL = 'https://users.nexusmods.com/auth/sign_in';
const DEDUPE_MS = 2000;
const AUTH_COOKIE = /session|auth|member|pass_hash|jwt|token/i;
const IGNORED_COOKIE = /^(_ga|_gid|_gcl|_fbp|__cf|cf_|_cfuvid|consent|cookie|ab_|euconsent|OptanonConsent)/i;

/** True for https URLs on nexusmods.com or a subdomain. */
export function isNexusUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (u.hostname === 'nexusmods.com' || u.hostname.endsWith('.nexusmods.com'));
  } catch {
    return false;
  }
}

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

/** Web permissions the Nexus window grants: only fullscreen and copy-to-clipboard, and only to nexusmods.com. */
export function nexusPermissionAllowed(permission: string, requestingUrl: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isNexusUrl(requestingUrl);
}

/** Where a page may navigate the window or a frame to (nxm:// is captured separately). */
export function isAllowedNavigation(url: string): boolean {
  return /^(https:|about:blank)/i.test(url);
}

/** Cookie-name heuristic described at the top of this file. */
export function looksLoggedIn(cookies: { name: string; value: string; expirationDate?: number }[], nowSeconds: number): boolean {
  return cookies.some(
    (c) =>
      c.value !== '' &&
      AUTH_COOKIE.test(c.name) &&
      !IGNORED_COOKIE.test(c.name) &&
      (c.expirationDate === undefined || c.expirationDate > nowSeconds),
  );
}

export class NexusWindow implements NexusWindowLike {
  #win: BrowserWindow | undefined;
  #session: Session | undefined;
  #title = 'Valley Loader — Nexus Mods';
  #confirmingExternal = false;
  readonly #nxmListeners = new Set<(url: string) => void>();
  readonly #downloadListeners = new Set<(d: CapturedDownload) => void>();
  readonly #recent = new Map<string, number>();

  constructor(private readonly downloadsDir: string) {}

  /** The partition session, set up once (must be called after app 'ready'). */
  session(): Session {
    if (this.#session) return this.#session;
    const ses = session.fromPartition(NEXUS_PARTITION);
    ses.protocol.handle('nxm', (request) => {
      this.#emitNxm(request.url);
      return new Response(null, { status: 204 });
    });
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      callback(nexusPermissionAllowed(permission, details.requestingUrl || wc.getURL()));
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => nexusPermissionAllowed(permission, requestingOrigin));
    ses.setDevicePermissionHandler(() => false);
    ses.on('will-download', (_event, item, contents) => {
      // A unique name in its own folder: a page can never choose a name that lands on a DownloadQueue cache file.
      const fileName = sanitizeFileName(item.getFilename() || 'download');
      const path = join(this.downloadsDir, CAPTURED_DIR_NAME, `${randomUUID().slice(0, 8)}-${fileName}`);
      item.setSavePath(path);
      const url = redactUrl(item.getURL());
      const page = contents.getURL();
      item.once('done', (_e, state) => {
        const ok = state === 'completed';
        const d: CapturedDownload = { path, url, fileName, ok };
        if (page !== '') d.pageUrl = redactUrl(page);
        if (!ok) d.error = `Download of ${fileName} ${state}`;
        for (const cb of this.#downloadListeners) cb(d);
      });
    });
    this.#session = ses;
    return ses;
  }

  onNxm(cb: (url: string) => void): () => void {
    this.#nxmListeners.add(cb);
    return () => this.#nxmListeners.delete(cb);
  }

  onDownload(cb: (download: CapturedDownload) => void): () => void {
    this.#downloadListeners.add(cb);
    return () => this.#downloadListeners.delete(cb);
  }

  async open(url: string, title?: string): Promise<void> {
    if (!/^https:\/\//i.test(url)) throw new Error(`Refusing to open a non-https page in the Nexus window: ${redactUrl(url)}`);
    await mkdir(join(this.downloadsDir, CAPTURED_DIR_NAME), { recursive: true });
    const win = this.#ensureWindow();
    this.#setTitle(title ?? 'Valley Loader — Nexus Mods');
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    try {
      await win.loadURL(url);
    } catch (err) {
      // ERR_ABORTED is normal when the page redirects or a download starts; anything else is real.
      const msg = (err as Error).message;
      if (!/ERR_ABORTED|\(-3\)/.test(msg)) throw new Error(`Could not open ${redactUrl(url)}: ${msg}`, { cause: err });
    }
  }

  async showMod(args: ShowModArgs): Promise<void> {
    const title = `Valley Loader — Mod ${args.index}/${args.total}: click Slow download for ${args.name}`;
    await this.open(nexusFilePageUrl(GAME_DOMAIN, args.modId, args.fileId), title);
  }

  async openLogin(): Promise<void> {
    await this.open(LOGIN_URL, 'Valley Loader — Sign in to Nexus Mods');
  }

  async isLoggedIn(): Promise<boolean | undefined> {
    const cookies = await this.session().cookies.get({ domain: 'nexusmods.com' });
    if (cookies.length === 0) return false;
    return looksLoggedIn(cookies, Date.now() / 1000);
  }

  focus(): void {
    if (!this.#win || this.#win.isDestroyed()) return;
    if (this.#win.isMinimized()) this.#win.restore();
    this.#win.show();
    this.#win.focus();
  }

  close(): void {
    if (this.#win && !this.#win.isDestroyed()) this.#win.close();
    this.#win = undefined;
  }

  #setTitle(title: string): void {
    this.#title = title;
    this.#win?.setTitle(title);
  }

  #emitNxm(url: string): void {
    const now = Date.now();
    for (const [u, at] of this.#recent) if (now - at > DEDUPE_MS) this.#recent.delete(u);
    if (this.#recent.has(url)) return;
    this.#recent.set(url, now);
    for (const cb of this.#nxmListeners) cb(url);
  }

  #ensureWindow(): BrowserWindow {
    if (this.#win && !this.#win.isDestroyed()) return this.#win;
    const win = new BrowserWindow({
      width: 1200,
      height: 860,
      minWidth: 800,
      minHeight: 600,
      title: this.#title,
      show: false,
      webPreferences: {
        partition: NEXUS_PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.session();
    win.on('page-title-updated', (event) => event.preventDefault());
    win.on('closed', () => {
      if (this.#win === win) this.#win = undefined;
    });
    this.#guard(win.webContents);
    this.#win = win;
    return win;
  }

  /** Cancels nxm/non-web navigations (capturing nxm) and routes popups. */
  #guard(contents: WebContents): void {
    const onNavigate = (event: { url: string; preventDefault: () => void }): void => {
      const url = event.url;
      if (/^nxm:/i.test(url)) {
        event.preventDefault();
        this.#emitNxm(url);
      } else if (!isAllowedNavigation(url)) {
        event.preventDefault();
        console.warn(`[nexus-window] blocked navigation to ${redactUrl(url)}`);
      }
    };
    contents.on('will-navigate', onNavigate);
    contents.on('will-frame-navigate', onNavigate);
    contents.setWindowOpenHandler(({ url }) => {
      if (/^nxm:/i.test(url)) {
        this.#emitNxm(url);
        return { action: 'deny' };
      }
      if (isNexusUrl(url)) {
        void this.#win?.loadURL(url).catch((err: unknown) => console.error(`[nexus-window] could not open ${redactUrl(url)}`, err));
        return { action: 'deny' };
      }
      if (/^https:\/\//i.test(url)) void this.#openExternal(url);
      return { action: 'deny' };
    });
  }

  /**
   * Popups to other sites open in the system browser: help hosts right away, anything else only after the user
   * agrees. Pages get no user gesture check from Electron, so a window.open loop yields at most one dialog.
   */
  async #openExternal(url: string): Promise<void> {
    if (isAllowedExternalUrl(url)) {
      await shell.openExternal(url).catch((err: unknown) => console.error(`[nexus-window] openExternal failed for ${redactUrl(url)}`, err));
      return;
    }
    const win = this.#win;
    if (this.#confirmingExternal || !win || win.isDestroyed()) {
      console.warn(`[nexus-window] blocked popup to ${redactUrl(url)}`);
      return;
    }
    this.#confirmingExternal = true;
    try {
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Open in browser', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `Open ${new URL(url).host} in your browser?`,
        detail: redactUrl(url),
      });
      if (response === 0) await shell.openExternal(url);
      else console.warn(`[nexus-window] user declined popup to ${redactUrl(url)}`);
    } catch (err) {
      console.error(`[nexus-window] could not open ${redactUrl(url)} in the browser`, err);
    } finally {
      this.#confirmingExternal = false;
    }
  }
}
