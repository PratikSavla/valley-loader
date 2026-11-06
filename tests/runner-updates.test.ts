// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CollectionSummary, PlannedMod, ProfileState } from '@shared/types';
import {
  ACTIVATE_DEBOUNCE_MS,
  STARTUP_DELAY_MS,
  UpdateService,
  cachedNexusKeys,
  revisionLink,
  type UpdateApiLike,
} from '../src/main/install/runner-updates';
import type { RevisionModFile, RevisionModFiles } from '../src/main/nexus/api-graphql';
import { NexusApiError } from '../src/main/nexus/api-http';
import { Store } from '../src/main/state/store';
import { cleanupTempDirs, makeTempDir } from './helpers/archive-fixtures';
import { buildFixtures, makeHarness, settleHarnesses, type Fixtures } from './helpers/runner-harness';

afterAll(async () => {
  await settleHarnesses();
  await cleanupTempDirs();
});
afterEach(() => {
  vi.useRealTimers();
});

const NOW = new Date('2026-11-06T12:00:00.000Z');

function nexusMod(name: string, modId: number, fileId: number, optional = false): PlannedMod {
  return {
    key: `nexus:${modId}:${fileId}`, name, version: '1.0.0', optional, selected: !optional, phase: 0, order: fileId,
    sourceType: 'nexus', modId, fileId, status: 'installed', warnings: [],
  };
}

function profile(slug: string, revision: number, extra: Partial<ProfileState> = {}): ProfileState {
  return {
    slug, revision, name: `Collection ${slug}`, author: 'curator', totalSize: 1, profileDir: `/tmp/${slug}`,
    modsDir: `/tmp/${slug}/Mods`, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), running: false,
    mods: [nexusMod('Alpha', 101, 1001), nexusMod('Beta', 102, 2002)], ...extra,
  };
}

const summary = (slug: string, revision: number): CollectionSummary => ({
  slug, revision, name: slug, author: 'curator', totalSize: 1, modCount: 2, adultContent: false, downloadLinkPath: '/x',
});

class FakeUpdateClient implements UpdateApiLike {
  latest = 3;
  failWith: Error | undefined;
  missingFileIds: number[] = [];
  collectionCalls = 0;
  readonly fileCalls: [string, number][] = [];
  files: RevisionModFile[] = [
    { fileId: 1001, modId: 101, optional: false, name: 'a.zip', version: '1.0.0', modName: 'Alpha' },
    { fileId: 2003, modId: 102, optional: false, name: 'b.zip', version: '1.1.0', modName: 'Beta' },
    { fileId: 3003, modId: 103, optional: false, name: 'c.zip', version: '0.1', modName: 'Gamma' },
  ];
  async getCollection(slug: string): Promise<CollectionSummary> {
    this.collectionCalls += 1;
    await Promise.resolve();
    if (this.failWith) throw this.failWith;
    return summary(slug, this.latest);
  }
  async getRevisionModFiles(slug: string, revision: number): Promise<RevisionModFiles> {
    this.fileCalls.push([slug, revision]);
    return { files: this.files, missingFileIds: this.missingFileIds };
  }
}

async function setup(profiles: ProfileState[] = [profile('col', 2)], opts: { busy?: boolean } = {}) {
  const userData = await makeTempDir('vl-updates-');
  const store = await Store.open(userData, { saveDelayMs: 5, emitIntervalMs: 0 });
  for (const p of profiles) store.upsertProfile(p);
  const client = new FakeUpdateClient();
  const resolved: string[] = [];
  const downloadsDir = join(userData, 'downloads');
  const clock = { now: NOW };
  const service = new UpdateService({
    store,
    client: () => client,
    resolve: async (input) => {
      resolved.push(input);
      const revision = Number(/\/revisions\/(\d+)$/.exec(input)?.[1]);
      return store.updateProfile('col', { revision, update: undefined });
    },
    isBusy: () => opts.busy === true,
    downloadsDir,
    now: () => clock.now,
  });
  return { store, client, service, resolved, userData, downloadsDir, clock };
}

