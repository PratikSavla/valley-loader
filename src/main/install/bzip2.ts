// SPDX-License-Identifier: AGPL-3.0-only
// Pure-TS bzip2 decompressor (no dependencies, no child processes). Used for the three compressed blocks of
// BSDIFF40 patches. Implements the bzip2 1.0.x format: Huffman + MTF + RUNA/RUNB → inverse BWT → RLE1,
// verifying every block CRC and the combined stream CRC. Concatenated streams are decoded back to back.

const GROUP_SIZE = 50;
const MAX_CODE_LEN = 20;
const BLOCK_MAGIC = [0x314159, 0x265359] as const;
const EOS_MAGIC = [0x177245, 0x385090] as const;

function fail(what: string): never {
  throw new Error(`bzip2: ${what}`);
}

/** bzip2's CRC32 is MSB-first (poly 0x04C11DB7), unlike zlib's reflected CRC32. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c >>> 0;
  }
  return table;
})();

class BitReader {
  private pos = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  bit(): number {
    const byte = this.data[this.pos >>> 3];
    if (byte === undefined) fail('unexpected end of data');
    const value = (byte >>> (7 - (this.pos & 7))) & 1;
    this.pos += 1;
    return value;
  }

  /** Reads n ≤ 32 bits, most significant first, as an unsigned number. */
  bits(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) value = (value << 1) | this.bit();
    return value >>> 0;
  }

  alignToByte(): void {
    this.pos = (this.pos + 7) & ~7;
  }

  /** True when the next whole bytes spell "BZh" (another concatenated stream follows). */
  atStreamHeader(): boolean {
    const at = this.pos >>> 3;
    return this.data[at] === 0x42 && this.data[at + 1] === 0x5a && this.data[at + 2] === 0x68;
  }
}

