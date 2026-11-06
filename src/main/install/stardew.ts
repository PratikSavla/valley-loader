// SPDX-License-Identifier: AGPL-3.0-only
// Decides how an extracted mod archive maps onto a Stardew Valley install (Vortex SDV rules). Pure Node.
import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { parseLenientJson as parseLenient } from './lenient-json';

export interface SmapiManifest {
  Name?: string;
  UniqueID?: string;
  Version?: string;
  Author?: string;
}

export interface ModFolder {
  /** Absolute path of the folder containing manifest.json. */
  sourceDir: string;
  /**
   * "/"-separated path to use under Mods/: the manifest folder's path inside the archive, wrapper folders kept
   * (e.g. "Ridgeside Village/RidgesideVillage"), as Vortex installs it. Config packs such as VERY Configured
   * and the collection's patches address files by that same path.
   */
  targetName: string;
  manifest: SmapiManifest;
}

export type InstallAnalysis =
  | { kind: 'smapi' }
  | { kind: 'root'; contentDir: string }
  | { kind: 'mods'; folders: ModFolder[] }
  | { kind: 'fallback'; sourceDir: string };

const JUNK_NAMES = new Set(['__macosx', '.ds_store', 'thumbs.db', 'desktop.ini']);
const LOCALE_DIRS = new Set(['i18n', 'locale', 'locales']);

/** OS clutter that archives often carry (Finder/Explorer metadata). */
export function isJunkName(name: string): boolean {
  const lower = name.toLowerCase();
  return JUNK_NAMES.has(lower) || lower.startsWith('._');
}

async function visibleEntries(dir: string): Promise<Dirent[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => !isJunkName(e.name) && (e.isDirectory() || e.isFile()));
}

/** All regular files under root as "/"-separated relative paths, junk and symlinks skipped. */
async function listFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await visibleEntries(rel === '' ? root : join(root, rel))) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(root, childRel)));
    else out.push(childRel);
  }
  return out;
}

/** Descend through single-folder wrappers ("Foo-1.2/Foo/…"), stopping at a Content folder. Only for the Content/ check. */
async function unwrap(dir: string): Promise<string> {
  let current = dir;
  for (;;) {
    const entries = await visibleEntries(current);
    const only = entries[0];
    if (entries.length !== 1 || !only?.isDirectory() || only.name.toLowerCase() === 'content') {
      return current;
    }
    current = join(current, only.name);
  }
}

async function findContentDir(top: string): Promise<string | undefined> {
  const entries = await visibleEntries(top);
  if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'manifest.json')) return undefined;
  const content = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === 'content');
  return content ? join(top, content.name) : undefined;
}

/**
 * Relative folders ("" = extraction root) holding a manifest.json, outermost first. Manifests under an
 * i18n/locale folder, or nested inside another manifest folder, belong to their parent mod.
 */
export function pickManifestFolders(files: string[]): string[] {
  const candidates = files
    .map((f) => f.split('/'))
    .filter((parts) => parts[parts.length - 1]?.toLowerCase() === 'manifest.json')
    .map((parts) => parts.slice(0, -1))
    .filter((dirs) => !dirs.some((d) => LOCALE_DIRS.has(d.toLowerCase())))
    .sort((a, b) => a.length - b.length)
    .map((dirs) => dirs.join('/'));
  const accepted: string[] = [];
  for (const folder of candidates) {
    const nested = accepted.some((parent) => parent === '' || folder.startsWith(`${parent}/`));
    if (!nested && !accepted.includes(folder)) accepted.push(folder);
  }
  return accepted;
}

/** Make a manifest Name usable as a folder name; undefined when nothing usable is left. */
export function safeFolderName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const replaced = [...raw]
    .map((ch) => (ch.charCodeAt(0) < 32 || '/\\:*?"<>|'.includes(ch) ? ' ' : ch))
    .join('');
  const cleaned = replaced
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 100)
    .trim();
  return cleaned === '' ? undefined : cleaned;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

async function readManifest(path: string, rel: string): Promise<SmapiManifest> {
  let parsed: unknown;
  try {
    parsed = parseLenient(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read SMAPI manifest ${rel}: ${(err as Error).message}`, { cause: err });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`SMAPI manifest ${rel} is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const manifest: SmapiManifest = {};
  for (const key of ['Name', 'UniqueID', 'Version', 'Author'] as const) {
    const value = stringField(obj, key);
    if (value !== undefined) manifest[key] = value;
  }
  return manifest;
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${name} (${n})`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** The manifest file inside folder `rel`, keeping its on-disk casing (e.g. "Manifest.json"). */
function manifestFileIn(rel: string, files: string[]): string {
  const prefix = rel === '' ? '' : `${rel}/`;
  const found = files.find(
    (f) => f.startsWith(prefix) && f.slice(prefix.length).toLowerCase() === 'manifest.json',
  );
  return found ?? `${prefix}manifest.json`;
}

async function buildModFolders(dir: string, files: string[], folders: string[]): Promise<ModFolder[]> {
  const manifests = await Promise.all(
    folders.map((rel) => {
      const sourceDir = rel === '' ? dir : join(dir, ...rel.split('/'));
      const manifestRel = manifestFileIn(rel, files);
      return readManifest(join(dir, ...manifestRel.split('/')), manifestRel).then((manifest) => ({
        rel,
        sourceDir,
        manifest,
      }));
    }),
  );
  const used = new Set<string>();
  return manifests.map(({ rel, sourceDir, manifest }) => {
    const base = rel === '' ? (safeFolderName(manifest.Name) ?? safeFolderName(manifest.UniqueID) ?? 'mod') : rel;
    return { sourceDir, targetName: uniqueName(base, used), manifest };
  });
}

/**
 * Where a manifest-less archive (a config/overlay pack) is copied from: the archive root as packed, so
 * "ChestsAnywhere/config.json" lands on Mods/ChestsAnywhere/config.json. Only a lone top-level "Mods" folder is
 * stepped into (people often zip their whole Mods folder); other wrapper folders are part of the target path.
 */
async function fallbackRoot(dir: string): Promise<string> {
  const entries = await visibleEntries(dir);
  const only = entries[0];
  return entries.length === 1 && only?.isDirectory() && only.name.toLowerCase() === 'mods' ? join(dir, only.name) : dir;
}

/**
 * - SMAPI.Installer.dll anywhere → smapi
 * - top-level Content/ (case-insensitive, after unwrapping a single wrapper folder) → root
 * - every folder with manifest.json (not under a locale/ or i18n/ dir, not nested inside another manifest folder) → mods
 * - otherwise → fallback (the extracted root as packed; a lone top-level Mods/ folder is stepped into)
 * Manifest JSON may have comments/trailing commas/BOM (SMAPI allows them).
 */
export async function analyzeExtracted(dir: string): Promise<InstallAnalysis> {
  const files = await listFiles(dir);
  if (files.some((f) => f.split('/').pop()?.toLowerCase() === 'smapi.installer.dll')) {
    return { kind: 'smapi' };
  }
  const top = await unwrap(dir);
  const contentDir = await findContentDir(top);
  if (contentDir) return { kind: 'root', contentDir };
  const folders = pickManifestFolders(files);
  if (folders.length > 0) return { kind: 'mods', folders: await buildModFolders(dir, files, folders) };
  return { kind: 'fallback', sourceDir: await fallbackRoot(dir) };
}

/** Lenient JSON parse (strips BOM, // and /* comments, trailing commas). */
export function parseLenientJson(text: string): unknown {
  return parseLenient(text);
}
