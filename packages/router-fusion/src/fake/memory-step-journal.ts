/**
 * An in-memory DelegateStepJournal — the reference behaviour the host's
 * durable journal must match, for the offline delegate tests and the labelled
 * mock path. A step is PREPARED, then DISPATCHED before its side effect
 * starts, then COMMITTED with its receipt. A committed step replays its
 * receipt; a dispatched one that never committed is UNKNOWN; the same step id
 * with another request is a mismatch. Receipts are stored as JSON, so a
 * receipt that would not survive the host's database fails here too.
 */

import type {
  DelegateSideEffectKind,
  DelegateStepJournal,
  StepJournalBegin,
} from "../workflows/delegate-ports"

export interface MemoryJournalEntry {
  kind: DelegateSideEffectKind
  requestHash: string
  state: "prepared" | "dispatched" | "committed"
  receipt?: string
}

export class MemoryStepJournal implements DelegateStepJournal {
  readonly entries = new Map<string, MemoryJournalEntry>()

  async begin(input: {
    stepId: string
    kind: DelegateSideEffectKind
    requestHash: string
  }): Promise<StepJournalBegin> {
    const entry = this.entries.get(input.stepId)
    if (!entry) {
      this.entries.set(input.stepId, {
        kind: input.kind,
        requestHash: input.requestHash,
        state: "prepared",
      })
      return { kind: "fresh" }
    }
    if (entry.kind !== input.kind || entry.requestHash !== input.requestHash)
      return { kind: "mismatch" }
    if (entry.state === "committed") {
      return { kind: "replay", receipt: JSON.parse(entry.receipt as string) as unknown }
    }
    if (entry.state === "dispatched") return { kind: "unknown" }
    return { kind: "fresh" }
  }

  async markDispatched(stepId: string): Promise<void> {
    const entry = this.entries.get(stepId)
    if (!entry) throw new Error(`no journal step ${stepId}`)
    if (entry.state === "committed") throw new Error(`step ${stepId} is already committed`)
    entry.state = "dispatched"
  }

  async commit(stepId: string, receipt: unknown): Promise<void> {
    const entry = this.entries.get(stepId)
    if (!entry || entry.state !== "dispatched") {
      throw new Error(`step ${stepId} is not dispatched`)
    }
    entry.receipt = JSON.stringify(receipt)
    entry.state = "committed"
  }

  /** Test seam: a step dispatched and never answered, as a crash leaves it. */
  strand(stepId: string, kind: DelegateSideEffectKind, requestHash: string): void {
    this.entries.set(stepId, { kind, requestHash, state: "dispatched" })
  }
}
