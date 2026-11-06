// SPDX-License-Identifier: AGPL-3.0-only
// Per-profile install orchestrator (architecture doc "click-through flow"). No Electron imports: the
// Nexus window, dialogs, shell and Steam/SMAPI launching are injected (see RunnerDeps), so it is testable.
//
// - resolveCollection: link → GraphQL summary → archive (needs API key) → collection.json → plan → profile.
// - startInstall: bundle/cached/Premium/direct mods download (≤ maxConcurrentDownloads) and install in the
//   background; installs are serialised through one mutex (deploy writes one Mods dir). Free-account Nexus
//   and browse mods become 'needsClick' and a cursor shows them one by one in the Nexus window.
// - nxm links (Nexus window or macOS open-url) → handleNxmUrl; window downloads → handleCapturedDownload.
//   A collection link from outside the app only becomes pendingCollection: the UI asks before resolving it.
import { SMAPI_MOD_ID, type PrereqCheck, type ProfileState, type ResolveOptions } from '@shared/types';
import { DownloadQueue, type DownloadQueueOptions } from '../download/queue';
import { advanceCursor, handOffCursor, handleCapturedDownload, handleNxm, showInWindow } from './runner-clicks';
import { Mutex, SETTLED, byOrder, errorMessage, isHeld, isPremium, jobKey, resumeStatus, runnerPaths, type RunnerCtx } from './runner-context';
import { ensureUser, launchGame, refreshGame, removeProfileDir, requireAccount, runPrereqChecks } from './runner-game';
import { installArchive, uninstallMod } from './runner-install';
import { ResolveLock } from './runner-lock';
import { NEED_API_KEY, resolveCollection } from './runner-resolve';
import { parseCollectionInput } from '../nexus/nxm';
import { startMods } from './runner-sources';
import type { RunnerDeps } from './runner-types';

export { NEED_API_KEY } from './runner-resolve';
export { NEXUS_UNREACHABLE, STEAM_STARTING } from './runner-game';
export type { RunnerDeps, NexusWindowLike, CapturedDownload, ShowModArgs } from './runner-types';

export class Runner {
  readonly #ctx: RunnerCtx;
  readonly #inflight = new Set<Promise<unknown>>();
  readonly #unsubscribe: (() => void)[] = [];
  readonly #lock: ResolveLock;
  #queue: DownloadQueue | undefined;
  #queueConcurrency = 0;

