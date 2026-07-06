/**
 * Shared one-shot MCP tool invocation. Resolves an MCP server (stored row, or
 * a plugin-contributed preset as a fallback), opens a correctly-built transport
 * (stdio / sse / http + static headers + optional OAuth `authProvider`), calls
 * one tool, and tears the connection down.
 *
 * Reused by the desktop workflow runtime (`action.mcp.invokeTool`) and the plan
 * step dispatcher (`mcp_tool_call`) so the transport split and auth wiring stay
 * consistent — the previous hand-rolled node path only ever built a
 * Streamable-HTTP transport (mis-connecting `sse` servers) and dropped
 * `config.headers` (breaking authenticated HTTP servers).
 *
 * Plugin event hooks are intentionally NOT fired here — each caller owns its
 * hook semantics. The helper is a pure tool-invoke seam with injectable deps.
 */
import type { McpServer } from "@/lib/claude/types"

import { type McpClientInfo, openMcpClient } from "./transport"

/** Thrown when neither a stored row nor a preset matches `serverId`. Callers map this to a non-retryable failure. */
export class McpServerNotFoundError extends Error {
  constructor(serverId: string) {
    super(`MCP server ${serverId} not found`)
    this.name = "McpServerNotFoundError"
  }
}

export interface InvokeMcpToolInput {
  serverId: string
  toolName: string
  args?: Record<string, unknown>
  signal?: AbortSignal
  /** OAuth client provider (cluster #1) — forwarded to the transport, not constructed here. */
  authProvider?: unknown
  /** Identity reported to the server during `initialize`. */
  clientInfo?: McpClientInfo
}

export interface InvokeMcpToolResult {
  serverId: string
  toolName: string
  isError: boolean
  content: unknown[]
  structuredContent?: unknown
}

/** A preset projected to the minimal server-like shape the transport needs. */
export interface McpPresetLike {
  name: string
  transport: McpServer["transport"]
  config: Record<string, unknown>
}

export interface InvokeMcpToolDeps {
  getServer?: (id: string) => Promise<McpServer | undefined>
  getPreset?: (id: string) => McpPresetLike | undefined | Promise<McpPresetLike | undefined>
  open?: typeof openMcpClient
  /** Total connect attempts (default 2) — a cold server routinely fails its
   * FIRST connect; one automatic retry rescues it. Tool-call errors are never
   * retried (the tool may not be idempotent). */
  connectAttempts?: number
  /** Backoff before each connect retry (default 300ms). */
  retryDelayMs?: number
}

/**
 * Invoke a single MCP tool. Throws {@link McpServerNotFoundError} when the
 * server can't be resolved; propagates connection / tool errors verbatim so
 * callers can decide retryability.
 */
export async function invokeMcpTool(
  input: InvokeMcpToolInput,
  deps: InvokeMcpToolDeps = {}
): Promise<InvokeMcpToolResult> {
  const serverId = input.serverId?.trim()
  const toolName = input.toolName?.trim()
  if (!serverId) throw new Error("invokeMcpTool requires a serverId")
  if (!toolName) throw new Error("invokeMcpTool requires a toolName")

  const getServer =
    deps.getServer ?? (async (id) => (await import("@/lib/db/mcp-servers")).getMcpServer(id))
  const getPreset =
    deps.getPreset ??
    (async (id) => {
      const { getMcpServerPreset } =
        await import("@/lib/plugin/registries/mcp-server-preset-registry")
      const p = getMcpServerPreset(id)
      return p ? { name: p.name, transport: p.transport, config: p.config } : undefined
    })
  const open = deps.open ?? openMcpClient

  const stored = await getServer(serverId)
  // Fall back to a plugin-contributed preset (overlay registry) when the Dexie
  // table has no row — presets share the { name, transport, config } shape.
  const preset = stored ? undefined : await getPreset(serverId)
  const server: McpServer | undefined = stored
    ? stored
    : preset
      ? ({
          id: serverId,
          name: preset.name,
          transport: preset.transport,
          config: preset.config,
          enabled: true,
        } as McpServer)
      : undefined
  if (!server) throw new McpServerNotFoundError(serverId)

  const args = (input.args && typeof input.args === "object" ? input.args : {}) as Record<
    string,
    unknown
  >

  // Connect with one automatic retry: first connections to cold servers
  // (spawning stdio child, waking remote endpoint) routinely fail once. An
  // aborted connect is NOT retried — the caller cancelled.
  const attempts = Math.max(1, deps.connectAttempts ?? 2)
  const retryDelayMs = deps.retryDelayMs ?? 300
  let opened: Awaited<ReturnType<typeof openMcpClient>> | undefined
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0 && retryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs))
    }
    try {
      opened = await open(server, {
        signal: input.signal,
        authProvider: input.authProvider,
        clientInfo: input.clientInfo,
      })
      break
    } catch (err) {
      if (input.signal?.aborted || attempt === attempts - 1) throw err
    }
  }
  if (!opened) throw new Error(`MCP server ${serverId}: connect failed`)
  try {
    const result = await opened.client.callTool({ name: toolName, arguments: args })
    return {
      serverId,
      toolName,
      isError: result.isError ?? false,
      content: result.content ?? [],
      structuredContent: (result as { structuredContent?: unknown }).structuredContent,
    }
  } finally {
    await opened.close()
  }
}
