// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractArchive } from '../src/main/install/archive';
import {
  analyzeExtracted,
  parseLenientJson,
  pickManifestFolders,
  safeFolderName,
  type InstallAnalysis,
} from '../src/main/install/stardew';
import { build7zaArchive, cleanupTempDirs, makeTempDir, writeTree, type TreeSpec } from './helpers/archive-fixtures';

afterAll(cleanupTempDirs);

const manifest = (name: string, id = `Test.${name.replace(/\W/g, '')}`): string =>
  JSON.stringify({ Name: name, UniqueID: id, Version: '1.0.0', Author: 'Tester' });

async function analyzeTree(tree: TreeSpec): Promise<{ dir: string; result: InstallAnalysis }> {
  const dir = await makeTempDir('vl-extracted-');
  await writeTree(dir, tree);
  return { dir, result: await analyzeExtracted(dir) };
}

function modsOf(result: InstallAnalysis): { targetName: string; sourceDir: string; name?: string }[] {
  if (result.kind !== 'mods') throw new Error(`expected mods, got ${result.kind}`);
  return result.folders.map((f) => ({ targetName: f.targetName, sourceDir: f.sourceDir, name: f.manifest.Name }));
}

describe('analyzeExtracted on real archives', () => {
  it('finds every mod in a multi-mod 7z ([CP] + [JA] siblings in a wrapper)', async () => {
    const archive = await build7zaArchive(
      {
        'Cool Pack 1.2/[CP] Cool/manifest.json': manifest('Cool CP'),
        'Cool Pack 1.2/[CP] Cool/content.json': '{}',
        'Cool Pack 1.2/[CP] Cool/assets/manifest.json': '{"not":"a mod"}',
        'Cool Pack 1.2/[JA] Cool/manifest.json': manifest('Cool JA'),
        'Cool Pack 1.2/[JA] Cool/i18n/default.json': '{}',
        '__MACOSX/Cool Pack 1.2/._manifest.json': 'junk',
      },
      '7z',
    );
    const dir = await makeTempDir();
    await extractArchive(archive, dir);
    const mods = modsOf(await analyzeExtracted(dir));
    // Wrapper folders are kept, as Vortex installs them (config packs and patches use these paths).
    expect(mods.map((m) => [m.targetName, m.name])).toEqual([
      ['Cool Pack 1.2/[CP] Cool', 'Cool CP'],
      ['Cool Pack 1.2/[JA] Cool', 'Cool JA'],
    ]);
    expect(mods[0]?.sourceDir).toBe(join(dir, 'Cool Pack 1.2', '[CP] Cool'));
  });

  it('detects the SMAPI installer archive', async () => {
    const archive = await build7zaArchive(
      {
        'SMAPI 4.1.10 installer/install on macOS.command': '#!/bin/sh',
        'SMAPI 4.1.10 installer/internal/macOS/SMAPI.Installer.dll': 'dll',
      },
      'zip',
    );
    const dir = await makeTempDir();
    await extractArchive(archive, dir);
    expect(await analyzeExtracted(dir)).toEqual({ kind: 'smapi' });
  });
});

