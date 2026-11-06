// SPDX-License-Identifier: AGPL-3.0-only
// Shared data types used by the main process, preload and renderer.
// Keep this file free of Node/Electron imports — the renderer imports it too.

export const GAME_DOMAIN = 'stardewvalley';
export const SMAPI_MOD_ID = 2400;

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'pending';

export type PrereqId =
  | 'platform'
  | 'game'
  | 'smapi'
  | 'disk'
  | 'apiKey'
  | 'nexusLogin'
  | 'nxmHandler';

export interface PrereqCheck {
  id: PrereqId;
  title: string;
  status: CheckStatus;
  /** One-line result, e.g. "Found Stardew Valley 1.6.15". */
  detail: string;
  /** Plain-language steps a new user can follow to fix a warn/fail. Empty when passing. */
  fixSteps: string[];
  /** Optional help link (Nexus or SMAPI pages only). */
  fixUrl?: string;
  /** Renderer shows an action button for these. */
  action?: 'pickGameFolder' | 'enterApiKey' | 'openNexusLogin' | 'registerNxm';
}

export interface NexusUser {
  userId: number;
  name: string;
  isPremium: boolean;
  isSupporter: boolean;
  avatarUrl?: string;
}

export interface GameInfo {
  /** Folder that holds the `StardewModdingAPI` launcher, e.g. ".../Stardew Valley/Contents/MacOS". */
  gamePath: string;
  gameVersion?: string;
  smapiInstalled: boolean;
  smapiVersion?: string;
}

export interface CollectionSummary {
  slug: string;
  revision: number;
  name: string;
  author: string;
  summary?: string;
  tileImageUrl?: string;
  totalSize: number;
  modCount: number;
  adultContent: boolean;
  /** API path like "/v2/collections/994/revisions/802199/download_link". */
  downloadLinkPath: string;
}

export type ModSourceType = 'nexus' | 'bundle' | 'direct' | 'browse' | 'manual';

export type ModStatus =
  | 'pending' // not started
  | 'needsClick' // free account: waiting for user to click Slow download
  | 'resolving' // got nxm link / premium: asking API for the CDN URL
  | 'queued' // waiting for a download slot
  | 'downloading'
  | 'installing'
  | 'installed'
  | 'skipped' // optional and not selected
  | 'manual' // needs the user to supply a file / not auto-installable
  | 'failed';

export interface PlannedMod {
  /** Stable key: "nexus:<modId>:<fileId>", "bundle:<fileExpression>", "direct:<url>", etc. */
  key: string;
  name: string;
  version: string;
  author?: string;
  optional: boolean;
  selected: boolean;
  phase: number;
  /** Position in deploy order; higher order wins file conflicts. */
  order: number;
  sourceType: ModSourceType;
  modId?: number;
  fileId?: number;
  md5?: string;
  fileSize?: number;
  logicalFilename?: string;
  /** bundle: path inside the collection archive's bundled/ folder. */
  fileExpression?: string;
  url?: string;
  instructions?: string;
  status: ModStatus;
  error?: string;
  progress?: { received: number; total: number };
  /** Non-fatal notes shown in the UI (FOMOD choices ignored, root Content mod, ...). */
  warnings: string[];
  /** Folder names this mod deployed under Mods/. */
  installedFolders?: string[];
}

export interface ProfileState {
  slug: string;
  revision: number;
  name: string;
  author: string;
  summary?: string;
  tileImageUrl?: string;
  totalSize: number;
  profileDir: string;
  modsDir: string;
  installInstructions?: string;
  /** Minimum SMAPI version the collection lists, if it includes SMAPI (mod 2400). */
  smapiRequirement?: string;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  mods: PlannedMod[];
  /** Result of the last "is there a newer revision?" check. Absent until the first check. */
  update?: ProfileUpdate;
}

/** A mod a newer revision adds (Nexus mods only; see RevisionDiff). */
export interface RevisionDiffAdded {
  name: string;
  version: string;
  modId: number;
  fileId: number;
  optional: boolean;
}

export interface RevisionDiffRemoved {
  name: string;
  version: string;
}

/** Same Nexus mod, different pinned file. */
export interface RevisionDiffChanged {
  name: string;
  fromVersion: string;
  toVersion: string;
  modId: number;
}

/**
 * What moving a profile to a newer collection revision would change. Covers Nexus mods only: bundled (and
 * direct/browse/manual) mods are not part of Nexus's revision file list, so their changes are not shown.
 */
export interface RevisionDiff {
  fromRevision: number;
  toRevision: number;
  added: RevisionDiffAdded[];
  removed: RevisionDiffRemoved[];
  changed: RevisionDiffChanged[];
  /** Nexus mods whose pinned file stays the same. */
  unchanged: number;
  /** Slow-download clicks a free account needs (required or switched-on added/changed mods not already downloaded); 0 for Premium. */
  clicksNeeded: number;
  /** SMAPI version the new revision lists, when it adds SMAPI or changes its version. */
  newSmapiRequirement?: string;
  /** Files the new revision pins that are no longer on Nexus Mods (deleted or archived by the mod author). */
  unavailable?: number;
}

/** Stored on ProfileState.update by the revision check. */
export interface ProfileUpdate {
  /** Newest published revision seen (equals ProfileState.revision when up to date). */
  latestRevision: number;
  /** ISO time of the last check attempt. */
  checkedAt: string;
  /** Present when latestRevision is newer than the profile's revision. */
  diff?: RevisionDiff;
  /** Why the last check failed (offline, Nexus down…). */
  error?: string;
}

export interface Settings {
  gamePath?: string;
  onboardingComplete: boolean;
  dismissedHints: string[];
  maxConcurrentDownloads: number;
}

/** Everything the renderer needs to draw itself. Pushed on every change. */
export interface AppSnapshot {
  settings: Settings;
  user?: NexusUser;
  hasApiKey: boolean;
  game?: GameInfo;
  profiles: ProfileState[];
  activeSlug?: string;
  /** Mod currently shown in the Nexus window for the user to click. */
  awaitingClick?: { slug: string; key: string; index: number; total: number };
  rateLimit?: { daily?: number; hourly?: number };
  lastError?: string;
  /** Bumped every time lastError is set, so the UI can show a repeated identical error again. */
  lastErrorId?: number;
  /** Nexus rejected the saved API key (401/403); the user has to enter a new one. */
  apiKeyError?: string;
  /** A collection link that arrived from outside the app (nxm:// link); only resolved after the user confirms. */
  pendingCollection?: PendingCollection;
  /** Lower-cased slugs of collections being resolved or updated right now (Start, Remove etc. wait for them). */
  resolving?: string[];
}

/** A collection link waiting for the user's confirmation (see AppSnapshot.pendingCollection). */
export interface PendingCollection {
  slug: string;
  /** undefined = latest revision. */
  revision?: number;
  url: string;
}

/** Options for resolving a collection. */
export interface ResolveOptions {
  /** Allow switching an existing profile to an older revision (removes mods that revision lacks). */
  allowDowngrade?: boolean;
}
