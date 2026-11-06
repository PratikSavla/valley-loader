// SPDX-License-Identifier: AGPL-3.0-only
// Access to the preload bridge. Throws a clear error when the preload script did not load.
import type { ValleyApi } from '@shared/ipc';

export function hasValleyBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.valley === 'object' && window.valley !== null;
}

export function getValley(): ValleyApi {
  if (!hasValleyBridge()) {
    throw new Error('The app bridge (window.valley) is missing — the preload script did not load.');
  }
  return window.valley;
}
