// SPDX-License-Identifier: AGPL-3.0-only
// Curator edits from collection.json applied to a freshly extracted mod, before the Stardew analyzer runs:
// first mods[].hashes (exact file list, see hashes.ts), then mods[].patches (binary patches, see patches.ts).
// The raw entry is looked up in the collection.json kept in the profile's collection-r<revision> folder.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProfileState } from '@shared/types';
import { uniqueModKeys } from '../collection/plan';
import { parseCollectionJson, type CollectionModEntry } from '../collection/schema';
import { applyHashesFilter, type HashesResult } from './hashes';
import { applyCollectionPatches, type PatchResult } from './patches';
import { errCode, errMessage } from './profile-fs';
import { collectionDir, isInside } from './runner-context';

/** Every warning this module adds starts with this, so a reinstall can replace the previous ones. */
export const EDITS_WARNING_PREFIX = "Curator's edits: ";
const MAX_LISTED = 5;

type EntryCache = { mtimeMs: number; size: number; byKey: Map<string, CollectionModEntry> };
const cache = new Map<string, EntryCache>();

/** The collection.json entry behind a plan key; undefined when the profile has no collection.json on disk. */
export async function collectionEntryFor(profile: Pick<ProfileState, 'profileDir' | 'revision'>, key: string): Promise<CollectionModEntry | undefined> {
  const path = join(collectionDir(profile), 'collection.json');
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if (errCode(err) === 'ENOENT') {
      console.warn(`[runner] ${path} is missing; installing ${key} without the curator's file edits`);
      return undefined;
    }
    throw new Error(`Cannot read ${path}: ${errMessage(err)}`, { cause: err });
  }
  let hit = cache.get(path);
  if (hit === undefined || hit.mtimeMs !== info.mtimeMs || hit.size !== info.size) {
    const json = parseCollectionJson(await readFile(path, 'utf8'));
    const keys = uniqueModKeys(json.mods);
    hit = { mtimeMs: info.mtimeMs, size: info.size, byKey: new Map(json.mods.map((m, i) => [keys[i] ?? '', m])) };
    cache.set(path, hit);
  }
  return hit.byKey.get(key);
}

function listSome(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join('; ');
  return items.length > MAX_LISTED ? `${shown}; and ${items.length - MAX_LISTED} more` : shown;
}

export function hashesWarning(result: HashesResult, listed: number): string | undefined {
  if (result.mode === 'unchanged') {
    return `${EDITS_WARNING_PREFIX}the collection lists the exact files to install, but ${result.reason ?? 'they could not be matched'} — installed everything in the download instead.`;
  }
  if (result.missing.length === 0) return undefined;
  return `${EDITS_WARNING_PREFIX}${result.missing.length} of ${listed} listed file(s) were not in the download: ${listSome(result.missing)}.`;
}

export function patchesWarning(result: PatchResult): string | undefined {
  if (result.skipped.length === 0) return undefined;
  const total = result.skipped.length + result.applied.length;
  const items = result.skipped.map((s) => `${s.path.replace(/\\/g, '/')} (${s.reason})`);
  return `${EDITS_WARNING_PREFIX}${result.skipped.length} of ${total} file patch(es) not applied, those files are installed unedited: ${listSome(items)}.`;
}

async function runPatches(profile: Pick<ProfileState, 'profileDir' | 'revision'>, entry: CollectionModEntry, out: string): Promise<string | undefined> {
  const patches = entry.patches ?? {};
  if (Object.keys(patches).length === 0) return undefined;
  const root = join(collectionDir(profile), 'patches');
  const patchesDir = join(root, entry.name);
  const result: PatchResult = isInside(root, patchesDir)
    ? await applyCollectionPatches({ patchesDir, patches, modRoot: out })
    : { applied: [], skipped: Object.keys(patches).map((path) => ({ path, reason: 'unsafe mod name for the patches folder' })) };
  console.info(`[runner] ${entry.name}: applied ${result.applied.length} patch(es), skipped ${result.skipped.length}`);
  for (const s of result.skipped) console.warn(`[runner] ${entry.name}: patch ${s.path} skipped: ${s.reason}`);
  return patchesWarning(result);
}

/**
 * Applies the curator's hashes + patches for one mod to its extracted folder `out`.
 * Returns warnings to show on the mod (empty when everything applied or there was nothing to do).
 */
export async function applyCuratorEdits(profile: Pick<ProfileState, 'profileDir' | 'revision'>, key: string, out: string): Promise<string[]> {
  const entry = await collectionEntryFor(profile, key);
  if (entry === undefined) return [];
  const warnings: string[] = [];
  if (entry.hashes !== undefined && entry.hashes.length > 0) {
    const result = await applyHashesFilter(out, entry.hashes);
    console.info(`[runner] ${entry.name}: file list ${result.mode}, placed ${result.placed}, missing ${result.missing.length}, dropped ${result.dropped}`);
    const warning = hashesWarning(result, entry.hashes.length);
    if (warning !== undefined) warnings.push(warning);
  }
  const warning = await runPatches(profile, entry, out);
  if (warning !== undefined) warnings.push(warning);
  return warnings;
}

/** Replaces the previous install's curator-edit warnings with `fresh`. */
export function mergeEditWarnings(existing: string[], fresh: string[]): string[] {
  return [...existing.filter((w) => !w.startsWith(EDITS_WARNING_PREFIX)), ...fresh];
}
