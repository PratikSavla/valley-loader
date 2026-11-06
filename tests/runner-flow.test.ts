// SPDX-License-Identifier: AGPL-3.0-only
// Install-flow edge cases: two running profiles sharing the click cursor, Pause/Resume while work is in
// flight, extra clicks, Resume as "retry failed", the SMAPI row following the installed SMAPI, account checks.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NexusApiError } from '../src/main/nexus/api';
import { NEXUS_UNREACHABLE } from '../src/main/install/runner';
import { cleanupTempDirs } from './helpers/archive-fixtures';
import { buildFixtures, deferred, GAME, makeHarness, modLink, settleHarnesses, USER, type Fixtures, type Harness } from './helpers/runner-harness';

let fx: Fixtures;
beforeAll(async () => {
  fx = await buildFixtures();
});
afterAll(async () => {
  await settleHarnesses();
  await cleanupTempDirs();
});

const keyOf = (h: Harness, name: string, slug = 'testcol'): string => {
  const mod = h.store.requireProfile(slug).mods.find((m) => m.name === name);
  if (!mod) throw new Error(`no mod ${name}`);
  return mod.key;
};
const modOf = (h: Harness, name: string, slug = 'testcol') => h.store.requireMod(slug, keyOf(h, name, slug));
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/** A second profile ("other") built from the same collection archive. */
async function addSecondProfile(h: Harness): Promise<void> {
  h.client.summary = { ...fx.summary, slug: 'other', name: 'Other Collection' };
  await h.runner.resolveCollection('other');
  h.client.summary = fx.summary;
}

describe('two running profiles share the click cursor', () => {
  it('hands the cursor to the other running profile when the first has nothing left to click', async () => {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    await addSecondProfile(h);
    await h.runner.startInstall('testcol');
    await h.runner.startInstall('other');
    expect(h.store.transient.awaitingClick?.slug).toBe('testcol');
    expect(modOf(h, 'Alpha', 'other').status).toBe('needsClick');

    await h.runner.handleNxmUrl(modLink(101, 1001));
    await h.runner.handleNxmUrl(modLink(102, 2002));
    // testcol has no clicks left: the cursor moves to "other" and shows its first mod.
    expect(h.store.transient.awaitingClick).toMatchObject({ slug: 'other', key: keyOf(h, 'Alpha', 'other'), index: 1 });
    expect(h.win.shown.at(-1)).toMatchObject({ modId: 101, fileId: 1001 });
    await h.runner.idle();
    expect(h.store.requireProfile('testcol').running).toBe(false);
    expect(h.store.requireProfile('other').running).toBe(true);
    expect(h.store.transient.awaitingClick?.slug).toBe('other');
  });

  it('pausing the profile that holds the cursor moves it to the other running profile', async () => {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    await addSecondProfile(h);
    await h.runner.startInstall('testcol');
    await h.runner.startInstall('other');
    const closedBefore = h.win.closed;
    await h.runner.pauseInstall('testcol');
    expect(h.store.transient.awaitingClick).toMatchObject({ slug: 'other', key: keyOf(h, 'Alpha', 'other') });
    expect(h.win.closed).toBe(closedBefore);
    expect(h.store.requireProfile('other').running).toBe(true);
  });
});

describe('Pause and Resume while a click is still resolving', () => {
  it('a link that resolves after Pause does not download for the paused profile', async () => {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    await h.runner.startInstall('testcol');
    const gate = deferred();
    h.client.gate = gate.promise;
    const click = h.runner.handleNxmUrl(modLink(101, 1001));
    await h.runner.pauseInstall('testcol');
    gate.open();
    await click;
    await h.runner.idle();
    expect(modOf(h, 'Alpha').status).toBe('needsClick');
    expect(h.requests.some((u) => u.includes('101-1001'))).toBe(false);
  });

  it('after Resume the in-flight mod is not re-planned and the cursor never parks on an installed mod', async () => {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    await h.runner.startInstall('testcol');
    const gate = deferred();
    h.client.gate = gate.promise;
    const click = h.runner.handleNxmUrl(modLink(101, 1001));
    await h.runner.pauseInstall('testcol');
    await h.runner.startInstall('testcol');
    gate.open();
    await click;
    h.client.gate = undefined;
    await h.runner.idle();
    expect(modOf(h, 'Alpha').status).toBe('installed');
    expect(h.store.requireProfile('testcol').running).toBe(true);
    expect(h.store.transient.awaitingClick).toMatchObject({ key: keyOf(h, 'Beta Config') });
    await h.runner.handleNxmUrl(modLink(102, 2002));
    await h.runner.idle();
    expect(modOf(h, 'Beta Config').status).toBe('installed');
    expect(h.store.requireProfile('testcol').running).toBe(false);
  });

  it('a second click on a file that is already resolving is not called "a different file"', async () => {
    const h = await makeHarness(fx);
    const profile = await h.runner.resolveCollection('testcol');
    const alpha = modOf(h, 'Alpha');
    // Like SVE in tckf0m: the collection needs two files of the same mod.
    h.store.upsertProfile({ ...profile, mods: [...profile.mods, { ...alpha, key: 'nexus:101:1002', fileId: 1002, name: 'Alpha extra', order: 99 }] });
    await h.runner.startInstall('testcol');
    const gate = deferred();
    h.client.gate = gate.promise;
    const first = h.runner.handleNxmUrl(modLink(101, 1001));
    await h.runner.handleNxmUrl(`${modLink(101, 1001)}&again=1`);
    expect(h.store.transient.lastError).toMatch(/Alpha is already downloading, so the extra click was ignored/);
    expect(h.store.transient.lastError).not.toMatch(/different file/);
    gate.open();
    await first;
    await h.runner.handleNxmUrl(modLink(101, 5555));
    expect(h.store.transient.lastError).toMatch(/different file of Alpha/);
  });
});

