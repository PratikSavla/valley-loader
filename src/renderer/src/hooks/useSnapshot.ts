// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import type { AppSnapshot } from '@shared/types';
import { errorMessage } from '../lib/errors';
import { getValley, hasValleyBridge } from './valley';

/**
 * Loads the initial snapshot and follows pushes from the main process.
 * `onLastError` fires once per new error event (`snapshot.lastErrorId`), so a repeated identical error is shown
 * again while an unrelated snapshot push never re-shows the same one.
 */
export function useSnapshot(onLastError: (message: string) => void): {
  snapshot: AppSnapshot | undefined;
  loadError: string | undefined;
} {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [fetchError, setFetchError] = useState<string>();
  const bridgeError = hasValleyBridge() ? undefined : 'Valley Loader could not connect to its background process.';

  useEffect(() => {
    if (!hasValleyBridge()) return undefined;
    const api = getValley();
    let alive = true;
    let pushed = false;
    let lastSeenId: number | undefined;
    const accept = (next: AppSnapshot): void => {
      if (!alive) return;
      if (next.lastError && next.lastErrorId !== lastSeenId) onLastError(next.lastError);
      lastSeenId = next.lastErrorId;
      setSnapshot(next);
    };
    const unsubscribe = api.onSnapshot((next) => {
      pushed = true;
      accept(next);
    });
    api.getSnapshot().then(
      (initial) => {
        if (!pushed) accept(initial);
      },
      (cause: unknown) => {
        const message = `Couldn't load app state: ${errorMessage(cause)}`;
        console.error('[valley] getSnapshot failed', cause);
        if (alive) setFetchError(message);
      },
    );
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [onLastError]);

  return { snapshot, loadError: bridgeError ?? (snapshot ? undefined : fetchError) };
}
