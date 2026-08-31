import {
  getBuiltInProviderCatalog,
  type BuiltInProviderCatalogEntry,
} from "@cognia/provider-types/built-in-provider-catalog"
import type { ApiProtocol } from "@cognia/provider-types/provider"
import type { ProviderParameterSchema } from "@cognia/provider-types/provider-parameter-schema"
import { getSchemaForProvider } from "./provider-parameter-schemas"

export type ProviderCredentialContract =
  "api-key" | "keyless" | "bedrock-chain" | "oauth-or-api-key"

export interface ProviderContract {
  id: string
  kind: "built-in" | "local" | "custom"
  protocol: ApiProtocol
  credentials: ProviderCredentialContract
  modelSources: readonly ("catalog" | "discovered" | "manual")[]
  parameterSchema: ProviderParameterSchema
  persistenceTarget: "providerSettings" | "customProviders"
  runtimeAdapter: string
}

function credentialContract(entry: BuiltInProviderCatalogEntry): ProviderCredentialContract {
  if (entry.protocol === "bedrock") return "bedrock-chain"
  if (entry.supportsOAuth) return "oauth-or-api-key"
  return entry.apiKeyRequired ? "api-key" : "keyless"
}

export function buildBuiltInProviderContractMatrix(): ProviderContract[] {
  return getBuiltInProviderCatalog().map((entry) => ({
    id: entry.id,
    kind: entry.type === "local" ? "local" : "built-in",
    protocol: entry.protocol,
    credentials: credentialContract(entry),
    modelSources: ["catalog", "discovered", "manual"],
    parameterSchema: getSchemaForProvider(entry.id),
    persistenceTarget: "providerSettings",
    runtimeAdapter: entry.adapter ?? entry.protocol,
  }))
}

export function buildCustomProviderContract(input: {
  id: string
  protocol: ApiProtocol
  name?: string
}): ProviderContract {
  return {
    id: input.id,
    kind: "custom",
    protocol: input.protocol,
    credentials: "keyless",
    modelSources: ["discovered", "manual"],
    parameterSchema: getSchemaForProvider(input.id, {
      [input.id]: { apiProtocol: input.protocol, name: input.name ?? input.id },
    }),
    persistenceTarget: "customProviders",
    runtimeAdapter: input.protocol,
  }
}