describe('UpdateService.checkForUpdates', () => {
  it('stores a diff when a newer revision is published, and persists it', async () => {
    const { store, client, service, userData, downloadsDir } = await setup();
    await mkdir(downloadsDir, { recursive: true });
    await writeFile(join(downloadsDir, '103-3003-Gamma.zip'), 'cached');
    await service.checkForUpdates('col');
    expect(client.fileCalls).toEqual([['col', 3]]);
    const update = store.requireProfile('col').update;
    expect(update).toMatchObject({ latestRevision: 3, checkedAt: NOW.toISOString() });
    expect(update?.diff).toEqual({
      fromRevision: 2, toRevision: 3, unchanged: 1, removed: [],
      added: [{ name: 'Gamma', version: '0.1', modId: 103, fileId: 3003, optional: false }],
      changed: [{ name: 'Beta', fromVersion: '1.0.0', toVersion: '1.1.0', modId: 102 }],
      clicksNeeded: 1, // Beta's new file; Gamma is already in the download cache
    });
    await store.flush();
    const reopened = await Store.open(userData);
    expect(reopened.requireProfile('col').update).toEqual(update);
  });

  it('records an up-to-date check without a diff when the latest revision is the current one', async () => {
    const { store, client, service } = await setup();
    client.latest = 2;
    await service.checkForUpdates();
    expect(store.requireProfile('col').update).toEqual({ latestRevision: 2, checkedAt: NOW.toISOString() });
    expect(client.fileCalls).toEqual([]);
  });

  it('stores the error (keeping an update found earlier) instead of rejecting', async () => {
    const { store, client, service } = await setup();
    await service.checkForUpdates('col');
    const diff = store.requireProfile('col').update?.diff;
    client.failWith = new Error('fetch failed: offline');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(service.checkForUpdates()).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('[updates] col'), client.failWith);
    errors.mockRestore();
    const error = 'Something went wrong while checking Nexus Mods. Try again later.';
    expect(store.requireProfile('col').update).toEqual({ latestRevision: 3, checkedAt: NOW.toISOString(), diff, error });
  });

  it('stores a plain-language reason for network and server failures', async () => {
    const { store, client, service } = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    client.failWith = new NexusApiError('Could not reach Nexus Mods (https://x): fetch failed', 0, 'https://x');
    await service.checkForUpdates('col');
    expect(store.requireProfile('col').update?.error).toBe("Couldn't reach Nexus Mods. Check your internet connection.");
    client.failWith = new NexusApiError('HTTP 503 <html>', 503, 'https://x');
    await service.checkForUpdates('col');
    expect(store.requireProfile('col').update?.error).toMatch(/^Nexus Mods is not responding right now/);
    vi.mocked(console.error).mockRestore();
  });

  it('counts a pinned file deleted on Nexus as unchanged, not removed', async () => {
    const { store, client, service } = await setup();
    client.files = [{ fileId: 1001, modId: 101, optional: false, name: 'a.zip', version: '1.0.0', modName: 'Alpha' }];
    client.missingFileIds = [2002];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await service.checkForUpdates('col');
    expect(store.requireProfile('col').update?.diff).toMatchObject({ removed: [], unchanged: 2, unavailable: 1, clicksNeeded: 0 });
  });

  it('checks every profile and never runs two checks for one slug at once', async () => {
    const { store, client, service } = await setup([profile('col', 2), profile('other', 3)]);
    await Promise.all([service.checkForUpdates('col'), service.checkForUpdates('col'), service.checkForUpdates()]);
    expect(client.collectionCalls).toBe(2);
    expect(store.requireProfile('other').update).toEqual({ latestRevision: 3, checkedAt: NOW.toISOString() });
  });

  it('checks while installing (only applying is refused)', async () => {
    const { store, service } = await setup([profile('col', 2, { running: true })]);
    await service.checkForUpdates('col');
    expect(store.requireProfile('col').update?.latestRevision).toBe(3);
  });

  it('rejects an unknown slug', async () => {
    const { service } = await setup();
    await expect(service.checkForUpdates('nope')).rejects.toThrow(/No collection profile "nope"/);
  });
});

