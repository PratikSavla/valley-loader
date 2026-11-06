// SPDX-License-Identifier: AGPL-3.0-only
// Test helpers: build BSDIFF40 patches by hand (macOS ships /usr/bin/bspatch and /usr/bin/bzip2, but no bsdiff).
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from './archive-fixtures';

export const BZIP2_BIN = '/usr/bin/bzip2';
export const BSPATCH_BIN = '/usr/bin/bspatch';

export interface CtrlTuple {
  /** Bytes produced as diff[i] + old[oldpos + i]. */
  add: number;
  /** Bytes copied from the extra block. */
  copy: number;
  /** Move oldpos by this much afterwards (may be negative). */
  seek: number;
}

/** bsdiff's offtout: 8-byte little-endian magnitude, sign in the top bit. */
export function offtout(n: number): Buffer {
  const out = Buffer.alloc(8);
  let magnitude = Math.abs(n);
  for (let i = 0; i < 8; i++) {
    out[i] = magnitude % 256;
    magnitude = Math.floor(magnitude / 256);
  }
  if (n < 0) out[7] = (out[7] ?? 0) | 0x80;
  return out;
}

export function bzip2Compress(data: Uint8Array, level = 9): Buffer {
  return execFileSync(BZIP2_BIN, ['-c', `-${level}`], { input: data, maxBuffer: 1 << 28 });
}

/** Assemble a BSDIFF40 file from raw (uncompressed) ctrl tuples, diff bytes and extra bytes. */
export function buildPatch(ctrl: CtrlTuple[], diff: Uint8Array, extra: Uint8Array, newSize: number): Buffer {
  const ctrlRaw = Buffer.concat(ctrl.flatMap((t) => [offtout(t.add), offtout(t.copy), offtout(t.seek)]));
  const ctrlZ = bzip2Compress(ctrlRaw);
  const diffZ = bzip2Compress(diff);
  const extraZ = bzip2Compress(extra);
  const header = Buffer.concat([Buffer.from('BSDIFF40'), offtout(ctrlZ.length), offtout(diffZ.length), offtout(newSize)]);
  return Buffer.concat([header, ctrlZ, diffZ, extraZ]);
}

/** A valid (if not minimal) patch turning oldBuf into newBuf: one tuple, byte-wise diff over the overlap. */
export function naivePatch(oldBuf: Uint8Array, newBuf: Uint8Array): Buffer {
  const overlap = Math.min(oldBuf.length, newBuf.length);
  const diff = Buffer.alloc(overlap);
  for (let i = 0; i < overlap; i++) diff[i] = ((newBuf[i] ?? 0) - (oldBuf[i] ?? 0)) & 0xff;
  const extra = Buffer.from(newBuf.subarray(overlap));
  return buildPatch([{ add: overlap, copy: extra.length, seek: 0 }], diff, extra, newBuf.length);
}

/** Apply a patch with the system bspatch (the oracle). */
export async function systemBspatch(oldBuf: Uint8Array, patch: Uint8Array): Promise<Buffer> {
  const dir = await makeTempDir('vl-bspatch-');
  const [oldPath, newPath, patchPath] = ['old.bin', 'new.bin', 'p.diff'].map((n) => join(dir, n)) as [string, string, string];
  await writeFile(oldPath, oldBuf);
  await writeFile(patchPath, patch);
  execFileSync(BSPATCH_BIN, [oldPath, newPath, patchPath]);
  return readFile(newPath);
}
