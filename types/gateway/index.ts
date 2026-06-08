/**
 * Inbound LLM Gateway types (ADR-0043 M3).
 *
 * Mirror the Rust serde shapes in `src-tauri/src/gateway/{types,snapshot}.rs`
 * (camelCase). The gateway is desktop-only (it needs an HTTP listener, which
 * only the Tauri shell provides) — web/mobile builds hide the whole surface.
 */

/** Persisted gateway configuration. */
export interface GatewayConfig {
  enabled: boolean
  /** TCP port on 127.0.0.1; 0 = OS-assigned ephemeral. */
  port: number
  /** IPv4 allowlist (CIDR strings). */
  allowlist: string[]
  /** Fixed-window per-minute request budget. */
  rateLimitPerMin: number
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  enabled: false,
  port: 47823,
  allowlist: ["127.0.0.1/32"],
  rateLimitPerMin: 600,
}

/** Live status surfaced to the settings UI. */
export interface GatewayStatus {
  running: boolean
  boundPort: number | null
  hasToken: boolean
  callsTotal: number
  lastCallAt: string | null
  snapshotGeneratedAtMs: number | null
  snapshotProviderCount: number
  snapshotAliasCount: number
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

/** A provider the gateway can execute against. `apiKey` stays Rust-side. */
export interface GatewayProviderSnapshot {
  id: string
  /** Wire protocol: "openai" | "anthropic" execute; others are listed but skipped. */
  protocol: string
  baseUrl: string
  apiKey?: string
  enabled: boolean
  models: string[]
}

/** Routing + credential snapshot pushed into the Rust gateway. */
export interface GatewayRoutingSnapshot {
  aliases: GatewayAliasSnapshot[]
  providers: GatewayProviderSnapshot[]
  generatedAtMs: number
}

/** One inbound request log entry (from the `gateway://inbound-call` event). */
export interface GatewayInboundCall {
  id: string
  at: string
  route: string
  status: number
  remoteIp: string
}

/** Per-request outcome (from the `gateway://request-outcome` event). */
export interface GatewayRequestOutcome {
  providerId: string
  modelId: string
  ok: boolean
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  errorMessage: string | null
}

export const GATEWAY_INBOUND_CALL_EVENT = "gateway://inbound-call"
export const GATEWAY_REQUEST_OUTCOME_EVENT = "gateway://request-outcome"
export const GATEWAY_DECIDE_EVENT = "gateway://decide"
