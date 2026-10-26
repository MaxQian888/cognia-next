/**
 * The plugin contract's share of `lib/db/template-platform.ts`, which re-exports these.
 */
import type { StoredTemplatePackage, TemplateDerivation } from "../templates/repository"
import type { TemplateDefinitionEnvelope } from "../templates/contracts"

/**
 * A stored definition: the portable envelope plus what only this library knows.
 *
 * `workspaceId` and `derivedFrom` are local facts (see `TemplateLocalRecord`).
 * They live on the row rather than in the envelope so that `toDefinition`
 * removes them on every read, which means no export, package or content hash
 * can ever carry them. Every row sharing a definition id carries the same
 * values, so any one of them can answer a read.
 */
export interface TemplateDefinitionRow extends TemplateDefinitionEnvelope {
  storageKey: string
  workspaceId?: string
  derivedFrom?: TemplateDerivation
}

export interface TemplatePackageRow extends StoredTemplatePackage {
  id: string
  version: string
}
