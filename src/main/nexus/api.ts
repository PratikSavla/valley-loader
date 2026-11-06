// SPDX-License-Identifier: AGPL-3.0-only
// Nexus Mods REST v1 + GraphQL v2 client. Pure (injectable fetch), no Electron imports.
import { z } from 'zod';
import { GAME_DOMAIN, type CollectionSummary, type NexusUser } from '@shared/types';
import {
  NexusApiError,
  buildHeaders,
  httpError,
  networkError,
  redactUrl,
  trackRateLimit,
  type RateLimit,
} from './api-http';
import {
  LATEST_QUERY,
  MOD_FILES_QUERY,
  REVISION_QUERY,
  graphqlEnvelopeSchema,
  latestResponseSchema,
  modFilesResponseSchema,
  revisionResponseSchema,
  toModFiles,
  toSummary,
  type RevisionModFiles,
} from './api-graphql';

export { NexusApiError, type RateLimit } from './api-http';
export type { RevisionModFile, RevisionModFiles } from './api-graphql';

export const API_BASE = 'https://api.nexusmods.com';
export const GRAPHQL_URL = `${API_BASE}/v2/graphql`;
export const DEFAULT_APP_VERSION = '0.1.0';

export interface NexusClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  appName?: string;
  appVersion?: string;
}

const validateSchema = z.object({
  user_id: z.number().int(),
  name: z.string(),
  is_premium: z.boolean().optional(),
  'is_premium?': z.boolean().optional(),
  is_supporter: z.boolean().optional(),
  'is_supporter?': z.boolean().optional(),
  profile_url: z.string().nullish(),
});

const uriEntry = z.object({ URI: z.string().min(1) });
const archiveLinkSchema = z.union([
  z.array(uriEntry).min(1),
  z.object({ download_links: z.array(uriEntry).min(1) }),
  z.object({ download_link: z.union([z.string().min(1), uriEntry]) }),
]);

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, what: string, url: string, status = 200): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue === undefined ? '' : ` at ${issue.path.join('.') || '(root)'}: ${issue.message}`;
  throw new NexusApiError(`Nexus returned an unexpected ${what} response${where}`, status, redactUrl(url));
}

