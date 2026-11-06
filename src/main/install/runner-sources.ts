// SPDX-License-Identifier: AGPL-3.0-only
// Per-source install paths: bundle, nexus (Premium API / cached / needs a click), direct, browse, manual.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { GAME_DOMAIN, SMAPI_MOD_ID, type PlannedMod } from '@shared/types';
import { DownloadError, md5File, type DownloadJob } from '../download/queue';
import { mapLimit } from './profile-fs';
import { refreshGame } from './runner-game';
import { installArchive, smapiOutcome } from './runner-install';
import {
  cacheFileName,
  collectionDir,
  directFileName,
  errorMessage,
  failMod,
  hold,
  isInside,
  isPremium,
  jobKey,
  noteRateLimit,
  resumeStatus,
  type RunnerCtx,
} from './runner-context';

export interface DownloadSpec {
  url: string;
  fileName: string;
  md5?: string;
  size?: number;
}

/** After an install: move the click cursor off the mod if it still shows it, then see whether the run is done. */
export async function afterInstall(ctx: RunnerCtx, slug: string, key: string): Promise<void> {
  const awaiting = ctx.store.transient.awaitingClick;
  if (awaiting?.slug === slug && awaiting.key === key) await ctx.advanceCursor(slug);
  ctx.checkDone(slug);
}

/** Installs an archive that is already on disk, in the background (cached or captured downloads). */
export function installInBackground(ctx: RunnerCtx, slug: string, key: string, path: string, what: string): void {
  const release = hold(ctx, slug, key);
  ctx.store.updateMod(slug, key, { status: 'queued', error: undefined });
  ctx.track(
    installArchive(ctx, slug, key, path)
      .then(() => afterInstall(ctx, slug, key))
      .finally(release),
    what,
  );
}

/** Downloads through the shared queue; undefined when the download was cancelled or failed (the mod is updated). */
async function fetchArchive(ctx: RunnerCtx, slug: string, key: string, spec: DownloadSpec): Promise<string | undefined> {
  const job = jobKey(slug, key);
  ctx.jobs.set(job, { slug, key });
  try {
    const request: DownloadJob = { key: job, url: spec.url, fileName: spec.fileName };
    if (spec.md5 !== undefined) request.md5 = spec.md5;
    if (spec.size !== undefined && spec.size > 0) request.size = spec.size;
    return await ctx.queue().enqueue(request);
  } catch (err) {
    if (err instanceof DownloadError && err.code === 'cancelled') onCancelled(ctx, slug, key);
    else failMod(ctx, slug, key, `Download failed: ${errorMessage(err)}`, err);
    return undefined;
  } finally {
    ctx.jobs.delete(job);
  }
}

/** Queue a download, then install it. Never throws (failures mark the mod failed). */
export async function downloadAndInstall(ctx: RunnerCtx, slug: string, key: string, spec: DownloadSpec): Promise<void> {
  const release = hold(ctx, slug, key);
  try {
    ctx.store.updateMod(slug, key, { status: 'queued', error: undefined });
    const path = await fetchArchive(ctx, slug, key, spec);
    if (path === undefined) return;
    await installArchive(ctx, slug, key, path);
    await afterInstall(ctx, slug, key);
  } finally {
    release();
  }
}

function onCancelled(ctx: RunnerCtx, slug: string, key: string): void {
  const mod = ctx.store.getMod(slug, key);
  if (mod === undefined) return;
  ctx.store.updateMod(slug, key, { status: resumeStatus(mod, isPremium(ctx)), progress: undefined });
  // Only this profile's pause cancels its downloads; keep the mod going if the profile is still running.
  if (ctx.store.getProfile(slug)?.running === true) {
    const fresh = ctx.store.requireMod(slug, key);
    if (fresh.status === 'pending') ctx.track(dispatchMod(ctx, slug, fresh), `restart ${key}`);
    else if (fresh.status === 'needsClick') ctx.track(ctx.advanceCursor(slug), `show ${key} again`);
  }
}

export type ArchiveCheck = 'match' | 'mismatch' | 'unknown';

/** Compares a file with the collection's md5 (or, without one, its size). 'unknown' when it lists neither. */
export async function checkArchive(mod: Pick<PlannedMod, 'md5' | 'fileSize'>, path: string, knownMd5?: string): Promise<ArchiveCheck> {
  if (mod.md5 !== undefined && mod.md5 !== '') {
    return (knownMd5 ?? (await md5File(path))) === mod.md5.toLowerCase() ? 'match' : 'mismatch';
  }
  if (mod.fileSize !== undefined) return (await stat(path)).size === mod.fileSize ? 'match' : 'mismatch';
  return 'unknown';
}

