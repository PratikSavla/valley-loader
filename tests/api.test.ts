// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { NexusApiError, NexusClient } from '../src/main/nexus/api';

const KEY = 'secret-api-key-123';

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> } | Error>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next === undefined) throw new Error('mockFetch: no response configured');
    if (next instanceof Error) throw next;
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(body, { status: next.status ?? 200, headers: next.headers });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function headersOf(call: Call | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

async function rejection(promise: Promise<unknown>): Promise<NexusApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof NexusApiError) return err;
    throw err;
  }
  throw new Error('expected a NexusApiError rejection');
}

const VALIDATE_BODY = {
  user_id: 4242,
  key: KEY,
  name: 'Farmer',
  email: 'farmer@example.com',
  is_premium: false,
  is_supporter: true,
  profile_url: 'https://avatars.nexusmods.com/4242/100',
};

describe('NexusClient headers and validate()', () => {
  it('sends all required headers and maps the user without key/email', async () => {
    const { fetchImpl, calls } = mockFetch([{ body: VALIDATE_BODY }]);
    const client = new NexusClient({ apiKey: KEY, fetchImpl, appVersion: '1.2.3' });
    const user = await client.validate();

    expect(user).toEqual({
      userId: 4242,
      name: 'Farmer',
      isPremium: false,
      isSupporter: true,
      avatarUrl: 'https://avatars.nexusmods.com/4242/100',
    });
    expect(JSON.stringify(user)).not.toContain(KEY);
    expect(JSON.stringify(user)).not.toContain('farmer@example.com');
    expect(calls[0]?.url).toBe('https://api.nexusmods.com/v1/users/validate.json');
    const h = headersOf(calls[0]);
    expect(h.apikey).toBe(KEY);
    expect(h['Application-Name']).toBe('Valley Loader');
    expect(h['Application-Version']).toBe('1.2.3');
    expect(h['Protocol-Version']).toBe('1.0.0');
    expect(h.Accept).toBe('application/json');
    expect(h['User-Agent']).toMatch(/^ValleyLoader\/1\.2\.3 \(macOS [^;]+; \w+\) Node\/\d+/);
  });

  it('accepts the legacy "is_premium?" field names', async () => {
    const { fetchImpl } = mockFetch([{ body: { user_id: 1, name: 'A', 'is_premium?': true, 'is_supporter?': false } }]);
    const user = await new NexusClient({ apiKey: KEY, fetchImpl }).validate();
    expect(user.isPremium).toBe(true);
    expect(user.avatarUrl).toBeUndefined();
  });

  it('refuses validate() without a key and never calls fetch', async () => {
    const { fetchImpl, calls } = mockFetch([{ body: VALIDATE_BODY }]);
    const err = await rejection(new NexusClient({ fetchImpl }).validate());
    expect(err.message).toMatch(/API key/);
    expect(calls).toHaveLength(0);
  });

  it('omits the apikey header when no key is set (public GraphQL) and defaults the version', async () => {
    const { fetchImpl, calls } = mockFetch([{ body: { data: { collection: null } } }]);
    await rejection(new NexusClient({ fetchImpl }).getCollection('tckf0m'));
    const h = headersOf(calls[0]);
    expect('apikey' in h).toBe(false);
    expect(h['Application-Version']).toBe('0.1.0');
    expect(h['Content-Type']).toBe('application/json');
  });

  it('tracks X-RL rate-limit headers', async () => {
    const { fetchImpl } = mockFetch([
      { body: VALIDATE_BODY, headers: { 'X-RL-Daily-Remaining': '19990', 'X-RL-Hourly-Remaining': '499' } },
      { body: VALIDATE_BODY, headers: { 'X-RL-Hourly-Remaining': '498' } },
    ]);
    const client = new NexusClient({ apiKey: KEY, fetchImpl });
    await client.validate();
    expect(client.rateLimit).toEqual({ daily: 19990, hourly: 499 });
    await client.validate();
    expect(client.rateLimit).toEqual({ daily: 19990, hourly: 498 });
  });
});

