// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bspatch, crc32Hex, parseBsdiffHeader, readBsdiffBlocks, readOfftin } from '../src/main/install/bspatch';
import { bunzip2 } from '../src/main/install/bzip2';
import { cleanupTempDirs } from './helpers/archive-fixtures';
import { buildPatch, bzip2Compress, naivePatch, offtout, systemBspatch } from './helpers/bsdiff-fixtures';

afterAll(cleanupTempDirs);

const LIVE_PATCHES = join(__dirname, 'fixtures', 'live', 'tckf0m-r114', 'patches');

async function listDiffs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listDiffs(abs)));
    else if (entry.name.endsWith('.diff')) out.push(abs);
  }
  return out;
}

describe('crc32Hex', () => {
  it('matches the standard CRC-32 check values, as 8 uppercase hex digits', () => {
    expect(crc32Hex(Buffer.from('123456789'))).toBe('CBF43926');
    expect(crc32Hex(new Uint8Array(0))).toBe('00000000');
    expect(crc32Hex(Buffer.from('The quick brown fox jumps over the lazy dog'))).toBe('414FA339');
  });
});

describe('bunzip2', () => {
  const cases: [string, Buffer][] = [
    ['empty', Buffer.alloc(0)],
    ['one byte', Buffer.from('a')],
    ['text with repeats', Buffer.from('hello hello hello banana bandana '.repeat(40))],
    ['long runs (RLE1 + RUNA/RUNB)', Buffer.concat([Buffer.alloc(70_000, 0x61), Buffer.from('xyz'), Buffer.alloc(300, 0)])],
    ['random bytes (all 256 symbols)', randomBytes(50_000)],
  ];
  for (const [name, input] of cases) {
    it(`decodes /usr/bin/bzip2 output: ${name}`, () => {
      expect(Buffer.from(bunzip2(bzip2Compress(input))).equals(input)).toBe(true);
    });
  }

  it('decodes multi-block streams (-1 = 100k blocks) and concatenated streams', () => {
    const big = Buffer.concat([randomBytes(150_000), Buffer.alloc(200_000, 7), randomBytes(90_000)]);
    expect(Buffer.from(bunzip2(bzip2Compress(big, 1))).equals(big)).toBe(true);
    const joined = Buffer.concat([bzip2Compress(Buffer.from('first,')), bzip2Compress(Buffer.from('second'))]);
    expect(Buffer.from(bunzip2(joined)).toString()).toBe('first,second');
  });

  it('rejects corrupt data and output past the limit', () => {
    const z = bzip2Compress(Buffer.from('some text to compress, some text to compress'));
    const corrupt = Buffer.from(z);
    corrupt[20] = (corrupt[20] ?? 0) ^ 0xff;
    expect(() => bunzip2(corrupt)).toThrow(/bzip2:/);
    expect(() => bunzip2(Buffer.from('not bzip2'))).toThrow(/BZh/);
    expect(() => bunzip2(z.subarray(0, z.length - 6))).toThrow(/bzip2:/);
    expect(() => bunzip2(z, 10)).toThrow(/limit/);
  });
});

