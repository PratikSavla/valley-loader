// SPDX-License-Identifier: AGPL-3.0-only
// Concurrent HTTP downloader with md5/size verification and retries. Pure Node (injectable fetch).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DownloadJob {
  key: string;
  url: string;
  /** Final file name inside the queue's directory. */
  fileName: string;
  md5?: string;
  size?: number;
}

export interface DownloadQueueOptions {
  dir: string;
  concurrency: number;
  fetchImpl?: typeof fetch;
  retries?: number;
  onProgress?: (key: string, received: number, total: number) => void;
  /** First retry waits this long, doubling each attempt. Default 1000 ms. */
  retryBaseDelayMs?: number;
  /** Minimum gap between progress callbacks per job (the final callback is always sent). Default 200 ms. */
  progressIntervalMs?: number;
}

import { DownloadError } from './download-error';

export { DownloadError, type DownloadErrorCode } from './download-error';

/** URL without query string or fragment (Nexus CDN links carry signed tokens there). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.replace(/[?#].*$/, '');
  }
}

/** Strips query strings from any URLs embedded in free text (e.g. a lower-level error message). */
export function redactText(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#'"]*)[?#][^\s'"]*/gi, '$1');
}

/** Replaces path separators/NUL with "_". Throws DownloadError('invalid') for names that stay unusable. */
export function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[/\\\u0000]/g, '_').trim();
  if (clean === '' || clean === '.' || clean === '..') {
    throw new DownloadError(`Invalid download file name: ${JSON.stringify(name)}`, { code: 'invalid' });
  }
  return clean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** md5 hex of a file (streamed). */
