// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatIssuePath, parseCollectionJson } from '../src/main/collection/schema';

const fixtureText = readFileSync(resolve(__dirname, 'fixtures/collection.json'), 'utf8');

function minimal(overrides: Record<string, unknown> = {}, mod: Record<string, unknown> = {}): string {
  return JSON.stringify({
    info: { name: 'Tiny', domainName: 'stardewvalley' },
    mods: [{ name: 'Content Patcher', version: '2.5.3', source: { type: 'nexus', modId: 1915, fileId: 1 }, ...mod }],
    ...overrides,
  });
}

describe('parseCollectionJson — fixture', () => {
  const parsed = parseCollectionJson(fixtureText);

  it('reads info, every mod and every rule', () => {
    expect(parsed.info.name).toBe('Stardew Valley VERY Expanded (fixture)');
    expect(parsed.info.domainName).toBe('stardewvalley');
    expect(parsed.info.gameVersions).toEqual(['1.6.15']);
    expect(parsed.mods).toHaveLength(10);
    expect(parsed.modRules).toHaveLength(8);
    expect(parsed.mods.map((m) => m.source.type)).toEqual([
      'nexus', 'nexus', 'nexus', 'nexus', 'nexus', 'nexus', 'nexus', 'nexus', 'bundle', 'direct',
    ]);
  });

  it('coerces numeric-string mod/file ids to numbers', () => {
    const spaceCore = parsed.mods.find((m) => m.name === 'SpaceCore');
    expect(spaceCore?.source.modId).toBe(1348);
    expect(spaceCore?.source.fileId).toBe(127755);
  });

  it('keeps unknown keys (loose objects)', () => {
    const raw = parsed as unknown as Record<string, unknown>;
    expect(raw['unknownTopLevel']).toEqual({ keep: true });
    expect(parsed.collectionConfig).toEqual({ recommendNewProfile: true });
    expect(parsed.mods[0]?.details?.category).toBe('Modding Tools');
  });

  it('keeps choices and optional flags as authored', () => {
    const outfits = parsed.mods.find((m) => m.source.modId === 5450);
    expect(outfits?.choices).toMatchObject({ type: 'fomod' });
    expect(parsed.mods.filter((m) => m.optional).map((m) => m.name)).toEqual(['Generic Mod Config Menu']);
  });
});

describe('parseCollectionJson — defaults and coercion', () => {
  it('defaults optional=false, phase=0, modRules=[] and domainName from info', () => {
    const c = parseCollectionJson(minimal());
    expect(c.modRules).toEqual([]);
    expect(c.mods[0]).toMatchObject({ optional: false, phase: 0, domainName: 'stardewvalley' });
  });

  it('coerces fileSize and phase strings, numeric versions, and repo ids to strings', () => {
    const c = parseCollectionJson(
      minimal(
        {
          modRules: [
            { type: 'after', source: { repo: { repository: 'nexus', modId: 1915, fileId: '7' } }, reference: { fileMD5: 'abc' } },
          ],
        },
        { version: 2, phase: '3', source: { type: 'nexus', modId: '1915', fileId: '9', fileSize: '1024' } },
      ),
    );
    expect(c.mods[0]).toMatchObject({ version: '2', phase: 3 });
    expect(c.mods[0]?.source).toMatchObject({ modId: 1915, fileId: 9, fileSize: 1024 });
    expect(c.modRules[0]?.source.repo).toEqual({ repository: 'nexus', modId: '1915', fileId: '7' });
  });

  it('strips a UTF-8 BOM', () => {
    const c = parseCollectionJson(`${String.fromCharCode(0xfeff)}${minimal()}`);
    expect(c.info.name).toBe('Tiny');
  });

  it('treats null properties as absent', () => {
    const c = parseCollectionJson(minimal({}, { author: null, optional: null }));
    expect(c.mods[0]?.author).toBeUndefined();
    expect(c.mods[0]?.optional).toBe(false);
  });
});

describe('parseCollectionJson — error messages', () => {
  it('reports malformed JSON clearly', () => {
    expect(() => parseCollectionJson('{"info": ')).toThrow(/collection\.json is not valid JSON/);
  });

  it('points at the bad source type with an indexed path', () => {
    const text = minimal({}, { source: { type: 'torrent' } });
    expect(() => parseCollectionJson(text)).toThrow(/collection\.json is invalid: mods\[0\]\.source\.type: /);
  });

  it('rejects non-numeric mod ids', () => {
    const text = minimal({}, { source: { type: 'nexus', modId: 'abc', fileId: 1 } });
    expect(() => parseCollectionJson(text)).toThrow(/mods\[0\]\.source\.modId: /);
  });

  it('requires info.domainName', () => {
    const text = JSON.stringify({ info: { name: 'x' }, mods: [] });
    expect(() => parseCollectionJson(text)).toThrow(/info\.domainName: /);
  });

  it('lists several problems at once', () => {
    const text = JSON.stringify({ info: { domainName: 'stardewvalley' }, mods: [{ version: '1', source: {} }] });
    let message = '';
    try {
      parseCollectionJson(text);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('info.name');
    expect(message).toContain('mods[0].name');
    expect(message).toContain('mods[0].source.type');
  });

  it('labels root-level type errors', () => {
    expect(() => parseCollectionJson('[]')).toThrow(/\(root\): /);
  });

  it('formats paths with indices and dots', () => {
    expect(formatIssuePath(['mods', 3, 'source', 'type'])).toBe('mods[3].source.type');
    expect(formatIssuePath([])).toBe('(root)');
  });
});
