// SPDX-License-Identifier: AGPL-3.0-only
// "New revision available" checks and one-click update. No Electron imports: Nexus, the resolve path and the
// clock are injected so it is unit-testable.
//
// - check: GraphQL latest published revision (public, no API key) → if newer, its mod files → diffRevisions →
//   ProfileState.update (persisted). Failures are logged and stored as update.error (no toast).
// - schedule: ~10 s after start, every 6 h, and when a profile becomes active with a check older than 1 h
//   (debounced). Never two checks for one slug at once. Checking while installing is fine; applying is not.
// - applyUpdate: re-resolves the profile at the previewed revision (or a newer one an in-flight check found)
//   through Runner.resolveCollection (kept mods stay, new/changed mods become pending, dropped mods are
//   unstaged), then runs a real check. It never starts an install.
import { readdir } from 'node:fs/promises';
import type { ProfileState, ProfileUpdate } from '@shared/types';
import { diffRevisions } from '../collection/revision-diff';
import type { NexusClient } from '../nexus/api';
import { NexusApiError } from '../nexus/api-http';
import type { Store } from '../state/store';
import { errorMessage } from './runner-context';

export const STARTUP_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const STALE_AFTER_MS = 60 * 60 * 1000;
export const ACTIVATE_DEBOUNCE_MS = 1_500;

export type UpdateApiLike = Pick<NexusClient, 'getCollection' | 'getRevisionModFiles'>;

export interface UpdateDeps {
  store: Store;
  client: () => UpdateApiLike;
  /** Re-resolves a profile at one revision (Runner.resolveCollection); makes it active. */
  resolve: (input: string) => Promise<ProfileState>;
  /** True while downloads/installs for the profile are still in flight (e.g. finishing after a Pause). */
  isBusy: (slug: string) => boolean;
  /** Folder holding cached mod archives ("<modId>-<fileId>-<name>"). */
  downloadsDir: string;
  now?: () => Date;
}

/** Collection page for one revision; parseCollectionInput turns it back into (slug, revision). */
export function revisionLink(slug: string, revision: number): string {
  return `https://www.nexusmods.com/games/stardewvalley/collections/${encodeURIComponent(slug)}/revisions/${revision}`;
}

