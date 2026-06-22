import {
  PROVIDERS,
  type CustomProviderSettings,
  type ProviderVerificationStatus,
  type UserProviderSettings,
} from "@cognia/provider-types"
import {
  getBuiltInProviderCatalogEntry,
  getBuiltInProviderSettingsBaseURL,
} from "@cognia/provider-types/built-in-provider-catalog"
import { resolveBuiltInProviderAdapter } from "./provider-adapters"

function resolveEffectiveBaseURL(providerId: string, settings?: SettingsLike): string | undefined {
  return hasText(settings?.baseURL)
    ? settings?.baseURL?.trim()
    : getBuiltInProviderSettingsBaseURL(providerId)
}

export type ProviderReadinessState = "unconfigured" | "configured" | "verified"

export type ProviderGuardCode =
  | "provider_disabled"
  | "missing_credential"
  | "missing_base_url"
  | "invalid_base_url"

export type ProviderNextAction =
  | "enable_provider"
  | "add_api_key"
  | "configure_base_url"
  | "select_default_model"
  | "verify_connection"

export interface ProviderGuardResult {
  allowed: boolean
  reason?: string
  code?: ProviderGuardCode
  nextAction?: ProviderNextAction
}

export interface ProviderRequirements {
  providerId: string
  requiresCredential: boolean
  requiresBaseUrl: boolean
  isLocal: boolean
}

export type ProviderSetupChecklistStepId =
  | "credential"
  | "base_url"
  | "default_model"
  | "verification"

export interface ProviderSetupChecklistStep {
  id: ProviderSetupChecklistStepId
  done: boolean
  nextAction?: ProviderNextAction
  reason?: string
}

export interface ProviderSetupChecklist {
  steps: ProviderSetupChecklistStep[]
  total: number
  completed: number
  isComplete: boolean
  nextAction?: ProviderNextAction
}

