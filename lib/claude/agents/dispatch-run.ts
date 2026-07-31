/**
 * Single-dispatch lifecycle for the `dispatch_agent` host tool (renderer).
 *
 * `startDispatchRun` owns everything one dispatched run needs:
 *  - caller-context resolution (depth / budget / deadline / permission ceiling),
 *  - the runtime-store records (start / retry / terminal — exactly once, via
 *    `finalize`),
 *  - the per-run tracker (partial-text salvage + live usage),
 *  - bounded retries for transient failures (abort/deadline/budget-aware),
 *  - journaling: background runs enter the collectable registry; foreground
 *    runs are journal-only so a renderer reload reconciles them on boot.
 *
 * Extracted from `dispatch-agent-handler.ts` so out-of-turn callers (Job
 * Center re-run, boot auto-resume) can dispatch without a live tool call.
 */

import type { ExternalSessionPermissionSpec } from "@/lib/ai/agent/external/permission-cascade"
import type {
  PluginDispatchErrorEnvelope,
  PluginSubagentDispatchResult,
} from "@/types/plugin/plugin-agent-sdk"
import { getDispatchContext, getResolvedPermissionCeiling } from "./dispatch-context-registry"
import { getOrCreateDispatchBudget, isDispatchBudgetExhausted } from "./dispatch-budget"
import {
  journalRendererForegroundRun,
  startRendererBackgroundRun,
} from "@/lib/background-tasks/renderer-subagent-registry"
import {
  createDispatchRunTracker,
  recordDispatchStart,
  recordDispatchComplete,
  recordDispatchFailed,
  recordDispatchCancelled,
  recordDispatchRejected,
  recordDispatchRetry,
} from "./dispatch-runtime"
import { registerSubagentRun, unregisterSubagentRun } from "./subagent-cancel-registry"
import { toDispatchErrorEnvelope, renderDispatchOutcomeForModel } from "./dispatch-error"
import {
  DEFAULT_DISPATCH_RETRY,
  retryDelayMs,
  shouldRetryDispatch,
  waitForRetry,
  type DispatchRetryPolicy,
} from "./dispatch-retry"

/** Fallback cap when nesting settings can't be read. */
export const DEFAULT_NESTING_MAX_DEPTH = 2

export interface ResolvedCaller {
  parentDepth: number
  maxDepth: number
  parentChain: string[]
  parentSubagentId?: string
  deadlineMs?: number
  budgetRoot: string
  /** The caller's resolved permission ceiling, clamping every child it dispatches. */
  parentCeiling?: ExternalSessionPermissionSpec
}

export interface NestingSettings {
  maxDepth: number
  tokenBudget: number
  timeoutMs: number
  dispatchMaxRetries: number
}

export async function loadNesting(): Promise<NestingSettings> {
  try {
    const { getSettings } = await import("@/lib/db/settings")
    const s = await getSettings()
    const n = s?.subagentNesting
    return {
      maxDepth: n?.maxDepth ?? DEFAULT_NESTING_MAX_DEPTH,
      tokenBudget: n?.tokenBudget ?? 0,
      timeoutMs: n?.timeoutMs ?? 0,
      dispatchMaxRetries: n?.dispatchMaxRetries ?? DEFAULT_DISPATCH_RETRY.maxRetries,
    }
  } catch {
    return {
      maxDepth: DEFAULT_NESTING_MAX_DEPTH,
      tokenBudget: 0,
      timeoutMs: 0,
      dispatchMaxRetries: DEFAULT_DISPATCH_RETRY.maxRetries,
    }
  }
}

/**
 * Belt-and-braces ceiling when `resolveSendOptions` never deposited one for
 * this session (e.g. an early-returned send, or a caller that didn't pass
 * `session.id`). The session row's own `permissionMode` is the FIRST link of
 * the resolution chain, so a plan-mode parent still clamps its children even
 * without a recorded ceiling. Only consulted when no recorded ceiling exists —
 * a recorded ceiling is post-clamp and authoritative, never overridden.
 * `auto` has no ACP equivalent (same convention as the ceiling recorder).
 */
