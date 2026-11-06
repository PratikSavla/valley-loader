// SPDX-License-Identifier: AGPL-3.0-only
import { chmod, copyFile, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  detectArchiveKind,
  ensureExecutable,
  extractArchive,
  kindFromHeader,
  normalizeEntryPath,
  sevenZipPath,
  toUnpackedPath,
  UnsupportedArchiveError,
} from '../src/main/install/archive';
import { parseSltListing } from '../src/main/install/archive-7z';
import {
  build7zaArchive,
  cleanupTempDirs,
  makeTempDir,
  writeRawRar,
  writeRawZip,
} from './helpers/archive-fixtures';

afterAll(cleanupTempDirs);

const MOD_TREE = {
  'Foo/manifest.json': '{"Name":"Foo"}',
  'Foo/assets/Tex.png': 'png-bytes',
  'Bar/readme.txt': 'bar',
};

async function listRecursive(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listRecursive(join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

describe('detectArchiveKind', () => {
  it('detects zip, 7z, rar and empty zip by magic bytes', async () => {
    const dir = await makeTempDir();
    const empty = join(dir, 'empty.zip');
    await writeRawZip(empty, []);
    const rar = join(dir, 'a.rar');
    await writeRawRar(rar, [{ name: 'a.txt', data: 'a' }]);
    expect(await detectArchiveKind(await build7zaArchive(MOD_TREE, 'zip'))).toBe('zip');
    expect(await detectArchiveKind(await build7zaArchive(MOD_TREE, '7z'))).toBe('7z');
    expect(await detectArchiveKind(rar)).toBe('rar');
    expect(await detectArchiveKind(empty)).toBe('zip');
  });

  it('ignores the extension: a zip named .7z is a zip, text is unknown', async () => {
    const misnamed = await build7zaArchive(MOD_TREE, 'zip', 'actually-zip.7z');
    expect(await detectArchiveKind(misnamed)).toBe('zip');
    const txt = join(await makeTempDir(), 'notes.zip');
    await writeFile(txt, 'hello world');
    expect(await detectArchiveKind(txt)).toBe('unknown');
    expect(kindFromHeader(new Uint8Array([0x50, 0x4b]))).toBe('unknown');
  });

  it('rejects with context when the file is missing', async () => {
    await expect(detectArchiveKind('/nonexistent/x.zip')).rejects.toThrow(/Cannot open archive/);
  });
});

describe('sevenZipPath / ensureExecutable', () => {
  it('points at an existing 7za binary', async () => {
    const p = sevenZipPath();
    expect(p).toMatch(/7za$/);
    expect((await stat(p)).isFile()).toBe(true);
  });

  it('rewrites app.asar to app.asar.unpacked only once', () => {
    const packed = '/Applications/Valley Loader.app/Contents/Resources/app.asar/node_modules/7zip-bin/mac/arm64/7za';
    const unpacked = toUnpackedPath(packed);
    expect(unpacked).toBe(packed.replace('app.asar/', 'app.asar.unpacked/'));
    expect(toUnpackedPath(unpacked)).toBe(unpacked);
  });

  it('adds execute bits when missing', async () => {
    const copy = join(await makeTempDir(), '7za-copy');
    await copyFile(sevenZipPath(), copy);
    await chmod(copy, 0o644);
    await ensureExecutable(copy);
    expect((await stat(copy)).mode & 0o777).toBe(0o755);
    await expect(ensureExecutable(join(copy, 'missing'))).rejects.toThrow(/not found/);
  });
});

describe('normalizeEntryPath', () => {
  it('normalizes Windows separators and drops "." segments', () => {
    expect(normalizeEntryPath('Foo\\Bar\\x.txt')).toBe('Foo/Bar/x.txt');
    expect(normalizeEntryPath('./Foo//x.txt')).toBe('Foo/x.txt');
  });

  it.each(['../evil.txt', 'a/../../evil', '..\\evil.txt', '/etc/passwd', 'C:\\Windows\\x', 'c:/x'])(
    'rejects %s',
    (name) => {
      expect(() => normalizeEntryPath(name)).toThrow(/Unsafe archive entry/);
    },
  );
});

describe('parseSltListing', () => {
  it('reads paths, folders and unix symlink attributes', () => {
    const out = 'Path = A\nFolder = +\nAttributes = D_ drwxr-xr-x\n\nPath = A/l\nFolder = -\nAttributes = _ lrwxr-xr-x\n\nPath = A/f\nAttributes = A_ -rw-r--r--\n';
    expect(parseSltListing(out)).toEqual([
      { path: 'A', isDir: true, isSymlink: false },
      { path: 'A/l', isDir: false, isSymlink: true },
      { path: 'A/f', isDir: false, isSymlink: false },
    ]);
  });
});

describe('extractArchive', () => {
  it.each(['zip', '7z'] as const)('extracts a %s archive with file contents intact', async (type) => {
    const dest = join(await makeTempDir(), 'out');
    await extractArchive(await build7zaArchive(MOD_TREE, type), dest);
    expect(await listRecursive(dest)).toEqual(['Bar/readme.txt', 'Foo/assets/Tex.png', 'Foo/manifest.json']);
    expect(await readFile(join(dest, 'Foo/manifest.json'), 'utf8')).toBe('{"Name":"Foo"}');
  });

  it('extracts a zip that is misnamed .7z', async () => {
    const dest = await makeTempDir();
    await extractArchive(await build7zaArchive(MOD_TREE, 'zip', 'mod.7z'), dest);
    expect(await readFile(join(dest, 'Bar/readme.txt'), 'utf8')).toBe('bar');
  });

  it('onlyPaths keeps only the listed files (case-insensitive, either separator)', async () => {
    const dest = await makeTempDir();
    const archive = await build7zaArchive(MOD_TREE, '7z');
    await extractArchive(archive, dest, { onlyPaths: ['foo\\ASSETS\\tex.png', 'bar/README.TXT'] });
    expect(await listRecursive(dest)).toEqual(['Bar/readme.txt', 'Foo/assets/Tex.png']);
  });

  it.each(['../evil.txt', '..\\evil.txt', '/tmp/vl-abs-evil.txt', 'C:\\evil.txt'])(
    'rejects traversal entry %s and writes nothing',
    async (name) => {
      const root = await makeTempDir();
      const archive = join(root, 'bad.zip');
      await writeRawZip(archive, [{ name: 'ok.txt', data: 'ok' }, { name, data: 'pwned' }]);
      const dest = join(root, 'dest');
      await expect(extractArchive(archive, dest)).rejects.toThrow(/Unsafe archive entry/);
      expect(await readdir(dest)).toEqual([]);
      expect((await readdir(root)).sort()).toEqual(['bad.zip', 'dest']);
    },
  );

  it('rejects an archive containing a symlink (7za-built and hand-written)', async () => {
    const root = await makeTempDir();
    const linked = await build7zaArchive({ 'Mod/a.txt': 'a', 'Mod/link': { symlinkTo: '/etc/hosts' } }, 'zip');
    await expect(extractArchive(linked, join(root, 'd1'))).rejects.toThrow(/symlink/);
    expect(await readdir(join(root, 'd1'))).toEqual([]);
    const raw = join(root, 'raw.zip');
    await writeRawZip(raw, [{ name: 'Mod/escape', data: '../../..', symlink: true }]);
    await expect(extractArchive(raw, join(root, 'd2'))).rejects.toThrow(/symlink/);
    expect(await readdir(join(root, 'd2'))).toEqual([]);
  });

  it('turns backslash entry names into real folders', async () => {
    const root = await makeTempDir();
    const archive = join(root, 'win.zip');
    await writeRawZip(archive, [{ name: 'Mod\\sub\\file.txt', data: 'w' }]);
    await extractArchive(archive, join(root, 'out'));
    expect(await readFile(join(root, 'out/Mod/sub/file.txt'), 'utf8')).toBe('w');
  });

  it('wraps 7za failures with its error output', async () => {
    const root = await makeTempDir();
    const corrupt = join(root, 'corrupt.zip');
    await writeFile(corrupt, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64, 0xff)]));
    await expect(extractArchive(corrupt, join(root, 'out'))).rejects.toThrow(/7za l failed \(exit code \d+\): .+/);
  });

  it('rejects unknown formats', async () => {
    const root = await makeTempDir();
    const file = join(root, 'mod.rar');
    await writeFile(file, 'not an archive');
    await expect(extractArchive(file, join(root, 'out'))).rejects.toThrow(/not a zip or 7z file/);
  });
});

describe('extractArchive (rar)', () => {
  it('refuses RAR archives with UnsupportedArchiveError and writes nothing', async () => {
    const root = await makeTempDir();
    const archive = join(root, 'mod.rar');
    await writeRawRar(archive, [{ name: 'Mod/manifest.json', data: '{}' }]);
    const err = await extractArchive(archive, join(root, 'out')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedArchiveError);
    expect((err as UnsupportedArchiveError).kind).toBe('rar');
    expect((err as UnsupportedArchiveError).archivePath).toBe(archive);
    expect((err as Error).message).toMatch(/mod\.rar is a RAR archive.*only opens \.zip and \.7z/);
    expect((await readdir(root)).sort()).toEqual(['mod.rar']);
  });

  it('detects RAR by content even when the file is named .zip', async () => {
    const root = await makeTempDir();
    const archive = join(root, 'disguised.zip');
    await writeRawRar(archive, [{ name: 'a.txt', data: 'a' }]);
    await expect(extractArchive(archive, join(root, 'out'))).rejects.toBeInstanceOf(UnsupportedArchiveError);
  });
});
