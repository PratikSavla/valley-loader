// SPDX-License-Identifier: AGPL-3.0-only
// Test helpers: build fixture archives at test time in os.tmpdir() (7za for normal archives,
// tiny hand-written zip/rar writers for malicious entries 7za would refuse to create).
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { run7za } from '../../src/main/install/archive-7z';
import { ensureSevenZip } from '../../src/main/install/archive';

const created: string[] = [];

export async function makeTempDir(prefix = 'vl-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

export type TreeSpec = Record<string, string | Buffer | { symlinkTo: string }>;

/** Write files ("/"-separated relative paths) under root. */
export async function writeTree(root: string, tree: TreeSpec): Promise<void> {
  for (const [rel, value] of Object.entries(tree)) {
    const target = join(root, ...rel.split('/'));
    await mkdir(dirname(target), { recursive: true });
    if (typeof value === 'object' && !Buffer.isBuffer(value)) await symlink(value.symlinkTo, target);
    else await writeFile(target, value);
  }
}

/** Build a real zip/7z with the bundled 7za from a tree. Symlinks are stored as links (-snl). */
export async function build7zaArchive(tree: TreeSpec, type: 'zip' | '7z', fileName?: string): Promise<string> {
  const src = await makeTempDir('vl-src-');
  await writeTree(src, tree);
  const out = join(await makeTempDir('vl-arc-'), fileName ?? `fixture.${type}`);
  const bin = await ensureSevenZip();
  const tops = [...new Set(Object.keys(tree).map((k) => k.split('/')[0] ?? k))];
  await run7za(bin, ['a', `-t${type}`, '-snl', '-bd', out, ...tops.map((t) => join(src, t))]);
  return out;
}

export interface RawEntry {
  name: string;
  data?: string;
  symlink?: boolean;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

/** Hand-written stored (uncompressed) zip: lets tests use names like "../evil.txt" or "C:\\x". */
export async function writeRawZip(outPath: string, entries: RawEntry[]): Promise<void> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '', 'utf8');
    const crc = crc32(data);
    const common = [u16(20), u16(0x0800), u16(0), u16(0), u16(DOS_DATE), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0)];
    const local = Buffer.concat([u32(0x04034b50), ...common, name, data]);
    const mode = entry.symlink ? 0o120777 : 0o100644;
    const central = Buffer.concat([
      u32(0x02014b50), u16((3 << 8) | 20), ...common, u16(0), u16(0), u16(0), u32(mode * 0x10000), u32(offset), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0),
  ]);
  await writeFile(outPath, Buffer.concat([...locals, cd, eocd]));
}

function rarBlock(body: Buffer): Buffer {
  // body starts at HEAD_TYPE; HEAD_CRC is the low 16 bits of CRC32 over it.
  return Buffer.concat([u16(crc32(body) & 0xffff), body]);
}

/** Hand-written RAR 4.x archive with stored entries (no rar binary needed). hostOs 2 = Windows, 3 = Unix. */
export async function writeRawRar(outPath: string, entries: RawEntry[], hostOs = 3): Promise<void> {
  const parts: Buffer[] = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])];
  parts.push(rarBlock(Buffer.concat([Buffer.from([0x73]), u16(0), u16(13), u16(0), u32(0)])));
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '', 'utf8');
    const attr = hostOs === 3 ? 0o100644 : 0x20;
    const body = Buffer.concat([
      Buffer.from([0x74]), u16(0x8000), u16(32 + name.length), u32(data.length), u32(data.length),
      Buffer.from([hostOs]), u32(crc32(data)), u32(DOS_DATE * 0x10000), Buffer.from([20, 0x30]),
      u16(name.length), u32(attr), name,
    ]);
    parts.push(rarBlock(body), data);
  }
  parts.push(rarBlock(Buffer.concat([Buffer.from([0x7b]), u16(0x4000), u16(7)])));
  await writeFile(outPath, Buffer.concat(parts));
}
