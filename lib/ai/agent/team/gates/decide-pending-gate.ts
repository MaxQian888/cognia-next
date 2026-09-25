"use client"

/**
 * Settle a pending plan-step or cost-budget gate — the one decision path every
 * surface shares.
 *
 * The root-mounted gate dialog and the island overlay both answer these gates.
 * A gate is three things that must move together: the approval-bus waiter the
 * producer is blocked on, the store entry that renders it, and the record left
 * in the conversation the run belongs to. Answering from a second surface with
 * its own copy of those steps is how a gate ends up resolved but still on
 * screen, or answered with no record of who decided it.
 */

import { approve, reject } from "@/lib/runtime/approval-bus"
import { usePendingGatesStore, type PendingGate } from "@/stores/agent/pending-gates-store"

export type PendingGateDecision =
  | { outcome: "approve"; payload?: unknown }
  | { outcome: "reject"; feedback?: string }
  /** A gate restored after a reload: its waiter died with the page. */
  | { outcome: "dismiss" }

const RECORDED_DECISION = {
  approve: "approved",
  reject: "rejected",
  dismiss: "dismissed",
} as const

/**
 * Deliver `decision`, remove the gate and record the answer.
 *
 * The entry is removed whatever the bus reports: a gate nobody is waiting on
 * can only ever be answered into the void. The record is best-effort and
 * fire-and-forget — the run is waiting on the answer, and losing the answer
 * would be far worse than losing the note.
 *
 * @returns whether a live waiter received the decision. Always false for a
 * dismissal, which deliberately resolves nothing.
 */
export function decidePendingGate(gate: PendingGate, decision: PendingGateDecision): boolean {
  let delivered = 0
  if (decision.outcome === "approve") delivered = approve(gate.key, decision.payload)
  if (decision.outcome === "reject") delivered = reject(gate.key, decision.feedback)
  usePendingGatesStore.getState().close(gate.key)
  if (gate.runId) {
    const runId = gate.runId
    void import("./record-gate-answer")
      .then(({ recordSquadGateAnswer }) =>
        recordSquadGateAnswer({
          runId,
          gateType: gate.gateType,
          decision: RECORDED_DECISION[decision.outcome],
          title: gate.title,
        })
      )
      .catch(() => undefined)
  }
  return delivered > 0
}