describe('analyzeExtracted', () => {
  it('uses a filesystem-safe manifest Name when the mod sits at the extraction root', async () => {
    const { dir, result } = await analyzeTree({ 'manifest.json': manifest('Better: Crafting?'), 'content.json': '{}' });
    expect(modsOf(result)).toEqual([{ targetName: 'Better Crafting', sourceDir: dir, name: 'Better: Crafting?' }]);
  });

  it('falls back to UniqueID, then "mod", for a root mod without a usable Name', async () => {
    const byId = await analyzeTree({ 'manifest.json': '{"UniqueID":"Author.Thing"}' });
    expect(modsOf(byId.result)[0]?.targetName).toBe('Author.Thing');
    const bare = await analyzeTree({ 'manifest.json': '{"Name":"///"}' });
    expect(modsOf(bare.result)[0]?.targetName).toBe('mod');
  });

  it('keeps a version wrapper folder in the target path, as Vortex does', async () => {
    const { dir, result } = await analyzeTree({ 'Foo-1.2/Foo/manifest.json': manifest('Foo Mod'), '.DS_Store': 'x' });
    expect(modsOf(result)).toEqual([{ targetName: 'Foo-1.2/Foo', sourceDir: join(dir, 'Foo-1.2', 'Foo'), name: 'Foo Mod' }]);
  });

  it('treats top-level Content/ (inside a wrapper, any case) as a root mod', async () => {
    const { dir, result } = await analyzeTree({ 'Wrapper/content/Maps/Farm.xnb': 'xnb', 'Thumbs.db': 'x' });
    expect(result).toEqual({ kind: 'root', contentDir: join(dir, 'Wrapper', 'content') });
    const direct = await analyzeTree({ 'Content/Data/Fish.xnb': 'xnb' });
    expect(direct.result).toEqual({ kind: 'root', contentDir: join(direct.dir, 'Content') });
  });

  it('ignores manifests under i18n/ and locale/ folders', async () => {
    const { dir, result } = await analyzeTree({
      'Pack/i18n/manifest.json': '{"Name":"translation"}',
      'Pack/locale/de/manifest.json': '{"Name":"de"}',
      'Pack/readme.txt': 'hi',
    });
    expect(result).toEqual({ kind: 'fallback', sourceDir: dir });
  });

  it('keeps a manifest nested inside another mod folder as part of the parent', async () => {
    const { result } = await analyzeTree({
      'Outer/manifest.json': manifest('Outer'),
      'Outer/Inner/manifest.json': manifest('Inner'),
    });
    expect(modsOf(result).map((m) => m.targetName)).toEqual(['Outer']);
  });

  it('keeps distinct paths for same-named mod folders under different wrappers', async () => {
    const { result } = await analyzeTree({
      'A/Mod/manifest.json': manifest('One'),
      'B/mod/manifest.json': manifest('Two'),
    });
    expect(modsOf(result).map((m) => m.targetName)).toEqual(['A/Mod', 'B/mod']);
  });

  it('reads lenient manifests (BOM, comments, trailing commas, URLs) and odd casing', async () => {
    const text = '\uFEFF{\n  // comment\n  "Name": "Lenient", /* inline */\n  "UpdateKeys": ["Nexus:1",],\n  "Url": "https://x.y/z",\n}';
    const { result } = await analyzeTree({ 'Lenient/Manifest.json': text });
    expect(modsOf(result)).toEqual([expect.objectContaining({ targetName: 'Lenient', name: 'Lenient' })]);
  });

  it('reports which manifest is broken', async () => {
    const dir = await makeTempDir();
    await writeTree(dir, { 'Broken/manifest.json': '{"Name": ' });
    await expect(analyzeExtracted(dir)).rejects.toThrow(/Broken\/manifest\.json: Invalid JSON/);
  });

  it('falls back to the archive root as packed when there is nothing recognisable', async () => {
    const { dir, result } = await analyzeTree({ 'Wrap/Inner/file.dll': 'x', 'Wrap/Inner/other.txt': 'y' });
    expect(result).toEqual({ kind: 'fallback', sourceDir: dir });
  });

  it('keeps a config-only pack\'s folder (never unwraps down to the bare file)', async () => {
    const one = await analyzeTree({ 'ChestsAnywhere/config.json': '{}' });
    expect(one.result).toEqual({ kind: 'fallback', sourceDir: one.dir });
    const deep = await analyzeTree({ 'Stardew Valley Expanded/[CP] Stardew Valley Expanded/config.json': '{}' });
    expect(deep.result).toEqual({ kind: 'fallback', sourceDir: deep.dir });
  });

  it('steps into a lone top-level Mods folder of a fallback archive', async () => {
    const { dir, result } = await analyzeTree({ 'mods/ChestsAnywhere/config.json': '{}' });
    expect(result).toEqual({ kind: 'fallback', sourceDir: join(dir, 'mods') });
  });
});

describe('pickManifestFolders / safeFolderName', () => {
  it('returns outermost manifest folders and keeps root-level mods exclusive', () => {
    expect(pickManifestFolders(['manifest.json', 'Sub/manifest.json'])).toEqual(['']);
    expect(pickManifestFolders(['a/b/manifest.json', 'a/manifest.json', 'c/manifest.json'])).toEqual(['a', 'c']);
  });

  it('strips path separators, control characters and leading dots', () => {
    expect(safeFolderName('..\\Evil/Name\u0001')).toBe('Evil Name');
    expect(safeFolderName('   ')).toBeUndefined();
  });
});

describe('parseLenientJson', () => {
  it('keeps "//" and "/*" inside strings, including escaped quotes', () => {
    const text = '{"url": "https://www.nexusmods.com/stardewvalley/mods/1", "q": "say \\"//hi\\" /* x */"}';
    expect(parseLenientJson(text)).toEqual({
      url: 'https://www.nexusmods.com/stardewvalley/mods/1',
      q: 'say "//hi" /* x */',
    });
  });

  it('strips comments and trailing commas in objects and arrays', () => {
    const text = '\uFEFF/* header */{"a": [1, 2, /* c */ ], // end\n "b": {"c": true,},}';
    expect(parseLenientJson(text)).toEqual({ a: [1, 2], b: { c: true } });
  });

  it('keeps a comma that is inside a string before a brace', () => {
    expect(parseLenientJson('{"s": ",}"}')).toEqual({ s: ',}' });
  });

  it('throws a descriptive error for invalid JSON', () => {
    expect(() => parseLenientJson('{"a": }')).toThrow(/Invalid JSON/);
    expect(() => parseLenientJson('{"a": 1 /* open')).toThrow(/unterminated/);
  });
});
