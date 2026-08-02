/** Capability-specific provider diagnostic contracts shared by UI, persistence, and native hosts. */

export type ProviderDiagnosticCapability = "probe" | "text-generation" | "embedding"
export type ProviderDiagnosticMode = "quick" | "precise"
export type ProviderDiagnosticSampleRole = "warmup" | "measured"
export type ProviderDiagnosticStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled" | "unverified"

export type ProviderDiagnosticFailureCode =
  | "aborted"
  | "authentication"
  | "budget-exhausted"
  | "capability-unsupported"
  | "invalid-response"
  | "model-unavailable"
  | "network"
  | "permission"
  | "quota"
  | "rate-limited"
  | "schema"
  | "script-policy"
  | "timeout"
  | "transport"
  | "unknown"

export interface ProviderDiagnosticFailure {
  code: ProviderDiagnosticFailureCode
  retryable: boolean
  /** Redacted technical detail. Never include credentials or raw response bodies. */
  message: string
  httpStatus?: number
  retryAfterMs?: number
}

export interface ProviderDiagnosticTarget {
  id: string
  providerId: string
  modelId?: string
  credentialId?: string
  credentialFingerprint: string
  endpoint: string
  capability: ProviderDiagnosticCapability
}

export interface ProviderProbeResult {
  reachable: boolean
  authenticated?: boolean
  capabilityVerified: boolean
  durationMs: number
  httpStatus?: number
  failure?: ProviderDiagnosticFailure
}

export interface ProviderBenchmarkMetrics {
  ttftMs?: number
  totalDurationMs: number
  generationDurationMs?: number
  outputTokensPerSecond?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  usageEstimated?: boolean
  estimatedCostUsd?: number
  embeddingBatchSize?: number
  embeddingItemsPerSecond?: number
  embeddingDimensions?: number
}

export interface ProviderDiagnosticSample {
  id: string
  jobId: string
  targetId: string
  providerId: string
  modelId?: string
  credentialFingerprint: string
  endpoint: string
  capability: ProviderDiagnosticCapability
  promptVersion: string
  sampleRole: ProviderDiagnosticSampleRole
  status: ProviderDiagnosticStatus
  startedAt: number
  completedAt?: number
  probe?: ProviderProbeResult
  metrics?: ProviderBenchmarkMetrics
  failure?: ProviderDiagnosticFailure
  pricingVersion?: string
}

export interface ProviderDiagnosticJob {
  id: string
  providerId: string
  mode: ProviderDiagnosticMode
  capability: ProviderDiagnosticCapability
  status: ProviderDiagnosticStatus
  targetCount: number
  completedCount: number
  requestLimit: number
  maxEstimatedCostUsd: number
  estimatedCostUsd?: number
  startedAt: number
  completedAt?: number
  cancelledAt?: number
  /** Sanitized audit context for jobs initiated by an authenticated paired device. */
  remoteAudit?: {
    deviceId: string
    requestedAt: number
    confirmedRequestLimit: number
    confirmedMaxEstimatedCostUsd: number
    outcome?: ProviderDiagnosticStatus
  }
}

export type ProviderEndpointCandidateSource = "catalog" | "current" | "user" | "ccswitch"

export interface ProviderEndpointCandidate {
  id: string
  providerId: string
  url: string
  source: ProviderEndpointCandidateSource
  label?: string
}

export interface ProviderEndpointChange {
  id: string
  providerId: string
  previousEndpoint: string
  appliedEndpoint: string
  appliedAt: number
  rolledBackAt?: number
}

export type ProviderBalanceSourceKind =
  "official" | "declarative" | "sandbox-script" | "plugin" | "unsupported"

export interface ProviderBalanceSource {
  id: string
  providerId: string
  accountId?: string
  credentialId?: string
  kind: ProviderBalanceSourceKind
  label: string
  primary: boolean
  enabled: boolean
  unit?: string
}

export interface ProviderBalanceScriptGrant {
  domain: string
  allowHttp: boolean
  allowPrivate: boolean
}