  constructor(private readonly deps: RunnerDeps) {
    this.#lock = new ResolveLock(deps.store);
    this.#ctx = {
      deps,
      store: deps.store,
      paths: runnerPaths(deps.userDataDir),
      mutex: new Mutex(),
      clicks: { total: 0, done: 0 },
      jobs: new Map(),
      held: new Map(),
      queue: () => this.#getQueue(),
      track: (work, what) => this.#track(work, what),
      advanceCursor: (slug) => advanceCursor(this.#ctx, slug),
      checkDone: (slug) => this.#checkDone(slug),
    };
    this.#unsubscribe.push(
      deps.nexusWindow.onNxm((url) => this.#track(this.handleNxmUrl(url), 'nxm link')),
      deps.nexusWindow.onDownload((d) => this.#track(handleCapturedDownload(this.#ctx, d), 'captured download')),
    );
  }

  get downloadsDir(): string {
    return this.#ctx.paths.downloadsDir;
  }

  /** Holds the collection's lock for the whole resolve: Start, Remove, toggles and retries wait for it. */
  async resolveCollection(input: string, opts: ResolveOptions = {}): Promise<ProfileState> {
    const ref = parseCollectionInput(input);
    const profile = await this.#lock.hold(ref.slug, () => resolveCollection(this.#ctx, input, opts));
    const pending = this.#ctx.store.transient.pendingCollection;
    if (pending !== undefined && pending.slug.toLowerCase() === profile.slug.toLowerCase()) this.dismissPendingCollection();
    return profile;
  }

  /** Forgets a collection link that is waiting for the user's confirmation. */
  dismissPendingCollection(): void {
    this.#ctx.store.setTransient({ pendingCollection: undefined });
  }

  /**
   * Handles an nxm:// link from the Nexus window or macOS. A collection link is only a proposal: it is stored
   * as pendingCollection and the UI asks the user before anything is resolved.
   */
  async handleNxmUrl(url: string): Promise<void> {
    const link = await handleNxm(this.#ctx, url);
    if (link?.kind !== 'collection') return;
    const pendingCollection: { slug: string; url: string; revision?: number } = { slug: link.slug, url };
    if (link.revision !== 'latest') pendingCollection.revision = link.revision;
    this.#ctx.store.setTransient({ pendingCollection });
  }

  /** Validates the saved key if no account is known yet; returns why Nexus couldn't be reached, if it couldn't. */
  async ensureUser(): Promise<string | undefined> {
    return ensureUser(this.#ctx);
  }

  async startInstall(slug: string): Promise<void> {
    const { store } = this.#ctx;
    const before = store.requireProfile(slug);
    if (before.running) return;
    this.#lock.assertFree(slug);
    const nexusLeft = before.mods.some(
      (m) => m.selected && m.sourceType === 'nexus' && m.modId !== SMAPI_MOD_ID && (m.status === 'failed' || !SETTLED.has(m.status)),
    );
    if (nexusLeft) await requireAccount(this.#ctx, NEED_API_KEY);
    await this.#prepareResume(slug);
    const profile = store.requireProfile(slug);
    // Mods with work still in flight (e.g. a download that outlived a Pause) finish on their own.
    const todo = profile.mods.filter((m) => m.selected && !SETTLED.has(m.status) && !isHeld(this.#ctx, slug, m.key)).sort(byOrder);
    store.updateProfile(slug, { running: true });
    store.setTransient({ lastError: undefined });
    const holder = store.transient.awaitingClick;
    const otherHoldsCursor = holder !== undefined && holder.slug !== slug && store.getProfile(holder.slug)?.running === true;
    if (!otherHoldsCursor) this.#ctx.clicks = { slug, total: 0, done: 0 };
    try {
      const clicks = await startMods(this.#ctx, slug, todo);
      if (this.#ctx.clicks.slug === slug) this.#ctx.clicks.total = clicks;
    } catch (err) {
      store.updateProfile(slug, { running: false });
      throw new Error(`Could not start installing "${profile.name}": ${errorMessage(err)}`, { cause: err });
    }
    await advanceCursor(this.#ctx, slug);
    this.#checkDone(slug);
  }

  async pauseInstall(slug: string): Promise<void> {
    const { store } = this.#ctx;
    store.requireProfile(slug);
    store.updateProfile(slug, { running: false });
    // Only this profile's downloads: another running profile keeps going.
    const prefix = jobKey(slug, '');
    this.#queue?.cancelWhere((key) => key.startsWith(prefix));
    const premium = isPremium(this.#ctx);
    for (const mod of store.requireProfile(slug).mods) {
      if (['resolving', 'queued', 'downloading'].includes(mod.status)) {
        store.updateMod(slug, mod.key, { status: resumeStatus(mod, premium), progress: undefined });
      }
    }
    if (store.transient.awaitingClick?.slug === slug) {
      store.setTransient({ awaitingClick: undefined });
      await this.#handOffOrClose();
    }
  }

  async setModSelected(slug: string, key: string, selected: boolean): Promise<void> {
    const { store } = this.#ctx;
    const mod = store.requireMod(slug, key);
    this.#lock.assertFree(slug);
    if (!mod.optional && !selected) throw new Error(`"${mod.name}" is required by the collection and can't be turned off.`);
    if (mod.selected === selected) return;
    if (!selected) {
      store.updateMod(slug, key, { selected: false, status: 'skipped', error: undefined, progress: undefined });
      if (mod.installedFolders !== undefined) {
        await this.#ctx.mutex.run(async () => {
          await uninstallMod(this.#ctx, slug, key);
          store.updateMod(slug, key, { installedFolders: undefined });
        });
      }
      if (store.transient.awaitingClick?.key === key) await advanceCursor(this.#ctx, slug);
    } else {
      store.updateMod(slug, key, { selected: true, status: mod.sourceType === 'manual' ? 'manual' : 'pending' });
      // A download still in flight from before the deselect installs it once it lands.
      if (store.requireProfile(slug).running && !isHeld(this.#ctx, slug, key)) await this.#restart(slug, key);
    }
    this.#checkDone(slug);
  }

  async retryMod(slug: string, key: string): Promise<void> {
    const { store } = this.#ctx;
    const mod = store.requireMod(slug, key);
    this.#lock.assertFree(slug);
    if (mod.status === 'installed') return;
    store.updateMod(slug, key, { status: mod.sourceType === 'manual' ? 'manual' : 'pending', error: undefined, selected: true });
    if (store.requireProfile(slug).running) await this.#restart(slug, key);
    else await this.startInstall(slug);
  }

  async pickManualFile(slug: string, key: string): Promise<void> {
    const { store } = this.#ctx;
    const mod = store.requireMod(slug, key);
    this.#lock.assertFree(slug);
    const path = await this.deps.pickArchive(`Choose the downloaded archive for ${mod.name}`);
    if (path === undefined) return;
    if (!mod.selected) store.updateMod(slug, key, { selected: true });
    await installArchive(this.#ctx, slug, key, path, { userPicked: true });
    const after = store.requireMod(slug, key);
    if (after.status === 'failed') throw new Error(after.error ?? `Could not install ${mod.name}`);
    if (after.needsRepack === true) throw new Error('That file is a .rar archive too. Unpack it, compress the folder to a .zip, then pick the .zip.');
    if (store.transient.awaitingClick?.key === key) await advanceCursor(this.#ctx, slug);
    this.#checkDone(slug);
  }

  async removeProfile(slug: string): Promise<void> {
    this.#lock.assertFree(slug);
    await removeProfileDir(this.#ctx, slug);
  }

  async launchGame(slug: string): Promise<void> {
    await launchGame(this.#ctx, slug);
  }

  revealProfile(slug: string): void {
    this.deps.showItemInFolder(this.#ctx.store.requireProfile(slug).modsDir);
  }

  async focusNexusWindow(): Promise<void> {
    const awaiting = this.#ctx.store.transient.awaitingClick;
    const mod = awaiting && this.#ctx.store.getMod(awaiting.slug, awaiting.key);
    if (awaiting && mod) await showInWindow(this.#ctx, mod, awaiting.index, awaiting.total);
    else await this.deps.nexusWindow.open('https://www.nexusmods.com/stardewvalley');
  }

  async openNexusLogin(): Promise<void> {
    await this.deps.nexusWindow.openLogin();
  }

  async refreshGame(): Promise<void> {
    await refreshGame(this.#ctx);
  }

  async runPrereqChecks(): Promise<PrereqCheck[]> {
    return runPrereqChecks(this.#ctx);
  }

  /** True while a download/install for the profile is still in flight (it can outlive a Pause). */
  hasWorkInFlight(slug: string): boolean {
    const prefix = jobKey(slug, '');
    return [...this.#ctx.held.keys()].some((k) => k.startsWith(prefix));
  }

  /** Resolves once all background work (downloads, installs) has settled. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  dispose(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#queue?.cancelAll();
  }

  /**
   * Before a (re)start: failed mods get another go (Resume doubles as "retry all failed"), and an outdated-SMAPI
   * row is re-checked against a fresh game detection.
   */
  async #prepareResume(slug: string): Promise<void> {
    const { store } = this.#ctx;
    for (const m of store.requireProfile(slug).mods) {
      if (m.selected && m.status === 'failed') {
        store.updateMod(slug, m.key, { status: m.sourceType === 'manual' ? 'manual' : 'pending', error: undefined });
      }
    }
    const smapiRows = store.requireProfile(slug).mods.filter((m) => m.selected && m.modId === SMAPI_MOD_ID && m.status !== 'installed');
    if (smapiRows.length > 0) {
      await refreshGame(this.#ctx).catch((err: unknown) => console.error(`[runner] ${slug}: game re-detection failed`, err));
    }
  }

  /** After the cursor was cleared: give it to another running profile, or close the Nexus window. */
  async #handOffOrClose(): Promise<void> {
    await handOffCursor(this.#ctx);
    if (this.#ctx.store.transient.awaitingClick === undefined) this.deps.nexusWindow.close();
  }

  async #restart(slug: string, key: string): Promise<void> {
    await startMods(this.#ctx, slug, [this.#ctx.store.requireMod(slug, key)]);
    await advanceCursor(this.#ctx, slug);
  }

  #track(work: Promise<unknown>, what: string): void {
    const p = work.catch((err: unknown) => {
      console.error(`[runner] ${what} failed`, err);
      this.#ctx.store.setTransient({ lastError: `${what}: ${errorMessage(err)}` });
    });
    this.#inflight.add(p);
    void p.finally(() => this.#inflight.delete(p));
  }

  #checkDone(slug: string): void {
    const { store } = this.#ctx;
    const profile = store.getProfile(slug);
    if (profile === undefined || !profile.running) return;
    if (!profile.mods.every((m) => !m.selected || SETTLED.has(m.status))) return;
    store.updateProfile(slug, { running: false });
    if (store.transient.awaitingClick?.slug === slug || store.transient.awaitingClick === undefined) {
      store.setTransient({ awaitingClick: undefined });
      this.#track(this.#handOffOrClose(), 'show the next mod to click');
    }
  }

  #getQueue(): DownloadQueue {
    const concurrency = this.#ctx.store.settings.maxConcurrentDownloads || 3;
    const idle = this.#queue === undefined || this.#queue.activeCount + this.#queue.pendingCount === 0;
    if (this.#queue === undefined || (idle && concurrency !== this.#queueConcurrency)) {
      const opts: DownloadQueueOptions = {
        dir: this.#ctx.paths.downloadsDir,
        concurrency,
        onProgress: (job, received, total) => this.#onProgress(job, received, total),
      };
      if (this.deps.fetchImpl) opts.fetchImpl = this.deps.fetchImpl;
      if (this.deps.retryBaseDelayMs !== undefined) opts.retryBaseDelayMs = this.deps.retryBaseDelayMs;
      this.#queue = new DownloadQueue(opts);
      this.#queueConcurrency = concurrency;
    }
    return this.#queue;
  }

  #onProgress(job: string, received: number, total: number): void {
    const target = this.#ctx.jobs.get(job);
    if (target === undefined) return;
    const mod = this.#ctx.store.getMod(target.slug, target.key);
    if (mod === undefined) return;
    const progress = { received, total };
    if (mod.status === 'queued') this.#ctx.store.updateMod(target.slug, target.key, { status: 'downloading', progress });
    else if (mod.status === 'downloading') this.#ctx.store.updateMod(target.slug, target.key, { progress });
  }
}
