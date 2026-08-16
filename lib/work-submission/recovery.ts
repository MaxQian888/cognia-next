/**
 * Recovery decisions for work stranded by a crash (ADR-0123).
 *
 * A submission that was `claimed` or `dispatched` when the process died is
 * ambiguous: the runtime may never have seen it, may have started it, or may
 * have run tools and died before reporting. This module answers one question
 * per submission — **may this be re-dispatched automatically?** — and defaults
 * to "no".
 *
 * The rule is asymmetric on purpose. Re-dispatching work that already ran a
 * tool can double-fire a side effect the user cannot undo; leaving work parked
 * costs an explicit resume. So automatic replay requires positive evidence that
 * nothing happened, not merely the absence of evidence that something did.
 *
 * This does **not** introduce a second recovery machine. It composes the
 * existing zero-replay machinery in `lib/ai/agent/recovery/`:
 * `readCanonicalEnvelopes` + `candidateFromEnvelopes` + `planRecovery` decide
 * whenever a canonical envelope log exists. The semantic run journal is
 * consulted first because Direct Chat writes `tool.*` events there long before
 * it writes canonical envelopes, and a tool call recorded in either place is
 * disqualifying.
 */

import { listExecutionRunEvents } from "@/lib/db/execution-runs"
import {
  candidateFromEnvelopes,
  CanonicalLogCorruptionError,
  readCanonicalEnvelopes,
} from "@/lib/ai/agent/recovery/canonical-log"
import { planRecovery } from "@/lib/ai/agent/recovery/recovery-planner"
import type { WorkSubmissionRow } from "@/lib/db/work-submissions"

/** Run-event types that prove the turn reached a tool. */
const TOOL_EVENT_TYPES = new Set(["tool.started", "tool.completed", "tool.failed"])

export type WorkRecoveryDecision =
  | {
      action: "redispatch"
      /**
       * `never-dispatched` — the runtime was never handed the work.
       * `no-observed-effects` — it was, but nothing side-effecting was recorded.
       */
      reason: "never-dispatched" | "no-observed-effects"
    }
  | {
      action: "recovery_required"
      reason:
        | "observed-tool-activity"
        | "corrupt-canonical-log"
        | "no-candidates"
        | "forked-history"
        | "no-dominant"
        | "ambiguous-side-effects"
        | "unreadable-journal"
      detail: string[]
    }

export interface WorkRecoveryDeps {
  listRunEvents?: typeof listExecutionRunEvents
  readEnvelopes?: typeof readCanonicalEnvelopes
}

/**
 * Decide whether a stranded submission may be re-dispatched without asking.
 *
 * Order matters: the cheap, always-present semantic journal is checked before
 * the canonical envelope log, because a `tool.*` event is disqualifying on its
 * own and reading envelopes cannot make it safe again.
 */
export async function planWorkSubmissionRecovery(
  row: WorkSubmissionRow,
  deps: WorkRecoveryDeps = {}
): Promise<WorkRecoveryDecision> {
  // Never claimed means the runtime never saw it: replaying is a first attempt,
  // not a retry.
  if (row.attemptCount === 0) return { action: "redispatch", reason: "never-dispatched" }

  const listEvents = deps.listRunEvents ?? listExecutionRunEvents
  let events
  try {
    events = await listEvents(row.runId)
  } catch (error) {
    return {
      action: "recovery_required",
      reason: "unreadable-journal",
      detail: [error instanceof Error ? error.message : String(error)],
    }
  }
  const toolEvents = events.filter((event) => TOOL_EVENT_TYPES.has(event.type))
  if (toolEvents.length > 0) {
    return {
      action: "recovery_required",
      reason: "observed-tool-activity",
      detail: [`${toolEvents.length} tool event(s) recorded on run ${row.runId}`],
    }
  }

  let envelopes
  try {
    envelopes = await (deps.readEnvelopes ?? readCanonicalEnvelopes)(row.runId)
  } catch (error) {
    if (error instanceof CanonicalLogCorruptionError) {
      return {
        action: "recovery_required",
        reason: "corrupt-canonical-log",
        detail: [error.message],
      }
    }
    return {
      action: "recovery_required",
      reason: "unreadable-journal",
      detail: [error instanceof Error ? error.message : String(error)],
    }
  }

  // An absent canonical log is the common case for a turn that died before the
  // runtime produced anything. Combined with the tool-event check above, that
  // is positive evidence of "nothing happened" — not merely missing evidence.
  // (`candidateFromEnvelopes` returns undefined exactly when there are none.)
  const candidate = candidateFromEnvelopes(envelopes)
  if (!candidate) return { action: "redispatch", reason: "no-observed-effects" }

  const plan = planRecovery([candidate])
  if (plan.action === "auto") return { action: "redispatch", reason: "no-observed-effects" }
  return { action: "recovery_required", reason: plan.reason, detail: plan.detail }
}
