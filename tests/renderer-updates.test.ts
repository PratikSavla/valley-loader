// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { GameInfo, PlannedMod, RevisionDiff } from '@shared/types';
import { parsePersistedState } from '../src/main/state/store-schema';
import { isUpdating, startLabel } from '../src/renderer/src/lib/profile';
import {
  applyBlockedReason,
  availableUpdate,
  changedLabel,
  clicksText,
  diffSummary,
  newModsToFetch,
  relativeTime,
  smapiUpgradeNeeded,
} from '../src/renderer/src/lib/updates';

const diff: RevisionDiff = {
  fromRevision: 114, toRevision: 115, unchanged: 100, clicksNeeded: 3,
  added: [{ name: 'New', version: '1.0', modId: 1, fileId: 11, optional: false }],
  changed: [{ name: 'Changed', fromVersion: '1.0', toVersion: '1.1', modId: 2 }],
  removed: [],
};

const game = (smapiVersion?: string): GameInfo => ({
  gamePath: '/g', smapiInstalled: smapiVersion !== undefined, ...(smapiVersion ? { smapiVersion } : {}),
});

function mod(key: string, extra: Partial<PlannedMod> = {}): PlannedMod {
  return { key, name: key, version: '1', optional: false, selected: true, phase: 0, order: 0, sourceType: 'nexus', status: 'pending', warnings: [], ...extra };
}

describe('update display helpers', () => {
  it('shows an update only when it points past the current revision', () => {
    const checkedAt = '2026-11-06T10:00:00Z';
    expect(availableUpdate({ revision: 114 })).toBeUndefined();
    expect(availableUpdate({ revision: 114, update: { latestRevision: 114, checkedAt } })).toBeUndefined();
    expect(availableUpdate({ revision: 114, update: { latestRevision: 115, checkedAt, diff } })?.latestRevision).toBe(115);
  });

  it('describes clicks for free and Premium accounts', () => {
    expect(clicksText(diff, false)).toBe('about 3 Slow-download clicks');
    expect(clicksText({ clicksNeeded: 1 }, false)).toBe('about 1 Slow-download click');
    expect(clicksText({ clicksNeeded: 0 }, false)).toBe('no new downloads');
    expect(clicksText(diff, true)).toBe('no download clicks (Premium)');
  });

  it('summarises the diff, leaving out empty groups', () => {
    expect(diffSummary(diff)).toBe('1 added · 1 changed');
    expect(diffSummary({ added: [], changed: [], removed: [] })).toBe(
      'No Nexus mods change (the curator may have updated included files or settings)',
    );
  });

  it('labels a changed file, including a new file with the same version', () => {
    expect(changedLabel({ fromVersion: '1.0', toVersion: '1.1' })).toBe('v1.0 → v1.1');
    expect(changedLabel({ fromVersion: '1.2', toVersion: ' 1.2 ' })).toBe('v1.2 · new file from the curator');
    expect(changedLabel({ fromVersion: '', toVersion: '' })).toBe('same version · new file from the curator');
  });

  it('warns about SMAPI only when the new requirement is newer than what is installed', () => {
    const smapiDiff = { newSmapiRequirement: '4.6.0' };
    expect(smapiUpgradeNeeded(smapiDiff, game('4.5.2'))).toBe('4.6.0');
    expect(smapiUpgradeNeeded(smapiDiff, game('4.6.0'))).toBeUndefined();
    expect(smapiUpgradeNeeded(smapiDiff, game())).toBe('4.6.0');
    expect(smapiUpgradeNeeded(smapiDiff, undefined)).toBeUndefined();
    expect(smapiUpgradeNeeded({}, game('4.0.0'))).toBeUndefined();
  });

  it('blocks Update with a reason: installing, mods still installing, updating, no key, rejected key', () => {
    const ok = { hasApiKey: true, keyRejected: false };
    expect(applyBlockedReason({ running: true, mods: [] }, ok)).toMatch(/Pause the install first/);
    expect(applyBlockedReason({ running: false, mods: [mod('a', { status: 'installing' })] }, ok)).toMatch(/Waiting for the mods already being installed/);
    expect(applyBlockedReason({ running: false, mods: [] }, { ...ok, updating: true })).toMatch(/being updated/);
    expect(applyBlockedReason({ running: false, mods: [] }, { hasApiKey: false, keyRejected: false })).toMatch(/Add your Nexus API key in Settings/);
    expect(applyBlockedReason({ running: false, mods: [] }, { hasApiKey: true, keyRejected: true })).toMatch(/rejected your saved API key/);
    expect(applyBlockedReason({ running: true, mods: [] }, { hasApiKey: false, keyRejected: false })).toMatch(/Pause the install first/);
    expect(applyBlockedReason({ running: false, mods: [mod('a', { status: 'installed' })] }, ok)).toBeUndefined();
  });

  it('counts only mods the update brought in that still need installing', () => {
    const before = new Set(['nexus:1:1', 'nexus:2:2']);
    const mods = [
      mod('nexus:1:1'),
      mod('nexus:2:3'),
      mod('nexus:5:5', { status: 'installed' }),
      mod('nexus:6:6', { optional: true, selected: false, status: 'skipped' }),
      mod('nexus:2400:9', { modId: 2400, status: 'manual' }),
      mod('nexus:7:7', { status: 'needsClick' }),
    ];
    expect(newModsToFetch({ mods }, before)).toBe(2);
  });

  it('names the header start button the way the update callout refers to it', () => {
    expect(startLabel({ mods: [mod('a'), mod('b')] })).toBe('Start install');
    expect(startLabel({ mods: [mod('a', { status: 'installed' }), mod('b')] })).toBe('Resume install');
    expect(startLabel({ mods: [mod('a', { status: 'failed' }), mod('b', { status: 'failed' })] })).toBe('Retry 2 failed');
    expect(isUpdating(['col'], 'COL')).toBe(true);
    expect(isUpdating(undefined, 'col')).toBe(false);
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    expect(relativeTime('2026-11-06T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-11-06T11:55:00Z', now)).toBe('5 minutes ago');
    expect(relativeTime('2026-11-06T11:00:00Z', now)).toBe('1 hour ago');
    expect(relativeTime('2026-11-03T12:00:00Z', now)).toBe('3 days ago');
    expect(relativeTime('2026-11-06T13:00:00Z', now)).toBe('just now');
    expect(relativeTime('garbage', now)).toBe('at an unknown time');
  });
});

describe('persisted update info', () => {
  const profile = (update: unknown): unknown => ({
    slug: 'col', revision: 2, name: 'C', author: 'a', totalSize: 1, profileDir: '/p', modsDir: '/p/Mods',
    createdAt: 'x', updatedAt: 'x', running: false, mods: [], update,
  });

  it('keeps a valid update and drops a malformed one instead of resetting state.json', () => {
    const good = { latestRevision: 3, checkedAt: '2026-11-06T10:00:00Z', diff: { ...diff, fromRevision: 2, toRevision: 3 } };
    expect(parsePersistedState(JSON.stringify({ profiles: [profile(good)] })).profiles[0]?.update).toEqual(good);
    const bad = parsePersistedState(JSON.stringify({ profiles: [profile({ latestRevision: 'x' })] }));
    expect(bad.profiles).toHaveLength(1);
    expect(bad.profiles[0]?.update).toBeUndefined();
    expect(bad.profiles[0]).not.toHaveProperty('update');
  });
});