function positiveInt(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${what}: ${value}`);
  return value;
}

export class NexusClient {
  rateLimit: RateLimit = {};
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #appName: string;
  readonly #appVersion: string;

  constructor(opts: NexusClientOptions) {
    this.#apiKey = opts.apiKey === '' ? undefined : opts.apiKey;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#appName = opts.appName ?? 'Valley Loader';
    this.#appVersion = opts.appVersion ?? DEFAULT_APP_VERSION;
  }

  get hasApiKey(): boolean {
    return this.#apiKey !== undefined;
  }

  /** Sends a request with the standard headers, tracks rate limits, maps errors, returns parsed JSON. */
  async #request(url: string, init: { method?: string; body?: string } = {}): Promise<{ data: unknown; status: number }> {
    const headers = buildHeaders({ apiKey: this.#apiKey, appName: this.#appName, appVersion: this.#appVersion });
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.#fetch(url, { method: init.method ?? 'GET', headers, body: init.body });
    } catch (err) {
      throw networkError(err, url, this.#apiKey);
    }
    trackRateLimit(res.headers, this.rateLimit);
    const text = await res.text().catch((err: unknown) => {
      throw networkError(err, url, this.#apiKey);
    });
    if (!res.ok) {
      throw httpError(res.status, res.statusText, text, url, { apiKey: this.#apiKey, rateLimit: this.rateLimit });
    }
    try {
      return { data: JSON.parse(text) as unknown, status: res.status };
    } catch (err) {
      const wrapped = new NexusApiError(
        `Nexus returned a response that is not JSON (status ${res.status})`,
        res.status,
        redactUrl(url),
      );
      wrapped.cause = err;
      throw wrapped;
    }
  }

  #requireKey(url: string): void {
    if (this.#apiKey === undefined) {
      throw new NexusApiError('No Nexus API key yet — paste your personal API key in Settings', 401, url);
    }
  }

  /** POSTs a GraphQL query; a non-empty `errors` array becomes a NexusApiError (status 404 for NOT_FOUND). */
  async #graphql<T>(query: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const { data, status } = await this.#request(GRAPHQL_URL, {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
    });
    const envelope = parseOrThrow(graphqlEnvelopeSchema, data, 'GraphQL', GRAPHQL_URL, status);
    const errors = envelope.errors ?? [];
    if (errors.length > 0) {
      const notFound = errors.some((e) => e.extensions?.code === 'NOT_FOUND');
      const message = errors.map((e) => e.message).join('; ');
      throw new NexusApiError(`Nexus GraphQL error: ${message}`, notFound ? 404 : status, GRAPHQL_URL);
    }
    return parseOrThrow(schema, envelope.data, 'GraphQL', GRAPHQL_URL, status);
  }

  /** GET /v1/users/validate.json → NexusUser. Requires apiKey. The key and email in the response are dropped. */
  async validate(): Promise<NexusUser> {
    const url = `${API_BASE}/v1/users/validate.json`;
    this.#requireKey(url);
    const { data } = await this.#request(url);
    const raw = parseOrThrow(validateSchema, data, 'account', url);
    const user: NexusUser = {
      userId: raw.user_id,
      name: raw.name,
      isPremium: raw.is_premium ?? raw['is_premium?'] ?? false,
      isSupporter: raw.is_supporter ?? raw['is_supporter?'] ?? false,
    };
    if (raw.profile_url !== undefined && raw.profile_url !== null && raw.profile_url !== '') {
      user.avatarUrl = raw.profile_url;
    }
    return user;
  }

  /**
   * GraphQL collection(slug) / collectionRevision → summary. Works without apiKey.
   * Omit `revision` for the latest published revision. Unknown slugs throw NexusApiError(status 404) with a friendly message.
   */
  async getCollection(slug: string, revision?: number): Promise<CollectionSummary> {
    try {
      if (revision === undefined) {
        const res = await this.#graphql(LATEST_QUERY, { slug, domain: GAME_DOMAIN }, latestResponseSchema);
        const col = res.collection;
        if (col === null) throw new NexusApiError(`Collection "${slug}" was not found`, 404, GRAPHQL_URL);
        const latest = col.latestPublishedRevision;
        if (latest === undefined || latest === null) {
          throw new NexusApiError(`Collection "${slug}" has no published revision yet`, 404, GRAPHQL_URL);
        }
        return toSummary(col, latest);
      }
      const rev = positiveInt(revision, 'revision number');
      const res = await this.#graphql(REVISION_QUERY, { slug, revision: rev, domain: GAME_DOMAIN }, revisionResponseSchema);
      const cr = res.collectionRevision;
      if (cr === null) throw new NexusApiError(`Revision ${rev} of "${slug}" was not found`, 404, GRAPHQL_URL);
      return toSummary(cr.collection, cr);
    } catch (err) {
      if (err instanceof NexusApiError && err.status === 404) {
        const which = revision === undefined ? '' : ` (revision ${revision})`;
        const friendly = new NexusApiError(
          `Stardew Valley collection "${slug}"${which} was not found on Nexus Mods — check the link (${err.message})`,
          404,
          err.url,
        );
        friendly.cause = err;
        throw friendly;
      }
      throw err;
    }
  }

  /**
   * GraphQL collectionRevision.modFiles for a revision. Works without apiKey.
   * Entries whose file was deleted on Nexus (file: null) are left out of `files`, listed in `missingFileIds`
   * and logged as a warning.
   */
  async getRevisionModFiles(slug: string, revision: number): Promise<RevisionModFiles> {
    const rev = positiveInt(revision, 'revision number');
    const res = await this.#graphql(MOD_FILES_QUERY, { slug, revision: rev, domain: GAME_DOMAIN }, modFilesResponseSchema);
    if (res.collectionRevision === null) {
      throw new NexusApiError(`Revision ${rev} of collection "${slug}" was not found`, 404, GRAPHQL_URL);
    }
    const { files, missing } = toModFiles(res.collectionRevision.modFiles);
    if (missing.length > 0) {
      console.warn(`[nexus] ${slug} rev ${rev}: ${missing.length} mod file(s) no longer exist on Nexus: ${missing.join(', ')}`);
    }
    return { files, missingFileIds: missing };
  }

  /** GET API_BASE + downloadLinkPath (apikey header) → first CDN URI. Only api.nexusmods.com paths are allowed. */
  async getCollectionArchiveUrl(downloadLinkPath: string): Promise<string> {
    const url = new URL(downloadLinkPath, API_BASE);
    if (url.origin !== API_BASE) {
      throw new Error(`Refusing to send the API key to ${url.origin}: collection download path must be on ${API_BASE}`);
    }
    const href = url.toString();
    this.#requireKey(redactUrl(href));
    const { data, status } = await this.#request(href);
    const parsed = parseOrThrow(archiveLinkSchema, data, 'collection download link (no URI)', href, status);
    if (Array.isArray(parsed)) return parsed[0]?.URI ?? '';
    if ('download_links' in parsed) return parsed.download_links[0]?.URI ?? '';
    return typeof parsed.download_link === 'string' ? parsed.download_link : parsed.download_link.URI;
  }

  /** GET /v1/games/{domain}/mods/{modId}/files/{fileId}/download_link.json[?key&expires] → first URI. */
  async getModFileDownloadUrl(args: {
    domain: string;
    modId: number;
    fileId: number;
    key?: string;
    expires?: number;
  }): Promise<string> {
    const modId = positiveInt(args.modId, 'mod id');
    const fileId = positiveInt(args.fileId, 'file id');
    let url = `${API_BASE}/v1/games/${encodeURIComponent(args.domain)}/mods/${modId}/files/${fileId}/download_link.json`;
    const params = new URLSearchParams();
    if (args.key !== undefined && args.key !== '') params.set('key', args.key);
    if (args.expires !== undefined) params.set('expires', String(args.expires));
    if (params.size > 0) url += `?${params.toString()}`;
    this.#requireKey(redactUrl(url));
    const { data, status } = await this.#request(url);
    const links = parseOrThrow(z.array(uriEntry), data, 'download link', url, status);
    const first = links[0];
    if (first === undefined) {
      throw new NexusApiError(`Nexus returned no download servers for mod ${modId} file ${fileId}`, status, redactUrl(url));
    }
    return first.URI;
  }
}
