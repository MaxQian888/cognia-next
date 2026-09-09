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

import {
  collectWithTimeout,
  parseDispatchAgentArgs,
  renderCollectPending,
} from "./dispatch-agent-tool"
import { runDispatchFanout } from "./dispatch-core"
import { clearResolvedPermissionCeiling } from "./dispatch-context-registry"
import { releaseDispatchBudget, isDispatchBudgetFinite } from "./dispatch-budget"
import { collectRendererBackgroundResult } from "@/lib/background-tasks/renderer-subagent-registry"
import { cancelSubagentRun } from "./cancel-subagent"
import { renderDispatchOutcomeForModel } from "./dispatch-error"
import { resolveCaller, startDispatchRun, DEFAULT_NESTING_MAX_DEPTH } from "./dispatch-run"

export { DEFAULT_NESTING_MAX_DEPTH }

export interface DispatchAgentToolRequest {
  sessionId: string
  args: Record<string, unknown>
}

/**
 * Resolve the fan-out width for one call. A finite token budget forces
 * serial fan-out (see below). Otherwise the user's concurrency cap applies,
 * and `0` (unset) keeps the historical fully-parallel behaviour.
 */
export function resolveDispatchWidth(caller: {
  budgetRoot: string
  maxConcurrent: number
}): number {
  if (isDispatchBudgetFinite(caller.budgetRoot)) return 1
  return caller.maxConcurrent > 0 ? caller.maxConcurrent : Infinity
}

/**
 * Await one or more background runs, optionally bounded by a wait window.
 * Runs are awaited concurrently and reported in the order the model listed
 * them. A run that is still in flight when the window closes is reported as
 * pending rather than blocking the rest.
 */
async function collectDispatchRuns(runIds: string[], timeoutMs: number | undefined) {
  const startedAt = Date.now()
  const parts = await Promise.all(
    runIds.map(async (runId) => {
      const outcome = await collectWithTimeout(
        () => collectRendererBackgroundResult(runId),
        timeoutMs
      )
      if (!outcome.settled) return renderCollectPending(runId, Date.now() - startedAt)
      if (!outcome.value) return `No background run "${runId}" found.`
      return renderDispatchOutcomeForModel(runId, outcome.value)
    })
  )
  return parts.join("\n\n---\n\n")
}

/** Stop running background runs. A run that is not live reads as such. */
function cancelDispatchRuns(runIds: string[]): string {
  return runIds
    .map((runId) => {
      const cancelled = cancelSubagentRun(runId, {
        backgrounded: true,
        reason: "Cancelled by the dispatching agent.",
      })
      return cancelled
        ? `Cancelled run "${runId}". Any partial output it produced can still be collected.`
        : `No running background run "${runId}" (already finished, or unknown).`
    })
    .join("\n")
}

export async function runDispatchAgentTool(req: DispatchAgentToolRequest): Promise<string> {
  const parsed = parseDispatchAgentArgs(req.args)
  if (parsed.mode === "error") return parsed.message

  if (parsed.mode === "cancel") return cancelDispatchRuns(parsed.runIds)

  if (parsed.mode === "collect") return collectDispatchRuns(parsed.runIds, parsed.timeoutMs)

  if (parsed.mode === "resume") {
    return resumeDispatchRun(req.sessionId, parsed)
  }

  const caller = await resolveCaller(req.sessionId)

  // Fan-out policy via the shared core (unified with the CLI handler so the two
  // can't drift). The guard is a post-hoc accumulator (`add` runs AFTER each
  // run), so under a FINITE budget concurrent siblings would all clear the
  // pre-spend exhaustion gate and overshoot in one batch. When the budget is
  // finite, serialize (`width: 1`) so each sibling sees the prior siblings'
  // draw-down and the per-child budget check trips mid-batch. An unlimited
  // budget has nothing to overshoot, so it runs as wide as the user's cap.
  const width = resolveDispatchWidth(caller)
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
        ...(d.model ? { model: d.model } : {}),
      })
      return { text, ok: true }
    },
  })
  return outcomes.map((o) => o.text).join("\n\n---\n\n")
}

/**
 * Continue a FINISHED run with a follow-up prompt. The prior prompt + outcome
 * (all the ephemeral session leaves behind) are re-framed as context and the
 * same subagent is re-dispatched. Never throws — guards collapse into a
 * readable tool result.
 */
async function resumeDispatchRun(
  sessionId: string,
  parsed: {
    runId: string
    prompt: string
    toolsEnabled?: boolean
    background: boolean
    model?: string
  }
): Promise<string> {
  const [{ getBackgroundTaskRecord }, { frameResumePrompt }, { getDispatchableSubagentDef }] =
    await Promise.all([
      import("@/lib/db/background-tasks"),
      import("@/lib/background-tasks/completion-delivery"),
      import("@/lib/claude/agents/subagents"),
    ])

  let record: Awaited<ReturnType<typeof getBackgroundTaskRecord>>
  try {
    record = await getBackgroundTaskRecord(parsed.runId)
  } catch {
    record = undefined
  }
  if (!record || record.host !== "renderer" || record.kind !== "subagent") {
    return `No background run "${parsed.runId}" found.`
  }
  if (record.status === "running") {
    return `Run "${parsed.runId}" is still running — collect it with dispatch_agent({collect:"${parsed.runId}"}) or wait for it to finish.`
  }
  if (!getDispatchableSubagentDef(record.subagentId)) {
    return `Cannot resume run "${parsed.runId}" — subagent "${record.subagentId}" is no longer available.`
  }

  const caller = await resolveCaller(sessionId)
  const framedPrompt = frameResumePrompt(
    {
      prompt: record.prompt,
      outcome: record.resultText ?? record.error ?? "(no output recorded)",
    },
    parsed.prompt
  )
  const { runId, text } = await startDispatchRun({
    subagentId: record.subagentId,
    prompt: framedPrompt,
    toolsEnabled: parsed.toolsEnabled ?? record.toolsEnabled ?? true,
    background: parsed.background,
    parentSessionId: sessionId,
    caller,
    label: `${record.subagentId} (resumed)`,
    resumeOfRunId: record.runId,
    ...(parsed.model ? { model: parsed.model } : {}),
  })
  // Provenance: link the original row to its continuation (best-effort).
  try {
    const { updateBackgroundTaskRecord } = await import("@/lib/db/background-tasks")
    await updateBackgroundTaskRecord(record.runId, { resumedByRunId: runId })
  } catch {
    // Journal bookkeeping only.
  }
  return text
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
