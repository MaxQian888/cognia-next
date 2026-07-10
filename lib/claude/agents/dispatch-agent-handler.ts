/**
 * Renderer-side executor for the `dispatch_agent` host tool (A4).
 *
 * Called from `lib/claude/plugin-tool-ipc.ts:handlePluginToolExec` when a
 * `plugin_tool_exec` event names `dispatch_agent`. It runs in the RENDERER —
 * exactly where `dispatchSubagent` lives — so it sidesteps the missing
 * sidecar→renderer orchestration proxy (Thread D4) by riding the existing
 * plugin-tool wire.
 *
 * Responsibilities:
 *  - parse the call (single / parallel / background / collect / resume),
 *  - resolve the CALLER's nesting context (via `dispatch-run`),
 *  - drive the fan-out policy over `startDispatchRun` (which owns the per-run
 *    lifecycle: records, retries, journaling, cancellation).
 *
 * Returns the plain-text tool result the model reads (never throws).
 */

import { parseDispatchAgentArgs } from "./dispatch-agent-tool"
import { runDispatchFanout } from "./dispatch-core"
import { clearResolvedPermissionCeiling } from "./dispatch-context-registry"
import { releaseDispatchBudget, isDispatchBudgetFinite } from "./dispatch-budget"
import { collectRendererBackgroundResult } from "@/lib/background-tasks/renderer-subagent-registry"
import { renderDispatchOutcomeForModel } from "./dispatch-error"
import { resolveCaller, startDispatchRun, DEFAULT_NESTING_MAX_DEPTH } from "./dispatch-run"

export { DEFAULT_NESTING_MAX_DEPTH }

export interface DispatchAgentToolRequest {
  sessionId: string
  args: Record<string, unknown>
}

export async function runDispatchAgentTool(req: DispatchAgentToolRequest): Promise<string> {
  const parsed = parseDispatchAgentArgs(req.args)
  if (parsed.mode === "error") return parsed.message

  if (parsed.mode === "collect") {
    const r = await collectRendererBackgroundResult(parsed.runId)
    if (!r) return `No background run "${parsed.runId}" found (already collected or unknown).`
    return renderDispatchOutcomeForModel(parsed.runId, r)
  }

  const caller = await resolveCaller(req.sessionId)

  // Fan-out policy via the shared core (unified with the CLI handler so the two
  // can't drift). The guard is a post-hoc accumulator (`add` runs AFTER each
  // run), so under a FINITE budget concurrent siblings would all clear the
  // pre-spend exhaustion gate and overshoot in one batch. When the budget is
  // finite, serialize (`width: 1`) so each sibling sees the prior siblings'
  // draw-down and the per-child budget check trips mid-batch. An unlimited
  // budget has nothing to overshoot, so it stays fully parallel.
  const width = isDispatchBudgetFinite(caller.budgetRoot) ? 1 : Infinity
  const outcomes = await runDispatchFanout({
    dispatches: parsed.dispatches,
    width,
    // `startDispatchRun` collapses per-run errors into the result text itself,
    // so every outcome is surfaced as `ok` text.
    runOne: async (d, label) => {
      const { text } = await startDispatchRun({
        subagentId: d.subagentId,
        prompt: d.prompt,
        toolsEnabled: d.toolsEnabled,
        background: d.background,
        parentSessionId: req.sessionId,
        caller,
        label,
      })
      return { text, ok: true }
    },
  })
  return outcomes.map((o) => o.text).join("\n\n---\n\n")
}

/**
 * Release a top-level chat session's dispatch budget guard. The guard is
 * seeded lazily by `resolveCaller` on the first `dispatch_agent` of a session
 * and must survive across multiple dispatches within a turn (shared subtree
 * accounting), so it can only be dropped at session teardown — call this from
 * the chat session-close path. Without it, `getOrCreateDispatchBudget` leaks
 * one guard per distinct session id for the renderer's lifetime.
 */
export function releaseDispatchBudgetForSession(sessionId: string): void {
  releaseDispatchBudget(`dispatch:${sessionId}`)
}

/**
 * Drop ALL per-session dispatch state at chat session teardown: the subtree
 * budget guard AND the resolved permission ceiling. `resolveSendOptions`
 * deposits a ceiling under the chat session id on every send (not just dispatch
 * turns), so — like the budget guard — it leaks one entry per distinct session
 * id for the renderer's lifetime unless cleared here. Subagent/team sessions are
 * ephemeral and clear their own ceiling in their executor `finally`; only the
 * long-lived chat session needs this teardown hook.
 */
export function releaseDispatchStateForSession(sessionId: string): void {
  releaseDispatchBudgetForSession(sessionId)
  clearResolvedPermissionCeiling(sessionId)
}
