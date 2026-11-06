// SPDX-License-Identifier: AGPL-3.0-only
// The app's ONE persistence wrapper (singleton). Persists settings/profiles/activeSlug to
// <userData>/state.json (atomic tmp+rename, debounced), keeps transient fields in memory and pushes
// AppSnapshot to listeners (throttled). Never stores the API key. No Electron imports (testable).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppSnapshot, GameInfo, NexusUser, PendingCollection, PlannedMod, ProfileState, Settings } from '@shared/types';
import { DEFAULT_SETTINGS, parsePersistedState, serializeState, type PersistedState } from './store-schema';

export interface TransientState {
  hasApiKey: boolean;
  user?: NexusUser;
  game?: GameInfo;
  awaitingClick?: { slug: string; key: string; index: number; total: number };
  rateLimit?: { daily?: number; hourly?: number };
  lastError?: string;
  /** Incremented by setTransient whenever a patch sets lastError (see AppSnapshot.lastErrorId). */
  lastErrorId?: number;
  apiKeyError?: string;
  pendingCollection?: PendingCollection;
  resolving?: string[];
}

export interface StoreOptions {
  /** Debounce before state.json is written. Default 250 ms. */
  saveDelayMs?: number;
  /** Minimum gap between snapshot pushes. Default 100 ms (≈10/s). */
  emitIntervalMs?: number;
}

export type SnapshotListener = (snapshot: AppSnapshot) => void;

/** Applies a patch; keys whose value is `undefined` are deleted (so callers can clear `error`). */
function applyPatch<T extends object>(target: T, patch: Partial<T>): T {
  const next = { ...target } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return next as T;
}

async function loadState(statePath: string): Promise<{ state: PersistedState; loadError?: string }> {
  let text: string;
  try {
    text = await readFile(statePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: { settings: { ...DEFAULT_SETTINGS }, profiles: [] } };
    throw new Error(`Could not read ${statePath}: ${(err as Error).message}`, { cause: err });
  }
  try {
    return { state: parsePersistedState(text) };
  } catch (err) {
    const backup = `${statePath}.corrupt-${Date.now()}`;
    console.error(`[store] ${(err as Error).message}; moving it to ${backup} and starting fresh`, err);
    await rename(statePath, backup);
    const loadError = `Saved app state was unreadable and was reset (backup: ${backup}).`;
    return { state: { settings: { ...DEFAULT_SETTINGS }, profiles: [] }, loadError };
  }
}

export class Store {
  static #instance: Store | undefined;

  readonly statePath: string;
  #state: PersistedState;
  #transient: TransientState = { hasApiKey: false };
  readonly #listeners = new Set<SnapshotListener>();
  readonly #saveDelay: number;
  readonly #emitInterval: number;
  #saveTimer: NodeJS.Timeout | undefined;
  #saveChain: Promise<void> = Promise.resolve();
  #emitTimer: NodeJS.Timeout | undefined;
  #lastEmit = 0;
  #lastSaveError: unknown;

  private constructor(userDataDir: string, state: PersistedState, opts: StoreOptions) {
    this.statePath = join(userDataDir, 'state.json');
    this.#state = state;
    this.#saveDelay = opts.saveDelayMs ?? 250;
    this.#emitInterval = opts.emitIntervalMs ?? 100;
  }

  /** Loads (or creates) a store without touching the singleton. Used by init() and by tests. */
  static async open(userDataDir: string, opts: StoreOptions = {}): Promise<Store> {
    await mkdir(userDataDir, { recursive: true });
    const { state, loadError } = await loadState(join(userDataDir, 'state.json'));
    const store = new Store(userDataDir, state, opts);
    if (loadError !== undefined) store.#transient = { ...store.#transient, lastError: loadError, lastErrorId: 1 };
    return store;
  }

