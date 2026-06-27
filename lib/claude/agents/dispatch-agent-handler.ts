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
 *  - resolve the CALLER's nesting context (registered by session id, or
 *    derived from app settings for the top-level chat),
 *  - thread depth / parent chain / budget / deadline into `dispatchSubagent`,
 *  - drive single, parallel-fan-out, background, and collect call modes,
 *  - record every run into the subagent runtime store for the chat tree.
 *
 * Returns the plain-text tool result the model reads (never throws).
 */

import { parseDispatchAgentArgs, type NormalizedDispatch } from "./dispatch-agent-tool"
import {
  getDispatchContext,
  getResolvedPermissionCeiling,
  clearResolvedPermissionCeiling,
} from "./dispatch-context-registry"
import type { ExternalSessionPermissionSpec } from "@/lib/ai/agent/external/permission-cascade"
import {
  getOrCreateDispatchBudget,
  releaseDispatchBudget,
  isDispatchBudgetFinite,
} from "./dispatch-budget"
import {
  startRendererBackgroundRun,
  collectRendererBackgroundResult,
} from "@/lib/background-tasks/renderer-subagent-registry"
import {
  recordDispatchStart,
  recordDispatchComplete,
  recordDispatchFailed,
  recordDispatchCancelled,
  recordDispatchRejected,
  createDispatchEventSink,
} from "./dispatch-runtime"
import { registerSubagentRun, unregisterSubagentRun } from "./subagent-cancel-registry"
import type { PluginSubagentDispatchResult } from "@/types/plugin/plugin-agent-sdk"

/** Fallback cap when nesting settings can't be read. */
export const DEFAULT_NESTING_MAX_DEPTH = 2

export interface DispatchAgentToolRequest {
  sessionId: string
  args: Record<string, unknown>
}

function newRunId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  }
}

function formatResult(label: string, r: PluginSubagentDispatchResult): string {
  if (r.rejection) return `[${label}] ${r.text}`
  return `[${label}]\n${r.text}`
}

interface ResolvedCaller {
  parentDepth: number
  maxDepth: number
  parentChain: string[]
  parentSubagentId?: string
  deadlineMs?: number
  budgetRoot: string
  /** The caller's resolved permission ceiling, clamping every child it dispatches. */
  parentCeiling?: ExternalSessionPermissionSpec
}

async function loadNesting(): Promise<{
  maxDepth: number
  tokenBudget: number
  timeoutMs: number
}> {
  try {
    const { getSettings } = await import("@/lib/db/settings")
    const s = await getSettings()
    const n = s?.subagentNesting
    return {
      maxDepth: n?.maxDepth ?? DEFAULT_NESTING_MAX_DEPTH,
      tokenBudget: n?.tokenBudget ?? 0,
      timeoutMs: n?.timeoutMs ?? 0,
    }
  } catch {
    return { maxDepth: DEFAULT_NESTING_MAX_DEPTH, tokenBudget: 0, timeoutMs: 0 }
  }
}

async function resolveCaller(sessionId: string): Promise<ResolvedCaller> {
  // The caller's resolved ceiling is deposited by `resolveSendOptions` under the
  // caller's own session id — whether the caller is the top-level chat or a
  // running subagent. Read it once and clamp every child it dispatches.
  const parentCeiling = getResolvedPermissionCeiling(sessionId)
  const ctx = getDispatchContext(sessionId)
  if (ctx) {
    return {
      parentDepth: ctx.depth,
      maxDepth: ctx.maxDepth,
      parentChain: ctx.parentChain,
      parentSubagentId: ctx.selfRunId,
      deadlineMs: ctx.deadlineMs,
      budgetRoot: ctx.budgetRootRunId ?? `dispatch:${sessionId}`,
      ...(parentCeiling ? { parentCeiling } : {}),
    }
  }
  // Top-level chat: derive from settings and seed the subtree budget once.
  const settings = await loadNesting()
  const budgetRoot = `dispatch:${sessionId}`
  getOrCreateDispatchBudget(budgetRoot, settings.tokenBudget)
  return {
    parentDepth: 0,
    maxDepth: settings.maxDepth,
    parentChain: [],
    budgetRoot,
    ...(settings.timeoutMs > 0 ? { deadlineMs: Date.now() + settings.timeoutMs } : {}),
    ...(parentCeiling ? { parentCeiling } : {}),
  }
}

