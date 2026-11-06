// SPDX-License-Identifier: AGPL-3.0-only
// Applies a collection's binary patches (collection.json mods[].patches) to a freshly extracted mod. Pure Node.
//
// Vortex semantics (collections/util/binaryPatching.ts → applyPatches):
// - keys are paths relative to the mod's Vortex staging folder (installer output, Windows "\" separators);
// - the diff lives at <collection>/patches/<mod name>/<key>.diff and is BSDIFF40;
// - the value is the CRC32 of the ORIGINAL, unpatched file (from the archive listing); the patch is applied only
//   when the file on disk has that CRC, otherwise it is skipped with a warning; any other failure is reported and
//   the remaining patches still run. The mod stays installed either way.
// Our extracted tree keeps the archive layout, which can differ from Vortex's staging layout by wrapper folders,
// so each key is matched by progressively shorter path suffixes (case-insensitive, exactly one candidate).
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { bspatch, crc32Hex } from './bspatch';
import { errCode, errMessage, walkFiles, type WalkedFile } from './profile-fs';

export interface PatchSkip {
  /** The key as written in collection.json. */
  path: string;
  reason: string;
}

export interface PatchResult {
  /** Paths (relative to modRoot, "/"-separated) of files that were patched. */
  applied: string[];
  skipped: PatchSkip[];
}

export interface ApplyPatchesArgs {
  /** <collection folder>/patches/<mod name>. */
  patchesDir: string;
  /** collection.json mods[].patches: key → CRC32 (8 hex digits) of the unpatched file. */
  patches: Record<string, unknown>;
  /** Folder holding the extracted mod; only files under it are ever written. */
  modRoot: string;
}

/** Splits a patch key into safe path segments; undefined for absolute, drive-letter, ".." or NUL keys. */
export function patchKeySegments(key: string): string[] | undefined {
  const unified = key.replace(/\\/g, '/');
  if (unified.includes('\0') || unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) return undefined;
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.includes('..')) return undefined;
  return parts;
}

export type TargetMatch = { file: WalkedFile } | { reason: string };

/**
 * Finds the file a patch key refers to: tries the whole key, then drops leading folders one at a time.
 * At each length, files whose path equals the suffix or ends with "/<suffix>" are candidates (case-insensitive);
 * one candidate wins, several are ambiguous unless exactly one equals the suffix outright.
 */
export function locatePatchTarget(segments: string[], files: WalkedFile[]): TargetMatch {
  const keyed = files.map((file) => ({ file, lower: file.rel.toLowerCase() }));
  for (let start = 0; start < segments.length; start++) {
    const suffix = segments.slice(start).join('/').toLowerCase();
    const matches = keyed.filter((f) => f.lower === suffix || f.lower.endsWith(`/${suffix}`));
    if (matches.length === 0) continue;
    const exact = matches.filter((f) => f.lower === suffix);
    const only = matches.length === 1 ? matches[0] : exact.length === 1 ? exact[0] : undefined;
    if (only !== undefined) return { file: only.file };
    return { reason: `ambiguous: ${matches.length} files match "${suffix}"` };
  }
  return { reason: 'file not found in the download' };
}

function normalizeCrc(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[0-9a-f]{1,8}$/i.test(value.trim())) return undefined;
  return value.trim().toUpperCase().padStart(8, '0');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (errCode(err) === 'ENOENT') return false;
    throw new Error(`Cannot check ${path}: ${errMessage(err)}`, { cause: err });
  }
}

/** Writes next to the target, then renames over it, so a crash never leaves a half-written file. */
async function writeAtomically(target: string, data: Uint8Array): Promise<void> {
  const tmp = join(dirname(target), `.vl-patch-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, data);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Patches one file; returns the patched file, or why it was skipped. */
async function applyOne(key: string, expectedRaw: unknown, args: ApplyPatchesArgs, files: WalkedFile[]): Promise<string | WalkedFile> {
  const segments = patchKeySegments(key);
  if (segments === undefined) return 'unsafe path (absolute or "..")';
  const expected = normalizeCrc(expectedRaw);
  if (expected === undefined) return `invalid CRC32 value ${JSON.stringify(expectedRaw)}`;
  const diffPath = `${join(args.patchesDir, ...segments)}.diff`;
  if (!(await exists(diffPath))) return 'patch file missing from the collection';
  const match = locatePatchTarget(segments, files);
  if ('reason' in match) return match.reason;
  const original = await readFile(match.file.abs);
  const actual = crc32Hex(original);
  if (actual !== expected) return `file differs from the one the curator edited (CRC32 ${actual}, expected ${expected})`;
  let patched: Uint8Array;
  try {
    patched = bspatch(original, await readFile(diffPath));
  } catch (err) {
    return `patch could not be applied: ${errMessage(err)}`;
  }
  await writeAtomically(match.file.abs, patched);
  return match.file;
}

/** Applies every patch it safely can. A bad patch is reported in `skipped`, never thrown; only listing modRoot can throw. */
export async function applyCollectionPatches(args: ApplyPatchesArgs): Promise<PatchResult> {
  const files = await walkFiles(args.modRoot);
  const result: PatchResult = { applied: [], skipped: [] };
  for (const [key, crc] of Object.entries(args.patches)) {
    let outcome: string | WalkedFile;
    try {
      outcome = await applyOne(key, crc, args, files);
    } catch (err) {
      console.error(`[patches] could not patch ${JSON.stringify(key)}`, err);
      outcome = `could not patch: ${errMessage(err)}`;
    }
    if (typeof outcome === 'string') result.skipped.push({ path: key, reason: outcome });
    else result.applied.push(outcome.rel);
  }
  return result;
}
