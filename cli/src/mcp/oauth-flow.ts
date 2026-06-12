/**
 * Drives the interactive OAuth authorization-code flow for a remote MCP server
 * (`/mcp auth <name>`):
 *
 *   1. start a loopback callback server (gets the redirect URI);
 *   2. attach an `OAuthClientProvider` to a fresh connection;
 *   3. `connect()` either succeeds (a stored refresh token still works) or
 *      throws `UnauthorizedError` after opening the browser;
 *   4. capture the redirect `code`, verify the CSRF `state`, `finishAuth(code)`;
 *   5. reconnect to confirm the new tokens, then tear everything down.
 *
 * Tokens land in `mcp-auth.json` via the provider. Every collaborator (browser
 * opener, callback server, connection, RNG) is injectable so the orchestration
 * is unit-tested without sockets or a real browser.
 */
import type { McpServer } from "@/lib/claude/types"

import { createMcpConnection, type McpClientLike, type OpenedMcp } from "./mcp-client"
import { startCallbackServer, type CallbackServer } from "./oauth-callback-server"
import { createMcpOAuthProvider } from "./oauth-provider"
import { type McpAuthFs } from "./oauth-store"
import { isUnauthorized } from "./probe-mcp-server"
import { openBrowser } from "./open-browser"

export type AuthFlowStatus = "authorized" | "denied" | "error" | "unsupported"

export interface AuthFlowResult {
  ok: boolean
  status: AuthFlowStatus
  message: string
}

export interface AuthFlowDeps {
  home: string
  scope?: string
  /** How long to wait for the browser redirect (default 3 min). */
  timeoutMs?: number
  fs?: McpAuthFs
  createConnection?: (
    server: McpServer,
    opts: { authProvider?: unknown }
  ) => Promise<{ client: McpClientLike; transport: OpenedMcp["transport"] }>
  startCallbackServer?: typeof startCallbackServer
  openBrowser?: (url: string) => Promise<boolean>
  /** Surface the authorization URL to the TUI (manual-paste fallback). */
  onAuthUrl?: (url: string) => void
  isAuthError?: (err: unknown) => boolean
  /** CSRF state generator (injected for deterministic tests). */
  randomState?: () => string
}

function randomToken(): string {
  // 16 hex chars of weak-but-sufficient CSRF state (the redirect is loopback).
  let s = ""
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

/**
 * Authenticate a remote MCP server via OAuth. Never throws — every failure mode
 * is reported as a structured {@link AuthFlowResult}.
 */
export async function authenticateMcpServer(
  server: McpServer,
  deps: AuthFlowDeps
): Promise<AuthFlowResult> {
  if (server.transport === "stdio") {
    return {
      ok: false,
      status: "unsupported",
      message: `"${server.name}" is a stdio server — OAuth applies to sse/http servers only.`,
    }
  }

  const startServer = deps.startCallbackServer ?? startCallbackServer
  const createConnection = deps.createConnection ?? createMcpConnection
  const open = deps.openBrowser ?? openBrowser
  const isAuthError = deps.isAuthError ?? isUnauthorized
  const timeoutMs = deps.timeoutMs ?? 180_000
  const state = (deps.randomState ?? randomToken)()

  let callback: CallbackServer
  try {
    callback = await startServer()
  } catch (err) {
    return {
      ok: false,
      status: "error",
      message: `Could not start OAuth callback server: ${msg(err)}`,
    }
  }

  let client: McpClientLike | undefined
  try {
    const provider = createMcpOAuthProvider({
      home: deps.home,
      serverName: server.name,
      redirectUrl: callback.redirectUrl,
      scope: deps.scope,
      state,
      fs: deps.fs,
      onRedirect: async (url) => {
        deps.onAuthUrl?.(url.href)
        await open(url.href)
      },
    })

    const conn = await createConnection(server, { authProvider: provider })
    client = conn.client
    const { transport } = conn

    try {
      await client.connect(transport)
      // A stored refresh token still works — no browser round-trip needed.
      return { ok: true, status: "authorized", message: `"${server.name}" is already authorized.` }
    } catch (err) {
      if (!isAuthError(err)) {
        return { ok: false, status: "error", message: `Connection failed: ${msg(err)}` }
      }
      // UnauthorizedError → the provider opened the browser; await the redirect.
    }

    let result
    try {
      result = await callback.waitForCode(timeoutMs)
    } catch (err) {
      return { ok: false, status: "denied", message: msg(err) }
    }

    if (result.state && result.state !== state) {
      return {
        ok: false,
        status: "error",
        message: "OAuth state mismatch (possible CSRF) — aborted.",
      }
    }
    if (!result.code) {
      return { ok: false, status: "denied", message: "Authorization server returned no code." }
    }

    if (typeof transport.finishAuth !== "function") {
      return { ok: false, status: "error", message: "Transport does not support OAuth completion." }
    }
    try {
      await transport.finishAuth(result.code)
      await client.connect(transport)
    } catch (err) {
      return { ok: false, status: "error", message: `Token exchange failed: ${msg(err)}` }
    }

    return { ok: true, status: "authorized", message: `"${server.name}" authorized.` }
  } finally {
    await client?.close().catch(() => undefined)
    callback.close()
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
