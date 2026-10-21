/**
 * The plugin contract's share of `lib/db/document-templates.ts`, which re-exports these.
 */
import type { ArtifactLanguage } from "../../types/artifact/artifact"

export interface DocumentTemplateRow {
  /** "dtpl_" prefix. */
  id: string
  name: string
  description?: string
  /** The document body a new document starts with. */
  content: string
  language: ArtifactLanguage
  type: "code" | "text"
  /** Bumped on every content edit, so the template catalog can version it. */
  revision: number
  createdAt: number
  updatedAt: number
}