describe('NexusClient error mapping', () => {
  const run = async (status: number, body: unknown, headers?: Record<string, string>) => {
    const { fetchImpl } = mockFetch([{ status, body, headers }]);
    return rejection(new NexusClient({ apiKey: KEY, fetchImpl }).validate());
  };

  it('401 → paste a new key', async () => {
    const err = await run(401, { message: 'Please provide a valid API Key' });
    expect(err.status).toBe(401);
    expect(err.message).toBe('Nexus rejected the API key — paste a new one in Settings');
  });

  it('403 → Premium needed, includes the server message', async () => {
    const err = await run(403, { message: 'You don\'t have permission to get download links' });
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/needs Premium.*click Slow download/);
    expect(err.message).toContain("You don't have permission to get download links");
  });

  it('404 and 410 have their own messages', async () => {
    expect((await run(404, { message: 'No File found' })).message).toMatch(/could not find.*No File found/);
    expect((await run(410, '')).message).toMatch(/expired/);
  });

  it('429 → rate limit message with remaining counters', async () => {
    const err = await run(429, { message: 'Too many' }, { 'X-RL-Daily-Remaining': '0', 'X-RL-Hourly-Remaining': '0' });
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/rate limit.*daily remaining: 0, hourly remaining: 0/);
  });

  it('other statuses include status and a body snippet but never the API key', async () => {
    const err = await run(500, `internal failure for key ${KEY} ${'x'.repeat(500)}`);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/^Nexus API error 500/);
    expect(err.message).toContain('internal failure');
    expect(err.message).not.toContain(KEY);
    expect(err.message.length).toBeLessThan(400);
  });

  it('wraps network failures with context', async () => {
    const { fetchImpl } = mockFetch([new TypeError('fetch failed')]);
    const err = await rejection(new NexusClient({ apiKey: KEY, fetchImpl }).validate());
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Could not reach Nexus Mods.*fetch failed/);
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it('rejects malformed JSON payloads', async () => {
    const err = await run(200, '<html>maintenance</html>');
    expect(err.message).toMatch(/not JSON/);
  });
});

describe('download links', () => {
  it('builds the mod file URL with key/expires and returns the first URI', async () => {
    const { fetchImpl, calls } = mockFetch([
      { body: [{ name: 'Nexus CDN', short_name: 'CDN', URI: 'https://cdn.example/a.zip' }, { URI: 'https://b' }] },
    ]);
    const client = new NexusClient({ apiKey: KEY, fetchImpl });
    const uri = await client.getModFileDownloadUrl({ domain: 'stardewvalley', modId: 20870, fileId: 188857, key: 'k1', expires: 99 });
    expect(uri).toBe('https://cdn.example/a.zip');
    expect(calls[0]?.url).toBe(
      'https://api.nexusmods.com/v1/games/stardewvalley/mods/20870/files/188857/download_link.json?key=k1&expires=99',
    );
    expect(calls[0]?.url).not.toContain(KEY);
  });

  it('omits the query for premium (no key/expires) and errors on an empty list', async () => {
    const { fetchImpl, calls } = mockFetch([{ body: [] }]);
    const err = await rejection(
      new NexusClient({ apiKey: KEY, fetchImpl }).getModFileDownloadUrl({ domain: 'stardewvalley', modId: 1, fileId: 2 }),
    );
    expect(calls[0]?.url).toBe('https://api.nexusmods.com/v1/games/stardewvalley/mods/1/files/2/download_link.json');
    expect(err.message).toMatch(/no download servers/);
  });

  it('download error URLs drop the download key', async () => {
    const { fetchImpl } = mockFetch([{ status: 410, body: '' }]);
    const err = await rejection(
      new NexusClient({ apiKey: KEY, fetchImpl }).getModFileDownloadUrl({
        domain: 'stardewvalley', modId: 1, fileId: 2, key: 'dlkey', expires: 5,
      }),
    );
    expect(err.status).toBe(410);
    expect(err.url).not.toContain('dlkey');
  });

  it.each([
    ['array', [{ URI: 'https://cdn/x.7z' }]],
    ['download_links', { download_links: [{ URI: 'https://cdn/x.7z' }] }],
    ['download_link string', { download_link: 'https://cdn/x.7z' }],
    ['download_link object', { download_link: { URI: 'https://cdn/x.7z' } }],
  ])('collection archive URL from %s shape', async (_label, body) => {
    const { fetchImpl, calls } = mockFetch([{ body }]);
    const client = new NexusClient({ apiKey: KEY, fetchImpl });
    expect(await client.getCollectionArchiveUrl('/v2/collections/994/revisions/802199/download_link')).toBe('https://cdn/x.7z');
    expect(calls[0]?.url).toBe('https://api.nexusmods.com/v2/collections/994/revisions/802199/download_link');
    expect(headersOf(calls[0]).apikey).toBe(KEY);
  });

  it('collection archive: no URI → NexusApiError; foreign host → refused without fetching', async () => {
    const { fetchImpl, calls } = mockFetch([{ body: { something: 'else' } }]);
    const client = new NexusClient({ apiKey: KEY, fetchImpl });
    const err = await rejection(client.getCollectionArchiveUrl('/v2/collections/1/revisions/2/download_link'));
    expect(err.message).toMatch(/unexpected collection download link/);
    await expect(client.getCollectionArchiveUrl('https://evil.example/steal')).rejects.toThrow(/Refusing to send the API key/);
    expect(calls).toHaveLength(1);
  });
});
