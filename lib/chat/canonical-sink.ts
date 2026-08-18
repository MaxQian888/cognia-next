/**
 * Chat canonical envelope sink — the stateful half of the chat event log.
 *
 * Owns, per live chat session: the run identity, the envelope sequencer, the
 * `toolCallId → toolName` correlation the SDK's result blocks omit, and a write
 * buffer. `lib/chat/canonical-projection.ts` owns the pure mapping.
 *
 * Writes are BATCHED. `appendCanonicalEnvelopes` is one Dexie transaction per
 * call; issuing one per streamed event would put a transaction on the hot path
 * of every token. Events accumulate and flush on a short debounce, on a size
 * threshold, and unconditionally when the turn closes — so a turn that ends
 * (or crashes the renderer between flushes) loses at most one window rather
 * than the whole log.
 */

import type {
  AgentEventEnvelope,
  CanonicalAgentEvent,
} from "@cognia/agent-config-types/agent-execution"
import type { SDKMessage } from "@cognia/agent-config-types"

import { appendCanonicalEnvelopes } from "@/lib/ai/agent/recovery/canonical-log"
import {
  createEnvelopeSequencer,
  redactAgentEventEnvelope,
} from "@/lib/ai/agent/execution/event-envelope"
import { isTraceDebugArmed } from "@/lib/observability/debug-session"
import {
  canonicalEventsFromSdkMessage,
  filterChatCanonicalEvents,
  type ChatCanonicalCaptureTiers,
} from "./canonical-projection"

/** Debounce window for the batched append. Long enough to coalesce a burst of
 * tool events, short enough that a crash loses almost nothing. */
const FLUSH_DEBOUNCE_MS = 400

/** Flush immediately once this many envelopes are queued, regardless of the timer. */
const FLUSH_MAX_PENDING = 64

/** Cap on remembered tool names per turn — bounds a runaway tool loop. */
const MAX_TRACKED_TOOL_CALLS = 500

/** Redacted prompt/preview text is truncated to this before it is persisted. */
const MAX_TEXT_CHARS = 2_000

export interface OpenChatCanonicalLogInput {
  sessionId: string
  /** The direct-chat execution run id — the join key shared with spans and usage rows. */
  runId: string
  /** Defaults to the run id: one direct-chat run is exactly one turn. */
  turnId?: string
  attemptId?: string
  hostRef?: string
  runtime?: string
  /** Prompt text. Persisted only when the `prompts` debug tier is armed. */
  prompt?: string
}

interface ActiveChatLog {
  sessionId: string
  runId: string
  envelope: (event: CanonicalAgentEvent) => AgentEventEnvelope
  toolNamesByCallId: Map<string, string>
  pending: AgentEventEnvelope[]
  timer: ReturnType<typeof setTimeout> | null
  /** Chained so two flushes can never interleave their appends for one run. */
  flushing: Promise<unknown>
  closed: boolean
}

const activeLogs = new Map<string, ActiveChatLog>()

/** Resolve the armed capture tiers for one session. */
function tiersFor(sessionId: string): ChatCanonicalCaptureTiers {
  return {
    deltas: isTraceDebugArmed("deltas", sessionId),
    prompts: isTraceDebugArmed("prompts", sessionId),
    toolDetails: isTraceDebugArmed("toolDetails", sessionId),
  }
}

/**
 * Open the canonical log for one chat turn.
 *
 * Idempotent per `(sessionId, runId)` — the retry / routing-fallback rails
 * re-enter the same turn, and reopening would restart the sequence and orphan
 * everything already written.
 */
export function openChatCanonicalLog(input: OpenChatCanonicalLogInput): void {
  const existing = activeLogs.get(input.sessionId)
  if (existing && existing.runId === input.runId && !existing.closed) return
  // A previous turn on this session that never closed: seal it rather than
  // dropping its buffered events on the floor.
  if (existing) void closeChatCanonicalLog(input.sessionId, "interrupted")

  const turnId = input.turnId ?? input.runId
  const log: ActiveChatLog = {
    sessionId: input.sessionId,
    runId: input.runId,
    envelope: createEnvelopeSequencer({
      sessionId: input.sessionId,
      runId: input.runId,
      turnId,
      attemptId: input.attemptId ?? `${input.runId}:1`,
      hostRef: input.hostRef ?? "local-desktop",
      runtime: input.runtime ?? "claude-agent-sdk",
    }),
    toolNamesByCallId: new Map(),
    pending: [],
    timer: null,
    flushing: Promise.resolve(),
    closed: false,
  }
  activeLogs.set(input.sessionId, log)

  const events: CanonicalAgentEvent[] = [{ kind: "lifecycle", phase: "started" }]
  if (input.prompt) {
    events.push({ kind: "user-input", text: input.prompt.slice(0, MAX_TEXT_CHARS) })
  }
  enqueue(log, events)
}

