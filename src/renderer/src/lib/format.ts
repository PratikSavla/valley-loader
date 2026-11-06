// SPDX-License-Identifier: AGPL-3.0-only
// Pure display helpers for the renderer. No DOM or Electron access — unit tested in tests/renderer-lib.test.ts.
import type { CheckStatus, ModSourceType, ModStatus } from '@shared/types';

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** Human-readable size using 1024-based units: "512 B", "12 KB", "4.2 MB", "465 MB", "1.3 GB". */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  const rounded = Number(value.toFixed(digits));
  if (rounded >= 1024 && unit < UNITS.length - 1) return `1.0 ${UNITS[unit + 1]}`;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** "4.2 MB of 12 MB" style progress text; total may be unknown (0). */
export function formatProgress(received: number, total: number): string {
  if (total <= 0) return `${formatBytes(received)} received`;
  return `${formatBytes(received)} of ${formatBytes(total)}`;
}

/** Whole-number percentage clamped to 0–100, or undefined when the total is unknown. */
export function percent(received: number, total: number): number | undefined {
  if (!(total > 0)) return undefined;
  return Math.max(0, Math.min(100, Math.round((received / total) * 100)));
}

export type Tone = 'ok' | 'warn' | 'bad' | 'busy' | 'idle';

const STATUS_LABELS: Record<ModStatus, string> = {
  pending: 'Waiting',
  needsClick: 'Needs your click',
  resolving: 'Getting link',
  queued: 'Queued',
  downloading: 'Downloading',
  installing: 'Installing',
  installed: 'Installed',
  skipped: 'Skipped',
  manual: 'Needs a file',
  failed: 'Failed',
};

const STATUS_TONES: Record<ModStatus, Tone> = {
  pending: 'idle',
  needsClick: 'warn',
  resolving: 'busy',
  queued: 'busy',
  downloading: 'busy',
  installing: 'busy',
  installed: 'ok',
  skipped: 'idle',
  manual: 'warn',
  failed: 'bad',
};

/** Display order for status summaries: things needing the user first. */
export const STATUS_ORDER: readonly ModStatus[] = [
  'failed',
  'manual',
  'needsClick',
  'downloading',
  'installing',
  'resolving',
  'queued',
  'pending',
  'installed',
  'skipped',
];

export function statusLabel(status: ModStatus): string {
  return STATUS_LABELS[status];
}

export function statusTone(status: ModStatus): Tone {
  return STATUS_TONES[status];
}

const SOURCE_LABELS: Record<ModSourceType, string> = {
  nexus: 'Nexus',
  bundle: 'Bundled',
  direct: 'Direct link',
  browse: 'Website',
  manual: 'Manual',
};

export function sourceLabel(source: ModSourceType): string {
  return SOURCE_LABELS[source];
}

const CHECK_LABELS: Record<CheckStatus, string> = {
  pass: 'Ready',
  warn: 'Worth fixing',
  fail: 'Needs fixing',
  pending: 'Checking',
};

const CHECK_TONES: Record<CheckStatus, Tone> = { pass: 'ok', warn: 'warn', fail: 'bad', pending: 'busy' };

export function checkLabel(status: CheckStatus): string {
  return CHECK_LABELS[status];
}

export function checkTone(status: CheckStatus): Tone {
  return CHECK_TONES[status];
}

/** "1 mod" / "3 mods". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
