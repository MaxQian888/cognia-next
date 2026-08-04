/**
 * Inbound LLM Gateway types (ADR-0043 M3).
 *
 * Mirror the Rust serde shapes in `src-tauri/src/gateway/{types,snapshot,api_keys}.rs`
 * (camelCase). The gateway is desktop-only (it needs an HTTP listener, which
 * only the Tauri shell provides) — web/mobile builds hide the whole surface.
 */

/** Which interface the listener binds to. */
export type GatewayBindInterface = "loopback" | "lan"

/** Persisted gateway configuration. */
export interface GatewayConfig {
  enabled: boolean
  /** TCP port; 0 = OS-assigned ephemeral. */
  port: number
  /** IPv4 allowlist (CIDR strings). */
  allowlist: string[]
  /** Fixed-window per-minute request budget. */
  rateLimitPerMin: number
  /** Interface the listener binds to. */
  bindInterface: GatewayBindInterface
  /** Upstream TCP+TLS connect timeout (seconds). Bounds hung connects. */
  connectTimeoutSecs: number
  /** Total timeout (seconds) for NON-streaming requests; 0 = no cap. */
  requestTimeoutSecs: number
  /** Max candidate attempts before giving up; 0 = walk the whole chain. */
  maxRetries: number
  /** Upstream statuses that advance the failover walk. */
  retryStatusCodes: number[]
  /** Exponential retry backoff floor in milliseconds. */
  retryBackoffBaseMs: number
  /** Exponential retry backoff ceiling in milliseconds. */
  retryBackoffMaxMs: number
  /** Total time budget spent waiting between attempts. */
  maxRetryWaitMs: number
  /** Prefer upstream recovery headers over the local backoff schedule. */
  respectRetryAfter: boolean
  /** Rollout kill switch for the Rust-local V2 planner. */
  gatewayLocalRoutingV2: boolean
  /** Model/alias ids the gateway advertises + serves. Empty = expose all. */
  exposedModels: string[]
  /** List only aliases in `/v1/models` (hide raw provider model ids). */
  hideRawProviderModels: boolean

  // ---- W1.1 upstream cooldown (per pooled key) ------------------------------
  /** Cooldown (seconds) for a 429 with no parseable recovery header; `0`
   * disables the header-less fallback. Header-derived cooldowns always apply. */
  cooldownFallbackSecs: number
  /** Cooldown (seconds) for a 529 "overloaded" with no recovery header. */
  overloadCooldownSecs: number

  // ---- W3.1 permanent key disable -------------------------------------------
  /** Case-insensitive substrings that, in a failing body, permanently disable
   * the pooled key (quota exhausted / org disabled). A 401 is always permanent. */
  disableKeywords: string[]

  // ---- W1.2 in-flight concurrency caps --------------------------------------
  /** Max simultaneous in-flight requests per gateway API key; `0` = unlimited. */
  maxConcurrentPerKey: number
  /** Max simultaneous in-flight upstream calls per pooled key; `0` = unlimited. */
  maxConcurrentPerUpstreamKey: number
  /** Wait (ms) for a concurrency slot before rejecting with 429; `0` = no queue. */
  concurrencyWaitMs: number
  /** Seconds an SSE pump tolerates TOTAL upstream silence before abandoning the
   * stream; `0` = wait forever. Streaming skips `requestTimeoutSecs` (a long
   * generation is not a hung one), so without this a silent upstream parks the
   * pump and leaks its concurrency slots + in-flight tally. */
  streamIdleTimeoutSecs: number

