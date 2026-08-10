import { ApiProtocol } from "@cognia/provider-types"
import {
  BuiltInProviderAdapterId,
  BuiltInProviderFamily,
  BuiltInProviderProtocol,
} from "@cognia/provider-types/built-in-provider-catalog"
import { EquivalentCustomProviderLike } from "./built-in-provider-compatibility.js"

interface ProviderAdapterRequirements {
  requiresCredential: boolean
  requiresBaseUrl: boolean
  isLocal: boolean
}
interface ProviderAdapterDefinition {
  id: BuiltInProviderAdapterId
  family: BuiltInProviderFamily
  protocol: ApiProtocol | BuiltInProviderProtocol
  builtInDefaults: ProviderAdapterRequirements
  customDefaults: ProviderAdapterRequirements
}
declare function getProviderAdapter(
  adapterId: BuiltInProviderAdapterId | undefined
): ProviderAdapterDefinition | undefined
declare function resolveBuiltInProviderAdapter(
  providerId: string
): ProviderAdapterDefinition | undefined
declare function resolveCustomProviderAdapter(
  providerId: string,
  provider?: EquivalentCustomProviderLike
): ProviderAdapterDefinition

export {
  type ProviderAdapterDefinition,
  type ProviderAdapterRequirements,
  getProviderAdapter,
  resolveBuiltInProviderAdapter,
  resolveCustomProviderAdapter,
}
