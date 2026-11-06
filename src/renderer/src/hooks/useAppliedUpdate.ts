// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useState } from 'react';

/** What an applied update brought in: the revision it moved to and the plan keys from before it. */
export interface AppliedUpdate {
  revision: number;
  keysBefore: ReadonlySet<string>;
}

// Lives as long as the window, so the "press Start" callout survives going to Home and back.
const appliedBySlug = new Map<string, AppliedUpdate>();

/** Per-collection memory of the last update applied from this window. */
export function useAppliedUpdate(slug: string): [AppliedUpdate | undefined, (applied: AppliedUpdate) => void] {
  const [, rerender] = useState(0);
  const set = useCallback(
    (next: AppliedUpdate) => {
      appliedBySlug.set(slug, next);
      rerender((n) => n + 1);
    },
    [slug],
  );
  return [appliedBySlug.get(slug), set];
}
