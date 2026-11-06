// SPDX-License-Identifier: AGPL-3.0-only
// Compares a profile's plan with the file list of a newer collection revision. Pure, no Electron imports.
//
// Collections pin exact files (updatePolicy 'exact'): a curator ships updates as new revisions, so the diff is
// between pinned files, never "newer on Nexus". Only Nexus mods take part: bundled (and direct/browse/manual) mods
// are not in GraphQL collectionRevision.modFiles, so they are ignored here and simply re-planned on update.
import {
  SMAPI_MOD_ID,
  type PlannedMod,
  type RevisionDiff,
  type RevisionDiffAdded,
  type RevisionDiffChanged,
  type RevisionDiffRemoved,
} from '@shared/types';
import type { RevisionModFile } from '../nexus/api-graphql';

export interface DiffOptions {
  fromRevision: number;
  toRevision: number;
  isPremium: boolean;
  /** Archives already downloaded, as plan keys "nexus:<modId>:<fileId>" (no click needed for those). */
  cachedKeys?: ReadonlySet<string>;
  /**
   * File ids the new revision still pins but Nexus no longer has (GraphQL modFiles entry with file: null). Apply
   * keeps a current mod pinned to one of them (same plan key), so it counts as unchanged, not removed.
   */
  missingFileIds?: ReadonlySet<number>;
}

type NexusMod = PlannedMod & { modId: number; fileId: number };

interface Pairing {
  unchanged: number;
  added: RevisionModFile[];
  changed: { from: NexusMod; to: RevisionModFile }[];
  removed: NexusMod[];
}

function isNexusMod(mod: PlannedMod): mod is NexusMod {
  return mod.sourceType === 'nexus' && mod.modId !== undefined && mod.fileId !== undefined;
}

/** Takes (and removes) the first entry of `list` matching `pred`. */
function takeFirst<T>(list: T[], pred: (item: T) => boolean): T | undefined {
  const index = list.findIndex(pred);
  if (index === -1) return undefined;
  return list.splice(index, 1)[0];
}

/**
 * Exact fileId matches first (a mod can be listed several times with different files, e.g. a main file and
 * its config pack), then files still pinned but deleted on Nexus, then leftover files of the same modId pair up
 * as "changed" (same file name first); the rest are added/removed.
 */
function pairFiles(current: readonly PlannedMod[], next: readonly RevisionModFile[], missing: ReadonlySet<number>): Pairing {
  const left = current.filter(isNexusMod);
  const unmatched: RevisionModFile[] = [];
  let unchanged = 0;
  for (const file of next) {
    if (takeFirst(left, (m) => m.fileId === file.fileId) === undefined) unmatched.push(file);
    else unchanged += 1;
  }
  for (const id of missing) {
    if (takeFirst(left, (m) => m.fileId === id) !== undefined) unchanged += 1;
  }
  const added: RevisionModFile[] = [];
  const changed: Pairing['changed'] = [];
  for (const file of unmatched) {
    const from =
      takeFirst(left, (m) => m.modId === file.modId && m.logicalFilename !== undefined && m.logicalFilename === file.name) ??
      takeFirst(left, (m) => m.modId === file.modId);
    if (from === undefined) added.push(file);
    else changed.push({ from, to: file });
  }
  return { unchanged, added, changed, removed: left };
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

function needsClick(file: RevisionModFile, cached: ReadonlySet<string>): boolean {
  return file.modId !== SMAPI_MOD_ID && !cached.has(`nexus:${file.modId}:${file.fileId}`);
}

/** SMAPI version the new revision asks for, when it adds SMAPI or changes its listed version. */
function smapiChange(pairing: Pairing): string | undefined {
  const added = pairing.added.find((f) => f.modId === SMAPI_MOD_ID);
  if (added !== undefined) return added.version.trim() || undefined;
  const changed = pairing.changed.find((c) => c.to.modId === SMAPI_MOD_ID);
  if (changed === undefined) return undefined;
  const version = changed.to.version.trim();
  return version !== '' && version !== changed.from.version.trim() ? version : undefined;
}

export function diffRevisions(current: readonly PlannedMod[], next: readonly RevisionModFile[], opts: DiffOptions): RevisionDiff {
  const missing = opts.missingFileIds ?? new Set<number>();
  const pairing = pairFiles(current, next, missing);
  const cached = opts.cachedKeys ?? new Set<string>();
  const added: RevisionDiffAdded[] = pairing.added
    .map((f) => ({ name: f.modName, version: f.version, modId: f.modId, fileId: f.fileId, optional: f.optional }))
    .sort(byName);
  const changed: RevisionDiffChanged[] = pairing.changed
    .map(({ from, to }) => ({ name: from.name, fromVersion: from.version, toVersion: to.version, modId: to.modId }))
    .sort(byName);
  const removed: RevisionDiffRemoved[] = pairing.removed.map((m) => ({ name: m.name, version: m.version })).sort(byName);
  // Required files, plus a changed optional file the user had switched on (buildPlan keeps it selected).
  const toFetch = [
    ...pairing.added.filter((f) => !f.optional),
    ...pairing.changed.filter((c) => !c.to.optional || c.from.selected).map((c) => c.to),
  ];
  const diff: RevisionDiff = {
    fromRevision: opts.fromRevision,
    toRevision: opts.toRevision,
    added,
    removed,
    changed,
    unchanged: pairing.unchanged,
    clicksNeeded: opts.isPremium ? 0 : toFetch.filter((f) => needsClick(f, cached)).length,
  };
  const smapi = smapiChange(pairing);
  if (smapi !== undefined) diff.newSmapiRequirement = smapi;
  if (missing.size > 0) diff.unavailable = missing.size;
  return diff;
}
