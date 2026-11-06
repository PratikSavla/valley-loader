// SPDX-License-Identifier: AGPL-3.0-only
// Turns a parsed collection.json into an ordered install plan. Pure.
import { GAME_DOMAIN, SMAPI_MOD_ID } from '@shared/types';
import type { ModStatus, PlannedMod } from '@shared/types';
import { computeDeployOrder } from './order';
import type { OrderEdge } from './order';
import { referenceMatches } from './reference';
import type { CollectionJson, CollectionModEntry, ModReference } from './schema';

export { referenceMatches, isFuzzyVersion } from './reference';

export const WARN_CHOICES =
  'This mod has installer options (FOMOD) in the collection; Valley Loader installs its default files — check it in game.';

/** Statuses that only make sense while the app is running; on re-plan they start over. */
const TRANSIENT: ReadonlySet<ModStatus> = new Set<ModStatus>([
  'resolving',
  'queued',
  'downloading',
  'installing',
]);

/** Stable key for a collection mod entry (see PlannedMod.key). */
export function modKey(entry: CollectionModEntry): string {
  const s = entry.source;
  switch (s.type) {
    case 'nexus':
      return `nexus:${s.modId ?? 'unknown'}:${s.fileId ?? 'unknown'}`;
    case 'bundle':
      return `bundle:${s.fileExpression ?? s.logicalFilename ?? entry.name}`;
    case 'direct':
    case 'browse':
      return `${s.type}:${s.url ?? entry.name}`;
    case 'manual':
      return `manual:${entry.name}`;
  }
}

/** modKey for every entry, suffixing "#2", "#3", … onto repeats so keys are unique. */
export function uniqueModKeys(entries: CollectionModEntry[]): string[] {
  const used = new Set<string>();
  return entries.map((entry) => {
    const base = modKey(entry);
    let key = base;
    for (let n = 2; used.has(key); n += 1) key = `${base}#${n}`;
    used.add(key);
    return key;
  });
}

function matchingIndices(ref: ModReference, entries: CollectionModEntry[]): number[] {
  const out: number[] = [];
  entries.forEach((entry, index) => {
    if (referenceMatches(ref, entry)) out.push(index);
  });
  return out;
}

/** "A before B" → edge A→B; "A after B" → edge B→A. Other rule types don't affect order. */
export function orderingEdges(collection: CollectionJson): OrderEdge[] {
  const edges: OrderEdge[] = [];
  for (const rule of collection.modRules) {
    if (rule.type !== 'before' && rule.type !== 'after') continue;
    const sources = matchingIndices(rule.source, collection.mods);
    const references = matchingIndices(rule.reference, collection.mods);
    for (const s of sources) {
      for (const r of references) {
        if (s !== r) edges.push(rule.type === 'before' ? { from: s, to: r } : { from: r, to: s });
      }
    }
  }
  return edges;
}

function isNonEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function entryWarnings(entry: CollectionModEntry): string[] {
  const warnings: string[] = [];
  if (isNonEmpty(entry.choices)) warnings.push(WARN_CHOICES);
  // mods[].patches and mods[].hashes are applied at install time (install/runner-extras.ts), which warns per file.
  if (entry.domainName !== GAME_DOMAIN) {
    warnings.push(`This mod is listed for "${entry.domainName}", not Stardew Valley — it may not work.`);
  }
  return warnings;
}

function baseStatus(entry: CollectionModEntry, selected: boolean): ModStatus {
  if (!selected) return 'skipped';
  return entry.source.type === 'manual' ? 'manual' : 'pending';
}

function plannedFromEntry(entry: CollectionModEntry, key: string, order: number): PlannedMod {
  const s = entry.source;
  const selected = !entry.optional;
  return {
    key,
    name: entry.name,
    version: entry.version,
    author: entry.author,
    optional: entry.optional,
    selected,
    phase: entry.phase,
    order,
    sourceType: s.type,
    modId: s.modId,
    fileId: s.fileId,
    md5: s.md5,
    fileSize: s.fileSize,
    logicalFilename: s.logicalFilename,
    fileExpression: s.fileExpression,
    url: s.url,
    instructions: s.instructions ?? entry.instructions,
    status: baseStatus(entry, selected),
    warnings: entryWarnings(entry),
  };
}

