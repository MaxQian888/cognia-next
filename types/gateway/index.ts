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
}

export const GATEWAY_REQUEST_LOG_EVENT = "gateway://request-log"
export const GATEWAY_REQUEST_OUTCOME_EVENT = "gateway://request-outcome"
export const GATEWAY_DECIDE_EVENT = "gateway://decide"
