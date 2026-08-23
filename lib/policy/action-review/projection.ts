/**
 * The two calls every approval channel makes, so one list can answer
 * "what is blocked on a human?" and one table can answer "what was decided?".
 *
 * Channels keep owning their own waiters and their own UI. This layer only
 * projects:
 *
 * - {@link projectActionReviewOpened} parks a run on an `ExecutionRunInterrupt`
 *   (the durable, per-run pending table that already existed — deliberately no
 *   new pending store, see ADR notes on the sibling harness plan's D3);
 * - {@link projectActionReviewSettled} resolves that interrupt and writes the
 *   `ActionReviewReceipt` that, before this, only `workflow-step` ever wrote.
 *
 * Both are best-effort by construction. A projection failure must never block
 * or fail the approval itself — the decision plumbing is authoritative and the
 * projection is an observer, so every write here is wrapped and swallowed.
 * Losing a row from a list is recoverable; losing an approval is not.
 */

import type {
  ActionReviewDecision,
  ActionReviewEffect,
  ActionReviewReceipt,
  ActionReviewRequest,
} from "@cognia/agent-config-types/action-review"
import type { ExecutionRunInterrupt } from "@/types/execution/run"
import { getActionReviewChannelAdapter } from "./registry"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Stable interrupt id for a review, so a retried open does not mint a second
 * pending row and a settle can always find the row its open created.
 */
export function actionReviewInterruptId(requestId: string): string {
  return `${ACTION_REVIEW_INTERRUPT_PREFIX}${requestId}`
}

const ACTION_REVIEW_INTERRUPT_PREFIX = "action-review:"

/**
 * The review request an interrupt came from, or `undefined` if it came from
 * somewhere else.
 *
 * Exists so a surface that lists BOTH pending approvals and pending run
 * interrupts can tell that the two are one item. Without it the Control Center
 * shows every chat tool approval twice — once from the chat store, once from
 * the interrupt this module created for the same request.
 */
export function actionReviewRequestIdFromInterrupt(interruptId: string): string | undefined {
  if (!interruptId.startsWith(ACTION_REVIEW_INTERRUPT_PREFIX)) return undefined
  const requestId = interruptId.slice(ACTION_REVIEW_INTERRUPT_PREFIX.length)
  return requestId || undefined
}

/**
 * A title safe to show in a run list.
 *
 * `subject.title` is producer-supplied and may carry a path or an argument, so
 * it is NOT used. The tool/node reference is a short identifier from a closed
 *-ish vocabulary, which is what a pending list actually needs.
 */
function interruptTitle(request: ActionReviewRequest): string {
  const ref = request.subject.ref.trim()
  return ref.length > 0 ? ref : request.subject.kind
}

/** Park the run on a pending interrupt. No-op when there is no run to park. */
export async function projectActionReviewOpened(
  request: ActionReviewRequest,
  now: number = Date.now()
): Promise<{ interruptId: string } | null> {
  const runId = request.origin.runId
  if (!runId) return null
  const adapter = getActionReviewChannelAdapter(request.origin.channel)
  if (!adapter.interruptType) return null

  const interrupt: ExecutionRunInterrupt = {
    id: actionReviewInterruptId(request.requestId),
    runId,
    ...(request.origin.projectId ? { projectId: request.origin.projectId } : {}),
    type: adapter.interruptType,
    status: "pending",
    title: interruptTitle(request),
    ...(request.subject.kind === "tool-call" ? { toolName: request.subject.ref } : {}),
    expiresAt: request.expiresAt ?? now + adapter.defaultTtlMs,
    createdAt: request.requestedAt ?? now,
  }

  try {
    const { createRunInterrupt } = await import("@/lib/execution/run-control")
    await createRunInterrupt(interrupt)
    return { interruptId: interrupt.id }
  } catch {
    // Already projected, or the run is gone. Either way the approval itself is
    // unaffected — see the module docblock.
    return null
  }
}

function receiptFrom(
  request: ActionReviewRequest,
  decision: ActionReviewDecision,
  retentionDays: number,
  effect?: ActionReviewEffect
): ActionReviewReceipt {
  return {
    contractVersion: request.contractVersion,
    id: request.requestId,
    request,
    decision,
    ...(effect ? { effect } : {}),
    expiresAt: decision.decidedAt + retentionDays * DAY_MS,
  }
}

/**
 * Resolve the pending interrupt and record the durable receipt.
 *
 * The receipt is written even when there was no run to park — an approval that
 * belongs to no run is still an auditable decision.
 */
export async function projectActionReviewSettled(
  request: ActionReviewRequest,
  decision: ActionReviewDecision,
  effect?: ActionReviewEffect
): Promise<void> {
  const runId = request.origin.runId
  const adapter = getActionReviewChannelAdapter(request.origin.channel)

  if (runId && adapter.interruptType) {
    try {
      const { resolveRunInterruptFromSource, expireRunInterruptFromSource } =
        await import("@/lib/execution/run-control")
      const interruptId = actionReviewInterruptId(request.requestId)
      if (decision.outcome === "expired") {
        await expireRunInterruptFromSource(runId, interruptId)
      } else {
        // `allow_always` is an allow that also wrote a rule; the run resumes
        // either way. `interrupted` is a deny for the run's purposes — the
        // waiter died, so nothing was authorized.
        const resolution =
          decision.outcome === "allow" || decision.outcome === "allow_always" ? "approve" : "deny"
        await resolveRunInterruptFromSource(
          runId,
          interruptId,
          resolution,
          decision.actor ? { displayName: decision.actor.label ?? decision.actor.id } : undefined
        )
      }
    } catch {
      // See the module docblock: never fail an approval on its projection.
    }
  }

  try {
    // Imported lazily, with the retention constant, so this module stays
    // Dexie-free at load. It is reached from `lib/claude/ipc` and the chat
    // hooks; a static `lib/db/*` import there would pull the whole schema into
    // every one of their test suites and into the first-paint graph.
    const { recordActionReviewReceipt, ACTION_REVIEW_RETENTION_DAYS } =
      await import("@/lib/db/action-review-receipts")
    await recordActionReviewReceipt(
      receiptFrom(request, decision, ACTION_REVIEW_RETENTION_DAYS, effect)
    )
  } catch {
    // Audit is best-effort at the write; retention and the cap are enforced
    // by the accessor itself.
  }
}
