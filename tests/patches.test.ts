// SPDX-License-Identifier: AGPL-3.0-only
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { crc32Hex } from '../src/main/install/bspatch';
import { applyCollectionPatches, locatePatchTarget, patchKeySegments } from '../src/main/install/patches';
import type { WalkedFile } from '../src/main/install/profile-fs';
import { cleanupTempDirs, makeTempDir, writeTree } from './helpers/archive-fixtures';
import { naivePatch } from './helpers/bsdiff-fixtures';

afterAll(cleanupTempDirs);

const files = (...rels: string[]): WalkedFile[] => rels.map((rel) => ({ rel, abs: `/x/${rel}` }));

describe('patchKeySegments', () => {
  it('normalises backslashes and rejects traversal / absolute keys', () => {
    expect(patchKeySegments('Ridgeside Village\\RidgesideVillage\\config.json')).toEqual(['Ridgeside Village', 'RidgesideVillage', 'config.json']);
    expect(patchKeySegments('a/./b//c.json')).toEqual(['a', 'b', 'c.json']);
    for (const bad of ['..\\evil.dll', 'a\\..\\..\\b', '/etc/passwd', '\\\\server\\share', 'C:\\Windows\\x.dll', '', 'a\0b']) {
      expect(patchKeySegments(bad), bad).toBeUndefined();
    }
  });
});

describe('locatePatchTarget', () => {
  const seg = (key: string): string[] => patchKeySegments(key) ?? [];

  it('matches the full path, a path under an extra wrapper, or a path without Vortex\'s wrapper', () => {
    const tree = files('RidgesideVillage/config.json', 'Wrapper/[CP] RSV/i18n/default.json', 'Other/manifest.json');
    expect(locatePatchTarget(seg('RidgesideVillage\\config.json'), tree)).toEqual({ file: tree[0] });
    expect(locatePatchTarget(seg('[CP] RSV\\i18n\\default.json'), tree)).toEqual({ file: tree[1] });
    expect(locatePatchTarget(seg('Ridgeside Village\\RidgesideVillage\\config.json'), tree)).toEqual({ file: tree[0] });
  });

  it('is case-insensitive', () => {
    const tree = files('ModB/Content.JSON');
    expect(locatePatchTarget(seg('modb\\content.json'), tree)).toEqual({ file: tree[0] });
  });

  it('reports ambiguity instead of guessing, but prefers an outright exact path', () => {
    const tree = files('A/content.json', 'B/content.json');
    expect(locatePatchTarget(seg('Pack\\content.json'), tree)).toEqual({ reason: 'ambiguous: 2 files match "content.json"' });
    const nested = files('A/content.json', 'X/A/content.json');
    expect(locatePatchTarget(seg('A\\content.json'), nested)).toEqual({ file: nested[0] });
    expect(locatePatchTarget(seg('Gone\\nothing.json'), tree)).toEqual({ reason: 'file not found in the download' });
  });
});

interface Setup {
  modRoot: string;
  patchesDir: string;
  outside: string;
}

async function setup(tree: Record<string, string | Buffer>, diffs: Record<string, Buffer>): Promise<Setup> {
  const base = await makeTempDir('vl-patches-');
  const modRoot = join(base, 'out');
  const patchesDir = join(base, 'collection', 'patches', 'Ridgeside Village (CP)');
  await writeTree(modRoot, tree);
  await writeTree(patchesDir, diffs);
  const outside = join(base, 'evil.dll');
  return { modRoot, patchesDir, outside };
}

const ORIGINAL_CONFIG = '{"EnableRidgesideMarket": false}';
const EDITED_CONFIG = '{"EnableRidgesideMarket": true, "Curated": 1}';
const ORIGINAL_DLL = Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff]);
const EDITED_DLL = Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xab, 0xcd, 0xef]);

