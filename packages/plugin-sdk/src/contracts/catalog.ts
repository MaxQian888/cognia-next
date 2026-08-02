import catalog from "../../contract/catalog.json"
import pluginPointCatalog from "../../contract/plugin-points.json"

export type PluginCapabilitySupport = "supported" | "partial" | "experimental" | "blocked"
export type PluginRuntimeKind = "javascript" | "python" | "wasm" | "vscode" | "asset"
export type PluginContributionExecution =
  "host" | "conditional" | Exclude<PluginRuntimeKind, "asset">

export interface PluginContributionJavascriptCondition {
  path: string
  equals?: string
}

export interface AuthorCapabilityContract {
  id: string
  support: PluginCapabilitySupport
  manifestFields: readonly string[]
  introducedIn: string
  minimumHostVersion: string
}

/**
 * Whether a pure-Python (or hybrid python-backed) plugin can supply this
 * contribution's runtime executor through the `plugin_python_call` seam.
 * Only meaningful for `javascript` / `conditional` execution fields — `host`
 * contributions are plain data and language-agnostic. Absent means
 * `"unsupported"` (JS/React only, e.g. message renderers and tree views).
 */
export type PluginContributionPythonExecution = "supported" | "experimental" | "unsupported"

export interface PluginManifestContributionContract {
  field: string
  capabilities: readonly string[]
  execution: PluginContributionExecution
  pythonExecution?: PluginContributionPythonExecution
  entryPath?: string
  javascriptWhen?: PluginContributionJavascriptCondition
}

export interface PluginRuntimeEntryContract {
  required: readonly string[]
  javascriptEntry: string | null
  javascriptEntryRequiredForContributions: boolean
  requiredAnyOf?: readonly string[]
}

export interface PluginPathFieldContract {
  path: string
  runtime: PluginRuntimeKind
  requiredFor: readonly string[]
  executable: boolean
  sentinels?: readonly string[]
}

export const CANONICAL_PLUGIN_POINT_KINDS = ["ui-slot", "hook", "activation", "runtime"] as const

export type AuthorPluginPointKind = (typeof CANONICAL_PLUGIN_POINT_KINDS)[number]
export type AuthorPluginPointStability = "stable" | "experimental" | "deprecated"
export type AuthorPluginPointStatus = "implemented" | "virtual" | "deprecated"
export type AuthorPluginPointFormFactor = "icon" | "row" | "block" | "panel"

export interface AuthorPluginPointContract {
  id: string
  kind: AuthorPluginPointKind
  stability: AuthorPluginPointStability
  status: AuthorPluginPointStatus
  introducedIn: string
  deprecatedIn?: string
  replacementId?: string
  retirementNote?: string
  permission?: string
  aliases?: readonly string[]
  formFactor?: AuthorPluginPointFormFactor
}

export const PLUGIN_CONTRACT_SCHEMA_VERSION = catalog.schemaVersion
export const PLUGIN_POINT_CONTRACT_SCHEMA_VERSION = pluginPointCatalog.schemaVersion
export const PLUGIN_CONTRACT_MINIMUM_HOST_VERSION = catalog.minimumHostVersion
export const CANONICAL_PLUGIN_TYPES = catalog.pluginTypes as readonly string[]
export const CANONICAL_PLUGIN_PERMISSIONS = catalog.permissions as readonly string[]
export const AUTHOR_CAPABILITY_CONTRACTS = catalog.capabilities.map((contract) => ({
  ...contract,
  minimumHostVersion:
    "minimumHostVersion" in contract && typeof contract.minimumHostVersion === "string"
      ? contract.minimumHostVersion
      : catalog.minimumHostVersion,
})) as readonly AuthorCapabilityContract[]
export const PLUGIN_PATH_FIELD_CONTRACTS = catalog.pathFields as readonly PluginPathFieldContract[]
export const PLUGIN_MANIFEST_CONTRIBUTIONS =
  catalog.manifestContributions as readonly PluginManifestContributionContract[]
export const PLUGIN_RUNTIME_ENTRY_CONTRACTS = catalog.runtimeEntries as Readonly<
  Record<string, PluginRuntimeEntryContract>
>
export const CANONICAL_PLUGIN_CAPABILITIES = AUTHOR_CAPABILITY_CONTRACTS.map(
  (contract) => contract.id
)
export const AUTHOR_PLUGIN_POINT_CONTRACTS =
  pluginPointCatalog.pluginPoints as readonly AuthorPluginPointContract[]

export function getAuthorPluginPointContract(id: string): AuthorPluginPointContract | undefined {
  return AUTHOR_PLUGIN_POINT_CONTRACTS.find((contract) => contract.id === id)
}
