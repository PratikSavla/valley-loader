// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { GameInfo, NexusUser, PrereqCheck, PrereqId } from '@shared/types';
import { PREREQ_BUTTON_LABELS, evaluatePrereqs, type PrereqInputs } from '../src/main/prereqs';

const GB = 1e9;
const game: GameInfo = { gamePath: '/Games/Stardew Valley/Contents/MacOS', gameVersion: '1.6.15', smapiInstalled: true, smapiVersion: '4.5.1' };
const freeUser: NexusUser = { userId: 7, name: 'Abigail', isPremium: false, isSupporter: false };
const premiumUser: NexusUser = { ...freeUser, isPremium: true };

function base(over: Partial<PrereqInputs> = {}): PrereqInputs {
  return {
    platform: 'darwin',
    arch: 'arm64',
    macosVersion: '26.1',
    game,
    smapiRequired: '4.0.0',
    freeDiskBytes: 100 * GB,
    neededDiskBytes: 0.5 * GB,
    hasApiKey: true,
    user: freeUser,
    nexusLoggedIn: true,
    nxmHandlerRegistered: true,
    ...over,
  };
}

function get(over: Partial<PrereqInputs>, id: PrereqId): PrereqCheck {
  const found = evaluatePrereqs(base(over)).find((c) => c.id === id);
  if (!found) throw new Error(`missing check ${id}`);
  return found;
}

function expectFixable(c: PrereqCheck): void {
  expect(c.fixSteps.length).toBeGreaterThan(0);
  for (const step of c.fixSteps) expect(step).not.toMatch(/^\d+[.)]/);
}

