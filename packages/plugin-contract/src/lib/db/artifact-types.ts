/**
 * The plugin contract's share of `lib/db/artifact-types.ts`, which re-exports these.
 */
import type {
  ArtifactLanguage,
  ArtifactMetadata,
  ArtifactType,
} from "../../types/artifact/artifact"

/** `ArtifactMetadata` with its single `Date` field flattened for IndexedDB. */
export type ArtifactMetadataRow = Omit<ArtifactMetadata, "lastAccessedAt"> & {
  lastAccessedAt?: number
}

export interface ArtifactRow {
  id: string
  sessionId: string
  /** Owning workspace id — Workspace isolation column (Dexie v86). See `lib/db/project-scope.ts`. */
  projectId?: string
  messageId: string
  type: ArtifactType
  title: string
  content: string
  language?: ArtifactLanguage
  version: number
  createdAt: number
  updatedAt: number
  metadata?: ArtifactMetadataRow
}

export interface ArtifactVersionRow {
  id: string
  artifactId: string
  /** Owning workspace id — inherits the artifact's project. */
  projectId?: string
  title?: string
  content: string
  version: number
  createdAt: number
  changeDescription?: string
  metadata?: ArtifactMetadataRow
}
