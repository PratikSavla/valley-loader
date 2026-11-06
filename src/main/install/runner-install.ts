// SPDX-License-Identifier: AGPL-3.0-only
// Archive → extract → analyse → stage → deploy, serialised through the runner mutex.
import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { compareVersions } from '../game/detect';
import { md5File } from '../download/queue';
import { UnsupportedArchiveError, extractArchive } from './archive';
import { Profile } from './profile';
import { SMAPI_BUNDLED_KEY } from './smapi-bundled';
import { analyzeExtracted, type InstallAnalysis } from './stardew';
import { applyCuratorEdits, mergeEditWarnings } from './runner-extras';
import { byOrder, errorMessage, failMod, type RunnerCtx } from './runner-context';

export const ROOT_MOD_WARNING = 'This mod replaces game files (Content/); not supported yet — install it by hand if you need it.';
export const LOOSE_FILES_WARNING = 'Archive has no SMAPI mod folder; its files were placed loose in Mods/ and may not take effect.';

/**
 * Deploys every staged, selected, installed mod (plus `include`) in plan order, after SMAPI's own bundled mods
 * when those are staged (so collection files win). Call inside the mutex.
 */
export async function redeploy(ctx: RunnerCtx, slug: string, include?: string): Promise<void> {
  const profile = ctx.store.requireProfile(slug);
  const keys = [...profile.mods]
    .sort(byOrder)
    .filter((m) => m.selected && (m.key === include || (m.status === 'installed' && m.installedFolders !== undefined)))
    .map((m) => m.key);
  const target = new Profile(profile.profileDir);
  const bundled = (await target.isStaged(SMAPI_BUNDLED_KEY)) ? [SMAPI_BUNDLED_KEY] : [];
  const result = await target.deploy([...bundled, ...keys]);
  if (result.overrides.length > 0) {
    console.info(`[runner] ${slug}: ${result.overrides.length} file(s) overridden by later mods (load order)`);
  }
}

/** SMAPI itself is never installed into a profile: compare the installed version instead. */
export function smapiOutcome(ctx: RunnerCtx, slug: string, key: string): void {
  const mod = ctx.store.requireMod(slug, key);
  const installed = ctx.store.transient.game?.smapiVersion;
  const needs = mod.version.trim();
  if (installed !== undefined && (needs === '' || compareVersions(installed, needs) >= 0)) {
    ctx.store.updateMod(slug, key, { status: 'installed', error: undefined, progress: undefined });
    return;
  }
  const what = needs === '' ? 'the latest version' : needs;
  ctx.store.updateMod(slug, key, {
    status: 'manual',
    error: `Update SMAPI from smapi.io (needs ${what})`,
    progress: undefined,
  });
}

async function applyAnalysis(ctx: RunnerCtx, slug: string, key: string, analysis: InstallAnalysis, editWarnings: string[]): Promise<void> {
  const before = ctx.store.requireMod(slug, key).warnings;
  ctx.store.updateMod(slug, key, { warnings: mergeEditWarnings(before, editWarnings) });
  if (analysis.kind === 'smapi') {
    smapiOutcome(ctx, slug, key);
    return;
  }
  if (analysis.kind === 'root') {
    const mod = ctx.store.requireMod(slug, key);
    const warnings = mod.warnings.includes(ROOT_MOD_WARNING) ? mod.warnings : [...mod.warnings, ROOT_MOD_WARNING];
    ctx.store.updateMod(slug, key, { status: 'manual', warnings, error: 'Replaces game files; not supported yet', progress: undefined });
    return;
  }
  const profile = new Profile(ctx.store.requireProfile(slug).profileDir);
  const folders = await profile.stageMod(key, analysis);
  await redeploy(ctx, slug, key);
  const now = ctx.store.requireMod(slug, key).warnings.filter((w) => w !== LOOSE_FILES_WARNING);
  const warnings = analysis.kind === 'fallback' && folders.length === 0 ? [...now, LOOSE_FILES_WARNING] : now;
  ctx.store.updateMod(slug, key, { status: 'installed', installedFolders: folders, warnings, error: undefined, progress: undefined, needsRepack: undefined });
}

/**
 * Re-checks a downloaded archive against the collection's md5 right before it is unpacked, closing the gap
 * between the download check and the install (another writer could have replaced the file meanwhile).
 */
