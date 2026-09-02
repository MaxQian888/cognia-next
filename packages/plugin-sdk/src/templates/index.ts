import {
  TEMPLATE_API_VERSION,
  createTemplateDefinition,
  validateTemplateDefinition,
  verifyTemplateDefinitionHash,
  type TemplateDefinitionDraft,
  type TemplateDefinitionEnvelope,
  type TemplateDomain,
  type TemplateCompatibility,
  type TemplateInputSpec,
  type TemplateDependency,
  type TemplateJson,
  type TemplateMetadata,
  type TemplatePlatform,
  type TemplateVersionBump,
} from "@/lib/templates/contracts"
import type { TemplateCatalogQuery } from "@/lib/templates/catalog"

export {
  TEMPLATE_API_VERSION,
  createTemplateDefinition,
  validateTemplateDefinition,
  verifyTemplateDefinitionHash,
}

export type {
  TemplateDefinitionDraft,
  TemplateDefinitionEnvelope,
  TemplateDomain,
  TemplateInputSpec,
  TemplateDependency,
  TemplateCatalogQuery,
  TemplateVersionBump,
}

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

export const WORKFLOW_NODE_GROUP_PAYLOAD_KIND = "cognia.workflow/node-group/v1" as const

export type WorkflowNodeGroupNode = {
  id: string
  type: string
  typeVersion: number
  position: { x: number; y: number }
  data: {
    label: string
    params?: { [key: string]: TemplateJson }
    notes?: string
    disabled?: boolean
    locked?: boolean
    errorHandling?: { [key: string]: TemplateJson }
  }
  parentId?: string
  width?: number
  height?: number
}

export type WorkflowNodeGroupEdge = {
  id: string
  source: string
  sourceHandle?: string
  target: string
  targetHandle?: string
  label?: string
  data?: {
    kind?: "default" | "conditional" | "parallel" | "loop" | "error"
  }
}

export type WorkflowNodeGroupBoundaryPort = {
  id: string
  label: string
  nodeId: string
  handleId?: string
  schema: { [key: string]: TemplateJson }
  required: boolean
  defaultValue?: TemplateJson
  source: "edge" | "variable" | "expression"
}

export type WorkflowNodeGroupInterface = {
  inputs: WorkflowNodeGroupBoundaryPort[]
  outputs: WorkflowNodeGroupBoundaryPort[]
}

/**
 * A reusable authoring-time graph fragment. The editor expands it into normal
 * workflow nodes/edges under the existing visual `annotation.group` frame;
 * the runtime never sees a second executor or graph representation.
 */
export type WorkflowNodeGroupPayload = {
  kind: typeof WORKFLOW_NODE_GROUP_PAYLOAD_KIND
  nodes: WorkflowNodeGroupNode[]
  edges: WorkflowNodeGroupEdge[]
  /** Confirmed authoring boundary; absent on legacy node groups. */
  interface?: WorkflowNodeGroupInterface
  /** Controls where the immutable definition may be distributed. */
  distribution?: { scope: "personal" | "workspace" | "portable-bundle" }
}

export type WorkflowNodeGroupDefinition = TemplateDefinitionEnvelope<WorkflowNodeGroupPayload> & {
  domain: "workflow"
}

const PACKAGE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i
const DEFINITION_ID = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/i
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256 = /^[a-f0-9]{64}$/i

function validatePackagePath(input: string): string {
  const normalized = input.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.includes("\0") ||
    normalized !== normalized.normalize("NFC")
  ) {
    throw new Error(`Template package path is unsafe: ${input}`)
  }
  const parts = normalized.split("/").filter((part) => part && part !== ".")
  if (parts.includes("..") || parts.length === 0 || parts.length > 16) {
    throw new Error(`Template package path is unsafe: ${input}`)
  }
  return parts.join("/")
}

