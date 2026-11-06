// SPDX-License-Identifier: AGPL-3.0-only
// Matches a Vortex modRules reference (IModReference) against a collection.json mod entry.
// Mirrors testRef() in Vortex's mod_management/util/testModReference.ts, with the collection
// entry standing in for an installed mod: source.md5 → fileMD5, source.tag → referenceTag,
// source.logicalFilename → logicalFileName, nexus modId/fileId → repo, source.fileExpression
// (or the entry name) → archive name. Pure.
import type { CollectionModEntry, ModReference } from './schema';

interface LookupInfo {
  fileMD5?: string;
  logicalFileName?: string;
  fileExpression?: string;
  name: string;
  version: string;
  repository?: string;
  modId?: number;
  fileId?: number;
  tag?: string;
}

/** Treat "" like a missing value: Vortex uses truthiness for most of these checks. */
function present(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function lookupInfo(entry: CollectionModEntry): LookupInfo {
  const s = entry.source;
  return {
    fileMD5: present(s.md5)?.toLowerCase(),
    logicalFileName: present(s.logicalFilename),
    fileExpression: present(s.fileExpression),
    name: entry.name,
    version: entry.version,
    repository: s.type === 'nexus' ? 'nexus' : undefined,
    modId: s.modId,
    fileId: s.fileId,
    tag: present(s.tag),
  };
}

/** Same rules as Vortex isFuzzyVersion: "*", "+prefer" and real semver ranges are fuzzy. */
export function isFuzzyVersion(versionMatch: string | undefined): boolean {
  const v = versionMatch?.trim();
  if (v === undefined || v === '') return false;
  if (v === '*' || v.endsWith('+prefer')) return true;
  return /^[<>=^~]|\s|\|\||(^|\.)[xX*](\.|$)/.test(v);
}

/** Rough semver.coerce: first "x[.y[.z]]" run, padded to three parts. */
function coerceVersion(version: string): string | undefined {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.split('+')[0] ?? '');
  if (m === null) return undefined;
  return `${Number(m[1])}.${Number(m[2] ?? 0)}.${Number(m[3] ?? 0)}`;
}

function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('')
    .map((ch) => {
      if (ch === '*') return '[^/]*';
      if (ch === '?') return '[^/]';
      return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${body}$`, 'i');
}

function equalsIgnoreCase(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

function hasIdentifyingMarker(
  mod: LookupInfo,
  ref: ModReference,
  fuzzy: boolean,
  allowTag: boolean,
): boolean {
  return (
    (!fuzzy && present(ref.fileMD5) !== undefined && mod.fileMD5 !== undefined) ||
    present(ref.fileExpression) !== undefined ||
    (present(ref.logicalFileName) !== undefined && mod.logicalFileName !== undefined) ||
    (ref.repo !== undefined && mod.repository !== undefined) ||
    (allowTag && present(ref.tag) !== undefined && mod.tag !== undefined)
  );
}

function fileExpressionMatches(mod: LookupInfo, expression: string): boolean {
  if (mod.fileExpression === undefined) return mod.name === expression;
  return mod.fileExpression === expression || globToRegExp(expression).test(mod.fileExpression);
}

function versionMatches(mod: LookupInfo, ref: ModReference, fuzzy: boolean): boolean {
  const wanted = present(ref.versionMatch);
  // Fuzzy ranges ("*", ">=x+prefer", "^x") are satisfied by whatever version the collection pins.
  if (wanted === undefined || fuzzy || mod.version === '') return true;
  if (mod.version === wanted) return true;
  if (present(ref.fileMD5)?.toLowerCase() === mod.fileMD5 && mod.fileMD5 !== undefined) return true;
  const coerced = coerceVersion(mod.version);
  return coerced !== undefined && coerced === coerceVersion(wanted);
}

/** Tag / md5 / repo checks; returns a final verdict, or undefined to keep checking file names. */
function identityVerdict(mod: LookupInfo, ref: ModReference, fuzzy: boolean): boolean | undefined {
  const tag = present(ref.tag);
  if (tag !== undefined) {
    if (mod.tag === tag) return true;
    // tags differ: without a stricter marker this would match anything
    if (!hasIdentifyingMarker(mod, ref, fuzzy, false)) return false;
  }
  const md5 = present(ref.fileMD5)?.toLowerCase();
  if (md5 !== undefined && !fuzzy && mod.fileMD5 !== md5) return false;
  if (ref.repo !== undefined) {
    if (ref.repo.repository !== mod.repository || ref.repo.modId !== String(mod.modId ?? -1)) {
      return false;
    }
    // same repo + mod + file id is definitively the same file
    if (!fuzzy) return ref.repo.fileId === String(mod.fileId ?? -1);
  } else if (md5 !== undefined && md5 === mod.fileMD5) {
    // external reference identified by hash alone
    return true;
  }
  return undefined;
}

function fileNamesMatch(mod: LookupInfo, ref: ModReference): boolean {
  const logical = present(ref.logicalFileName);
  const expression = present(ref.fileExpression);
  if (logical !== undefined && expression === undefined) {
    if (!equalsIgnoreCase(mod.logicalFileName, logical)) return false;
  }
  if (expression !== undefined && !fileExpressionMatches(mod, expression)) return false;
  return true;
}

/** True if a modRules reference points at this entry (md5, logical filename, fileExpression, tag, repo ids). */
export function referenceMatches(ref: ModReference, entry: CollectionModEntry): boolean {
  const mod = lookupInfo(entry);
  const fuzzy = isFuzzyVersion(ref.versionMatch);
  if (!hasIdentifyingMarker(mod, ref, fuzzy, true)) return false;
  const verdict = identityVerdict(mod, ref, fuzzy);
  if (verdict !== undefined) return verdict;
  if (!fileNamesMatch(mod, ref)) return false;
  return versionMatches(mod, ref, fuzzy);
}
