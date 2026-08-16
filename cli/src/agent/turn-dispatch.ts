/**
 * Publish/retire the per-turn subagent dispatch context, for BOTH backends.
 *
 * A model-driven `dispatch_agent` call round-trips back into this process — via
 * the sidecar's `plugin_tool_exec` on the built-in path, via the Cognia tool-host
 * broker on an external one — and the handler resolves the caller's turn state
 * (gate, abort signal, MCP rows, approvals, discovered subagents) from a registry
 * keyed by chat session id. Both backends therefore need the identical
 * register/clear pair around a turn; keeping it in one place is what stops the
 * external path from advertising `dispatch_agent` with no context behind it.
 */

import { registerCliSubagentContext, clearCliSubagentContext } from "./subagent-dispatch"
import type { PermissionResponder } from "./permission-gate"
import type { ResolvedCliSessionContext } from "./session-context"
import type { ResolvedConfig } from "../config/schema"
import type { BuildOptionsContext } from "@/lib/claude/build-options"
import type { SendOptions } from "@cognia/agent-config-types"

export interface TurnDispatchParams {
  session: ResolvedCliSessionContext
  config: ResolvedConfig
  home: string
  gate: PermissionResponder
  resolveSubagentOptions?: (actorRef: string, ctx: BuildOptionsContext) => Promise<SendOptions>
  resolveSubagentGate?: (actorRef: string) => PermissionResponder
  signal?: AbortSignal
  approvedTools: Set<string>
  disabledMcpTools: Set<string>
}

/**
 * Register this turn's dispatch context when the session actually surfaced the
 * `dispatch_agent` tool. Returns a cleanup fn that is always safe to call — a
 * no-op when nothing was registered — so callers can `finally` it unconditionally.
 */
export function registerTurnSubagentContext(params: TurnDispatchParams): () => void {
  const { session } = params
  if (!session.subagentToolEnabled || session.agents.length === 0) return () => {}
  registerCliSubagentContext(session.sessionId, {
    agents: session.agents,
    config: params.config,
    home: params.home,
    cwd: session.cwd,
    gate: params.gate,
    ...(params.resolveSubagentOptions
      ? { resolveSubagentOptions: params.resolveSubagentOptions }
      : {}),
    ...(params.resolveSubagentGate ? { resolveSubagentGate: params.resolveSubagentGate } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    mcpServers: session.mcpServers,
    approvedTools: params.approvedTools,
    disabledMcpTools: params.disabledMcpTools,
  })
  return () => clearCliSubagentContext(session.sessionId)
}
