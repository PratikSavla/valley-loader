// SPDX-License-Identifier: AGPL-3.0-only
// Collection link → summary → archive → collection.json → plan → ProfileState.
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CollectionSummary, ProfileState, ProfileUpdate, ResolveOptions } from '@shared/types';
import { buildPlan, smapiRequirement } from '../collection/plan';
import { parseCollectionJson, type CollectionJson } from '../collection/schema';
import { DownloadQueue } from '../download/queue';
import { parseCollectionInput } from '../nexus/nxm';
import { extractArchive } from './archive';
import { Profile } from './profile';
import { redeploy } from './runner-install';
import { collectionDir, errorMessage, noteRateLimit, type RunnerCtx } from './runner-context';

export const NEED_API_KEY = 'Add your Nexus API key first — Nexus only hands out collection files to apps signed in with your key (Setup → Enter API key).';
const SLUG_RE = /^[a-z0-9_-]{1,64}$/i;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`Could not check ${path}: ${errorMessage(err)}`, { cause: err });
  }
}

/** Downloads + extracts the collection archive once per revision; returns parsed collection.json. */
async function loadCollectionJson(ctx: RunnerCtx, summary: CollectionSummary, profileDir: string): Promise<CollectionJson> {
  const dir = collectionDir({ profileDir, revision: summary.revision });
  const jsonPath = join(dir, 'collection.json');
  if (!(await exists(jsonPath))) {
    const client = ctx.deps.client();
    const url = await client.getCollectionArchiveUrl(summary.downloadLinkPath);
    noteRateLimit(ctx);
    const opts: ConstructorParameters<typeof DownloadQueue>[0] = { dir: profileDir, concurrency: 1 };
    if (ctx.deps.fetchImpl) opts.fetchImpl = ctx.deps.fetchImpl;
    if (ctx.deps.retryBaseDelayMs !== undefined) opts.retryBaseDelayMs = ctx.deps.retryBaseDelayMs;
    const archive = await new DownloadQueue(opts).enqueue({
      key: `collection:${summary.slug}`,
      url,
      fileName: `collection-r${summary.revision}.7z`,
    });
    await rm(dir, { recursive: true, force: true });
    await extractArchive(archive, dir);
    if (!(await exists(jsonPath))) {
      throw new Error(`The collection archive for "${summary.name}" has no collection.json — it may be damaged; try again later.`);
    }
  }
  const text = await readFile(jsonPath, 'utf8');
  return parseCollectionJson(text);
}

function buildProfile(summary: CollectionSummary, json: CollectionJson, profileDir: string, previous?: ProfileState): ProfileState {
  const now = new Date().toISOString();
  const profile: ProfileState = {
    slug: summary.slug,
    revision: summary.revision,
    name: summary.name,
    author: summary.author,
    totalSize: summary.totalSize,
    profileDir,
    modsDir: new Profile(profileDir).modsDir,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    running: false,
    mods: buildPlan(json, previous?.mods),
  };
  if (summary.summary) profile.summary = summary.summary;
  if (summary.tileImageUrl) profile.tileImageUrl = summary.tileImageUrl;
  const instructions = json.info.installInstructions?.trim();
  if (instructions) profile.installInstructions = instructions;
  const smapi = smapiRequirement(json);
  if (smapi) profile.smapiRequirement = smapi;
  const update = carriedUpdate(previous?.update, summary.revision);
  if (update !== undefined) profile.update = update;
  return profile;
}

/**
 * A known newer revision survives a re-resolve (e.g. re-opening the link of the current revision); its diff only
 * when it was computed from the revision now being resolved. Same rule as UpdateService's error carry-over.
 */
function carriedUpdate(prev: ProfileUpdate | undefined, revision: number): ProfileUpdate | undefined {
  if (prev === undefined || prev.latestRevision <= revision) return undefined;
  const update: ProfileUpdate = { latestRevision: prev.latestRevision, checkedAt: prev.checkedAt };
  if (prev.diff !== undefined && prev.diff.fromRevision === revision) update.diff = prev.diff;
  if (prev.error !== undefined) update.error = prev.error;
  return update;
}

/** Removes mods a new revision dropped and the previous revision's archive + folder. */
async function cleanupPrevious(ctx: RunnerCtx, previous: ProfileState, next: ProfileState): Promise<void> {
  const keys = new Set(next.mods.map((m) => m.key));
  const dropped = previous.mods.filter((m) => !keys.has(m.key) && m.installedFolders !== undefined);
  if (dropped.length > 0) {
    await ctx.mutex.run(async () => {
      for (const mod of dropped) await new Profile(next.profileDir).unstageMod(mod.key);
      await redeploy(ctx, next.slug);
    });
  }
  if (previous.revision !== next.revision) {
    await rm(collectionDir(previous), { recursive: true, force: true });
    await rm(join(previous.profileDir, `collection-r${previous.revision}.7z`), { force: true });
  }
}

/**
 * Accepts a collection URL / slug / nxm collection link; creates or refreshes the profile and makes it active.
 * Moving an existing profile to an older revision (which uninstalls what that revision lacks) needs `allowDowngrade`.
 */
export async function resolveCollection(ctx: RunnerCtx, input: string, opts: ResolveOptions = {}): Promise<ProfileState> {
  const ref = parseCollectionInput(input);
  const client = ctx.deps.client();
  const summary = await client.getCollection(ref.slug, ref.revision);
  noteRateLimit(ctx);
  if (!SLUG_RE.test(summary.slug)) throw new Error(`Nexus returned an unexpected collection id "${summary.slug}"`);
  const previous = ctx.store.getProfile(summary.slug);
  if (previous?.running === true) {
    throw new Error(`"${previous.name}" is installing right now — pause it before refreshing the collection.`);
  }
  if (previous !== undefined && summary.revision < previous.revision && opts.allowDowngrade !== true) {
    throw new Error(
      `"${previous.name}" is on revision ${previous.revision}; going back to revision ${summary.revision} needs your confirmation.`,
    );
  }
  if (!client.hasApiKey) throw new Error(NEED_API_KEY);
  const profileDir = join(ctx.paths.profilesRoot, summary.slug.toLowerCase());
  await mkdir(profileDir, { recursive: true });
  const json = await loadCollectionJson(ctx, summary, profileDir);
  // The archive download took a while: re-read the profile and check again, with no await before the upsert.
  const current = ctx.store.getProfile(summary.slug);
  if (previous !== undefined && current === undefined) throw new Error(`"${previous.name}" was removed while it was being updated.`);
  if (current?.running === true) {
    throw new Error(`"${current.name}" started installing while it was being updated; pause it and try again.`);
  }
  const profile = buildProfile(summary, json, profileDir, current);
  ctx.store.upsertProfile(profile);
  ctx.store.setActive(profile.slug);
  await mkdir(profile.modsDir, { recursive: true });
  if (current !== undefined) await cleanupPrevious(ctx, current, profile);
  return ctx.store.requireProfile(profile.slug);
}
