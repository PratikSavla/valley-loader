// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DownloadError, DownloadQueue, md5File, redactUrl, sanitizeFileName } from '../src/main/download/queue';

const BODY = Buffer.from('stardew-archive-bytes-'.repeat(500));
const MD5 = createHash('md5').update(BODY).digest('hex');

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base: string;
let dir: string;
let hits: Record<string, number>;
let active = 0;
let maxActive = 0;
const routes = new Map<string, Handler>();

function sendBody(res: ServerResponse, body: Buffer = BODY): void {
  res.writeHead(200, { 'content-length': String(body.length) });
  res.end(body);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vl-queue-'));
  hits = {};
  active = 0;
  maxActive = 0;
  routes.clear();
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    hits[path] = (hits[path] ?? 0) + 1;
    const handler = routes.get(path);
    if (!handler) {
      res.writeHead(404).end('nope');
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const makeQueue = (extra: Partial<ConstructorParameters<typeof DownloadQueue>[0]> = {}): DownloadQueue =>
  new DownloadQueue({ dir, concurrency: 2, retryBaseDelayMs: 5, ...extra });

describe('DownloadQueue', () => {
  it('downloads, verifies md5 + size, renames and reports progress', async () => {
    routes.set('/ok', (_req, res) => sendBody(res));
    const progress: [number, number][] = [];
    const queue = makeQueue({ onProgress: (_k, r, t) => progress.push([r, t]) });
    const path = await queue.enqueue({ key: 'm1', url: `${base}/ok?key=secret`, fileName: 'mod.zip', md5: MD5.toUpperCase(), size: BODY.length });
    expect(path).toBe(join(dir, 'mod.zip'));
    expect((await readFile(path)).equals(BODY)).toBe(true);
    expect(await md5File(path)).toBe(MD5);
    expect(await readdir(dir)).toEqual(['mod.zip']);
    expect(progress.at(-1)).toEqual([BODY.length, BODY.length]);
  });

  it('rejects an md5 mismatch with expected vs actual and leaves no file behind', async () => {
    routes.set('/ok', (_req, res) => sendBody(res));
    const wrong = 'a'.repeat(32);
    const err = await makeQueue()
      .enqueue({ key: 'm2', url: `${base}/ok?key=s3cret&expires=1`, fileName: 'mod.zip', md5: wrong })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as DownloadError).message).toContain(wrong);
    expect((err as DownloadError).message).toContain(MD5);
    expect((err as DownloadError).code).toBe('md5');
    expect(hits['/ok']).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects a size mismatch', async () => {
    routes.set('/ok', (_req, res) => sendBody(res));
    const err = await makeQueue()
      .enqueue({ key: 'm3', url: `${base}/ok`, fileName: 'mod.zip', size: BODY.length + 1 })
      .catch((e: unknown) => e);
    expect((err as DownloadError).code).toBe('size');
    expect((err as Error).message).toMatch(new RegExp(`expected ${BODY.length + 1} bytes, got ${BODY.length}`));
    expect(await readdir(dir)).toEqual([]);
  });

  it('retries a 500 and then succeeds', async () => {
    let calls = 0;
    routes.set('/flaky', (_req, res) => {
      calls++;
      if (calls < 3) res.writeHead(500).end('boom');
      else sendBody(res);
    });
    const path = await makeQueue().enqueue({ key: 'm4', url: `${base}/flaky`, fileName: 'f.zip', md5: MD5 });
    expect(calls).toBe(3);
    expect(await md5File(path)).toBe(MD5);
  });

  it('gives up after the configured retries on persistent 503', async () => {
    routes.set('/down', (_req, res) => res.writeHead(503).end());
    const err = await makeQueue({ retries: 2 })
      .enqueue({ key: 'm5', url: `${base}/down`, fileName: 'd.zip' })
      .catch((e: unknown) => e);
    expect((err as DownloadError).status).toBe(503);
    expect(hits['/down']).toBe(3);
  });

  it('fails a 404 without retrying and never leaks the query string', async () => {
    const err = await makeQueue()
      .enqueue({ key: 'm6', url: `${base}/missing?key=TOPSECRET&expires=99`, fileName: 'x.zip' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as DownloadError).status).toBe(404);
    expect((err as Error).message).toContain('/missing');
    expect((err as Error).message).not.toContain('TOPSECRET');
    expect(hits['/missing']).toBe(1);
  });

  it('never runs more downloads at once than the concurrency limit', async () => {
    routes.set('/slow', (_req, res) => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active--;
        sendBody(res);
      }, 30);
    });
    const queue = makeQueue({ concurrency: 2 });
    const jobs = Array.from({ length: 6 }, (_, i) =>
      queue.enqueue({ key: `k${i}`, url: `${base}/slow`, fileName: `f${i}.zip`, md5: MD5 }),
    );
    expect(queue.activeCount).toBeLessThanOrEqual(2);
    const paths = await Promise.all(jobs);
    expect(paths).toHaveLength(6);
    expect(hits['/slow']).toBe(6);
    expect(maxActive).toBe(2);
    expect(queue.activeCount).toBe(0);
  });

  it('cache hit: an existing file with matching md5 resolves without any request', async () => {
    await writeFile(join(dir, 'cached.zip'), BODY);
    const progress: number[] = [];
    const queue = makeQueue({ onProgress: (_k, r) => progress.push(r) });
    const path = await queue.enqueue({ key: 'c', url: `${base}/ok`, fileName: 'cached.zip', md5: MD5 });
    expect(path).toBe(join(dir, 'cached.zip'));
    expect(Object.keys(hits)).toHaveLength(0);
    expect(progress).toEqual([BODY.length]);
  });

  it('re-downloads an existing file whose md5 does not match', async () => {
    routes.set('/ok', (_req, res) => sendBody(res));
    await writeFile(join(dir, 'stale.zip'), 'corrupt');
    const path = await makeQueue().enqueue({ key: 's', url: `${base}/ok`, fileName: 'stale.zip', md5: MD5 });
    expect(hits['/ok']).toBe(1);
    expect(await md5File(path)).toBe(MD5);
  });

  it('cancelAll rejects in-flight and queued jobs with DownloadError("cancelled") and leaves no .part', async () => {
    routes.set('/hang', (_req, res) => {
      res.writeHead(200, { 'content-length': '1000000' });
      res.write(Buffer.alloc(10));
    });
    const queue = makeQueue({ concurrency: 1 });
    const jobs = [0, 1, 2].map((i) =>
      queue.enqueue({ key: `h${i}`, url: `${base}/hang`, fileName: `h${i}.zip` }).catch((e: unknown) => e),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(queue.activeCount).toBe(1);
    queue.cancelAll();
    const errors = await Promise.all(jobs);
    for (const err of errors) {
      expect(err).toBeInstanceOf(DownloadError);
      expect((err as DownloadError).message).toBe('cancelled');
    }
    expect(hits['/hang']).toBe(1);
    expect(queue.activeCount).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it('cancelWhere aborts only the matching jobs; the others still finish', async () => {
    routes.set('/hang', (_req, res) => {
      res.writeHead(200, { 'content-length': '1000000' });
      res.write(Buffer.alloc(10));
    });
    routes.set('/ok', (_req, res) => sendBody(res));
    const queue = makeQueue({ concurrency: 1 });
    const paused = queue.enqueue({ key: 'a\nmod1', url: `${base}/hang`, fileName: 'a1.zip' }).catch((e: unknown) => e);
    const queuedPaused = queue.enqueue({ key: 'a\nmod2', url: `${base}/hang`, fileName: 'a2.zip' }).catch((e: unknown) => e);
    const other = queue.enqueue({ key: 'b\nmod1', url: `${base}/ok`, fileName: 'b1.zip', md5: MD5 });
    await new Promise((r) => setTimeout(r, 100));
    queue.cancelWhere((key) => key.startsWith('a\n'));
    for (const err of await Promise.all([paused, queuedPaused])) expect((err as DownloadError).code).toBe('cancelled');
    expect(await md5File(await other)).toBe(MD5);
  });

  it('refuses an https download that is redirected to plain http', async () => {
    const fetchImpl = (async () => {
      const res = new Response('x', { status: 200 });
      Object.defineProperty(res, 'url', { value: 'http://mirror.example/file.zip' });
      return res;
    }) as typeof fetch;
    const queue = new DownloadQueue({ dir, concurrency: 1, fetchImpl, retryBaseDelayMs: 0 });
    const err = await queue.enqueue({ key: 'r', url: 'https://cdn.example/file.zip', fileName: 'r.zip' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as DownloadError).code).toBe('invalid');
    expect(await readdir(dir)).toEqual([]);
  });

  it('shares one download between duplicate enqueues of the same file', async () => {
    routes.set('/ok', (_req, res) => sendBody(res));
    const queue = makeQueue();
    const [a, b] = await Promise.all([
      queue.enqueue({ key: 'd1', url: `${base}/ok`, fileName: 'same.zip' }),
      queue.enqueue({ key: 'd2', url: `${base}/ok`, fileName: 'same.zip' }),
    ]);
    expect(a).toBe(b);
    expect(hits['/ok']).toBe(1);
  });
});

describe('helpers', () => {
  it('sanitizeFileName strips path separators and rejects empty/dot names', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeFileName('a\\b.zip')).toBe('a_b.zip');
    expect(() => sanitizeFileName('..')).toThrow(DownloadError);
    expect(() => sanitizeFileName('  ')).toThrow(DownloadError);
  });

  it('redactUrl drops query and fragment', () => {
    expect(redactUrl('https://cf.nexus.com/a/b.zip?md5=x&expires=1#frag')).toBe('https://cf.nexus.com/a/b.zip');
  });
});
