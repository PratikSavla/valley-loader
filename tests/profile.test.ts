// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Profile, safeModKey } from '../src/main/install/profile';
import type { InstallAnalysis } from '../src/main/install/stardew';

let root: string;
let profile: Profile;

async function writeTree(base: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(base, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

/** Builds an extraction dir with one manifest folder per top-level name and stages it as a 'mods' install. */
async function stageMods(key: string, files: Record<string, string>): Promise<string[]> {
  const extract = await mkdtemp(join(root, 'extract-'));
  await writeTree(extract, files);
  const names = [...new Set(Object.keys(files).map((p) => p.split('/')[0] ?? ''))];
  const analysis: InstallAnalysis = {
    kind: 'mods',
    folders: names.map((n) => ({ sourceDir: join(extract, n), targetName: n, manifest: { Name: n } })),
  };
  return profile.stageMod(key, analysis);
}

const read = (rel: string): Promise<string> => readFile(join(profile.modsDir, rel), 'utf8');
const existsInMods = (rel: string): Promise<boolean> =>
  stat(join(profile.modsDir, rel)).then(
    () => true,
    () => false,
  );

const BASE = 'nexus:1:10';
const CONFIG = 'nexus:20870:99';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vl-profile-'));
  profile = new Profile(join(root, 'profile'));
  await stageMods(BASE, {
    'ModA/manifest.json': '{"Name":"A"}',
    'ModA/config.json': '{"base":true}',
    'ModA/assets/a.png': 'png',
    'ModB/manifest.json': '{"Name":"B"}',
  });
  await stageMods(CONFIG, { 'ModA/config.json': '{"configured":true}' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('safeModKey', () => {
  it('is lowercase, filesystem-safe and distinguishes keys that sanitise the same', () => {
    const a = safeModKey('direct:https://x.com/A?b=1');
    expect(a).toMatch(/^[a-z0-9._-]+$/);
    expect(a.startsWith('direct_https___x.com_a_b_1-')).toBe(true);
    expect(safeModKey('Mod:A')).not.toBe(safeModKey('mod:a'));
  });
});

describe('Profile.stageMod', () => {
  it('stages folders under staging/<safeKey>/ and returns the folder names', async () => {
    expect(await profile.isStaged(BASE)).toBe(true);
    expect(await profile.stagedFolders(BASE)).toEqual(['ModA', 'ModB']);
    const staged = await readFile(join(profile.stagingDir, safeModKey(BASE), 'ModA', 'config.json'), 'utf8');
    expect(staged).toBe('{"base":true}');
  });

  it('replaces an already-staged mod instead of merging', async () => {
    const folders = await stageMods(BASE, { 'ModC/manifest.json': '{}' });
    expect(folders).toEqual(['ModC']);
    expect(await profile.stagedFolders(BASE)).toEqual(['ModC']);
  });

  it('stages fallback extractions by moving the root children', async () => {
    const extract = await mkdtemp(join(root, 'fb-'));
    await writeTree(extract, { 'Loose/thing.txt': 'x', 'Other/y.txt': 'y' });
    const folders = await profile.stageMod('bundle:loose.zip', { kind: 'fallback', sourceDir: extract });
    expect(folders).toEqual(['Loose', 'Other']);
    expect(await readdir(extract)).toEqual([]);
  });

  it('throws for smapi and root kinds and stages nothing', async () => {
    await expect(profile.stageMod('nexus:2400:1', { kind: 'smapi' })).rejects.toThrow(/SMAPI installer/);
    await expect(profile.stageMod('nexus:5:5', { kind: 'root', contentDir: root })).rejects.toThrow(/root mods/);
    expect(await profile.isStaged('nexus:2400:1')).toBe(false);
    expect(await profile.isStaged('nexus:5:5')).toBe(false);
  });

  it('rejects target names that would escape staging', async () => {
    const extract = await mkdtemp(join(root, 'bad-'));
    const analysis: InstallAnalysis = {
      kind: 'mods',
      folders: [{ sourceDir: extract, targetName: '../evil', manifest: {} }],
    };
    await expect(profile.stageMod('nexus:6:6', analysis)).rejects.toThrow(/unsafe folder name/);
  });
});

describe('Profile.deploy', () => {
  it('deploys both mods, the later key wins the conflict and the override is reported', async () => {
    const result = await profile.deploy([BASE, CONFIG]);
    expect(result.copied).toBe(4);
    expect(result.removed).toBe(0);
    expect(await read('ModA/config.json')).toBe('{"configured":true}');
    expect(await read('ModA/assets/a.png')).toBe('png');
    expect(await read('ModB/manifest.json')).toBe('{"Name":"B"}');
    expect(result.overrides).toEqual([{ path: 'ModA/config.json', winner: CONFIG, loser: BASE }]);
    const owned = JSON.parse(await readFile(profile.manifestPath, 'utf8')) as Record<string, { owner: string }>;
    expect(owned['ModA/config.json']?.owner).toBe(CONFIG);
    expect(owned['ModA/manifest.json']?.owner).toBe(BASE);
  });

  it('is idempotent: a second deploy with the same keys copies nothing', async () => {
    await profile.deploy([BASE, CONFIG]);
    const second = await profile.deploy([BASE, CONFIG]);
    expect(second.copied).toBe(0);
    expect(second.removed).toBe(0);
    expect(second.overrides).toHaveLength(1);
  });

  it('reordering flips the winner and recopies only the contested file', async () => {
    await profile.deploy([BASE, CONFIG]);
    const result = await profile.deploy([CONFIG, BASE]);
    expect(result.copied).toBe(1);
    expect(await read('ModA/config.json')).toBe('{"base":true}');
    expect(result.overrides).toEqual([{ path: 'ModA/config.json', winner: BASE, loser: CONFIG }]);
  });

  it('treats paths case-insensitively and keeps the winner casing', async () => {
    await stageMods('nexus:7:7', { 'moda/CONFIG.JSON': '{"upper":true}' });
    const result = await profile.deploy([BASE, 'nexus:7:7']);
    expect(result.overrides).toEqual([{ path: 'moda/CONFIG.JSON', winner: 'nexus:7:7', loser: BASE }]);
    expect(await read('moda/CONFIG.JSON')).toBe('{"upper":true}');
  });

  it('unstaging a mod removes its files and prunes empty folders on the next deploy', async () => {
    await profile.deploy([BASE, CONFIG]);
    await profile.unstageMod(BASE);
    const result = await profile.deploy([CONFIG]);
    expect(result.removed).toBe(3);
    expect(await existsInMods('ModB')).toBe(false);
    expect(await existsInMods('ModA/assets')).toBe(false);
    expect(await read('ModA/config.json')).toBe('{"configured":true}');
  });

  it('removing the override mod restores the lower-order file', async () => {
    await profile.deploy([BASE, CONFIG]);
    const result = await profile.deploy([BASE]);
    expect(result.copied).toBe(1);
    expect(await read('ModA/config.json')).toBe('{"base":true}');
  });

  it('never deletes unowned files (e.g. a config.json SMAPI wrote at runtime)', async () => {
    await profile.deploy([BASE]);
    await writeFile(join(profile.modsDir, 'ModB', 'config.json'), '{"runtime":true}');
    await profile.deploy([BASE]);
    expect(await read('ModB/config.json')).toBe('{"runtime":true}');
    await profile.unstageMod(BASE);
    const result = await profile.deploy([]);
    expect(result.removed).toBe(4);
    expect(await read('ModB/config.json')).toBe('{"runtime":true}');
    expect(await existsInMods('ModB/manifest.json')).toBe(false);
  });

  it('keeps a user-modified owned file while the owner is unchanged, replaces it when the owner changes', async () => {
    await profile.deploy([BASE]);
    await writeFile(join(profile.modsDir, 'ModA', 'config.json'), '{"userEdited":1234}');
    const same = await profile.deploy([BASE]);
    expect(same.copied).toBe(0);
    expect(await read('ModA/config.json')).toBe('{"userEdited":1234}');
    const changed = await profile.deploy([BASE, CONFIG]);
    expect(changed.copied).toBe(1);
    expect(await read('ModA/config.json')).toBe('{"configured":true}');
  });

  it('does not delete a user-modified owned file that no mod provides any more', async () => {
    await profile.deploy([BASE, CONFIG]);
    await writeFile(join(profile.modsDir, 'ModA', 'config.json'), '{"edited":"by user"}');
    await profile.unstageMod(BASE);
    await profile.unstageMod(CONFIG);
    const result = await profile.deploy([]);
    expect(result.removed).toBe(3);
    expect(await read('ModA/config.json')).toBe('{"edited":"by user"}');
  });

  it('redeploys a re-staged mod whose files changed', async () => {
    await profile.deploy([BASE]);
    await stageMods(BASE, {
      'ModA/manifest.json': '{"Name":"A","Version":"2.0.0"}',
      'ModA/config.json': '{"base":true}',
      'ModA/assets/a.png': 'png',
      'ModB/manifest.json': '{"Name":"B"}',
    });
    const result = await profile.deploy([BASE]);
    expect(result.copied).toBeGreaterThanOrEqual(1);
    expect(await read('ModA/manifest.json')).toBe('{"Name":"A","Version":"2.0.0"}');
  });

  it('throws when asked to deploy a key that is not staged', async () => {
    await expect(profile.deploy([BASE, 'nexus:404:404'])).rejects.toThrow(/not staged/);
  });
});
