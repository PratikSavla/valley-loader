// SPDX-License-Identifier: AGPL-3.0-only
// File-level deploy of staged mods into Mods/ with ownership tracking (files.json). Pure Node.
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { DeployResult } from './profile';
import {
  errCode,
  errMessage,
  mapLimit,
  pruneEmptyParents,
  safeModKey,
  statOrUndefined,
  walkFiles,
} from './profile-fs';

const IO_CONCURRENCY = 16;

const entrySchema = z.object({
  owner: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
  /** Staged source signature at deploy time, so a re-staged mod (new version) is redeployed. */
  srcSize: z.number().optional(),
  srcMtimeMs: z.number().optional(),
});
const manifestSchema = z.record(z.string(), entrySchema);

export type OwnedFile = z.infer<typeof entrySchema>;
/** Keyed by lowercased Mods-relative path; `rel` keeps the on-disk casing. */
type Manifest = Map<string, { rel: string; entry: OwnedFile }>;

interface Desired {
  rel: string;
  owner: string;
  src: string;
}

export interface DeployPaths {
  modsDir: string;
  stagingDir: string;
  manifestPath: string;
}

export async function loadManifest(path: string): Promise<Manifest> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return new Map();
    throw new Error(`Cannot read ${path}: ${errMessage(err)}`, { cause: err });
  }
  const parsed = manifestSchema.safeParse(JSON.parse(text) as unknown);
  if (!parsed.success) throw new Error(`Corrupt ownership file ${path}: ${parsed.error.message}`);
  const map: Manifest = new Map();
  for (const [rel, entry] of Object.entries(parsed.data)) map.set(rel.toLowerCase(), { rel, entry });
  return map;
}

export async function saveManifest(path: string, manifest: Manifest): Promise<void> {
  const sorted = [...manifest.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const obj: Record<string, OwnedFile> = {};
  for (const { rel, entry } of sorted) obj[rel] = entry;
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(obj, null, 1));
    await rename(tmp, path);
  } catch (err) {
    throw new Error(`Cannot write ownership file ${path}: ${errMessage(err)}`, { cause: err });
  }
}

/** Winner per lowercased path (later key wins) plus every distinct lower-order owner it beat. */
async function collectDesired(stagingDir: string, orderedKeys: string[]) {
  const keys = [...new Set(orderedKeys)];
  const walked = await Promise.all(
    keys.map(async (key) => {
      const dir = join(stagingDir, safeModKey(key));
      const st = await statOrUndefined(dir);
      if (!st?.isDirectory()) throw new Error(`Cannot deploy mod "${key}": it is not staged (${dir} missing)`);
      return { key, files: await walkFiles(dir) };
    }),
  );
  const desired = new Map<string, Desired>();
  const losers = new Map<string, Set<string>>();
  for (const { key, files } of walked) {
    for (const file of files) {
      const lc = file.rel.toLowerCase();
      const prev = desired.get(lc);
      if (prev && prev.owner !== key) {
        const set = losers.get(lc) ?? new Set<string>();
        set.add(prev.owner);
        losers.set(lc, set);
      }
      desired.set(lc, { rel: file.rel, owner: key, src: file.abs });
    }
  }
  return { desired, losers };
}

function sameSig(entry: OwnedFile, size: number, mtimeMs: number): boolean {
  return entry.size === size && entry.mtimeMs === mtimeMs;
}

