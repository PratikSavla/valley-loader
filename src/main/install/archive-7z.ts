// SPDX-License-Identifier: AGPL-3.0-only
// 7za (7zip-bin) process wrapper: list and extract zip/7z archives. Pure Node, spawn with argument arrays only.
import { spawn } from 'node:child_process';

export interface ListedEntry {
  path: string;
  isDir: boolean;
  isSymlink: boolean;
}

const MAX_OUTPUT_IN_ERROR = 2000;

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_OUTPUT_IN_ERROR ? `…${trimmed.slice(-MAX_OUTPUT_IN_ERROR)}` : trimmed;
}

/** Run 7za with an argument array; rejects with stderr/stdout context on spawn failure or non-zero exit. */
export function run7za(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (e) => {
      reject(new Error(`Could not start 7za (${bin}): ${e.message}`, { cause: e }));
    });
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(out).toString('utf8');
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const stderr = Buffer.concat(err).toString('utf8');
      const detail = tail(stderr) || tail(stdout) || 'no output';
      const how = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      reject(new Error(`7za ${args[0] ?? ''} failed (${how}): ${detail}`));
    });
  });
}

const UNIX_SYMLINK_MODE = /(?:^|\s)l[rwxsStT-]{9}(?:\s|$)/;

/** Parse `7za l -slt -ba` output (blank-line separated "Key = Value" blocks). */
export function parseSltListing(stdout: string): ListedEntry[] {
  const entries: ListedEntry[] = [];
  for (const block of stdout.split(/\r?\n\s*\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const at = line.indexOf(' = ');
      if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 3));
      else if (line.endsWith(' =')) fields.set(line.slice(0, -2).trim(), '');
    }
    const path = fields.get('Path');
    if (path === undefined) continue;
    const attributes = fields.get('Attributes') ?? '';
    entries.push({
      path,
      isDir: fields.get('Folder') === '+' || attributes.startsWith('D'),
      isSymlink: UNIX_SYMLINK_MODE.test(attributes),
    });
  }
  return entries;
}

/** List entries of a zip/7z archive. `type` is passed as -t so mis-named archives still open. */
export async function list7z(bin: string, type: 'zip' | '7z', archivePath: string): Promise<ListedEntry[]> {
  const stdout = await run7za(bin, ['l', '-slt', '-ba', `-t${type}`, '--', archivePath]);
  return parseSltListing(stdout);
}

/** Extract everything into outDir (which should be an empty staging dir). */
export async function extract7z(
  bin: string,
  type: 'zip' | '7z',
  archivePath: string,
  outDir: string,
): Promise<void> {
  await run7za(bin, ['x', '-y', '-bd', `-t${type}`, `-o${outDir}`, '--', archivePath]);
}
