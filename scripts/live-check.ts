// SPDX-License-Identifier: AGPL-3.0-only
// Live end-to-end check against the real Nexus API (needs NEXUS_API_KEY in .env):
//   npm run live-check   (= node --env-file=.env --experimental-strip-types scripts/live-check.ts)
// Validates the key (prints name + Premium only — never the key), resolves tckf0m, downloads and extracts
// its archive into tests/fixtures/live/, parses collection.json and prints a summary of the install plan.
//
// Why the loader hooks below: Node's type stripping can't run src/ directly — the modules use extensionless
// relative imports, the '@shared/*' path alias at runtime, and TS parameter properties (which strip-only
// mode rejects). So this script registers tiny in-process resolve/load hooks (node:module registerHooks)
// that map '@shared/*' to src/shared, add the '.ts' extension, and transpile src/**/*.ts with the
// TypeScript compiler already in devDependencies. No tsx/vite-node needed.
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { PlannedMod } from '../src/shared/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const OUT_DIR = join(ROOT, 'tests', 'fixtures', 'live');
const SLUG = 'tckf0m';

function tsFileFor(base: string): string | undefined {
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (candidate.endsWith('.ts') && existsSync(candidate)) return candidate;
  }
  return undefined;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    let base: string | undefined;
    if (specifier.startsWith('@shared/')) base = join(SRC, 'shared', specifier.slice('@shared/'.length));
    else if (specifier.startsWith('.') && parent?.startsWith('file:') && fileURLToPath(parent).startsWith(SRC)) {
      base = resolve(dirname(fileURLToPath(parent)), specifier);
    }
    const file = base === undefined ? undefined : tsFileFor(base);
    if (file !== undefined) return { url: pathToFileURL(file).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts') && fileURLToPath(url).startsWith(SRC)) {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      const out = ts.transpileModule(source, {
        fileName: fileURLToPath(url),
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: true,
          useDefineForClassFields: true,
        },
      });
      return { format: 'module', source: out.outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

type Api = typeof import('../src/main/nexus/api.ts');
type Queue = typeof import('../src/main/download/queue.ts');
type Archive = typeof import('../src/main/install/archive.ts');
type Schema = typeof import('../src/main/collection/schema.ts');
type Plan = typeof import('../src/main/collection/plan.ts');

/** Imports a src/ module through the hooks above (a runtime path keeps tsc from checking the .ts suffix). */
async function load<T>(rel: string): Promise<T> {
  return (await import(pathToFileURL(join(SRC, rel)).href)) as T;
}

function step(text: string): void {
  console.log(`\n== ${text}`);
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function printPlan(mods: PlannedMod[], smapi: string | undefined): void {
  const bySource = new Map<string, number>();
  for (const m of mods) bySource.set(m.sourceType, (bySource.get(m.sourceType) ?? 0) + 1);
  console.log(`Planned mods: ${mods.length} (${mods.filter((m) => m.optional).length} optional)`);
  console.log(`By source: ${[...bySource].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log('First 10 in deploy order:');
  for (const m of mods.slice(0, 10)) {
    const id = m.modId !== undefined ? ` mod ${m.modId}/file ${m.fileId}` : '';
    console.log(`  ${String(m.order).padStart(3)}  phase ${m.phase}  ${m.name} ${m.version} [${m.sourceType}${id}]`);
  }
  console.log(`SMAPI requirement: ${smapi ?? '(collection does not list SMAPI)'}`);
}

async function main(): Promise<void> {
  const apiKey = process.env['NEXUS_API_KEY']?.trim();
  if (!apiKey || apiKey.startsWith('your-')) throw new Error('Set NEXUS_API_KEY in .env (see .env.example)');
  const { NexusClient } = await load<Api>('main/nexus/api.ts');
  const { DownloadQueue } = await load<Queue>('main/download/queue.ts');
  const { extractArchive } = await load<Archive>('main/install/archive.ts');
  const { parseCollectionJson } = await load<Schema>('main/collection/schema.ts');
  const { buildPlan, smapiRequirement } = await load<Plan>('main/collection/plan.ts');
  const client = new NexusClient({ apiKey });

  step('Validate API key');
  const user = await client.validate();
  console.log(`Signed in as ${user.name} (${user.isPremium ? 'Premium' : 'Free'})`);

  step(`Resolve collection ${SLUG}`);
  const summary = await client.getCollection(SLUG);
  console.log(`${summary.name} by ${summary.author} — revision ${summary.revision}, ${summary.modCount} mods, ${mb(summary.totalSize)}`);
  const modFiles = await client.getRevisionModFiles(SLUG, summary.revision);
  console.log(`GraphQL lists ${modFiles.files.length} mod files for this revision (${modFiles.missingFileIds.length} no longer on Nexus)`);

  step('Download collection archive');
  const url = await client.getCollectionArchiveUrl(summary.downloadLinkPath);
  await mkdir(OUT_DIR, { recursive: true });
  let lastPct = -1;
  const queue = new DownloadQueue({
    dir: OUT_DIR,
    concurrency: 1,
    onProgress: (_k, received, total) => {
      const pct = total > 0 ? Math.floor((received / total) * 10) * 10 : -1;
      if (pct !== lastPct) console.log(`  ${mb(received)}${total > 0 ? ` / ${mb(total)}` : ''}`);
      lastPct = pct;
    },
  });
  const archive = await queue.enqueue({ key: SLUG, url, fileName: `${SLUG}-r${summary.revision}.7z` });
  console.log(`Saved ${archive}`);

  step('Extract + parse collection.json');
  const dir = join(OUT_DIR, `${SLUG}-r${summary.revision}`);
  await rm(dir, { recursive: true, force: true });
  await extractArchive(archive, dir);
  const json = parseCollectionJson(await readFile(join(dir, 'collection.json'), 'utf8'));
  console.log(`collection.json: "${json.info.name}", ${json.mods.length} mods, ${json.modRules.length} rules`);

  step('Install plan');
  printPlan(buildPlan(json), smapiRequirement(json));
  const withChoices = json.mods.filter((m) => m.choices !== undefined && m.choices !== null).length;
  const withPatches = json.mods.filter((m) => m.patches !== undefined && Object.keys(m.patches).length > 0).length;
  const withHashes = json.mods.filter((m) => (m.hashes?.length ?? 0) > 0).length;
  console.log(`Mods with FOMOD choices: ${withChoices}, with patches: ${withPatches}, with file hashes: ${withHashes}`);
  console.log(`Rate limit left: daily ${client.rateLimit.daily ?? '?'}, hourly ${client.rateLimit.hourly ?? '?'}`);
}

process.on('unhandledRejection', (reason) => {
  console.error('live-check: unhandled rejection', reason);
  process.exit(1);
});

main().catch((err: unknown) => {
  console.error(`\nlive-check FAILED: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.cause !== undefined) console.error('cause:', err.cause);
  process.exit(1);
});
