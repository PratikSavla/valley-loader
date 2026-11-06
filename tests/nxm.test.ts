// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  NxmParseError,
  nexusFilePageUrl,
  parseCollectionInput,
  parseNxm,
  validateModLink,
  type NxmModLink,
} from '../src/main/nexus/nxm';

describe('parseNxm', () => {
  it('parses a mod file link with key, expires and user_id, ignoring tracking params', () => {
    const link = parseNxm(
      'nxm://stardewvalley/mods/20870/files/188857?key=abcDEF123&expires=1767225600&user_id=4242&campaign=x&placement=y&position=3',
    );
    expect(link).toEqual({
      kind: 'mod',
      domain: 'stardewvalley',
      modId: 20870,
      fileId: 188857,
      key: 'abcDEF123',
      expires: 1767225600,
      userId: 4242,
    });
  });

  it('parses a mod link without query and lowercases an uppercase host', () => {
    const link = parseNxm('NXM://StardewValley/mods/1/files/2');
    expect(link).toEqual({ kind: 'mod', domain: 'stardewvalley', modId: 1, fileId: 2 });
  });

  it('parses collection links with numeric and latest revisions', () => {
    expect(parseNxm('nxm://stardewvalley/collections/tckf0m/revisions/114')).toEqual({
      kind: 'collection',
      domain: 'stardewvalley',
      slug: 'tckf0m',
      revision: 114,
    });
    expect(parseNxm('nxm://stardewvalley/collections/tckf0m/revisions/latest')).toMatchObject({ revision: 'latest' });
    expect(parseNxm('nxm://stardewvalley/collections/tckf0m/')).toMatchObject({ slug: 'tckf0m', revision: 'latest' });
  });

  it('keeps the domain of other games (callers decide)', () => {
    expect(parseNxm('nxm://skyrimspecialedition/mods/3/files/4')).toMatchObject({ domain: 'skyrimspecialedition' });
  });

  it.each([
    ['not a url', 'garbage'],
    ['wrong scheme', 'https://stardewvalley/mods/1/files/2'],
    ['non-numeric mod id', 'nxm://stardewvalley/mods/abc/files/2'],
    ['zero file id', 'nxm://stardewvalley/mods/1/files/0'],
    ['missing files segment', 'nxm://stardewvalley/mods/1'],
    ['bad expires', 'nxm://stardewvalley/mods/1/files/2?key=k&expires=soon'],
    ['bad user id', 'nxm://stardewvalley/mods/1/files/2?user_id=-5'],
    ['unknown kind', 'nxm://stardewvalley/images/1'],
    ['bad revision', 'nxm://stardewvalley/collections/tckf0m/revisions/abc'],
    ['bad slug', 'nxm://stardewvalley/collections/bad$slug/revisions/1'],
  ])('throws NxmParseError for %s', (_label, url) => {
    expect(() => parseNxm(url)).toThrow(NxmParseError);
  });
});

describe('validateModLink', () => {
  const base: NxmModLink = {
    kind: 'mod',
    domain: 'stardewvalley',
    modId: 1,
    fileId: 2,
    key: 'k',
    expires: 2000,
    userId: 7,
  };

  it('accepts a valid, unexpired link for the right user', () => {
    expect(validateModLink(base, { expectedUserId: 7, nowSeconds: 1000 })).toEqual({ ok: true });
  });

  it('rejects links missing key or expires and tells the user to click Slow download', () => {
    const noKey = validateModLink({ ...base, key: undefined }, { nowSeconds: 1000 });
    const noExpires = validateModLink({ ...base, expires: undefined }, { nowSeconds: 1000 });
    expect(noKey.ok).toBe(false);
    expect(noExpires.ok).toBe(false);
    if (!noKey.ok) expect(noKey.reason).toMatch(/click Slow download/);
  });

  it('rejects expired links (expires <= now)', () => {
    const atExpiry = validateModLink(base, { nowSeconds: 2000 });
    expect(atExpiry.ok).toBe(false);
    if (!atExpiry.ok) expect(atExpiry.reason).toMatch(/expired/);
    expect(validateModLink(base, { nowSeconds: 1999 }).ok).toBe(true);
  });

  it('rejects a user mismatch only when both ids are known', () => {
    const mismatch = validateModLink(base, { expectedUserId: 8, nowSeconds: 1000 });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reason).toMatch(/different Nexus account/);
    expect(validateModLink({ ...base, userId: undefined }, { expectedUserId: 8, nowSeconds: 1000 }).ok).toBe(true);
    expect(validateModLink(base, { nowSeconds: 1000 }).ok).toBe(true);
  });

  it('rejects links for another game', () => {
    const res = validateModLink({ ...base, domain: 'skyrim' }, { nowSeconds: 1000 });
    expect(res).toEqual({
      ok: false,
      reason: 'This link is for skyrim; Valley Loader only supports Stardew Valley collections',
    });
  });
});

