// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  shell: {},
  session: {},
  BrowserWindow: class {},
}));

const { isAllowedExternalUrl, isTrustedFrame, parseCheckForUpdatesArgs } = await import('../src/main/ipc');
const { isAllowedNavigation, isNexusUrl, looksLoggedIn, nexusPermissionAllowed } = await import('../src/main/nexus/browser');
const { isAppUrl } = await import('../src/main/main-window');

const APP = 'file:///Applications/Valley%20Loader.app/Contents/Resources/app.asar/out/renderer/index.html';

describe('main window trust', () => {
  it('only lets the app page itself (main frame) call IPC in production', () => {
    const ctx = { appUrl: APP };
    expect(isTrustedFrame(APP, true, ctx)).toBe(true);
    expect(isTrustedFrame(`${APP}#/settings`, true, ctx)).toBe(true);
    expect(isTrustedFrame(APP.replace('%20', ' '), true, ctx)).toBe(true);
    expect(isTrustedFrame(APP, false, ctx)).toBe(false);
    expect(isTrustedFrame('file:///Users/me/Downloads/readme.html', true, ctx)).toBe(false);
    expect(isTrustedFrame('https://www.nexusmods.com/', true, ctx)).toBe(false);
  });

  it('matches the dev server by exact origin', () => {
    const ctx = { appUrl: APP, devOrigin: 'http://localhost:5173' };
    expect(isTrustedFrame('http://localhost:5173/index.html', true, ctx)).toBe(true);
    expect(isTrustedFrame('http://localhost:51730/', true, ctx)).toBe(false);
  });

  it('refuses every navigation away from the app page (e.g. a dropped HTML file)', () => {
    expect(isAppUrl(APP, undefined, APP)).toBe(true);
    expect(isAppUrl('file:///Users/me/Downloads/readme.html', undefined, APP)).toBe(false);
    expect(isAppUrl('http://localhost:5173/x', 'http://localhost:5173', APP)).toBe(true);
    expect(isAppUrl('http://localhost:5174/x', 'http://localhost:5173', APP)).toBe(false);
  });
});

describe('Nexus window hardening', () => {
  it('grants only fullscreen and clipboard writes, and only to nexusmods.com', () => {
    expect(nexusPermissionAllowed('fullscreen', 'https://www.nexusmods.com/stardewvalley')).toBe(true);
    expect(nexusPermissionAllowed('clipboard-sanitized-write', 'https://next.nexusmods.com/')).toBe(true);
    for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'hid']) {
      expect(nexusPermissionAllowed(p, 'https://www.nexusmods.com/')).toBe(false);
    }
    expect(nexusPermissionAllowed('fullscreen', 'https://ads.example/')).toBe(false);
  });

  it('lets frames navigate to https only', () => {
    expect(isAllowedNavigation('https://www.nexusmods.com/')).toBe(true);
    expect(isAllowedNavigation('about:blank')).toBe(true);
    expect(isAllowedNavigation('http://mirror.example/mod.zip')).toBe(false);
    expect(isAllowedNavigation('file:///etc/passwd')).toBe(false);
  });
});

describe('openExternal allowlist', () => {
  it.each([
    'https://www.nexusmods.com/stardewvalley/mods/2400',
    'https://next.nexusmods.com/settings/api-keys',
    'https://smapi.io',
    'https://stardewvalleywiki.com/Modding:Player_Guide',
    'https://github.com/pratiksavla/valley-loader',
    'https://github.com/pratiksavla/valley-loader/releases',
    'https://www.gnu.org/licenses/agpl-3.0.html',
  ])('allows %s', (url) => expect(isAllowedExternalUrl(url)).toBe(true));

  it.each([
    'http://www.nexusmods.com/',
    'https://evil-nexusmods.com/',
    'https://nexusmods.com.evil.io/',
    'https://user:pw@smapi.io/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
    'https://github.com/pratiksavla/valley-loader-evil',
    'https://github.com/someone-else/repo',
    'https://gist.github.com/pratiksavla/valley-loader',
    'https://www.gnu.org/philosophy/',
  ])('blocks %s', (url) => expect(isAllowedExternalUrl(url)).toBe(false));
});

describe('checkForUpdates arguments', () => {
  it('accepts no slug (every profile) or one slug', () => {
    expect(parseCheckForUpdatesArgs([])).toBeUndefined();
    expect(parseCheckForUpdatesArgs([' tckf0m '])).toBe('tckf0m');
  });

  it.each([[[42]], [['']], [['a', 'b']], [['x'.repeat(65)]], [[undefined]]])('rejects %j', (args) => {
    expect(() => parseCheckForUpdatesArgs(args)).toThrow(/Invalid arguments for valley:check-updates/);
  });
});

describe('Nexus window helpers', () => {
  it('recognises only https nexusmods.com pages', () => {
    expect(isNexusUrl('https://users.nexusmods.com/auth/sign_in')).toBe(true);
    expect(isNexusUrl('http://www.nexusmods.com/')).toBe(false);
    expect(isNexusUrl('https://nexusmods.com.example.org/')).toBe(false);
  });

  it('treats only live, non-analytics session-like cookies as signed in', () => {
    const now = 1000;
    expect(looksLoggedIn([{ name: '_ga', value: 'x' }, { name: 'cf_clearance', value: 'y' }], now)).toBe(false);
    expect(looksLoggedIn([{ name: 'nexusmods_session', value: '' }], now)).toBe(false);
    expect(looksLoggedIn([{ name: 'nexusmods_session', value: 'abc', expirationDate: 999 }], now)).toBe(false);
    expect(looksLoggedIn([{ name: 'nexusmods_session', value: 'abc', expirationDate: 5000 }], now)).toBe(true);
    expect(looksLoggedIn([{ name: 'member_id', value: '42' }], now)).toBe(true);
  });
});
