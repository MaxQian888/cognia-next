import {
  ProviderVerificationStatus,
  UserProviderSettings,
  CustomProviderSettings,
} from "@cognia/provider-types"

type ProviderReadinessState = "unconfigured" | "configured" | "verified"
type ProviderGuardCode =
  "provider_disabled" | "missing_credential" | "missing_base_url" | "invalid_base_url"
type ProviderNextAction =
  | "enable_provider"
  | "add_api_key"
  | "configure_base_url"
  | "select_default_model"
  | "verify_connection"
interface ProviderGuardResult {
  allowed: boolean
  reason?: string
  code?: ProviderGuardCode
  nextAction?: ProviderNextAction
}
interface ProviderRequirements {
  providerId: string
  requiresCredential: boolean
  requiresBaseUrl: boolean
  isLocal: boolean
}
type ProviderSetupChecklistStepId = "credential" | "base_url" | "default_model" | "verification"
interface ProviderSetupChecklistStep {
  id: ProviderSetupChecklistStepId
  done: boolean
  nextAction?: ProviderNextAction
  reason?: string
}
interface ProviderSetupChecklist {
  steps: ProviderSetupChecklistStep[]
  total: number
  completed: number
  isComplete: boolean
  nextAction?: ProviderNextAction
}
interface BuiltInProviderCompleteness {
  readiness: ProviderReadinessState
  verificationStatus: ProviderVerificationStatus
  verificationFingerprint: string
  setupChecklist: ProviderSetupChecklist
  hasCredential: boolean
  hasBaseUrl: boolean
  eligibility: {
    configure: ProviderGuardResult
    enable: ProviderGuardResult
    testConnection: ProviderGuardResult
    defaultModel: ProviderGuardResult
    runtime: ProviderGuardResult
  }
}
interface CustomProviderCompleteness {
  readiness: ProviderReadinessState
  verificationStatus: ProviderVerificationStatus
  verificationFingerprint: string
  setupChecklist: ProviderSetupChecklist
  hasCredential: boolean
  hasBaseUrl: boolean
  eligibility: {
    configure: ProviderGuardResult
    enable: ProviderGuardResult
    testConnection: ProviderGuardResult
    runtime: ProviderGuardResult
  }
}
interface SettingsLike {
  apiKey?: string
  apiKeys?: string[]
  currentKeyIndex?: number
  baseURL?: string
  defaultModel?: string
  enabled?: boolean
  verificationStatus?: ProviderVerificationStatus
  verificationFingerprint?: string
}
declare function getActiveCredential(settings?: SettingsLike): string
declare function hasAnyCredential(settings?: SettingsLike): boolean
declare function isValidHttpUrl(value?: string): boolean
declare function buildProviderVerificationFingerprint(settings?: SettingsLike): string
type LatestConnectivityResult =
  | {
      success?: boolean
      message?: string
      authoritative?: boolean
      outcome?: "verified" | "failed" | "limited"
    }
  | null
  | undefined
declare function getProviderRequirements(providerId: string): ProviderRequirements
declare function evaluateBuiltInProviderCompleteness(
  providerId: string,
  settings?: Partial<UserProviderSettings>,
  latestTestResult?: LatestConnectivityResult
): BuiltInProviderCompleteness
declare function evaluateCustomProviderCompleteness(
  provider: Partial<CustomProviderSettings> | undefined,
  latestTestResult?: LatestConnectivityResult
): CustomProviderCompleteness
declare function evaluateRuntimeEligibility(
  providerId: string,
  settings?: SettingsLike
): ProviderGuardResult

export {
  type BuiltInProviderCompleteness,
  type CustomProviderCompleteness,
  type LatestConnectivityResult,
  type ProviderGuardCode,
  type ProviderGuardResult,
  type ProviderNextAction,
  type ProviderReadinessState,
  type ProviderRequirements,
  type ProviderSetupChecklist,
  type ProviderSetupChecklistStep,
  type ProviderSetupChecklistStepId,
  buildProviderVerificationFingerprint,
  evaluateBuiltInProviderCompleteness,
  evaluateCustomProviderCompleteness,
  evaluateRuntimeEligibility,
  getActiveCredential,
  getProviderRequirements,
  hasAnyCredential,
  isValidHttpUrl,
}
