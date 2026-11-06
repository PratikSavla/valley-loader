// SPDX-License-Identifier: AGPL-3.0-only
// Finds the Stardew Valley install and SMAPI on macOS. Pure Node.
//
// Where versions live (verified read-only on a Steam install, SMAPI 4.5.1 / game 1.6.15):
// - Game: `Contents/MacOS/Stardew Valley.deps.json` has the key "Stardew Valley/1.6.15.24356" (reliable).
//   `Contents/Info.plist` CFBundleShortVersionString is stale on Steam ("1.08"), so it is the last resort.
//   `Stardew Valley.dll` ProductVersion ("1.6.15, , 24356") is the middle fallback.
// - SMAPI: `StardewModdingAPI.dll` version resource ProductVersion ("4.5.1+<commit>") is reliable.
//   `smapi-internal/StardewModdingAPI.update.marker` holds the *latest available* version, not the
//   installed one, so it is ignored. Fallback: first line of ~/.config/StardewValley/ErrorLogs/SMAPI-latest.txt
//   ("SMAPI 4.5.1 with Stardew Valley 1.6.15 build 24356 on macOS ...").
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { GameInfo } from '@shared/types';

export const GAME_DLL = 'Stardew Valley.dll';
export const SMAPI_LAUNCHER = 'StardewModdingAPI';
export const SMAPI_DLL = 'StardewModdingAPI.dll';
const MACOS_SUFFIX = join('Contents', 'MacOS');
const STEAM_ROOT = join('Library', 'Application Support', 'Steam');

export interface InspectOptions {
  /** SMAPI log used as a version fallback. Defaults to ~/.config/StardewValley/ErrorLogs/SMAPI-latest.txt. */
  smapiLogPath?: string;
}

/** Default macOS candidate folders (each the folder containing the game executable). */
export function candidateGamePaths(home: string): string[] {
  return [
    steamLibraryGamePath(join(home, STEAM_ROOT)),
    join('/Applications', 'Stardew Valley.app', MACOS_SUFFIX),
    join(home, 'Applications', 'Stardew Valley.app', MACOS_SUFFIX),
  ];
}

/** "<library>/steamapps/common/Stardew Valley/Contents/MacOS" for a Steam library root. */
export function steamLibraryGamePath(libraryRoot: string): string {
  return join(libraryRoot, 'steamapps', 'common', 'Stardew Valley', MACOS_SUFFIX);
}

/** Extract every `"path" "<dir>"` entry from Steam's libraryfolders.vdf text (handles \\ escapes). */
export function parseLibraryFolders(vdf: string): string[] {
  const out: string[] = [];
  for (const m of vdf.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/gi)) {
    const raw = m[1];
    if (raw) out.push(raw.replace(/\\(.)/g, '$1'));
  }
  return out;
}

/** Game folders inside every Steam library listed in libraryfolders.vdf ([] when the file is absent). */
export async function steamLibraryCandidates(home: string): Promise<string[]> {
  const vdfPath = join(home, STEAM_ROOT, 'steamapps', 'libraryfolders.vdf');
  const text = await readOptional(vdfPath, 'utf8');
  return text === undefined ? [] : parseLibraryFolders(text).map(steamLibraryGamePath);
}

/**
 * Normalise a user-picked path: accepts ".../Stardew Valley", ".../Stardew Valley.app",
 * ".../Contents", or ".../Contents/MacOS" and returns the folder with "Stardew Valley.dll", or undefined.
 */
export async function normaliseGamePath(picked: string): Promise<string | undefined> {
  const trimmed = picked.trim();
  if (trimmed === '') return undefined;
  const expanded = trimmed === '~' || trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(1)) : trimmed;
  let base = resolve(expanded);
  if (basename(base) === GAME_DLL) base = dirname(base);
  for (const dir of [base, join(base, MACOS_SUFFIX), join(base, 'MacOS')]) {
    if (await isFile(join(dir, GAME_DLL))) return dir;
  }
  return undefined;
}

/** Inspect a game folder: game version (Info.plist / dll), SMAPI presence + version. */
export async function inspectGame(gamePath: string, options: InspectOptions = {}): Promise<GameInfo> {
  const [gameVersion, launcher, dll] = await Promise.all([
    readGameVersion(gamePath),
    isFile(join(gamePath, SMAPI_LAUNCHER)),
    isFile(join(gamePath, SMAPI_DLL)),
  ]);
  const smapiInstalled = launcher && dll;
  const info: GameInfo = { gamePath, smapiInstalled };
  if (gameVersion) info.gameVersion = gameVersion;
  if (smapiInstalled) {
    const logPath = options.smapiLogPath ?? defaultSmapiLogPath(homedir());
    const smapiVersion = await readSmapiVersion(gamePath, logPath);
    if (smapiVersion) info.smapiVersion = smapiVersion;
  }
  return info;
}

