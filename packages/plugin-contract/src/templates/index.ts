/**
 * The plugin contract's share of `packages/plugin-sdk/src/templates/index.ts`, which re-exports these.
 */

import type {
  TemplateDefinitionEnvelope,
  validateTemplateDefinition,
  TemplateVersionBump,
  TemplateCompatibility,
  TemplateJson,
  TemplateDomain,
  TemplateMetadata,
  TemplateInputSpec,
  TemplateDependency,
  TEMPLATE_API_VERSION,
  TemplatePlatform,
} from "../lib/templates/contracts"
import type { TemplateCatalogQuery } from "../lib/templates/catalog"

export interface CreateTemplateDraftInput<TPayload extends TemplateJson = TemplateJson> {
  id: string
  domain: TemplateDomain
  metadata: TemplateMetadata
  payload: TPayload
  inputs: TemplateInputSpec[]
  dependencies: TemplateDependency[]
  capabilities: string[]
  compatibility: TemplateCompatibility
}

export interface TemplateBinding {
  slotId: string
  kind: string
  resourceId: string
  sensitive?: boolean
}

export interface TemplatePreflightIssue {
  code: string
  severity: "blocker" | "warning"
  message: string
  path?: string
}

export interface TemplateOperation {
  id: string
  kind: "create" | "update" | "bind" | "permission" | "enable"
  domain: string
  summary: string
  sideEffects?: string[]
}

export interface TemplatePreflightPlan {
  id?: string
  definitionId: string
  definitionHash: string
  definition?: TemplateDefinitionEnvelope
  platform?: TemplatePlatform
  status: "ready" | "needs-confirmation" | "blocked"
  bindings: TemplateBinding[]
  issues: TemplatePreflightIssue[]
  operations: TemplateOperation[]
  requiresConfirmation: boolean
}

export interface TemplateInstantiationResult {
  resources: Array<{ domain: string; id: string }>
  rollbackToken?: TemplateJson | null
}

export interface TemplatePackageFileRecord {
  path: string
  sha256: string
  size?: number
}

export interface TemplatePackageDefinitionRecord extends TemplatePackageFileRecord {
  id: string
  version: string
}

export interface TemplatePackageSignature {
  algorithm: "ed25519"
  publisher: string
  publicKey: string
  signature: string
}

export interface TemplatePackageManifest {
  schemaVersion: 1
  apiVersion: typeof TEMPLATE_API_VERSION
  id: string
  version: string
  name: string
  description?: string
  entrypoints: string[]
  definitions: TemplatePackageDefinitionRecord[]
  assets: TemplatePackageFileRecord[]
  compatibility?: {
    platforms?: Array<"desktop" | "web" | "mobile">
    minHostVersion?: string
    maxHostVersion?: string
  }
  signature?: TemplatePackageSignature
}

export interface TemplatePackageAsset {
  path: string
  bytes: Uint8Array
}

export interface PluginTemplatePackageContribution {
  manifest: TemplatePackageManifest
  definitions: readonly TemplateDefinitionEnvelope[]
  assets?: readonly TemplatePackageAsset[]
}

export interface PluginTemplatesAPI {
  register(definition: TemplateDefinitionEnvelope): () => void
  /** Register multiple definitions atomically with one catalog notification. */
  registerMany(definitions: readonly TemplateDefinitionEnvelope[]): () => void
  query(query?: TemplateCatalogQuery): readonly TemplateDefinitionEnvelope[]
  get(id: string, version?: string | null): TemplateDefinitionEnvelope | undefined
  list(): readonly TemplateDefinitionEnvelope[]
  getRevision(): number
  subscribe(listener: () => void): () => void
  validate(definition: TemplateDefinitionEnvelope): ReturnType<typeof validateTemplateDefinition>
  /**
   * Create a library draft owned by this plugin.
   *
   * The row lands in the user's library with `provenance.source: "user"`, as
   * ADR-0100 requires, and with `provenance.pluginId` set to the calling
   * plugin. That stamp is what the mutating calls below check: a plugin may
   * edit, publish, deprecate and delete its own drafts and no one else's.
   */
  createDraft(input: CreateTemplateDraftInput): Promise<TemplateDefinitionEnvelope>
  /**
   * Overwrite a draft this plugin created, at a known revision. A concurrent
   * edit does not throw: the host writes a `conflict` copy and returns it, so
   * check the returned `status` rather than assuming a clean save.
   */
  saveDraft(
    input: TemplateDefinitionEnvelope,
    expectedRevision: number
  ): Promise<TemplateDefinitionEnvelope>
  /**
   * Turn a draft this plugin created into an immutable release.
   * `confirmedBump` has to match the host's own conservative suggestion, so
   * publishing a breaking change as a patch is refused rather than silently
   * accepted.
   */
  publish(
    id: string,
    input: { expectedRevision: number; confirmedBump: TemplateVersionBump }
  ): Promise<TemplateDefinitionEnvelope & { version: string }>
  /**
   * Derive a new editable draft from ANY definition, including one this plugin
   * does not own. That is what a fork is for. The resulting draft is stamped
   * with this plugin and carries its lineage back to the original.
   */
  fork(
    definitionId: string,
    input: { version?: string; newId: string; workspaceId?: string }
  ): Promise<TemplateDefinitionEnvelope>
  /** Mark a release this plugin published as deprecated or yanked. */
  deprecate(
    id: string,
    version: string,
    status?: "deprecated" | "yanked"
  ): Promise<TemplateDefinitionEnvelope>
  /** Delete a draft this plugin created. Releases are immutable, use `deprecate`. */
  deleteDraft(id: string): Promise<void>
  /** Bundle one or more releases into portable package bytes. */
  exportPackage(input: {
    id: string
    version: string
    name: string
    description?: string
    compatibility?: TemplateCompatibility
    definitionIds: Array<{ id: string; version: string }>
  }): Promise<{ bytes: Uint8Array; fingerprint: string; manifest: TemplatePackageManifest }>
  /**
   * Import package bytes into the library, recorded with `source: "plugin"`.
   *
   * The installed releases are stamped with THIS plugin as
   * `provenance.pluginId`, replacing whoever authored the package, so the
   * library-write checks let this plugin publish, deprecate or delete what it
   * imported. The author is still readable from the package manifest and its
   * signature, and the content hash is unaffected because provenance is not
   * part of it.
   */
  importPackage(bytes: Uint8Array): Promise<{
    fingerprint: string
    manifest: TemplatePackageManifest
    definitions: TemplateDefinitionEnvelope[]
    assets: Map<string, Uint8Array>
    trust: "signed-unknown" | "unsigned"
  }>
  preflight(input: {
    definitionId: string
    version?: string
    platform: "desktop" | "web" | "mobile"
    bindings: Record<string, string>
  }): Promise<TemplatePreflightPlan>
  instantiate(input: {
    plan: TemplatePreflightPlan
    confirmed: boolean
  }): Promise<TemplateInstantiationResult>
}
