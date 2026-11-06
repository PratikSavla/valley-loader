// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NEED_API_KEY, STEAM_STARTING } from '../src/main/install/runner';
import { cleanupTempDirs } from './helpers/archive-fixtures';
import { buildFixtures, makeHarness, modLink, NOW, settleHarnesses, type Fixtures, type Harness } from './helpers/runner-harness';

let fx: Fixtures;
beforeAll(async () => {
  fx = await buildFixtures();
});
afterAll(async () => {
  await settleHarnesses();
  await cleanupTempDirs();
});

const keyOf = (h: Harness, name: string): string => {
  const mod = h.store.requireProfile('testcol').mods.find((m) => m.name === name);
  if (!mod) throw new Error(`no mod ${name}`);
  return mod.key;
};
const modOf = (h: Harness, name: string) => h.store.requireMod('testcol', keyOf(h, name));
const modsFile = (h: Harness, rel: string): Promise<string> =>
  readFile(join(h.store.requireProfile('testcol').modsDir, rel), 'utf8');

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('resolveCollection', () => {
  it('downloads + parses the collection into an active profile with a rule-ordered plan', async () => {
    const h = await makeHarness(fx);
    const profile = await h.runner.resolveCollection('https://www.nexusmods.com/games/stardewvalley/collections/testcol');
    expect(profile.slug).toBe('testcol');
    expect(profile.profileDir).toBe(join(h.userData, 'profiles', 'testcol'));
    expect(profile.modsDir).toBe(join(profile.profileDir, 'Mods'));
    expect(await exists(profile.modsDir)).toBe(true);
    expect(profile.smapiRequirement).toBe('4.5.2');
    expect(profile.installInstructions).toBe('Have fun');
    expect(h.store.activeSlug).toBe('testcol');
    expect(profile.mods).toHaveLength(5);
    expect(modOf(h, 'Beta Config').order).toBeGreaterThan(modOf(h, 'Alpha').order);
    expect(modOf(h, 'Gamma')).toMatchObject({ optional: true, selected: false, status: 'skipped' });
    expect(await exists(join(profile.profileDir, 'collection-r3', 'collection.json'))).toBe(true);
  });

  it('refuses to fetch the archive without an API key', async () => {
    const h = await makeHarness(fx);
    h.client.hasApiKey = false;
    await expect(h.runner.resolveCollection('testcol')).rejects.toThrow(NEED_API_KEY);
    expect(h.store.profiles).toHaveLength(0);
  });
});