function validateTemplatePackageManifest(raw: unknown): TemplatePackageManifest {
  if (!raw || typeof raw !== "object") throw new Error("Template package manifest is invalid")
  const manifest = raw as Partial<TemplatePackageManifest>
  if (manifest.schemaVersion !== 1) {
    throw new Error(
      typeof manifest.schemaVersion === "number" && manifest.schemaVersion > 1
        ? `Unsupported future template package schema ${manifest.schemaVersion}`
        : `Unsupported template package schema ${String(manifest.schemaVersion)}`
    )
  }
  if (
    manifest.apiVersion !== TEMPLATE_API_VERSION ||
    typeof manifest.id !== "string" ||
    !PACKAGE_ID.test(manifest.id) ||
    typeof manifest.version !== "string" ||
    !SEMVER.test(manifest.version) ||
    typeof manifest.name !== "string" ||
    !manifest.name.trim() ||
    !Array.isArray(manifest.entrypoints) ||
    !Array.isArray(manifest.definitions) ||
    manifest.definitions.length > 256 ||
    !Array.isArray(manifest.assets)
  ) {
    throw new Error("Template package manifest is invalid")
  }
  if (manifest.definitions.length === 0) {
    throw new Error("Template package has no definitions")
  }
  const paths = new Set<string>()
  const identities = new Set<string>()
  for (const record of [...manifest.definitions, ...manifest.assets]) {
    if (!record || typeof record.path !== "string" || typeof record.sha256 !== "string") {
      throw new Error("Template package file record is invalid")
    }
    const path = validatePackagePath(record.path)
    if (paths.has(path)) throw new Error(`Template package has duplicate path: ${path}`)
    paths.add(path)
    if (!SHA256.test(record.sha256)) {
      throw new Error(`Template package checksum is invalid: ${path}`)
    }
    if (record.size !== undefined && (!Number.isSafeInteger(record.size) || record.size < 0)) {
      throw new Error(`Template package size is invalid: ${path}`)
    }
  }
  for (const record of manifest.definitions) {
    if (
      typeof record.id !== "string" ||
      !DEFINITION_ID.test(record.id) ||
      typeof record.version !== "string" ||
      !SEMVER.test(record.version)
    ) {
      throw new Error("Template package definition identity is invalid")
    }
    const identity = `${record.id}@${record.version}`
    if (identities.has(identity)) throw new Error(`Duplicate template definition: ${identity}`)
    identities.add(identity)
  }
  if (
    new Set(manifest.entrypoints).size !== manifest.entrypoints.length ||
    manifest.entrypoints.some((entrypoint) => !identities.has(entrypoint))
  ) {
    throw new Error("Template package entrypoints are invalid")
  }
  if (
    manifest.compatibility?.platforms?.some(
      (platform) => !["desktop", "web", "mobile"].includes(platform)
    )
  ) {
    throw new Error("Template package platform compatibility is invalid")
  }
  if (
    manifest.signature &&
    (manifest.signature.algorithm !== "ed25519" ||
      !manifest.signature.publisher.trim() ||
      !manifest.signature.publicKey.trim() ||
      !manifest.signature.signature.trim())
  ) {
    throw new Error("Template package signature metadata is invalid")
  }
  return manifest as TemplatePackageManifest
}

export function defineTemplate<const T extends TemplateDefinitionEnvelope>(definition: T): T {
  const validation = validateTemplateDefinition(definition)
  if (!validation.ok) {
    throw new Error(
      `Invalid template definition: ${validation.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`
    )
  }
  return definition
}

export function defineTemplatePackage<const T extends TemplatePackageManifest>(manifest: T): T {
  validateTemplatePackageManifest(manifest)
  return manifest
}

type DomainTemplate<
  TDomain extends TemplateDomain,
  TPayload extends TemplateJson,
> = TemplateDefinitionEnvelope<TPayload> & { domain: TDomain }

function defineDomainTemplate<
  const TDomain extends TemplateDomain,
  const TPayload extends TemplateJson,
  const T extends DomainTemplate<TDomain, TPayload>,
>(domain: TDomain, definition: T): T {
  if (definition.domain !== domain) {
    throw new Error(`Expected ${domain} template, received ${definition.domain}`)
  }
  return defineTemplate(definition)
}

export const defineAgentTeamTemplate = <
  const TPayload extends TemplateJson,
  const T extends DomainTemplate<"agentTeam", TPayload>,
>(
  definition: T
): T => defineDomainTemplate("agentTeam", definition)

