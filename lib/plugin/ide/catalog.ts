import rawCatalog from "@/packages/plugin-sdk/contract/code-1.128-ide.json"
import upstreamInventory from "@/packages/plugin-sdk/contract/code-1.128-upstream-extension-points.json"
import upstreamProviderInventory from "@/packages/plugin-sdk/contract/code-1.128-upstream-provider-apis.json"
import type { PluginIdeProviderKind, PluginIdeTarget } from "@/types/plugin/plugin-ide"
import type { PluginPermission } from "@/types/plugin/plugin"

export interface IdeProviderCatalogEntry {
  kind: PluginIdeProviderKind
  permission: PluginPermission | null
  targets: PluginIdeTarget[]
}

export interface IdeCapabilityCatalog {
  schemaVersion: 1
  codeApiVersion: "1.128.0"
  brokerProtocol: "1.0"
  catalogId: string
  catalogHash: string
  contributions: string[]
  providers: IdeProviderCatalogEntry[]
  exclusions: Array<{ id: string; code: string }>
}

export const IDE_CAPABILITY_CATALOG = rawCatalog as IdeCapabilityCatalog

export const IDE_PROVIDER_KINDS = IDE_CAPABILITY_CATALOG.providers.map(
  (entry) => entry.kind
) as PluginIdeProviderKind[]

export const IDE_PROVIDER_CATALOG = new Map(
  IDE_CAPABILITY_CATALOG.providers.map((entry) => [entry.kind, entry] as const)
)

export const IDE_CONTRIBUTION_KEYS = new Set(IDE_CAPABILITY_CATALOG.contributions)

const exclusionCodes = new Map(
  IDE_CAPABILITY_CATALOG.exclusions.map((entry) => [entry.id, entry.code] as const)
)

export const IDE_EXCLUDED_CONTRIBUTIONS = new Map(
  upstreamInventory.extensionPoints.flatMap((entry) =>
    entry.classification === "excluded" &&
    "exclusion" in entry &&
    typeof entry.exclusion === "string"
      ? [[entry.id, exclusionCodes.get(entry.exclusion) ?? "IDE_INTERNAL_API_UNSUPPORTED"] as const]
      : []
  )
)

/** Runtime registration families present only in proposal-gated Code 1.128 d.ts files. */
export const IDE_EXCLUDED_PROVIDERS = new Map(
  upstreamProviderInventory.providerApis.flatMap((entry) =>
    entry.classification === "excluded" &&
    "exclusion" in entry &&
    typeof entry.exclusion === "string"
      ? [
          [
            entry.providerKind,
            exclusionCodes.get(entry.exclusion) ?? "IDE_INTERNAL_API_UNSUPPORTED",
          ] as const,
        ]
      : []
  )
)
