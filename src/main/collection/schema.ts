// SPDX-License-Identifier: AGPL-3.0-only
// zod schema for collection.json inside a Nexus collection archive (Vortex ICollection format).
// Objects are loose: unknown keys are kept, so newer Vortex fields never break parsing.
import { z } from 'zod';

export type CollectionSourceType = 'nexus' | 'bundle' | 'direct' | 'browse' | 'manual';
export type UpdatePolicy = 'exact' | 'latest' | 'prefer';
/** Rule types Vortex writes. Only 'before'/'after' affect deploy order. */
export const RULE_TYPES = ['before', 'after', 'requires', 'conflicts', 'recommends', 'provides'] as const;

export type CollectionJson = {
  info: {
    author?: string;
    authorUrl?: string;
    name: string;
    description?: string;
    installInstructions?: string;
    domainName: string;
    gameVersions?: string[];
  };
  mods: CollectionModEntry[];
  modRules: CollectionModRule[];
  collectionConfig?: unknown;
};

export type CollectionModEntry = {
  name: string;
  version: string;
  optional: boolean;
  /** Falls back to info.domainName when the entry omits it. */
  domainName: string;
  author?: string;
  phase: number;
  instructions?: string;
  source: {
    type: CollectionSourceType;
    modId?: number;
    fileId?: number;
    md5?: string;
    fileSize?: number;
    logicalFilename?: string;
    fileExpression?: string;
    url?: string;
    instructions?: string;
    updatePolicy?: UpdatePolicy;
    tag?: string;
    adultContent?: boolean;
  };
  hashes?: { path: string; md5?: string; xxh64?: string }[];
  choices?: unknown;
  patches?: Record<string, unknown>;
  details?: { type?: string; category?: string };
  fileOverrides?: string[];
};

export type ModReference = {
  fileMD5?: string;
  fileSize?: number;
  logicalFileName?: string;
  fileExpression?: string;
  /** "1.2.0" (exact), "*" (any), ">=1.2.0+prefer", or another semver range. */
  versionMatch?: string;
  tag?: string;
  gameId?: string;
  description?: string;
  /** Numeric ids are normalised to strings (Vortex stores them as strings). */
  repo?: { repository?: string; gameId?: string; modId?: string; fileId?: string };
};

export type CollectionModRule = {
  /** One of RULE_TYPES in practice; kept as string so unknown future types don't fail parsing. */
  type: string;
  source: ModReference;
  reference: ModReference;
};

const NUMERIC = /^\s*\d+\s*$/;

/** Accepts 123 or "123" and yields a number. */
const numberish = z.preprocess(
  (v) => (typeof v === 'string' && NUMERIC.test(v) ? Number(v) : v),
  z.number().int().nonnegative(),
);

/** Accepts "123" or 123 and yields a string (Vortex repo ids are strings). */
const idString = z.union([z.string(), z.number().int().transform(String)]);

const sourceSchema = z.looseObject({
  type: z.enum(['nexus', 'bundle', 'direct', 'browse', 'manual']),
  modId: numberish.optional(),
  fileId: numberish.optional(),
  md5: z.string().optional(),
  fileSize: numberish.optional(),
  logicalFilename: z.string().optional(),
  fileExpression: z.string().optional(),
  url: z.string().optional(),
  instructions: z.string().optional(),
  updatePolicy: z.enum(['exact', 'latest', 'prefer']).optional(),
  tag: z.string().optional(),
  adultContent: z.boolean().optional(),
});

const modEntrySchema = z.looseObject({
  name: z.string(),
  version: z.union([z.string(), z.number().transform(String)]).default(''),
  optional: z.boolean().default(false),
  domainName: z.string().optional(),
  author: z.string().optional(),
  phase: numberish.default(0),
  instructions: z.string().optional(),
  source: sourceSchema,
  hashes: z
    .array(z.looseObject({ path: z.string(), md5: z.string().optional(), xxh64: z.string().optional() }))
    .optional(),
  choices: z.unknown().optional(),
  patches: z.record(z.string(), z.unknown()).optional(),
  details: z.looseObject({ type: z.string().optional(), category: z.string().optional() }).optional(),
  fileOverrides: z.array(z.string()).optional(),
});

const modReferenceSchema = z.looseObject({
  fileMD5: z.string().optional(),
  fileSize: numberish.optional(),
  logicalFileName: z.string().optional(),
  fileExpression: z.string().optional(),
  versionMatch: z.string().optional(),
  tag: z.string().optional(),
  gameId: z.string().optional(),
  description: z.string().optional(),
  repo: z
    .looseObject({
      repository: z.string().optional(),
      gameId: z.string().optional(),
      modId: idString.optional(),
      fileId: idString.optional(),
    })
    .optional(),
});

const modRuleSchema = z.looseObject({
  type: z.string(),
  source: modReferenceSchema,
  reference: modReferenceSchema,
});

export const collectionJsonSchema = z
  .looseObject({
    info: z.looseObject({
      author: z.string().optional(),
      authorUrl: z.string().optional(),
      name: z.string(),
      description: z.string().optional(),
      installInstructions: z.string().optional(),
      domainName: z.string().min(1),
      gameVersions: z.array(z.string()).optional(),
    }),
    mods: z.array(modEntrySchema),
    modRules: z.array(modRuleSchema).default([]),
    collectionConfig: z.unknown().optional(),
  })
  .transform((c) => ({
    ...c,
    mods: c.mods.map((m) => ({ ...m, domainName: m.domainName ?? c.info.domainName })),
  }));

/** "mods[3].source.type" style path for an issue. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out === '' ? '(root)' : out;
}

const MAX_REPORTED_ISSUES = 8;
const BOM = 0xfeff;

function formatZodError(error: z.ZodError): string {
  const lines = error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`);
  const extra = error.issues.length - MAX_REPORTED_ISSUES;
  if (extra > 0) lines.push(`…and ${extra} more problem(s)`);
  return lines.join('; ');
}

/** Vortex never writes null, but hand-edited files sometimes do: treat null properties as absent. */
function dropNullProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNullProperties);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner !== null) out[key] = dropNullProperties(inner);
  }
  return out;
}

/** Parse + validate collection.json text. Throws Error with a readable message on invalid input. */
export function parseCollectionJson(text: string): CollectionJson {
  const clean = text.charCodeAt(0) === BOM ? text.slice(1) : text;
  let raw: unknown;
  try {
    raw = JSON.parse(clean);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`collection.json is not valid JSON: ${detail}`, { cause: err });
  }
  const result = collectionJsonSchema.safeParse(dropNullProperties(raw));
  if (!result.success) {
    throw new Error(`collection.json is invalid: ${formatZodError(result.error)}`, {
      cause: result.error,
    });
  }
  const parsed: CollectionJson = result.data;
  return parsed;
}