describe('free account install', () => {
  it('walks needsClick mods, matches nxm links, installs and deploys in load order', async () => {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    await h.runner.setModSelected('testcol', keyOf(h, 'Gamma'), true);
    await h.runner.startInstall('testcol');

    expect(modOf(h, 'SMAPI')).toMatchObject({ status: 'manual', error: 'Update SMAPI from smapi.io (needs 4.5.2)' });
    expect(['Alpha', 'Beta Config', 'Gamma'].map((n) => modOf(h, n).status)).toEqual(['needsClick', 'needsClick', 'needsClick']);
    expect(h.store.transient.awaitingClick).toMatchObject({ slug: 'testcol', key: keyOf(h, 'Alpha'), index: 1, total: 3 });
    expect(h.win.shown[0]).toMatchObject({ modId: 101, fileId: 1001, name: 'Alpha', index: 1, total: 3 });

    // Out-of-order click on Beta: resolved with key/expires right away, cursor stays on Alpha (now 2/3).
    await h.runner.handleNxmUrl(modLink(102, 2002));
    expect(h.client.calls[0]).toEqual({ domain: 'stardewvalley', modId: 102, fileId: 2002, key: 'k2002', expires: NOW + 3600 });
    expect(h.store.transient.awaitingClick).toMatchObject({ key: keyOf(h, 'Alpha'), index: 2, total: 3 });

    await h.runner.handleNxmUrl(modLink(101, 9999));
    expect(h.store.transient.lastError).toMatch(/different file of Alpha; the collection needs Alpha-1\.0\.0/);
    await h.runner.handleNxmUrl(modLink(101, 1001, { expires: NOW - 1 }));
    expect(h.store.transient.lastError).toMatch(/expired/);
    await h.runner.handleNxmUrl(modLink(101, 1001, { userId: 99 }));
    expect(h.store.transient.lastError).toMatch(/different Nexus account/);
    expect(modOf(h, 'Alpha').status).toBe('needsClick');
    expect(h.client.calls).toHaveLength(1);

    await h.runner.handleNxmUrl(modLink(101, 1001));
    await h.runner.handleNxmUrl(modLink(103, 3003));
    await h.runner.idle();

    for (const name of ['Marker', 'Alpha', 'Beta Config', 'Gamma']) expect(modOf(h, name).status).toBe('installed');
    expect(modOf(h, 'Alpha').installedFolders).toEqual(['Alpha']);
    expect(await modsFile(h, 'Alpha/config.json')).toBe('beta-config');
    expect(await modsFile(h, '[CP] Marker/content.json')).toBe('{}');
    expect(h.store.requireProfile('testcol').running).toBe(false);
    expect(h.store.transient.awaitingClick).toBeUndefined();
    expect(h.win.closed).toBeGreaterThan(0);
    expect(h.requests.every((u) => !u.includes('apikey'))).toBe(true);

    // Turning an installed optional mod off removes its files but keeps other mods' files in that folder.
    await h.runner.setModSelected('testcol', keyOf(h, 'Gamma'), false);
    expect(modOf(h, 'Gamma')).toMatchObject({ selected: false, status: 'skipped' });
    expect(modOf(h, 'Gamma').installedFolders).toBeUndefined();
    const mods = h.store.requireProfile('testcol').modsDir;
    expect(await exists(join(mods, 'Gamma', 'gamma.txt'))).toBe(false);
    expect(await modsFile(h, 'Gamma/config.json')).toBe('beta-config');
    await expect(h.runner.setModSelected('testcol', keyOf(h, 'Alpha'), false)).rejects.toThrow(/required/);

    // Re-installing from scratch reuses the md5-verified cache: no clicks, no API calls.
    await h.runner.removeProfile('testcol');
    expect(await exists(join(h.userData, 'profiles', 'testcol'))).toBe(false);
    await h.runner.resolveCollection('testcol');
    const shownBefore = h.win.shown.length;
    await h.runner.startInstall('testcol');
    await h.runner.idle();
    expect(modOf(h, 'Alpha').status).toBe('installed');
    expect(modOf(h, 'Beta Config').status).toBe('installed');
    expect(h.win.shown.length).toBe(shownBefore);
    expect(h.client.calls).toHaveLength(3);
  });

  it('ignores links for mods no collection is waiting for', async () => {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    await h.runner.handleNxmUrl(modLink(555, 1));
    expect(h.store.transient.lastError).toMatch(/isn't waiting in any of your collections/);
    expect(h.client.calls).toHaveLength(0);
  });

  it('pausing returns in-flight mods to needsClick and clears the cursor', async () => {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    await h.runner.startInstall('testcol');
    await h.runner.pauseInstall('testcol');
    await h.runner.idle();
    expect(h.store.requireProfile('testcol').running).toBe(false);
    expect(h.store.transient.awaitingClick).toBeUndefined();
    expect(modOf(h, 'Alpha').status).toBe('needsClick');
  });
});

describe('premium install', () => {
  it('downloads every Nexus mod through the API without clicks', async () => {
    const h = await makeHarness(fx, { premium: true });
    await h.runner.resolveCollection('testcol');
    await h.runner.startInstall('testcol');
    await h.runner.idle();
    expect(h.win.shown).toHaveLength(0);
    expect(h.client.calls.map((c) => c.modId).sort()).toEqual([101, 102]);
    expect(h.client.calls.every((c) => c.key === undefined && c.expires === undefined)).toBe(true);
    expect(modOf(h, 'Alpha').status).toBe('installed');
    expect(await modsFile(h, 'Alpha/config.json')).toBe('beta-config');
    expect(h.store.requireProfile('testcol').running).toBe(false);
  });

  it('applies the curator\'s patches and file lists before staging, warning about the ones it skips', async () => {
    const edited = await buildFixtures({ curatorEdits: true });
    const h = await makeHarness(edited, { premium: true });
    await h.runner.resolveCollection('testcol');
    await h.runner.setModSelected('testcol', keyOf(h, 'Gamma'), true);
    await h.runner.startInstall('testcol');
    await h.runner.idle();
    for (const name of ['Marker', 'Alpha', 'Beta Config', 'Gamma']) expect(modOf(h, name).status).toBe('installed');
    // Patch keyed "Marker Pack\\[CP] Marker\\content.json" found the bundled "[CP] Marker/content.json".
    expect(await modsFile(h, '[CP] Marker/content.json')).toBe('{"Changes":[]}');
    expect(modOf(h, 'Marker').warnings).toEqual([]);
    // Alpha's patch has the wrong CRC: skipped, file left as shipped, mod installed with a warning.
    expect(modOf(h, 'Alpha').warnings).toEqual([expect.stringMatching(/^Curator's edits: 1 of 1 file patch\(es\) not applied.*Alpha\/config\.json \(file differs/)]);
    expect(await modsFile(h, 'Alpha/manifest.json')).toMatch(/test\.Alpha/);
    // Gamma's file list only keeps its manifest: gamma.txt is not installed.
    expect(await modsFile(h, 'Gamma/manifest.json')).toMatch(/test\.Gamma/);
    expect(await exists(join(h.store.requireProfile('testcol').modsDir, 'Gamma', 'gamma.txt'))).toBe(false);
  });

  it('refuses to start Nexus downloads without an API key', async () => {
    const h = await makeHarness(fx, { premium: true });
    await h.runner.resolveCollection('testcol');
    h.client.hasApiKey = false;
    await expect(h.runner.startInstall('testcol')).rejects.toThrow(NEED_API_KEY);
    expect(h.store.requireProfile('testcol').running).toBe(false);
  });
});

describe('profiles and launching', () => {
  it('refuses to delete a profile folder outside <userData>/profiles', async () => {
    const h = await makeHarness(fx);
    const profile = await h.runner.resolveCollection('testcol');
    h.store.upsertProfile({ ...profile, profileDir: h.userData });
    await expect(h.runner.removeProfile('testcol')).rejects.toThrow(/Refusing to delete/);
    expect(await exists(join(h.userData, 'profiles', 'testcol', 'collection-r3', 'collection.json'))).toBe(true);
    expect(h.store.getProfile('testcol')).toBeDefined();
  });

  it('opens Steam first when the Steam build is not running, then launches SMAPI on the profile', async () => {
    const h = await makeHarness(fx);
    const profile = await h.runner.resolveCollection('testcol');
    h.store.updateProfile('testcol', { smapiRequirement: undefined });
    await expect(h.runner.launchGame('testcol')).rejects.toThrow(STEAM_STARTING);
    expect(h.steam.opened).toBe(1);
    expect(h.launches).toHaveLength(0);
    h.steam.running = true;
    await h.runner.launchGame('testcol');
    expect(h.launches).toEqual([{ gamePath: '/fake/steamapps/common/Stardew Valley/Contents/MacOS', modsDir: profile.modsDir }]);
  });

  it('blocks launch when SMAPI is older than the collection needs', async () => {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    h.steam.running = true;
    await expect(h.runner.launchGame('testcol')).rejects.toThrow(/needs SMAPI 4\.5\.2 or newer \(you have 4\.5\.1\)/);
    expect(h.launches).toHaveLength(0);
  });

  it('feeds setup checks from the environment', async () => {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    h.win.loggedIn = true;
    const checks = await h.runner.runPrereqChecks();
    expect(checks.map((c) => c.id)).toEqual(['platform', 'game', 'smapi', 'disk', 'apiKey', 'nexusLogin', 'nxmHandler']);
    const smapi = checks.find((c) => c.id === 'smapi');
    expect(smapi?.status).not.toBe('pass');
    expect(smapi?.detail).toMatch(/4\.5\.2/);
    expect(checks.find((c) => c.id === 'nexusLogin')?.status).toBe('pass');
    expect(checks.find((c) => c.id === 'nxmHandler')?.status).toBe('warn');
    expect(checks.find((c) => c.id === 'apiKey')?.detail).toMatch(/farmer/);
  });
});