describe('parseCollectionInput', () => {
  const sdv = { domain: 'stardewvalley', slug: 'tckf0m' };

  it.each([
    ['https://www.nexusmods.com/games/stardewvalley/collections/tckf0m', sdv],
    ['https://next.nexusmods.com/stardewvalley/collections/tckf0m', sdv],
    ['https://www.nexusmods.com/games/stardewvalley/collections/tckf0m/', sdv],
    ['https://www.nexusmods.com/games/stardewvalley/collections/tckf0m?tab=mods', sdv],
    ['https://www.nexusmods.com/games/stardewvalley/collections/tckf0m/mods', sdv],
    ['http://WWW.NEXUSMODS.COM/games/stardewvalley/collections/tckf0m', sdv],
    ['www.nexusmods.com/games/stardewvalley/collections/tckf0m', sdv],
    ['  tckf0m  ', sdv],
    ['https://www.nexusmods.com/games/stardewvalley/collections/tckf0m/revisions/12', { ...sdv, revision: 12 }],
    ['https://next.nexusmods.com/stardewvalley/collections/tckf0m/revisions/12/?tab=mods', { ...sdv, revision: 12 }],
    ['nxm://stardewvalley/collections/tckf0m/revisions/114', { ...sdv, revision: 114 }],
    ['nxm://STARDEWVALLEY/collections/tckf0m/revisions/latest', sdv],
  ])('accepts %s', (input, expected) => {
    expect(parseCollectionInput(input)).toEqual(expected);
  });

  it.each([
    'https://www.nexusmods.com/games/skyrimspecialedition/collections/abc123',
    'https://next.nexusmods.com/cyberpunk2077/collections/abc123/revisions/2',
    'nxm://skyrimspecialedition/collections/abc123/revisions/1',
  ])('rejects other games with a friendly message: %s', (input) => {
    expect(() => parseCollectionInput(input)).toThrow(/^This link is for \w+; Valley Loader only supports Stardew Valley collections$/);
  });

  it.each([
    ['empty input', '   ', /Paste a collection link/],
    ['mod page', 'https://www.nexusmods.com/stardewvalley/mods/2400', /doesn't look like a Nexus Mods collection/],
    ['other site', 'https://example.com/stardewvalley/collections/tckf0m', /doesn't look like/],
    ['nxm mod link', 'nxm://stardewvalley/mods/1/files/2?key=a&expires=1', /single mod file link/],
    ['broken nxm', 'nxm://stardewvalley/collections/', /could not be read/],
    ['sentence', 'please install this', /doesn't look like/],
  ])('rejects %s', (_label, input, message) => {
    expect(() => parseCollectionInput(input)).toThrow(message);
  });
});

describe('nexusFilePageUrl', () => {
  it('builds the Slow download page URL', () => {
    expect(nexusFilePageUrl('stardewvalley', 20870, 188857)).toBe(
      'https://www.nexusmods.com/stardewvalley/mods/20870?tab=files&file_id=188857&nmm=1',
    );
  });
});
