// SPDX-License-Identifier: AGPL-3.0-only
// Game-facing runner actions: refresh game info, launch SMAPI on a profile, gather setup-check inputs.
import { mkdir, rm, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SMAPI_MOD_ID, type GameInfo, type PrereqCheck } from '@shared/types';
import { compareVersions } from '../game/detect';
import { NexusApiError } from '../nexus/api';
import { evaluatePrereqs, type PrereqInputs } from '../prereqs';
import { redeploy, smapiOutcome } from './runner-install';
import { errorMessage, isInside, noteRateLimit, type RunnerCtx } from './runner-context';
import { stageSmapiBundled } from './smapi-bundled';

export const STEAM_STARTING = 'Steam is starting — press Play again in a few seconds';
export const NEXUS_UNREACHABLE = "Couldn't reach Nexus Mods to check your account; check your connection and try again.";

/** Re-detects the game (configured path first), stores it in the snapshot and re-checks every SMAPI row. */
export async function refreshGame(ctx: RunnerCtx): Promise<GameInfo | undefined> {
  const game = await ctx.deps.detectGame(ctx.deps.home, ctx.store.settings.gamePath);
  ctx.store.setTransient({ game });
  // Only on a successful detection, so a failed one can't turn an 'installed' SMAPI row back into 'manual'.
  if (game !== undefined) recheckSmapi(ctx);
  return game;
}

/** SMAPI's row mirrors the installed SMAPI version: re-evaluate it whenever the game is re-detected. */
function recheckSmapi(ctx: RunnerCtx): void {
  for (const p of ctx.store.profiles) {
    for (const m of p.mods) {
      if (m.selected && m.sourceType === 'nexus' && m.modId === SMAPI_MOD_ID && (m.status === 'manual' || m.status === 'installed')) {
        smapiOutcome(ctx, p.slug, m.key);
      }
    }
  }
}

/**
 * Validates the saved key when no account is known yet (startup validation failed or hasn't finished).
 * A 401/403 is stored as apiKeyError; any other failure is logged and returned so callers can explain it.
 */
export async function ensureUser(ctx: RunnerCtx): Promise<string | undefined> {
  const client = ctx.deps.client();
  const t = ctx.store.transient;
  if (!client.hasApiKey || t.user !== undefined || t.apiKeyError !== undefined) return undefined;
  try {
    const user = await client.validate();
    ctx.store.setTransient({ user });
    noteRateLimit(ctx);
    return undefined;
  } catch (err) {
    console.error('[runner] could not validate the saved Nexus API key', err);
    if (err instanceof NexusApiError && (err.status === 401 || err.status === 403)) {
      ctx.store.setTransient({ apiKeyError: err.message });
      return undefined;
    }
    return errorMessage(err);
  }
}

/** Nexus downloads need a known account (Premium or not, and the user id nxm links are checked against). */
export async function requireAccount(ctx: RunnerCtx, needKeyMessage: string): Promise<void> {
  if (!ctx.deps.client().hasApiKey) throw new Error(needKeyMessage);
  const unreachable = await ensureUser(ctx);
  const t = ctx.store.transient;
  if (t.apiKeyError !== undefined) throw new Error(`Nexus Mods rejected your saved API key — enter a new one in Settings. (${t.apiKeyError})`);
  if (t.user === undefined) throw new Error(unreachable === undefined ? NEXUS_UNREACHABLE : `${NEXUS_UNREACHABLE} (${unreachable})`);
}

/** Copies SMAPI's ConsoleCommands + SaveBackup into the profile (once per SMAPI version) and deploys them. */
async function provideSmapiBundled(ctx: RunnerCtx, slug: string, game: GameInfo): Promise<void> {
  try {
    await ctx.mutex.run(async () => {
      const profile = ctx.store.requireProfile(slug);
      if (await stageSmapiBundled(profile.profileDir, game.gamePath, game.smapiVersion)) await redeploy(ctx, slug);
    });
  } catch (err) {
    console.error(`[runner] ${slug}: could not add SMAPI's bundled mods to the profile`, err);
    ctx.store.setTransient({
      lastError: `Couldn't add SMAPI's Save Backup and Console Commands to this collection (the game still starts): ${errorMessage(err)}`,
    });
  }
}

function isSteamBuild(gamePath: string): boolean {
  return gamePath.includes('/steamapps/common/');
}

