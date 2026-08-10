// Canonical envelope log (ADR-0090 Phase 8).
//
// The canonical run log IS the AgentEventEnvelope stream, persisted on the
// EXISTING durable workflow event-log (no new event store): each envelope
// rides a `run_log` row whose payload carries the additive discriminator
// `kind: "agent_envelope"`. `run_log` rows are already dropped by the
// semantic-journal mapper, so envelope frames never pollute the run timeline.
// Appends are idempotent on the full envelope identity (crash/replay safe), and the
// header projection derives the session-level view without a second store.

import {
  isAgentEventEnvelope,
  type AgentEventEnvelope,
} from "@cognia/agent-config-types/agent-execution"
import { appendEvents, listRunEvents } from "@/lib/workflow/runtime/event-log"

const ENVELOPE_KIND = "agent_envelope"

export class CanonicalLogCorruptionError extends Error {
  constructor(runId: string) {
    super(`canonical agent envelope log is corrupt for run ${runId}`)
    this.name = "CanonicalLogCorruptionError"
  }
}

interface EnvelopePayload {
  kind: typeof ENVELOPE_KIND
  envelope: AgentEventEnvelope
}

function isEnvelopePayload(payload: unknown): payload is EnvelopePayload {
  return (
    !!payload &&
    typeof payload === "object" &&
    (payload as { kind?: string }).kind === ENVELOPE_KIND &&
    isAgentEventEnvelope((payload as { envelope?: unknown }).envelope)
  )
}

/** Per-run cache of already-persisted envelope identities (idempotency without rescans). */
const seenByRun = new Map<string, Set<string>>()
/** Serialize appends per run so concurrent snapshot effects cannot race dedupe. */
const appendTailByRun = new Map<string, Promise<unknown>>()

function outsideCurrentDexieTransaction<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      void operation().then(resolve, reject)
    }, 0)
  })
}

/** Test-only: drop the idempotency cache so suites start cold. */
export function __resetCanonicalLogForTesting(): void {
  seenByRun.clear()
  appendTailByRun.clear()
}

function envelopeIdentityKey(envelope: AgentEventEnvelope): string {
  return `${envelope.sessionId}\u001f${envelope.turnId}\u001f${envelope.attemptId}\u001f${envelope.sequence}`
}

function attemptSequenceKey(envelope: AgentEventEnvelope): string {
  return `${envelope.sessionId}:${envelope.turnId}:${envelope.attemptId}`
}

async function seenEnvelopeKeys(runId: string): Promise<Set<string>> {
  let seen = seenByRun.get(runId)
  if (!seen) {
    seen = new Set(
      (await listRunEvents(runId))
        .map((row) => row.payload)
        .filter(isEnvelopePayload)
        .map((payload) => envelopeIdentityKey(payload.envelope))
    )
    seenByRun.set(runId, seen)
  }
  return seen
}

/**
 * Append envelopes to the run's canonical log, skipping any whose full
 * session/turn/attempt/sequence identity is already persisted. Using the full
 * identity keeps old schema-v1 logs readable even when their legacy eventId
 * omitted turnId. Returns the count actually
 * written.
 */
export async function appendCanonicalEnvelopes(
  runId: string,
  envelopes: readonly AgentEventEnvelope[]
): Promise<number> {
  const previous = appendTailByRun.get(runId) ?? Promise.resolve()
  const pending = previous
    .catch(() => undefined)
    .then(() =>
      outsideCurrentDexieTransaction(async () => {
        const seen = await seenEnvelopeKeys(runId)
        const pendingKeys = new Set<string>()
        const fresh = envelopes.filter((envelope) => {
          const key = envelopeIdentityKey(envelope)
          if (seen.has(key) || pendingKeys.has(key)) return false
          pendingKeys.add(key)
          return true
        })
        if (fresh.length === 0) return 0
        await appendEvents(
          fresh.map((envelope) => ({
            runId,
            type: "run_log" as const,
            payload: { kind: ENVELOPE_KIND, envelope } satisfies EnvelopePayload,
          }))
        )
        for (const envelope of fresh) seen.add(envelopeIdentityKey(envelope))
        return fresh.length
      })
    )
  appendTailByRun.set(runId, pending)
  try {
    return await pending
  } finally {
    if (appendTailByRun.get(runId) === pending) appendTailByRun.delete(runId)
  }
}

