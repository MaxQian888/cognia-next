import {
  PLUGIN_POINT_CONTRACTS,
  getExtensionPointFormFactor,
  type CanonicalExtensionPoint,
  type PluginPointContract,
} from "../../lib/plugin/contracts/plugin-points"

export const PLUGIN_POINT_SCHEMA_VERSION = 1

export interface AuthorPluginPointContract {
  id: string
  kind: PluginPointContract["kind"]
  stability: PluginPointContract["stability"]
  status: PluginPointContract["status"]
  introducedIn: string
  deprecatedIn?: string
  replacementId?: string
  retirementNote?: string
  permission?: string
  aliases?: readonly string[]
  formFactor?: "icon" | "row" | "block" | "panel"
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

export function projectPluginPointContract(
  contract: PluginPointContract
): AuthorPluginPointContract {
  return omitUndefined({
    id: contract.id,
    kind: contract.kind,
    stability: contract.stability,
    status: contract.status,
    introducedIn: contract.introducedIn,
    deprecatedIn: contract.deprecatedIn,
    replacementId: contract.replacementId,
    retirementNote: contract.retirementNote,
    permission: contract.permission,
    aliases: contract.aliases,
    formFactor:
      contract.kind === "ui-slot"
        ? getExtensionPointFormFactor(contract.id as CanonicalExtensionPoint)
        : undefined,
  })
}

export function buildPluginPointCatalog(
  contracts: readonly PluginPointContract[] = PLUGIN_POINT_CONTRACTS
) {
  return {
    schemaVersion: PLUGIN_POINT_SCHEMA_VERSION,
    pluginPoints: contracts.map(projectPluginPointContract),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${JSON.stringify(buildPluginPointCatalog(), null, 2)}\n`)
}