/** Path of a cached archive whose md5 (or, without md5, size) matches the mod; undefined otherwise. */
export async function findCached(ctx: RunnerCtx, mod: PlannedMod): Promise<string | undefined> {
  if (mod.sourceType !== 'nexus' || mod.modId === undefined || mod.fileId === undefined) return undefined;
  const path = join(ctx.paths.downloadsDir, cacheFileName(mod));
  try {
    await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Could not check cached download ${path}: ${errorMessage(err)}`, { cause: err });
  }
  return (await checkArchive(mod, path)) === 'match' ? path : undefined;
}

async function startPremium(ctx: RunnerCtx, slug: string, mod: PlannedMod): Promise<void> {
  const { modId, fileId } = mod;
  if (modId === undefined || fileId === undefined) throw new Error('The collection entry has no Nexus mod/file id');
  ctx.store.updateMod(slug, mod.key, { status: 'resolving', error: undefined });
  const url = await ctx.deps.client().getModFileDownloadUrl({ domain: GAME_DOMAIN, modId, fileId });
  noteRateLimit(ctx);
  if (ctx.store.getProfile(slug)?.running !== true) {
    if (ctx.store.getMod(slug, mod.key)?.status === 'resolving') ctx.store.updateMod(slug, mod.key, { status: 'pending' });
    return;
  }
  await downloadAndInstall(ctx, slug, mod.key, nexusSpec(mod, url));
}

/** Download spec carrying the collection's md5 and size, so the queue verifies what arrives. */
export function specFor(mod: Pick<PlannedMod, 'md5' | 'fileSize'>, url: string, fileName: string): DownloadSpec {
  const spec: DownloadSpec = { url, fileName };
  if (mod.md5 !== undefined && mod.md5 !== '') spec.md5 = mod.md5;
  if (mod.fileSize !== undefined) spec.size = mod.fileSize;
  return spec;
}

export function nexusSpec(mod: PlannedMod, url: string): DownloadSpec {
  return specFor(mod, url, cacheFileName(mod));
}

/** Background work for one mod that is ready to go (bundle, Premium nexus, direct). */
export async function dispatchMod(ctx: RunnerCtx, slug: string, mod: PlannedMod): Promise<void> {
  const release = hold(ctx, slug, mod.key);
  try {
    if (mod.sourceType === 'bundle') {
      const profile = ctx.store.requireProfile(slug);
      const rel = mod.fileExpression ?? mod.logicalFilename;
      if (rel === undefined) throw new Error('The collection entry has no bundled file name');
      const bundled = join(collectionDir(profile), 'bundled');
      const path = join(bundled, rel);
      if (!isInside(bundled, path)) throw new Error(`Unsafe bundled file name: ${JSON.stringify(rel)}`);
      await installArchive(ctx, slug, mod.key, path);
    } else if (mod.sourceType === 'nexus') {
      await startPremium(ctx, slug, mod);
    } else if (mod.sourceType === 'direct') {
      // Plain http could be swapped in transit, and the archive runs code inside SMAPI: https only.
      if (mod.url === undefined || !/^https:\/\//i.test(mod.url)) throw new Error('The collection entry has no https download URL');
      await downloadAndInstall(ctx, slug, mod.key, specFor(mod, mod.url, directFileName(mod.url)));
    }
  } catch (err) {
    failMod(ctx, slug, mod.key, errorMessage(err), err);
  } finally {
    release();
  }
  ctx.checkDone(slug);
}

type Plan = { mod: PlannedMod; cached?: string; click: boolean };

async function classify(ctx: RunnerCtx, mod: PlannedMod): Promise<Plan> {
  if (mod.modId === SMAPI_MOD_ID) return { mod, click: false };
  if (mod.sourceType === 'browse') return { mod, click: true };
  if (mod.sourceType !== 'nexus') return { mod, click: false };
  const cached = await findCached(ctx, mod);
  if (cached !== undefined) return { mod, cached, click: false };
  return { mod, click: !isPremium(ctx) };
}

/**
 * Starts work for the given mods: cached archives install directly, mods that need a website click
 * become 'needsClick', the rest download in the background. Returns how many need a click.
 */
export async function startMods(ctx: RunnerCtx, slug: string, mods: PlannedMod[]): Promise<number> {
  // SMAPI's row mirrors the installed version: compare against a fresh detection, not the startup one.
  if (mods.some((m) => m.sourceType === 'nexus' && m.modId === SMAPI_MOD_ID)) {
    await refreshGame(ctx).catch((err: unknown) => console.error(`[runner] ${slug}: could not re-detect the game for the SMAPI check`, err));
  }
  const plans = await mapLimit(mods, 4, (mod) => classify(ctx, mod));
  let clicks = 0;
  for (const plan of plans) {
    const { mod } = plan;
    if (mod.sourceType === 'manual') {
      ctx.store.updateMod(slug, mod.key, { status: 'manual' });
    } else if (mod.sourceType === 'nexus' && mod.modId === SMAPI_MOD_ID) {
      // No point downloading the SMAPI installer (or asking for a click): just check the installed version.
      smapiOutcome(ctx, slug, mod.key);
    } else if (plan.cached !== undefined) {
      installInBackground(ctx, slug, mod.key, plan.cached, `install cached ${mod.key}`);
    } else if (plan.click) {
      clicks += 1;
      ctx.store.updateMod(slug, mod.key, { status: 'needsClick', error: undefined });
    } else {
      ctx.store.updateMod(slug, mod.key, { status: 'pending', error: undefined });
      ctx.track(dispatchMod(ctx, slug, ctx.store.requireMod(slug, mod.key)), `start ${mod.key}`);
    }
  }
  return clicks;
}
