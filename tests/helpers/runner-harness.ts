// SPDX-License-Identifier: AGPL-3.0-only
// Test harness for the install runner: a real Store + Profile on a temp dir, real 7z/zip archives,
// and fakes for the Nexus API, the Nexus window, fetch, Steam and SMAPI.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import type { CollectionSummary, GameInfo, NexusUser } from '@shared/types';
import type { RateLimit } from '../../src/main/nexus/api';
import { Runner } from '../../src/main/install/runner';
import type { CapturedDownload, ModFileUrlArgs, NexusWindowLike, ShowModArgs } from '../../src/main/install/runner-types';
import { Store } from '../../src/main/state/store';
import { build7zaArchive, makeTempDir, type TreeSpec } from './archive-fixtures';
import { naivePatch } from './bsdiff-fixtures';

export const CDN = 'https://cdn.test';
export const NOW = 1_000_000;
export const USER: NexusUser = { userId: 7, name: 'farmer', isPremium: false, isSupporter: false };

export class FakeClient {
  hasApiKey = true;
  rateLimit: RateLimit = {};
  readonly calls: ModFileUrlArgs[] = [];
  /** What validate() does; defaults to returning USER. */
  validateImpl: () => Promise<NexusUser> = async () => USER;
  validateCalls = 0;
  /** While set, getModFileDownloadUrl waits for it (to test what happens while a link is resolving). */
  gate: Promise<void> | undefined;
  constructor(public summary: CollectionSummary) {}
  async validate(): Promise<NexusUser> {
    this.validateCalls += 1;
    return this.validateImpl();
  }
  async getCollection(): Promise<CollectionSummary> {
    return this.summary;
  }
  async getCollectionArchiveUrl(): Promise<string> {
    return `${CDN}/collection.7z?token=secret`;
  }
  async getModFileDownloadUrl(args: ModFileUrlArgs): Promise<string> {
    this.calls.push(args);
    if (this.gate !== undefined) await this.gate;
    return `${CDN}/${args.modId}-${args.fileId}.zip?token=secret`;
  }
}

export class FakeWindow implements NexusWindowLike {
  readonly shown: ShowModArgs[] = [];
  readonly opened: string[] = [];
  closed = 0;
  loggedIn: boolean | undefined = undefined;
  readonly downloadListeners: ((d: CapturedDownload) => void)[] = [];
  /** Simulates a download finishing in the Nexus window. */
  emitDownload(d: CapturedDownload): void {
    for (const cb of this.downloadListeners) cb(d);
  }
  async open(url: string): Promise<void> {
    this.opened.push(url);
  }
  async showMod(args: ShowModArgs): Promise<void> {
    this.shown.push(args);
  }
  async openLogin(): Promise<void> {
    this.opened.push('login');
  }
  async isLoggedIn(): Promise<boolean | undefined> {
    return this.loggedIn;
  }
  onNxm(): () => void {
    return () => undefined;
  }
  onDownload(cb: (d: CapturedDownload) => void): () => void {
    this.downloadListeners.push(cb);
    return () => undefined;
  }
  focus(): void {}
  close(): void {
    this.closed += 1;
  }
}

const manifest = (name: string): string => JSON.stringify({ Name: name, UniqueID: `test.${name}`, Version: '1.0.0' });

export interface Fixtures {
  files: Map<string, Buffer>;
  md5: Record<'alpha' | 'beta' | 'gamma', string>;
  summary: CollectionSummary;
}

async function addArchive(files: Map<string, Buffer>, path: string, tree: TreeSpec, type: 'zip' | '7z'): Promise<Buffer> {
  const buf = await readFile(await build7zaArchive(tree, type));
  files.set(`${CDN}/${path}`, buf);
  return buf;
}

const hash = (buf: Buffer): string => createHash('md5').update(buf).digest('hex');

/** CRC32 (zlib) as Vortex writes it into mods[].patches. */
const crcHex = (text: string): string => (crc32(Buffer.from(text)) >>> 0).toString(16).toUpperCase().padStart(8, '0');

/**
 * Optional curator edits: Marker gets a binary patch keyed with an extra "Marker Pack" wrapper, Alpha a patch whose
 * CRC does not match (must be skipped with a warning), and Gamma a file list that keeps only its manifest.
 */
function addCuratorEdits(mods: Record<string, unknown>[], collectionTree: TreeSpec): void {
  const at = (i: number): Record<string, unknown> => {
    const mod = mods[i];
    if (mod === undefined) throw new Error(`fixture has no mod #${i}`);
    return mod;
  };
  const [marker, alpha, gamma] = [at(2), at(3), at(4)];
  marker.patches = { 'Marker Pack\\[CP] Marker\\content.json': crcHex('{}') };
  alpha.patches = { 'Alpha\\config.json': 'DEADBEEF' };
  gamma.hashes = [{ path: 'Gamma\\manifest.json', md5: createHash('md5').update(manifest('Gamma')).digest('hex') }];
  collectionTree['patches/Marker/Marker Pack/[CP] Marker/content.json.diff'] = naivePatch(Buffer.from('{}'), Buffer.from('{"Changes":[]}'));
  collectionTree['patches/Alpha/Alpha/config.json.diff'] = naivePatch(Buffer.from('x'), Buffer.from('y'));
}

