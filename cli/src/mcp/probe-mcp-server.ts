/**
 * Rich MCP server probe: one connection yields the server's live status plus
 * its advertised tools, resources, and prompts. Powers `/mcp list` (status
 * symbols), `/mcp resources`, and `/mcp prompts`. A disabled server is reported
 * without a connection; a remote server that needs authorization is reported as
 * `needs_auth` rather than a generic failure so the UI can point at `/mcp auth`.
 *
 * Resource/prompt listing is fail-soft: a server that doesn't implement those
 * capabilities (JSON-RPC "Method not found") contributes an empty list instead
 * of degrading the whole probe to "failed".
 */
import type { McpServer } from "@cognia/agent-config-types"

import { openMcpClient, type OpenMcpOptions, type OpenedMcp } from "./mcp-client"
import type { McpToolInfo } from "./probe-mcp-tools"

export type McpServerStatus = "connected" | "needs_auth" | "failed" | "disabled"

export interface McpResourceInfo {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface McpPromptInfo {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface McpProbeResult {
  status: McpServerStatus
  tools: McpToolInfo[]
  resources: McpResourceInfo[]
  prompts: McpPromptInfo[]
  /** Failure detail for `failed` / `needs_auth`. */
  error?: string
}

export interface ProbeServerDeps {
  /** Override the live connection (tests / OAuth token injection). */
  open?: (server: McpServer, opts: OpenMcpOptions) => Promise<OpenedMcp>
  /** Build an OAuth provider (loads stored tokens) for a remote server. */
  authProvider?: (server: McpServer) => unknown
  /** Per-attempt probe timeout in ms (default 12s). */
  timeoutMs?: number
  /** Total connect attempts (default 2) — a cold stdio server (npx still
   * installing) or a waking remote endpoint routinely fails its FIRST connect;
   * one automatic retry turns those into a `connected` instead of a false
   * `failed` badge. Auth failures are never retried (a retry can't mint a
   * token) and neither are timeouts (the budget is already spent). */
  attempts?: number
  /** Backoff before each retry (default 300ms). */
  retryDelayMs?: number
  /** Classify a connection error as an authorization failure. */
  isAuthError?: (err: unknown) => boolean
  /** Skip resource listing (status-only callers like `/mcp list`). */
  skipResources?: boolean
  /** Skip prompt listing (status-only callers like `/mcp list`). */
  skipPrompts?: boolean
}

/** Default auth-error detector: SDK `UnauthorizedError` or a 401-ish message. */
export function isUnauthorized(err: unknown): boolean {
  if (!err) return false
  const name = (err as { name?: string }).name ?? ""
  const message = (err as { message?: string }).message ?? String(err)
  return (
    name === "UnauthorizedError" || /\b401\b|unauthorized|invalid_token|forbidden/i.test(message)
  )
}

/** A server may not implement resources/prompts; treat that as "none". */
async function listSoft<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn()
  } catch {
    return []
  }
}

/**
 * Connect to `server`, capture status + capabilities, tear the connection down.
 * Never rejects — failures surface as `{ status: "failed" | "needs_auth" }`.
 */
export async function probeMcpServer(
  server: McpServer,
  deps: ProbeServerDeps = {}
): Promise<McpProbeResult> {
  const empty = { tools: [], resources: [], prompts: [] }
  if (!server.enabled) return { status: "disabled", ...empty }

  const open = deps.open ?? openMcpClient
  const isAuthError = deps.isAuthError ?? isUnauthorized
  const timeoutMs = deps.timeoutMs ?? 12_000
  const maxAttempts = Math.max(1, deps.attempts ?? 2)
  const retryDelayMs = deps.retryDelayMs ?? 300
  const authProvider = deps.authProvider?.(server)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** One connect attempt with its own timeout + abort. */
  const connectOnce = async (): Promise<
    { ok: true; opened: OpenedMcp } | { ok: false; error: string; timedOut: boolean; auth: boolean }
  > => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error(`MCP probe timed out after ${timeoutMs}ms`))
        controller.abort()
      }, timeoutMs)
    })
    try {
      const opened = await Promise.race([
        open(server, { signal: controller.signal, authProvider }),
        timeout,
      ])
      return { ok: true, opened }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { ok: false, error: reason, timedOut, auth: !timedOut && isAuthError(err) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  let opened: OpenedMcp | undefined
  for (let attempt = 0; attempt < maxAttempts && !opened; attempt++) {
    if (attempt > 0 && retryDelayMs > 0) await sleep(retryDelayMs)
    const result = await connectOnce()
    if (result.ok) {
      opened = result.opened
      break
    }
    // Auth failures can't be fixed by retrying; a timeout already burned the
    // full per-attempt budget — report both immediately.
    if (result.auth) return { status: "needs_auth", ...empty, error: result.error }
    if (result.timedOut || attempt === maxAttempts - 1) {
      return { status: "failed", ...empty, error: result.error }
    }
  }
  if (!opened) return { status: "failed", ...empty, error: "unreachable" }

  try {
    const tools = await listSoft(async () =>
      ((await opened.client.listTools()).tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
    )
    const resources = deps.skipResources
      ? []
      : await listSoft(async () =>
          ((await opened.client.listResources()).resources ?? []).map((r) => ({
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
          }))
        )
    const prompts = deps.skipPrompts
      ? []
      : await listSoft(async () =>
          ((await opened.client.listPrompts()).prompts ?? []).map((p) => ({
            name: p.name,
            description: p.description,
            arguments: p.arguments,
          }))
        )
    return { status: "connected", tools, resources, prompts }
  } finally {
    await opened.close().catch(() => undefined)
  }
}
