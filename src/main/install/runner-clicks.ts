// SPDX-License-Identifier: AGPL-3.0-only
// Free-account click flow: a cursor walks 'needsClick' mods in plan order, showing each file page in the
// Nexus window; nxm links (from that window or the OS) and captured browser downloads are matched back to mods.
import { join } from 'node:path';
import { GAME_DOMAIN, type PlannedMod } from '@shared/types';
import { md5File } from '../download/queue';
import { parseNxm, validateModLink, type NxmLink, type NxmModLink } from '../nexus/nxm';
import { checkArchive, downloadAndInstall, installInBackground, nexusSpec } from './runner-sources';
import { byOrder, errorMessage, hold, noteRateLimit, type RunnerCtx } from './runner-context';
import { CAPTURED_DIR_NAME, type CapturedDownload, type ModFileUrlArgs } from './runner-types';

/**
 * Shows the next mod waiting for a click. When this profile has none left, the cursor is cleared and handed
 * to another running profile that still has mods waiting (see handOffCursor).
 */
export async function advanceCursor(ctx: RunnerCtx, slug: string): Promise<void> {
  const { store } = ctx;
  const current = store.transient.awaitingClick;
  if (current !== undefined && current.slug !== slug && store.getProfile(current.slug)?.running === true) return;
  const profile = store.getProfile(slug);
  const waiting = (profile?.mods ?? []).filter((m) => m.selected && m.status === 'needsClick').sort(byOrder);
  const next = waiting[0];
  if (profile === undefined || !profile.running || next === undefined) {
    if (current?.slug === slug || current === undefined) {
      store.setTransient({ awaitingClick: undefined });
      await handOffCursor(ctx, slug);
    }
    return;
  }
  if (ctx.clicks.slug !== slug) ctx.clicks = { slug, total: waiting.length, done: 0 };
  ctx.clicks.total = Math.max(ctx.clicks.total, ctx.clicks.done + waiting.length);
  const index = ctx.clicks.done + 1;
  store.setTransient({ awaitingClick: { slug, key: next.key, index, total: ctx.clicks.total } });
  try {
    await showInWindow(ctx, next, index, ctx.clicks.total);
  } catch (err) {
    console.error(`[runner] could not open the Nexus page for ${next.key}`, err);
    store.setTransient({ lastError: `Could not open the Nexus page for ${next.name}: ${errorMessage(err)}` });
  }
}

/** When no profile holds the cursor, gives it to a running profile (other than `except`) with mods waiting for a click. */
export async function handOffCursor(ctx: RunnerCtx, except?: string): Promise<void> {
  for (const p of ctx.store.profiles) {
    if (ctx.store.transient.awaitingClick !== undefined) return;
    if (p.slug === except || !p.running || !p.mods.some((m) => m.selected && m.status === 'needsClick')) continue;
    await advanceCursor(ctx, p.slug);
  }
}

export async function showInWindow(ctx: RunnerCtx, mod: PlannedMod, index: number, total: number): Promise<void> {
  const win = ctx.deps.nexusWindow;
  if (mod.sourceType === 'browse') {
    if (mod.url === undefined) throw new Error('The collection entry has no page URL');
    await win.open(mod.url, `Valley Loader — Mod ${index}/${total}: download ${mod.name} from this page`);
    return;
  }
  if (mod.modId === undefined || mod.fileId === undefined) throw new Error('The collection entry has no Nexus mod/file id');
  await win.showMod({ modId: mod.modId, fileId: mod.fileId, name: mod.name, index, total });
}

const CLICKABLE = new Set(['needsClick', 'pending', 'failed']);

/** Search order: the profile the cursor is on, the active one, then the rest. */
function searchOrder(ctx: RunnerCtx): string[] {
  const first = [ctx.store.transient.awaitingClick?.slug, ctx.store.activeSlug].filter((s): s is string => s !== undefined);
  return [...new Set([...first, ...ctx.store.profiles.map((p) => p.slug)])];
}

function findTarget(ctx: RunnerCtx, pred: (m: PlannedMod) => boolean): { slug: string; mod: PlannedMod } | undefined {
  for (const slug of searchOrder(ctx)) {
    const mod = ctx.store.getProfile(slug)?.mods.find((m) => m.selected && pred(m));
    if (mod) return { slug, mod };
  }
  return undefined;
}

function reportUnmatched(ctx: RunnerCtx, link: NxmModLink): void {
  const same = findTarget(ctx, (m) => m.sourceType === 'nexus' && m.modId === link.modId && m.fileId === link.fileId);
  if (same !== undefined) {
    // The right file, clicked again while it is already on its way (or done): nothing is wrong.
    const state = same.mod.status === 'installed' ? 'already installed' : 'already downloading';
    console.info(`[runner] extra click for ${same.mod.key} ignored: ${state}`);
    ctx.store.setTransient({ lastError: `${same.mod.name} is ${state}, so the extra click was ignored.` });
    return;
  }
  const sibling = findTarget(
    ctx,
    (m) => m.sourceType === 'nexus' && m.modId === link.modId && m.fileId !== link.fileId && CLICKABLE.has(m.status),
  );
  const message =
    sibling !== undefined
      ? `That's a different file of ${sibling.mod.name}; the collection needs ${sibling.mod.logicalFilename ?? `file ${sibling.mod.fileId}`} — pick that file's Slow download`
      : `Ignored a download link for mod ${link.modId} (file ${link.fileId}): it isn't waiting in any of your collections.`;
  console.warn(`[runner] ${message}`);
  ctx.store.setTransient({ lastError: message });
}

