// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { GRAPHQL_URL, NexusApiError, NexusClient } from '../src/main/nexus/api';

// Canned bodies shaped like the real public GraphQL responses for tckf0m (trimmed).
const COLLECTION = {
  slug: 'tckf0m',
  name: 'Stardew Valley VERY Expanded',
  summary: 'Built for both online co-op play and experienced solo players.',
  user: { name: 'JennaJuffuffles' },
  tileImage: { url: 'https://media.nexusmods.com/1/3/tile.webp' },
};
const REVISION = {
  revisionNumber: 114,
  downloadLink: '/v2/collections/994/revisions/802199/download_link',
  totalSize: '464703554',
  adultContent: false,
  modCount: 105,
};
const MOD_FILES = [
  {
    fileId: 188857,
    optional: false,
    version: '2.0.114',
    file: {
      modId: 20870,
      name: 'VERY Configured Stardew Valley VERY Expanded',
      version: '2.0.114',
      sizeInBytes: '28359',
      mod: { name: 'Stardew Valley VERY Configured (1.6)' },
    },
  },
  {
    fileId: 120871,
    optional: true,
    version: '1.4.0',
    file: { modId: 5735, name: 'Animated Fish', version: null, sizeInBytes: null, mod: { name: 'Animated Fish' } },
  },
  { fileId: 999, optional: false, version: '1.0', file: null },
];

function graphqlFetch(body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function sentBody(call: { init: RequestInit } | undefined): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(String(call?.init.body)) as { query: string; variables: Record<string, unknown> };
}

const EXPECTED_SUMMARY = {
  slug: 'tckf0m',
  revision: 114,
  name: 'Stardew Valley VERY Expanded',
  author: 'JennaJuffuffles',
  summary: 'Built for both online co-op play and experienced solo players.',
  tileImageUrl: 'https://media.nexusmods.com/1/3/tile.webp',
  totalSize: 464703554,
  modCount: 105,
  adultContent: false,
  downloadLinkPath: '/v2/collections/994/revisions/802199/download_link',
};

describe('GraphQL collection lookup', () => {
  it('latest revision: POSTs the collection query and maps the summary', async () => {
    const { fetchImpl, calls } = graphqlFetch({ data: { collection: { ...COLLECTION, latestPublishedRevision: REVISION } } });
    const summary = await new NexusClient({ fetchImpl }).getCollection('tckf0m');
    expect(summary).toEqual(EXPECTED_SUMMARY);
    expect(calls[0]?.url).toBe(GRAPHQL_URL);
    expect(calls[0]?.init.method).toBe('POST');
    const sent = sentBody(calls[0]);
    expect(sent.query).toContain('collection(slug: $slug, domainName: $domain, viewAdultContent: true)');
    expect(sent.query).toContain('latestPublishedRevision');
    expect(sent.variables).toEqual({ slug: 'tckf0m', domain: 'stardewvalley' });
  });

  it('explicit revision: uses collectionRevision with an Int revision', async () => {
    const { fetchImpl, calls } = graphqlFetch({ data: { collectionRevision: { ...REVISION, collection: COLLECTION } } });
    const summary = await new NexusClient({ fetchImpl }).getCollection('tckf0m', 114);
    expect(summary).toEqual(EXPECTED_SUMMARY);
    const sent = sentBody(calls[0]);
    expect(sent.query).toContain('collectionRevision(slug: $slug, revision: $revision');
    expect(sent.variables).toEqual({ slug: 'tckf0m', revision: 114, domain: 'stardewvalley' });
  });

  it('omits empty summary / missing tile image / missing user gracefully', async () => {
    const col = { ...COLLECTION, summary: '', tileImage: null, user: null };
    const { fetchImpl } = graphqlFetch({ data: { collection: { ...col, latestPublishedRevision: REVISION } } });
    const summary = await new NexusClient({ fetchImpl }).getCollection('tckf0m');
    expect(summary.summary).toBeUndefined();
    expect(summary.tileImageUrl).toBeUndefined();
    expect(summary.author).toBe('Unknown curator');
  });

  it('GraphQL NOT_FOUND errors become a friendly 404 NexusApiError', async () => {
    const { fetchImpl } = graphqlFetch({
      errors: [{ message: 'Collection not found', extensions: { code: 'NOT_FOUND' } }],
      data: null,
    });
    const err = await new NexusClient({ fetchImpl }).getCollection('nope99').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NexusApiError);
    expect((err as NexusApiError).status).toBe(404);
    expect((err as NexusApiError).message).toMatch(/collection "nope99" was not found.*Collection not found/);
  });

  it('other GraphQL errors surface the server message', async () => {
    const { fetchImpl } = graphqlFetch({ errors: [{ message: "Field 'x' doesn't exist" }] });
    await expect(new NexusClient({ fetchImpl }).getCollection('tckf0m', 3)).rejects.toThrow(
      "Nexus GraphQL error: Field 'x' doesn't exist",
    );
  });

  it('a collection with no published revision is reported', async () => {
    const { fetchImpl } = graphqlFetch({ data: { collection: { ...COLLECTION, latestPublishedRevision: null } } });
    await expect(new NexusClient({ fetchImpl }).getCollection('tckf0m')).rejects.toThrow(/no published revision/);
  });

  it('unexpected shapes are rejected with the failing path', async () => {
    const { fetchImpl } = graphqlFetch({ data: { collection: { ...COLLECTION, latestPublishedRevision: { ...REVISION, totalSize: 'big' } } } });
    await expect(new NexusClient({ fetchImpl }).getCollection('tckf0m')).rejects.toThrow(/unexpected GraphQL response.*totalSize/);
  });
});

describe('GraphQL revision mod files', () => {
  it('maps modFiles, falls back to the revision version and skips deleted files with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fetchImpl, calls } = graphqlFetch({ data: { collectionRevision: { modFiles: MOD_FILES } } });
    const { files, missingFileIds } = await new NexusClient({ fetchImpl }).getRevisionModFiles('tckf0m', 114);
    expect(missingFileIds).toEqual([999]);
    expect(files).toEqual([
      {
        fileId: 188857,
        modId: 20870,
        optional: false,
        name: 'VERY Configured Stardew Valley VERY Expanded',
        version: '2.0.114',
        modName: 'Stardew Valley VERY Configured (1.6)',
        sizeInBytes: 28359,
      },
      { fileId: 120871, modId: 5735, optional: true, name: 'Animated Fish', version: '1.4.0', modName: 'Animated Fish' },
    ]);
    expect(sentBody(calls[0]).variables).toEqual({ slug: 'tckf0m', revision: 114, domain: 'stardewvalley' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('999'));
    warn.mockRestore();
  });

  it('rejects a non-positive revision without calling the API', async () => {
    const { fetchImpl, calls } = graphqlFetch({});
    await expect(new NexusClient({ fetchImpl }).getRevisionModFiles('tckf0m', 0)).rejects.toThrow(/Invalid revision/);
    expect(calls).toHaveLength(0);
  });
});

describe.skipIf(!process.env.NEXUS_LIVE)('live public GraphQL', () => {
  it('resolves tckf0m', async () => {
    const client = new NexusClient({});
    const summary = await client.getCollection('tckf0m');
    expect(summary.name).toBe('Stardew Valley VERY Expanded');
    expect(summary.downloadLinkPath).toMatch(/^\/v2\/collections\/\d+\/revisions\/\d+\/download_link$/);
    const { files } = await client.getRevisionModFiles('tckf0m', summary.revision);
    expect(files.length).toBeGreaterThan(50);
  });
});
