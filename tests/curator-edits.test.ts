// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { uniqueModKeys } from '../src/main/collection/plan';
import { parseCollectionJson } from '../src/main/collection/schema';
import { crc32Hex } from '../src/main/install/bspatch';
import { applyHashesFilter } from '../src/main/install/hashes';
import { walkFiles } from '../src/main/install/profile-fs';
import {
  applyCuratorEdits,
  collectionEntryFor,
  EDITS_WARNING_PREFIX,
  hashesWarning,
  mergeEditWarnings,
  patchesWarning,
} from '../src/main/install/runner-extras';
import { cleanupTempDirs, makeTempDir, writeTree } from './helpers/archive-fixtures';
import { naivePatch } from './helpers/bsdiff-fixtures';

afterAll(cleanupTempDirs);

const md5 = (text: string): string => createHash('md5').update(text).digest('hex');
const tree = async (root: string): Promise<string[]> => (await walkFiles(root)).map((f) => f.rel).sort();

const DLL = 'MZ fontsmasher binary';
const MANIFEST = '{"Name":"Font Smasher","UniqueID":"x.FontSmasher","Version":"2.0.0"}';

describe('applyHashesFilter (Vortex replicate mode)', () => {
  it('installs exactly the listed files at the listed paths, matched by md5 wherever they sit in the archive', async () => {
    const root = join(await makeTempDir('vl-hashes-'), 'out');
    await writeTree(root, { 'Font Smasher 2/FS/FontSmasher.dll': DLL, 'Font Smasher 2/FS/manifest.json': MANIFEST, 'Font Smasher 2/README.txt': 'hi' });
    const result = await applyHashesFilter(root, [
      { path: 'FontSmasher\\FontSmasher.dll', md5: md5(DLL) },
      { path: 'FontSmasher\\manifest.json', md5: md5(MANIFEST).toUpperCase() },
    ]);
    expect(result).toEqual({ mode: 'replicated', placed: 2, missing: [], dropped: 1 });
    expect(await tree(root)).toEqual(['FontSmasher/FontSmasher.dll', 'FontSmasher/manifest.json']);
    expect(await readFile(join(root, 'FontSmasher', 'FontSmasher.dll'), 'utf8')).toBe(DLL);
  });

  it('warns about listed files missing from the download but installs the rest; unsafe listed paths never escape', async () => {
    const base = await makeTempDir('vl-hashes-');
    const root = join(base, 'out');
    await writeTree(root, { 'FS/FontSmasher.dll': DLL });
    const result = await applyHashesFilter(root, [
      { path: 'FontSmasher\\FontSmasher.dll', md5: md5(DLL) },
      { path: 'FontSmasher\\manifest.json', md5: md5('another version') },
      { path: '..\\escape.dll', md5: md5(DLL) },
      { path: 'FontSmasher\\fast.bin', xxh64: 'AAAAAAAAAAA=' },
    ]);
    expect(result).toMatchObject({ mode: 'replicated', placed: 1, dropped: 0 });
    expect(result.missing).toEqual(['FontSmasher\\manifest.json', '..\\escape.dll', 'FontSmasher\\fast.bin']);
    expect(await tree(root)).toEqual(['FontSmasher/FontSmasher.dll']);
    await expect(stat(join(base, 'escape.dll'))).rejects.toThrow(/ENOENT/);
    expect(hashesWarning(result, 4)).toBe(
      `${EDITS_WARNING_PREFIX}3 of 4 listed file(s) were not in the download: FontSmasher\\manifest.json; ..\\escape.dll; FontSmasher\\fast.bin.`,
    );
  });

  it('keeps the download as extracted, with a warning, when nothing on the list matches or there are no md5s', async () => {
    const root = join(await makeTempDir('vl-hashes-'), 'out');
    await writeTree(root, { 'FS/FontSmasher.dll': 'different build', 'FS/manifest.json': MANIFEST.replace('2.0.0', '2.0.1') });
    const none = await applyHashesFilter(root, [{ path: 'FontSmasher\\FontSmasher.dll', md5: md5(DLL) }]);
    expect(none).toMatchObject({ mode: 'unchanged', placed: 0, reason: 'none of the listed files are in the download' });
    expect(await tree(root)).toEqual(['FS/FontSmasher.dll', 'FS/manifest.json']);
    expect(hashesWarning(none, 1)).toMatch(/installed everything in the download instead/);
    const xxh = await applyHashesFilter(root, [{ path: 'FS/FontSmasher.dll', xxh64: 'AAAAAAAAAAA=' }]);
    expect(xxh).toMatchObject({ mode: 'unchanged', reason: expect.stringMatching(/no md5/) });
    expect(await tree(root)).toEqual(['FS/FontSmasher.dll', 'FS/manifest.json']);
  });
});