  // ---- W3.2 outbound field stripping ----------------------------------------
  /** Dotted-path fields stripped from every upstream request body. */
  strippedRequestFields: string[]
  /** Per-provider re-permits (`"providerId:field"`) that keep a stripped field. */
  fieldStripAllow: string[]
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  enabled: false,
  port: 47823,
  allowlist: ["127.0.0.1/32"],
  rateLimitPerMin: 600,
  bindInterface: "loopback",
  connectTimeoutSecs: 30,
  requestTimeoutSecs: 300,
  maxRetries: 0,
  retryStatusCodes: [408, 409, 429, 500, 502, 503, 504],
  retryBackoffBaseMs: 250,
  retryBackoffMaxMs: 4000,
  maxRetryWaitMs: 60000,
  respectRetryAfter: true,
  gatewayLocalRoutingV2: true,
  exposedModels: [],
  hideRawProviderModels: false,
  cooldownFallbackSecs: 20,
  overloadCooldownSecs: 600,
  disableKeywords: [
    "insufficient_quota",
    "organization has been disabled",
    "deactivated_workspace",
    "account_deactivated",
  ],
  maxConcurrentPerKey: 0,
  maxConcurrentPerUpstreamKey: 0,
  concurrencyWaitMs: 10_000,
  streamIdleTimeoutSecs: 300,
  strippedRequestFields: [
    "service_tier",
    "store",
    "safety_identifier",
    "stream_options.include_obfuscation",
  ],
  fieldStripAllow: [],
}

/** Live status surfaced to the settings UI. */
export interface GatewayStatus {
  running: boolean
  boundPort: number | null
  /** Whether at least one usable API key exists. */
  hasToken: boolean
  bindInterface: GatewayBindInterface
  callsTotal: number
  lastCallAt: string | null
  snapshotGeneratedAtMs: number | null
  snapshotProviderCount: number
  snapshotAliasCount: number
  /** Active V2 policy revision; absent for legacy snapshots. */
  routingPolicyRevision?: string | null
  /** Effective built-in strategy used for the virtual `auto` model. */
  routingStrategy?: GatewayRoutingStrategy | null
  /** Requested plugin/custom strategy that degraded to reliability. */
  routingStrategyUnavailable?: string | null
  /** True when requests are planned locally without renderer IPC. */
  localRoutingEnabled?: boolean
}

/** A scoped API key WITH its secret — returned only on create / reveal. */
export interface GatewayApiKey {
  id: string
  name: string
  secret: string
  modelAllowlist: string[]
  expiresAtMs: number | null
  enabled: boolean
  rateLimitPerMin: number | null
  /** Cumulative token budget (input + output); `null` = unlimited. */
  quotaTokens: number | null
  /** Tokens consumed so far against `quotaTokens`. */
  quotaUsedTokens: number
  createdAtMs: number
  lastUsedAtMs: number | null
}

/** A key with its secret redacted to a fingerprint — the list shape. */
export interface GatewayApiKeyRedacted {
  id: string
  name: string
  modelAllowlist: string[]
  expiresAtMs: number | null
  enabled: boolean
  rateLimitPerMin: number | null
  quotaTokens: number | null
  quotaUsedTokens: number
  createdAtMs: number
  lastUsedAtMs: number | null
  /** e.g. `sk-cognia-…a1b2` — enough to identify, not to use. */
  secretPreview: string
}

/** Mutable fields on an existing key. Absent = unchanged; explicit `null`
 * clears an optional value (expiry / per-key rate limit / quota). */
export interface GatewayApiKeyPatch {
  name?: string
  modelAllowlist?: string[]
  expiresAtMs?: number | null
  enabled?: boolean
  rateLimitPerMin?: number | null
  /** Explicit `null` clears the quota (→ unlimited); never resets used. */
  quotaTokens?: number | null
}

/** One entry in an alias's pre-ordered deployment chain. */
export interface GatewaySnapshotEntry {
  providerId: string
  modelId: string
  /** Optional deployment-level weight used by weighted alias distribution. */
  weight?: number
  deploymentId?: string
  available?: boolean
  locality?: "local" | "remote"
  capabilities?: {
    tools?: boolean
    vision?: boolean
    structuredOutput?: boolean
    streaming?: boolean
    contextTokens?: number
  }
  pricingPer1M?: number
  latencyMs?: number
  successRate?: number
  conditions?: { maxCostPer1M?: number; maxLatencyMs?: number }
}

