/** Capability-specific provider diagnostic contracts shared by UI, persistence, and native hosts. */
type ProviderDiagnosticCapability = "probe" | "text-generation" | "embedding"
type ProviderDiagnosticMode = "quick" | "precise"
type ProviderDiagnosticSampleRole = "warmup" | "measured"
type ProviderDiagnosticStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled" | "unverified"
type ProviderDiagnosticFailureCode =
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
interface ProviderDiagnosticFailure {
  code: ProviderDiagnosticFailureCode
  retryable: boolean
  /** Redacted technical detail. Never include credentials or raw response bodies. */
  message: string
  httpStatus?: number
  retryAfterMs?: number
}
interface ProviderDiagnosticTarget {
  id: string
  providerId: string
  modelId?: string
  credentialId?: string
  credentialFingerprint: string
  endpoint: string
  capability: ProviderDiagnosticCapability
}
interface ProviderProbeResult {
  reachable: boolean
  authenticated?: boolean
  capabilityVerified: boolean
  durationMs: number
  httpStatus?: number
  failure?: ProviderDiagnosticFailure
}
interface ProviderBenchmarkMetrics {
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
interface ProviderDiagnosticSample {
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
interface ProviderDiagnosticJob {
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
type ProviderEndpointCandidateSource = "catalog" | "current" | "user" | "ccswitch"
interface ProviderEndpointCandidate {
  id: string
  providerId: string
  url: string
  source: ProviderEndpointCandidateSource
  label?: string
}
interface ProviderEndpointChange {
  id: string
  providerId: string
  previousEndpoint: string
  appliedEndpoint: string
  appliedAt: number
  rolledBackAt?: number
}
type ProviderBalanceSourceKind =
  "official" | "declarative" | "sandbox-script" | "plugin" | "unsupported"
interface ProviderBalanceSource {
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
interface ProviderBalanceScriptGrant {
  domain: string
  allowHttp: boolean
  allowPrivate: boolean
}
interface ProviderBalanceScriptSourceConfig {
  id: string
  providerId: string
  label: string
  script: string
  sameOrigin: string
  credentialRef: string
  grants: ProviderBalanceScriptGrant[]
  enabled: boolean
}
interface ProviderBalanceAmount {
  unit: string
  remaining?: number
  total?: number
  used?: number
}
interface ProviderBalanceSnapshot {
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
interface ProviderDiagnosticsPreferences {
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
  lowBalanceThresholdsBySource: Record<
    string,
    {
      unit: string
      value: number
    }
  >
  balanceScriptSources: ProviderBalanceScriptSourceConfig[]
}
interface ProviderDiagnosticsRefreshState {
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
declare const PROVIDER_DIAGNOSTICS_HARD_LIMITS: {
  readonly maxRequestsPerJob: 50
  readonly maxEstimatedCostUsd: 0.25
}
declare const DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES: ProviderDiagnosticsPreferences
/**
 * Force the two budget fields back under [`PROVIDER_DIAGNOSTICS_HARD_LIMITS`].
 *
 * A non-finite or negative value is not "unlimited" — it is a broken row, and
 * the ceiling is the only reading that cannot overspend.
 */
declare function clampProviderDiagnosticsBudget(
  preferences: ProviderDiagnosticsPreferences
): ProviderDiagnosticsPreferences

export {
  DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES,
  PROVIDER_DIAGNOSTICS_HARD_LIMITS,
  type ProviderBalanceAmount,
  type ProviderBalanceScriptGrant,
  type ProviderBalanceScriptSourceConfig,
  type ProviderBalanceSnapshot,
  type ProviderBalanceSource,
  type ProviderBalanceSourceKind,
  type ProviderBenchmarkMetrics,
  type ProviderDiagnosticCapability,
  type ProviderDiagnosticFailure,
  type ProviderDiagnosticFailureCode,
  type ProviderDiagnosticJob,
  type ProviderDiagnosticMode,
  type ProviderDiagnosticSample,
  type ProviderDiagnosticSampleRole,
  type ProviderDiagnosticStatus,
  type ProviderDiagnosticTarget,
  type ProviderDiagnosticsPreferences,
  type ProviderDiagnosticsRefreshState,
  type ProviderEndpointCandidate,
  type ProviderEndpointCandidateSource,
  type ProviderEndpointChange,
  type ProviderProbeResult,
  clampProviderDiagnosticsBudget,
}