describe('UpdateService.applyUpdate', () => {
  it('refuses while the profile is installing or still finishing downloads', async () => {
    const running = await setup([profile('col', 2, { running: true })]);
    await running.service.checkForUpdates('col');
    await expect(running.service.applyUpdate('col')).rejects.toThrow(/Pause the install first/);
    expect(running.resolved).toEqual([]);
    const busy = await setup(undefined, { busy: true });
    await busy.service.checkForUpdates('col');
    await expect(busy.service.applyUpdate('col')).rejects.toThrow(/still finishing/);
  });

  it('refuses when no newer revision is known', async () => {
    const { service, client, resolved } = await setup();
    await expect(service.applyUpdate('col')).rejects.toThrow(/Check again/);
    client.latest = 2;
    await service.checkForUpdates('col');
    await expect(service.applyUpdate('col')).rejects.toThrow(/Check again/);
    expect(resolved).toEqual([]);
  });

  it('re-resolves at the previewed revision, then records a real check instead of a made-up one', async () => {
    const { store, service, resolved, client } = await setup();
    await service.checkForUpdates('col');
    const after = await service.applyUpdate('col');
    expect(resolved).toEqual([revisionLink('col', 3)]);
    expect(after.revision).toBe(3);
    expect(after.update).toBeUndefined();
    await vi.waitFor(() => expect(store.requireProfile('col').update).toEqual({ latestRevision: 3, checkedAt: NOW.toISOString() }));
    expect(client.collectionCalls).toBe(2);
  });

  it('goes to the newer revision an in-flight check finds, and keeps that check result', async () => {
    const { store, service, resolved, client, clock } = await setup();
    await service.checkForUpdates('col'); // finds 3
    client.latest = 4;
    clock.now = new Date(NOW.getTime() + 60_000);
    const checking = service.checkForUpdates('col'); // will find 4 while the update waits for it
    const after = await service.applyUpdate('col');
    await checking;
    expect(resolved).toEqual([revisionLink('col', 4)]);
    expect(after.revision).toBe(4);
    await service.checkForUpdates('col');
    expect(store.requireProfile('col').update).toEqual({ latestRevision: 4, checkedAt: clock.now.toISOString() });
  });
});

describe('applyUpdate through the real resolve path', () => {
  let fx: Fixtures;
  beforeAll(async () => {
    fx = await buildFixtures();
  });

  it('moves the profile to the new revision, keeps it active and starts nothing', async () => {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    const service = new UpdateService({
      store: h.store,
      client: () => ({
        getCollection: async () => ({ ...fx.summary, revision: 4 }),
        getRevisionModFiles: async () => ({ files: [], missingFileIds: [] }),
      }),
      resolve: (input) => h.runner.resolveCollection(input),
      isBusy: (slug) => h.runner.hasWorkInFlight(slug),
      downloadsDir: h.runner.downloadsDir,
      now: () => NOW,
    });
    await service.checkForUpdates('testcol');
    expect(h.store.requireProfile('testcol').update?.diff?.removed.map((r) => r.name).sort()).toEqual(['Alpha', 'Beta Config', 'Gamma', 'SMAPI']);
    h.client.summary = { ...fx.summary, revision: 4 };
    const after = await service.applyUpdate('testcol');
    expect(after).toMatchObject({ revision: 4, running: false });
    await vi.waitFor(() => expect(h.store.requireProfile('testcol').update).toEqual({ latestRevision: 4, checkedAt: NOW.toISOString() }));
    expect(h.store.activeSlug).toBe('testcol');
    expect(after.mods.filter((m) => m.selected && m.sourceType === 'nexus').every((m) => ['pending', 'manual'].includes(m.status))).toBe(true);
    expect(h.win.shown).toEqual([]);
    expect(h.client.calls).toEqual([]);
  });
});

describe('UpdateService schedule', () => {
  it('checks every profile shortly after start and a stale profile when it becomes active', async () => {
    vi.useFakeTimers({ now: NOW });
    const fresh = { latestRevision: 3, checkedAt: NOW.toISOString() };
    const stale = { latestRevision: 2, checkedAt: new Date(NOW.getTime() - 2 * 3600_000).toISOString() };
    const { store, client, service } = await setup([profile('col', 2, { update: stale }), profile('other', 3, { update: fresh })]);
    service.start();
    store.setActive('other');
    await vi.advanceTimersByTimeAsync(ACTIVATE_DEBOUNCE_MS + 10);
    expect(client.collectionCalls).toBe(0); // checked within the hour
    store.setActive('col');
    await vi.advanceTimersByTimeAsync(ACTIVATE_DEBOUNCE_MS + 10);
    expect(client.collectionCalls).toBe(1);
    // The diff step lists the download cache (real disk I/O), so wait for it rather than for timers.
    await vi.waitFor(() => expect(store.requireProfile('col').update?.latestRevision).toBe(3));
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(client.collectionCalls).toBe(3);
    service.dispose();
    await vi.advanceTimersByTimeAsync(7 * 3600_000);
    expect(client.collectionCalls).toBe(3);
  });
});

describe('cachedNexusKeys', () => {
  it('maps cached archive names to plan keys and ignores partial downloads', async () => {
    const dir = await makeTempDir('vl-cache-');
    await writeFile(join(dir, '101-1001-Alpha.zip'), 'x');
    await writeFile(join(dir, '102-2002-Beta.zip.part'), 'x');
    await writeFile(join(dir, 'direct-abc-file.zip'), 'x');
    expect(await cachedNexusKeys(dir)).toEqual(new Set(['nexus:101:1001']));
    expect(await cachedNexusKeys(join(dir, 'missing'))).toEqual(new Set());
  });
});
