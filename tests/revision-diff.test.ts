// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlannedMod } from '@shared/types';
import { buildPlan } from '../src/main/collection/plan';
import { diffRevisions } from '../src/main/collection/revision-diff';
import { parseCollectionJson } from '../src/main/collection/schema';
import type { RevisionModFile } from '../src/main/nexus/api-graphql';

// Trimmed from a real collection (tckf0m r114): real mod/file ids incl. multi-file mods 20870, 5787, 3753 and SMAPI 4.5.2; generic names.
const live = parseCollectionJson(readFileSync(join(__dirname, 'fixtures/collection-revision.json'), 'utf8'));
/** The plan as a profile holds it: Nexus mods (SMAPI among them) plus 1 bundled mod. */
const current: PlannedMod[] = buildPlan(live);
const nexusMods = current.filter((m) => m.sourceType === 'nexus');
const n = nexusMods.length;

/** What getRevisionModFiles would return for rev 114 (GraphQL lists Nexus files only, never bundled ones). */
function asModFiles(mods: PlannedMod[]): RevisionModFile[] {
  return mods.map((m) => ({
    fileId: m.fileId ?? 0,
    modId: m.modId ?? 0,
    optional: m.optional,
    name: `${m.name} file`,
    version: m.version,
    modName: m.name,
  }));
}

const opts = { fromRevision: 114, toRevision: 115, isPremium: false };
const byMod = (modId: number): PlannedMod[] => nexusMods.filter((m) => m.modId === modId);
const first = <T>(list: T[]): T => {
  const item = list[0];
  if (item === undefined) throw new Error('fixture changed: expected an entry');
  return item;
};