/** Read the run's canonical envelope stream in persisted (ts) order. */
export async function readCanonicalEnvelopes(runId: string): Promise<AgentEventEnvelope[]> {
  const rows = await listRunEvents(runId)
  const corrupt = rows.some(
    (row) =>
      !!row.payload &&
      typeof row.payload === "object" &&
      (row.payload as { kind?: unknown }).kind === ENVELOPE_KIND &&
      !isEnvelopePayload(row.payload)
  )
  if (corrupt) throw new CanonicalLogCorruptionError(runId)
  return rows
    .map((row) => row.payload)
    .filter(isEnvelopePayload)
    .map((payload) => payload.envelope)
}

/**
 * Fold an envelope stream into a recovery CANDIDATE (ADR-0090 Phase 8).
 * Each distinct `turnId` becomes one assistant turn (text deltas
 * concatenated, tool calls collected). A tool call with NO matching result
 * marks the candidate side-effect-ambiguous — the planner then refuses
 * automatic recovery for it (replaying could double-fire the effect).
 */
export function candidateFromEnvelopes(
  envelopes: readonly AgentEventEnvelope[]
): import("./recovery-planner").RecoveryCandidate | undefined {
  if (envelopes.length === 0) return undefined
  const order: string[] = []
  const byTurn = new Map<
    string,
    { text: string; toolCalls: { callId: string; toolName: string; resolved: boolean }[] }
  >()
  for (const envelope of envelopes) {
    let turn = byTurn.get(envelope.turnId)
    if (!turn) {
      turn = { text: "", toolCalls: [] }
      byTurn.set(envelope.turnId, turn)
      order.push(envelope.turnId)
    }
    const event = envelope.event as { kind?: string } & Record<string, unknown>
    if (event.kind === "text-delta" && typeof event.delta === "string") {
      turn.text += event.delta
    } else if (event.kind === "tool-call") {
      turn.toolCalls.push({
        callId: (event.toolCallId as string) ?? `call-${turn.toolCalls.length}`,
        toolName: (event.toolName as string) ?? "tool",
        resolved: false,
      })
    } else if (event.kind === "tool-result") {
      const match = turn.toolCalls.find(
        (call) =>
          !call.resolved && (event.toolCallId === undefined || call.callId === event.toolCallId)
      )
      if (match) match.resolved = true
    }
  }
  let ambiguous = false
  const turns = order.map((turnId) => {
    const turn = byTurn.get(turnId)!
    if (turn.toolCalls.some((call) => !call.resolved)) ambiguous = true
    return {
      turnId,
      role: "assistant" as const,
      text: turn.text,
      ...(turn.toolCalls.length > 0
        ? { toolCalls: turn.toolCalls.map(({ callId, toolName }) => ({ callId, toolName })) }
        : {}),
    }
  })
  return {
    id: `canonical-log:${envelopes[0].runId}`,
    kind: "canonical-log",
    fidelity: "structured",
    turns,
    ...(ambiguous ? { hasAmbiguousSideEffects: true } : {}),
  }
}

export interface CanonicalLogHeader {
  runId: string
  sessionId?: string
  eventCount: number
  /** Highest per session/turn/attempt sequence numbers (gap detection input). */
  lastSequenceByAttempt: Record<string, number>
  firstTimestamp?: string
  lastTimestamp?: string
}

/** Project the session-level header from an envelope stream. */
export function projectCanonicalHeader(
  runId: string,
  envelopes: readonly AgentEventEnvelope[]
): CanonicalLogHeader {
  const lastSequenceByAttempt: Record<string, number> = {}
  for (const envelope of envelopes) {
    const key = attemptSequenceKey(envelope)
    const prev = lastSequenceByAttempt[key] ?? -1
    if (envelope.sequence > prev) lastSequenceByAttempt[key] = envelope.sequence
  }
  return {
    runId,
    ...(envelopes[0]?.sessionId ? { sessionId: envelopes[0].sessionId } : {}),
    eventCount: envelopes.length,
    lastSequenceByAttempt,
    ...(envelopes[0]?.timestamp ? { firstTimestamp: envelopes[0].timestamp } : {}),
    ...(envelopes.at(-1)?.timestamp ? { lastTimestamp: envelopes.at(-1)!.timestamp } : {}),
  }
}
