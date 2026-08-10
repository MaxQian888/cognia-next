import { BuiltInProviderProtocol } from "@cognia/provider-types/built-in-provider-catalog"
import {
  ApiProtocol,
  ProviderVerificationStatus,
  UserProviderSettings,
} from "@cognia/provider-types"

type ProviderConnectivityProtocol = ApiProtocol | BuiltInProviderProtocol
type ProviderConnectivityOutcome = "verified" | "failed" | "limited"
interface ProviderConnectivityTarget {
  providerId: string
  protocol: ProviderConnectivityProtocol
  apiKey: string
  baseURL?: string
  requiresCredential: boolean
  requiresBaseURL: boolean
  isLocal: boolean
}
interface ProviderConnectivityResultLike {
  success?: boolean
  outcome?: ProviderConnectivityOutcome
  authoritative?: boolean
  message?: string
}
interface CustomProviderConnectivityInput {
  apiKey?: string
  baseURL?: string
  apiProtocol?: ApiProtocol
  enabled?: boolean
}
declare function resolveBuiltInProviderConnectivityTarget(
  providerId: string,
  settings?: Partial<UserProviderSettings>
): ProviderConnectivityTarget
declare function resolveCustomProviderConnectivityTarget(
  providerId: string,
  provider?: CustomProviderConnectivityInput
): ProviderConnectivityTarget
declare function deriveVerificationStatusFromConnectivityResult(
  previousStatus: ProviderVerificationStatus | undefined,
  result?: ProviderConnectivityResultLike | null
): ProviderVerificationStatus

export {
  type CustomProviderConnectivityInput,
  type ProviderConnectivityOutcome,
  type ProviderConnectivityProtocol,
  type ProviderConnectivityResultLike,
  type ProviderConnectivityTarget,
  deriveVerificationStatusFromConnectivityResult,
  resolveBuiltInProviderConnectivityTarget,
  resolveCustomProviderConnectivityTarget,
}
