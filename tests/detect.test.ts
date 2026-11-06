// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  candidateGamePaths,
  compareVersions,
  detectGame,
  inspectGame,
  normaliseGamePath,
  parseLibraryFolders,
  parsePlistString,
  parseSmapiLogVersion,
  readPeProductVersion,
} from '../src/main/game/detect';

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>StardewValley</string>
  <key>CFBundleShortVersionString</key>
  <string>1.08</string>
</dict></plist>`;

/** Minimal fake of a PE VS_VERSIONINFO string entry. */
function fakePe(productVersion: string): Buffer {
  return Buffer.concat([
    Buffer.from('MZ junk header bytes'),
    Buffer.from('ProductVersion\0', 'utf16le'),
    Buffer.from([0, 0]),
    Buffer.from(`${productVersion}\0`, 'utf16le'),
    Buffer.from('trailing'),
  ]);
}

interface FakeGameOpts {
  deps?: boolean;
  gameDllVersion?: string;
  smapi?: boolean;
  smapiDllVersion?: string;
}

/** Creates "<root>/Stardew Valley/Contents/MacOS" with the requested files; returns the MacOS folder. */
async function makeGame(root: string, opts: FakeGameOpts = {}): Promise<string> {
  const macos = join(root, 'Stardew Valley', 'Contents', 'MacOS');
  await mkdir(macos, { recursive: true });
  await writeFile(join(root, 'Stardew Valley', 'Contents', 'Info.plist'), PLIST);
  await writeFile(join(macos, 'Stardew Valley.dll'), opts.gameDllVersion ? fakePe(opts.gameDllVersion) : 'dll');
  if (opts.deps !== false) {
    await writeFile(join(macos, 'Stardew Valley.deps.json'), JSON.stringify({ targets: { x: { 'Stardew Valley/1.6.15.24356': {} } } }));
  }
  if (opts.smapi) {
    await writeFile(join(macos, 'StardewModdingAPI'), '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(join(macos, 'StardewModdingAPI.dll'), opts.smapiDllVersion ? fakePe(opts.smapiDllVersion) : 'no version');
  }
  return macos;
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'valley-detect-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('candidateGamePaths', () => {
  it('lists Steam default library, /Applications and ~/Applications bundles', () => {
    expect(candidateGamePaths('/Users/me')).toEqual([
      '/Users/me/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS',
      '/Applications/Stardew Valley.app/Contents/MacOS',
      '/Users/me/Applications/Stardew Valley.app/Contents/MacOS',
    ]);
  });
});

describe('parseLibraryFolders', () => {
  it('extracts every path entry and unescapes backslashes', () => {
    const vdf = `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"/Users/me/Library/Application Support/Steam"\n\t\t"label"\t\t""\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"/Volumes/Games/Steam \\\\ Lib"\n\t}\n}`;
    expect(parseLibraryFolders(vdf)).toEqual(['/Users/me/Library/Application Support/Steam', '/Volumes/Games/Steam \\ Lib']);
  });
});

describe('normaliseGamePath', () => {
  it.each([
    'Stardew Valley',
    'Stardew Valley/Contents',
    'Stardew Valley/Contents/MacOS',
    'Stardew Valley/Contents/MacOS/',
    'Stardew Valley/Contents/MacOS/Stardew Valley.dll',
  ])('accepts %s', async (rel) => {
    const macos = await makeGame(tmp);
    expect(await normaliseGamePath(join(tmp, rel))).toBe(macos);
  });

  it('accepts a "Stardew Valley.app" bundle', async () => {
    const macos = join(tmp, 'Stardew Valley.app', 'Contents', 'MacOS');
    await mkdir(macos, { recursive: true });
    await writeFile(join(macos, 'Stardew Valley.dll'), 'dll');
    expect(await normaliseGamePath(join(tmp, 'Stardew Valley.app'))).toBe(macos);
  });

  it('returns undefined for folders without the game dll, missing paths and blanks', async () => {
    await mkdir(join(tmp, 'Empty', 'Contents', 'MacOS'), { recursive: true });
    expect(await normaliseGamePath(join(tmp, 'Empty'))).toBeUndefined();
    expect(await normaliseGamePath(join(tmp, 'nope'))).toBeUndefined();
    expect(await normaliseGamePath('   ')).toBeUndefined();
  });
});

describe('version readers', () => {
  it('reads ProductVersion from a PE resource and drops build metadata', () => {
    expect(readPeProductVersion(fakePe('4.5.1+da22197e150e828c2d3'))).toBe('4.5.1');
    expect(readPeProductVersion(fakePe('1.6.15, , 24356'))).toBe('1.6.15');
    expect(readPeProductVersion(fakePe('4.0.0-beta.2'))).toBe('4.0.0-beta.2');
    expect(readPeProductVersion(Buffer.from('no resource here'))).toBeUndefined();
  });

  it('parses SMAPI log first line and plist strings', () => {
    expect(parseSmapiLogVersion('[19:28:28 INFO  SMAPI] SMAPI 4.5.1 with Stardew Valley 1.6.15 build 24356 on macOS')).toBe('4.5.1');
    expect(parseSmapiLogVersion('garbage')).toBeUndefined();
    expect(parsePlistString(PLIST, 'CFBundleShortVersionString')).toBe('1.08');
    expect(parsePlistString(PLIST, 'Missing')).toBeUndefined();
  });
});

describe('inspectGame', () => {
  it('prefers deps.json game version and the SMAPI dll version over the log', async () => {
    const macos = await makeGame(tmp, { smapi: true, smapiDllVersion: '4.5.1+abc' });
    const log = join(tmp, 'SMAPI-latest.txt');
    await writeFile(log, 'SMAPI 3.0.0 with Stardew Valley 1.5.0 on macOS');
    expect(await inspectGame(macos, { smapiLogPath: log })).toEqual({
      gamePath: macos,
      gameVersion: '1.6.15',
      smapiInstalled: true,
      smapiVersion: '4.5.1',
    });
  });

  it('falls back to the game dll, then Info.plist, for the game version', async () => {
    const withDll = await makeGame(join(tmp, 'a'), { deps: false, gameDllVersion: '1.6.14, , 24300' });
    expect((await inspectGame(withDll)).gameVersion).toBe('1.6.14');
    const plistOnly = await makeGame(join(tmp, 'b'), { deps: false });
    expect((await inspectGame(plistOnly)).gameVersion).toBe('1.08');
  });

  it('falls back to the SMAPI log when the dll has no version resource', async () => {
    const macos = await makeGame(tmp, { smapi: true });
    const log = join(tmp, 'SMAPI-latest.txt');
    await writeFile(log, '[10:00:00 INFO  SMAPI] SMAPI 4.4.0 with Stardew Valley 1.6.15 build 24356 on macOS Unix 27.0.1\n');
    expect(await inspectGame(macos, { smapiLogPath: log })).toMatchObject({ smapiInstalled: true, smapiVersion: '4.4.0' });
    const noLog = await inspectGame(macos, { smapiLogPath: join(tmp, 'missing.txt') });
    expect(noLog.smapiInstalled).toBe(true);
    expect(noLog.smapiVersion).toBeUndefined();
  });

  it('reports SMAPI as missing without the launcher', async () => {
    const macos = await makeGame(tmp);
    const info = await inspectGame(macos, { smapiLogPath: join(tmp, 'missing.txt') });
    expect(info.smapiInstalled).toBe(false);
    expect(info).not.toHaveProperty('smapiVersion');
  });
});

describe('detectGame', () => {
  it('finds the game in an extra Steam library from libraryfolders.vdf', async () => {
    const home = join(tmp, 'home');
    const steamapps = join(home, 'Library', 'Application Support', 'Steam', 'steamapps');
    await mkdir(steamapps, { recursive: true });
    const extraLib = join(tmp, 'External Drive', 'SteamLibrary');
    await writeFile(join(steamapps, 'libraryfolders.vdf'), `"libraryfolders"\n{\n\t"1"\n\t{\n\t\t"path"\t\t"${extraLib}"\n\t}\n}`);
    const macos = await makeGame(join(extraLib, 'steamapps', 'common'), { smapi: true, smapiDllVersion: '4.5.1' });
    expect(await detectGame(home)).toMatchObject({ gamePath: macos, gameVersion: '1.6.15', smapiVersion: '4.5.1' });
  });

  it('uses the configured path first and returns undefined when nothing is found', async () => {
    const home = join(tmp, 'home');
    await makeGame(join(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'common'));
    const custom = await makeGame(join(tmp, 'custom'));
    expect((await detectGame(home, join(tmp, 'custom', 'Stardew Valley')))?.gamePath).toBe(custom);
    expect((await detectGame(home, join(tmp, 'bogus')))?.gamePath).toContain(join('home', 'Library'));
    expect(await detectGame(join(tmp, 'nobody'))).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it.each([
    ['4.1.10', '4.0.0', 1],
    ['4.0.0', '4.1.10', -1],
    ['4.1.10', '4.1.9', 1],
    ['1.6', '1.6.0', 0],
    ['1.6.15', '1.6.15.24356', -1],
    ['4.0.0-beta.2', '4.0.0', 0],
    ['v4.5.1', '4.5.1+abc', 0],
    ['10.0.0', '9.9.9', 1],
  ])('compareVersions(%s, %s) = %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});