export const defineWorkflowTemplate = <
  const TPayload extends TemplateJson,
  const T extends DomainTemplate<"workflow", TPayload>,
>(
  definition: T
): T => defineDomainTemplate("workflow", definition)

function assertWorkflowNodeGroupPayload(payload: WorkflowNodeGroupPayload): void {
  if (payload?.kind !== WORKFLOW_NODE_GROUP_PAYLOAD_KIND) {
    throw new Error(
      `Workflow node group payload kind must be "${WORKFLOW_NODE_GROUP_PAYLOAD_KIND}"`
    )
  }
  if (!Array.isArray(payload.nodes) || payload.nodes.length === 0) {
    throw new Error("Workflow node group must contain at least one node")
  }
  if (payload.nodes.length > 256) {
    throw new Error("Workflow node group cannot contain more than 256 nodes")
  }
  if (!Array.isArray(payload.edges) || payload.edges.length > 1024) {
    throw new Error("Workflow node group cannot contain more than 1024 edges")
  }

  const nodeIds = new Set<string>()
  for (const node of payload.nodes) {
    if (
      !node ||
      typeof node.id !== "string" ||
      !node.id ||
      typeof node.type !== "string" ||
      !node.type ||
      !Number.isInteger(node.typeVersion) ||
      node.typeVersion < 1 ||
      !node.position ||
      !Number.isFinite(node.position.x) ||
      !Number.isFinite(node.position.y) ||
      !node.data ||
      typeof node.data.label !== "string"
    ) {
      throw new Error("Workflow node group contains an invalid node")
    }
    if (nodeIds.has(node.id)) {
      throw new Error(`Workflow node group contains duplicate node id "${node.id}"`)
    }
    nodeIds.add(node.id)
  }

  const edgeIds = new Set<string>()
  for (const edge of payload.edges) {
    if (
      !edge ||
      typeof edge.id !== "string" ||
      !edge.id ||
      typeof edge.source !== "string" ||
      typeof edge.target !== "string" ||
      !nodeIds.has(edge.source) ||
      !nodeIds.has(edge.target)
    ) {
      throw new Error("Workflow node group contains an invalid or dangling edge")
    }
    if (edgeIds.has(edge.id)) {
      throw new Error(`Workflow node group contains duplicate edge id "${edge.id}"`)
    }
    edgeIds.add(edge.id)
  }
}

/** Validate and retain the exact definition type supplied by a plugin author. */
export function defineWorkflowNodeGroup<const T extends WorkflowNodeGroupDefinition>(
  definition: T
): T {
  const validated = defineDomainTemplate("workflow", definition)
  assertWorkflowNodeGroupPayload(validated.payload)
  return validated
}

/**
 * Batch authoring helper. Validation is all-or-nothing and identities must be
 * unique so the matching `ctx.templates.registerMany()` call is atomic.
 */
export function defineWorkflowNodeGroups<const T extends readonly WorkflowNodeGroupDefinition[]>(
  definitions: T
): T {
  const identities = new Set<string>()
  for (const definition of definitions) {
    defineWorkflowNodeGroup(definition)
    const identity = `${definition.id}@${definition.version ?? `${definition.status}:${definition.revision}`}`
    if (identities.has(identity)) {
      throw new Error(`Duplicate workflow node group definition "${identity}"`)
    }
    identities.add(identity)
  }
  return definitions
}

export const defineSubagentTemplate = <
  const TPayload extends TemplateJson,
  const T extends DomainTemplate<"subagent", TPayload>,
>(
  definition: T
): T => defineDomainTemplate("subagent", definition)

export const defineCustomModeTemplate = <
  const TPayload extends TemplateJson,
  const T extends DomainTemplate<"customMode", TPayload>,
>(
  definition: T
): T => defineDomainTemplate("customMode", definition)

export const defineCharacterTemplate = <
  const TPayload extends TemplateJson,
  const T extends DomainTemplate<"character", TPayload>,
>(
  definition: T
): T => defineDomainTemplate("character", definition)

export const defineSkillTemplate = <
  const TPayload extends TemplateJson,
  const T extends DomainTemplate<"skill", TPayload>,
>(
  definition: T
): T => defineDomainTemplate("skill", definition)

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
