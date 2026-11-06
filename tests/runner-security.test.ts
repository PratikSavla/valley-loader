// SPDX-License-Identifier: AGPL-3.0-only
// Integrity and consent: direct downloads, collection links from outside the app, window downloads for browse mods.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlannedMod } from '@shared/types';
import { cleanupTempDirs, makeTempDir } from './helpers/archive-fixtures';
import { buildFixtures, CDN, makeHarness, settleHarnesses, type Fixtures, type Harness } from './helpers/runner-harness';

let fx: Fixtures;
beforeAll(async () => {
  fx = await buildFixtures();
});
afterAll(async () => {
  await settleHarnesses();
  await cleanupTempDirs();
});

/** Adds extra mods (built from Alpha's entry) to the resolved test profile. */
function addMods(h: Harness, extra: Partial<PlannedMod>[]): void {
  const profile = h.store.requireProfile('testcol');
  const alpha = profile.mods.find((m) => m.name === 'Alpha');
  if (!alpha) throw new Error('no Alpha');
  const base: PlannedMod = { ...alpha, modId: undefined, fileId: undefined, md5: undefined, fileSize: undefined, logicalFilename: undefined, status: 'pending' };
  h.store.upsertProfile({ ...profile, mods: [...profile.mods, ...extra.map((e) => ({ ...base, ...e }) as PlannedMod)] });
}

const mod = (h: Harness, key: string): PlannedMod => h.store.requireMod('testcol', key);

describe('direct-URL mods', () => {
  it('refuses plain http and enforces the collection md5', async () => {
    const h = await makeHarness(fx, { premium: true });
    await h.runner.resolveCollection('testcol');
    addMods(h, [
      { key: 'direct:http', name: 'Plain', sourceType: 'direct', url: 'http://cdn.test/101-1001.zip', order: 50 },
      { key: 'direct:bad', name: 'Tampered', sourceType: 'direct', url: `${CDN}/101-1001.zip`, md5: '0'.repeat(32), order: 51 },
      { key: 'direct:good', name: 'Good', sourceType: 'direct', url: `${CDN}/101-1001.zip?copy=2`, md5: fx.md5.alpha, order: 52 },
    ]);
    await h.runner.startInstall('testcol');
    await h.runner.idle();
    expect(mod(h, 'direct:http')).toMatchObject({ status: 'failed', error: expect.stringMatching(/no https download URL/) });
    expect(h.requests.some((u) => u.startsWith('http://'))).toBe(false);
    expect(mod(h, 'direct:bad')).toMatchObject({ status: 'failed', error: expect.stringMatching(/md5/) });
    expect(mod(h, 'direct:good').status).toBe('installed');
  });
});

describe('collection links from outside the app', () => {
  it('only become a pending proposal; nothing is downloaded until the user confirms', async () => {
    const h = await makeHarness(fx);
    const url = 'nxm://stardewvalley/collections/testcol/revisions/3';
    await h.runner.handleNxmUrl(url);
    expect(h.store.snapshot().pendingCollection).toEqual({ slug: 'testcol', revision: 3, url });
    expect(h.store.profiles).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    await h.runner.resolveCollection(url);
    expect(h.store.getProfile('testcol')).toBeDefined();
    expect(h.store.snapshot().pendingCollection).toBeUndefined();
  });

  it('refuses to move a profile to an older revision without explicit permission', async () => {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    h.client.summary = { ...fx.summary, revision: 2 };
    await expect(h.runner.resolveCollection('testcol')).rejects.toThrow(/revision 3; going back to revision 2 needs your confirmation/);
    expect(h.store.requireProfile('testcol').revision).toBe(3);
    await h.runner.resolveCollection('testcol', { allowDowngrade: true });
    expect(h.store.requireProfile('testcol').revision).toBe(2);
  });
});

describe('browse mods downloaded in the Nexus window', () => {
  async function setup(extra: Partial<PlannedMod>): Promise<{ h: Harness; dir: string }> {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    addMods(h, [{ key: 'browse:x', name: 'Browsy', sourceType: 'browse', url: 'https://example.org/mods/browsy', order: -1, ...extra }]);
    await h.runner.startInstall('testcol');
    expect(h.store.transient.awaitingClick?.key).toBe('browse:x');
    return { h, dir: await makeTempDir('vl-captured-') };
  }

  it('rejects a download that does not match the collection md5, accepts the right one', async () => {
    const { h, dir } = await setup({ md5: fx.md5.gamma });
    const junk = join(dir, 'ad.zip');
    await writeFile(junk, 'drive-by');
    h.win.emitDownload({ path: junk, url: 'https://ads.example/ad.zip', fileName: 'ad.zip', ok: true });
    await h.runner.idle();
    expect(h.store.transient.lastError).toMatch(/isn't the file the collection expects for Browsy \(checksum mismatch\).*captured/);
    expect(mod(h, 'browse:x').status).toBe('needsClick');

    const good = join(dir, 'gamma.zip');
    await writeFile(good, fx.files.get(`${CDN}/103-3003.zip`) ?? Buffer.alloc(0));
    h.win.emitDownload({ path: good, url: 'https://example.org/files/gamma.zip', fileName: 'gamma.zip', ok: true });
    await h.runner.idle();
    expect(mod(h, 'browse:x').status).toBe('installed');
  });

  it('without md5 or size, only accepts a download started from the mod page\'s site', async () => {
    const { h, dir } = await setup({});
    const file = join(dir, 'gamma.zip');
    await writeFile(file, fx.files.get(`${CDN}/103-3003.zip`) ?? Buffer.alloc(0));
    h.win.emitDownload({ path: file, url: 'https://cdn.evil.example/g.zip', pageUrl: 'https://evil.example/page', fileName: 'g.zip', ok: true });
    await h.runner.idle();
    expect(h.store.transient.lastError).toMatch(/didn't come from the mod's download page/);
    expect(mod(h, 'browse:x').status).toBe('needsClick');
    h.win.emitDownload({ path: file, url: 'https://cdn.example.net/g.zip', pageUrl: 'https://example.org/mods/browsy', fileName: 'g.zip', ok: true });
    await h.runner.idle();
    expect(mod(h, 'browse:x').status).toBe('installed');
  });
});
