/**
 * Dexie row shapes for the artifact tables.
 *
 * These mirror the runtime types in `@/types/artifact/artifact`, but use
 * primitive epoch-ms timestamps rather than `Date` objects so IndexedDB can
 * index them — the same convention `canvas-types.ts` follows. Conversion
 * happens here and nowhere else, so the bridge, the backup pipeline and the
 * CRUD layer all agree on what a row means.
 *
 * `metadata.lastAccessedAt` is the one nested `Date` an artifact carries, so
 * the row type replaces it with a number instead of storing a `Date` inside an
 * otherwise-primitive record. A backup file round-trips through JSON, which
 * would turn a stored `Date` into an ISO string and leave two shapes of the
 * same field in circulation.
 */

import type { Artifact, ArtifactMetadata, ArtifactVersion } from "@/types/artifact/artifact"
import type {
  ArtifactMetadataRow,
  ArtifactRow,
  ArtifactVersionRow,
} from "@cognia/plugin-contract/lib/db/artifact-types"
export type {
  ArtifactMetadataRow,
  ArtifactRow,
  ArtifactVersionRow,
} from "@cognia/plugin-contract/lib/db/artifact-types"

/**
 * Epoch ms for a value that may already be a number, a `Date`, or the ISO
 * string a JSON round-trip leaves behind. Returns 0 for absent input so a row
 * always has a sortable timestamp — an artifact with no `updatedAt` sorts to
 * the bottom of the list rather than throwing on `.getTime()`.
 */
export function artifactDateMs(value: Date | string | number | undefined): number {
  if (value === undefined || value === null) return 0
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isNaN(ms) ? 0 : ms
  }
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}

function metadataToRow(metadata?: ArtifactMetadata): ArtifactMetadataRow | undefined {
  if (!metadata) return undefined
  if (metadata.lastAccessedAt === undefined) return metadata as ArtifactMetadataRow
  return { ...metadata, lastAccessedAt: artifactDateMs(metadata.lastAccessedAt) }
}

function metadataFromRow(metadata?: ArtifactMetadataRow): ArtifactMetadata | undefined {
  if (!metadata) return undefined
  if (metadata.lastAccessedAt === undefined) return metadata as ArtifactMetadata
  return { ...metadata, lastAccessedAt: new Date(metadata.lastAccessedAt) }
}

export function artifactRowFrom(artifact: Artifact): ArtifactRow {
  return {
    id: artifact.id,
    sessionId: artifact.sessionId,
    projectId: artifact.projectId,
    messageId: artifact.messageId,
    type: artifact.type,
    title: artifact.title,
    content: artifact.content,
    language: artifact.language,
    version: artifact.version,
    createdAt: artifactDateMs(artifact.createdAt),
    updatedAt: artifactDateMs(artifact.updatedAt),
    metadata: metadataToRow(artifact.metadata),
  }
}

export function artifactFromRow(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    sessionId: row.sessionId,
    projectId: row.projectId,
    messageId: row.messageId,
    type: row.type,
    title: row.title,
    content: row.content,
    language: row.language,
    version: row.version,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    metadata: metadataFromRow(row.metadata),
  }
}

export function artifactVersionRowFrom(
  version: ArtifactVersion,
  projectId?: string
): ArtifactVersionRow {
  return {
    id: version.id,
    artifactId: version.artifactId,
    projectId,
    title: version.title,
    content: version.content,
    version: version.version,
    createdAt: artifactDateMs(version.createdAt),
    changeDescription: version.changeDescription,
    metadata: metadataToRow(version.metadata),
  }
}

export function artifactVersionFromRow(row: ArtifactVersionRow): ArtifactVersion {
  return {
    id: row.id,
    artifactId: row.artifactId,
    title: row.title,
    content: row.content,
    version: row.version,
    createdAt: new Date(row.createdAt),
    changeDescription: row.changeDescription,
    metadata: metadataFromRow(row.metadata),
  }
}
