// SPDX-License-Identifier: AGPL-3.0-only
// GraphQL v2 queries, response schemas and mapping for the Nexus client. Pure, no Electron imports.
// Field names verified against the public endpoint (introspection + live tckf0m query).
import { z } from 'zod';
import type { CollectionSummary } from '@shared/types';

/** Raw mod-file entry from GraphQL collectionRevision.modFiles (used to enrich the plan). */
export interface RevisionModFile {
  fileId: number;
  modId: number;
  optional: boolean;
  name: string;
  version: string;
  modName: string;
  sizeInBytes?: number;
}

/** A revision's mod files, plus the file ids it pins that Nexus no longer has (deleted or archived). */
export interface RevisionModFiles {
  files: RevisionModFile[];
  missingFileIds: number[];
}

const REVISION_FIELDS = 'revisionNumber downloadLink totalSize adultContent modCount';
const COLLECTION_FIELDS = 'slug name summary user { name } tileImage { url }';

export const LATEST_QUERY = `query ValleyCollection($slug: String!, $domain: String!) {
  collection(slug: $slug, domainName: $domain, viewAdultContent: true) {
    ${COLLECTION_FIELDS}
    latestPublishedRevision { ${REVISION_FIELDS} }
  }
}`;

export const REVISION_QUERY = `query ValleyCollectionRevision($slug: String!, $revision: Int!, $domain: String!) {
  collectionRevision(slug: $slug, revision: $revision, domainName: $domain, viewAdultContent: true) {
    ${REVISION_FIELDS}
    collection { ${COLLECTION_FIELDS} }
  }
}`;

export const MOD_FILES_QUERY = `query ValleyRevisionModFiles($slug: String!, $revision: Int!, $domain: String!) {
  collectionRevision(slug: $slug, revision: $revision, domainName: $domain, viewAdultContent: true) {
    modFiles { fileId optional version file { modId name version sizeInBytes mod { name } } }
  }
}`;

/** GraphQL BigInt arrives as a string ("464703554"); accept numbers too. */
const bigInt = z.union([z.number(), z.string().regex(/^\d+$/)]).transform((v) => Number(v));

const collectionSchema = z.object({
  slug: z.string(),
  name: z.string(),
  summary: z.string().nullish(),
  user: z.object({ name: z.string() }).nullish(),
  tileImage: z.object({ url: z.string() }).nullish(),
});

const revisionSchema = z.object({
  revisionNumber: z.number().int(),
  downloadLink: z.string().min(1),
  totalSize: bigInt,
  adultContent: z.boolean(),
  modCount: z.number().int(),
});

export const latestResponseSchema = z.object({
  collection: collectionSchema.extend({ latestPublishedRevision: revisionSchema.nullish() }).nullable(),
});

export const revisionResponseSchema = z.object({
  collectionRevision: revisionSchema.extend({ collection: collectionSchema }).nullable(),
});

const modFileSchema = z.object({
  fileId: z.number().int(),
  optional: z.boolean(),
  version: z.string().nullish(),
  file: z
    .object({
      modId: z.number().int(),
      name: z.string(),
      version: z.string().nullish(),
      sizeInBytes: bigInt.nullish(),
      mod: z.object({ name: z.string() }).nullish(),
    })
    .nullish(),
});

export const modFilesResponseSchema = z.object({
  collectionRevision: z.object({ modFiles: z.array(modFileSchema) }).nullable(),
});

export const graphqlEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.looseObject({
        message: z.string(),
        extensions: z.looseObject({ code: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});

type CollectionData = z.infer<typeof collectionSchema>;
type RevisionData = z.infer<typeof revisionSchema>;

/**
 * Maps a collection + revision to the shared summary.
 * modCount is Nexus's revision.modCount (it can be one higher than modFiles.length, e.g. 105 vs 104 for tckf0m).
 */
export function toSummary(col: CollectionData, rev: RevisionData): CollectionSummary {
  const summary: CollectionSummary = {
    slug: col.slug,
    revision: rev.revisionNumber,
    name: col.name,
    author: col.user?.name ?? 'Unknown curator',
    totalSize: rev.totalSize,
    modCount: rev.modCount,
    adultContent: rev.adultContent,
    downloadLinkPath: rev.downloadLink,
  };
  if (col.summary !== undefined && col.summary !== null && col.summary.trim() !== '') summary.summary = col.summary;
  if (col.tileImage?.url !== undefined && col.tileImage.url !== '') summary.tileImageUrl = col.tileImage.url;
  return summary;
}

/** Maps modFiles; entries whose file was deleted on Nexus (file: null) are returned in `missing` by fileId. */
export function toModFiles(entries: z.infer<typeof modFileSchema>[]): {
  files: RevisionModFile[];
  missing: number[];
} {
  const files: RevisionModFile[] = [];
  const missing: number[] = [];
  for (const entry of entries) {
    const file = entry.file;
    if (file === undefined || file === null) {
      missing.push(entry.fileId);
      continue;
    }
    const mapped: RevisionModFile = {
      fileId: entry.fileId,
      modId: file.modId,
      optional: entry.optional,
      name: file.name,
      version: file.version ?? entry.version ?? '',
      modName: file.mod?.name ?? file.name,
    };
    if (file.sizeInBytes !== undefined && file.sizeInBytes !== null) mapped.sizeInBytes = file.sizeInBytes;
    files.push(mapped);
  }
  return { files, missing };
}
