// SPDX-License-Identifier: AGPL-3.0-only
// Typed download failure (shared by the queue and its callers). Pure.

export type DownloadErrorCode = 'cancelled' | 'http' | 'network' | 'size' | 'md5' | 'invalid' | 'io';

export class DownloadError extends Error {
  override readonly name = 'DownloadError';
  readonly code: DownloadErrorCode;
  /** HTTP status for code 'http'. */
  readonly status?: number;

  constructor(message: string, opts: { code?: DownloadErrorCode; status?: number } = {}) {
    super(message);
    this.code = opts.code ?? (message === 'cancelled' ? 'cancelled' : 'io');
    if (opts.status !== undefined) this.status = opts.status;
  }

  get retryable(): boolean {
    return this.code === 'network' || (this.code === 'http' && (this.status === 429 || (this.status ?? 0) >= 500));
  }
}
