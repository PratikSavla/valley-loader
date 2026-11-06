// SPDX-License-Identifier: AGPL-3.0-only
// Filesystem helpers for profile staging/deploy. Pure Node.
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** Node error code, if any. */
export function errCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const { code } = err as { code: unknown };
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Filesystem-safe, collision-resistant folder name for a mod key:
 * lowercase, chars outside [a-z0-9._-] → "_", truncated, plus "-<8 hex of sha1(rawKey)>".
 */
export function safeModKey(modKey: string): string {
  const base = modKey
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_')
    .slice(0, 80);
  const hash = createHash('sha1').update(modKey).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/** lstat that returns undefined for a missing path and rethrows anything else with context. */
export async function statOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (err) {
    if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') return undefined;
    throw new Error(`Cannot stat ${path}: ${errMessage(err)}`, { cause: err });
  }
}

/**
 * Move a file or directory. Falls back to copy+delete across devices (EXDEV).
 * If `to` is an existing directory and `from` is a directory, contents are merged (from wins).
 */
export async function movePath(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  const existing = await statOrUndefined(to);
  try {
    if (!existing) {
      await rename(from, to);
      return;
    }
  } catch (err) {
    if (errCode(err) !== 'EXDEV') {
      throw new Error(`Cannot move ${from} to ${to}: ${errMessage(err)}`, { cause: err });
    }
  }
  try {
    await cp(from, to, { recursive: true, force: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  } catch (err) {
    throw new Error(`Cannot copy ${from} to ${to}: ${errMessage(err)}`, { cause: err });
  }
}

export interface WalkedFile {
  /** Path relative to the walk root, always "/"-separated. */
  rel: string;
  abs: string;
}

/** Regular files under root (recursive). Symlinks and special files are ignored on purpose. */
export async function walkFiles(root: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`Cannot read directory ${dir}: ${errMessage(err)}`, { cause: err });
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push({ abs, rel: relative(root, abs).split(sep).join('/') });
    }
  }
  return out;
}

/** Remove empty directories from dirname(filePath) upwards, stopping at (and never removing) stopAt. */
export async function pruneEmptyParents(filePath: string, stopAt: string): Promise<void> {
  let dir = dirname(filePath);
  while (dir.startsWith(stopAt + sep) && dir !== stopAt) {
    try {
      await rmdir(dir);
    } catch (err) {
      const code = errCode(err);
      if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOENT') return;
      throw new Error(`Cannot remove empty directory ${dir}: ${errMessage(err)}`, { cause: err });
    }
    dir = dirname(dir);
  }
}

/** Run `fn` over items with at most `limit` in flight. Rejects on the first failure (after in-flight work settles). */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failure: { err: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i] as T);
      } catch (err) {
        failure ??= { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw failure.err;
  return results;
}