/** Try the configured path first, then candidates. */
export async function detectGame(home: string, configured?: string): Promise<GameInfo | undefined> {
  const libraries = await steamLibraryCandidates(home);
  const ordered = [...(configured ? [configured] : []), ...candidateGamePaths(home), ...libraries];
  const seen = new Set<string>();
  for (const candidate of ordered) {
    const key = resolve(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const gamePath = await normaliseGamePath(candidate);
    if (gamePath) return inspectGame(gamePath, { smapiLogPath: defaultSmapiLogPath(home) });
  }
  return undefined;
}

/** Compare dotted versions ("4.1.10" vs "4.0.0"): negative/0/positive. Ignores pre-release suffixes. */
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function versionParts(v: string): number[] {
  const core = v.trim().replace(/^v/i, '').split(/[-+\s]/)[0] ?? '';
  return core.split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

export function defaultSmapiLogPath(home: string): string {
  return join(home, '.config', 'StardewValley', 'ErrorLogs', 'SMAPI-latest.txt');
}

/** Game version: deps.json → dll version resource → Info.plist (stale on Steam). */
export async function readGameVersion(gamePath: string): Promise<string | undefined> {
  const deps = await readOptional(join(gamePath, 'Stardew Valley.deps.json'), 'utf8');
  const fromDeps = deps?.match(/"Stardew Valley\/(\d+\.\d+\.\d+)(?:\.\d+)?"/)?.[1];
  if (fromDeps) return fromDeps;
  const dll = await readOptional(join(gamePath, GAME_DLL));
  const fromDll = dll ? readPeProductVersion(dll) : undefined;
  if (fromDll) return fromDll;
  const plist = await readOptional(join(dirname(gamePath), 'Info.plist'), 'utf8');
  return plist ? parsePlistString(plist, 'CFBundleShortVersionString') : undefined;
}

/** SMAPI version: StardewModdingAPI.dll version resource, then the SMAPI log's first line. */
export async function readSmapiVersion(gamePath: string, logPath: string): Promise<string | undefined> {
  const dll = await readOptional(join(gamePath, SMAPI_DLL));
  const fromDll = dll ? readPeProductVersion(dll) : undefined;
  if (fromDll) return fromDll;
  const log = await readOptional(logPath, 'utf8');
  return log ? parseSmapiLogVersion(log) : undefined;
}

/** "SMAPI 4.5.1 with Stardew Valley 1.6.15 build 24356 on macOS" → "4.5.1". */
export function parseSmapiLogVersion(log: string): string | undefined {
  return log.match(/SMAPI (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) with Stardew Valley/)?.[1];
}

/** Value of `<key>name</key><string>value</string>` in an XML plist (undefined for binary plists). */
export function parsePlistString(xml: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = xml.match(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`))?.[1]?.trim();
  return value || undefined;
}

/**
 * Read the ProductVersion string from a PE file's VS_VERSIONINFO resource (UTF-16LE key, null padding,
 * UTF-16LE value). Build metadata ("+<commit>") is dropped; a pre-release suffix is kept.
 */
export function readPeProductVersion(buf: Buffer): string | undefined {
  const key = Buffer.from('ProductVersion\0', 'utf16le');
  const idx = buf.lastIndexOf(key);
  if (idx < 0) return undefined;
  let start = idx + key.length;
  while (start + 1 < buf.length && buf.readUInt16LE(start) === 0) start += 2;
  let end = start;
  while (end + 1 < buf.length && buf.readUInt16LE(end) !== 0 && end - start < 256) end += 2;
  const value = buf.toString('utf16le', start, end);
  return value.match(/^\s*(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?)/)?.[1];
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (err) {
    if (isMissing(err)) return false;
    throw new Error(`Could not check ${path}: ${(err as Error).message}`, { cause: err });
  }
}

async function readOptional(path: string): Promise<Buffer | undefined>;
async function readOptional(path: string, encoding: 'utf8'): Promise<string | undefined>;
async function readOptional(path: string, encoding?: 'utf8'): Promise<Buffer | string | undefined> {
  try {
    return encoding ? await readFile(path, encoding) : await readFile(path);
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw new Error(`Could not read ${path}: ${(err as Error).message}`, { cause: err });
  }
}