export async function launchGame(ctx: RunnerCtx, slug: string): Promise<void> {
  const profile = ctx.store.requireProfile(slug);
  const game = await refreshGame(ctx);
  if (game === undefined) throw new Error("Stardew Valley wasn't found. Open Setup and press \"Choose game folder\".");
  if (!game.smapiInstalled) {
    throw new Error("SMAPI (the mod loader) isn't installed yet. Install it from smapi.io — Setup shows the steps — then press Play again.");
  }
  const required = profile.smapiRequirement;
  if (required !== undefined && game.smapiVersion !== undefined && compareVersions(game.smapiVersion, required) < 0) {
    throw new Error(
      `This collection needs SMAPI ${required} or newer (you have ${game.smapiVersion}). Update SMAPI (the steps are shown on this collection's page), then press Play again.`,
    );
  }
  await mkdir(profile.modsDir, { recursive: true });
  if (isSteamBuild(game.gamePath) && !(await ctx.deps.isSteamRunning())) {
    await ctx.deps.openSteam();
    throw new Error(STEAM_STARTING);
  }
  await provideSmapiBundled(ctx, slug, game);
  await ctx.deps.launchSmapi({ gamePath: game.gamePath, modsDir: profile.modsDir });
}

/**
 * rm -rf a profile, but only a direct child of <userData>/profiles. Runs inside the install mutex, so an install
 * that kept going after Pause finishes before its folder is deleted.
 */
export async function removeProfileDir(ctx: RunnerCtx, slug: string): Promise<void> {
  const first = ctx.store.requireProfile(slug);
  if (first.running) throw new Error(`Pause "${first.name}" before removing it.`);
  await ctx.mutex.run(async () => {
    // The user may have resumed while this waited for the lock.
    const profile = ctx.store.requireProfile(slug);
    if (profile.running) throw new Error(`Pause "${profile.name}" before removing it.`);
    const root = resolve(ctx.paths.profilesRoot);
    const dir = resolve(profile.profileDir);
    if (!isInside(root, dir) || resolve(dir, '..') !== root) {
      throw new Error(`Refusing to delete ${dir}: it is not a Valley Loader profile folder inside ${root}`);
    }
    await rm(dir, { recursive: true, force: true });
    ctx.store.removeProfile(slug);
  });
}

async function freeDiskBytes(dir: string): Promise<number | undefined> {
  try {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch (err) {
    console.error(`[runner] could not read free disk space for ${dir}`, err);
    return undefined;
  }
}

async function nexusLoggedIn(ctx: RunnerCtx): Promise<boolean | undefined> {
  try {
    return await ctx.deps.nexusWindow.isLoggedIn();
  } catch (err) {
    console.error('[runner] could not read Nexus login cookies', err);
    return undefined;
  }
}

function highestVersion(versions: (string | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const v of versions) if (v !== undefined && (best === undefined || compareVersions(v, best) > 0)) best = v;
  return best;
}

/** Largest download size among profiles that still have selected mods left to install. */
function neededBytes(ctx: RunnerCtx): number {
  const pending = ctx.store.profiles.filter((p) => p.mods.some((m) => m.selected && m.status !== 'installed'));
  return Math.max(0, ...pending.map((p) => p.totalSize));
}

export async function gatherPrereqInputs(ctx: RunnerCtx): Promise<PrereqInputs> {
  const [game, macosVersion, free, loggedIn, unreachable] = await Promise.all([
    refreshGame(ctx),
    ctx.deps.macosVersion().catch((err: unknown) => {
      console.error(`[runner] could not read the macOS version: ${errorMessage(err)}`);
      return undefined;
    }),
    freeDiskBytes(ctx.deps.userDataDir),
    nexusLoggedIn(ctx),
    ensureUser(ctx),
  ]);
  const t = ctx.store.transient;
  const inputs: PrereqInputs = {
    platform: ctx.deps.platform ?? process.platform,
    arch: ctx.deps.arch ?? process.arch,
    neededDiskBytes: neededBytes(ctx),
    hasApiKey: t.hasApiKey,
    nxmHandlerRegistered: ctx.deps.isNxmHandlerRegistered(),
  };
  if (macosVersion !== undefined) inputs.macosVersion = macosVersion;
  if (game !== undefined) inputs.game = game;
  const required = highestVersion(ctx.store.profiles.map((p) => p.smapiRequirement));
  if (required !== undefined) inputs.smapiRequired = required;
  if (free !== undefined) inputs.freeDiskBytes = free;
  if (t.user !== undefined) inputs.user = t.user;
  if (t.apiKeyError !== undefined) inputs.apiKeyError = t.apiKeyError;
  if (unreachable !== undefined && t.user === undefined) inputs.apiKeyUnreachable = unreachable;
  if (loggedIn !== undefined) inputs.nexusLoggedIn = loggedIn;
  return inputs;
}

export async function runPrereqChecks(ctx: RunnerCtx): Promise<PrereqCheck[]> {
  return evaluatePrereqs(await gatherPrereqInputs(ctx));
}
