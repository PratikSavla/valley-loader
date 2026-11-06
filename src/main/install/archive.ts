// SPDX-License-Identifier: AGPL-3.0-only
// Archive extraction: zip/7z via bundled 7za (7zip-bin). RAR is detected but not opened (see UnsupportedArchiveError). Pure Node.
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { path7za } from '7zip-bin';
import { extract7z, list7z } from './archive-7z';
import { assertNoSymlinks, ensureExecutable, moveSelected, normalizeEntryPath, pathKey } from './archive-safety';

export { ensureExecutable, normalizeEntryPath } from './archive-safety';

export type ArchiveKind = 'zip' | '7z' | 'rar' | 'unknown';

const SIGNATURES: { kind: Exclude<ArchiveKind, 'unknown'>; bytes: number[] }[] = [
  { kind: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { kind: 'zip', bytes: [0x50, 0x4b, 0x05, 0x06] }, // empty zip (end-of-central-directory only)
  { kind: '7z', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { kind: 'rar', bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] }, // RAR4 (…00) and RAR5 (…01 00)
];

/** Classify the first bytes of a file. Exported for tests and callers that already hold a header. */
export function kindFromHeader(header: Uint8Array): ArchiveKind {
  const match = SIGNATURES.find((sig) => sig.bytes.every((b, i) => header[i] === b));
  return match ? match.kind : 'unknown';
}

/** Detect by magic bytes, not extension. */
export async function detectArchiveKind(path: string): Promise<ArchiveKind> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    throw new Error(`Cannot open archive ${path}: ${(err as Error).message}`, { cause: err });
  }
  try {
    const header = new Uint8Array(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return kindFromHeader(header.subarray(0, bytesRead));
  } catch (err) {
    throw new Error(`Cannot read archive header of ${path}: ${(err as Error).message}`, { cause: err });
  } finally {
    await handle.close();
  }
}

/** Rewrite ".../app.asar/..." to ".../app.asar.unpacked/..." (binaries can't run from inside an asar). */
export function toUnpackedPath(p: string): string {
  return p.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked');
}

/** Path to the 7za binary, correcting app.asar → app.asar.unpacked when packaged. */
export function sevenZipPath(): string {
  return toUnpackedPath(path7za);
}

let executableCheck: Promise<string> | undefined;

/** sevenZipPath() with its execute bit ensured (checked once per process; retried after a failure). */
export function ensureSevenZip(): Promise<string> {
  if (!executableCheck) {
    const bin = sevenZipPath();
    // USE_SYSTEM_7ZA=true makes 7zip-bin return a bare "7za" resolved from PATH.
    const check = bin.includes('/') || bin.includes('\\') ? ensureExecutable(bin) : Promise.resolve();
    executableCheck = check.then(() => bin);
    executableCheck.catch(() => {
      executableCheck = undefined;
    });
  }
  return executableCheck;
}

async function extractWith7z(kind: 'zip' | '7z', archivePath: string, staging: string): Promise<void> {
  const bin = await ensureSevenZip();
  const entries = await list7z(bin, kind, archivePath);
  for (const entry of entries) {
    normalizeEntryPath(entry.path);
    if (entry.isSymlink) {
      throw new Error(`Archive entry is a symlink, refusing to install: ${entry.path}`);
    }
  }
  await extract7z(bin, kind, archivePath, staging);
}

function toFilter(onlyPaths: string[] | undefined): Set<string> | undefined {
  if (!onlyPaths || onlyPaths.length === 0) return undefined;
  return new Set(onlyPaths.map((p) => pathKey(p)));
}

/**
 * Extract into destDir (created if missing). Rejects entries that would escape destDir
 * (absolute paths, "..", symlinks). `onlyPaths` (archive-relative, case-insensitive, "/" separators)
 * limits extraction to those files.
 *
 * Everything is first extracted into a sibling staging dir, validated (lstat walk, no symlinks or
 * special files), then moved into destDir, so a rejected archive leaves destDir untouched.
 * An empty `onlyPaths` array is treated like no filter.
 */
/** The archive is a format Valley Loader deliberately doesn't open (RAR: its decoder's license is AGPL-incompatible). */
export class UnsupportedArchiveError extends Error {
  constructor(
    readonly kind: 'rar',
    readonly archivePath: string,
  ) {
    super(`${basename(archivePath)} is a RAR archive. Valley Loader only opens .zip and .7z files.`);
    this.name = 'UnsupportedArchiveError';
  }
}

export async function extractArchive(
  archivePath: string,
  destDir: string,
  opts?: { onlyPaths?: string[] },
): Promise<void> {
  const name = basename(archivePath);
  const kind = await detectArchiveKind(archivePath);
  if (kind === 'unknown') {
    throw new Error(`Unsupported or corrupt archive ${name}: not a zip or 7z file`);
  }
  if (kind === 'rar') throw new UnsupportedArchiveError('rar', archivePath);
  const only = toFilter(opts?.onlyPaths);
  const dest = resolve(destDir);
  await mkdir(dest, { recursive: true });
  const staging = await mkdtemp(join(dirname(dest), `.${basename(dest)}.extract-`));
  try {
    await extractWith7z(kind, archivePath, staging);
    await assertNoSymlinks(staging);
    await moveSelected(staging, dest, only);
  } catch (err) {
    throw new Error(`Failed to extract ${name} (${kind}): ${(err as Error).message}`, { cause: err });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
