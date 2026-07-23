// Canonical envelope log (ADR-0090 Phase 8).
//
// The canonical run log IS the AgentEventEnvelope stream, persisted on the
// EXISTING durable workflow event-log (no new event store): each envelope
// rides a `run_log` row whose payload carries the additive discriminator
// `kind: "agent_envelope"`. `run_log` rows are already dropped by the
// semantic-journal mapper, so envelope frames never pollute the run timeline.
// Appends are idempotent on `envelope.eventId` (crash/replay safe), and the
// header projection derives the session-level view without a second store.

import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"

import { appendEvents, listRunEvents } from "@/lib/workflow/runtime/event-log"

const ENVELOPE_KIND = "agent_envelope"

interface EnvelopePayload {
  kind: typeof ENVELOPE_KIND
  envelope: AgentEventEnvelope
}

function isEnvelopePayload(payload: unknown): payload is EnvelopePayload {
  return (
    !!payload &&
    typeof payload === "object" &&
    (payload as { kind?: string }).kind === ENVELOPE_KIND &&
    typeof (payload as { envelope?: { eventId?: unknown } }).envelope?.eventId === "string"
  )
}

/** Per-run cache of already-persisted eventIds (idempotency without rescans). */
const seenByRun = new Map<string, Set<string>>()

/** Test-only: drop the idempotency cache so suites start cold. */
export function __resetCanonicalLogForTesting(): void {
  seenByRun.clear()
}

async function seenEventIds(runId: string): Promise<Set<string>> {
  let seen = seenByRun.get(runId)
  if (!seen) {
    seen = new Set(
      (await listRunEvents(runId))
        .map((row) => row.payload)
        .filter(isEnvelopePayload)
        .map((payload) => payload.envelope.eventId)
    )
    seenByRun.set(runId, seen)
  }
  return seen
}

/**
 * Append envelopes to the run's canonical log, skipping any whose `eventId`
 * is already persisted (idempotent replay). Returns the count actually
 * written.
 */
export async function appendCanonicalEnvelopes(
  runId: string,
  envelopes: readonly AgentEventEnvelope[]
): Promise<number> {
  const seen = await seenEventIds(runId)
  const fresh = envelopes.filter((envelope) => !seen.has(envelope.eventId))
  if (fresh.length === 0) return 0
  await appendEvents(
    fresh.map((envelope) => ({
      runId,
      type: "run_log" as const,
      payload: { kind: ENVELOPE_KIND, envelope } satisfies EnvelopePayload,
    }))
  )
  for (const envelope of fresh) seen.add(envelope.eventId)
  return fresh.length
}

/** Read the run's canonical envelope stream in persisted (ts) order. */
export async function readCanonicalEnvelopes(runId: string): Promise<AgentEventEnvelope[]> {
  return (await listRunEvents(runId))
    .map((row) => row.payload)
    .filter(isEnvelopePayload)
    .map((payload) => payload.envelope)
}

export interface CanonicalLogHeader {
  runId: string
  sessionId?: string
  eventCount: number
  /** Highest per-attempt sequence numbers (gap detection input). */
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
    const prev = lastSequenceByAttempt[envelope.attemptId] ?? -1
    if (envelope.sequence > prev) lastSequenceByAttempt[envelope.attemptId] = envelope.sequence
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
