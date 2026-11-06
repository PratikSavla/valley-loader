// SPDX-License-Identifier: AGPL-3.0-only
// Derived numbers for a collection profile: counts, readiness to play, headline status.
import type { ModStatus, PlannedMod, ProfileState } from '@shared/types';
import type { Tone } from './format';

const BUSY: ReadonlySet<ModStatus> = new Set<ModStatus>(['resolving', 'queued', 'downloading', 'installing']);

export interface ProfileStats {
  total: number;
  /** Mods that will be installed (required + chosen optional). */
  selected: number;
  installed: number;
  failed: number;
  /** Mods waiting for a file the user must pick. */
  manual: number;
  needsClick: number;
  busy: number;
  counts: Record<ModStatus, number>;
  selectedBytes: number;
  optionalCount: number;
}

function emptyCounts(): Record<ModStatus, number> {
  return {
    pending: 0,
    needsClick: 0,
    resolving: 0,
    queued: 0,
    downloading: 0,
    installing: 0,
    installed: 0,
    skipped: 0,
    manual: 0,
    failed: 0,
  };
}

export function profileStats(profile: Pick<ProfileState, 'mods'>): ProfileStats {
  const counts = emptyCounts();
  const stats: ProfileStats = {
    total: profile.mods.length,
    selected: 0,
    installed: 0,
    failed: 0,
    manual: 0,
    needsClick: 0,
    busy: 0,
    counts,
    selectedBytes: 0,
    optionalCount: 0,
  };
  for (const mod of profile.mods) {
    counts[mod.status] += 1;
    if (mod.optional) stats.optionalCount += 1;
    if (!mod.selected) continue;
    stats.selected += 1;
    stats.selectedBytes += mod.fileSize ?? 0;
    if (mod.status === 'installed') stats.installed += 1;
    else if (mod.status === 'failed') stats.failed += 1;
    else if (mod.status === 'manual') stats.manual += 1;
    else if (mod.status === 'needsClick') stats.needsClick += 1;
    else if (BUSY.has(mod.status)) stats.busy += 1;
  }
  return stats;
}

/**
 * 'ready'      – every selected mod is installed.
 * 'partial'    – some selected mods failed/need a file, nothing is in flight, at least one installed:
 *                playing is allowed after the user confirms.
 * 'incomplete' – install hasn't progressed far enough to play.
 */
export type PlayReadiness = 'ready' | 'partial' | 'incomplete';

export function playReadiness(profile: Pick<ProfileState, 'mods' | 'running'>): PlayReadiness {
  const s = profileStats(profile);
  if (s.selected > 0 && s.installed === s.selected) return 'ready';
  if (!profile.running && s.busy === 0 && s.installed > 0 && s.failed + s.manual > 0) return 'partial';
  return 'incomplete';
}

/** One headline for cards and headers. */
export function profileStatus(profile: Pick<ProfileState, 'mods' | 'running'>): { text: string; tone: Tone } {
  const s = profileStats(profile);
  if (profile.running) {
    return s.needsClick > 0 ? { text: 'Waiting for your click', tone: 'warn' } : { text: 'Installing', tone: 'busy' };
  }
  if (s.selected > 0 && s.installed === s.selected) return { text: 'Ready to play', tone: 'ok' };
  if (s.failed + s.manual > 0) return { text: 'Needs attention', tone: 'bad' };
  if (s.installed > 0) return { text: 'Paused', tone: 'idle' };
  return { text: 'Not started', tone: 'idle' };
}

/** Label of the header's start button: "Retry 2 failed", "Resume install" or "Start install". */
export function startLabel(profile: Pick<ProfileState, 'mods'>): string {
  const stats = profileStats(profile);
  if (stats.failed > 0) return `Retry ${stats.failed} failed`;
  const started = stats.installed > 0 || profile.mods.some((m) => m.status !== 'pending' && m.status !== 'skipped');
  return started ? 'Resume install' : 'Start install';
}

/** True while the collection is being resolved or updated (AppSnapshot.resolving). */
export function isUpdating(resolving: readonly string[] | undefined, slug: string): boolean {
  return resolving?.includes(slug.toLowerCase()) === true;
}

/** Mods sorted into deploy order (lowest order first). Does not mutate the input. */
export function sortedMods(mods: readonly PlannedMod[]): PlannedMod[] {
  return [...mods].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export type ModFilter = 'all' | 'attention' | 'remaining';

export function filterMods(mods: readonly PlannedMod[], filter: ModFilter): PlannedMod[] {
  if (filter === 'attention') {
    return mods.filter((m) => m.status === 'failed' || m.status === 'manual' || m.warnings.length > 0);
  }
  if (filter === 'remaining') return mods.filter((m) => m.selected && m.status !== 'installed');
  return [...mods];
}