describe('diffRevisions on a trimmed real-collection plan', () => {
  it('reports nothing when the next revision pins the same files (bundled mod ignored)', () => {
    expect(n).toBeGreaterThan(8);
    expect(current).toHaveLength(n + 1);
    const diff = diffRevisions(current, asModFiles(nexusMods), opts);
    expect(diff).toEqual({ fromRevision: 114, toRevision: 115, added: [], removed: [], changed: [], unchanged: n, clicksNeeded: 0 });
  });

  it('pairs a mod listed with several files by exact fileId first, so only the swapped file shows as changed', () => {
    const veryConfigured = byMod(20870);
    expect(veryConfigured.length).toBeGreaterThan(1);
    const target = first(veryConfigured.slice(1));
    const next = asModFiles(nexusMods).map((f) => (f.fileId === target.fileId ? { ...f, fileId: 999_001, version: '9.9.9' } : f));
    const diff = diffRevisions(current, next, opts);
    expect(diff.changed).toEqual([{ name: target.name, fromVersion: target.version, toVersion: '9.9.9', modId: 20870 }]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toBe(n - 1);
    expect(diff.clicksNeeded).toBe(1);
  });

  it('lists added, removed and changed mods and counts free-account clicks', () => {
    const [dropped, bumped] = [first(byMod(3753)), first(nexusMods.filter((m) => m.modId !== 3753 && m.modId !== 2400 && byMod(m.modId ?? 0).length === 1))];
    const next = asModFiles(nexusMods)
      .filter((f) => f.fileId !== dropped.fileId)
      .map((f) => (f.fileId === bumped.fileId ? { ...f, fileId: 999_002, version: '2.0.0' } : f));
    next.push(
      { fileId: 999_003, modId: 777_001, optional: false, name: 'New-1.0.zip', version: '1.0.0', modName: 'Brand New Mod' },
      { fileId: 999_004, modId: 777_002, optional: true, name: 'Extra.zip', version: '0.5', modName: 'Optional Extra' },
    );
    const diff = diffRevisions(current, next, opts);
    expect(diff.added).toEqual([
      { name: 'Brand New Mod', version: '1.0.0', modId: 777_001, fileId: 999_003, optional: false },
      { name: 'Optional Extra', version: '0.5', modId: 777_002, fileId: 999_004, optional: true },
    ]);
    expect(diff.removed).toEqual([{ name: dropped.name, version: dropped.version }]);
    expect(diff.changed).toEqual([{ name: bumped.name, fromVersion: bumped.version, toVersion: '2.0.0', modId: bumped.modId }]);
    expect(diff.unchanged).toBe(n - 2);
    // Required new mod + changed mod; the optional extra needs no click.
    expect(diff.clicksNeeded).toBe(2);
    expect(diffRevisions(current, next, { ...opts, isPremium: true }).clicksNeeded).toBe(0);
    expect(diffRevisions(current, next, { ...opts, cachedKeys: new Set(['nexus:777001:999003']) }).clicksNeeded).toBe(1);
  });

  it('flags a new SMAPI requirement without counting SMAPI as a click', () => {
    const smapi = first(byMod(2400));
    expect(smapi.version).toBe('4.5.2');
    const next = asModFiles(nexusMods).map((f) => (f.modId === 2400 ? { ...f, fileId: 999_005, version: '4.6.0' } : f));
    const diff = diffRevisions(current, next, opts);
    expect(diff.newSmapiRequirement).toBe('4.6.0');
    expect(diff.changed).toEqual([{ name: smapi.name, fromVersion: '4.5.2', toVersion: '4.6.0', modId: 2400 }]);
    expect(diff.clicksNeeded).toBe(0);
  });

  it('does not flag SMAPI when only its file id changes', () => {
    const next = asModFiles(nexusMods).map((f) => (f.modId === 2400 ? { ...f, fileId: 999_006 } : f));
    expect(diffRevisions(current, next, opts).newSmapiRequirement).toBeUndefined();
  });

  it('flags SMAPI when a revision adds it', () => {
    const withoutSmapi = current.filter((m) => m.modId !== 2400);
    const diff = diffRevisions(withoutSmapi, asModFiles(nexusMods), opts);
    expect(diff.newSmapiRequirement).toBe('4.5.2');
    expect(diff.added.map((a) => a.modId)).toEqual([2400]);
  });

  it('turns two files of one mod into one changed + one removed when the next revision keeps a single new file', () => {
    const files = byMod(5787);
    expect(files.length).toBeGreaterThan(1);
    const next = asModFiles(nexusMods).filter((f) => f.modId !== 5787);
    next.push({ fileId: 999_007, modId: 5787, optional: false, name: 'Merged.zip', version: '3.0.0', modName: 'Merged' });
    const diff = diffRevisions(current, next, opts);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({ modId: 5787, toVersion: '3.0.0' });
    expect(diff.removed).toHaveLength(files.length - 1);
    expect(diff.added).toEqual([]);
  });

  it('counts a mod pinned to a file deleted on Nexus as unchanged, not removed', () => {
    const gone = first(nexusMods.filter((m) => byMod(m.modId ?? 0).length === 1));
    const next = asModFiles(nexusMods).filter((f) => f.fileId !== gone.fileId);
    const diff = diffRevisions(current, next, { ...opts, missingFileIds: new Set([gone.fileId ?? 0]) });
    expect(diff).toMatchObject({ removed: [], added: [], changed: [], unchanged: n, unavailable: 1, clicksNeeded: 0 });
  });

  it('pairs changed files of a mod listed twice by file name, whatever the order', () => {
    const [a, b] = byMod(5787);
    if (a === undefined || b === undefined) throw new Error('fixture changed: expected two 5787 files');
    expect(a.logicalFilename).toBeDefined();
    const next = asModFiles(nexusMods).filter((f) => f.modId !== 5787);
    next.push(
      { fileId: 999_011, modId: 5787, optional: b.optional, name: b.logicalFilename ?? '', version: 'b-new', modName: b.name },
      { fileId: 999_010, modId: 5787, optional: a.optional, name: a.logicalFilename ?? '', version: 'a-new', modName: a.name },
    );
    const diff = diffRevisions(current, next, opts);
    expect(diff.changed).toHaveLength(2);
    const row = (toVersion: string) => diff.changed.find((c) => c.toVersion === toVersion);
    expect(row('a-new')).toMatchObject({ name: a.name, fromVersion: a.version });
    expect(row('b-new')).toMatchObject({ name: b.name, fromVersion: b.version });
  });

  it('counts a click for a changed optional mod the user switched on, not for one left off', () => {
    // The live revision has no optional mods: make one single-file mod optional and left off.
    const optional = first(nexusMods.filter((m) => m.modId !== 2400 && byMod(m.modId ?? 0).length === 1));
    const leftOff = current.map((m) => (m.key === optional.key ? { ...m, optional: true, selected: false, status: 'skipped' as const } : m));
    const bump = (f: RevisionModFile): RevisionModFile => (f.fileId === optional.fileId ? { ...f, fileId: 999_020, optional: true } : f);
    const next = asModFiles(nexusMods).map(bump);
    expect(diffRevisions(leftOff, next, opts).clicksNeeded).toBe(0);
    const switchedOn = leftOff.map((m) => (m.key === optional.key ? { ...m, selected: true, status: 'installed' as const } : m));
    expect(diffRevisions(switchedOn, next, opts).clicksNeeded).toBe(1);
  });
});