export async function runDispatchAgentTool(req: DispatchAgentToolRequest): Promise<string> {
  const parsed = parseDispatchAgentArgs(req.args)
  if (parsed.mode === "error") return parsed.message

  if (parsed.mode === "collect") {
    const r = await collectRendererBackgroundResult(parsed.runId)
    if (!r) return `No background run "${parsed.runId}" found (already collected or unknown).`
    return formatResult(parsed.runId, r)
  }

  const caller = await resolveCaller(req.sessionId)

  const runOne = async (d: NormalizedDispatch, label: string): Promise<string> => {
    const childRunId = newRunId()
    // Every run (foreground OR background) gets a controller so the chat card's
    // Abort button can stop it via the cancel registry.
    const abort = new AbortController()
    const childDepth = caller.parentDepth + 1
    recordDispatchStart({
      id: childRunId,
      name: d.subagentId,
      task: d.prompt,
      depth: childDepth,
      ...(caller.parentSubagentId ? { parentSubagentId: caller.parentSubagentId } : {}),
      parentSessionId: req.sessionId,
      backgrounded: d.background,
    })
    registerSubagentRun(childRunId, abort)

    const [{ dispatchSubagent }, { getDispatchableSubagentDef }] = await Promise.all([
      import("@/lib/plugin/agent-sdk/dispatch"),
      import("@/lib/claude/agents/subagents"),
    ])
    // Prefer the inline def (projected ids like `template:x` / `pluginId:y` are
    // not resolvable by the registry's `getSubagent`); fall back to the raw id.
    const target = getDispatchableSubagentDef(d.subagentId) ?? d.subagentId
    const promise = dispatchSubagent(target, d.prompt, {
      toolsEnabled: d.toolsEnabled,
      _runId: childRunId,
      _depth: caller.parentDepth,
      _maxDepth: caller.maxDepth,
      _parentChain: caller.parentChain,
      _budgetRootRunId: caller.budgetRoot,
      _onEvent: createDispatchEventSink(childRunId),
      abortSignal: abort.signal,
      ...(caller.deadlineMs ? { _deadlineMs: caller.deadlineMs } : {}),
      ...(caller.parentCeiling ? { _permissionCeiling: caller.parentCeiling } : {}),
    })
      .then((r) => {
        if (r.rejection) {
          recordDispatchRejected({
            id: childRunId,
            name: d.subagentId,
            task: d.prompt,
            depth: childDepth,
            ...(caller.parentSubagentId ? { parentSubagentId: caller.parentSubagentId } : {}),
            parentSessionId: req.sessionId,
            rejection: r.rejection,
          })
        } else {
          recordDispatchComplete(childRunId, {
            text: r.text,
            ...(r.usage ? { usage: r.usage } : {}),
          })
        }
        unregisterSubagentRun(childRunId)
        return r
      })
      .catch((err): PluginSubagentDispatchResult => {
        const msg = err instanceof Error ? err.message : String(err)
        // An aborted run is a user cancellation, not a failure.
        if (abort.signal.aborted) {
          recordDispatchCancelled(childRunId)
        } else {
          recordDispatchFailed(childRunId, msg)
        }
        unregisterSubagentRun(childRunId)
        return {
          text: msg,
          channel: "text",
          toolsAvailable: false,
          runId: childRunId,
          finishReason: abort.signal.aborted ? "cancelled" : "error",
        }
      })

    if (d.background) {
      startRendererBackgroundRun(
        childRunId,
        {
          kind: "subagent",
          subagentId: d.subagentId,
          prompt: d.prompt,
          sessionId: req.sessionId,
          host: "renderer",
          startedAt: Date.now(),
        },
        promise,
        { cancel: () => abort.abort() }
      )
      return `[${d.subagentId}] started in background (runId: ${childRunId}). Collect later with dispatch_agent({collect:"${childRunId}"}).`
    }
    const r = await promise
    return formatResult(label, r)
  }

  if (parsed.dispatches.length === 1) {
    const d = parsed.dispatches[0]
    return runOne(d, d.subagentId)
  }
  // Parallel fan-out shares the subtree budget. The guard is a post-hoc
  // accumulator (`add` runs AFTER each run), so under a FINITE budget concurrent
  // siblings would all clear the pre-spend exhaustion gate and overshoot in one
  // batch. When the budget is finite, serialize the fan-out so each sibling sees
  // the prior siblings' draw-down and `isDispatchBudgetExhausted` trips mid-batch.
  // An unlimited budget has nothing to overshoot, so it stays fully parallel.
  if (isDispatchBudgetFinite(caller.budgetRoot)) {
    const out: string[] = []
    for (let i = 0; i < parsed.dispatches.length; i++) {
      const d = parsed.dispatches[i]
      out.push(await runOne(d, `${d.subagentId}#${i + 1}`))
    }
    return out.join("\n\n---\n\n")
  }
  const settled = await Promise.all(
    parsed.dispatches.map((d, i) => runOne(d, `${d.subagentId}#${i + 1}`))
  )
  return settled.join("\n\n---\n\n")
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