/** Plan keys ("nexus:<modId>:<fileId>") of archives already in the download cache. Partial downloads don't count. */
export async function cachedNexusKeys(downloadsDir: string): Promise<Set<string>> {
  let names: string[];
  try {
    names = await readdir(downloadsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw new Error(`Could not list cached downloads in ${downloadsDir}: ${errorMessage(err)}`, { cause: err });
  }
  const keys = new Set<string>();
  for (const name of names) {
    const match = /^(\d+)-(\d+)-/.exec(name);
    if (match !== null && !name.endsWith('.part')) keys.add(`nexus:${match[1]}:${match[2]}`);
  }
  return keys;
}

/** Plain-language reason a revision check failed (the full error goes to the log). */
export function updateCheckError(err: unknown): string {
  if (err instanceof NexusApiError) {
    if (err.status === 0) return "Couldn't reach Nexus Mods. Check your internet connection.";
    if (err.status === 429) return 'Nexus Mods is limiting requests right now. Valley Loader will try again later.';
    if (err.status >= 500) return 'Nexus Mods is not responding right now. Valley Loader will try again later.';
    if (err.status === 404) return err.message; // already friendly: "collection … was not found … check the link"
  }
  return 'Something went wrong while checking Nexus Mods. Try again later.';
}

export class UpdateService {
  readonly #checks = new Map<string, Promise<void>>();
  readonly #applying = new Set<string>();
  readonly #timers: NodeJS.Timeout[] = [];
  #activateTimer: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;
  #lastActive: string | undefined;

  constructor(private readonly deps: UpdateDeps) {}

  /** Starts the schedule: one check shortly after launch, then every 6 h, plus stale checks on activation. */
  start(): void {
    const all = (what: string): void => {
      this.checkForUpdates().catch((err: unknown) => console.error(`[updates] ${what} check failed`, err));
    };
    this.#timers.push(setTimeout(() => all('startup'), STARTUP_DELAY_MS), setInterval(() => all('periodic'), CHECK_INTERVAL_MS));
    this.#lastActive = this.deps.store.activeSlug;
    this.#unsubscribe = this.deps.store.subscribe((snap) => this.#onActive(snap.activeSlug));
  }

  dispose(): void {
    for (const t of this.#timers.splice(0)) clearTimeout(t);
    if (this.#activateTimer !== undefined) clearTimeout(this.#activateTimer);
    this.#activateTimer = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** Checks one profile, or every profile when slug is omitted. Failures land in update.error, never reject. */
  async checkForUpdates(slug?: string): Promise<void> {
    const slugs = slug === undefined ? this.deps.store.profiles.map((p) => p.slug) : [this.deps.store.requireProfile(slug).slug];
    await Promise.all(slugs.map((s) => this.#check(s)));
  }

  /** Moves the profile to the revision its update preview is for. Refused while installing. */
  async applyUpdate(slug: string): Promise<ProfileState> {
    const { store } = this.deps;
    const profile = store.requireProfile(slug);
    if (profile.running) throw new Error(`"${profile.name}" is installing right now. Pause the install first, then update.`);
    if (this.deps.isBusy(slug)) throw new Error(`Downloads for "${profile.name}" are still finishing. Try again in a moment.`);
    const target = profile.update?.latestRevision;
    if (target === undefined || target <= profile.revision) {
      throw new Error(`"${profile.name}" is already on the newest revision Valley Loader knows about. Press "Check again" first.`);
    }
    if (this.#applying.has(slug)) throw new Error(`"${profile.name}" is already being updated.`);
    this.#applying.add(slug);
    let next: ProfileState;
    try {
      // A check still in flight may have found an even newer revision: go there, never back to a stale target.
      await this.#checks.get(slug);
      const goal = Math.max(store.requireProfile(slug).update?.latestRevision ?? target, target);
      next = await this.deps.resolve(revisionLink(profile.slug, goal));
      // No made-up check result: clearing it shows "not checked yet" until the real check below lands.
      if (store.getProfile(next.slug) !== undefined) next = store.updateProfile(next.slug, { update: undefined });
    } finally {
      this.#applying.delete(slug);
    }
    this.#check(next.slug).catch((err: unknown) => console.error(`[updates] ${slug}: post-update check failed`, err));
    return next;
  }

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  #check(slug: string): Promise<void> {
    const running = this.#checks.get(slug);
    if (running !== undefined) return running;
    if (this.#applying.has(slug)) return Promise.resolve();
    const work = this.#runCheck(slug).finally(() => this.#checks.delete(slug));
    this.#checks.set(slug, work);
    return work;
  }

  async #runCheck(slug: string): Promise<void> {
    const before = this.deps.store.getProfile(slug);
    if (before === undefined) return;
    const checkedAt = this.#now().toISOString();
    try {
      const client = this.deps.client();
      const latest = await client.getCollection(before.slug);
      if (latest.revision <= before.revision) {
        this.#setUpdate(slug, { latestRevision: before.revision, checkedAt });
        return;
      }
      const [{ files, missingFileIds }, cachedKeys] = await Promise.all([
        client.getRevisionModFiles(before.slug, latest.revision),
        cachedNexusKeys(this.deps.downloadsDir),
      ]);
      const current = this.deps.store.getProfile(slug);
      // No check starts while applying, and applyUpdate waits for one already running, so its result is used.
      if (current === undefined) return;
      if (latest.revision <= current.revision) {
        this.#setUpdate(slug, { latestRevision: current.revision, checkedAt });
        return;
      }
      const isPremium = this.deps.store.transient.user?.isPremium === true;
      const missing = new Set(missingFileIds);
      const opts = { fromRevision: current.revision, toRevision: latest.revision, isPremium, cachedKeys, missingFileIds: missing };
      this.#setUpdate(slug, { latestRevision: latest.revision, checkedAt, diff: diffRevisions(current.mods, files, opts) });
    } catch (err) {
      console.error(`[updates] ${slug}: could not check for a newer collection revision`, err);
      this.#recordError(slug, checkedAt, updateCheckError(err));
    }
  }

  /** Keeps a previously found update (still valid offline) and notes why this check failed. */
  #recordError(slug: string, checkedAt: string, error: string): void {
    const profile = this.deps.store.getProfile(slug);
    if (profile === undefined) return;
    const prev = profile.update;
    const update: ProfileUpdate = { latestRevision: profile.revision, checkedAt, error };
    if (prev !== undefined && prev.latestRevision > profile.revision) {
      update.latestRevision = prev.latestRevision;
      if (prev.diff !== undefined && prev.diff.fromRevision === profile.revision) update.diff = prev.diff;
    }
    this.#setUpdate(slug, update);
  }

  #setUpdate(slug: string, update: ProfileUpdate): ProfileState | undefined {
    if (this.deps.store.getProfile(slug) === undefined) return undefined;
    return this.deps.store.updateProfile(slug, { update });
  }

  #onActive(slug: string | undefined): void {
    if (slug === this.#lastActive) return;
    this.#lastActive = slug;
    if (this.#activateTimer !== undefined) clearTimeout(this.#activateTimer);
    this.#activateTimer = undefined;
    if (slug === undefined) return;
    this.#activateTimer = setTimeout(() => {
      this.#activateTimer = undefined;
      if (!this.#isStale(slug)) return;
      this.#check(slug).catch((err: unknown) => console.error(`[updates] ${slug}: activation check failed`, err));
    }, ACTIVATE_DEBOUNCE_MS);
  }

  #isStale(slug: string): boolean {
    const profile = this.deps.store.getProfile(slug);
    if (profile === undefined) return false;
    const checked = Date.parse(profile.update?.checkedAt ?? '');
    return Number.isNaN(checked) || this.#now().getTime() - checked > STALE_AFTER_MS;
  }
}
