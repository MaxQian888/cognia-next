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
import { getDispatchContext } from "./dispatch-context-registry"
import { getOrCreateDispatchBudget } from "./dispatch-budget"
import { startBackgroundRun, collectBackgroundResult } from "./background-registry"
import {
  recordDispatchStart,
  recordDispatchComplete,
  recordDispatchFailed,
  recordDispatchRejected,
} from "./dispatch-runtime"
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
  const ctx = getDispatchContext(sessionId)
  if (ctx) {
    return {
      parentDepth: ctx.depth,
      maxDepth: ctx.maxDepth,
      parentChain: ctx.parentChain,
      parentSubagentId: ctx.selfRunId,
      deadlineMs: ctx.deadlineMs,
      budgetRoot: ctx.budgetRootRunId ?? `dispatch:${sessionId}`,
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
  }
}

export async function runDispatchAgentTool(req: DispatchAgentToolRequest): Promise<string> {
  const parsed = parseDispatchAgentArgs(req.args)
  if (parsed.mode === "error") return parsed.message

  if (parsed.mode === "collect") {
    const r = await collectBackgroundResult(parsed.runId)
    if (!r) return `No background run "${parsed.runId}" found (already collected or unknown).`
    return formatResult(parsed.runId, r)
  }

  const caller = await resolveCaller(req.sessionId)

  const runOne = async (d: NormalizedDispatch, label: string): Promise<string> => {
    const childRunId = newRunId()
    const childDepth = caller.parentDepth + 1
    recordDispatchStart({
      id: childRunId,
      name: d.subagentId,
      task: d.prompt,
      depth: childDepth,
      ...(caller.parentSubagentId ? { parentSubagentId: caller.parentSubagentId } : {}),
      backgrounded: d.background,
    })

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
      ...(caller.deadlineMs ? { _deadlineMs: caller.deadlineMs } : {}),
    })
      .then((r) => {
        if (r.rejection) {
          recordDispatchRejected({
            id: childRunId,
            name: d.subagentId,
            task: d.prompt,
            depth: childDepth,
            ...(caller.parentSubagentId ? { parentSubagentId: caller.parentSubagentId } : {}),
            rejection: r.rejection,
          })
        } else {
          recordDispatchComplete(childRunId, {
            text: r.text,
            ...(r.usage ? { usage: r.usage } : {}),
          })
        }
        return r
      })
      .catch((err): PluginSubagentDispatchResult => {
        const msg = err instanceof Error ? err.message : String(err)
        recordDispatchFailed(childRunId, msg)
        return {
          text: msg,
          channel: "text",
          toolsAvailable: false,
          runId: childRunId,
          finishReason: "error",
        }
      })

    if (d.background) {
      startBackgroundRun(childRunId, promise)
      return `[${d.subagentId}] started in background (runId: ${childRunId}). Collect later with dispatch_agent({collect:"${childRunId}"}).`
    }
    const r = await promise
    return formatResult(label, r)
  }

  if (parsed.dispatches.length === 1) {
    const d = parsed.dispatches[0]
    return runOne(d, d.subagentId)
  }
  // Parallel fan-out: all siblings run concurrently, share the subtree budget.
  const settled = await Promise.all(
    parsed.dispatches.map((d, i) => runOne(d, `${d.subagentId}#${i + 1}`))
  )
  return settled.join("\n\n---\n\n")
}
