/**
 * What a run went through, read back from its journal (ADR-0188 B3, B4).
 *
 * The run card shows a cascade's escalation, a panel's candidates and judge,
 * and a delegate's attempts, turns, tool operations, sandbox tier, approvals
 * and delivery. All of it is already in the journal as counts, reasons and
 * phase names — the journal never holds model output — so the card's picture
 * is a pure fold over the events, and the same fold serves a run still in
 * flight and a sealed one.
 *
 * A delegate run re-executes its graph after an approval and replays what it
 * already did, so its events can repeat. The delegate part of the fold keys
 * every count by attempt and turn, and a repeated event changes nothing.
 */

export interface TimelineEvent {
  type: string
  payload: Record<string, unknown>
  /** Epoch milliseconds. */
  at: number
}

export interface DelegateTimeline {
  /** Subtasks the lead planned, and how many the run has finished. */
  subtasks: { planned: number | null; completed: number }
  /** Sessions started: a subtask's work session, then any repair or takeover. */
  attempts: number
  repairs: number
  takeovers: number
  /** Model turns across every session. */
  workerTurns: number
  /** Tool operations admitted across every session (refusals past a limit not counted). */
  toolOperations: number
  /** The sandbox tier of the latest acceptance run. */
  sandboxTier: string | null
  /** Files in the latest staged or delivered patch. */
  patchFiles: number | null
  /** `patch_only` or `workspace_updated`, once delivered. */
  delivery: string | null
  approvals: {
    /** Distinct approval requests (by digest). */
    requested: number
    /** The request the run waits on, if any. */
    pending: { kind: string } | null
  }
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
  /** Null for every mode but delegate. */
  delegate: DelegateTimeline | null
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
    delegate: null,
  }
}

interface DelegateFold {
  seen: boolean
  kinds: Map<number, string>
  planned: number | null
  done: Set<number>
  turns: Set<string>
  tools: Map<string, number>
  tier: string | null
  patchFiles: number | null
  delivery: string | null
  digests: Set<string>
  pending: Map<string, string>
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

function foldDelegatePhase(
  fold: DelegateFold,
  step: string | null,
  payload: Record<string, unknown>
) {
  fold.seen = true
  const attempt = positiveInt(payload.attempt)
  switch (step) {
    case "planned": {
      fold.planned = positiveInt(payload.subtasks)
      break
    }
    case "subtask_done": {
      const index = positiveInt(payload.subtask)
      if (index !== null) fold.done.add(index)
      break
    }
    case "attempt": {
      const kind = text(payload.kind)
      if (attempt !== null && kind) fold.kinds.set(attempt, kind)
      break
    }
    case "turn": {
      const turn = positiveInt(payload.turn)
      if (attempt !== null && turn !== null) fold.turns.add(`${attempt}:${turn}`)
      break
    }
    case "tools": {
      const turn = positiveInt(payload.turn)
      if (attempt !== null && turn !== null)
        fold.tools.set(`${attempt}:${turn}`, count(payload.admitted))
      break
    }
    case "staged":
      fold.patchFiles = count(payload.files)
      break
    case "delivered":
      fold.patchFiles = count(payload.files)
      fold.delivery = text(payload.delivery)
      fold.pending.clear()
      break
    case "approval_resolved": {
      const id = text(payload.approval_id)
      if (id) fold.pending.delete(id)
      break
    }
  }
}

function delegateTimelineOf(fold: DelegateFold): DelegateTimeline {
  const kinds = [...fold.kinds.values()]
  const pending = [...fold.pending.values()].at(-1)
  return {
    subtasks: { planned: fold.planned, completed: fold.done.size },
    attempts: fold.kinds.size,
    repairs: kinds.filter((kind) => kind === "repair").length,
    takeovers: kinds.filter((kind) => kind === "takeover").length,
    workerTurns: fold.turns.size,
    toolOperations: [...fold.tools.values()].reduce((sum, n) => sum + n, 0),
    sandboxTier: fold.tier,
    patchFiles: fold.patchFiles,
    delivery: fold.delivery,
    approvals: {
      requested: fold.digests.size,
      pending: pending ? { kind: pending } : null,
    },
  }
}

export function runTimelineOf(events: readonly TimelineEvent[]): RunTimeline {
  const timeline = emptyRunTimeline()
  const delegate: DelegateFold = {
    seen: false,
    kinds: new Map(),
    planned: null,
    done: new Set(),
    turns: new Set(),
    tools: new Map(),
    tier: null,
    patchFiles: null,
    delivery: null,
    digests: new Set(),
    pending: new Map(),
  }
  for (const event of events) {
    const payload = event.payload ?? {}
    switch (event.type) {
      case "phase.changed": {
        // The ledger's own status transitions carry `from`/`to`, not a phase.
        const phase = text(payload.phase)
        if (!phase) break
        const step = text(payload.step)
        if (phase === "delegate") foldDelegatePhase(delegate, step, payload)
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
        const tier = text(payload.tier)
        if (tier) delegate.tier = tier
        break
      }
      case "approval.required": {
        delegate.seen = true
        const digest = text(payload.request_digest)
        const id = text(payload.approval_id)
        if (digest) delegate.digests.add(digest)
        if (id) {
          delegate.pending.delete(id)
          delegate.pending.set(id, text(payload.kind) ?? "unknown")
        }
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
  if (delegate.seen) timeline.delegate = delegateTimelineOf(delegate)
  return timeline
}
