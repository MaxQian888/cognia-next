import type { McpServerDescriptor } from "./oauth-tauri"

export interface McpOAuthCredentialPartition {
  endpoint: string
  endpointFingerprint: string
  scopes: string[]
  scopeFingerprint: string
  credentialKey: string
}

export interface McpOAuthScopeReview {
  state: "unchanged" | "reduced" | "step-up"
  requested: string[]
  added: string[]
  removed: string[]
}

const refreshFlights = new Map<string, Promise<unknown>>()

/** Canonical remote endpoint used to isolate OAuth metadata, registration, and tokens. */
export function canonicalMcpOAuthEndpoint(server: McpServerDescriptor): string {
  if (server.transport === "stdio") throw new Error("MCP OAuth requires a remote endpoint")
  const raw = server.config.url
  if (typeof raw !== "string" || !raw.trim()) throw new Error("MCP OAuth endpoint is missing")
  const endpoint = new URL(raw)
  if (endpoint.username || endpoint.password) {
    throw new Error("MCP OAuth endpoint cannot contain credentials")
  }
  const isLoopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost"
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLoopback)) {
    throw new Error("MCP OAuth endpoint must use HTTPS or loopback HTTP")
  }
  endpoint.hash = ""
  endpoint.searchParams.sort()
  endpoint.pathname = endpoint.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/"
  return endpoint.href
}

export function normalizeMcpOAuthScopes(server: McpServerDescriptor): string[] {
  const configured = server.config.scopes ?? server.config.scope
  const values = Array.isArray(configured)
    ? configured
    : typeof configured === "string"
      ? configured.split(/\s+/)
      : []
  return [...new Set(values.filter((value): value is string => typeof value === "string"))]
    .map((value) => value.trim())
    .filter(Boolean)
    .sort()
}

export function reviewMcpOAuthScopes(
  pinnedScopes: readonly string[],
  requestedScopes: readonly string[]
): McpOAuthScopeReview {
  const pinned = new Set(pinnedScopes)
  const requested = [...new Set(requestedScopes)].sort()
  const desired = new Set(requested)
  const added = requested.filter((scope) => !pinned.has(scope))
  const removed = [...pinned].filter((scope) => !desired.has(scope)).sort()
  return {
    state: added.length > 0 ? "step-up" : removed.length > 0 ? "reduced" : "unchanged",
    requested,
    added,
    removed,
  }
}

export async function resolveMcpOAuthCredentialPartition(
  serverId: string,
  server: McpServerDescriptor
): Promise<McpOAuthCredentialPartition> {
  const endpoint = canonicalMcpOAuthEndpoint(server)
  const scopes = normalizeMcpOAuthScopes(server)
  const [endpointFingerprint, scopeFingerprint] = await Promise.all([
    sha256Hex(endpoint),
    sha256Hex(scopes.join("\n")),
  ])
  return {
    endpoint,
    endpointFingerprint,
    scopes,
    scopeFingerprint,
    credentialKey: `${serverId}:${endpointFingerprint.slice(0, 32)}:${scopeFingerprint.slice(0, 16)}`,
  }
}

/** Collapse simultaneous refreshes for one endpoint/scope partition into one request. */
export async function runMcpOAuthRefreshSingleFlight<T>(
  credentialKey: string,
  refresh: () => Promise<T>
): Promise<T> {
  const active = refreshFlights.get(credentialKey)
  if (active) return active as Promise<T>
  const pending = refresh().finally(() => {
    if (refreshFlights.get(credentialKey) === pending) refreshFlights.delete(credentialKey)
  })
  refreshFlights.set(credentialKey, pending)
  return pending
}

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error("Web Crypto is required for MCP OAuth credential isolation")
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
