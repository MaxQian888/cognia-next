import catalog from "../../contract/catalog.json"

export type PluginCapabilitySupport = "supported" | "partial" | "experimental" | "blocked"
export type PluginRuntimeKind = "javascript" | "python" | "wasm" | "vscode"

export interface AuthorCapabilityContract {
  id: string
  support: PluginCapabilitySupport
  manifestFields: readonly string[]
  minimumHostVersion: string
}

export interface PluginPathFieldContract {
  path: string
  runtime: PluginRuntimeKind
  requiredFor: readonly string[]
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
export const CANONICAL_PLUGIN_CAPABILITIES = AUTHOR_CAPABILITY_CONTRACTS.map(
  (contract) => contract.id
)
