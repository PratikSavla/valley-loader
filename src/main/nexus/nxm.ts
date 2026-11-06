// SPDX-License-Identifier: AGPL-3.0-only
// nxm:// link and collection URL parsing. Pure, no Electron imports.
import { GAME_DOMAIN } from '@shared/types';

export type NxmModLink = {
  kind: 'mod';
  domain: string;
  modId: number;
  fileId: number;
  key?: string;
  expires?: number;
  userId?: number;
};
export type NxmCollectionLink = {
  kind: 'collection';
  domain: string;
  slug: string;
  revision: number | 'latest';
};
export type NxmLink = NxmModLink | NxmCollectionLink;

export class NxmParseError extends Error {
  override name = 'NxmParseError';
}

const SLUG_RE = /^[a-z0-9_-]{1,64}$/i;
const NEXUS_HOSTS = new Set(['nexusmods.com', 'www.nexusmods.com', 'next.nexusmods.com']);
const EXAMPLE_LINK = 'https://www.nexusmods.com/games/stardewvalley/collections/tckf0m';

/** Friendly message for links that belong to another game. */
export function otherGameMessage(domain: string): string {
  return `This link is for ${domain}; Valley Loader only supports Stardew Valley collections`;
}

function parsePositiveInt(raw: string | undefined | null, what: string): number {
  if (raw === undefined || raw === null || !/^\d+$/.test(raw)) {
    throw new NxmParseError(`Invalid ${what} "${raw ?? ''}" in nxm link`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new NxmParseError(`Invalid ${what} "${raw}" in nxm link`);
  }
  return value;
}

function optionalInt(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) throw new NxmParseError(`Invalid ${name} "${raw}" in nxm link`);
  return Number(raw);
}

function splitPath(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((s) => s !== '')
    .map((s) => decodeURIComponent(s));
}

function parseRevision(segment: string | undefined): number | 'latest' {
  if (segment === undefined || segment.toLowerCase() === 'latest') return 'latest';
  return parsePositiveInt(segment, 'revision');
}

function parseModPath(domain: string, segs: string[], params: URLSearchParams): NxmModLink {
  if (segs.length !== 4 || segs[2]?.toLowerCase() !== 'files') {
    throw new NxmParseError('nxm mod link must look like nxm://<game>/mods/<modId>/files/<fileId>');
  }
  const key = params.get('key');
  const link: NxmModLink = {
    kind: 'mod',
    domain,
    modId: parsePositiveInt(segs[1], 'mod id'),
    fileId: parsePositiveInt(segs[3], 'file id'),
  };
  if (key !== null && key !== '') link.key = key;
  const expires = optionalInt(params, 'expires');
  if (expires !== undefined) link.expires = expires;
  const userId = optionalInt(params, 'user_id');
  if (userId !== undefined) link.userId = userId;
  return link;
}

function parseCollectionPath(domain: string, segs: string[]): NxmCollectionLink {
  const slug = segs[1];
  if (slug === undefined || !SLUG_RE.test(slug)) {
    throw new NxmParseError(`Invalid collection slug "${slug ?? ''}" in nxm link`);
  }
  if (segs.length > 2 && segs[2]?.toLowerCase() !== 'revisions') {
    throw new NxmParseError('nxm collection link must look like nxm://<game>/collections/<slug>/revisions/<n>');
  }
  if (segs.length > 4) throw new NxmParseError('Unexpected extra path in nxm collection link');
  return { kind: 'collection', domain, slug, revision: parseRevision(segs[3]) };
}