/** An alias and its routing-engine-ordered entries. */
export interface GatewayAliasSnapshot {
  alias: string
  /** Explicit aliases own their distribution policy. Legacy snapshots default to priority. */
  distribution?: "priority" | "weighted" | "round-robin"
  entries: GatewaySnapshotEntry[]
  parameterDefaults?: {
    temperature?: number
    maxTokens?: number
    topP?: number
    frequencyPenalty?: number
    presencePenalty?: number
  }
}

export type GatewayRoutingStrategy =
  | "reliability"
  | "quality"
  | "cost"
  | "speed"
  | "balanced"
  | "adaptive"
  | "least-busy"
  | "difficulty"

export interface GatewayAutoRoutingPolicy {
  modelId: string
  strategy: GatewayRoutingStrategy | (string & {})
  candidateAliases: string[]
  thresholds?: { balanced: number; powerful: number }
  /** Requested plugin/custom strategy that degraded to reliability. */
  strategyUnavailable?: string
}

/** Versioned, secret-free policy executed on the Rust request hot path. */
export interface GatewayRoutingPolicySnapshotV2 {
  schemaVersion: 2
  policyRevision: string
  auto: GatewayAutoRoutingPolicy
  maxFallbackAttempts: number
  tierAliases?: Record<string, string>
  providerConstraints?: Array<{
    providerId: string
    maxRequestsPerMinute?: number
    maxTokensPerMinute?: number
    dailyCostBudget?: number
    priority?: number
    enabled: boolean
    currentRequestsPerMinute?: number
    currentTokensPerMinute?: number
    currentDailyCost?: number
    circuitOpen?: boolean
  }>
  circuitBreaker?: {
    enabled: boolean
    failureThreshold?: number
    windowDurationMs?: number
    cooldownMs?: number
  }
}

/** Upstream multi-account rotation strategy — mirrors the app's
 * `ApiKeyRotationStrategy`. */
export type GatewayRotationStrategy = "round-robin" | "random" | "least-used"

/** Wire/auth behavior projected from the Provider Profile Store's
 * TransportProfile (ADR-0090 Phase 2). Absent = legacy protocol defaults. */
export interface GatewayTransportSnapshot {
  authScheme: "x-api-key" | "bearer" | "custom-header"
  authHeaderName?: string
  staticHeaders?: Array<[string, string]>
  forwardedSemanticHeaders?: string[]
}

/** A provider the gateway can execute against. Credentials stay Rust-side. */
export interface GatewayProviderSnapshot {
  id: string
  protocol: string
  baseUrl: string
  /** Primary / single credential; the fallback when no rotation pool is set. */
  apiKey?: string
  /** Upstream multi-account pool — mirrors the provider's
   * `UserProviderSettings.apiKeys[]` so the gateway rotates / fails over across
   * the same accounts the chat pipeline does. */
  apiKeys?: string[]
  /** Rotation strategy for the pool; `undefined` = round-robin. */
  rotationStrategy?: GatewayRotationStrategy
  /** Whether the pool actually rotates (mirrors `apiKeyRotationEnabled`). */
  rotationEnabled?: boolean
  enabled: boolean
  models: string[]
  /** Provider Profile Store deployment this entry projects (ADR-0090). */
  deploymentId?: string
  /** Transport behavior override; absent = legacy protocol defaults. */
  transport?: GatewayTransportSnapshot
}

/** Routing + credential snapshot pushed into the Rust gateway. */
export interface GatewayRoutingSnapshot {
  aliases: GatewayAliasSnapshot[]
  providers: GatewayProviderSnapshot[]
  generatedAtMs: number
  /** Present on V2 publishers; absent snapshots retain legacy priority behavior. */
  routingPolicy?: GatewayRoutingPolicySnapshotV2
  /** Provider Profile Store CAS version this snapshot projects (R3). */
  profileVersion?: number
  /** Publisher identity; required alongside profileVersion. */
  authority?: "renderer" | "profile-store"
}

/** Result of a snapshot push — a rejected push (stale/conflicting version)
 * keeps the previous snapshot serving and reports why. */
export interface GatewayPushSnapshotResult {
  accepted: boolean
  profileVersion?: number | null
  reason?: string | null
}