/** Keeps the user's progress from an earlier plan of the same collection. */
function carryOver(mod: PlannedMod, entry: CollectionModEntry, prev: PlannedMod): PlannedMod {
  const selected = mod.optional ? prev.selected : true;
  let status = prev.status;
  if (TRANSIENT.has(status) || (status === 'skipped' && selected)) status = baseStatus(entry, selected);
  if (!selected && status !== 'installed') status = 'skipped';
  const next: PlannedMod = { ...mod, selected, status };
  if (prev.installedFolders !== undefined) next.installedFolders = [...prev.installedFolders];
  if (prev.error !== undefined) next.error = prev.error;
  return next;
}

/**
 * An optional Nexus mod whose pinned file changed gets a new key, so carryOver can't find it. Keep the user's
 * choice from the previous plan's entry for the same mod: same modId and file name first, else the only leftover
 * entry of that modId (a mod listed twice, e.g. main file + config pack, is never mixed up). Only `selected` is
 * taken: status and installedFolders belong to the old file, which cleanupPrevious unstages.
 */
function takePreviousChoice(mod: PlannedMod, leftovers: PlannedMod[]): PlannedMod | undefined {
  if (mod.sourceType !== 'nexus' || mod.modId === undefined) return undefined;
  const same = leftovers.filter((p) => p.modId === mod.modId);
  const hit = same.find((p) => p.logicalFilename !== undefined && p.logicalFilename === mod.logicalFilename) ?? (same.length === 1 ? same[0] : undefined);
  if (hit !== undefined) leftovers.splice(leftovers.indexOf(hit), 1);
  return hit;
}

function cycleWarning(a: string, b: string): string {
  return `Load-order rule between "${a}" and "${b}" is part of a cycle and was ignored.`;
}

/**
 * Build the plan: one PlannedMod per entry, ordered by phase, then by before/after modRules
 * (topological, stable on original index; cycles broken with a warning), `order` = final index.
 * When `previous` is given, carry over status/selected/installedFolders for mods with the same key, and keep an
 * optional mod switched on when only its pinned file changed (see takePreviousChoice).
 */
export function buildPlan(collection: CollectionJson, previous?: PlannedMod[]): PlannedMod[] {
  const entries = collection.mods;
  const keys = uniqueModKeys(entries);
  const { sequence, droppedEdges } = computeDeployOrder(
    entries.map((e) => e.phase),
    orderingEdges(collection),
  );
  const extraWarnings = new Map<number, string[]>();
  for (const { from, to } of droppedEdges) {
    const text = cycleWarning(entries[from]?.name ?? '?', entries[to]?.name ?? '?');
    for (const index of [from, to]) {
      const list = extraWarnings.get(index) ?? [];
      if (!list.includes(text)) list.push(text);
      extraWarnings.set(index, list);
    }
  }
  const prevByKey = new Map((previous ?? []).map((p) => [p.key, p]));
  const nextKeys = new Set(keys);
  const leftovers = (previous ?? []).filter((p) => p.sourceType === 'nexus' && !nextKeys.has(p.key));
  return sequence.map((index, order) => {
    const entry = entries[index];
    const key = keys[index];
    if (entry === undefined || key === undefined) {
      throw new Error(`buildPlan: deploy order references missing mod index ${index}`);
    }
    const mod = plannedFromEntry(entry, key, order);
    mod.warnings.push(...(extraWarnings.get(index) ?? []));
    const prev = prevByKey.get(key);
    if (prev !== undefined) return carryOver(mod, entry, prev);
    // Required mods take their match too, so a mod listed with several files pairs one-to-one.
    const choice = takePreviousChoice(mod, leftovers);
    if (mod.optional && choice?.selected === true) return { ...mod, selected: true, status: baseStatus(entry, true) };
    return mod;
  });
}

/** Minimum SMAPI version if the collection includes SMAPI (Nexus mod 2400). */
export function smapiRequirement(collection: CollectionJson): string | undefined {
  const smapi = collection.mods.find((m) => m.source.modId === SMAPI_MOD_ID);
  if (smapi === undefined || smapi.version.trim() === '') return undefined;
  return smapi.version.trim();
}