describe('bspatch against /usr/bin/bspatch', () => {
  it('reads sign-magnitude int64 values', () => {
    for (const n of [0, 1, 255, 256, 123_456_789, -1, -300, -(2 ** 40)]) expect(readOfftin(offtout(n), 0)).toBe(n);
  });

  it('applies a naive whole-file patch (old → new) exactly', async () => {
    const oldBuf = Buffer.from('{"Name":"Ridgeside","Enabled":false,"Speed":1}');
    const newBuf = Buffer.from('{"Name":"Ridgeside","Enabled":true,"Speed":12,"Extra":"yes"}');
    const patch = naivePatch(oldBuf, newBuf);
    expect(Buffer.from(bspatch(oldBuf, patch)).toString()).toBe(newBuf.toString());
    expect((await systemBspatch(oldBuf, patch)).equals(newBuf)).toBe(true);
  });

  it('matches the oracle with several control tuples, negative seeks and reads past the end of the old file', async () => {
    const oldBuf = randomBytes(4096);
    const ctrl = [
      { add: 1000, copy: 50, seek: 500 }, // oldpos 0→1000→1500
      { add: 300, copy: 0, seek: -1700 }, // oldpos 1500→1800→100 (negative seek)
      { add: 200, copy: 25, seek: -300 }, // oldpos 100→300→0 (negative seek back to the start)
      { add: 150, copy: 10, seek: 3800 }, // oldpos 0→150→3950
      { add: 300, copy: 5, seek: 0 }, // reads old[3950..4250): bytes past the end count as 0
    ];
    const addTotal = ctrl.reduce((s, t) => s + t.add, 0);
    const copyTotal = ctrl.reduce((s, t) => s + t.copy, 0);
    const diff = randomBytes(addTotal);
    const extra = randomBytes(copyTotal);
    const patch = buildPatch(ctrl, diff, extra, addTotal + copyTotal);
    const ours = Buffer.from(bspatch(oldBuf, patch));
    const oracle = await systemBspatch(oldBuf, patch);
    expect(ours.length).toBe(addTotal + copyTotal);
    expect(ours.equals(oracle)).toBe(true);
    // Spot-check the semantics directly: first byte is diff[0] + old[0]; first extra byte follows the first add.
    expect(ours[0]).toBe(((diff[0] ?? 0) + (oldBuf[0] ?? 0)) & 0xff);
    expect(ours[1000]).toBe(extra[0]);
    expect(ours[ours.length - 6]).toBe(diff[addTotal - 1]); // last add byte read old[4249], past the end
  });

  it('treats reads before the start of the old file as 0 (bsdiff 4.3 semantics)', () => {
    // /usr/bin/bspatch reads out of bounds here (undefined behaviour), so this case is checked by hand.
    const oldBuf = Buffer.from([10, 20, 30, 40]);
    const diff = Buffer.from([1, 2, 3, 4, 5, 6]);
    const patch = buildPatch([{ add: 2, copy: 0, seek: -4 }, { add: 4, copy: 0, seek: 0 }], diff, Buffer.alloc(0), 6);
    // oldpos 0→2, seek -4 → -2; the second tuple reads old[-2], old[-1], old[0], old[1].
    expect([...bspatch(oldBuf, patch)]).toEqual([11, 22, 3, 4, 15, 26]);
  });

  it('matches the oracle on a large binary-like file (multi-block bzip2 inside the patch)', async () => {
    const oldBuf = Buffer.concat([randomBytes(200_000), Buffer.alloc(300_000, 0x90)]);
    const newBuf = Buffer.from(oldBuf);
    newBuf.write('PATCHED', 12_345);
    newBuf.writeUInt32LE(0xdeadbeef, 450_000);
    const grown = Buffer.concat([newBuf, randomBytes(1000)]);
    const patch = naivePatch(oldBuf, grown);
    expect(Buffer.from(bspatch(oldBuf, patch)).equals(grown)).toBe(true);
    expect((await systemBspatch(oldBuf, patch)).equals(grown)).toBe(true);
  });

  it('rejects malformed patches', () => {
    const oldBuf = Buffer.from('abc');
    expect(() => bspatch(oldBuf, Buffer.from('BSDIFF41' + '\0'.repeat(24)))).toThrow(/not a BSDIFF40/);
    const good = naivePatch(oldBuf, Buffer.from('abcd'));
    expect(() => bspatch(oldBuf, good.subarray(0, 40))).toThrow(/bspatch/);
    // A tuple that writes past newSize.
    const overflow = buildPatch([{ add: 3, copy: 2, seek: 0 }], Buffer.alloc(3), Buffer.alloc(2), 4);
    expect(() => bspatch(oldBuf, overflow)).toThrow(/corrupt patch/);
    const negative = buildPatch([{ add: -1, copy: 0, seek: 0 }], Buffer.alloc(0), Buffer.alloc(0), 1);
    expect(() => bspatch(oldBuf, negative)).toThrow(/corrupt patch/);
    const short = buildPatch([{ add: 1, copy: 0, seek: 0 }], Buffer.alloc(1), Buffer.alloc(0), 2);
    expect(() => bspatch(oldBuf, short)).toThrow(/control block ended early/);
  });
});

// Real curator patches are only present after `npm run live-check` downloads a collection (git-ignored).
describe.skipIf(!existsSync(LIVE_PATCHES))('live tckf0m r114 patches', () => {
  it('every real patch parses and its three blocks decompress to consistent sizes', async () => {
    const diffs = await listDiffs(LIVE_PATCHES);
    expect(diffs.length).toBeGreaterThanOrEqual(30);
    const dll = diffs.find((d) => d.endsWith(join('RidgesideVillage', 'RidgesideVillage.dll.diff')));
    expect(dll).toBeDefined();
    for (const path of diffs) {
      const patch = await readFile(path);
      const header = parseBsdiffHeader(patch);
      const blocks = readBsdiffBlocks(patch);
      expect(blocks.ctrl.length % 24, path).toBe(0);
      let [adds, copies] = [0, 0];
      for (let at = 0; at < blocks.ctrl.length; at += 24) {
        adds += readOfftin(blocks.ctrl, at);
        copies += readOfftin(blocks.ctrl, at + 8);
      }
      // Every byte of the new file comes from exactly one diff or extra byte.
      expect(adds, path).toBe(blocks.diff.length);
      expect(copies, path).toBe(blocks.extra.length);
      expect(adds + copies, path).toBe(header.newSize);
    }
    expect((await stat(dll ?? '')).size).toBeGreaterThan(32);
  });
});