describe('warnings', () => {
  it('lists skipped patches (capped) and replaces earlier curator-edit warnings on reinstall', () => {
    const skipped = Array.from({ length: 7 }, (_, i) => ({ path: `Mod\\f${i}.json`, reason: 'file not found in the download' }));
    const text = patchesWarning({ applied: ['a', 'b'], skipped }) ?? '';
    expect(text.startsWith(`${EDITS_WARNING_PREFIX}7 of 9 file patch(es) not applied`)).toBe(true);
    expect(text).toContain('Mod/f0.json (file not found in the download)');
    expect(text).toMatch(/; and 2 more\.$/);
    expect(patchesWarning({ applied: ['a'], skipped: [] })).toBeUndefined();
    expect(mergeEditWarnings(['FOMOD note', `${EDITS_WARNING_PREFIX}old`], [`${EDITS_WARNING_PREFIX}new`])).toEqual(['FOMOD note', `${EDITS_WARNING_PREFIX}new`]);
  });
});

describe('applyCuratorEdits', () => {
  const ORIGINAL = '{"Enabled": false}';
  const EDITED = '{"Enabled": true}';

  async function profileWith(): Promise<{ profileDir: string; revision: number; keys: string[] }> {
    const profileDir = await makeTempDir('vl-profile-');
    const collection = {
      info: { name: 'C', domainName: 'stardewvalley' },
      mods: [
        { name: 'Plain', version: '1', source: { type: 'nexus', modId: 1, fileId: 1 } },
        {
          name: 'Ridgeside Village (CP)',
          version: '2',
          source: { type: 'nexus', modId: 2, fileId: 2 },
          patches: {
            'Ridgeside Village\\RidgesideVillage\\config.json': crc32Hex(Buffer.from(ORIGINAL)),
            'Ridgeside Village\\RidgesideVillage\\RidgesideVillage.dll': 'DEADBEEF',
          },
        },
        { name: 'Font Smasher', version: '3', source: { type: 'nexus', modId: 3, fileId: 3 }, hashes: [{ path: 'FontSmasher\\manifest.json', md5: md5(MANIFEST) }] },
      ],
      modRules: [],
    };
    const dir = join(profileDir, 'collection-r7');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'collection.json'), JSON.stringify(collection));
    await writeTree(join(dir, 'patches', 'Ridgeside Village (CP)'), {
      'Ridgeside Village/RidgesideVillage/config.json.diff': naivePatch(Buffer.from(ORIGINAL), Buffer.from(EDITED)),
      'Ridgeside Village/RidgesideVillage/RidgesideVillage.dll.diff': naivePatch(Buffer.from('x'), Buffer.from('y')),
    });
    return { profileDir, revision: 7, keys: uniqueModKeys(parseCollectionJson(JSON.stringify(collection)).mods) };
  }

  it('looks the raw entry up by plan key, then applies patches and the file list with readable warnings', async () => {
    const p = await profileWith();
    expect((await collectionEntryFor(p, 'nexus:2:2'))?.name).toBe('Ridgeside Village (CP)');
    expect(await collectionEntryFor(p, 'nexus:404:1')).toBeUndefined();

    const rsv = join(await makeTempDir('vl-out-'), 'out');
    await writeTree(rsv, { 'RidgesideVillage/config.json': ORIGINAL, 'RidgesideVillage/RidgesideVillage.dll': 'dll', 'RidgesideVillage/manifest.json': '{}' });
    const warnings = await applyCuratorEdits(p, 'nexus:2:2', rsv);
    expect(await readFile(join(rsv, 'RidgesideVillage', 'config.json'), 'utf8')).toBe(EDITED);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Curator's edits: 1 of 2 file patch\(es\) not applied.*RidgesideVillage\.dll \(file differs from the one the curator edited/);

    const fs = join(await makeTempDir('vl-out-'), 'out');
    await writeTree(fs, { 'Font Smasher/FontSmasher/manifest.json': MANIFEST, 'Font Smasher/junk.txt': 'x' });
    expect(await applyCuratorEdits(p, 'nexus:3:3', fs)).toEqual([]);
    expect(await tree(fs)).toEqual(['FontSmasher/manifest.json']);

    const plain = join(await makeTempDir('vl-out-'), 'out');
    await writeTree(plain, { 'Plain/manifest.json': '{}' });
    expect(await applyCuratorEdits(p, 'nexus:1:1', plain)).toEqual([]);
    expect(await tree(plain)).toEqual(['Plain/manifest.json']);
  });

  it('installs without edits when the profile has no collection.json', async () => {
    const out = join(await makeTempDir('vl-out-'), 'out');
    await writeTree(out, { 'A/manifest.json': '{}' });
    expect(await applyCuratorEdits({ profileDir: await makeTempDir('vl-empty-'), revision: 1 }, 'nexus:1:1', out)).toEqual([]);
    expect(await tree(out)).toEqual(['A/manifest.json']);
  });
});
