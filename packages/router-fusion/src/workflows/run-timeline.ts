/**
 * What a run went through, read back from its journal (ADR-0188 B3).
 *
 * The run card shows a cascade's escalation and a panel's candidates and
 * judge. All of it is already in the journal as counts, reasons and phase
 * names — the journal never holds model output — so the card's picture is a
 * pure fold over the events, and the same fold serves a run still in flight
 * and a sealed one.
 */

export interface TimelineEvent {
  type: string
  payload: Record<string, unknown>
  /** Epoch milliseconds. */
  at: number
}

export interface RunTimeline {
  phases: Array<{ phase: string; step: string | null; at: number }>
  calls: { started: number; finished: number; unknown: number }
  candidates: { members: number | null; rejected: number; evidenceRejected: number }
  judge: {
    supported: number
    rejected: number
    unverified: number
    contradictions: number
    unresolved: number
  } | null
  escalated: { reason: string } | null
  degraded: { reason: string } | null
  verification: { status: string; level: string } | null
  compactions: number
}

/** A timeline is shown, not archived: past this many phase entries the oldest go. */
export const MAX_TIMELINE_PHASES = 24

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function emptyRunTimeline(): RunTimeline {
  return {
    phases: [],
    calls: { started: 0, finished: 0, unknown: 0 },
    candidates: { members: null, rejected: 0, evidenceRejected: 0 },
    judge: null,
    escalated: null,
    degraded: null,
    verification: null,
    compactions: 0,
  }
}

export function runTimelineOf(events: readonly TimelineEvent[]): RunTimeline {
  const timeline = emptyRunTimeline()
  for (const event of events) {
    const payload = event.payload ?? {}
    switch (event.type) {
      case "phase.changed": {
        // The ledger's own status transitions carry `from`/`to`, not a phase.
        const phase = text(payload.phase)
        if (!phase) break
        const step = text(payload.step)
        if (phase === "context" && step === "compacted") timeline.compactions += 1
        if (phase === "prepare" && typeof payload.members === "number") {
          timeline.candidates.members = count(payload.members)
        }
        if (phase === "judge" && step === "reported") {
          timeline.judge = {
            supported: count(payload.supported),
            rejected: count(payload.rejected),
            unverified: count(payload.unverified),
            contradictions: count(payload.contradictions),
            unresolved: count(payload.unresolved),
          }
        }
        if (phase === "cascade" && step === "escalate") {
          timeline.escalated = { reason: text(payload.reason) ?? "UNKNOWN" }
        }
        const last = timeline.phases.at(-1)
        if (last && last.phase === phase && last.step === step) break
        timeline.phases.push({ phase, step, at: event.at })
        if (timeline.phases.length > MAX_TIMELINE_PHASES) timeline.phases.shift()
        break
      }
      case "call.started":
        timeline.calls.started += 1
        break
      case "call.finished":
        timeline.calls.finished += 1
        if (payload.status === "unknown" || payload.state === "UNKNOWN") timeline.calls.unknown += 1
        break
      case "candidate.rejected":
        if (payload.scope === "evidence") timeline.candidates.evidenceRejected += 1
        else timeline.candidates.rejected += 1
        break
      case "run.degraded":
        timeline.degraded = { reason: text(payload.reason) ?? "UNKNOWN" }
        break
      case "verification.completed": {
        const status = text(payload.status)
        const level = text(payload.level)
        if (status && level) timeline.verification = { status, level }
        break
      }
      case "answer.completed": {
        const status = text(payload.verification_status)
        const level = text(payload.verification_level)
        if (status && level) timeline.verification = { status, level }
        break
      }
    }
  }
  return timeline
}
