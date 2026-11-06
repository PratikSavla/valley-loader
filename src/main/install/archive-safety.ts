// SPDX-License-Identifier: AGPL-3.0-only
// Path safety helpers for archive extraction: entry-name validation, symlink checks, filtered moves. Pure Node.
import { chmod, copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface WalkedEntry {
  /** Path relative to the walk root, "/"-separated (names may still contain "\" from the archive). */
  rel: string;
  abs: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
}

/**
 * Normalize an archive entry name into a safe, relative, "/"-separated path.
 * Windows "\" separators become "/"; "." and empty segments are dropped.
 * Throws for absolute paths, drive letters, ".." segments and NUL bytes.
 * Returns "" for entries that name the archive root itself (e.g. "./").
 */
export function normalizeEntryPath(name: string): string {
  const unified = name.replace(/\\/g, '/');
  if (unified.includes('\0')) {
    throw new Error(`Unsafe archive entry (NUL byte): ${JSON.stringify(name)}`);
  }
  if (unified.startsWith('/')) {
    throw new Error(`Unsafe archive entry (absolute path): ${JSON.stringify(name)}`);
  }
  if (/^[a-zA-Z]:/.test(unified)) {
    throw new Error(`Unsafe archive entry (drive letter): ${JSON.stringify(name)}`);
  }
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) {
    throw new Error(`Unsafe archive entry (".." path traversal): ${JSON.stringify(name)}`);
  }
  return parts.join('/');
}

/** Lowercased, normalized key used to compare `onlyPaths` with archive entries. */
export function pathKey(name: string): string {
  return normalizeEntryPath(name).toLowerCase();
}

/** Recursively list everything under root without following symlinks (lstat semantics). */
export async function walkTree(root: string): Promise<WalkedEntry[]> {
  const out: WalkedEntry[] = [];
  const visit = async (absDir: string, relDir: string): Promise<void> => {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) out.push({ rel, abs, kind: 'symlink' });
      else if (entry.isDirectory()) {
        out.push({ rel, abs, kind: 'dir' });
        await visit(abs, rel);
      } else if (entry.isFile()) out.push({ rel, abs, kind: 'file' });
      else out.push({ rel, abs, kind: 'other' });
    }
  };
  await visit(root, '');
  return out;
}

/**
 * Reject a freshly extracted tree that contains symlinks or special files (fifos, devices, sockets).
 * Offending entries are removed before throwing so nothing dangerous is left behind.
 */
export async function assertNoSymlinks(root: string): Promise<void> {
  const bad = (await walkTree(root)).filter((e) => e.kind === 'symlink' || e.kind === 'other');
  if (bad.length === 0) return;
  await Promise.all(bad.map((e) => rm(e.abs, { force: true })));
  const names = bad.map((e) => e.rel).slice(0, 5).join(', ');
  throw new Error(`Archive contains symlinks or special files, refusing to install: ${names}`);
}

async function moveFile(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw new Error(`Could not move extracted file to ${dest}: ${(err as Error).message}`, { cause: err });
    }
    await copyFile(src, dest);
    await rm(src, { force: true });
  }
}

/**
 * Move regular files (and, without a filter, empty directories) from `staging` into `destDir`.
 * Names are re-normalized, so a file literally named "Foo\bar.txt" lands at Foo/bar.txt.
 * When `only` is given (keys from {@link pathKey}), only matching files are moved.
 */
export async function moveSelected(staging: string, destDir: string, only?: Set<string>): Promise<void> {
  const entries = await walkTree(staging);
  for (const entry of entries) {
    const rel = normalizeEntryPath(entry.rel);
    if (rel === '') continue;
    const target = join(destDir, ...rel.split('/'));
    if (entry.kind === 'dir') {
      if (!only) await mkdir(target, { recursive: true });
      continue;
    }
    if (entry.kind !== 'file') {
      throw new Error(`Unexpected non-regular file in extracted archive: ${entry.rel}`);
    }
    if (only && !only.has(rel.toLowerCase())) continue;
    await moveFile(entry.abs, target);
  }
}

/** Make sure a binary has its execute bits set (npm tarballs sometimes drop them). */
export async function ensureExecutable(binPath: string): Promise<void> {
  let mode: number;
  try {
    mode = (await stat(binPath)).mode;
  } catch (err) {
    throw new Error(`Bundled binary not found at ${binPath}: ${(err as Error).message}`, { cause: err });
  }
  if ((mode & 0o111) === 0o111) return;
  try {
    await chmod(binPath, 0o755);
  } catch (err) {
    throw new Error(`Could not make ${binPath} executable: ${(err as Error).message}`, { cause: err });
  }
}
