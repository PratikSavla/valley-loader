// SPDX-License-Identifier: AGPL-3.0-only
// Per-collection lock held while a collection is resolved or updated (archive download, re-plan, cleanup).
// Start/Resume, Remove, mod toggles and retries refuse while it is held, so a profile can't be installed into,
// deleted or edited underneath the resolve. Published as transient.resolving so the UI can disable buttons.
import type { Store } from '../state/store';

export class ResolveLock {
  readonly #slugs = new Set<string>();

  constructor(private readonly store: Store) {}

  isHeld(slug: string): boolean {
    return this.#slugs.has(slug.toLowerCase());
  }

  /** Throws when the collection is being resolved or updated right now. */
  assertFree(slug: string): void {
    if (!this.isHeld(slug)) return;
    const name = this.store.getProfile(slug)?.name ?? slug;
    throw new Error(`"${name}" is being updated; try again in a moment.`);
  }

  /** Runs `work` holding the lock for `slug`; refuses when it is already held. */
  async hold<T>(slug: string, work: () => Promise<T>): Promise<T> {
    this.assertFree(slug);
    const key = slug.toLowerCase();
    this.#slugs.add(key);
    this.#publish();
    try {
      return await work();
    } finally {
      this.#slugs.delete(key);
      this.#publish();
    }
  }

  #publish(): void {
    this.store.setTransient({ resolving: this.#slugs.size > 0 ? [...this.#slugs] : undefined });
  }
}
