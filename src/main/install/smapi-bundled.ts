// SPDX-License-Identifier: AGPL-3.0-only
// SMAPI ships two mods inside the game's own Mods folder: ConsoleCommands and SaveBackup (automatic save
// backups). A profile launched with --mods-path only loads its own Mods folder, so those two are copied (the
// game folder is only read) into the profile as a synthetic staged mod the app owns. Deploy puts it first, so
// collection files win any conflict. SaveBackup writes its backups into its own Mods/SaveBackup/backups
// folder; those files are not owned by the app, so a re-deploy never deletes them. Pure Node.
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { Profile } from './profile';
import { errCode, errMessage, statOrUndefined } from './profile-fs';

export const SMAPI_BUNDLED_KEY = 'smapi-bundled';
export const SMAPI_BUNDLED_MODS = ['ConsoleCommands', 'SaveBackup'] as const;
/** Records which SMAPI version the staged copy came from (outside staging, so it is never deployed). */
const STAMP_FILE = 'smapi-bundled.json';

async function readStamp(path: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'smapiVersion' in parsed) {
      const { smapiVersion } = parsed as { smapiVersion: unknown };
      return typeof smapiVersion === 'string' ? smapiVersion : undefined;
    }
    return undefined;
  } catch (err) {
    if (errCode(err) !== 'ENOENT') console.warn(`[smapi-bundled] ignoring unreadable ${path}: ${errMessage(err)}`);
    return undefined;
  }
}

/** Never copy the user's own save backups out of the game folder. */
function isBackupData(modDir: string, from: string): boolean {
  const first = relative(modDir, from).split(sep)[0] ?? '';
  return first.toLowerCase() === 'backups';
}

/**
 * Copies SMAPI's bundled mods from `<gamePath>/Mods` into the profile's staging area. Does nothing when they are
 * already staged for this SMAPI version. Missing folders are skipped with a warning. Returns true when it re-staged.
 */
export async function stageSmapiBundled(profileDir: string, gamePath: string, smapiVersion: string | undefined): Promise<boolean> {
  const profile = new Profile(profileDir);
  const stampPath = join(profileDir, STAMP_FILE);
  const version = smapiVersion ?? '';
  if ((await readStamp(stampPath)) === version && (await profile.isStaged(SMAPI_BUNDLED_KEY))) return false;
  const dir = profile.stagedDir(SMAPI_BUNDLED_KEY);
  await rm(dir, { recursive: true, force: true });
  let copied = 0;
  for (const name of SMAPI_BUNDLED_MODS) {
    const src = join(gamePath, 'Mods', name);
    if (!(await statOrUndefined(src))?.isDirectory()) {
      console.warn(`[smapi-bundled] SMAPI's ${name} mod is missing from ${join(gamePath, 'Mods')}; the profile runs without it`);
      continue;
    }
    try {
      await cp(src, join(dir, name), { recursive: true, verbatimSymlinks: true, filter: (from) => !isBackupData(src, from) });
    } catch (err) {
      throw new Error(`Cannot copy SMAPI's ${name} mod into the profile: ${errMessage(err)}`, { cause: err });
    }
    copied += 1;
  }
  if (copied === 0) await rm(dir, { recursive: true, force: true });
  await writeFile(stampPath, JSON.stringify({ smapiVersion: version }));
  return true;
}
