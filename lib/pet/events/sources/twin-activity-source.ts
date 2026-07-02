// Ambient twin-awareness (opt-in) → pet events. Watches ONE user-picked twin's
// job metadata only — status/kind/timestamps from `twinJobs`, never twin
// content (source text, chunks, the distilled profile) — and derives two
// low-stakes signals: a busy edge (any queued/running/paused job) and a
// milestone edge (a distill/re-distill job just completed). Because the emit
// payload is built field-by-field from typed enums/counts, there's no PII
// surface to gate here (contrast `character-persona.ts`, which reads free-text
// `voiceSummary` and does need `hasNoLeakingPii`).
//
// Two independent Dexie observations, both injectable so the edge-detection
// logic is unit-tested with plain fakes (mirrors `goal-source.ts`).

import { liveQuery } from "dexie"
import { listActiveJobsByTwin, listJobsByTwinAndStatus } from "@/lib/db/twin-jobs"
import type { TwinJob } from "@/types/twin"
import type { PetEmit } from "../pet-event-bus"
import type { RowObserver } from "./goal-source"

/** A twin counts as "busy" whenever it has any active (queued/running/paused) job. */
export function deriveBusy(activeJobCount: number): boolean {
  return activeJobCount > 0
}

/**
 * Milestones are meaningful learning events. Raw `ingest` completions don't
 * qualify — importing a source isn't "the twin learned something," distilling
 * it is.
 */
export function isMilestoneJob(job: TwinJob): boolean {
  return job.status === "completed" && (job.kind === "distill" || job.kind === "re-distill")
}

/** Newest milestone job by `completedAt` (ties broken arbitrarily — rare). */
export function newestMilestone(jobs: TwinJob[]): TwinJob | null {
  const milestones = jobs.filter(isMilestoneJob)
  if (!milestones.length) return null
  return milestones.reduce((a, b) => ((b.completedAt ?? 0) > (a.completedAt ?? 0) ? b : a))
}

/* istanbul ignore next -- thin Dexie liveQuery wrapper, exercised at runtime */
function defaultObserveActive(twinId: string): RowObserver<TwinJob> {
  return (onRows) => {
    const sub = liveQuery(() => listActiveJobsByTwin(twinId)).subscribe({ next: onRows })
    return () => sub.unsubscribe()
  }
}

/* istanbul ignore next -- thin Dexie liveQuery wrapper, exercised at runtime */
function defaultObserveCompleted(twinId: string): RowObserver<TwinJob> {
  return (onRows) => {
    const sub = liveQuery(() => listJobsByTwinAndStatus(twinId, "completed")).subscribe({
      next: onRows,
    })
    return () => sub.unsubscribe()
  }
}

export interface TwinActivitySourceDeps {
  observeActive?: RowObserver<TwinJob>
  observeCompleted?: RowObserver<TwinJob>
}

/**
 * Curried source: bind the watched `twinId` (+ optional test doubles) once,
 * yielding a `PetSourceWire`-shaped function so it composes into the same
 * source list as the zero-arg sources in `wire-sources.ts`.
 */
export function wireTwinActivitySource(
  twinId: string,
  deps: TwinActivitySourceDeps = {}
): (emit: PetEmit) => () => void {
  const observeActive = deps.observeActive ?? defaultObserveActive(twinId)
  const observeCompleted = deps.observeCompleted ?? defaultObserveCompleted(twinId)

  return (emit: PetEmit) => {
    // Starts false (not "unknown") — a job already active when the app opens
    // should surface immediately, same "settle current truth at launch"
    // philosophy as the heartbeat source. No mount-suppression needed here.
    let lastBusy = false
    // Milestones DO suppress their first emission — otherwise re-opening the
    // app replays a "happy" one-shot for a job that finished yesterday.
    let lastMilestoneId: string | null = null
    let milestoneStarted = false

    const offActive = observeActive((rows) => {
      const busy = deriveBusy(rows.length)
      if (busy === lastBusy) return
      lastBusy = busy
      if (busy) {
        emit({ source: "twin", kind: "twinBusy", meta: { twinId, activeJobCount: rows.length } })
      } else {
        emit({ source: "twin", kind: "idle", meta: { twinId } })
      }
    })

    const offCompleted = observeCompleted((rows) => {
      const newest = newestMilestone(rows)
      if (!newest || newest.id === lastMilestoneId) return
      lastMilestoneId = newest.id
      if (!milestoneStarted) {
        milestoneStarted = true
        return
      }
      emit({ source: "twin", kind: "twinMilestone", meta: { twinId, jobKind: newest.kind } })
    })

    return () => {
      offActive()
      offCompleted()
    }
  }
}