async function fallbackCeilingFromSession(
  sessionId: string
): Promise<ExternalSessionPermissionSpec | undefined> {
  try {
    const { getSession } = await import("@/lib/db/sessions")
    const mode = (await getSession(sessionId))?.permissionMode
    if (mode && mode !== "auto") return { permissionMode: mode }
  } catch {
    // best-effort fallback — absence of a ceiling is the pre-existing behavior
  }
  return undefined
}

/**
 * Resolve the CALLER's nesting context: a running subagent resolves from the
 * per-session dispatch-context registry; anything else (top-level chat, Job
 * Center re-run, boot auto-resume) derives from app settings and seeds the
 * subtree budget once.
 */
export async function resolveCaller(sessionId: string): Promise<ResolvedCaller> {
  // The caller's resolved ceiling is deposited by `resolveSendOptions` under the
  // caller's own session id — whether the caller is the top-level chat or a
  // running subagent. Read it once and clamp every child it dispatches.
  const parentCeiling =
    getResolvedPermissionCeiling(sessionId) ?? (await fallbackCeilingFromSession(sessionId))
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

function newRunId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  }
}

export interface StartDispatchRunParams {
  subagentId: string
  prompt: string
  toolsEnabled: boolean
  background: boolean
  /** The chat session that issued the dispatch (runtime-store bucketing + journal). */
  parentSessionId: string
  /** Caller nesting context from {@link resolveCaller}. */
  caller: ResolvedCaller
  /** Model-facing label for the result header (defaults to the subagent id). */
  label?: string
  /** Explicit run id (defaults to a generated one). */
  runId?: string
  /** Provenance: this dispatch resumes/re-runs that journal row. */
  resumeOfRunId?: string
  /** Chained auto-resume attempt counter (crash-loop cap). */
  resumeAttempt?: number
}

export interface DispatchRunHandle {
  runId: string
  /** Model-facing outcome text (or the started-in-background notice). */
  text: string
}

/**
 * Start one dispatched run. Never throws — every failure collapses into the
 * model-facing text (and the structured envelope on the underlying result).
 */
