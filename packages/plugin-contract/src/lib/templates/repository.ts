/**
 * The plugin contract's share of `lib/templates/repository.ts`, which re-exports these.
 */
import type { TemplateDefinitionEnvelope, TemplateJson, TemplateTrust } from "./contracts"
import type { TemplatePackageManifest } from "./package"

export interface StoredTemplatePackage {
  key: string
  manifest: TemplatePackageManifest
  fingerprint: string
  trust: TemplateTrust
  importedAt: number
  source: "file" | "link" | "plugin" | "marketplace"
  /**
   * The plugin that PERFORMED a `source: "plugin"` import, not the one that
   * authored the package.
   *
   * The two differ whenever a plugin imports somebody else's bytes, and only
   * the importer is the party the library-write ownership check in
   * `lib/plugin/api/templates-api.ts` can hold responsible afterwards. Absent
   * for every other source.
   */
  pluginId?: string
  yankedAt?: number
}

export interface TemplateResourceRef {
  domain: string
  id: string
}

export interface TemplateInstanceRecord {
  id: string
  idempotencyKey: string
  source: {
    definitionId: string
    version: string | null
    revision: number
    status: TemplateDefinitionEnvelope["status"]
    contentHash: string
    snapshot: TemplateDefinitionEnvelope
  }
  /**
   * The workspace this instance was created in.
   *
   * The definition stays portable (`adapters.ts` strips `projectId` from every
   * projected payload on purpose), but the instance is the record of "a
   * template was used HERE", so a workspace key belongs on it. Absent on rows
   * written before this existed, which `backfillInstanceWorkspaces` repairs to
   * the default workspace so they do not silently vanish from a scoped list.
   */
  projectId?: string
  bindingFingerprint: string
  /**
   * The non-sensitive input values this instance was created with.
   *
   * Recorded because an update has no plan of its own: without them the next
   * version's payload would be written back with its `{{inputId}}` tokens
   * un-substituted, undoing the interpolation the instance was created with.
   * Sensitive bindings are deliberately absent — see `interpolatableBindings`.
   * Absent entirely on instances created before this was recorded, which is
   * exactly the set whose payloads were never interpolated either.
   */
  bindings?: Record<string, string>
  resources: TemplateResourceRef[]
  baseline: TemplateJson
  createdAt: number
  updatedAt: number
  detachedAt?: number
  sourceUnavailableAt?: number
}

/**
 * Where a definition came from, recorded when it was forked.
 *
 * This is LOCAL relationship data, deliberately not part of the portable
 * envelope. Two reasons. Provenance is excluded from `contentHash`, so lineage
 * carried there would be freely forgeable by anyone shipping a package, and it
 * drives update prompts. And a fork's origin is a fact about this machine's
 * library, not a claim the template makes about itself, so exporting it would
 * turn one user's local history into another user's publisher metadata.
 *
 * `baseSnapshot` is the upstream definition AS IT WAS at fork time, stored
 * rather than re-read. `fork()` may derive from a draft, which is mutable and
 * gets overwritten, and a release can be removed with its package. Either way
 * the common ancestor would be unrecoverable and a three-way merge would
 * silently degrade to "take everything". `TemplateInstanceRecord.source`
 * already keeps a snapshot for the same reason.
 */
export interface TemplateDerivation {
  definitionId: string
  version: string | null
  revision: number
  contentHash: string
  forkedAt: number
  baseSnapshot: TemplateDefinitionEnvelope
}
