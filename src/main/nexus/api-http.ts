// SPDX-License-Identifier: AGPL-3.0-only
// HTTP helpers for the Nexus client: headers, rate-limit tracking, error mapping. Pure, no Electron imports.
import os from 'node:os';

export class NexusApiError extends Error {
  override name = 'NexusApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
  }
}

export interface RateLimit {
  daily?: number;
  hourly?: number;
}

export interface HeaderOptions {
  apiKey?: string;
  appName: string;
  appVersion: string;
}

export function userAgent(appVersion: string): string {
  return `ValleyLoader/${appVersion} (macOS ${os.release()}; ${process.arch}) Node/${process.versions.node}`;
}

export function buildHeaders(opts: HeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Application-Name': opts.appName,
    'Application-Version': opts.appVersion,
    'Protocol-Version': '1.0.0',
    'User-Agent': userAgent(opts.appVersion),
    Accept: 'application/json',
  };
  if (opts.apiKey !== undefined && opts.apiKey !== '') headers.apikey = opts.apiKey;
  return headers;
}

function headerInt(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Copies X-RL-Daily-Remaining / X-RL-Hourly-Remaining into `target` (only the ones present). */
export function trackRateLimit(headers: Headers, target: RateLimit): void {
  const daily = headerInt(headers, 'x-rl-daily-remaining');
  const hourly = headerInt(headers, 'x-rl-hourly-remaining');
  if (daily !== undefined) target.daily = daily;
  if (hourly !== undefined) target.hourly = hourly;
}

/** URL safe for error messages/logs: drops the query string (download keys live there). */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function scrub(text: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey === '') return text;
  return text.split(apiKey).join('[redacted]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pulls a human-readable message out of a Nexus error body ({message}, {error}, GraphQL {errors[]}). */
export function serverMessage(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON: the raw text (if short and non-HTML) is the message.
    const text = body.trim();
    return text !== '' && text.length <= 300 && !text.startsWith('<') ? text : undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.message === 'string' && parsed.message !== '') return parsed.message;
  if (typeof parsed.error === 'string' && parsed.error !== '') return parsed.error;
  if (Array.isArray(parsed.errors)) {
    const msgs = parsed.errors
      .map((e: unknown) => (isRecord(e) && typeof e.message === 'string' ? e.message : undefined))
      .filter((m): m is string => m !== undefined);
    if (msgs.length > 0) return msgs.join('; ');
  }
  return undefined;
}

function withServer(message: string, server: string | undefined): string {
  return server === undefined ? message : `${message} (Nexus said: ${server})`;
}

function statusMessage(status: number, server: string | undefined, rateLimit: RateLimit): string | undefined {
  switch (status) {
    case 401:
      return 'Nexus rejected the API key — paste a new one in Settings';
    case 403:
      return withServer('Nexus needs Premium for direct downloads — open the file page and click Slow download', server);
    case 404:
      return withServer('Nexus could not find that item (404) — it may have been removed or hidden', server);
    case 410:
      return 'This download link has expired — open the file page and click Slow download again';
    case 429:
      return (
        `Nexus API rate limit reached (daily remaining: ${rateLimit.daily ?? 'unknown'}, ` +
        `hourly remaining: ${rateLimit.hourly ?? 'unknown'}) — wait up to an hour and try again`
      );
    default:
      return undefined;
  }
}

/** Maps a non-2xx response to a user-facing NexusApiError. The API key is never included. */
export function httpError(
  status: number,
  statusText: string,
  body: string,
  url: string,
  ctx: { apiKey?: string; rateLimit: RateLimit },
): NexusApiError {
  const safeBody = scrub(body, ctx.apiKey);
  const server = serverMessage(safeBody);
  const safeUrl = redactUrl(url);
  const known = statusMessage(status, server, ctx.rateLimit);
  if (known !== undefined) return new NexusApiError(known, status, safeUrl);
  const snippet = (server ?? safeBody.trim()).slice(0, 200);
  const label = `${status}${statusText === '' ? '' : ` ${statusText}`}`;
  return new NexusApiError(
    `Nexus API error ${label} for ${safeUrl}${snippet === '' ? '' : `: ${snippet}`}`,
    status,
    safeUrl,
  );
}

/** Wraps a fetch/network failure with context. */
export function networkError(err: unknown, url: string, apiKey: string | undefined): NexusApiError {
  const detail = scrub(err instanceof Error ? err.message : String(err), apiKey);
  const safeUrl = redactUrl(url);
  const wrapped = new NexusApiError(
    `Could not reach Nexus Mods (${safeUrl}): ${detail} — check your internet connection`,
    0,
    safeUrl,
  );
  wrapped.cause = err;
  return wrapped;
}