async function verifyBeforeExtract(ctx: RunnerCtx, slug: string, key: string, archivePath: string): Promise<void> {
  const mod = ctx.store.requireMod(slug, key);
  if ((mod.sourceType !== 'nexus' && mod.sourceType !== 'direct') || mod.md5 === undefined || mod.md5 === '') return;
  const actual = await md5File(archivePath);
  if (actual !== mod.md5.toLowerCase()) {
    throw new Error(`the downloaded file changed after it was checked (md5 ${actual}, expected ${mod.md5.toLowerCase()}); retry the mod`);
  }
}

/** Step-by-step help shown on a mod whose download is a RAR archive. */
export function repackInstructions(archivePath: string): string {
  return (
    `This mod is packed as a .rar file, which Valley Loader can't open. To install it: ` +
    `1. Open the downloaded file in Finder (${archivePath}); if macOS can't open it, use The Unarchiver from the App Store. ` +
    `2. Right-click the unpacked folder and choose Compress to make a .zip. ` +
    `3. Press "Pick file…" here and choose that .zip.`
  );
}

function markNeedsRepack(ctx: RunnerCtx, slug: string, key: string, err: UnsupportedArchiveError): void {
  console.warn(`[runner] ${slug} / ${key}: ${err.message}`);
  if (ctx.store.getMod(slug, key) === undefined) return;
  ctx.store.updateMod(slug, key, { status: 'manual', needsRepack: true, error: repackInstructions(err.archivePath), progress: undefined });
}

async function extractAndApply(ctx: RunnerCtx, slug: string, key: string, archivePath: string, userPicked: boolean): Promise<void> {
  await mkdir(ctx.paths.tmpDir, { recursive: true });
  const work = await mkdtemp(join(ctx.paths.tmpDir, 'install-'));
  try {
    const out = join(work, 'out');
    // Bundled mods arrive already unpacked (bundled/<fileExpression> is a folder): copy, since staging moves.
    if ((await stat(archivePath)).isDirectory()) {
      await cp(archivePath, out, { recursive: true, verbatimSymlinks: true });
    } else {
      // A file the user picked themselves (e.g. a re-zipped RAR) can't match the collection's md5.
      if (!userPicked) await verifyBeforeExtract(ctx, slug, key, archivePath);
      await extractArchive(archivePath, out);
    }
    // Curator edits (exact file list, binary patches) apply to the download as extracted, before the analyzer.
    const editWarnings = await applyCuratorEdits(ctx.store.requireProfile(slug), key, out);
    await applyAnalysis(ctx, slug, key, await analyzeExtracted(out), editWarnings);
  } finally {
    await rm(work, { recursive: true, force: true }).catch((err: unknown) => {
      console.error(`[runner] could not remove temp folder ${work}`, err);
    });
  }
}

/**
 * Installs one archive (or an already-unpacked folder, for bundled mods) for a mod. Never throws: failures mark the mod failed with a readable message.
 * Skips (status 'skipped') when the mod was deselected while it was downloading.
 */
export function installArchive(ctx: RunnerCtx, slug: string, key: string, archivePath: string, opts: { userPicked?: boolean } = {}): Promise<void> {
  return ctx.mutex.run(async () => {
    const mod = ctx.store.getMod(slug, key);
    if (mod === undefined) return;
    if (!mod.selected) {
      ctx.store.updateMod(slug, key, { status: 'skipped', progress: undefined });
      return;
    }
    ctx.store.updateMod(slug, key, { status: 'installing', error: undefined, progress: undefined });
    try {
      await extractAndApply(ctx, slug, key, archivePath, opts.userPicked === true);
    } catch (err) {
      if (err instanceof UnsupportedArchiveError) markNeedsRepack(ctx, slug, key, err);
      else failMod(ctx, slug, key, `Install failed: ${errorMessage(err)}`, err);
    }
  });
}

/** Removes a mod's staged files and redeploys without it. Call inside the mutex. */
export async function uninstallMod(ctx: RunnerCtx, slug: string, key: string): Promise<void> {
  const profile = new Profile(ctx.store.requireProfile(slug).profileDir);
  await profile.unstageMod(key);
  await redeploy(ctx, slug);
}