describe('evaluatePrereqs', () => {
  it('returns 7 checks in fixed order, all passing for a ready setup', () => {
    const checks = evaluatePrereqs(base());
    expect(checks.map((c) => c.id)).toEqual(['platform', 'game', 'smapi', 'disk', 'apiKey', 'nexusLogin', 'nxmHandler']);
    expect(checks.every((c) => c.status === 'pass' && c.fixSteps.length === 0)).toBe(true);
  });

  it('platform: shows macOS version and arch, fails elsewhere', () => {
    expect(get({}, 'platform').detail).toBe('macOS 26.1 on Apple silicon (arm64)');
    expect(get({ arch: 'x64' }, 'platform').detail).toContain('Intel (x64)');
    const win = get({ platform: 'win32' }, 'platform');
    expect(win.status).toBe('fail');
    expectFixable(win);
  });

  it('game: fails with folder picker when missing, passes with version + path, warns on pre-1.6', () => {
    const missing = get({ game: undefined }, 'game');
    expect(missing).toMatchObject({ status: 'fail', action: 'pickGameFolder' });
    expect(missing.fixSteps.join(' ')).toMatch(/Steam.*GOG/);
    expect(missing.fixSteps.join(' ')).toContain('Choose game folder');
    expect(get({}, 'game').detail).toBe('Found Stardew Valley 1.6.15 at /Games/Stardew Valley/Contents/MacOS');
    const old = get({ game: { ...game, gameVersion: '1.5.6' } }, 'game');
    expect(old.status).toBe('warn');
    expectFixable(old);
  });

  it('smapi: fails with install steps when missing, warns when too old, passes with version', () => {
    const missing = get({ game: { ...game, smapiInstalled: false, smapiVersion: undefined } }, 'smapi');
    expect(missing).toMatchObject({ status: 'fail', fixUrl: 'https://smapi.io' });
    const steps = missing.fixSteps.join(' ');
    expect(steps).toContain('install on macOS.command');
    expect(steps).toContain('Open Anyway');
    expect(steps).toContain('Re-check');
    expect(get({ game: undefined }, 'smapi').status).toBe('fail');

    // Play refuses an older SMAPI, so it is a hard failure, not an optional warning.
    const old = get({ smapiRequired: '4.6.0' }, 'smapi');
    expect(old.status).toBe('fail');
    expect(old.detail).toBe('SMAPI 4.5.1 is installed; your collection needs 4.6.0 or newer. Play is blocked until you update.');
    expectFixable(old);
    expect(get({ game: { ...game, smapiVersion: undefined } }, 'smapi').status).toBe('warn');

    expect(get({ smapiRequired: '4.5.1' }, 'smapi')).toMatchObject({ status: 'pass', detail: 'SMAPI 4.5.1 is installed' });
    expect(get({ smapiRequired: undefined }, 'smapi').status).toBe('pass');
  });

  it('disk: needs 2.5x the collection, warns under 1.5x that or when unknown', () => {
    const collection = 4 * GB; // needs 10 GB, comfortable at 15 GB
    expect(get({ neededDiskBytes: collection, freeDiskBytes: 9.9 * GB }, 'disk').status).toBe('fail');
    const tight = get({ neededDiskBytes: collection, freeDiskBytes: 12 * GB }, 'disk');
    expect(tight.status).toBe('warn');
    expect(tight.detail).toContain('12.0 GB free');
    expectFixable(tight);
    const ok = get({ neededDiskBytes: collection, freeDiskBytes: 15 * GB }, 'disk');
    expect(ok.status).toBe('pass');
    expect(ok.detail).toContain('10.0 GB needed');
    const unknown = get({ freeDiskBytes: undefined }, 'disk');
    expect(unknown.status).toBe('warn');
    expectFixable(unknown);
    expect(get({ neededDiskBytes: 0, freeDiskBytes: 1 * GB }, 'disk').status).toBe('fail');
  });

  it('apiKey: fails without a key or with an error, passes with name and tier', () => {
    const none = get({ hasApiKey: false, user: undefined }, 'apiKey');
    expect(none).toMatchObject({ status: 'fail', action: 'enterApiKey', fixUrl: 'https://next.nexusmods.com/settings/api-keys' });
    expect(none.fixSteps.join(' ')).toMatch(/Personal API Key.*Keychain/s);
    const bad = get({ apiKeyError: 'Invalid API key', user: undefined }, 'apiKey');
    expect(bad.status).toBe('fail');
    expect(bad.detail).toContain('Invalid API key');
    expectFixable(bad);
    expect(get({}, 'apiKey').detail).toBe('Signed in as Abigail (Free)');
    expect(get({ user: premiumUser }, 'apiKey').detail).toBe('Signed in as Abigail (Premium)');
  });

  it('apiKey: never stays "checking" once a validation attempt failed to reach Nexus', () => {
    expect(get({ user: undefined }, 'apiKey').status).toBe('pending');
    const offline = get({ user: undefined, apiKeyUnreachable: 'fetch failed' }, 'apiKey');
    expect(offline).toMatchObject({ status: 'warn', action: 'enterApiKey' });
    expect(offline.detail).toContain('fetch failed');
    expect(offline.fixSteps.join(' ')).toMatch(/internet connection.*"Re-check"/);
  });

  it('fix steps only name buttons that exist, with the labels the renderer draws', () => {
    const failing = evaluatePrereqs(
      base({ game: undefined, hasApiKey: false, user: undefined, nexusLoggedIn: false, nxmHandlerRegistered: false }),
    );
    for (const c of failing.filter((x) => x.action !== undefined)) {
      const action = c.action as keyof typeof PREREQ_BUTTON_LABELS;
      expect(c.fixSteps.join(' '), c.id).toContain(`"${PREREQ_BUTTON_LABELS[action]}"`);
    }
    const all = failing.flatMap((c) => c.fixSteps).join(' ');
    expect(all).toContain(`"${PREREQ_BUTTON_LABELS.help}"`);
    for (const stale of ['"Open help"', '"Enter API key"', 'press "Enter API key"']) expect(all).not.toContain(stale);
    const quotedPresses = [...all.matchAll(/[Pp]ress "([^"]+)"/g)].map((m) => m[1]);
    const ours = new Set<string>(Object.values(PREREQ_BUTTON_LABELS));
    const thirdParty = new Set(['Generate', 'Copy', 'Open Anyway']);
    for (const name of quotedPresses) expect(ours.has(name ?? '') || thirdParty.has(name ?? ''), name).toBe(true);
  });

  it('nexusLogin: premium passes without login, free warns until signed in', () => {
    expect(get({ user: premiumUser, nexusLoggedIn: undefined }, 'nexusLogin')).toMatchObject({
      status: 'pass',
      detail: 'Premium: downloads go straight through the API, no website clicks',
    });
    expect(get({ nexusLoggedIn: true }, 'nexusLogin').status).toBe('pass');
    for (const loggedIn of [false, undefined]) {
      const c = get({ nexusLoggedIn: loggedIn }, 'nexusLogin');
      expect(c).toMatchObject({ status: 'warn', action: 'openNexusLogin' });
      expect(c.fixSteps.join(' ')).toContain('Slow download');
    }
  });

  it('nxmHandler: warns with register action when not registered', () => {
    const c = get({ nxmHandlerRegistered: false }, 'nxmHandler');
    expect(c).toMatchObject({ status: 'warn', action: 'registerNxm' });
    expect(c.fixSteps.join(' ')).toMatch(/Safari or Chrome.*built-in Nexus window works without it/);
  });
});
