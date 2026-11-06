// SPDX-License-Identifier: AGPL-3.0-only
// Types shared by the runner helpers. No Electron imports: everything environment-specific is injected
// so the runner can be unit-tested with fakes.
import type { CollectionSummary, GameInfo } from '@shared/types';
import type { NexusClient } from '../nexus/api';
import type { Store } from '../state/store';

export interface ShowModArgs {
  modId: number;
  fileId: number;
  name: string;
  index: number;
  total: number;
}

/** Sub-folder of the downloads folder that window downloads are saved into (never a DownloadQueue cache path). */
export const CAPTURED_DIR_NAME = 'captured';

export interface CapturedDownload {
  /** Where the file was saved (only meaningful when ok). */
  path: string;
  /** Source URL with its query string removed. */
  url: string;
  /** Page that started the download (query string removed), when known. */
  pageUrl?: string;
  fileName: string;
  ok: boolean;
  error?: string;
}

/** What the runner needs from the built-in Nexus browser window (src/main/nexus/browser.ts). */
export interface NexusWindowLike {
  open(url: string, title?: string): Promise<void>;
  showMod(args: ShowModArgs): Promise<void>;
  openLogin(): Promise<void>;
  /** Heuristic from cookies; undefined when it cannot tell. Never opens a window. */
  isLoggedIn(): Promise<boolean | undefined>;
  onNxm(cb: (url: string) => void): () => void;
  onDownload(cb: (download: CapturedDownload) => void): () => void;
  focus(): void;
  close(): void;
}

/** The subset of NexusClient the runner calls (a fake in tests). */
export type NexusApiLike = Pick<
  NexusClient,
  'getCollection' | 'getCollectionArchiveUrl' | 'getModFileDownloadUrl' | 'hasApiKey' | 'rateLimit' | 'validate'
>;

export type ModFileUrlArgs = Parameters<NexusClient['getModFileDownloadUrl']>[0];

export interface RunnerDeps {
  store: Store;
  userDataDir: string;
  /** Current Nexus client (changes when the API key changes). */
  client: () => NexusApiLike;
  nexusWindow: NexusWindowLike;
  fetchImpl?: typeof fetch;
  /** Home folder used for game detection. */
  home: string;
  /** Lets the user pick an archive for a manual mod; undefined when cancelled. */
  pickArchive: (title: string) => Promise<string | undefined>;
  showItemInFolder: (path: string) => void;
  /** Starts the Steam client (`open -a Steam`). */
  openSteam: () => Promise<void>;
  isSteamRunning: () => Promise<boolean>;
  launchSmapi: (opts: { gamePath: string; modsDir: string }) => Promise<void>;
  detectGame: (home: string, configured?: string) => Promise<GameInfo | undefined>;
  /** macOS product version (e.g. "26.1"), undefined when unknown. */
  macosVersion: () => Promise<string | undefined>;
  /** app.isDefaultProtocolClient('nxm'). */
  isNxmHandlerRegistered: () => boolean;
  platform?: string;
  arch?: string;
  /** Unix seconds; injectable for nxm expiry tests. */
  nowSeconds?: () => number;
  /** Download retry base delay (tests use 0). */
  retryBaseDelayMs?: number;
}

export type { CollectionSummary };
