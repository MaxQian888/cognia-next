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
}

/** An alias and its routing-engine-ordered entries. */
export interface GatewayAliasSnapshot {
  alias: string
  entries: GatewaySnapshotEntry[]
}

/** Upstream multi-account rotation strategy — mirrors the app's
 * `ApiKeyRotationStrategy`. */
export type GatewayRotationStrategy = "round-robin" | "random" | "least-used"

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
}

/** Routing + credential snapshot pushed into the Rust gateway. */
export interface GatewayRoutingSnapshot {
  aliases: GatewayAliasSnapshot[]
  providers: GatewayProviderSnapshot[]
  generatedAtMs: number
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
}

/** Per-attempt outcome (from the `gateway://request-outcome` event). */
export interface GatewayRequestOutcome {
  providerId: string
  modelId: string
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

export const GATEWAY_REQUEST_LOG_EVENT = "gateway://request-log"
export const GATEWAY_REQUEST_OUTCOME_EVENT = "gateway://request-outcome"
export const GATEWAY_DECIDE_EVENT = "gateway://decide"