/** Project and record one SDK frame. No-op when the session has no open log. */
export function recordChatSdkMessage(sessionId: string, message: SDKMessage): void {
  const log = activeLogs.get(sessionId)
  if (!log || log.closed) return
  let events: CanonicalAgentEvent[]
  try {
    events = canonicalEventsFromSdkMessage(message, tiersFor(sessionId))
  } catch {
    // A malformed frame must not break the turn it belongs to.
    return
  }
  enqueue(
    log,
    events.map((event) => correlateToolNames(log, event))
  )
}

/**
 * Record events the SDK stream does not carry — permission decisions, retries,
 * routing failures — which reach the chat hook on their own channels.
 */
export function recordChatCanonicalEvents(
  sessionId: string,
  events: readonly CanonicalAgentEvent[]
): void {
  const log = activeLogs.get(sessionId)
  if (!log || log.closed || events.length === 0) return
  enqueue(log, [...events])
}

/**
 * Seal the turn: emit `lifecycle` and flush everything still buffered.
 *
 * Awaited by callers that need the log durable before they report the turn
 * finished; safe to fire-and-forget otherwise.
 */
export async function closeChatCanonicalLog(
  sessionId: string,
  outcome: "ended" | "interrupted" = "ended"
): Promise<void> {
  const log = activeLogs.get(sessionId)
  if (!log || log.closed) return
  log.closed = true
  activeLogs.delete(sessionId)
  enqueue(log, [{ kind: "lifecycle", phase: outcome }])
  await flush(log)
}

/** The run id the session is currently logging to, if any. */
export function chatCanonicalRunId(sessionId: string): string | undefined {
  return activeLogs.get(sessionId)?.runId
}

/**
 * The SDK's `tool_result` block names only the call id, so a result read back
 * from the log would say `unknown`. Fill the name in from the call we already
 * saw, and remember calls as they go by.
 */
function correlateToolNames(log: ActiveChatLog, event: CanonicalAgentEvent): CanonicalAgentEvent {
  if (event.kind === "tool-call" && event.toolCallId) {
    if (log.toolNamesByCallId.size >= MAX_TRACKED_TOOL_CALLS) {
      const oldest = log.toolNamesByCallId.keys().next()
      if (!oldest.done) log.toolNamesByCallId.delete(oldest.value)
    }
    log.toolNamesByCallId.set(event.toolCallId, event.toolName)
    return event
  }
  if (event.kind === "tool-result" && event.toolCallId && event.toolName === "unknown") {
    const known = log.toolNamesByCallId.get(event.toolCallId)
    if (known) return { ...event, toolName: known }
  }
  return event
}

function enqueue(log: ActiveChatLog, events: readonly CanonicalAgentEvent[]): void {
  if (events.length === 0) return
  const tiers = tiersFor(log.sessionId)
  for (const event of filterChatCanonicalEvents(events, tiers)) {
    // Redaction happens at the envelope boundary, once, for every path into the
    // log — a caller cannot forget it.
    log.pending.push(redactAgentEventEnvelope(log.envelope(event)))
  }
  if (log.pending.length === 0) return
  if (log.pending.length >= FLUSH_MAX_PENDING) {
    void flush(log)
    return
  }
  if (log.timer === null) {
    log.timer = setTimeout(() => {
      log.timer = null
      void flush(log)
    }, FLUSH_DEBOUNCE_MS)
  }
}

function flush(log: ActiveChatLog): Promise<unknown> {
  if (log.timer !== null) {
    clearTimeout(log.timer)
    log.timer = null
  }
  const batch = log.pending
  if (batch.length === 0) return log.flushing
  log.pending = []
  // Chain rather than race: `appendCanonicalEnvelopes` serializes per run
  // internally, but chaining here also preserves the order two flushes were
  // enqueued in, which the sequence numbers assume.
  log.flushing = log.flushing
    .catch(() => undefined)
    .then(() =>
      appendCanonicalEnvelopes(log.runId, batch).catch((error) => {
        console.warn("chat canonical journal append failed", error)
      })
    )
  return log.flushing
}

/** Test-only: drop every open log without writing. */
export function __resetChatCanonicalSinkForTesting(): void {
  for (const log of activeLogs.values()) {
    if (log.timer !== null) clearTimeout(log.timer)
  }
  activeLogs.clear()
}

/** Test-only: how many envelopes are buffered for a session. */
export function __pendingChatEnvelopeCountForTesting(sessionId: string): number {
  return activeLogs.get(sessionId)?.pending.length ?? 0
}

/** Test-only: force the debounced batch out without closing the turn. */
export function __flushChatCanonicalLogForTesting(sessionId: string): Promise<unknown> {
  const log = activeLogs.get(sessionId)
  return log ? flush(log) : Promise.resolve()
}
