// SPDX-License-Identifier: AGPL-3.0-only
// Display logic for "new collection revision" checks: what to show, click estimates, SMAPI warnings, times.
import { SMAPI_MOD_ID, type GameInfo, type ProfileState, type ProfileUpdate, type RevisionDiff, type RevisionDiffChanged } from '@shared/types';
import { plural } from './format';
import { profileStats } from './profile';
import { compareVersions } from './version';

/** The profile's stored update when it points at a newer revision; undefined when up to date or never checked. */
export function availableUpdate(profile: Pick<ProfileState, 'revision' | 'update'>): ProfileUpdate | undefined {
  const update = profile.update;
  return update !== undefined && update.latestRevision > profile.revision ? update : undefined;
}

/** Completes "Updating needs …": "about 3 Slow-download clicks", "no download clicks (Premium)", "no new downloads". */
export function clicksText(diff: Pick<RevisionDiff, 'clicksNeeded'>, premium: boolean): string {
  if (premium) return 'no download clicks (Premium)';
  if (diff.clicksNeeded === 0) return 'no new downloads';
  return `about ${plural(diff.clicksNeeded, 'Slow-download click')}`;
}

/** "2 added · 1 changed · 1 removed" (zero counts left out), or a note that only bundled files/settings changed. */
export function diffSummary(diff: Pick<RevisionDiff, 'added' | 'changed' | 'removed'>): string {
  const parts = [
    diff.added.length > 0 ? `${diff.added.length} added` : '',
    diff.changed.length > 0 ? `${diff.changed.length} changed` : '',
    diff.removed.length > 0 ? `${diff.removed.length} removed` : '',
  ].filter((p) => p !== '');
  return parts.length > 0 ? parts.join(' · ') : 'No Nexus mods change (the curator may have updated included files or settings)';
}

/** "v1.0 → v1.1", or "v1.2 · new file from the curator" when the curator pinned another file with the same version. */
export function changedLabel(m: Pick<RevisionDiffChanged, 'fromVersion' | 'toVersion'>): string {
  const from = m.fromVersion.trim();
  const to = m.toVersion.trim();
  if (from !== to) return `v${from} → v${to}`;
  return `${to !== '' ? `v${to}` : 'same version'} · new file from the curator`;
}

/** The new revision's SMAPI version when it is newer than the installed SMAPI (or SMAPI is missing). */
export function smapiUpgradeNeeded(diff: Pick<RevisionDiff, 'newSmapiRequirement'>, game: GameInfo | undefined): string | undefined {
  const required = diff.newSmapiRequirement;
  if (required === undefined || game === undefined) return undefined;
  if (!game.smapiInstalled || game.smapiVersion === undefined) return required;
  return compareVersions(game.smapiVersion, required) < 0 ? required : undefined;
}

export interface UpdateAccount {
  hasApiKey: boolean;
  /** Nexus refused the saved key (401/403). */
  keyRejected: boolean;
  /** The collection is being resolved or updated right now. */
  updating?: boolean;
}

/** Why "Update" is disabled, or undefined when it can run. */
export function applyBlockedReason(profile: Pick<ProfileState, 'running' | 'mods'>, account: UpdateAccount): string | undefined {
  if (profile.running) return 'Pause the install first: a collection can only be updated while nothing is downloading.';
  if (profileStats(profile).busy > 0) return 'Waiting for the mods already being installed to finish…';
  if (account.updating === true) return 'This collection is being updated…';
  if (!account.hasApiKey) {
    return 'Add your Nexus API key in Settings to update. Checking for new revisions works without it, but downloading the collection needs your key.';
  }
  if (account.keyRejected) return 'Nexus Mods rejected your saved API key. Enter a new one in Settings to update.';
  return undefined;
}

/**
 * Mods an update brought in (keys not in the plan before it) that Start/Resume still has to download and install.
 * SMAPI is installed by hand, so it doesn't count.
 */
export function newModsToFetch(profile: Pick<ProfileState, 'mods'>, keysBefore: ReadonlySet<string>): number {
  return profile.mods.filter(
    (m) =>
      !keysBefore.has(m.key) &&
      m.selected &&
      m.modId !== SMAPI_MOD_ID &&
      m.status !== 'installed' &&
      m.status !== 'skipped' &&
      m.status !== 'manual',
  ).length;
}

const UNITS: [number, string][] = [
  [86_400_000, 'day'],
  [3_600_000, 'hour'],
  [60_000, 'minute'],
];

/** "just now", "5 minutes ago", "1 hour ago", "3 days ago"; "at an unknown time" for a bad date. */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'at an unknown time';
  const ago = Math.max(0, now - then);
  for (const [ms, unit] of UNITS) {
    if (ago >= ms) return `${plural(Math.floor(ago / ms), unit)} ago`;
  }
  return 'just now';
}