export interface BuiltInProviderCompleteness {
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

export interface CustomProviderCompleteness {
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

const LOCAL_PROVIDER_IDS = new Set([
  "ollama",
  "lmstudio",
  "llamacpp",
  "llamafile",
  "vllm",
  "localai",
  "jan",
  "textgenwebui",
  "koboldcpp",
  "tabbyapi",
])

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

const PROVIDER_VERIFICATION_CONTRACT = "provider-connectivity-v2"

const ALLOWED: ProviderGuardResult = { allowed: true }

const BLOCKED = {
  addApiKey: {
    allowed: false,
    code: "missing_credential" as const,
    reason: "Add an API key before continuing.",
    nextAction: "add_api_key" as const,
  },
  addApiKeyToTest: {
    allowed: false,
    code: "missing_credential" as const,
    reason: "Add an API key before testing this provider.",
    nextAction: "add_api_key" as const,
  },
  addApiKeyToRun: {
    allowed: false,
    code: "missing_credential" as const,
    reason: "Add an API key before using this provider at runtime.",
    nextAction: "add_api_key" as const,
  },
  configureBaseUrl: {
    allowed: false,
    code: "missing_base_url" as const,
    reason: "Configure a base URL before continuing.",
    nextAction: "configure_base_url" as const,
  },
  configureBaseUrlToTest: {
    allowed: false,
    code: "missing_base_url" as const,
    reason: "Configure a valid base URL before testing this provider.",
    nextAction: "configure_base_url" as const,
  },
  configureBaseUrlToRun: {
    allowed: false,
    code: "missing_base_url" as const,
    reason: "Configure a valid base URL before using this provider at runtime.",
    nextAction: "configure_base_url" as const,
  },
  invalidBaseUrlToTest: {
    allowed: false,
    code: "invalid_base_url" as const,
    reason: "Configure a valid base URL before testing this provider.",
    nextAction: "configure_base_url" as const,
  },
  invalidBaseUrlToRun: {
    allowed: false,
    code: "invalid_base_url" as const,
    reason: "Configure a valid base URL before using this provider at runtime.",
    nextAction: "configure_base_url" as const,
  },
  enableProviderFirst: {
    allowed: false,
    code: "provider_disabled" as const,
    reason: "Enable this provider before changing the default model.",
    nextAction: "enable_provider" as const,
  },
  enableProviderToRun: {
    allowed: false,
    code: "provider_disabled" as const,
    reason: "Enable this provider before using it at runtime.",
    nextAction: "enable_provider" as const,
  },
}

function hasText(value?: string): boolean {
  return typeof value === "string" && value.trim().length > 0
}

function getCredentialAtIndex(
  apiKeys: string[] | undefined,
  index: number | undefined
): string | undefined {
  if (!Array.isArray(apiKeys) || apiKeys.length === 0) return undefined
  if (
    typeof index === "number" &&
    index >= 0 &&
    index < apiKeys.length &&
    hasText(apiKeys[index])
  ) {
    return apiKeys[index]
  }
  return apiKeys.find((key) => hasText(key))
}

export function getActiveCredential(settings?: SettingsLike): string {
  if (!settings) return ""
  if (hasText(settings.apiKey)) return settings.apiKey!.trim()
  const keyFromPool = getCredentialAtIndex(settings.apiKeys, settings.currentKeyIndex)
  return keyFromPool?.trim() || ""
}

export function hasAnyCredential(settings?: SettingsLike): boolean {
  if (!settings) return false
  if (hasText(settings.apiKey)) return true
  if (!Array.isArray(settings.apiKeys)) return false
  return settings.apiKeys.some((key) => hasText(key))
}

export function isValidHttpUrl(value?: string): boolean {
  if (!hasText(value)) return false
  try {
    const parsed = new URL(value!)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

export function buildProviderVerificationFingerprint(settings?: SettingsLike): string {
  return JSON.stringify({
    verificationContract: PROVIDER_VERIFICATION_CONTRACT,
    apiKey: settings?.apiKey?.trim() || "",
    apiKeys: Array.isArray(settings?.apiKeys) ? settings!.apiKeys!.map((key) => key.trim()) : [],
    currentKeyIndex: settings?.currentKeyIndex ?? 0,
    baseURL: settings?.baseURL?.trim() || "",
    defaultModel: settings?.defaultModel?.trim() || "",
  })
}

function resolveVerificationStatus(
  settings: SettingsLike | undefined,
  latestTestResult?: {
    success?: boolean
    authoritative?: boolean
    outcome?: "verified" | "failed" | "limited"
  } | null
): { status: ProviderVerificationStatus; fingerprint: string } {
  const fingerprint = buildProviderVerificationFingerprint(settings)
  const persistedStatus = settings?.verificationStatus ?? "unverified"
  const persistedFingerprint = settings?.verificationFingerprint

  if (
    latestTestResult?.success === true &&
    latestTestResult.authoritative !== false &&
    latestTestResult.outcome !== "limited"
  ) {
    return { status: "verified", fingerprint }
  }

  if (
    persistedStatus === "verified" &&
    persistedFingerprint &&
    persistedFingerprint !== fingerprint
  ) {
    return { status: "stale", fingerprint }
  }

  if (latestTestResult?.success === false) {
    if (persistedStatus === "verified") return { status: "stale", fingerprint }
    return { status: persistedStatus === "stale" ? "stale" : "unverified", fingerprint }
  }

  return { status: persistedStatus, fingerprint }
}

export type LatestConnectivityResult =
  | {
      success?: boolean
      message?: string
      authoritative?: boolean
      outcome?: "verified" | "failed" | "limited"
    }
  | null
  | undefined

export function getProviderRequirements(providerId: string): ProviderRequirements {
  const catalogEntry = getBuiltInProviderCatalogEntry(providerId)
  const adapter = resolveBuiltInProviderAdapter(providerId)
  if (catalogEntry && adapter) {
    return {
      providerId,
      requiresCredential: adapter.builtInDefaults.requiresCredential,
      requiresBaseUrl: adapter.builtInDefaults.requiresBaseUrl,
      isLocal: adapter.builtInDefaults.isLocal,
    }
  }

  const provider = PROVIDERS[providerId]
  const inferredLocal = LOCAL_PROVIDER_IDS.has(providerId)
  if (!provider) {
    return {
      providerId,
      requiresCredential: !inferredLocal,
      requiresBaseUrl: true,
      isLocal: inferredLocal,
    }
  }
  const isLocal = provider?.type === "local" || inferredLocal
  return {
    providerId,
    requiresCredential: provider?.apiKeyRequired ?? !isLocal,
    requiresBaseUrl: provider?.baseURLRequired ?? false,
    isLocal,
  }
}

function hasRequiredConfiguration(
  requirements: ProviderRequirements,
  settings?: SettingsLike
): { hasCredential: boolean; hasBaseUrl: boolean; complete: boolean } {
  const hasCredential = hasAnyCredential(settings)
  const effectiveBaseURL = resolveEffectiveBaseURL(requirements.providerId, settings)
  const hasBaseUrl = hasText(effectiveBaseURL)
  const complete =
    (!requirements.requiresCredential || hasCredential) &&
    (!requirements.requiresBaseUrl || hasBaseUrl)
  return { hasCredential, hasBaseUrl, complete }
}

function getEnableGuard(
  requirements: ProviderRequirements,
  settings: SettingsLike | undefined,
  nextEnabled: boolean
): ProviderGuardResult {
  if (!nextEnabled) return ALLOWED
  if (requirements.requiresCredential && !hasAnyCredential(settings)) return BLOCKED.addApiKey
  if (requirements.requiresBaseUrl) {
    const effectiveBaseURL = resolveEffectiveBaseURL(requirements.providerId, settings)
    if (!hasText(effectiveBaseURL)) return BLOCKED.configureBaseUrl
    if (!isValidHttpUrl(effectiveBaseURL)) return BLOCKED.invalidBaseUrlToRun
  }
  return ALLOWED
}

function getTestGuard(
  requirements: ProviderRequirements,
  settings: SettingsLike | undefined
): ProviderGuardResult {
  if (requirements.requiresCredential && !hasText(getActiveCredential(settings))) {
    return BLOCKED.addApiKeyToTest
  }
  if (requirements.requiresBaseUrl) {
    const effectiveBaseURL = resolveEffectiveBaseURL(requirements.providerId, settings)
    if (!hasText(effectiveBaseURL)) return BLOCKED.configureBaseUrlToTest
    if (!isValidHttpUrl(effectiveBaseURL)) return BLOCKED.invalidBaseUrlToTest
  }
  return ALLOWED
}

function getRuntimeGuard(
  requirements: ProviderRequirements,
  settings: SettingsLike | undefined
): ProviderGuardResult {
  if (settings?.enabled === false) return BLOCKED.enableProviderToRun
  if (requirements.requiresCredential && !hasText(getActiveCredential(settings)))
    return BLOCKED.addApiKeyToRun
  if (requirements.requiresBaseUrl) {
    const effectiveBaseURL = resolveEffectiveBaseURL(requirements.providerId, settings)
    if (!hasText(effectiveBaseURL)) return BLOCKED.configureBaseUrlToRun
    if (!isValidHttpUrl(effectiveBaseURL)) return BLOCKED.invalidBaseUrlToRun
  }
  return ALLOWED
}

function getDefaultModelGuard(settings: SettingsLike | undefined): ProviderGuardResult {
  if (settings?.enabled === false) return BLOCKED.enableProviderFirst
  return ALLOWED
}

function createSetupChecklist(params: {
  hasCredential: boolean
  hasBaseUrl: boolean
  defaultModelConfigured: boolean
  verificationStatus: ProviderVerificationStatus
  requiresCredential: boolean
  requiresBaseUrl: boolean
  testGuard: ProviderGuardResult
}): ProviderSetupChecklist {
  const steps: ProviderSetupChecklistStep[] = []

  if (params.requiresCredential) {
    steps.push({
      id: "credential",
      done: params.hasCredential,
      nextAction: params.hasCredential ? undefined : "add_api_key",
      reason: params.hasCredential ? undefined : BLOCKED.addApiKey.reason,
    })
  }

  if (params.requiresBaseUrl) {
    const baseUrlDone = params.hasBaseUrl && params.testGuard.code !== "invalid_base_url"
    steps.push({
      id: "base_url",
      done: baseUrlDone,
      nextAction: baseUrlDone ? undefined : "configure_base_url",
      reason: baseUrlDone ? undefined : params.testGuard.reason || BLOCKED.configureBaseUrl.reason,
    })
  }

  steps.push({
    id: "default_model",
    done: params.defaultModelConfigured,
    nextAction: params.defaultModelConfigured ? undefined : "select_default_model",
    reason: params.defaultModelConfigured ? undefined : "Select a default model before continuing.",
  })

  const prerequisitesDone = steps.every((step) => step.done)
  const verificationReason = !prerequisitesDone
    ? "Complete setup prerequisites before verifying this provider."
    : params.verificationStatus === "stale"
      ? "Provider configuration changed. Re-run verification."
      : params.verificationStatus === "verified"
        ? undefined
        : "Run a connection test to verify this provider."

  steps.push({
    id: "verification",
    done: params.verificationStatus === "verified",
    nextAction: params.verificationStatus === "verified" ? undefined : "verify_connection",
    reason: verificationReason,
  })

  const completed = steps.filter((step) => step.done).length
  const nextPending = steps.find((step) => !step.done)

  return {
    steps,
    total: steps.length,
    completed,
    isComplete: completed === steps.length,
    nextAction: nextPending?.nextAction,
  }
}

export function evaluateBuiltInProviderCompleteness(
  providerId: string,
  settings?: Partial<UserProviderSettings>,
  latestTestResult?: LatestConnectivityResult
): BuiltInProviderCompleteness {
  const requirements = getProviderRequirements(providerId)
  const configState = hasRequiredConfiguration(requirements, settings)
  const testConnectionGuard = getTestGuard(requirements, settings)
  const verification = resolveVerificationStatus(settings, latestTestResult)

  const readiness: ProviderReadinessState = !configState.complete
    ? "unconfigured"
    : verification.status === "verified"
      ? "verified"
      : "configured"

  const defaultModelConfigured =
    hasText(settings?.defaultModel) || hasText(PROVIDERS[providerId]?.defaultModel)
  const setupChecklist = createSetupChecklist({
    hasCredential: configState.hasCredential,
    hasBaseUrl: configState.hasBaseUrl,
    defaultModelConfigured,
    verificationStatus: verification.status,
    requiresCredential: requirements.requiresCredential,
    requiresBaseUrl: requirements.requiresBaseUrl,
    testGuard: testConnectionGuard,
  })

  return {
    readiness,
    verificationStatus: verification.status,
    verificationFingerprint: verification.fingerprint,
    setupChecklist,
    hasCredential: configState.hasCredential,
    hasBaseUrl: configState.hasBaseUrl,
    eligibility: {
      configure: ALLOWED,
      enable: getEnableGuard(requirements, settings, true),
      testConnection: testConnectionGuard,
      defaultModel: getDefaultModelGuard(settings),
      runtime: getRuntimeGuard(requirements, settings),
    },
  }
}

export function evaluateCustomProviderCompleteness(
  provider: Partial<CustomProviderSettings> | undefined,
  latestTestResult?: LatestConnectivityResult
): CustomProviderCompleteness {
  const hasCredential = hasText(provider?.apiKey)
  const hasBaseUrl = hasText(provider?.baseURL)

  const enable = !hasCredential
    ? BLOCKED.addApiKey
    : !hasBaseUrl
      ? BLOCKED.configureBaseUrl
      : !isValidHttpUrl(provider?.baseURL)
        ? BLOCKED.invalidBaseUrlToRun
        : ALLOWED

  const testConnection = !hasCredential
    ? BLOCKED.addApiKeyToTest
    : !hasBaseUrl
      ? BLOCKED.configureBaseUrlToTest
      : !isValidHttpUrl(provider?.baseURL)
        ? BLOCKED.invalidBaseUrlToTest
        : ALLOWED

  const runtime =
    provider?.enabled === false
      ? BLOCKED.enableProviderToRun
      : !hasCredential
        ? BLOCKED.addApiKeyToRun
        : !hasBaseUrl
          ? BLOCKED.configureBaseUrlToRun
          : !isValidHttpUrl(provider?.baseURL)
            ? BLOCKED.invalidBaseUrlToRun
            : ALLOWED

  const verification = resolveVerificationStatus(provider, latestTestResult)
  const readiness: ProviderReadinessState =
    !hasCredential || !hasBaseUrl
      ? "unconfigured"
      : verification.status === "verified"
        ? "verified"
        : "configured"

  const setupChecklist = createSetupChecklist({
    hasCredential,
    hasBaseUrl,
    defaultModelConfigured: hasText(provider?.defaultModel),
    verificationStatus: verification.status,
    requiresCredential: true,
    requiresBaseUrl: true,
    testGuard: testConnection,
  })

  return {
    readiness,
    verificationStatus: verification.status,
    verificationFingerprint: verification.fingerprint,
    setupChecklist,
    hasCredential,
    hasBaseUrl,
    eligibility: {
      configure: ALLOWED,
      enable,
      testConnection,
      runtime,
    },
  }
}

export function evaluateRuntimeEligibility(
  providerId: string,
  settings?: SettingsLike
): ProviderGuardResult {
  return evaluateBuiltInProviderCompleteness(
    providerId,
    settings as Partial<UserProviderSettings> | undefined,
    null
  ).eligibility.runtime
}
