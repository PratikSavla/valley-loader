// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlannedMod } from '@shared/types';
import {
  WARN_CHOICES,
  buildPlan,
  modKey,
  referenceMatches,
  smapiRequirement,
} from '../src/main/collection/plan';
import { parseCollectionJson } from '../src/main/collection/schema';
import type { CollectionJson, CollectionModEntry, CollectionModRule } from '../src/main/collection/schema';

const fixture = parseCollectionJson(readFileSync(resolve(__dirname, 'fixtures/collection.json'), 'utf8'));

function entry(name: string, source: Partial<CollectionModEntry['source']>, extra: Partial<CollectionModEntry> = {}): CollectionModEntry {
  return {
    name,
    version: '1.0.0',
    optional: false,
    domainName: 'stardewvalley',
    phase: 0,
    source: { type: 'nexus', ...source },
    ...extra,
  };
}

function collection(mods: CollectionModEntry[], modRules: CollectionModRule[] = []): CollectionJson {
  return { info: { name: 'Inline', domainName: 'stardewvalley' }, mods, modRules };
}

const byName = (plan: PlannedMod[], name: string): PlannedMod => {
  const found = plan.find((m) => m.name === name);
  if (found === undefined) throw new Error(`no planned mod named ${name}`);
  return found;
};

describe('modKey', () => {
  it('builds a key per source type', () => {
    expect(modKey(entry('CP', { modId: 1915, fileId: 128843 }))).toBe('nexus:1915:128843');
    expect(modKey(entry('B', { type: 'bundle', fileExpression: 'Valley Tweaks-1.0.0', logicalFilename: 'x' }))).toBe('bundle:Valley Tweaks-1.0.0');
    expect(modKey(entry('B', { type: 'bundle', logicalFilename: 'Tweaks' }))).toBe('bundle:Tweaks');
    expect(modKey(entry('B', { type: 'bundle' }))).toBe('bundle:B');
    expect(modKey(entry('D', { type: 'direct', url: 'https://x/y.zip' }))).toBe('direct:https://x/y.zip');
    expect(modKey(entry('W', { type: 'browse', url: 'https://moddrop.com/1' }))).toBe('browse:https://moddrop.com/1');
    expect(modKey(entry('Hand', { type: 'manual' }))).toBe('manual:Hand');
  });
});

