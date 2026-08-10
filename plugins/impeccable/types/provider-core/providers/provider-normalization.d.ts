import { ApiProtocol, UserProviderSettings } from "@cognia/provider-types"
import {
  BuiltInProviderAdapterId,
  BuiltInProviderFamily,
  BuiltInProviderProtocol,
} from "@cognia/provider-types/built-in-provider-catalog"
import { EquivalentCustomProviderLike } from "./built-in-provider-compatibility.js"

interface NormalizedProviderConfig {
  providerId: string
  source: "built-in" | "custom"
  adapterId: BuiltInProviderAdapterId
  family: BuiltInProviderFamily
  protocol: ApiProtocol | BuiltInProviderProtocol
  apiKey: string
  baseURL?: string
  defaultModel?: string
  enabled: boolean
  requiresCredential: boolean
  requiresBaseUrl: boolean
  isLocal: boolean
  equivalentBuiltInProviderId?: string
}
declare function normalizeBuiltInProviderConfig(
  providerId: string,
  settings?: Partial<UserProviderSettings>
): NormalizedProviderConfig
declare function normalizeCustomProviderConfig(
  providerId: string,
  provider?: EquivalentCustomProviderLike
): NormalizedProviderConfig

export {
  type NormalizedProviderConfig,
  normalizeBuiltInProviderConfig,
  normalizeCustomProviderConfig,
}
