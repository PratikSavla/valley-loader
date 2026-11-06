// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { build7zaArchive, cleanupTempDirs, makeTempDir, writeRawRar } from './helpers/archive-fixtures';
import { buildFixtures, makeHarness, settleHarnesses, type Harness } from './helpers/runner-harness';

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

describe('RAR downloads (not supported)', () => {
  it('parks a RAR mod as "needs a file" with re-zip steps, then installs the .zip the user picks', async () => {
    const rarFx = await buildFixtures({ rarAlpha: true });
    const picked: { path?: string } = {};
    const h = await makeHarness(rarFx, { premium: true, pickArchive: async () => picked.path });
    await h.runner.resolveCollection('testcol');
    await h.runner.startInstall('testcol');
    await h.runner.idle();
    const parked = modOf(h, 'Alpha');
    expect(parked).toMatchObject({ status: 'manual', needsRepack: true });
    expect(parked.error).toMatch(/packed as a \.rar file/);
    expect(parked.error).toMatch(/Compress to make a \.zip/);
    expect(parked.error).toMatch(/Pick file…/);
    // The rest of the collection still installed.
    expect(modOf(h, 'Beta Config').status).toBe('installed');
    expect(h.store.requireProfile('testcol').running).toBe(false);

    // The user re-zips it; its md5 differs from the collection's, which is fine for a file they picked.
    picked.path = await build7zaArchive({ 'Alpha/manifest.json': '{"Name":"Alpha","UniqueID":"test.Alpha","Version":"1.0.0"}' }, 'zip');
    await h.runner.pickManualFile('testcol', keyOf(h, 'Alpha'));
    const done = modOf(h, 'Alpha');
    expect(done).toMatchObject({ status: 'installed' });
    expect(done.needsRepack).toBeUndefined();
    expect(done.error).toBeUndefined();
    expect(await modsFile(h, 'Alpha/manifest.json')).toContain('test.Alpha');
  });

  it('tells the user when the picked file is a RAR archive again', async () => {
    const rarFx = await buildFixtures({ rarAlpha: true });
    const rarPath = join(await makeTempDir('vl-rar-pick-'), 'again.rar');
    await writeRawRar(rarPath, [{ name: 'Alpha/manifest.json', data: '{}' }]);
    const h = await makeHarness(rarFx, { premium: true, pickArchive: async () => rarPath });
    await h.runner.resolveCollection('testcol');
    await h.runner.startInstall('testcol');
    await h.runner.idle();
    await expect(h.runner.pickManualFile('testcol', keyOf(h, 'Alpha'))).rejects.toThrow(/\.rar archive too/);
    expect(modOf(h, 'Alpha')).toMatchObject({ status: 'manual', needsRepack: true });
  });
});