describe('applyCollectionPatches', () => {
  it('patches files despite wrapper differences, verifying the CRC32 of the ORIGINAL file', async () => {
    const s = await setup(
      {
        // Archive layout without Vortex's "Ridgeside Village" wrapper, and with one extra wrapper for the CP part.
        'RidgesideVillage/config.json': ORIGINAL_CONFIG,
        'RidgesideVillage/RidgesideVillage.dll': ORIGINAL_DLL,
        'Extra/[CP] Ridgeside Village/i18n/default.json': '{"a":"b"}',
      },
      {
        'Ridgeside Village/RidgesideVillage/config.json.diff': naivePatch(Buffer.from(ORIGINAL_CONFIG), Buffer.from(EDITED_CONFIG)),
        'Ridgeside Village/RidgesideVillage/RidgesideVillage.dll.diff': naivePatch(ORIGINAL_DLL, EDITED_DLL),
        '[CP] Ridgeside Village/i18n/default.json.diff': naivePatch(Buffer.from('{"a":"b"}'), Buffer.from('{"a":"c"}')),
      },
    );
    const result = await applyCollectionPatches({
      patchesDir: s.patchesDir,
      modRoot: s.modRoot,
      patches: {
        'Ridgeside Village\\RidgesideVillage\\config.json': crc32Hex(Buffer.from(ORIGINAL_CONFIG)),
        'Ridgeside Village\\RidgesideVillage\\RidgesideVillage.dll': crc32Hex(ORIGINAL_DLL).toLowerCase(),
        '[CP] Ridgeside Village\\i18n\\default.json': crc32Hex(Buffer.from('{"a":"b"}')),
      },
    });
    expect(result.skipped).toEqual([]);
    expect(result.applied.sort()).toEqual([
      'Extra/[CP] Ridgeside Village/i18n/default.json',
      'RidgesideVillage/RidgesideVillage.dll',
      'RidgesideVillage/config.json',
    ]);
    expect(await readFile(join(s.modRoot, 'RidgesideVillage', 'config.json'), 'utf8')).toBe(EDITED_CONFIG);
    expect((await readFile(join(s.modRoot, 'RidgesideVillage', 'RidgesideVillage.dll'))).equals(EDITED_DLL)).toBe(true);
    expect(await readFile(join(s.modRoot, 'Extra', '[CP] Ridgeside Village', 'i18n', 'default.json'), 'utf8')).toBe('{"a":"c"}');
    // Atomic writes leave no temp files behind.
    expect((await readdir(join(s.modRoot, 'RidgesideVillage'))).sort()).toEqual(['RidgesideVillage.dll', 'config.json']);
  });

  it('skips (never fails on) CRC mismatches, DLLs included, leaving those files untouched', async () => {
    const s = await setup(
      { 'RidgesideVillage/RidgesideVillage.dll': 'a newer build of the dll', 'RidgesideVillage/config.json': ORIGINAL_CONFIG },
      {
        'Ridgeside Village/RidgesideVillage/RidgesideVillage.dll.diff': naivePatch(ORIGINAL_DLL, EDITED_DLL),
        'Ridgeside Village/RidgesideVillage/config.json.diff': naivePatch(Buffer.from(ORIGINAL_CONFIG), Buffer.from(EDITED_CONFIG)),
      },
    );
    const result = await applyCollectionPatches({
      patchesDir: s.patchesDir,
      modRoot: s.modRoot,
      patches: {
        'Ridgeside Village\\RidgesideVillage\\RidgesideVillage.dll': crc32Hex(ORIGINAL_DLL),
        'Ridgeside Village\\RidgesideVillage\\config.json': crc32Hex(Buffer.from(ORIGINAL_CONFIG)),
      },
    });
    expect(result.applied).toEqual(['RidgesideVillage/config.json']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.path).toBe('Ridgeside Village\\RidgesideVillage\\RidgesideVillage.dll');
    expect(result.skipped[0]?.reason).toMatch(new RegExp(`CRC32 [0-9A-F]{8}, expected ${crc32Hex(ORIGINAL_DLL)}`));
    expect(await readFile(join(s.modRoot, 'RidgesideVillage', 'RidgesideVillage.dll'), 'utf8')).toBe('a newer build of the dll');
  });

  it('reports traversal keys, ambiguous targets, missing or corrupt diffs and bad CRC values as skipped', async () => {
    const s = await setup(
      { 'A/content.json': '{}', 'B/content.json': '{}', 'C/data.json': '[1]', 'D/only.json': '{}' },
      {
        'Pack/content.json.diff': naivePatch(Buffer.from('{}'), Buffer.from('{"x":1}')),
        'C/data.json.diff': Buffer.from('BSDIFF40 but truncated'),
        'D/only.json.diff': naivePatch(Buffer.from('{}'), Buffer.from('{"y":1}')),
      },
    );
    await writeFile(join(s.patchesDir, '..', 'evil.dll.diff'), naivePatch(Buffer.from(''), Buffer.from('pwned')));
    const result = await applyCollectionPatches({
      patchesDir: s.patchesDir,
      modRoot: s.modRoot,
      patches: {
        '..\\evil.dll': '00000000',
        '..\\..\\evil.dll': '00000000',
        'Pack\\content.json': crc32Hex(Buffer.from('{}')),
        'C\\data.json': crc32Hex(Buffer.from('[1]')),
        'Missing\\nope.json': '12345678',
        'D\\only.json': 42,
      },
    });
    expect(result.applied).toEqual([]);
    expect(Object.fromEntries(result.skipped.map((x) => [x.path, x.reason]))).toEqual({
      '..\\evil.dll': 'unsafe path (absolute or "..")',
      '..\\..\\evil.dll': 'unsafe path (absolute or "..")',
      'Pack\\content.json': 'ambiguous: 2 files match "content.json"',
      'C\\data.json': expect.stringMatching(/^patch could not be applied: bspatch/),
      'Missing\\nope.json': 'patch file missing from the collection',
      'D\\only.json': 'invalid CRC32 value 42',
    });
    await expect(stat(s.outside)).rejects.toThrow(/ENOENT/);
    for (const rel of ['A/content.json', 'B/content.json', 'D/only.json']) expect(await readFile(join(s.modRoot, rel), 'utf8')).toBe('{}');
    expect(await readFile(join(s.modRoot, 'C', 'data.json'), 'utf8')).toBe('[1]');
  });
});
