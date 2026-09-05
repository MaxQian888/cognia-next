/**
 * `/agents run` dispatcher — the manual-command counterpart of the model-driven
 * `dispatch_agent` tool.
 *
 * The `/agents run <id> <prompt>` command runs a discovered subagent on demand.
 * Like the model-driven path it must run over the live sidecar with the CLI's
 * own config/provider (NOT the desktop's Dexie-backed `executeAgent`), so this
 * builds the {@link runCliSubagent} deps from the resolved config + file-based
 * state and adapts the result to the controller's `dispatchAgent` seam.
 *
 * Permission policy for an on-demand run (no live chat turn to borrow a gate
 * from): read-only tools auto-run (the subagent's send options suppress them),
 * and ask-tier tools are allowed only in `bypassPermissions` mode — otherwise
 * denied with an actionable message. Run with `--yes` / bypass for a subagent
 * that needs to write or run commands.
 */

import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"

import { type ResolvedConfig } from "../config/schema"
import { loadMcpServers } from "../mcp/load-mcp-config"
import { applyDisabled, readDisabled, readDisabledTools } from "../mcp/mcp-state"
import { createPermissionGate } from "./permission-gate"
import { readToolApprovals } from "./tool-approvals"
import { runCliSubagent } from "./subagent-runner"

/**
 * What the `/agents` controller's `dispatchAgent` seam expects back. The `usage`
 * here is the controller's `{ totalTokens }` shape (NOT the runner's richer
 * {@link import("@/lib/claude/adapter").UsageInfo}); `rejection` is never set —
 * single-level CLI dispatch has no nesting guard — and is present only so the
 * type structurally matches the seam.
 */
export interface AgentsRunResult {
  text: string
  usage?: { totalTokens: number }
  finishReason?: string
  rejection?: { reason: string; message: string }
}

export interface AgentsRunDispatchCtx {
  config: ResolvedConfig
  /** Config home (`~/.cognia`). */
  home: string
  /** The chat session id — child session ids are namespaced under it. */
  sessionId: string
  /** Abort signal for the command (interrupts the subagent run). */
  signal?: AbortSignal
}

/**
 * Build the `dispatchAgent` function the `/agents` controller calls. Resolves
 * MCP servers, approved tools, and the disabled-tool overlay from file state
 * exactly like a chat turn would, then runs the subagent over the live sidecar.
 */
export function buildAgentsRunDispatch(ctx: AgentsRunDispatchCtx) {
  return async (
    def: PluginSubagentDef,
    prompt: string,
    opts: { cwd?: string; abortSignal?: AbortSignal }
  ): Promise<AgentsRunResult> => {
    const { config, home } = ctx
    const gate = createPermissionGate({ yes: config.permissionMode === "bypassPermissions" })
    const mcpServers = applyDisabled(loadMcpServers([config.cwd, home]), readDisabled(home))
    const signal = opts.abortSignal ?? ctx.signal
    const r = await runCliSubagent(def, prompt, ctx.sessionId, {
      config,
      home,
      cwd: opts.cwd ?? config.cwd,
      gate,
      ...(signal ? { signal } : {}),
      mcpServers,
      approvedTools: readToolApprovals(home, undefined, opts.cwd ?? config.cwd),
      disabledMcpTools: readDisabledTools(home),
    })
    const totalTokens = (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0)
    return {
      text: r.text,
      ...(totalTokens > 0 ? { usage: { totalTokens } } : {}),
      ...(r.finishReason ? { finishReason: r.finishReason } : {}),
    }
  }
}