export interface ProviderBalanceScriptSourceConfig {
  id: string
  providerId: string
  label: string
  script: string
  sameOrigin: string
  credentialRef: string
  grants: ProviderBalanceScriptGrant[]
  enabled: boolean
}

export interface ProviderBalanceAmount {
  unit: string
  remaining?: number
  total?: number
  used?: number
}

export interface ProviderBalanceSnapshot {
  id: string
  providerId: string
  sourceId: string
  accountId?: string
  credentialFingerprint: string
  amounts: ProviderBalanceAmount[]
  available?: boolean
  fetchedAt: number
  staleAt: number
  failure?: ProviderDiagnosticFailure
}

export interface ProviderDiagnosticsPreferences {
  concurrency: number
  textTimeoutMs: number
  embeddingTimeoutMs: number
  probeTimeoutMs: number
  maxOutputTokens: number
  maxRequestsPerJob: number
  maxEstimatedCostUsd: number
  historyRetentionDays: number
  historyRowLimit: number
  remotePaidDiagnosticsEnabled: boolean
  primaryBalanceSourceByProvider: Record<string, string>
  lowBalanceThresholdsBySource: Record<string, { unit: string; value: number }>
  balanceScriptSources: ProviderBalanceScriptSourceConfig[]
}

export interface ProviderDiagnosticsRefreshState {
  sourceId: string
  providerId: string
  status: "idle" | "scheduled" | "running" | "paused-auth" | "paused-offline" | "paused-vault"
  nextDueAt: number
  lastAttemptAt?: number
  lastSuccessAt?: number
  consecutiveFailures: number
  retryAfterMs?: number
  lastObservedRemaining?: number
  lastNotificationAt?: number
  lastNotifiedReason?: "authentication" | "repeated-failure" | "zero-balance" | "low-balance"
}

/**
 * ADR-0104 spend ceiling. These are **hard** limits, not defaults: a job may
 * ask for less, never for more.
 *
 * The distinction matters because preferences reach the service from places
 * the user never reviews per-job — a restored settings backup, an imported
 * profile, a companion payload. Treating a supplied number as the limit lets
 * any of those raise the budget silently, so the service clamps instead
 * ([`clampProviderDiagnosticsBudget`]).
 */
export const PROVIDER_DIAGNOSTICS_HARD_LIMITS = {
  maxRequestsPerJob: 50,
  maxEstimatedCostUsd: 0.25,
} as const

export const DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES: ProviderDiagnosticsPreferences = {
  concurrency: 3,
  textTimeoutMs: 60_000,
  embeddingTimeoutMs: 30_000,
  probeTimeoutMs: 15_000,
  maxOutputTokens: 64,
  maxRequestsPerJob: PROVIDER_DIAGNOSTICS_HARD_LIMITS.maxRequestsPerJob,
  maxEstimatedCostUsd: PROVIDER_DIAGNOSTICS_HARD_LIMITS.maxEstimatedCostUsd,
  historyRetentionDays: 90,
  historyRowLimit: 20_000,
  remotePaidDiagnosticsEnabled: false,
  primaryBalanceSourceByProvider: {},
  lowBalanceThresholdsBySource: {},
  balanceScriptSources: [],
}

/**
 * Force the two budget fields back under [`PROVIDER_DIAGNOSTICS_HARD_LIMITS`].
 *
 * A non-finite or negative value is not "unlimited" — it is a broken row, and
 * the ceiling is the only reading that cannot overspend.
 */
export function clampProviderDiagnosticsBudget(
  preferences: ProviderDiagnosticsPreferences
): ProviderDiagnosticsPreferences {
  return {
    ...preferences,
    maxRequestsPerJob: clampBudgetValue(
      preferences.maxRequestsPerJob,
      PROVIDER_DIAGNOSTICS_HARD_LIMITS.maxRequestsPerJob
    ),
    maxEstimatedCostUsd: clampBudgetValue(
      preferences.maxEstimatedCostUsd,
      PROVIDER_DIAGNOSTICS_HARD_LIMITS.maxEstimatedCostUsd
    ),
  }
}

function clampBudgetValue(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value < 0) return ceiling
  return Math.min(value, ceiling)
}
