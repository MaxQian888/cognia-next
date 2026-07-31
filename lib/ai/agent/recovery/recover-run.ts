// Recovery state-machine seam (ADR-0090 Phase 8).
//
// The single entry that turns recovery CANDIDATES into an outcome:
//   1. claim the run's single-writer lease FIRST — two hosts must never
//      recover the same run concurrently;
//   2. plan via the strict-dominance `planRecovery`;
//   3. `auto` → hand the chosen candidate back to the caller (which resumes
//      with route/host/bindings pinned; tickets remint via
//      `planTicketRemint`);
//   4. anything else → append a first-class `run.recovery_required` event to
//      the semantic journal and stop. No last-modified-wins, ever.

import { claimRunLease, releaseRunLease } from "@/lib/workflow/runtime/run-lease"
import { runEventJournal, semanticRunEvent } from "@/lib/db/execution-runs"

import { planRecovery, type RecoveryCandidate, type RecoveryPlan } from "./recovery-planner"

export type RecoverRunOutcome =
  | { status: "recovered"; candidateId: string }
  | { status: "recovery_required"; reason: string; detail: string[] }
  | { status: "lease-held" }

export interface RecoverRunDeps {
  claimLease?: (runId: string) => Promise<"claimed" | "held" | "not-found">
  releaseLease?: (runId: string) => Promise<void>
  appendJournal?: typeof runEventJournal.append
}

/**
 * Run the recovery decision for `runId`. On `auto`, the LEASE STAYS HELD —
 * the caller continues as the single writer and releases it when its resumed
 * run settles. On pause/no-op outcomes the lease is released here.
 */
export async function recoverRun(
  runId: string,
  candidates: RecoveryCandidate[],
  deps: RecoverRunDeps = {}
): Promise<RecoverRunOutcome> {
  const claim = deps.claimLease ?? (async (id: string) => claimRunLease(id))
  const release = deps.releaseLease ?? (async (id: string) => releaseRunLease(id))
  const append = deps.appendJournal ?? runEventJournal.append.bind(runEventJournal)

  const lease = await claim(runId)
  if (lease === "held") return { status: "lease-held" }

  const plan: RecoveryPlan = planRecovery(candidates)
  if (plan.action === "auto") {
    // Lease intentionally kept — the caller is now the single writer.
    return { status: "recovered", candidateId: plan.candidateId }
  }

  try {
    await append(
      runId,
      semanticRunEvent(
        "run.recovery_required",
        { reason: plan.reason, detail: plan.detail },
        { ts: Date.now() }
      )
    )
  } finally {
    if (lease === "claimed") await release(runId)
  }
  return { status: "recovery_required", reason: plan.reason, detail: plan.detail }
}
