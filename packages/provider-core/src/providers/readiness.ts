import type { ApiTestResult } from "./api-test"
import {
  evaluateBuiltInProviderCompleteness,
  evaluateCustomProviderCompleteness,
  getActiveCredential as getActiveCredentialFromContract,
  hasAnyCredential as hasAnyCredentialFromContract,
  type LatestConnectivityResult,
  type ProviderSetupChecklist,
  type ProviderReadinessState,
} from "./completeness"
import type { ProviderVerificationStatus, UserProviderSettings } from "@cognia/provider-types"

export type {
  ProviderNextAction,
  ProviderReadinessState,
  ProviderSetupChecklist,
} from "./completeness"
export type { ProviderVerificationStatus } from "@cognia/provider-types"

export interface ProviderActionEligibility {
  allowed: boolean
  reason?: string
}

export interface BuiltInProviderReadiness {
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

export interface CustomProviderLike {
  apiKey?: string
  baseURL?: string
  defaultModel?: string
  enabled?: boolean
  verificationStatus?: ProviderVerificationStatus
  verificationFingerprint?: string
}

export interface CustomProviderReadiness {
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

export interface ChatRuntimeProviderGuard {
  allowed: boolean
  message?: string
}

export function getActiveCredential(settings?: Partial<UserProviderSettings>): string {
  return getActiveCredentialFromContract(settings)
}

export function hasAnyCredential(settings?: Partial<UserProviderSettings>): boolean {
  return hasAnyCredentialFromContract(settings)
}

export function getProviderEnableEligibility(
  providerId: string,
  settings: Partial<UserProviderSettings> | undefined,
  nextEnabled: boolean
): ProviderActionEligibility {
  if (!nextEnabled) return { allowed: true }
  return evaluateBuiltInProviderCompleteness(providerId, settings, null).eligibility.enable
}

export function getBuiltInProviderReadiness(
  providerId: string,
  settings: Partial<UserProviderSettings> | undefined,
  latestTestResult?: LatestConnectivityResult
): BuiltInProviderReadiness {
  const evaluated = evaluateBuiltInProviderCompleteness(providerId, settings, latestTestResult)

  return {
    readiness: evaluated.readiness,
    verificationStatus: evaluated.verificationStatus,
    verificationFingerprint: evaluated.verificationFingerprint,
    setupChecklist: evaluated.setupChecklist,
    hasCredential: evaluated.hasCredential,
    hasBaseUrl: evaluated.hasBaseUrl,
    eligibility: {
      configure: evaluated.eligibility.configure,
      testConnection: evaluated.eligibility.testConnection,
      enable: evaluated.eligibility.enable,
      defaultModel: evaluated.eligibility.defaultModel,
    },
  }
}

export function getCustomProviderReadiness(
  provider: CustomProviderLike | undefined,
  latestTestResult?: LatestConnectivityResult
): CustomProviderReadiness {
  const evaluated = evaluateCustomProviderCompleteness(provider, latestTestResult)

  return {
    readiness: evaluated.readiness,
    verificationStatus: evaluated.verificationStatus,
    verificationFingerprint: evaluated.verificationFingerprint,
    setupChecklist: evaluated.setupChecklist,
    hasCredential: evaluated.hasCredential,
    hasBaseUrl: evaluated.hasBaseUrl,
    eligibility: {
      configure: evaluated.eligibility.configure,
      testConnection: evaluated.eligibility.testConnection,
      enable: evaluated.eligibility.enable,
    },
  }
}

export function getBuiltinProviderChatRuntimeMessage(
  providerId: string,
  settings: Partial<UserProviderSettings> | undefined
): string | undefined {
  if (!settings?.enabled) {
    return `Provider ${providerId} is disabled. Please enable it in Settings.`
  }

  const readiness = getBuiltInProviderReadiness(providerId, settings, null)
  if (readiness.readiness === "unconfigured") {
    return `API key not configured for ${providerId}. Please add your API key in Settings.`
  }

  return undefined
}

export function getChatRuntimeProviderGuard(
  providerId: string,
  options: {
    providerSettings: Record<string, Partial<UserProviderSettings> | undefined>
    customProviders: Record<string, CustomProviderLike | undefined>
  }
): ChatRuntimeProviderGuard {
  const builtInSettings = options.providerSettings[providerId]
  if (builtInSettings) {
    const message = getBuiltinProviderChatRuntimeMessage(providerId, builtInSettings)
    return message ? { allowed: false, message } : { allowed: true }
  }

  const customProvider = options.customProviders[providerId]
  if (customProvider) {
    if (!customProvider.enabled) {
      return {
        allowed: false,
        message: `Provider ${providerId} is disabled. Please enable it in Settings.`,
      }
    }

    const readiness = getCustomProviderReadiness(customProvider, null)
    if (readiness.readiness === "unconfigured") {
      return {
        allowed: false,
        message: `API key not configured for ${providerId}. Please add your API key in Settings.`,
      }
    }
  }

  return { allowed: true }
}

export function getVisibleSelectedProviderIds(
  visibleProviderIds: string[],
  selectedProviderIds: Set<string>
): string[] {
  return visibleProviderIds.filter((providerId) => selectedProviderIds.has(providerId))
}

export function getVisibleEligibleBuiltInProviderIds(
  visibleProviderIds: string[],
  providerSettings: Record<string, Partial<UserProviderSettings> | undefined>,
  latestTestResults: Record<string, ApiTestResult | null | undefined>
): string[] {
  return visibleProviderIds.filter((providerId) => {
    const settings = providerSettings[providerId]
    if (!settings?.enabled) return false
    const state = getBuiltInProviderReadiness(providerId, settings, latestTestResults[providerId])
    return state.eligibility.testConnection.allowed
  })
}

export function getVisibleRetryFailedBuiltInProviderIds(
  visibleProviderIds: string[],
  providerSettings: Record<string, Partial<UserProviderSettings> | undefined>,
  latestTestResults: Record<string, ApiTestResult | null | undefined>
): string[] {
  return visibleProviderIds.filter((providerId) => {
    const settings = providerSettings[providerId]
    if (!settings?.enabled) return false
    const latestResult = latestTestResults[providerId]
    if (!latestResult || latestResult.success) return false
    const state = getBuiltInProviderReadiness(providerId, settings, latestResult)
    return state.eligibility.testConnection.allowed
  })
}

export function getVisibleEligibleCustomProviderIds(
  visibleCustomProviderIds: string[],
  customProviders: Record<string, CustomProviderLike | undefined>,
  latestResults: Record<string, "success" | "error" | "limited" | null | undefined>
): string[] {
  return visibleCustomProviderIds.filter((providerId) => {
    const provider = customProviders[providerId]
    if (!provider?.enabled) return false
    const latest = latestResults[providerId]
    const state = getCustomProviderReadiness(
      provider,
      latest ? { success: latest === "success" } : null
    )
    return state.eligibility.testConnection.allowed
  })
}

export function getVisibleRetryFailedCustomProviderIds(
  visibleCustomProviderIds: string[],
  customProviders: Record<string, CustomProviderLike | undefined>,
  latestResults: Record<string, "success" | "error" | "limited" | null | undefined>
): string[] {
  return visibleCustomProviderIds.filter((providerId) => {
    if (latestResults[providerId] !== "error") return false
    const provider = customProviders[providerId]
    if (!provider?.enabled) return false
    const state = getCustomProviderReadiness(provider, { success: false })
    return state.eligibility.testConnection.allowed
  })
}
