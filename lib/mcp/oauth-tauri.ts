/**
 * Renderer-side wrappers for the desktop MCP-OAuth Tauri commands. The actual
 * token storage (OS keyring) and the interactive authorization flow live in
 * Rust (`src-tauri/src/mcp_oauth/`) + a Node helper; the renderer only ever
 * calls these commands and never touches `node:fs` / loopback servers (the
 * static-export build forbids it).
 *
 * Tokens are keyed by MCP server NAME (the same key the `mcpServers` map uses).
 */
import { transport } from "@/lib/tauri"
import { getBuiltinMcpRuntimeContext } from "@/lib/claude/builtin-mcp/runtime-context"

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
export async function mcpOAuthStatus(serverName: string): Promise<McpOAuthStatus> {
  const raw = await transport.call<{ has_tokens: boolean; expires_at_ms?: number | null }>(
    "mcp_oauth_status",
    { serverName }
  )
  return { hasTokens: raw.has_tokens, expiresAtMs: raw.expires_at_ms ?? undefined }
}

/** Load a server's access token (for send-time header injection). */
export async function mcpOAuthLoadEntry(serverName: string): Promise<McpOAuthEntry | undefined> {
  const raw = await transport.call<{
    access_token?: string | null
    expires_at_ms?: number | null
  } | null>("mcp_oauth_load_entry", { serverName })
  if (!raw || !raw.access_token) return undefined
  return { accessToken: raw.access_token, expiresAtMs: raw.expires_at_ms ?? undefined }
}

/** Run a headless refresh (PKCE refresh token) and return the new entry. */
export async function mcpOAuthRefresh(
  serverName: string,
  server: McpServerDescriptor
): Promise<McpOAuthEntry | undefined> {
  const helperPath = await resolveHelperPath()
  const raw = await transport.call<{
    access_token?: string | null
    expires_at_ms?: number | null
  } | null>("mcp_oauth_refresh", { serverName, server, helperPath })
  if (!raw || !raw.access_token) return undefined
  return { accessToken: raw.access_token, expiresAtMs: raw.expires_at_ms ?? undefined }
}

/** Drive the interactive authorization-code flow (opens the browser). */
export async function mcpOAuthAuthenticate(
  serverName: string,
  server: McpServerDescriptor
): Promise<McpOAuthResult> {
  const helperPath = await resolveHelperPath()
  return transport.call<McpOAuthResult>("mcp_oauth_authenticate", {
    serverName,
    server,
    helperPath,
  })
}

/** Clear a server's stored tokens (`/mcp logout` equivalent). */
export async function mcpOAuthClear(serverName: string): Promise<void> {
  await transport.call("mcp_oauth_clear", { serverName })
}