/** Route-ticket metadata (never the secret) — ADR-0090 Phase 2 §3.4. */
export interface GatewayRouteTicket {
  ticketId: string
  routePinId: string
  executionFingerprint: string
  sessionId: string
  parentSessionId?: string | null
  candidates: Array<{ deploymentId: string; modelId: string }>
  modelBindings: Record<string, string>
  credentialAffinity: "session-sticky" | "sticky-with-failover" | "per-request"
  allowAuthFailover?: boolean
  routePolicy: string
  issuedAtMs: number
  expiresAtMs: number
  profileVersion?: number | null
  revoked?: boolean
}

/** Mint request for a route ticket (frozen spec projection). */
export interface GatewayMintRouteTicketRequest {
  sessionId: string
  parentSessionId?: string
  executionFingerprint: string
  candidates: Array<{ deploymentId: string; modelId: string }>
  modelBindings?: Record<string, string>
  credentialAffinity: "session-sticky" | "sticky-with-failover" | "per-request"
  allowAuthFailover?: boolean
  routePolicy: string
  ttlMs?: number
}

/** Mint response: the secret appears ONCE and must never be persisted. */
export interface GatewayMintedRouteTicket {
  ticket: GatewayRouteTicket
  secret: string
}

/**
 * One durable request-log row (from the `gateway://request-log` event, also
 * the persisted Dexie shape). Emitted once per request — success, upstream
 * failure, or middleware rejection.
 */
export interface GatewayRequestLogRow {
  id: string
  at: string
  route: string
  remoteIp: string
  keyId: string | null
  model: string | null
  providerId: string | null
  status: number
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  error: string | null
  stream: boolean
  decisionId?: string | null
  policyRevision?: string | null
  strategy?: GatewayRoutingStrategy | string | null
  distribution?: "priority" | "weighted" | "round-robin" | null
  routingLatencyMs?: number | null
  selectedDeployment?: string | null
  attempts?: Array<{
    providerId: string
    modelId: string
    deploymentId?: string | null
    status?: number | null
    latencyMs: number
    reason?: string | null
    keyFingerprint?: string | null
  }>
  fallbackReason?: string | null
  keyFingerprint?: string | null
}

/** Per-attempt outcome (from the `gateway://request-outcome` event). */
export interface GatewayRequestOutcome {
  providerId: string
  modelId: string
  deploymentId?: string | null
  /** Redacted upstream credential identity; never contains the secret. */
  keyFingerprint?: string | null
  ok: boolean
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  errorMessage: string | null
  /** Upstream-derived cooldown window (W1.1) — feeds the breaker's dynamic
   * cooldown. Present only on a 429/529 with a recovery hint. */
  retryAfterMs?: number | null
  /** Gateway-derived affinity session key (W1.3) — a successful outcome pins
   * this deployment; a permanent failure releases the pin. */
  sessionId?: string | null
}

/** One cooling / permanently-disabled upstream key (from
 * `gateway_list_cooldowns`; W1.1 + W3.1). Mirrors Rust `CooldownRow`. */
export interface GatewayKeyCooldown {
  providerId: string
  /** Key fingerprint (last 4 chars) — never the secret. */
  keyHint: string
  /** Epoch-ms the cooldown lifts; ignored when `permanent`. */
  untilMs: number
  permanent: boolean
  reason: string
}

/** One candidate's result from the upstream self-check (`gateway_probe_upstream`,
 * the IPC path onto the loopback-only `/healthz/upstream` route). Mirrors Rust
 * `UpstreamProbeResult`. */
export interface GatewayUpstreamProbeResult {
  providerId: string
  modelId: string
  ok: boolean
  /** Upstream HTTP status; `null` when the connection itself failed. */
  status: number | null
  latencyMs: number
  error: string | null
}

export const GATEWAY_REQUEST_LOG_EVENT = "gateway://request-log"
export const GATEWAY_REQUEST_OUTCOME_EVENT = "gateway://request-outcome"
export const GATEWAY_DECIDE_EVENT = "gateway://decide"
