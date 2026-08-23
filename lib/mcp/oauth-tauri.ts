/**
 * Renderer-side wrappers for the desktop MCP-OAuth Tauri commands. The actual
 * token storage (OS keyring) and the interactive authorization flow live in
 * Rust (`src-tauri/src/mcp_oauth/`) + a Node helper; the renderer only ever
 * calls these commands and never touches `node:fs` / loopback servers (the
 * static-export build forbids it).
 *
 * Tokens are partitioned by stable server ID, endpoint fingerprint, and pinned
 * scopes. Legacy callers can still read the former ID/name keys, but a caller
 * with a concrete endpoint never falls back because the former entry cannot
 * prove which origin issued it.
 */
import { transport } from "@/lib/tauri"
import { getBuiltinMcpRuntimeContext } from "@/lib/claude/builtin-mcp/runtime-context"
import {
  resolveMcpOAuthCredentialPartition,
  runMcpOAuthRefreshSingleFlight,
} from "./oauth-security"

/** A server descriptor the OAuth helper needs (transport + connection config). */
export interface McpServerDescriptor {
  transport: "stdio" | "sse" | "http"
  config: Record<string, unknown>
}

/** Resolve the bundled OAuth helper script path (sidecar dir + filename). */
async function resolveHelperPath(): Promise<string> {
  const ctx = await getBuiltinMcpRuntimeContext()
  if (!ctx) throw new Error("MCP OAuth requires the desktop app")
  return `${ctx.sidecarDir}/mcp-oauth-helper.mjs`
}

/** Stored OAuth state for a server, projected for header injection / status. */
export interface McpOAuthStatus {
  hasTokens: boolean
  expiresAtMs?: number
}

export interface McpOAuthEntry {
  accessToken?: string
  expiresAtMs?: number
}

/** Auth-flow outcome mirrored from the Node helper's structured result. */
export interface McpOAuthResult {
  ok: boolean
  status: "authorized" | "denied" | "error" | "unsupported"
  message: string
}

/** Whether a server currently has stored tokens (+ optional expiry). */
export async function mcpOAuthStatus(
  serverId: string,
  legacyName?: string,
  server?: McpServerDescriptor
): Promise<McpOAuthStatus> {
  const credentialKey = server
    ? (await resolveMcpOAuthCredentialPartition(serverId, server)).credentialKey
    : serverId
  const raw = await transport.call<{ has_tokens: boolean; expires_at_ms?: number | null }>(
    "mcp_oauth_status",
    { serverName: credentialKey }
  )
  if (!raw.has_tokens && legacyName && legacyName !== serverId && credentialKey === serverId) {
    const legacy = await transport.call<{ has_tokens: boolean; expires_at_ms?: number | null }>(
      "mcp_oauth_status",
      { serverName: legacyName }
    )
    return { hasTokens: legacy.has_tokens, expiresAtMs: legacy.expires_at_ms ?? undefined }
  }
  return { hasTokens: raw.has_tokens, expiresAtMs: raw.expires_at_ms ?? undefined }
}

/** Load a server's access token (for send-time header injection). */
export async function mcpOAuthLoadEntry(
  serverId: string,
  legacyName?: string,
  server?: McpServerDescriptor
): Promise<McpOAuthEntry | undefined> {
  const credentialKey = server
    ? (await resolveMcpOAuthCredentialPartition(serverId, server)).credentialKey
    : serverId
  const raw = await transport.call<{
    access_token?: string | null
    expires_at_ms?: number | null
  } | null>("mcp_oauth_load_entry", { serverName: credentialKey })
  if (
    (!raw || !raw.access_token) &&
    credentialKey === serverId &&
    legacyName &&
    legacyName !== serverId
  ) {
    return mcpOAuthLoadEntry(legacyName)
  }
  if (!raw?.access_token) return undefined
  return { accessToken: raw.access_token, expiresAtMs: raw.expires_at_ms ?? undefined }
}

/** Run a headless refresh (PKCE refresh token) and return the new entry. */
export async function mcpOAuthRefresh(
  serverId: string,
  server: McpServerDescriptor
): Promise<McpOAuthEntry | undefined> {
  const partition = await resolveMcpOAuthCredentialPartition(serverId, server)
  return runMcpOAuthRefreshSingleFlight(partition.credentialKey, async () => {
    const helperPath = await resolveHelperPath()
    const raw = await transport.call<{
      access_token?: string | null
      expires_at_ms?: number | null
    } | null>("mcp_oauth_refresh", {
      serverName: partition.credentialKey,
      server,
      helperPath,
    })
    if (!raw || !raw.access_token) return undefined
    return { accessToken: raw.access_token, expiresAtMs: raw.expires_at_ms ?? undefined }
  })
}

/** Drive the interactive authorization-code flow (opens the browser). */
export async function mcpOAuthAuthenticate(
  serverId: string,
  server: McpServerDescriptor
): Promise<McpOAuthResult> {
  const partition = await resolveMcpOAuthCredentialPartition(serverId, server)
  const helperPath = await resolveHelperPath()
  return transport.call<McpOAuthResult>("mcp_oauth_authenticate", {
    serverName: partition.credentialKey,
    server,
    helperPath,
  })
}

/** Clear a server's stored tokens (`/mcp logout` equivalent). */
export async function mcpOAuthClear(
  serverId: string,
  legacyName?: string,
  server?: McpServerDescriptor
): Promise<void> {
  const credentialKey = server
    ? (await resolveMcpOAuthCredentialPartition(serverId, server)).credentialKey
    : serverId
  await transport.call("mcp_oauth_clear", { serverName: credentialKey })
  if (credentialKey !== serverId) {
    await transport.call("mcp_oauth_clear", { serverName: serverId })
  }
  if (legacyName && legacyName !== serverId) {
    await transport.call("mcp_oauth_clear", { serverName: legacyName })
  }
}
