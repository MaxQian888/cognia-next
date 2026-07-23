// Startup reconciliation for crashed agent runs (ADR-0090 Phase 8).
//
// At bootstrap (alongside `recoverPendingRunInterrupts`), any agent-turn
// execution run still projected `running` has lost its writer — the renderer
// just booted. Each one goes through the recovery state machine:
//
//   candidates ← the run's canonical envelope log (side-effect ambiguity
//                derived from unresolved tool calls)
//   recoverRun ← claims the single-writer lease, plans strict dominance
//     · pause  → a first-class `run.recovery_required` event (human decides)
//     · auto   → the run is parked as `run.paused` with the chosen candidate
//                recorded; NOTHING is replayed automatically — resuming is
//                an explicit operator/run-owner action.
//
// This is deliberately zero-replay: reconciliation only ever narrows a stale
// `running` into an honest terminal-adjacent state.

import { getDb } from "@/lib/db/schema"
import { runEventJournal, semanticRunEvent } from "@/lib/db/execution-runs"
import { releaseRunLease } from "@/lib/workflow/runtime/run-lease"

import { candidateFromEnvelopes, readCanonicalEnvelopes } from "./canonical-log"
import { recoverRun, type RecoverRunOutcome } from "./recover-run"

export interface ReconcileOutcome {
  runId: string
  outcome: RecoverRunOutcome
}

/**
 * Reconcile every stale-`running` agent-turn run. Best-effort per run — one
 * failing run never blocks the rest. Returns what happened for observability
 * and tests.
 */
export async function reconcileCrashedAgentRuns(
  now: number = Date.now()
): Promise<ReconcileOutcome[]> {
  const runs = await getDb().executionRuns.toArray()
  const crashed = runs.filter(
    (run) => run.kind === "agent-turn" && (run.latestSnapshot?.status ?? run.status) === "running"
  )

  const outcomes: ReconcileOutcome[] = []
  for (const run of crashed) {
    try {
      const envelopes = await readCanonicalEnvelopes(run.id)
      const candidate = candidateFromEnvelopes(envelopes)
      const outcome = await recoverRun(run.id, candidate ? [candidate] : [])
      if (outcome.status === "recovered") {
        // Park — never replay. The chosen candidate is recorded so a resume
        // action knows what state it continues from.
        await runEventJournal.append(
          run.id,
          semanticRunEvent(
            "run.paused",
            { reason: "crash-reconciled", candidateId: outcome.candidateId },
            { ts: now, sourceEventId: `crash-reconcile:${run.id}` }
          )
        )
        await releaseRunLease(run.id)
      }
      outcomes.push({ runId: run.id, outcome })
    } catch {
      // Reconciliation is best-effort; the run stays as-is for manual action.
    }
  }
  return outcomes
}
