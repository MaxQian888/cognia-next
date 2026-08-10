import { ApiTestResult } from "./api-test.js"
import {
  ProviderReadinessState,
  ProviderSetupChecklist,
  LatestConnectivityResult,
} from "./completeness.js"
export { ProviderNextAction } from "./completeness.js"
import { ProviderVerificationStatus, UserProviderSettings } from "@cognia/provider-types"
export { ProviderVerificationStatus } from "@cognia/provider-types"

interface ProviderActionEligibility {
  allowed: boolean
  reason?: string
}
interface BuiltInProviderReadiness {
  readiness: ProviderReadinessState
  verificationStatus: ProviderVerificationStatus
  verificationFingerprint: string
  setupChecklist: ProviderSetupChecklist
  hasCredential: boolean
  hasBaseUrl: boolean
  eligibility: {
    configure: ProviderActionEligibility
    testConnection: ProviderActionEligibility
    enable: ProviderActionEligibility
    defaultModel: ProviderActionEligibility
  }
}
interface CustomProviderLike {
  apiKey?: string
  baseURL?: string
  defaultModel?: string
  enabled?: boolean
  verificationStatus?: ProviderVerificationStatus
  verificationFingerprint?: string
}
interface CustomProviderReadiness {
  readiness: ProviderReadinessState
  verificationStatus: ProviderVerificationStatus
  verificationFingerprint: string
  setupChecklist: ProviderSetupChecklist
  hasCredential: boolean
  hasBaseUrl: boolean
  eligibility: {
    configure: ProviderActionEligibility
    testConnection: ProviderActionEligibility
    enable: ProviderActionEligibility
  }
}
interface ChatRuntimeProviderGuard {
  allowed: boolean
  message?: string
}
declare function getActiveCredential(settings?: Partial<UserProviderSettings>): string
declare function hasAnyCredential(settings?: Partial<UserProviderSettings>): boolean
declare function getProviderEnableEligibility(
  providerId: string,
  settings: Partial<UserProviderSettings> | undefined,
  nextEnabled: boolean
): ProviderActionEligibility
declare function getBuiltInProviderReadiness(
  providerId: string,
  settings: Partial<UserProviderSettings> | undefined,
  latestTestResult?: LatestConnectivityResult
): BuiltInProviderReadiness
declare function getCustomProviderReadiness(
  provider: CustomProviderLike | undefined,
  latestTestResult?: LatestConnectivityResult
): CustomProviderReadiness
declare function getBuiltinProviderChatRuntimeMessage(
  providerId: string,
  settings: Partial<UserProviderSettings> | undefined
): string | undefined
declare function getChatRuntimeProviderGuard(
  providerId: string,
  options: {
    providerSettings: Record<string, Partial<UserProviderSettings> | undefined>
    customProviders: Record<string, CustomProviderLike | undefined>
  }
): ChatRuntimeProviderGuard
declare function getVisibleSelectedProviderIds(
  visibleProviderIds: string[],
  selectedProviderIds: Set<string>
): string[]
declare function getVisibleEligibleBuiltInProviderIds(
  visibleProviderIds: string[],
  providerSettings: Record<string, Partial<UserProviderSettings> | undefined>,
  latestTestResults: Record<string, ApiTestResult | null | undefined>
): string[]
declare function getVisibleRetryFailedBuiltInProviderIds(
  visibleProviderIds: string[],
  providerSettings: Record<string, Partial<UserProviderSettings> | undefined>,
  latestTestResults: Record<string, ApiTestResult | null | undefined>
): string[]
declare function getVisibleEligibleCustomProviderIds(
  visibleCustomProviderIds: string[],
  customProviders: Record<string, CustomProviderLike | undefined>,
  latestResults: Record<string, "success" | "error" | "limited" | null | undefined>
): string[]
declare function getVisibleRetryFailedCustomProviderIds(
  visibleCustomProviderIds: string[],
  customProviders: Record<string, CustomProviderLike | undefined>,
  latestResults: Record<string, "success" | "error" | "limited" | null | undefined>
): string[]

export {
  type BuiltInProviderReadiness,
  type ChatRuntimeProviderGuard,
  type CustomProviderLike,
  type CustomProviderReadiness,
  type ProviderActionEligibility,
  ProviderReadinessState,
  ProviderSetupChecklist,
  getActiveCredential,
  getBuiltInProviderReadiness,
  getBuiltinProviderChatRuntimeMessage,
  getChatRuntimeProviderGuard,
  getCustomProviderReadiness,
  getProviderEnableEligibility,
  getVisibleEligibleBuiltInProviderIds,
  getVisibleEligibleCustomProviderIds,
  getVisibleRetryFailedBuiltInProviderIds,
  getVisibleRetryFailedCustomProviderIds,
  getVisibleSelectedProviderIds,
  hasAnyCredential,
}