describe('Resume retries failed mods', () => {
  it('turns failed mods back into work instead of doing nothing', async () => {
    const files = new Map(fx.files);
    const alphaUrl = [...files.keys()].find((u) => u.endsWith('/101-1001.zip')) ?? '';
    const alphaBuf = files.get(alphaUrl);
    files.delete(alphaUrl);
    const h = await makeHarness({ ...fx, files }, { premium: true });
    await h.runner.resolveCollection('testcol');
    await h.runner.startInstall('testcol');
    await h.runner.idle();
    expect(modOf(h, 'Alpha')).toMatchObject({ status: 'failed', error: expect.stringMatching(/HTTP 404/) });
    if (alphaBuf) files.set(alphaUrl, alphaBuf);
    await h.runner.startInstall('testcol');
    await h.runner.idle();
    expect(modOf(h, 'Alpha')).toMatchObject({ status: 'installed' });
    expect(modOf(h, 'Alpha').error).toBeUndefined();
  });
});

describe('the SMAPI row follows the installed SMAPI', () => {
  it('turns from "manual" into "installed" once SMAPI is updated, and back on a downgrade', async () => {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    await h.runner.startInstall('testcol');
    expect(modOf(h, 'SMAPI')).toMatchObject({ status: 'manual', error: 'Update SMAPI from smapi.io (needs 4.5.2)' });
    h.store.setTransient({ game: { ...GAME, smapiVersion: '4.5.2' } });
    await h.runner.refreshGame();
    expect(modOf(h, 'SMAPI').status).toBe('installed');
    expect(modOf(h, 'SMAPI').error).toBeUndefined();
    h.store.setTransient({ game: { ...GAME, smapiVersion: '4.5.1' } });
    await h.runner.refreshGame();
    expect(modOf(h, 'SMAPI').status).toBe('manual');
  });

  it('Resume re-checks an outdated-SMAPI row against a fresh detection', async () => {
    const h = await makeHarness(fx, { premium: true });
    await h.runner.resolveCollection('testcol');
    await h.runner.startInstall('testcol');
    await h.runner.idle();
    expect(modOf(h, 'SMAPI').status).toBe('manual');
    // Detection now reports 4.5.2, but nothing has refreshed the game yet.
    const detected = { ...GAME, smapiVersion: '4.5.2' };
    h.store.setTransient({ game: detected });
    h.store.updateMod('testcol', keyOf(h, 'SMAPI'), { status: 'manual' });
    await h.runner.startInstall('testcol');
    expect(modOf(h, 'SMAPI').status).toBe('installed');
  });
});

describe('account checks before installing', () => {
  it('re-validates the key when startup could not, so a Premium user is not asked to click', async () => {
    const h = await makeHarness(fx, { premium: true });
    h.store.setTransient({ user: undefined });
    h.client.validateImpl = async () => ({ ...USER, isPremium: true });
    await h.runner.resolveCollection('testcol');
    await h.runner.startInstall('testcol');
    await h.runner.idle();
    expect(h.client.validateCalls).toBe(1);
    expect(h.win.shown).toHaveLength(0);
    expect(modOf(h, 'Alpha').status).toBe('installed');
  });

  it('refuses to start (instead of silently using clicks) when Nexus cannot be reached', async () => {
    const h = await makeHarness(fx);
    h.store.setTransient({ user: undefined });
    h.client.validateImpl = async () => {
      throw new Error('fetch failed');
    };
    await h.runner.resolveCollection('testcol');
    await expect(h.runner.startInstall('testcol')).rejects.toThrow(NEXUS_UNREACHABLE);
    expect(h.store.requireProfile('testcol').running).toBe(false);
    const checks = await h.runner.runPrereqChecks();
    expect(checks.find((c) => c.id === 'apiKey')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/fetch failed/) });
  });

  it('stores a rejected key in the snapshot', async () => {
    const h = await makeHarness(fx);
    h.store.setTransient({ user: undefined });
    h.client.validateImpl = async () => {
      throw new NexusApiError('Invalid API key', 401, 'https://api.nexusmods.com/v1/users/validate.json');
    };
    const checks = await h.runner.runPrereqChecks();
    expect(h.store.snapshot().apiKeyError).toBe('Invalid API key');
    expect(checks.find((c) => c.id === 'apiKey')?.status).toBe('fail');
  });
});

describe('removing a profile', () => {
  it('waits for an install that kept going after Pause, leaving no folder behind', async () => {
    const h = await makeHarness(fx, { premium: true });
    const profile = await h.runner.resolveCollection('testcol');
    await h.runner.startInstall('testcol');
    await h.runner.pauseInstall('testcol');
    await h.runner.removeProfile('testcol');
    await h.runner.idle();
    expect(h.store.getProfile('testcol')).toBeUndefined();
    expect(await exists(profile.profileDir)).toBe(false);
    expect(await exists(join(h.userData, 'profiles'))).toBe(true);
  });
});
