// SPDX-License-Identifier: AGPL-3.0-only
// RAR extraction via node-unrar-js (WASM). Extracts in memory and writes files ourselves, so the
// archive can never create symlinks or write outside the target directory. Pure Node.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createExtractorFromData, type FileHeader } from 'node-unrar-js';
import { normalizeEntryPath } from './archive-safety';

async function loadExtractor(archivePath: string): Promise<Awaited<ReturnType<typeof createExtractorFromData>>> {
  const buf = await readFile(archivePath);
  const data = new Uint8Array(buf.byteLength);
  data.set(buf);
  return createExtractorFromData({ data: data.buffer });
}

function validateHeaders(headers: FileHeader[]): void {
  for (const header of headers) {
    normalizeEntryPath(header.name);
    if (header.flags.encrypted) {
      throw new Error(`RAR entry is password protected: ${header.name}`);
    }
  }
}

/**
 * Extract a RAR archive into outDir. Every entry name is validated before anything is written.
 * `only` holds lowercased normalized paths (see pathKey); undefined extracts everything.
 */
export async function extractRar(archivePath: string, outDir: string, only?: Set<string>): Promise<void> {
  const extractor = await loadExtractor(archivePath);
  const headers = [...extractor.getFileList().fileHeaders];
  validateHeaders(headers);
  const wanted = (h: FileHeader): boolean => {
    if (h.flags.directory) return false;
    return !only || only.has(normalizeEntryPath(h.name).toLowerCase());
  };
  const files = [...extractor.extract({ files: wanted }).files];
  for (const file of files) {
    const rel = normalizeEntryPath(file.fileHeader.name);
    if (rel === '' || file.fileHeader.flags.directory) continue;
    if (!file.extraction) throw new Error(`RAR entry produced no data: ${file.fileHeader.name}`);
    const target = join(outDir, ...rel.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.extraction);
  }
}
