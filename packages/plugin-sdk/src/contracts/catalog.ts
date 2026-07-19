import catalog from "../../contract/catalog.json"

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

export interface PluginManifestContributionContract {
  field: string
  capabilities: readonly string[]
  execution: PluginContributionExecution
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

export const PLUGIN_CONTRACT_SCHEMA_VERSION = catalog.schemaVersion
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