describe('referenceMatches (Vortex testRef semantics)', () => {
  const cp = entry('Content Patcher', { modId: 1915, fileId: 10, md5: 'aa11', logicalFilename: 'Content Patcher 2.5.3', tag: 'tagCP' }, { version: '2.5.3' });

  it('matches nexus repo ids exactly unless the version is fuzzy', () => {
    const repo = { repository: 'nexus', modId: '1915', fileId: '10' };
    expect(referenceMatches({ repo, versionMatch: '2.5.3' }, cp)).toBe(true);
    expect(referenceMatches({ repo: { ...repo, fileId: '11' }, versionMatch: '2.5.3' }, cp)).toBe(false);
    expect(referenceMatches({ repo: { ...repo, fileId: '11' }, versionMatch: '*' }, cp)).toBe(true);
    expect(referenceMatches({ repo: { ...repo, modId: '9999' }, versionMatch: '*' }, cp)).toBe(false);
  });

  it('a non-matching fileMD5 vetoes an otherwise matching logical file name', () => {
    expect(referenceMatches({ fileMD5: 'ffff', logicalFileName: 'Content Patcher 2.5.3', versionMatch: '2.5.3' }, cp)).toBe(false);
    expect(referenceMatches({ fileMD5: 'AA11', versionMatch: '2.5.3' }, cp)).toBe(true);
    // fuzzy versions ignore md5 and fall back to the name
    expect(referenceMatches({ fileMD5: 'ffff', logicalFileName: 'content patcher 2.5.3', versionMatch: '>=2.0.0+prefer' }, cp)).toBe(true);
  });

  it('matches logical file names case-insensitively and checks exact versions', () => {
    expect(referenceMatches({ logicalFileName: 'CONTENT PATCHER 2.5.3' }, cp)).toBe(true);
    expect(referenceMatches({ logicalFileName: 'Content Patcher 2.5.3', versionMatch: '2.5' }, cp)).toBe(false);
    expect(referenceMatches({ logicalFileName: 'Content Patcher 2.5.3', versionMatch: 'v2.5.3' }, cp)).toBe(true);
    expect(referenceMatches({ logicalFileName: 'SpaceCore' }, cp)).toBe(false);
  });

  it('tags win immediately; a different tag needs another marker', () => {
    expect(referenceMatches({ tag: 'tagCP' }, cp)).toBe(true);
    expect(referenceMatches({ tag: 'other' }, cp)).toBe(false);
    expect(referenceMatches({ tag: 'other', logicalFileName: 'Content Patcher 2.5.3' }, cp)).toBe(true);
  });

  it('matches fileExpression exactly or as a glob, and refuses refs with no usable marker', () => {
    const bundle = entry('Valley Tweaks', { type: 'bundle', fileExpression: 'Valley Tweaks-1.0.0' });
    expect(referenceMatches({ fileExpression: 'Valley Tweaks-1.0.0' }, bundle)).toBe(true);
    expect(referenceMatches({ fileExpression: 'Valley Tweaks-*' }, bundle)).toBe(true);
    expect(referenceMatches({ fileExpression: 'Other-*' }, bundle)).toBe(false);
    expect(referenceMatches({ versionMatch: '1.0.0' }, bundle)).toBe(false);
    expect(referenceMatches({ repo: { repository: 'nexus', modId: '1', fileId: '1' } }, bundle)).toBe(false);
  });

  it('the fixture rule with a wrong fileMD5 does not hit Content Patcher by name', () => {
    const rule = fixture.modRules[7];
    const contentPatcher = fixture.mods[1];
    expect(rule?.reference.logicalFileName).toBe(contentPatcher?.source.logicalFilename);
    if (rule === undefined || contentPatcher === undefined) throw new Error('fixture changed');
    expect(referenceMatches(rule.reference, contentPatcher)).toBe(false);
  });
});

