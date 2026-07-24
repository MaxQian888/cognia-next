/**
 * Execute a `cognia-plugin-tools` call for an external agent.
 *
 * These tools are NOT executed inside the bridge. Their handlers live in this
 * process — the in-tree plugin runtime, the TUI's `ask_user` elicitation
 * overlay, the CLI-local skill store behind `load_skill`, and the subagent
 * dispatcher behind `dispatch_agent`. Shipping them across the bridge would mean
 * reimplementing all four in a child of a foreign agent.
 *
 * So the broker calls this, which reuses the SAME
 * `makeCliPluginToolHandle()` seam the built-in backend's `plugin_tool_exec`
 * subscription uses. One executor, one behaviour, on both backends.
 */

import type { PluginToolExecRequest, PluginToolExecResponse } from "@/lib/claude/plugin-tool-ipc"

import { makeCliPluginToolHandle } from "../subagent-dispatch"
import type { ExecResult } from "./protocol"

export interface HostToolExecutorParams {
  sessionId: string
  /** Injected in tests; defaults to the shared CLI plugin-tool handle. */
  handle?: (req: PluginToolExecRequest) => Promise<PluginToolExecResponse>
  mintToolUseId?: () => string
}

/**
 * Build the broker's `execHostTool`.
 *
 * Never throws: a fault collapses onto `{ error }` so the agent's tool call
 * always settles rather than hanging on a promise the bridge is still awaiting.
 */
export function createHostToolExecutor(
  params: HostToolExecutorParams
): (name: string, args: unknown) => Promise<ExecResult> {
  const handle = params.handle ?? makeCliPluginToolHandle()
  let seq = 0
  const mintToolUseId = params.mintToolUseId ?? (() => `toolhost-${++seq}`)
  return async (name, args) => {
    const request: PluginToolExecRequest = {
      type: "plugin_tool_exec",
      sessionId: params.sessionId,
      toolUseId: mintToolUseId(),
      name,
      args: (args ?? {}) as Record<string, unknown>,
    }
    try {
      const response = await handle(request)
      if (response.error) return { error: response.error }
      return { result: response.result ?? null }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }
}