/** Handles a mod nxm link. Collection links are returned for the caller to resolve. */
export async function handleNxm(ctx: RunnerCtx, url: string): Promise<NxmLink | undefined> {
  let link: NxmLink;
  try {
    link = parseNxm(url);
  } catch (err) {
    ctx.store.setTransient({ lastError: `Ignored a link Valley Loader couldn't read: ${errorMessage(err)}` });
    return undefined;
  }
  if (link.kind === 'collection') return link;
  const now = ctx.deps.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  const check = validateModLink(link, { expectedUserId: ctx.store.transient.user?.userId, nowSeconds: now });
  if (!check.ok) {
    ctx.store.setTransient({ lastError: check.reason });
    return undefined;
  }
  const modLink = link;
  const target = findTarget(
    ctx,
    (m) => m.sourceType === 'nexus' && m.modId === modLink.modId && m.fileId === modLink.fileId && CLICKABLE.has(m.status),
  );
  if (target === undefined) {
    reportUnmatched(ctx, modLink);
    return undefined;
  }
  await resolveClicked(ctx, target.slug, target.mod, modLink);
  return undefined;
}

async function fetchClickedUrl(ctx: RunnerCtx, link: NxmModLink): Promise<string> {
  // Download keys expire quickly: ask for the CDN URL right away.
  const args: ModFileUrlArgs = { domain: GAME_DOMAIN, modId: link.modId, fileId: link.fileId };
  if (link.key !== undefined) args.key = link.key;
  if (link.expires !== undefined) args.expires = link.expires;
  const url = await ctx.deps.client().getModFileDownloadUrl(args);
  noteRateLimit(ctx);
  return url;
}

async function resolveClicked(ctx: RunnerCtx, slug: string, mod: PlannedMod, link: NxmModLink): Promise<void> {
  const release = hold(ctx, slug, mod.key);
  try {
    ctx.store.updateMod(slug, mod.key, { status: 'resolving', error: undefined });
    let cdnUrl: string;
    try {
      cdnUrl = await fetchClickedUrl(ctx, link);
    } catch (err) {
      const message = `Nexus didn't hand out the download for ${mod.name}: ${errorMessage(err)} — click Slow download again`;
      console.error(`[runner] ${slug} / ${mod.key}: ${message}`, err);
      if (ctx.store.getMod(slug, mod.key) !== undefined) ctx.store.updateMod(slug, mod.key, { status: 'needsClick', error: message });
      ctx.store.setTransient({ lastError: message });
      return;
    }
    // Paused (or deselected) while Nexus answered: don't start a download nobody is waiting for.
    const now = ctx.store.getMod(slug, mod.key);
    if (ctx.store.getProfile(slug)?.running !== true || (now?.status !== 'resolving' && now?.status !== 'needsClick')) {
      if (now?.status === 'resolving') ctx.store.updateMod(slug, mod.key, { status: 'needsClick' });
      return;
    }
    if (ctx.clicks.slug === slug) ctx.clicks.done += 1;
    ctx.track(downloadAndInstall(ctx, slug, mod.key, nexusSpec(mod, cdnUrl)), `download ${mod.key}`);
    await advanceCursor(ctx, slug);
  } finally {
    release();
  }
}

function sameSite(a: string | undefined, b: string | undefined): boolean {
  try {
    return a !== undefined && b !== undefined && new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The awaited browse mod, if this window download is acceptable for it: the file must match the collection's
 * md5/size, or (when the collection lists neither) come from the page the collection pointed at.
 */
async function browseTarget(ctx: RunnerCtx, download: CapturedDownload, md5: string): Promise<{ slug: string; mod: PlannedMod } | 'rejected' | undefined> {
  const awaiting = ctx.store.transient.awaitingClick;
  const mod = awaiting && ctx.store.getMod(awaiting.slug, awaiting.key);
  if (!awaiting || mod?.sourceType !== 'browse') return undefined;
  const check = await checkArchive(mod, download.path, md5);
  const fromPage = sameSite(download.pageUrl, mod.url) || sameSite(download.url, mod.url);
  if (check === 'match' || (check === 'unknown' && fromPage)) return { slug: awaiting.slug, mod };
  const why = check === 'mismatch' ? 'checksum mismatch' : "it didn't come from the mod's download page";
  console.warn(`[runner] rejected window download ${download.fileName} for ${mod.key}: ${why}`);
  ctx.store.setTransient({
    lastError: `Downloaded ${download.fileName}, but it isn't the file the collection expects for ${mod.name} (${why}). It was saved in ${join(ctx.paths.downloadsDir, CAPTURED_DIR_NAME)}.`,
  });
  return 'rejected';
}

/** A file downloaded in the Nexus window (browse mods, or a "Manual download" click). */
export async function handleCapturedDownload(ctx: RunnerCtx, download: CapturedDownload): Promise<void> {
  if (!download.ok) {
    ctx.store.setTransient({ lastError: download.error ?? `Download of ${download.fileName} did not finish` });
    return;
  }
  const md5 = await md5File(download.path);
  const waiting = new Set(['needsClick', 'pending', 'failed', 'manual']);
  const byMd5 = findTarget(ctx, (m) => m.md5 !== undefined && m.md5.toLowerCase() === md5 && waiting.has(m.status));
  const target = byMd5 ?? (await browseTarget(ctx, download, md5));
  if (target === 'rejected') return;
  if (target === undefined) {
    ctx.store.setTransient({
      lastError: `Downloaded ${download.fileName}, but it doesn't match a mod waiting in your collections. It was saved in ${join(ctx.paths.downloadsDir, CAPTURED_DIR_NAME)}.`,
    });
    return;
  }
  const { slug, mod } = target;
  if (ctx.clicks.slug === slug && mod.status === 'needsClick') ctx.clicks.done += 1;
  installInBackground(ctx, slug, mod.key, download.path, `install ${mod.key}`);
  await advanceCursor(ctx, slug);
}