describe('buildPlan — fixture ordering', () => {
  const plan = buildPlan(fixture);

  it('assigns order = index, phase ascending, stable topological order', () => {
    expect(plan.map((m) => m.order)).toEqual([...Array(10).keys()]);
    expect(plan.map((m) => m.name)).toEqual([
      'SMAPI - Stardew Modding API',
      'Content Patcher',
      'Farm Type Manager (FTM)',
      'SpaceCore',
      'Stardew Valley Expanded',
      '[CP] Seasonal Outfits - Slightly Cuter Aesthetic',
      'Generic Mod Config Menu',
      'Valley Tweaks (bundled)',
      'VERY Configured',
      'Better Crafting Icons',
    ]);
  });

  it('puts the config-overrides mod after every mod it is "after" (it wins conflicts)', () => {
    const vc = byName(plan, 'VERY Configured').order;
    for (const name of ['Stardew Valley Expanded', '[CP] Seasonal Outfits - Slightly Cuter Aesthetic', 'Generic Mod Config Menu', 'Valley Tweaks (bundled)']) {
      expect(vc).toBeGreaterThan(byName(plan, name).order);
    }
  });

  it('"A before B" deploys A first even when A comes later in the file', () => {
    expect(byName(plan, 'Farm Type Manager (FTM)').order).toBeLessThan(byName(plan, 'SpaceCore').order);
  });

  it('phase beats a cross-phase before/after rule', () => {
    // fixture: SVE (phase 1) "before" Content Patcher (phase 0) — ignored
    expect(byName(plan, 'Content Patcher').order).toBeLessThan(byName(plan, 'Stardew Valley Expanded').order);
    const phases = plan.map((m) => m.phase);
    expect(phases).toEqual([...phases].sort((a, b) => a - b));
  });

  it('sets initial selection, status, warnings and copied fields', () => {
    const gmcm = byName(plan, 'Generic Mod Config Menu');
    expect(gmcm).toMatchObject({ optional: true, selected: false, status: 'skipped' });
    expect(byName(plan, 'SpaceCore')).toMatchObject({ selected: true, status: 'pending', modId: 1348, fileId: 127755, key: 'nexus:1348:127755' });
    expect(byName(plan, '[CP] Seasonal Outfits - Slightly Cuter Aesthetic').warnings).toEqual([WARN_CHOICES]);
    expect(byName(plan, 'Valley Tweaks (bundled)')).toMatchObject({ sourceType: 'bundle', key: 'bundle:Valley Tweaks-1.0.0', fileExpression: 'Valley Tweaks-1.0.0' });
    expect(byName(plan, 'Better Crafting Icons').url).toMatch(/^https:\/\/github\.com\//);
    const smapi = byName(plan, 'SMAPI - Stardew Modding API');
    expect(smapi).toMatchObject({ author: 'Pathoschild', logicalFilename: 'SMAPI 4.3.2', fileSize: 21456789, version: '4.3.2' });
    expect(smapi.instructions).toMatch(/Install SMAPI manually/);
    expect(smapi.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(plan.filter((m) => m.warnings.length > 0).map((m) => m.name)).toEqual(['[CP] Seasonal Outfits - Slightly Cuter Aesthetic']);
  });
});

describe('buildPlan — inline cases', () => {
  const ref = (name: string): CollectionModRule['source'] => ({ logicalFileName: name });
  const named = (name: string, phase = 0): CollectionModEntry =>
    entry(name, { type: 'direct', url: `https://example.com/${name}.zip`, logicalFilename: name }, { phase });

  it('breaks a cycle, keeps all mods and warns only the mods on the dropped edge', () => {
    const mods = [named('A'), named('B'), named('C'), named('D')];
    const rules: CollectionModRule[] = [
      { type: 'before', source: ref('A'), reference: ref('B') },
      { type: 'before', source: ref('B'), reference: ref('C') },
      { type: 'before', source: ref('C'), reference: ref('A') },
      { type: 'after', source: ref('D'), reference: ref('A') },
    ];
    const plan = buildPlan(collection(mods, rules));
    expect(plan.map((m) => m.name)).toEqual(['A', 'B', 'C', 'D']);
    expect(byName(plan, 'C').warnings).toEqual(['Load-order rule between "C" and "A" is part of a cycle and was ignored.']);
    expect(byName(plan, 'A').warnings).toHaveLength(1);
    expect(byName(plan, 'B').warnings).toEqual([]);
    expect(byName(plan, 'D').warnings).toEqual([]);
  });

  it('"after" rule with source earlier in the file moves it later', () => {
    const plan = buildPlan(collection([named('Config'), named('Big')], [{ type: 'after', source: ref('Config'), reference: ref('Big') }]));
    expect(plan.map((m) => m.name)).toEqual(['Big', 'Config']);
  });

  it('keeps keys unique with #n suffixes', () => {
    const dup = entry('Same', { modId: 1, fileId: 2 });
    const plan = buildPlan(collection([dup, { ...dup }, { ...dup }, entry('Hand', { type: 'manual' }), entry('Hand', { type: 'manual' })]));
    expect(plan.map((m) => m.key)).toEqual(['nexus:1:2', 'nexus:1:2#2', 'nexus:1:2#3', 'manual:Hand', 'manual:Hand#2']);
  });

  it('flags manual sources and other games, not patched mods (patches apply at install), and prefers source.instructions', () => {
    const plan = buildPlan(
      collection([
        entry('Hand', { type: 'manual', instructions: 'from source' }, { instructions: 'from entry' }),
        entry('Patched', { modId: 5, fileId: 6 }, { patches: { 'Mods/x/content.json': 1 } }),
        entry('Skyrim thing', { modId: 7, fileId: 8 }, { domainName: 'skyrimspecialedition' }),
      ]),
    );
    expect(byName(plan, 'Hand')).toMatchObject({ status: 'manual', instructions: 'from source' });
    expect(byName(plan, 'Patched').warnings).toEqual([]);
    expect(byName(plan, 'Skyrim thing').warnings[0]).toMatch(/skyrimspecialedition/);
  });

  it('carries progress over from a previous plan and resets transient statuses', () => {
    const first = buildPlan(fixture);
    const previous = first.map((m): PlannedMod => {
      if (m.name === 'Content Patcher') return { ...m, status: 'installed', installedFolders: ['ContentPatcher'] };
      if (m.name === 'SpaceCore') return { ...m, status: 'downloading', progress: { received: 1, total: 2 } };
      if (m.name === 'Generic Mod Config Menu') return { ...m, selected: true, status: 'failed', error: 'md5 mismatch' };
      if (m.name === 'Farm Type Manager (FTM)') return { ...m, status: 'skipped', selected: false };
      return m;
    });
    const next = buildPlan(fixture, previous);
    expect(byName(next, 'Content Patcher')).toMatchObject({ status: 'installed', installedFolders: ['ContentPatcher'] });
    expect(byName(next, 'SpaceCore').status).toBe('pending');
    expect(byName(next, 'SpaceCore').progress).toBeUndefined();
    expect(byName(next, 'Generic Mod Config Menu')).toMatchObject({ selected: true, status: 'failed', error: 'md5 mismatch' });
    // required mods cannot stay deselected
    expect(byName(next, 'Farm Type Manager (FTM)')).toMatchObject({ selected: true, status: 'pending' });
    expect(next.map((m) => m.order)).toEqual(first.map((m) => m.order));
  });
});

describe('buildPlan — optional mod whose pinned file changed', () => {
  const opt = (fileId: number, logicalFilename = 'X Main'): CollectionModEntry =>
    entry('X', { modId: 50, fileId, logicalFilename }, { optional: true });

  it('stays switched on (pending) when the user had turned it on and installed it', () => {
    const before = buildPlan(collection([entry('Req', { modId: 1, fileId: 10 }), opt(500)]));
    const previous = before.map((m): PlannedMod => (m.name === 'X' ? { ...m, selected: true, status: 'installed', installedFolders: ['X'] } : m));
    const next = buildPlan(collection([entry('Req', { modId: 1, fileId: 10 }), opt(501)]), previous);
    expect(byName(next, 'X')).toMatchObject({ key: 'nexus:50:501', selected: true, status: 'pending' });
    expect(byName(next, 'X').installedFolders).toBeUndefined();
  });

  it('stays off when the user never turned it on', () => {
    const previous = buildPlan(collection([opt(500)]));
    expect(byName(buildPlan(collection([opt(501)]), previous), 'X')).toMatchObject({ selected: false, status: 'skipped' });
  });

  it('matches a mod listed twice by file name, never by guesswork', () => {
    const twice = (main: number, extra: number): CollectionModEntry[] => [opt(main, 'X Main'), { ...opt(extra, 'X Extra'), name: 'X Extra' }];
    const previous = buildPlan(collection(twice(500, 600))).map((m): PlannedMod => (m.name === 'X Extra' ? { ...m, selected: true, status: 'installed' } : m));
    const next = buildPlan(collection(twice(501, 601)), previous);
    expect(byName(next, 'X')).toMatchObject({ selected: false });
    expect(byName(next, 'X Extra')).toMatchObject({ selected: true, status: 'pending' });
    const unnamed = buildPlan(collection([opt(502, 'Other A'), { ...opt(602, 'Other B'), name: 'X Extra' }]), previous);
    expect(unnamed.every((m) => !m.selected)).toBe(true);
  });
});

describe('smapiRequirement', () => {
  it('returns the SMAPI entry version', () => {
    expect(smapiRequirement(fixture)).toBe('4.3.2');
  });

  it('is undefined without a SMAPI entry', () => {
    expect(smapiRequirement(collection([entry('CP', { modId: 1915, fileId: 1 })]))).toBeUndefined();
  });
});
