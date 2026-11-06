// SPDX-License-Identifier: AGPL-3.0-only
// Version comparison for SMAPI / game versions like "4.1.10", "4.0.0-beta.2", "1.6.15".
import type { GameInfo } from '@shared/types';

interface ParsedVersion {
  parts: number[];
  prerelease: string;
}

function parseVersion(raw: string): ParsedVersion {
  const cleaned = raw.trim().replace(/^v/i, '');
  const [core = '', ...rest] = cleaned.split(/[-+]/);
  const parts = core.split('.').map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  return { parts, prerelease: rest.join('-') };
}

/** Negative when a < b, 0 when equal, positive when a > b. Missing parts count as 0; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const len = Math.max(va.parts.length, vb.parts.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (va.parts[i] ?? 0) - (vb.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (va.prerelease === vb.prerelease) return 0;
  if (va.prerelease === '') return 1;
  if (vb.prerelease === '') return -1;
  return va.prerelease < vb.prerelease ? -1 : 1;
}

export type SmapiState =
  | { kind: 'ok' }
  | { kind: 'unknown' } // game folder not set yet: setup banner covers this
  | { kind: 'missing'; required?: string }
  | { kind: 'outdated'; required: string; installed: string };

/** Whether the installed SMAPI satisfies a collection's requirement (if any). */
export function smapiState(game: GameInfo | undefined, required: string | undefined): SmapiState {
  if (!game) return { kind: 'unknown' };
  if (!game.smapiInstalled) return required ? { kind: 'missing', required } : { kind: 'missing' };
  if (!required || !game.smapiVersion) return { kind: 'ok' };
  if (compareVersions(game.smapiVersion, required) < 0) {
    return { kind: 'outdated', required, installed: game.smapiVersion };
  }
  return { kind: 'ok' };
}