export async function md5File(path: string): Promise<string> {
  const hash = createHash('md5');
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  } catch (err) {
    throw new Error(`Cannot compute md5 of ${path}: ${message(err)}`, { cause: err });
  }
  return hash.digest('hex');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`Cannot stat ${path}: ${message(err)}`, { cause: err });
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DownloadError('cancelled'));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DownloadError('cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Releases a response's connection; a failure here is irrelevant next to the error the caller throws next. */
async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

interface Task {
  job: DownloadJob;
  target: string;
  controller: AbortController;
  resolve: (path: string) => void;
  reject: (err: unknown) => void;
  promise: Promise<string>;
}

export class DownloadQueue {
  private readonly pending: Task[] = [];
  private readonly active = new Set<Task>();
  /** In-flight/queued tasks by target path, so the same file is never downloaded twice at once. */
  private readonly byTarget = new Map<string, Task>();
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly baseDelay: number;
  private readonly progressInterval: number;

  constructor(private readonly opts: DownloadQueueOptions) {
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
      throw new Error(`DownloadQueue concurrency must be a positive integer, got ${opts.concurrency}`);
    }
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.retries = opts.retries ?? 3;
    this.baseDelay = opts.retryBaseDelayMs ?? 1000;
    this.progressInterval = opts.progressIntervalMs ?? 200;
  }

  /** Resolves with the absolute path of the verified file. Downloads to "<name>.part" then renames. */
  enqueue(job: DownloadJob): Promise<string> {
    let target: string;
    try {
      target = join(this.opts.dir, sanitizeFileName(job.fileName));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(message(err)));
    }
    const existing = this.byTarget.get(target);
    if (existing) return existing.promise;
    let resolve!: (path: string) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const task: Task = { job, target, controller: new AbortController(), resolve, reject, promise };
    this.byTarget.set(target, task);
    this.pending.push(task);
    this.pump();
    return promise;
  }

  /** Abort in-flight and queued jobs (their promises reject with DownloadError('cancelled')). */
  cancelAll(): void {
    this.cancelWhere(() => true);
  }

  /** Abort only the in-flight and queued jobs whose key matches. */
  cancelWhere(pred: (key: string) => boolean): void {
    const cancelled = this.pending.filter((task) => pred(task.job.key));
    this.pending.splice(0, this.pending.length, ...this.pending.filter((task) => !pred(task.job.key)));
    for (const task of cancelled) {
      this.byTarget.delete(task.target);
      task.reject(new DownloadError('cancelled'));
    }
    for (const task of this.active) if (pred(task.job.key)) task.controller.abort();
  }

  get activeCount(): number {
    return this.active.size;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private pump(): void {
    while (this.active.size < this.opts.concurrency) {
      const task = this.pending.shift();
      if (!task) return;
      this.active.add(task);
      this.run(task)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active.delete(task);
          this.byTarget.delete(task.target);
          this.pump();
        });
    }
  }

  private async run(task: Task): Promise<string> {
    const { job, target, controller } = task;
    await mkdir(this.opts.dir, { recursive: true });
    if (job.md5 && (await exists(target)) && (await md5File(target)) === job.md5.toLowerCase()) {
      const { size } = await stat(target);
      this.opts.onProgress?.(job.key, size, size);
      return target;
    }
    for (let attempt = 0; ; attempt++) {
      if (controller.signal.aborted) throw new DownloadError('cancelled');
      try {
        await this.attempt(task);
        return target;
      } catch (err) {
        if (controller.signal.aborted) throw new DownloadError('cancelled');
        const dlErr = this.toDownloadError(err, job);
        if (!dlErr.retryable || attempt >= this.retries) throw dlErr;
        await abortableSleep(this.baseDelay * 2 ** attempt, controller.signal);
      }
    }
  }

  private toDownloadError(err: unknown, job: DownloadJob): DownloadError {
    if (err instanceof DownloadError) return err;
    return new DownloadError(
      `Download of ${job.key} from ${redactUrl(job.url)} failed: ${redactText(message(err))}`,
      { code: 'network' },
    );
  }

  /** One HTTP attempt → .part → verify → rename. Removes the .part file on any failure. */
  private async attempt(task: Task): Promise<void> {
    const { job, target, controller } = task;
    const part = `${target}.part`;
    try {
      const res = await this.fetchImpl(job.url, { signal: controller.signal, redirect: 'follow' });
      if (/^https:/i.test(job.url) && res.url !== '' && !/^https:/i.test(res.url)) {
        await discardBody(res);
        throw new DownloadError(`Download of ${job.key} was redirected away from https (${redactUrl(res.url)})`, { code: 'invalid' });
      }
      if (!res.ok || !res.body) {
        await discardBody(res);
        throw new DownloadError(
          `Download of ${job.key} from ${redactUrl(job.url)} failed: HTTP ${res.status} ${res.statusText}`.trim(),
          { code: 'http', status: res.status },
        );
      }
      const lengthHeader = Number(res.headers.get('content-length') ?? NaN);
      const total = job.size ?? (Number.isFinite(lengthHeader) ? lengthHeader : 0);
      const { received, md5 } = await this.streamToFile(job.key, res.body, part, total);
      this.verify(job, received, md5);
      await rename(part, target);
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
  }

  private async streamToFile(key: string, body: ReadableStream<Uint8Array>, part: string, total: number) {
    const hash = createHash('md5');
    const fh = await open(part, 'w');
    let received = 0;
    let lastEmit = 0;
    try {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await fh.write(value);
        received += value.byteLength;
        const now = Date.now();
        if (now - lastEmit >= this.progressInterval) {
          lastEmit = now;
          this.opts.onProgress?.(key, received, total);
        }
      }
    } finally {
      await fh.close();
    }
    this.opts.onProgress?.(key, received, total || received);
    return { received, md5: hash.digest('hex') };
  }

  private verify(job: DownloadJob, received: number, md5: string): void {
    if (job.size !== undefined && received !== job.size) {
      throw new DownloadError(`Download of ${job.key} has wrong size: expected ${job.size} bytes, got ${received}`, {
        code: 'size',
      });
    }
    if (job.md5 && md5 !== job.md5.toLowerCase()) {
      throw new DownloadError(`Download of ${job.key} failed md5 check: expected ${job.md5.toLowerCase()}, got ${md5}`, {
        code: 'md5',
      });
    }
  }
}
