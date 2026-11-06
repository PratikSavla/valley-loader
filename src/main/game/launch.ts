// SPDX-License-Identifier: AGPL-3.0-only
// Launches SMAPI pointed at a profile's Mods folder.
//
// How SMAPI starts on macOS (verified read-only on SMAPI 4.5.1, Steam build, plus SMAPI's docs
// docs/technical/smapi.md and the wiki's Player Guide):
// - The SMAPI installer replaces `Contents/MacOS/StardewValley` (the bundle's CFBundleExecutable, so the
//   one Steam starts) with SMAPI's unix-launcher bash script; the game's own script is kept as
//   `StardewValley-original`.
// - That script is NOT usable for us: on macOS without a TTY it re-opens itself in Terminal via a temp
//   `.command` file that re-expands args unquoted (`"$0" $@`), which breaks our mods path because
//   "Application Support" contains a space; its arg loop also `shift`s away every unknown argument unless
//   they come after `--`.
// - `Contents/MacOS/StardewModdingAPI` is a Mach-O .NET apphost (x86_64, runs under Rosetta on Apple
//   silicon). The script itself ends with `./StardewModdingAPI "$@"`, so spawning the apphost directly
//   with an argv array is exactly what the script does, minus the Terminal hop, and passes args intact.
// - StardewModdingAPI.dll accepts `--mods-path <dir>` (absolute or relative to the game folder) and the
//   equivalent env var SMAPI_MODS_PATH; also `--no-terminal` / SMAPI_NO_TERMINAL, which stops SMAPI
//   writing to a console that doesn't exist (we spawn with stdio 'ignore'). The full log still goes to
//   ~/.config/StardewValley/ErrorLogs/SMAPI-latest.txt.
// - The Steam build needs the Steam client running (Steamworks init), hence isSteamRunning().
import { spawn as nodeSpawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SMAPI_LAUNCHER } from './detect';

/** Process names of the macOS Steam client (`Steam.app/Contents/MacOS/steam_osx`). */
export const STEAM_PROCESS_NAMES = ['steam_osx'] as const;

export interface LaunchOptions {
  gamePath: string;
  modsDir: string;
  /** Injected for tests. */
  spawnImpl?: typeof import('node:child_process').spawn;
}

/** Exact argv passed to the launcher. */
export function smapiArgs(modsDir: string): string[] {
  return ['--mods-path', modsDir, '--no-terminal'];
}

/** Spawn "<gamePath>/StardewModdingAPI --mods-path <modsDir>" detached. Throws if the launcher is missing. */
export async function launchSmapi(opts: LaunchOptions): Promise<void> {
  const launcher = join(opts.gamePath, SMAPI_LAUNCHER);
  await assertExecutable(launcher);
  await assertDirectory(opts.modsDir);
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const child = spawnImpl(launcher, smapiArgs(opts.modsDir), {
    cwd: opts.gamePath,
    detached: true,
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', (err) => reject(new Error(`Could not start SMAPI at ${launcher}: ${err.message}`, { cause: err })));
  });
  child.unref();
}

async function assertExecutable(launcher: string): Promise<void> {
  try {
    const info = await stat(launcher);
    if (!info.isFile()) throw new Error('not a file');
    await access(launcher, constants.X_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = code === 'ENOENT' ? 'SMAPI is not installed in this game folder' : 'the SMAPI launcher is not executable';
    throw new Error(`Cannot launch SMAPI: ${reason} (${launcher}).`, { cause: err });
  }
}

async function assertDirectory(dir: string): Promise<void> {
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error('not a directory');
  } catch (err) {
    throw new Error(`Cannot launch SMAPI: the profile's Mods folder is missing (${dir}).`, { cause: err });
  }
}

export type SpawnImpl = typeof import('node:child_process').spawn;

/** True if a Steam client process is running (pgrep). Steam must run for the Steam build to start. */
export async function isSteamRunning(spawnImpl: SpawnImpl = nodeSpawn): Promise<boolean> {
  for (const name of STEAM_PROCESS_NAMES) {
    if (await pgrep(name, spawnImpl)) return true;
  }
  return false;
}

/** `pgrep -x <name>`: exit 0 = found, 1 = not found, anything else is an error. */
function pgrep(name: string, spawnImpl: SpawnImpl): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawnImpl('/usr/bin/pgrep', ['-x', name], { stdio: 'ignore' });
    child.once('error', (err) => reject(new Error(`pgrep for ${name} failed: ${err.message}`, { cause: err })));
    child.once('close', (code) => {
      if (code === 0) resolve(true);
      else if (code === 1) resolve(false);
      else reject(new Error(`pgrep for ${name} exited with code ${String(code)}`));
    });
  });
}