/** Copies one winning file if needed; updates `manifest`. Returns true when a copy happened. */
async function applyFile(modsDir: string, lc: string, want: Desired, manifest: Manifest): Promise<boolean> {
  const srcStat = await statOrUndefined(want.src);
  if (!srcStat) throw new Error(`Staged file vanished during deploy: ${want.src}`);
  const dest = join(modsDir, want.rel);
  const destStat = await statOrUndefined(dest);
  if (destStat?.isDirectory()) throw new Error(`Cannot deploy ${want.rel}: a directory exists at ${dest}`);
  const old = manifest.get(lc);
  if (old && destStat && old.entry.owner === want.owner) {
    const srcUnchanged = old.entry.srcSize === srcStat.size && old.entry.srcMtimeMs === srcStat.mtimeMs;
    const userModified = !sameSig(old.entry, destStat.size, destStat.mtimeMs);
    // Same owner: skip when nothing changed, and never clobber a file the user/game edited.
    if (srcUnchanged || userModified) return false;
  }
  if (old && old.rel !== want.rel && destStat) {
    // Casing changed between winners: drop the old name so the winner's casing is used.
    await unlink(join(modsDir, old.rel)).catch((err: unknown) => {
      if (errCode(err) !== 'ENOENT') throw new Error(`Cannot replace ${old.rel}: ${errMessage(err)}`, { cause: err });
    });
  }
  try {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(want.src, dest, constants.COPYFILE_FICLONE);
  } catch (err) {
    throw new Error(`Cannot deploy ${want.rel} from mod "${want.owner}": ${errMessage(err)}`, { cause: err });
  }
  const st = await statOrUndefined(dest);
  if (!st) throw new Error(`Deployed file missing right after copy: ${dest}`);
  manifest.set(lc, {
    rel: want.rel,
    entry: { owner: want.owner, size: st.size, mtimeMs: st.mtimeMs, srcSize: srcStat.size, srcMtimeMs: srcStat.mtimeMs },
  });
  return true;
}

/** Removes owned files no mod provides any more (only if untouched since deploy). Returns count removed. */
async function removeStale(modsDir: string, desired: Map<string, Desired>, manifest: Manifest): Promise<number> {
  const stale = [...manifest.entries()].filter(([lc]) => !desired.has(lc));
  let removed = 0;
  await mapLimit(stale, IO_CONCURRENCY, async ([lc, { rel, entry }]) => {
    const dest = join(modsDir, rel);
    const st = await statOrUndefined(dest);
    if (st?.isFile() && sameSig(entry, st.size, st.mtimeMs)) {
      try {
        await unlink(dest);
      } catch (err) {
        throw new Error(`Cannot remove ${rel} (was owned by "${entry.owner}"): ${errMessage(err)}`, { cause: err });
      }
      await pruneEmptyParents(dest, modsDir);
      removed++;
    }
    // Modified or already gone: stop tracking it, leave whatever is on disk alone.
    manifest.delete(lc);
  });
  return removed;
}

function buildOverrides(desired: Map<string, Desired>, losers: Map<string, Set<string>>): DeployResult['overrides'] {
  const out: DeployResult['overrides'] = [];
  for (const [lc, set] of losers) {
    const winner = desired.get(lc);
    if (!winner) continue;
    for (const loser of set) out.push({ path: winner.rel, winner: winner.owner, loser });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.loser < b.loser ? -1 : 1));
}

export async function deployStaged(paths: DeployPaths, orderedKeys: string[]): Promise<DeployResult> {
  const { desired, losers } = await collectDesired(paths.stagingDir, orderedKeys);
  const manifest = await loadManifest(paths.manifestPath);
  await mkdir(paths.modsDir, { recursive: true });
  let copied = 0;
  let removed = 0;
  try {
    const flags = await mapLimit([...desired.entries()], IO_CONCURRENCY, ([lc, want]) =>
      applyFile(paths.modsDir, lc, want, manifest),
    );
    copied = flags.filter(Boolean).length;
    removed = await removeStale(paths.modsDir, desired, manifest);
  } catch (err) {
    // Persist what was done so far so ownership stays accurate, then surface the original failure.
    await saveManifest(paths.manifestPath, manifest).catch((saveErr: unknown) => {
      throw new Error(`${errMessage(err)} (and saving ownership failed: ${errMessage(saveErr)})`, { cause: err });
    });
    throw err;
  }
  await saveManifest(paths.manifestPath, manifest);
  return { copied, removed, overrides: buildOverrides(desired, losers) };
}
