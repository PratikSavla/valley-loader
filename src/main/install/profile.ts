// SPDX-License-Identifier: AGPL-3.0-only
// Per-collection profile: staging area per mod + deployed Mods/ folder with ownership tracking. Pure Node.
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { deployStaged } from './profile-deploy';
import { errMessage, movePath, safeModKey, statOrUndefined } from './profile-fs';
import type { InstallAnalysis } from './stardew';

export { safeModKey } from './profile-fs';

export interface DeployResult {
  copied: number;
  removed: number;
  /** Mods/-relative paths where a higher-order mod replaced a lower-order one. */
  overrides: { path: string; winner: string; loser: string }[];
}

/** Splits a "/"-separated Mods/ path into segments, rejecting any that could escape the staging dir. */
function safeSegments(path: string, modKey: string): string[] {
  const segments = path.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..' || seg.includes('\\') || seg.includes('\0'))) {
    throw new Error(`Mod "${modKey}" has an unsafe folder name: ${JSON.stringify(path)}`);
  }
  return segments;
}

/**
 * Layout under profileDir:
 *   staging/<safe modKey>/<Mods-relative files>   — each mod's files as they'd appear in Mods/
 *   Mods/                                          — what SMAPI loads (--mods-path)
 *   files.json                                     — { [modsRelativePath]: { owner: modKey, size, mtimeMs } }
 */
export class Profile {
  readonly modsDir: string;
  readonly stagingDir: string;
  readonly manifestPath: string;

  constructor(readonly profileDir: string) {
    this.modsDir = join(profileDir, 'Mods');
    this.stagingDir = join(profileDir, 'staging');
    this.manifestPath = join(profileDir, 'files.json');
  }

  /** Absolute staging folder for a mod key. */
  stagedDir(modKey: string): string {
    return join(this.stagingDir, safeModKey(modKey));
  }

  /**
   * Move an analysed extraction into staging/<modKey>. Returns the top-level Mods/ folder names it provides.
   * A folder's targetName may be a nested path ("Wrapper/Mod"), kept as is. Throws for smapi/root kinds.
   * The source folders are moved (renamed; copied when crossing devices), so the extraction dir is consumed.
   * An already-staged mod is replaced atomically (built in a temp dir, then swapped in).
   */
  async stageMod(modKey: string, analysis: InstallAnalysis): Promise<string[]> {
    if (analysis.kind === 'smapi') {
      throw new Error(`Mod "${modKey}" is the SMAPI installer; install SMAPI with its own installer instead of staging it`);
    }
    if (analysis.kind === 'root') {
      throw new Error(`Mod "${modKey}" replaces game files (Content/); root mods cannot be staged into a profile`);
    }
    const finalDir = this.stagedDir(modKey);
    // "~" is outside the safe-key alphabet, so temp dirs never collide with a staged mod.
    const tmpDir = join(this.stagingDir, `~tmp-${randomBytes(6).toString('hex')}`);
    try {
      await mkdir(tmpDir, { recursive: true });
      if (analysis.kind === 'mods') {
        for (const folder of analysis.folders) {
          await movePath(folder.sourceDir, join(tmpDir, ...safeSegments(folder.targetName, modKey)));
        }
      } else {
        for (const child of await readdir(analysis.sourceDir)) {
          await movePath(join(analysis.sourceDir, child), join(tmpDir, child));
        }
      }
      await rm(finalDir, { recursive: true, force: true });
      await rename(tmpDir, finalDir);
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true });
      throw new Error(`Cannot stage mod "${modKey}": ${errMessage(err)}`, { cause: err });
    }
    return this.stagedFolders(modKey);
  }

  /** Top-level folder names a staged mod provides under Mods/ (sorted). Empty when not staged. */
  async stagedFolders(modKey: string): Promise<string[]> {
    const dir = this.stagedDir(modKey);
    if (!(await this.isStaged(modKey))) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  async isStaged(modKey: string): Promise<boolean> {
    const st = await statOrUndefined(this.stagedDir(modKey));
    return st?.isDirectory() ?? false;
  }

  /** Deletes the mod's staging folder. Mods/ is untouched until the next deploy() (which removes its files). */
  async unstageMod(modKey: string): Promise<void> {
    try {
      await rm(this.stagedDir(modKey), { recursive: true, force: true });
    } catch (err) {
      throw new Error(`Cannot unstage mod "${modKey}": ${errMessage(err)}`, { cause: err });
    }
  }

  /**
   * Make Mods/ reflect the staged mods in `orderedKeys` (later key wins a file conflict).
   * Copies only files whose owner changed or that are missing; removes files we own that no mod provides any more.
   * Never deletes files we don't own (e.g. config.json SMAPI mods generate at runtime).
   * Files owned by us but modified on disk since deploy (size/mtime differ) are left alone unless the owner changes.
   * Every key must be staged (throws otherwise). Paths are compared case-insensitively (APFS).
   */
  async deploy(orderedKeys: string[]): Promise<DeployResult> {
    return deployStaged(
      { modsDir: this.modsDir, stagingDir: this.stagingDir, manifestPath: this.manifestPath },
      orderedKeys,
    );
  }
}
