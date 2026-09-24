/**
 * Fold a Squad run's journal into one row per step.
 *
 * The journal is append-only and per-event: `step.started`, then any number of
 * `step.progress`, then a terminal `step.completed` / `step.failed` /
 * `step.skipped`. What a reader wants is the current state of each step, so
 * this collapses the stream by `stepId` with the newest event winning.
 *
 * Kept as a pure function over `RunEvent[]` rather than a hook so the folding
 * rules — which event wins, what an unterminated step reads as, what happens
 * to an event with no `stepId` — are testable without Dexie.
 *
 * Deliberately narrow: this is the conversation's at-a-glance view. The full
 * cross-kind detail lives on `/agent-runs`, which the message links to.
 */

import type { RunEvent, RunEventType } from "@/types/execution/run"

export type SquadRunStepStatus = "running" | "completed" | "failed" | "skipped"

export interface SquadRunStep {
  /** `stepId` from the payload — a Squad task id. */
  id: string
  label: string
  status: SquadRunStepStatus
  startedAt: number
  endedAt?: number
}

const TERMINAL: Partial<Record<RunEventType, SquadRunStepStatus>> = {
  "step.completed": "completed",
  "step.failed": "failed",
  "step.skipped": "skipped",
}

const STEP_EVENTS = new Set<RunEventType>([
  "step.added",
  "step.started",
  "step.progress",
  "step.completed",
  "step.failed",
  "step.skipped",
])

function text(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * @returns one row per step, in the order each step was first seen — the order
 * the run actually did them, which is more useful than sorting by status.
 */
export function squadRunSteps(events: readonly RunEvent[]): SquadRunStep[] {
  const byId = new Map<string, SquadRunStep>()

  // Sorted by `seq`, not `ts`: two events written in the same millisecond are
  // ordered by the journal's own counter, and "which one won" must not depend
  // on clock resolution.
  const ordered = [...events].sort((a, b) => a.seq - b.seq)

  for (const event of ordered) {
    if (!STEP_EVENTS.has(event.type)) continue
    const stepId = text(event.payload, "stepId")
    // An event with no step identity cannot be attributed to a row. Dropping
    // it is right: inventing a row per orphan event would read as extra work
    // the Squad never did.
    if (!stepId) continue

    const label = text(event.payload, "title", "label", "name")
    const existing = byId.get(stepId)
    const terminal = TERMINAL[event.type]

    if (!existing) {
      byId.set(stepId, {
        id: stepId,
        label: label ?? stepId,
        status: terminal ?? "running",
        startedAt: event.ts,
        ...(terminal ? { endedAt: event.ts } : {}),
      })
      continue
    }

    // A later label replaces a placeholder, never the other way round.
    if (label) existing.label = label
    if (terminal) {
      existing.status = terminal
      existing.endedAt = event.ts
    }
  }

  return [...byId.values()]
}
