/**
 * Shared governed MCP tool invocation. Only stored, reviewed Registry rows are
 * executable; presets are installation templates and never a runtime fallback.
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
import type { McpServer } from "@cognia/agent-config-types"

import { type McpClientInfo, openMcpClient } from "./transport"
import {
  defaultMcpRuntimeGateway,
  McpRuntimeGateway,
  type RuntimeInvokeInput,
} from "./runtime-gateway"
import type { McpExecutionGrant, McpExecutionSurface } from "./policy"

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
  /** Stable chat-session/workflow-run scope. Omit for an ephemeral one-shot scope. */
  scopeId?: string
  surface?: McpExecutionSurface
  interactive?: boolean
  grant?: McpExecutionGrant
  /** Caller deadline, capped by the Gateway's 60-second default. */
  deadlineMs?: number
}

export interface InvokeMcpToolResult {
  serverId: string
  toolName: string
  isError: boolean
  content: unknown[]
  structuredContent?: unknown
}

export interface InvokeMcpToolDeps {
  getServer?: (id: string) => Promise<McpServer | undefined>
  open?: typeof openMcpClient
  gateway?: Pick<McpRuntimeGateway, "invoke" | "closeScope">
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
  const server = await getServer(serverId)
  if (!server) throw new McpServerNotFoundError(serverId)

  const args = (input.args && typeof input.args === "object" ? input.args : {}) as Record<
    string,
    unknown
  >

  const ephemeral = !input.scopeId
  const scopeId = input.scopeId ?? `ephemeral:${serverId}:${Date.now()}:${Math.random()}`
  const gateway =
    deps.gateway ??
    (deps.open || deps.connectAttempts !== undefined || deps.retryDelayMs !== undefined
      ? new McpRuntimeGateway({
          open: deps.open,
          connectAttempts: deps.connectAttempts,
          retryDelayMs: deps.retryDelayMs,
        })
      : defaultMcpRuntimeGateway)
  try {
    const gatewayInput: RuntimeInvokeInput = {
      scopeId,
      server,
      toolName,
      args,
      signal: input.signal,
      surface: input.surface ?? "cli",
      interactive: input.interactive,
      grant: input.grant,
      authProvider: input.authProvider,
      clientInfo: input.clientInfo,
      deadlineMs: input.deadlineMs,
    }
    const result = await gateway.invoke(gatewayInput)
    return {
      serverId,
      toolName,
      isError: result.isError ?? false,
      content: result.content ?? [],
      structuredContent: (result as { structuredContent?: unknown }).structuredContent,
    }
  } finally {
    if (ephemeral) await gateway.closeScope(scopeId)
  }
}
