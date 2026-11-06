// SPDX-License-Identifier: AGPL-3.0-only
// Collection "hashes" (Vortex's "replicate" install mode) for a freshly extracted mod. Pure Node.
//
// Vortex semantics (mod_management/listInstaller.tsx, used when collection.json mods[].hashes is set):
// the game's installer is bypassed; every extracted file is hashed (md5), and each listed item is installed by
// copying the extracted file with that md5 to item.path (relative to the mod's folder). Paths in the archive do not
// matter, only content does. Files not on the list are not installed. Missing items only produce a warning.
// We do the same, rebuilding the extracted folder so the Stardew analyzer then sees the curator's layout.
// If nothing on the list matches (or the list has no md5s), we keep the download as extracted and warn.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { normalizeEntryPath } from './archive-safety';
import { mapLimit, walkFiles } from './profile-fs';

export interface HashItem {
  path: string;
  md5?: string;
  xxh64?: string;
}

export interface HashesResult {
  /** 'replicated': modRoot now holds exactly the listed files; 'unchanged': modRoot was left as extracted. */
  mode: 'replicated' | 'unchanged';
  /** Listed files placed into modRoot. */
  placed: number;
  /** Listed paths that were not found in the download (or were unsafe). */
  missing: string[];
  /** Extracted files that were dropped because they are not on the list. */
  dropped: number;
  /** Set when mode is 'unchanged' and the list could not be used. */
  reason?: string;
}

const MD5 = /^[0-9a-f]{32}$/;

function md5Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    createReadStream(path)
      .on('error', (err) => reject(new Error(`Cannot hash ${path}: ${err.message}`, { cause: err })))
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

interface Placement {
  rel: string;
  source: string;
}

/** Maps each listed item to an extracted file by md5; the rest are missing. Duplicate paths keep the first. */
function plan(items: HashItem[], byMd5: Map<string, string>): { placements: Placement[]; missing: string[] } {
  const placements: Placement[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let rel: string;
    try {
      rel = normalizeEntryPath(item.path);
    } catch (err) {
      console.warn(`[hashes] ignoring unsafe listed path: ${(err as Error).message}`);
      missing.push(item.path);
      continue;
    }
    if (rel === '' || seen.has(rel.toLowerCase())) continue;
    const sum = (item.md5 ?? '').toLowerCase();
    const source = MD5.test(sum) ? byMd5.get(sum) : undefined;
    if (source === undefined) missing.push(item.path);
    else {
      seen.add(rel.toLowerCase());
      placements.push({ rel, source });
    }
  }
  return { placements, missing };
}

async function rebuild(modRoot: string, placements: Placement[]): Promise<void> {
  const next = await mkdtemp(join(dirname(modRoot), `.${basename(modRoot)}.replicate-`));
  try {
    for (const { rel, source } of placements) {
      const target = join(next, ...rel.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    await rm(modRoot, { recursive: true, force: true });
    await rename(next, modRoot);
  } catch (err) {
    await rm(next, { recursive: true, force: true });
    throw new Error(`Could not rebuild ${modRoot} from the collection's file list: ${(err as Error).message}`, { cause: err });
  }
}

/** Applies a mods[].hashes list to modRoot (see the header comment for the exact semantics). */
export async function applyHashesFilter(modRoot: string, hashes: HashItem[]): Promise<HashesResult> {
  const items = hashes.filter((h) => MD5.test((h.md5 ?? '').toLowerCase()));
  if (items.length === 0) {
    const reason = hashes.length === 0 ? 'the list is empty' : 'the list has no md5 checksums (only xxh64, which is not supported)';
    return { mode: 'unchanged', placed: 0, missing: [], dropped: 0, reason };
  }
  const files = await walkFiles(modRoot);
  const sums = await mapLimit(files, 4, (f) => md5Of(f.abs));
  const byMd5 = new Map<string, string>();
  files.forEach((f, i) => {
    const sum = sums[i];
    if (sum !== undefined && !byMd5.has(sum)) byMd5.set(sum, f.abs);
  });
  // Items without a usable md5 can't be looked up: plan() counts them as missing.
  const { placements, missing } = plan(hashes, byMd5);
  if (placements.length === 0) {
    return { mode: 'unchanged', placed: 0, missing, dropped: 0, reason: 'none of the listed files are in the download' };
  }
  const used = new Set(placements.map((p) => p.source));
  await rebuild(modRoot, placements);
  return { mode: 'replicated', placed: placements.length, missing, dropped: files.filter((f) => !used.has(f.abs)).length };
}
