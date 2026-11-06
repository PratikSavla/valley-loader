// SPDX-License-Identifier: AGPL-3.0-only
import type { AppSnapshot, NexusUser, PrereqCheck, ProfileState, ResolveOptions } from './types';

/** API exposed on `window.valley` by the preload script. Every call is an ipcRenderer.invoke. */
export interface ValleyApi {
  getSnapshot(): Promise<AppSnapshot>;
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;

  runPrereqChecks(): Promise<PrereqCheck[]>;
  completeOnboarding(): Promise<void>;
  dismissHint(id: string): Promise<void>;

  /** Validates the key against Nexus, stores it encrypted, returns the user. Throws on invalid key. */
  setApiKey(key: string): Promise<NexusUser>;
  clearApiKey(): Promise<void>;
  /** Opens a folder picker; returns the chosen game path, undefined when cancelled; throws for a wrong folder. */
  pickGameFolder(): Promise<string | undefined>;
  /** Registers this app as the macOS handler for nxm:// links. */
  registerNxmHandler(): Promise<boolean>;
  /** Opens the built-in Nexus window on the login page. */
  openNexusLogin(): Promise<void>;

  /** Accepts a collection URL / slug / nxm collection link; creates or refreshes the profile plan. */
  resolveCollection(input: string, opts?: ResolveOptions): Promise<ProfileState>;
  /** Drops the collection link waiting for confirmation (AppSnapshot.pendingCollection). */
  dismissPendingCollection(): Promise<void>;
  setActiveProfile(slug: string): Promise<void>;
  setModSelected(slug: string, key: string, selected: boolean): Promise<void>;
  startInstall(slug: string): Promise<void>;
  pauseInstall(slug: string): Promise<void>;
  /** Re-open the Nexus window on the current needsClick mod. */
  focusNexusWindow(): Promise<void>;
  /** For `manual`/`browse` mods: pick a downloaded archive from disk and install it. */
  pickManualFile(slug: string, key: string): Promise<void>;
  retryMod(slug: string, key: string): Promise<void>;
  removeProfile(slug: string): Promise<void>;
  launchGame(slug: string): Promise<void>;
  revealProfile(slug: string): Promise<void>;
  /** Looks for a newer published revision of one profile (all profiles when omitted); results land in ProfileState.update. */
  checkForUpdates(slug?: string): Promise<void>;
  /** Moves a profile to the newer revision found by checkForUpdates. Refused while installing; never starts installs. */
  applyUpdate(slug: string): Promise<ProfileState>;
  /** Only nexusmods.com / smapi.io / stardewvalleywiki.com URLs are opened. */
  openExternal(url: string): Promise<void>;
}

export const IPC = {
  snapshot: 'valley:snapshot',
  snapshotPush: 'valley:snapshot-push',
  runPrereqChecks: 'valley:prereqs',
  completeOnboarding: 'valley:onboarding-complete',
  dismissHint: 'valley:dismiss-hint',
  setApiKey: 'valley:set-api-key',
  clearApiKey: 'valley:clear-api-key',
  pickGameFolder: 'valley:pick-game-folder',
  registerNxmHandler: 'valley:register-nxm',
  openNexusLogin: 'valley:nexus-login',
  resolveCollection: 'valley:resolve-collection',
  dismissPendingCollection: 'valley:dismiss-pending-collection',
  setActiveProfile: 'valley:set-active-profile',
  setModSelected: 'valley:set-mod-selected',
  startInstall: 'valley:start-install',
  pauseInstall: 'valley:pause-install',
  focusNexusWindow: 'valley:focus-nexus',
  pickManualFile: 'valley:pick-manual-file',
  retryMod: 'valley:retry-mod',
  removeProfile: 'valley:remove-profile',
  launchGame: 'valley:launch-game',
  revealProfile: 'valley:reveal-profile',
  checkForUpdates: 'valley:check-updates',
  applyUpdate: 'valley:apply-update',
  openExternal: 'valley:open-external',
} as const satisfies Record<string, string>;
