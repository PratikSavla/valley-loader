// SPDX-License-Identifier: AGPL-3.0-only
// zod schema + defaults for <userData>/state.json. Pure, no Electron imports.
import { z } from 'zod';
import type { ModStatus, PlannedMod, ProfileState, Settings } from '@shared/types';

export const STATE_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  onboardingComplete: false,
  dismissedHints: [],
  maxConcurrentDownloads: 3,
};

/** Statuses that only make sense while the app is running. */
export const TRANSIENT_STATUSES: ReadonlySet<ModStatus> = new Set<ModStatus>([
  'resolving',
  'queued',
  'downloading',
  'installing',
]);

const statusSchema = z.enum([
  'pending',
  'needsClick',
  'resolving',
  'queued',
  'downloading',
  'installing',
  'installed',
  'skipped',
  'manual',
  'failed',
]);

const plannedModSchema = z.object({
  key: z.string().min(1),
  name: z.string(),
  version: z.string(),
  author: z.string().optional(),
  optional: z.boolean(),
  selected: z.boolean(),
  phase: z.number(),
  order: z.number(),
  sourceType: z.enum(['nexus', 'bundle', 'direct', 'browse', 'manual']),
  modId: z.number().optional(),
  fileId: z.number().optional(),
  md5: z.string().optional(),
  fileSize: z.number().optional(),
  logicalFilename: z.string().optional(),
  fileExpression: z.string().optional(),
  url: z.string().optional(),
  instructions: z.string().optional(),
  status: statusSchema,
  error: z.string().optional(),
  warnings: z.array(z.string()).default([]),
  installedFolders: z.array(z.string()).optional(),
});

const diffSchema = z.object({
  fromRevision: z.number(),
  toRevision: z.number(),
  added: z.array(z.object({ name: z.string(), version: z.string(), modId: z.number(), fileId: z.number(), optional: z.boolean() })),
  removed: z.array(z.object({ name: z.string(), version: z.string() })),
  changed: z.array(z.object({ name: z.string(), fromVersion: z.string(), toVersion: z.string(), modId: z.number() })),
  unchanged: z.number(),
  clicksNeeded: z.number(),
  newSmapiRequirement: z.string().optional(),
  unavailable: z.number().optional(),
});

/** ProfileState.update; dropped (not fatal) when it doesn't parse, since the next check rebuilds it. */
const updateSchema = z
  .object({
    latestRevision: z.number(),
    checkedAt: z.string(),
    diff: diffSchema.optional(),
    error: z.string().optional(),
  })
  .optional()
  .catch(undefined);

const profileSchema = z.object({
  slug: z.string().min(1),
  revision: z.number(),
  name: z.string(),
  author: z.string(),
  summary: z.string().optional(),
  tileImageUrl: z.string().optional(),
  totalSize: z.number(),
  profileDir: z.string().min(1),
  modsDir: z.string().min(1),
  installInstructions: z.string().optional(),
  smapiRequirement: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  running: z.boolean().default(false),
  mods: z.array(plannedModSchema),
  update: updateSchema,
});

const settingsSchema = z.object({
  gamePath: z.string().optional(),
  onboardingComplete: z.boolean().default(false),
  dismissedHints: z.array(z.string()).default([]),
  maxConcurrentDownloads: z.number().int().min(1).max(8).default(3),
});

export const persistedStateSchema = z.object({
  version: z.number().optional(),
  settings: settingsSchema.default(DEFAULT_SETTINGS),
  profiles: z.array(profileSchema).default([]),
  activeSlug: z.string().optional(),
});

export interface PersistedState {
  settings: Settings;
  profiles: ProfileState[];
  activeSlug?: string;
}

/** Drops undefined keys zod leaves behind so snapshots stay clean. */
function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** A mod as it should look after an app restart: no transient status, no progress. */
export function resetTransientMod(mod: PlannedMod): PlannedMod {
  const next: PlannedMod = { ...mod };
  delete next.progress;
  if (TRANSIENT_STATUSES.has(next.status)) next.status = 'pending';
  return next;
}

/** Parses state.json text. Throws with a readable message when it is corrupt. */
export function parsePersistedState(text: string): PersistedState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`state.json is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  const result = persistedStateSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? '' : ` at ${issue.path.join('.') || '(root)'}: ${issue.message}`;
    throw new Error(`state.json has an unexpected shape${where}`, { cause: result.error });
  }
  const data = result.data;
  const state: PersistedState = {
    settings: stripUndefined({ ...DEFAULT_SETTINGS, ...data.settings }),
    profiles: data.profiles.map((p) => ({
      ...stripUndefined(p),
      running: false,
      mods: p.mods.map((m) => resetTransientMod(stripUndefined(m))),
    })),
  };
  if (data.activeSlug !== undefined && state.profiles.some((p) => p.slug === data.activeSlug)) {
    state.activeSlug = data.activeSlug;
  }
  return state;
}

/** JSON written to disk: progress is never persisted. */
export function serializeState(state: PersistedState): string {
  const profiles = state.profiles.map((p) => ({
    ...p,
    mods: p.mods.map((m) => {
      const copy: PlannedMod = { ...m };
      delete copy.progress;
      return copy;
    }),
  }));
  return `${JSON.stringify({ version: STATE_VERSION, ...state, profiles }, null, 2)}\n`;
}