/** SMAPI, a config mod (Beta, listed first but ordered after Alpha), a bundled folder, Alpha, optional Gamma. */
export async function buildFixtures(opts: { curatorEdits?: boolean } = {}): Promise<Fixtures> {
  const files = new Map<string, Buffer>();
  const alpha = await addArchive(files, '101-1001.zip', { 'Alpha/manifest.json': manifest('Alpha'), 'Alpha/config.json': 'alpha-default' }, 'zip');
  const beta = await addArchive(files, '102-2002.zip', { 'Alpha/config.json': 'beta-config', 'Gamma/config.json': 'beta-config' }, 'zip');
  const gamma = await addArchive(files, '103-3003.zip', { 'Gamma/manifest.json': manifest('Gamma'), 'Gamma/gamma.txt': 'g' }, 'zip');
  const md5 = { alpha: hash(alpha), beta: hash(beta), gamma: hash(gamma) };
  const nexus = (modId: number, fileId: number, buf: Buffer, logicalFilename: string): Record<string, unknown> => ({
    type: 'nexus', modId, fileId, md5: hash(buf), fileSize: buf.length, logicalFilename,
  });
  const collection = {
    info: { name: 'Test Collection', author: 'curator', domainName: 'stardewvalley', installInstructions: 'Have fun' },
    mods: [
      { name: 'SMAPI', version: '4.5.2', source: { type: 'nexus', modId: 2400, fileId: 1 } },
      { name: 'Beta Config', version: '1.0.0', source: nexus(102, 2002, beta, 'Beta') },
      { name: 'Marker', version: '1.0.0', source: { type: 'bundle', fileExpression: 'Bundled Marker' } },
      { name: 'Alpha', version: '1.0.0', source: nexus(101, 1001, alpha, 'Alpha-1.0.0') },
      { name: 'Gamma', version: '1.0.0', optional: true, source: nexus(103, 3003, gamma, 'Gamma') },
    ],
    modRules: [{ type: 'after', source: { fileMD5: md5.beta }, reference: { fileMD5: md5.alpha } }],
  };
  const collectionTree: TreeSpec = {
    'bundled/Bundled Marker/[CP] Marker/manifest.json': manifest('Marker'),
    'bundled/Bundled Marker/[CP] Marker/content.json': '{}',
  };
  if (opts.curatorEdits === true) addCuratorEdits(collection.mods, collectionTree);
  collectionTree['collection.json'] = JSON.stringify(collection);
  await addArchive(files, 'collection.7z', collectionTree, '7z');
  const summary: CollectionSummary = {
    slug: 'testcol', revision: 3, name: 'Test Collection', author: 'curator', totalSize: 5000, modCount: 5,
    adultContent: false, downloadLinkPath: '/v2/collections/1/revisions/3/download_link',
  };
  return { files, md5, summary };
}

export function fakeFetch(files: Map<string, Buffer>): { fetchImpl: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    const buf = files.get(url.split('?')[0] ?? url);
    if (buf === undefined) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(buf), { status: 200, headers: { 'content-length': String(buf.length) } });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

export interface Harness {
  runner: Runner;
  store: Store;
  userData: string;
  client: FakeClient;
  win: FakeWindow;
  requests: string[];
  launches: { gamePath: string; modsDir: string }[];
  steam: { running: boolean; opened: number };
}

export const GAME: GameInfo = {
  gamePath: '/fake/steamapps/common/Stardew Valley/Contents/MacOS',
  gameVersion: '1.6.15',
  smapiInstalled: true,
  smapiVersion: '4.5.1',
};

const harnesses: Harness[] = [];

/** Lets background work and debounced state writes finish before temp dirs are removed. */
export async function settleHarnesses(): Promise<void> {
  for (const h of harnesses.splice(0)) {
    await h.runner.idle();
    h.runner.dispose();
    await h.store.flush();
  }
}

export async function makeHarness(fx: Fixtures, opts: { premium?: boolean; userData?: string } = {}): Promise<Harness> {
  const userData = opts.userData ?? (await makeTempDir('vl-runner-'));
  const store = await Store.open(userData, { saveDelayMs: 5, emitIntervalMs: 0 });
  store.setTransient({ hasApiKey: true, user: { ...USER, isPremium: opts.premium === true }, game: GAME });
  const client = new FakeClient(fx.summary);
  const win = new FakeWindow();
  const { fetchImpl, requests } = fakeFetch(fx.files);
  const launches: Harness['launches'] = [];
  const steam = { running: false, opened: 0 };
  const runner = new Runner({
    store, userDataDir: userData, client: () => client, nexusWindow: win, fetchImpl, home: userData,
    pickArchive: async () => undefined,
    showItemInFolder: () => undefined,
    openSteam: async () => {
      steam.opened += 1;
    },
    isSteamRunning: async () => steam.running,
    launchSmapi: async (o) => {
      launches.push(o);
    },
    detectGame: async () => store.transient.game,
    macosVersion: async () => '26.1',
    isNxmHandlerRegistered: () => false,
    nowSeconds: () => NOW,
    retryBaseDelayMs: 0,
  });
  const harness: Harness = { runner, store, userData, client, win, requests, launches, steam };
  harnesses.push(harness);
  return harness;
}

/** A gate for FakeClient.gate plus the function that opens it. */
export function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((res) => {
    open = res;
  });
  return { promise, open };
}

export function modLink(modId: number, fileId: number, extra: { expires?: number; userId?: number } = {}): string {
  return `nxm://stardewvalley/mods/${modId}/files/${fileId}?key=k${fileId}&expires=${extra.expires ?? NOW + 3600}&user_id=${extra.userId ?? USER.userId}`;
}