/** Parse an nxm:// URL. Throws NxmParseError on anything malformed. Domain is lowercased; any game is accepted here. */
export function parseNxm(url: string): NxmLink {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch (err) {
    throw new NxmParseError(`Not a valid nxm link: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.protocol.toLowerCase() !== 'nxm:') {
    throw new NxmParseError(`Expected an nxm:// link, got "${parsed.protocol}"`);
  }
  const domain = parsed.hostname.toLowerCase();
  if (domain === '') throw new NxmParseError('nxm link is missing the game name');
  const segs = splitPath(parsed.pathname);
  const kind = segs[0]?.toLowerCase();
  if (kind === 'mods') return parseModPath(domain, segs, parsed.searchParams);
  if (kind === 'collections') return parseCollectionPath(domain, segs);
  throw new NxmParseError('nxm link must point to a mod file or a collection');
}

export type LinkCheck = { ok: true } | { ok: false; reason: string };

/**
 * Reject links for another game, links missing key/expires, expired links (expires is unix seconds,
 * expired when expires <= nowSeconds), or links for another user (only when both user ids are known).
 */
export function validateModLink(
  link: NxmModLink,
  opts: { expectedUserId?: number; nowSeconds: number },
): LinkCheck {
  if (link.domain !== GAME_DOMAIN) return { ok: false, reason: otherGameMessage(link.domain) };
  if (link.key === undefined || link.expires === undefined) {
    return {
      ok: false,
      reason: 'This link has no download key — open the file page and click Slow download',
    };
  }
  if (link.expires <= opts.nowSeconds) {
    return {
      ok: false,
      reason: 'This download link has expired — open the file page and click Slow download again',
    };
  }
  if (opts.expectedUserId !== undefined && link.userId !== undefined && link.userId !== opts.expectedUserId) {
    return {
      ok: false,
      reason:
        'This download link belongs to a different Nexus account — sign in to nexusmods.com with the same account as your API key',
    };
  }
  return { ok: true };
}

type CollectionRef = { domain: string; slug: string; revision?: number };

function checkDomain(domain: string): string {
  const lower = domain.toLowerCase();
  if (lower !== GAME_DOMAIN) throw new Error(otherGameMessage(lower));
  return lower;
}

function fromNxm(input: string): CollectionRef {
  let link: NxmLink;
  try {
    link = parseNxm(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`That nxm link could not be read (${msg}). Paste a collection link like ${EXAMPLE_LINK}`, {
      cause: err,
    });
  }
  const domain = checkDomain(link.domain);
  if (link.kind === 'mod') {
    throw new Error(`That is a single mod file link, not a collection. Paste a collection link like ${EXAMPLE_LINK}`);
  }
  return link.revision === 'latest' ? { domain, slug: link.slug } : { domain, slug: link.slug, revision: link.revision };
}

function fromWebUrl(url: URL): CollectionRef | undefined {
  if (!NEXUS_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  const segs = splitPath(url.pathname);
  const idx = segs.findIndex((s) => s.toLowerCase() === 'collections');
  const rawDomain = idx > 0 ? segs[idx - 1] : undefined;
  const slug = segs[idx + 1];
  if (rawDomain === undefined || slug === undefined || !SLUG_RE.test(slug)) return undefined;
  const domain = checkDomain(rawDomain);
  if (segs[idx + 2]?.toLowerCase() === 'revisions') {
    const rev = segs[idx + 3];
    if (rev !== undefined && /^\d+$/.test(rev) && Number(rev) > 0) return { domain, slug, revision: Number(rev) };
  }
  return { domain, slug };
}

function unrecognised(cause?: unknown): Error {
  return new Error(
    `That doesn't look like a Nexus Mods collection link. Paste a link like ${EXAMPLE_LINK} or just the collection id (e.g. tckf0m)`,
    { cause },
  );
}

/**
 * Accepts: https://www.nexusmods.com/games/stardewvalley/collections/tckf0m,
 * https://next.nexusmods.com/stardewvalley/collections/tckf0m, .../revisions/12, ?tab=mods,
 * nxm://stardewvalley/collections/tckf0m/revisions/114, or a bare slug "tckf0m".
 * Also accepts http://, a missing scheme ("nexusmods.com/..."), trailing slashes and uppercase hosts.
 * `revision` is omitted for "latest". Throws Error with a user-friendly message for other games / unrecognised input.
 */
export function parseCollectionInput(input: string): CollectionRef {
  const text = input.trim();
  if (text === '') throw new Error(`Paste a collection link first, e.g. ${EXAMPLE_LINK}`);
  if (/^nxm:\/\//i.test(text)) return fromNxm(text);
  if (SLUG_RE.test(text)) return { domain: GAME_DOMAIN, slug: text };
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch (err) {
    throw unrecognised(err);
  }
  const ref = fromWebUrl(url);
  if (ref === undefined) throw unrecognised();
  return ref;
}

/** Website page where a free user can click "Slow download" for one file. */
export function nexusFilePageUrl(domain: string, modId: number, fileId: number): string {
  return `https://www.nexusmods.com/${encodeURIComponent(domain)}/mods/${modId}?tab=files&file_id=${fileId}&nmm=1`;
}
