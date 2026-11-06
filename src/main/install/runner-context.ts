// SPDX-License-Identifier: AGPL-3.0-only
// Shared state + small helpers for the runner modules (mutex, paths, mod status helpers). No Electron.
import { createHash } from 'node:crypto';
import { join, relative, isAbsolute, sep } from 'node:path';
import type { ModStatus, PlannedMod, ProfileState } from '@shared/types';
import { DownloadQueue } from '../download/queue';
import type { Store } from '../state/store';
import type { RunnerDeps } from './runner-types';

/** Serialises async work (deploy touches one Mods dir per profile; one lock keeps it simple). */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface ClickSession {
  slug?: string;
  total: number;
  done: number;
}

export interface RunnerPaths {
  profilesRoot: string;
  downloadsDir: string;
  tmpDir: string;
}

export interface RunnerCtx {
  deps: RunnerDeps;
  store: Store;
  paths: RunnerPaths;
  mutex: Mutex;
  clicks: ClickSession;
  /** The shared mod download queue (re-created when the concurrency setting changes while idle). */
  queue(): DownloadQueue;
  /** Maps queue job keys back to (slug, mod key). */
  jobs: Map<string, { slug: string; key: string }>;
  /** Job keys (jobKey(slug, key)) with background work in flight, counted (see hold()). */
  held: Map<string, number>;
  /** Runs work in the background; failures are logged and shown as lastError. */
  track(work: Promise<unknown>, what: string): void;
  advanceCursor(slug: string): Promise<void>;
  checkDone(slug: string): void;
}

export function runnerPaths(userDataDir: string): RunnerPaths {
  return {
    profilesRoot: join(userDataDir, 'profiles'),
    downloadsDir: join(userDataDir, 'downloads'),
    tmpDir: join(userDataDir, 'tmp'),
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when `child` is strictly inside `parent` (both absolute). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** Cache file name for a Nexus mod archive: "<modId>-<fileId>-<sanitised logicalFilename or name>". */
export function cacheFileName(mod: Pick<PlannedMod, 'modId' | 'fileId' | 'logicalFilename' | 'name'>): string {
  const label = (mod.logicalFilename ?? mod.name).replace(/[^A-Za-z0-9._ -]+/g, '_').trim().slice(0, 100) || 'mod';
  return `${mod.modId ?? 0}-${mod.fileId ?? 0}-${label}`;
}

/** Cache file name for a direct-URL download. */
export function directFileName(url: string): string {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 10);
  let base = 'download';
  try {
    base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || base;
  } catch (err) {
    console.warn(`[runner] could not read a file name from a direct URL: ${errorMessage(err)}`);
  }
  return `direct-${hash}-${base.replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 100)}`;
}

export function byOrder(a: PlannedMod, b: PlannedMod): number {
  return a.order - b.order;
}

export function isPremium(ctx: RunnerCtx): boolean {
  return ctx.store.transient.user?.isPremium === true;
}

/** Where a mod goes back to when its in-flight work is cancelled or restarted. */
export function resumeStatus(mod: PlannedMod, premium: boolean): ModStatus {
  if (mod.sourceType === 'manual') return 'manual';
  if (mod.sourceType === 'browse') return 'needsClick';
  if (mod.sourceType === 'nexus' && !premium) return 'needsClick';
  return 'pending';
}

/** Finished as far as an install run is concerned. */
export const SETTLED: ReadonlySet<ModStatus> = new Set<ModStatus>(['installed', 'manual', 'failed', 'skipped']);

export function collectionDir(profile: Pick<ProfileState, 'profileDir' | 'revision'>): string {
  return join(profile.profileDir, `collection-r${profile.revision}`);
}

export function failMod(ctx: RunnerCtx, slug: string, key: string, message: string, err?: unknown): void {
  console.error(`[runner] ${slug} / ${key}: ${message}`, err ?? '');
  if (ctx.store.getMod(slug, key) === undefined) return;
  ctx.store.updateMod(slug, key, { status: 'failed', error: message, progress: undefined });
}

export function noteRateLimit(ctx: RunnerCtx): void {
  const rl = ctx.deps.client().rateLimit;
  if (rl.daily !== undefined || rl.hourly !== undefined) ctx.store.setTransient({ rateLimit: { ...rl } });
}

export function jobKey(slug: string, key: string): string {
  return `${slug}\n${key}`;
}

/**
 * Marks a mod as having background work in flight (resolve, download, install) until the returned release
 * function is called, so a Resume or reselect does not start the same mod a second time.
 */
export function hold(ctx: Pick<RunnerCtx, 'held'>, slug: string, key: string): () => void {
  const k = jobKey(slug, key);
  ctx.held.set(k, (ctx.held.get(k) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (ctx.held.get(k) ?? 1) - 1;
    if (left <= 0) ctx.held.delete(k);
    else ctx.held.set(k, left);
  };
}

export function isHeld(ctx: Pick<RunnerCtx, 'held'>, slug: string, key: string): boolean {
  return ctx.held.has(jobKey(slug, key));
}
