/**
 * Shell-agnostic lifecycle-hook firer.
 *
 * Several autonomous LLM calls run *outside* the agent's main stream — the
 * `/goal` judge (`lib/goal/judge.ts`) and agent-team planning
 * (`agent-team-runtime.ts`). ADR-0040 wired the System-B settings.json hook
 * runtime only for the built-in/external agents, so those second-order LLM
 * calls were hook-blind. This module is the single seam those call sites inject
 * to bracket their LLM call with lifecycle hooks.
 *
 * The renderer/desktop default reuses {@link fireAgentHook} — the same
 * `run_agent_hook` Tauri bridge external agents use — so it reaches the shared
 * Rust runtime and gracefully no-ops on web/mobile. The CLI provides its own
 * firer backed by the CLI hook runner (see `cli/src/tui/runtime/lifecycle-firer.ts`).
 *
 * Every call is best-effort: a broken or absent hook bridge must never break
 * the autonomous LLM call it brackets.
 */

import {
  fireAgentHook,
  type AgentHookContext,
  type AgentHookDecision,
} from "@/lib/ai/agent/external/agent-hooks"

export type { AgentHookContext, AgentHookDecision }

/**
 * Fires one lifecycle hook event and resolves to the runtime's decision, or
 * `null` when no hook runtime is reachable (web/mobile, bridge error).
 */
export type LifecycleHookFirer = (
  event: string,
  ctx: AgentHookContext,
  opts?: { toolName?: string; payload?: Record<string, unknown> }
) => Promise<AgentHookDecision | null>

/** Renderer/desktop default — reuses the Tauri System-B bridge (no-ops on web). */
export const defaultLifecycleFirer: LifecycleHookFirer = (event, ctx, opts) =>
  fireAgentHook(event, ctx, opts)

/** Always-allow no-op firer — the default when no firer is injected (tests, web). */
export const noopLifecycleFirer: LifecycleHookFirer = async () => null

/** Outcome of bracketing a call's pre-hooks (SessionStart + UserPromptSubmit). */
export interface PreCallHookOutcome {
  /** Non-null reason when a blocking `UserPromptSubmit` hook denied the call. */
  block: string | null
  /** Concatenated `additionalContext` contributed by the pre-hooks, if any. */
  additionalContext: string | null
}

/** Join two optional context strings the way the Rust runtime concatenates them. */
function joinContext(a: string | null, b: string | null | undefined): string | null {
  const parts = [a, b].filter((s): s is string => typeof s === "string" && s.length > 0)
  return parts.length > 0 ? parts.join("\n\n") : null
}

/**
 * Fire the pre-call lifecycle hooks for an autonomous LLM call: the
 * observational `SessionStart`, then the blocking `UserPromptSubmit`. Returns
 * the merged `additionalContext` and the first block reason (the call site
 * aborts when `block` is set). Never throws.
 */
export async function firePreCallHooks(
  firer: LifecycleHookFirer,
  ctx: AgentHookContext,
  prompt: string,
  extraPayload?: Record<string, unknown>
): Promise<PreCallHookOutcome> {
  let additionalContext: string | null = null
  try {
    const start = await firer("SessionStart", ctx, { payload: extraPayload })
    additionalContext = joinContext(additionalContext, start?.additionalContext)

    const submit = await firer("UserPromptSubmit", ctx, {
      payload: { prompt, ...extraPayload },
    })
    additionalContext = joinContext(additionalContext, submit?.additionalContext)
    if (submit?.block) {
      return { block: submit.block, additionalContext }
    }
  } catch {
    // Best-effort: a broken firer must never break the bracketed call.
  }
  return { block: null, additionalContext }
}

/**
 * Fire the post-call lifecycle hooks for an autonomous LLM call: `Stop`
 * (or `StopFailure`) then `SessionEnd`. Observational only — never blocks,
 * never throws.
 */
export async function firePostCallHooks(
  firer: LifecycleHookFirer,
  ctx: AgentHookContext,
  outcome: { success: boolean; error?: string }
): Promise<void> {
  try {
    if (outcome.success) {
      await firer("Stop", ctx, { payload: { success: true } })
    } else {
      await firer("StopFailure", ctx, { payload: { error: outcome.error ?? "" } })
    }
    await firer("SessionEnd", ctx)
  } catch {
    // Best-effort.
  }
}