class ByteSink {
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  push(byte: number): void {
    if (this.len >= this.max) fail(`output exceeds the ${this.max}-byte limit`);
    if (this.len === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = byte;
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

interface Huffman {
  minLen: number;
  maxLen: number;
  /** Per code length: first canonical code, how many codes, index of the first symbol in perm. */
  first: Int32Array;
  count: Int32Array;
  offset: Int32Array;
  perm: Uint16Array;
}

function buildHuffman(lengths: Uint8Array): Huffman {
  let minLen = MAX_CODE_LEN;
  let maxLen = 0;
  for (const len of lengths) {
    minLen = Math.min(minLen, len);
    maxLen = Math.max(maxLen, len);
  }
  const first = new Int32Array(MAX_CODE_LEN + 2);
  const count = new Int32Array(MAX_CODE_LEN + 2);
  const offset = new Int32Array(MAX_CODE_LEN + 2);
  const perm = new Uint16Array(lengths.length);
  let code = 0;
  let index = 0;
  for (let len = minLen; len <= maxLen; len++) {
    first[len] = code;
    offset[len] = index;
    lengths.forEach((l, symbol) => {
      if (l === len) perm[index++] = symbol;
    });
    count[len] = index - (offset[len] ?? 0);
    code = (code + (count[len] ?? 0)) << 1;
  }
  return { minLen, maxLen, first, count, offset, perm };
}

function decodeSymbol(r: BitReader, h: Huffman): number {
  let code = r.bits(h.minLen);
  for (let len = h.minLen; ; len++) {
    const idx = code - (h.first[len] ?? 0);
    if (idx >= 0 && idx < (h.count[len] ?? 0)) return h.perm[(h.offset[len] ?? 0) + idx] ?? 0;
    if (len >= h.maxLen) fail('invalid Huffman code');
    code = (code << 1) | r.bit();
  }
}

/** The 256-bit "symbols in use" map → byte values in MTF order. */
function readSymbolMap(r: BitReader): Uint8Array {
  const ranges = r.bits(16);
  const symbols: number[] = [];
  for (let i = 0; i < 16; i++) {
    if ((ranges & (0x8000 >>> i)) === 0) continue;
    const bits = r.bits(16);
    for (let j = 0; j < 16; j++) if ((bits & (0x8000 >>> j)) !== 0) symbols.push(i * 16 + j);
  }
  if (symbols.length === 0) fail('block uses no symbols');
  return Uint8Array.from(symbols);
}

function readSelectors(r: BitReader, nGroups: number): Uint8Array {
  const nSelectors = r.bits(15);
  if (nSelectors < 1) fail('no Huffman selectors');
  const mtf = Array.from({ length: nGroups }, (_, i) => i);
  const selectors = new Uint8Array(nSelectors);
  for (let i = 0; i < nSelectors; i++) {
    let j = 0;
    while (r.bit() === 1) if (++j >= nGroups) fail('selector out of range');
    const [group] = mtf.splice(j, 1);
    mtf.unshift(group ?? 0);
    selectors[i] = group ?? 0;
  }
  return selectors;
}

function readCodeLengths(r: BitReader, alphaSize: number): Uint8Array {
  const lengths = new Uint8Array(alphaSize);
  let len = r.bits(5);
  for (let s = 0; s < alphaSize; s++) {
    for (;;) {
      if (len < 1 || len > MAX_CODE_LEN) fail('invalid Huffman code length');
      if (r.bit() === 0) break;
      len += r.bit() === 1 ? -1 : 1;
    }
    lengths[s] = len;
  }
  return lengths;
}

interface MtfOutput {
  tt: Uint32Array;
  n: number;
  counts: Uint32Array;
}

function emitRun(out: MtfOutput, byte: number, times: number): void {
  if (out.n + times > out.tt.length) fail('block is larger than its declared size');
  out.tt.fill(byte, out.n, out.n + times);
  out.n += times;
  out.counts[byte] = (out.counts[byte] ?? 0) + times;
}

/** Huffman → RUNA/RUNB + MTF decoding into tt (one byte value per entry). */
function decodeMtf(r: BitReader, tables: Huffman[], selectors: Uint8Array, symbols: Uint8Array, maxBlock: number): MtfOutput {
  const out: MtfOutput = { tt: new Uint32Array(maxBlock), n: 0, counts: new Uint32Array(256) };
  const mtf = Uint8Array.from({ length: 256 }, (_, i) => i);
  const eob = symbols.length + 1;
  let [runLen, runWeight, groupLeft, sel] = [0, 1, 0, 0];
  let table: Huffman | undefined;
  for (;;) {
    if (groupLeft === 0) {
      table = tables[selectors[sel++] ?? tables.length];
      if (table === undefined) fail('ran out of Huffman selectors');
      groupLeft = GROUP_SIZE;
    }
    groupLeft -= 1;
    const sym = decodeSymbol(r, table as Huffman);
    if (sym <= 1) {
      runLen += (sym + 1) * runWeight;
      runWeight *= 2;
      if (runLen > maxBlock) fail('run is longer than the block');
      continue;
    }
    if (runLen > 0) {
      emitRun(out, symbols[mtf[0] ?? 0] ?? 0, runLen);
      [runLen, runWeight] = [0, 1];
    }
    if (sym === eob) return out;
    const idx = sym - 1;
    const value = mtf[idx] ?? 0;
    mtf.copyWithin(1, 0, idx);
    mtf[0] = value;
    emitRun(out, symbols[value] ?? 0, 1);
  }
}

function crcUpdate(crc: number, byte: number): number {
  return ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
}

/** Inverse BWT + RLE1 undo, writing to sink. Returns the block CRC of the bytes written. */
function inverseBwt(block: MtfOutput, origPtr: number, sink: ByteSink): number {
  const { tt, n, counts } = block;
  if (origPtr >= n) fail('block origin pointer out of range');
  const cftab = new Uint32Array(256);
  for (let i = 0, sum = 0; i < 256; i++) {
    cftab[i] = sum;
    sum += counts[i] ?? 0;
  }
  for (let i = 0; i < n; i++) {
    const b = (tt[i] ?? 0) & 0xff;
    const at = cftab[b] ?? 0;
    tt[at] = (tt[at] ?? 0) | (i << 8);
    cftab[b] = at + 1;
  }
  // tt[origPtr] only seeds the chain: its own byte is not part of the output.
  let [pos, crc, last, run] = [(tt[origPtr] ?? 0) >>> 8, 0xffffffff, -1, 0];
  for (let k = 0; k < n; k++) {
    const entry = tt[pos] ?? 0;
    pos = entry >>> 8;
    const b = entry & 0xff;
    if (run === 4) {
      for (let j = 0; j < b; j++) {
        sink.push(last);
        crc = crcUpdate(crc, last);
      }
      run = 0;
      continue;
    }
    run = b === last ? run + 1 : 1;
    last = b;
    sink.push(b);
    crc = crcUpdate(crc, b);
  }
  return ~crc >>> 0;
}

function decodeBlock(r: BitReader, maxBlock: number, sink: ByteSink): number {
  if (r.bit() === 1) fail('randomised blocks (bzip2 < 0.9.5) are not supported');
  const origPtr = r.bits(24);
  const symbols = readSymbolMap(r);
  const nGroups = r.bits(3);
  if (nGroups < 2 || nGroups > 6) fail('invalid number of Huffman tables');
  const selectors = readSelectors(r, nGroups);
  const tables = Array.from({ length: nGroups }, () => buildHuffman(readCodeLengths(r, symbols.length + 2)));
  return inverseBwt(decodeMtf(r, tables, selectors, symbols, maxBlock), origPtr, sink);
}

function decodeStream(r: BitReader, sink: ByteSink): void {
  if (r.bits(24) !== 0x425a68) fail('missing "BZh" stream header');
  const level = r.bits(8) - 0x30;
  if (level < 1 || level > 9) fail('invalid block size');
  let combined = 0;
  for (;;) {
    const hi = r.bits(24);
    const lo = r.bits(24);
    const storedCrc = r.bits(32);
    if (hi === EOS_MAGIC[0] && lo === EOS_MAGIC[1]) {
      if (storedCrc !== combined) fail('stream CRC mismatch');
      return;
    }
    if (hi !== BLOCK_MAGIC[0] || lo !== BLOCK_MAGIC[1]) fail('bad block signature');
    const blockCrc = decodeBlock(r, level * 100_000, sink);
    if (blockCrc !== storedCrc) fail('block CRC mismatch (corrupt data)');
    combined = (((combined << 1) | (combined >>> 31)) ^ blockCrc) >>> 0;
  }
}

/** Decompresses bzip2 data (one or more concatenated streams). Throws on corrupt input or when output exceeds maxOutput. */
export function bunzip2(data: Uint8Array, maxOutput = Number.MAX_SAFE_INTEGER): Uint8Array {
  const r = new BitReader(data);
  const sink = new ByteSink(maxOutput);
  do {
    decodeStream(r, sink);
    r.alignToByte();
  } while (r.atStreamHeader());
  return sink.result();
}