  static async init(userDataDir: string, opts: StoreOptions = {}): Promise<Store> {
    if (Store.#instance !== undefined) throw new Error('Store.init() was called twice');
    Store.#instance = await Store.open(userDataDir, opts);
    return Store.#instance;
  }

  static get(): Store {
    if (Store.#instance === undefined) throw new Error('Store.get() called before Store.init()');
    return Store.#instance;
  }

  get settings(): Settings {
    return this.#state.settings;
  }

  get profiles(): readonly ProfileState[] {
    return this.#state.profiles;
  }

  get activeSlug(): string | undefined {
    return this.#state.activeSlug;
  }

  get transient(): Readonly<TransientState> {
    return this.#transient;
  }

  getProfile(slug: string): ProfileState | undefined {
    return this.#state.profiles.find((p) => p.slug === slug);
  }

  requireProfile(slug: string): ProfileState {
    const profile = this.getProfile(slug);
    if (profile === undefined) throw new Error(`No collection profile "${slug}" — paste the collection link again`);
    return profile;
  }

  getMod(slug: string, key: string): PlannedMod | undefined {
    return this.getProfile(slug)?.mods.find((m) => m.key === key);
  }

  requireMod(slug: string, key: string): PlannedMod {
    const mod = this.getMod(slug, key);
    if (mod === undefined) throw new Error(`Mod "${key}" is not part of collection "${slug}"`);
    return mod;
  }

  snapshot(): AppSnapshot {
    const t = this.#transient;
    const snap: AppSnapshot = {
      settings: this.#state.settings,
      hasApiKey: t.hasApiKey,
      profiles: [...this.#state.profiles],
    };
    if (t.user) snap.user = t.user;
    if (t.game) snap.game = t.game;
    if (this.#state.activeSlug !== undefined) snap.activeSlug = this.#state.activeSlug;
    if (t.awaitingClick) snap.awaitingClick = t.awaitingClick;
    if (t.rateLimit) snap.rateLimit = t.rateLimit;
    if (t.lastError !== undefined) snap.lastError = t.lastError;
    if (t.lastErrorId !== undefined) snap.lastErrorId = t.lastErrorId;
    if (t.apiKeyError !== undefined) snap.apiKeyError = t.apiKeyError;
    if (t.pendingCollection !== undefined) snap.pendingCollection = t.pendingCollection;
    if (t.resolving !== undefined && t.resolving.length > 0) snap.resolving = t.resolving;
    return structuredClone(snap);
  }

  subscribe(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  updateSettings(patch: Partial<Settings>): void {
    this.#state.settings = applyPatch(this.#state.settings, patch);
    this.#changed(true);
  }

  /** Transient (not persisted) fields; pass `undefined` to clear one. */
  setTransient(patch: Partial<TransientState>): void {
    const next = { ...patch };
    if (patch.lastError !== undefined) next.lastErrorId = (this.#transient.lastErrorId ?? 0) + 1;
    this.#transient = applyPatch(this.#transient, next);
    this.#changed(false);
  }

  upsertProfile(profile: ProfileState): void {
    const others = this.#state.profiles.filter((p) => p.slug !== profile.slug);
    const index = this.#state.profiles.findIndex((p) => p.slug === profile.slug);
    others.splice(index === -1 ? others.length : index, 0, profile);
    this.#state.profiles = others;
    this.#changed(true);
  }

  updateProfile(slug: string, patch: Partial<ProfileState>): ProfileState {
    const next = applyPatch(this.requireProfile(slug), { ...patch, updatedAt: new Date().toISOString() });
    this.#state.profiles = this.#state.profiles.map((p) => (p.slug === slug ? next : p));
    this.#changed(true);
    return next;
  }

  /** Patch one mod. A patch that only carries `progress` is pushed to the UI but not written to disk. */
  updateMod(slug: string, key: string, patch: Partial<PlannedMod>): PlannedMod {
    const profile = this.requireProfile(slug);
    const mod = this.requireMod(slug, key);
    const next = applyPatch(mod, patch);
    const mods = profile.mods.map((m) => (m.key === key ? next : m));
    this.#state.profiles = this.#state.profiles.map((p) => (p.slug === slug ? { ...p, mods } : p));
    const progressOnly = Object.keys(patch).every((k) => k === 'progress');
    this.#changed(!progressOnly);
    return next;
  }

  removeProfile(slug: string): void {
    this.#state.profiles = this.#state.profiles.filter((p) => p.slug !== slug);
    if (this.#state.activeSlug === slug) {
      const first = this.#state.profiles[0];
      if (first) this.#state.activeSlug = first.slug;
      else delete this.#state.activeSlug;
    }
    this.#changed(true);
  }

  setActive(slug: string | undefined): void {
    if (slug !== undefined) this.requireProfile(slug);
    if (slug === undefined) delete this.#state.activeSlug;
    else this.#state.activeSlug = slug;
    this.#changed(true);
  }

  /** Writes pending changes now (call on quit). Rejects if the write fails. */
  async flush(): Promise<void> {
    this.#lastSaveError = undefined;
    if (this.#saveTimer !== undefined) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
      this.#queueWrite();
    }
    await this.#saveChain;
    if (this.#lastSaveError !== undefined) throw this.#lastSaveError;
    if (this.#emitTimer !== undefined) {
      clearTimeout(this.#emitTimer);
      this.#emitTimer = undefined;
      this.#emit();
    }
  }

  #changed(persist: boolean): void {
    if (persist && this.#saveTimer === undefined) {
      this.#saveTimer = setTimeout(() => {
        this.#saveTimer = undefined;
        this.#queueWrite();
      }, this.#saveDelay);
    }
    this.#scheduleEmit();
  }

  #queueWrite(): void {
    const text = serializeState(this.#state);
    const tmp = `${this.statePath}.tmp`;
    this.#saveChain = this.#saveChain.then(async () => {
      try {
        await writeFile(tmp, text, 'utf8');
        await rename(tmp, this.statePath);
      } catch (err) {
        const msg = `Could not save app state to ${this.statePath}: ${(err as Error).message}`;
        console.error(`[store] ${msg}`, err);
        this.setTransient({ lastError: msg });
        throw new Error(msg, { cause: err });
      }
    });
    // Keep the chain usable for the next write; the failure is logged, shown in the UI and rethrown by flush().
    this.#saveChain = this.#saveChain.catch((err: unknown) => {
      this.#lastSaveError = err;
    });
  }

  #scheduleEmit(): void {
    if (this.#emitTimer !== undefined) return;
    const wait = Math.max(0, this.#lastEmit + this.#emitInterval - Date.now());
    this.#emitTimer = setTimeout(() => {
      this.#emitTimer = undefined;
      this.#emit();
    }, wait);
  }

  #emit(): void {
    this.#lastEmit = Date.now();
    const snap = this.snapshot();
    for (const listener of this.#listeners) {
      try {
        listener(snap);
      } catch (err) {
        console.error('[store] snapshot listener failed', err);
      }
    }
  }
}
