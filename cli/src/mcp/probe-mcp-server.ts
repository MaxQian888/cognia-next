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
import type { McpServer } from "@/lib/claude/types"

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
  /** Probe timeout in ms (default 12s). */
  timeoutMs?: number
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
  const authProvider = deps.authProvider?.(server)

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

  let opened: OpenedMcp
  try {
    opened = await Promise.race([
      open(server, { signal: controller.signal, authProvider }),
      timeout,
    ])
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (!timedOut && isAuthError(err)) {
      return { status: "needs_auth", ...empty, error: reason }
    }
    return { status: "failed", ...empty, error: reason }
  } finally {
    if (timer) clearTimeout(timer)
  }

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
