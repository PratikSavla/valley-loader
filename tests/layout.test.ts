// SPDX-License-Identifier: AGPL-3.0-only
// Mods/ layout end to end (analyze → stage → deploy): wrapper folders are kept like Vortex does, so config packs
// such as VERY Configured land on the files of the mods they configure; SMAPI's bundled mods reach a profile.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Profile } from '../src/main/install/profile';
import { walkFiles } from '../src/main/install/profile-fs';
import { SMAPI_BUNDLED_KEY } from '../src/main/install/smapi-bundled';
import { analyzeExtracted } from '../src/main/install/stardew';
import { cleanupTempDirs, makeTempDir, writeTree, type TreeSpec } from './helpers/archive-fixtures';
import { buildFixtures, GAME, makeHarness, settleHarnesses, type Fixtures } from './helpers/runner-harness';

let fx: Fixtures;
beforeAll(async () => {
  fx = await buildFixtures();
});
afterAll(async () => {
  await settleHarnesses();
  await cleanupTempDirs();
});

const manifest = (name: string): string => JSON.stringify({ Name: name, UniqueID: `test.${name.replace(/\W/g, '')}`, Version: '1.0.0' });

async function install(profile: Profile, key: string, tree: TreeSpec): Promise<string[]> {
  const dir = await makeTempDir('vl-extract-');
  await writeTree(dir, tree);
  return profile.stageMod(key, await analyzeExtracted(dir));
}

/** Top-level Mods/ folders that SMAPI would skip ("contains files, but none of them are manifest.json"). */
async function foldersWithoutManifest(modsDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(modsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = await walkFiles(join(modsDir, entry.name));
    if (!files.some((f) => f.rel.toLowerCase().endsWith('manifest.json'))) out.push(entry.name);
  }
  return out;
}

describe('wrapper folders and config packs', () => {
  it('lets a VERY Configured-style overlay override RSV\'s config at the same path', async () => {
    const profile = new Profile(await makeTempDir('vl-profile-'));
    const rsv = await install(profile, 'nexus:7286:1', {
      'Ridgeside Village/RidgesideVillage/manifest.json': manifest('Ridgeside Village'),
      'Ridgeside Village/RidgesideVillage/config.json': '{"default":true}',
      'Ridgeside Village/[CP] Ridgeside Village/manifest.json': manifest('[CP] Ridgeside Village'),
    });
    expect(rsv).toEqual(['Ridgeside Village']);
    const vc = await install(profile, 'nexus:20870:188857', { 'Ridgeside Village/RidgesideVillage/config.json': '{"curated":true}' });
    expect(vc).toEqual(['Ridgeside Village']);
    const result = await profile.deploy(['nexus:7286:1', 'nexus:20870:188857']);
    expect(result.overrides).toEqual([
      { path: 'Ridgeside Village/RidgesideVillage/config.json', winner: 'nexus:20870:188857', loser: 'nexus:7286:1' },
    ]);
    expect(await readFile(join(profile.modsDir, 'Ridgeside Village/RidgesideVillage/config.json'), 'utf8')).toBe('{"curated":true}');
    expect(await foldersWithoutManifest(profile.modsDir)).toEqual([]);
  });

  it('stages a config-only pack with its folder instead of a bare config.json in Mods/', async () => {
    const profile = new Profile(await makeTempDir('vl-profile-'));
    const folders = await install(profile, 'nexus:1:2', { 'ChestsAnywhere/config.json': '{}' });
    expect(folders).toEqual(['ChestsAnywhere']);
    await profile.deploy(['nexus:1:2']);
    expect(await readdir(profile.modsDir)).toEqual(['ChestsAnywhere']);
    expect(await readFile(join(profile.modsDir, 'ChestsAnywhere/config.json'), 'utf8')).toBe('{}');
  });

  it('rejects a staged path that tries to climb out of staging', async () => {
    const profile = new Profile(await makeTempDir('vl-profile-'));
    const dir = await makeTempDir('vl-extract-');
    await writeTree(dir, { 'x/manifest.json': manifest('x') });
    const evil = { kind: 'mods' as const, folders: [{ sourceDir: join(dir, 'x'), targetName: 'ok/../../escape', manifest: {} }] };
    await expect(profile.stageMod('k', evil)).rejects.toThrow(/unsafe folder name/);
  });
});

describe("SMAPI's bundled mods", () => {
  it('are copied (read-only) from the game into the profile on Play, without the user\'s save backups', async () => {
    const h = await makeHarness(fx);
    const gameDir = await makeTempDir('vl-game-');
    const source: TreeSpec = {
      'Mods/ConsoleCommands/manifest.json': manifest('Console Commands'),
      'Mods/ConsoleCommands/ConsoleCommands.dll': 'dll',
      'Mods/SaveBackup/manifest.json': manifest('Save Backup'),
      'Mods/SaveBackup/backups/2026-01-01 - Farm.zip': 'old save',
    };
    await writeTree(gameDir, source);
    const before = (await walkFiles(gameDir)).map((f) => f.rel).sort();
    const mtime = (await stat(join(gameDir, 'Mods/SaveBackup/manifest.json'))).mtimeMs;
    h.store.setTransient({ game: { ...GAME, gamePath: gameDir, smapiVersion: '4.5.2' } });
    const profile = await h.runner.resolveCollection('testcol');
    await h.runner.launchGame('testcol');
    expect(h.launches).toHaveLength(1);
    expect(await readFile(join(profile.modsDir, 'ConsoleCommands/manifest.json'), 'utf8')).toMatch(/Console Commands/);
    expect(await readFile(join(profile.modsDir, 'SaveBackup/manifest.json'), 'utf8')).toMatch(/Save Backup/);
    await expect(stat(join(profile.modsDir, 'SaveBackup/backups'))).rejects.toThrow();
    expect(await new Profile(profile.profileDir).isStaged(SMAPI_BUNDLED_KEY)).toBe(true);
    expect((await walkFiles(gameDir)).map((f) => f.rel).sort()).toEqual(before);
    expect((await stat(join(gameDir, 'Mods/SaveBackup/manifest.json'))).mtimeMs).toBe(mtime);
  });
});
