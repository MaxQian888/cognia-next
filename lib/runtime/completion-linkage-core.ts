/**
 * Shared "terminal event → subscribed workflows" fan-out core.
 *
 * `lib/goal/completion-linkage.ts` and `lib/ai/agent/team-completion-linkage.ts`
 * grew as parallel mirrors of the same mechanics; this module hosts the one
 * copy of what they share:
 *
 *   - lazy-load the workflow runtime (trigger bridge + subscriptions) so the
 *     goal/team subsystems stay cheap to import;
 *   - match subscribed workflows for the trigger kind, early-return on none;
 *   - dispatch every match with per-match isolation (one bad workflow can't
 *     block the others) and a shared `originAt`;
 *   - swallow everything at the outer edge — completion side effects are
 *     best-effort and must never throw back into a state machine's terminal
 *     block;
 *   - PII-gate model-produced free text before it rides a trigger payload
 *     (`gateModelText` — omit-when-unsafe, never empty-string, so templates
 *     can distinguish "no result").
 *
 * Domain-specific parts stay in the wrappers: payload/binding shapes, the
 * team chain-depth loop guard, and goal's notification / scheduler-event /
 * plugin-hook side effects.
 */

import type { TriggerMatchContext } from "@/lib/workflow/runtime/trigger-subscriptions"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

export interface CompletionFanoutInput {
  /** Trigger kind, e.g. `"trigger.team"` / `"trigger.goal.completed"`. */
  kind: WorkflowNodeKind
  /** Subscription match context (adapter/session/goal/team filters). */
  match: TriggerMatchContext
  /** Trigger payload delivered as `{{ $trigger.payload }}`. */
  payload: Record<string, unknown>
  /** Trigger binding persisted on the run row. */
  binding: Record<string, unknown>
}

/** Fan a terminal event out to every subscribed workflow. Never throws. */
export async function dispatchCompletionFanout(input: CompletionFanoutInput): Promise<void> {
  try {
    const [{ dispatchTrigger }, { findMatchingWorkflows }] = await Promise.all([
      import("@/lib/workflow/runtime/trigger-bridge"),
      import("@/lib/workflow/runtime/trigger-subscriptions"),
    ])
    const matches = findMatchingWorkflows(input.kind, input.match)
    if (matches.length === 0) return

    const originAt = Date.now()
    await Promise.all(
      matches.map((match) =>
        dispatchTrigger({
          workflowId: match.workflowId,
          kind: input.kind,
          payload: input.payload,
          originAt,
          binding: input.binding,
        }).catch(() => {
          // Per-match isolation — one bad workflow can't block the others.
        })
      )
    )
  } catch {
    // Workflow runtime unavailable (e.g. web-only build path) — best-effort.
  }
}

/**
 * PII red-line for model-produced free text riding a trigger payload:
 * returns the (optionally capped) text only when `hasNoLeakingPii` passes,
 * `undefined` otherwise — and `undefined` when the gate itself can't load
 * (fail-closed).
 */
export async function gateModelText(
  text: string | undefined,
  maxChars?: number
): Promise<string | undefined> {
  if (!text) return undefined
  try {
    const { hasNoLeakingPii } = await import("@/lib/twin/ingest/redact")
    if (!hasNoLeakingPii(text)) return undefined
    return maxChars !== undefined ? text.slice(0, maxChars) : text
  } catch {
    return undefined
  }
}
