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
import { randomBytes } from "node:crypto"
import type { McpServer } from "@cognia/agent-config-types"

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
  signal?: AbortSignal
  fs?: McpAuthFs
  createConnection?: (
    server: McpServer,
    opts: { authProvider?: unknown }
  ) => Promise<{
    client: McpClientLike
    transport: OpenedMcp["transport"]
    closeEgressGuard?: () => Promise<void>
  }>
  startCallbackServer?: typeof startCallbackServer
  openBrowser?: (url: string) => Promise<boolean>
  /** Surface the authorization URL to the TUI (manual-paste fallback). */
  onAuthUrl?: (url: string) => void
  isAuthError?: (err: unknown) => boolean
  /** CSRF state generator (injected for deterministic tests). */
  randomState?: () => string
}

function randomToken(): string {
  return randomBytes(32).toString("hex")
}

/**
 * Authenticate a remote MCP server via OAuth. Never throws — every failure mode
 * is reported as a structured {@link AuthFlowResult}.
 */
export async function authenticateMcpServer(
  server: McpServer,
  deps: AuthFlowDeps
): Promise<AuthFlowResult> {
  const cancelled = (): AuthFlowResult => ({
    ok: false,
    status: "denied",
    message: "OAuth authorization cancelled.",
  })
  if (deps.signal?.aborted) return cancelled()
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
  let callback: CallbackServer | undefined
  let connection: Awaited<ReturnType<NonNullable<AuthFlowDeps["createConnection"]>>> | undefined
  let finished = false
  const assertActive = () => {
    if (deps.signal?.aborted || finished) throw new Error("OAuth authorization cancelled.")
  }
  const closeConnection = async (conn: NonNullable<typeof connection>) => {
    await Promise.allSettled([
      Promise.resolve().then(() => conn.client.close()),
      Promise.resolve().then(() => conn.closeEgressGuard?.()),
    ])
  }
  const cleanup = () => {
    const cb = callback
    callback = undefined
    try {
      cb?.close()
    } catch {
      /* Continue releasing the connection. */
    }
    const conn = connection
    connection = undefined
    return conn ? closeConnection(conn) : Promise.resolve()
  }
  const onAbort = () => {
    void cleanup()
  }
  deps.signal?.addEventListener("abort", onAbort, { once: true })
  async function wait<T>(operation: () => Promise<T>): Promise<T> {
    assertActive()
    let onCancel: () => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      onCancel = () => reject(new Error("OAuth authorization cancelled."))
      deps.signal?.addEventListener("abort", onCancel, { once: true })
    })
    try {
      const result = await Promise.race([operation(), aborted])
      assertActive()
      return result
    } finally {
      deps.signal?.removeEventListener("abort", onCancel)
    }
  }
  let failurePrefix = "Could not start OAuth callback server"
  try {
    const state = (deps.randomState ?? randomToken)()
    const cb = await wait(() =>
      startServer().then((opened) => {
        if (deps.signal?.aborted || finished) opened.close()
        else callback = opened
        return opened
      })
    )
    failurePrefix = "Connection failed"
    const provider = createMcpOAuthProvider({
      home: deps.home,
      serverName: server.name,
      redirectUrl: cb.redirectUrl,
      scope: deps.scope,
      state,
      fs: deps.fs,
      onRedirect: async (url) => {
        assertActive()
        deps.onAuthUrl?.(url.href)
        await wait(() => open(url.href))
      },
    })

    const conn = await wait(() =>
      createConnection(server, { authProvider: provider }).then((opened) => {
        if (deps.signal?.aborted || finished) void closeConnection(opened)
        else connection = opened
        return opened
      })
    )
    const { transport } = conn

    try {
      await wait(() => conn.client.connect(transport))
      // A stored refresh token still works — no browser round-trip needed.
      return { ok: true, status: "authorized", message: `"${server.name}" is already authorized.` }
    } catch (err) {
      assertActive()
      if (!isAuthError(err)) {
        return { ok: false, status: "error", message: `Connection failed: ${msg(err)}` }
      }
      // UnauthorizedError → the provider opened the browser; await the redirect.
    }

    let result
    try {
      result = await wait(() => cb.waitForCode(timeoutMs))
    } catch (err) {
      assertActive()
      return { ok: false, status: "denied", message: msg(err) }
    }

    if (result.state !== state) {
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
      await wait(() => transport.finishAuth!(result.code!))
      await wait(() => conn.client.connect(transport))
    } catch (err) {
      assertActive()
      return { ok: false, status: "error", message: `Token exchange failed: ${msg(err)}` }
    }

    return { ok: true, status: "authorized", message: `"${server.name}" authorized.` }
  } catch (err) {
    if (deps.signal?.aborted) return cancelled()
    return { ok: false, status: "error", message: `${failurePrefix}: ${msg(err)}` }
  } finally {
    finished = true
    deps.signal?.removeEventListener("abort", onAbort)
    await cleanup()
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
