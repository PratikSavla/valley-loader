// SPDX-License-Identifier: AGPL-3.0-only
// Pure-TS bspatch for BSDIFF40 patches (the format Vortex writes for collection "patches").
// Layout: "BSDIFF40", three int64 sign-magnitude lengths (ctrl block, diff block, new file size), then three
// bzip2-compressed blocks: ctrl (x, y, z int64 triples), diff (bytes added to old), extra (bytes copied as is).
import { crc32 } from 'node:zlib';
import { bunzip2 } from './bzip2';

const MAGIC = 'BSDIFF40';
const HEADER_SIZE = 32;
/** Refuse to build files larger than this (a corrupt header must not make us allocate gigabytes). */
export const MAX_PATCHED_SIZE = 512 * 1024 * 1024;

export interface BsdiffHeader {
  ctrlLength: number;
  diffLength: number;
  newSize: number;
}

export interface BsdiffBlocks extends BsdiffHeader {
  ctrl: Uint8Array;
  diff: Uint8Array;
  extra: Uint8Array;
}

/** bsdiff's offtin: 8-byte little-endian magnitude with the sign in the top bit of the last byte. */
export function readOfftin(buf: Uint8Array, at: number): number {
  const top = buf[at + 7];
  if (top === undefined) throw new Error('bspatch: truncated integer');
  let value = top & 0x7f;
  for (let i = 6; i >= 0; i--) value = value * 256 + (buf[at + i] ?? 0);
  if (!Number.isSafeInteger(value)) throw new Error('bspatch: integer too large');
  return (top & 0x80) !== 0 ? -value : value;
}

export function parseBsdiffHeader(patch: Uint8Array): BsdiffHeader {
  if (patch.length < HEADER_SIZE || new TextDecoder().decode(patch.subarray(0, 8)) !== MAGIC) {
    throw new Error('bspatch: not a BSDIFF40 patch');
  }
  const header = { ctrlLength: readOfftin(patch, 8), diffLength: readOfftin(patch, 16), newSize: readOfftin(patch, 24) };
  if (header.ctrlLength < 0 || header.diffLength < 0 || header.newSize < 0) throw new Error('bspatch: negative length in header');
  if (HEADER_SIZE + header.ctrlLength + header.diffLength > patch.length) throw new Error('bspatch: truncated patch');
  if (header.newSize > MAX_PATCHED_SIZE) throw new Error(`bspatch: patched file would be ${header.newSize} bytes (limit ${MAX_PATCHED_SIZE})`);
  return header;
}

/** Parses the header and decompresses all three blocks (no old file needed). */
export function readBsdiffBlocks(patch: Uint8Array): BsdiffBlocks {
  const header = parseBsdiffHeader(patch);
  const diffStart = HEADER_SIZE + header.ctrlLength;
  const extraStart = diffStart + header.diffLength;
  const block = (name: string, from: number, to: number, max: number): Uint8Array => {
    try {
      return bunzip2(patch.subarray(from, to), max);
    } catch (err) {
      throw new Error(`bspatch: ${name} block: ${(err as Error).message}`, { cause: err });
    }
  };
  // Real ctrl blocks hold far fewer triples than output bytes; the bound only stops decompression bombs.
  return {
    ...header,
    ctrl: block('ctrl', HEADER_SIZE, diffStart, 24 * header.newSize + (1 << 20)),
    diff: block('diff', diffStart, extraStart, header.newSize),
    extra: block('extra', extraStart, patch.length, header.newSize),
  };
}

/** Applies a BSDIFF40 patch to `old`. Throws on any malformed or out-of-range control data. */
export function bspatch(old: Uint8Array, patch: Uint8Array): Uint8Array {
  const { ctrl, diff, extra, newSize } = readBsdiffBlocks(patch);
  const out = new Uint8Array(newSize);
  let [newPos, oldPos, ctrlPos, diffPos, extraPos] = [0, 0, 0, 0, 0];
  while (newPos < newSize) {
    if (ctrlPos + 24 > ctrl.length) throw new Error('bspatch: control block ended early');
    const add = readOfftin(ctrl, ctrlPos);
    const copy = readOfftin(ctrl, ctrlPos + 8);
    const seek = readOfftin(ctrl, ctrlPos + 16);
    ctrlPos += 24;
    if (add < 0 || copy < 0 || newPos + add > newSize || diffPos + add > diff.length) {
      throw new Error('bspatch: corrupt patch (diff range)');
    }
    for (let i = 0; i < add; i++) {
      const o = oldPos + i;
      const base = o >= 0 && o < old.length ? (old[o] ?? 0) : 0;
      out[newPos + i] = ((diff[diffPos + i] ?? 0) + base) & 0xff;
    }
    newPos += add;
    oldPos += add;
    diffPos += add;
    if (newPos + copy > newSize || extraPos + copy > extra.length) throw new Error('bspatch: corrupt patch (extra range)');
    out.set(extra.subarray(extraPos, extraPos + copy), newPos);
    newPos += copy;
    extraPos += copy;
    oldPos += seek;
  }
  return out;
}

/** CRC32 (zlib/IEEE, the one 7-Zip lists and Vortex stores) as 8 uppercase hex digits. */
export function crc32Hex(data: Uint8Array): string {
  return (crc32(data) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}