export async function startDispatchRun(p: StartDispatchRunParams): Promise<DispatchRunHandle> {
  const childRunId = p.runId ?? newRunId()
  const label = p.label ?? p.subagentId
  // Every run (foreground OR background) gets a controller so the chat card's
  // Abort button can stop it via the cancel registry.
  const abort = new AbortController()
  const childDepth = p.caller.parentDepth + 1
  recordDispatchStart({
    id: childRunId,
    name: p.subagentId,
    task: p.prompt,
    depth: childDepth,
    ...(p.caller.parentSubagentId ? { parentSubagentId: p.caller.parentSubagentId } : {}),
    parentSessionId: p.parentSessionId,
    backgrounded: p.background,
  })
  registerSubagentRun(childRunId, abort)

  const [{ dispatchSubagent }, { getDispatchableSubagentDef }, nesting] = await Promise.all([
    import("@/lib/plugin/agent-sdk/dispatch"),
    import("@/lib/claude/agents/subagents"),
    loadNesting(),
  ])
  // Prefer the inline def (projected ids like `template:x` / `pluginId:y` are
  // not resolvable by the registry's `getSubagent`); fall back to the raw id.
  const target = getDispatchableSubagentDef(p.subagentId) ?? p.subagentId
  const tracker = createDispatchRunTracker(childRunId)
  const policy: DispatchRetryPolicy = {
    ...DEFAULT_DISPATCH_RETRY,
    maxRetries: nesting.dispatchMaxRetries,
  }

  const attemptDispatch = (): Promise<PluginSubagentDispatchResult> =>
    dispatchSubagent(target, p.prompt, {
      toolsEnabled: p.toolsEnabled,
      _runId: childRunId,
      _depth: p.caller.parentDepth,
      _maxDepth: p.caller.maxDepth,
      _parentChain: p.caller.parentChain,
      _budgetRootRunId: p.caller.budgetRoot,
      _onEvent: tracker.sink,
      abortSignal: abort.signal,
      _approvalRoute: {
        parentSessionId: p.parentSessionId,
        runId: childRunId,
        subagentId: p.subagentId,
        backgrounded: p.background,
      },
      ...(p.caller.deadlineMs ? { _deadlineMs: p.caller.deadlineMs } : {}),
      ...(p.caller.parentCeiling ? { _permissionCeiling: p.caller.parentCeiling } : {}),
    }).catch((err): PluginSubagentDispatchResult => {
      const envelope = toDispatchErrorEnvelope(err, {
        aborted: abort.signal.aborted,
        partialText: tracker.partialText() || undefined,
      })
      return {
        text: envelope.message,
        channel: "text",
        toolsAvailable: false,
        runId: childRunId,
        finishReason: envelope.code === "aborted" ? "cancelled" : "error",
        errorEnvelope: envelope,
      }
    })

  // Terminal store recording happens exactly once, AFTER the retry loop
  // settles — a retried attempt must never record `failed` first.
  const finalize = (r: PluginSubagentDispatchResult): PluginSubagentDispatchResult => {
    if (r.rejection) {
      recordDispatchRejected({
        id: childRunId,
        name: p.subagentId,
        task: p.prompt,
        depth: childDepth,
        ...(p.caller.parentSubagentId ? { parentSubagentId: p.caller.parentSubagentId } : {}),
        parentSessionId: p.parentSessionId,
        rejection: r.rejection,
      })
    } else if (r.finishReason === "cancelled") {
      recordDispatchCancelled(childRunId)
    } else if (r.finishReason === "error" && r.errorEnvelope) {
      recordDispatchFailed(childRunId, r.errorEnvelope)
    } else if (r.finishReason === "error") {
      recordDispatchFailed(childRunId, {
        code: "unknown",
        retryable: false,
        message: r.text,
      })
    } else {
      recordDispatchComplete(childRunId, {
        text: r.text,
        ...(r.usage ? { usage: r.usage } : {}),
      })
    }
    unregisterSubagentRun(childRunId)
    return r
  }

  const cancelledResult = (
    envelope: PluginDispatchErrorEnvelope
  ): PluginSubagentDispatchResult => ({
    text: envelope.message,
    channel: "text",
    toolsAvailable: false,
    runId: childRunId,
    finishReason: "cancelled",
    errorEnvelope: { ...envelope, code: "aborted", retryable: false },
  })

  const runWithRetries = async (): Promise<PluginSubagentDispatchResult> => {
    let attempt = 0
    for (;;) {
      attempt += 1
      const r = await attemptDispatch()
      const envelope = r.errorEnvelope
      if (!envelope || r.finishReason === "cancelled" || r.rejection) {
        if (envelope) envelope.attempts = attempt
        return finalize(r)
      }
      const nextDelayMs = retryDelayMs(policy, attempt, envelope.retryAfterMs)
      const retry = shouldRetryDispatch(envelope, {
        attempt,
        policy,
        signal: abort.signal,
        nextDelayMs,
        ...(p.caller.deadlineMs !== undefined ? { deadlineMs: p.caller.deadlineMs } : {}),
        budgetExhausted: () => isDispatchBudgetExhausted(p.caller.budgetRoot),
      })
      if (!retry) {
        envelope.attempts = attempt
        return finalize(r)
      }
      recordDispatchRetry(childRunId, attempt, envelope, policy.maxRetries)
      await waitForRetry(nextDelayMs, abort.signal)
      if (abort.signal.aborted) {
        return finalize(cancelledResult(envelope))
      }
    }
  }

  const promise = runWithRetries()
  const journalMeta = {
    kind: "subagent" as const,
    subagentId: p.subagentId,
    prompt: p.prompt,
    sessionId: p.parentSessionId,
    host: "renderer" as const,
    startedAt: Date.now(),
    toolsEnabled: p.toolsEnabled,
    ...(p.resumeOfRunId ? { resumeOfRunId: p.resumeOfRunId } : {}),
    ...(p.resumeAttempt !== undefined ? { resumeAttempt: p.resumeAttempt } : {}),
  }

  if (p.background) {
    startRendererBackgroundRun(childRunId, journalMeta, promise, {
      cancel: () => abort.abort(),
    })
    return {
      runId: childRunId,
      text: `[${p.subagentId}] started in background (runId: ${childRunId}). Collect later with dispatch_agent({collect:"${childRunId}"}).`,
    }
  }

  journalRendererForegroundRun(childRunId, journalMeta, promise)
  const r = await promise
  return { runId: childRunId, text: renderDispatchOutcomeForModel(label, r) }
}
