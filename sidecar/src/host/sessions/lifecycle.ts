import type { SendOptions, Prompt } from "../../shared/wire/inbound.ts"
import type { HostSession, Emit, Frame, Log } from "./types.ts"
import { errorMessage } from "../../shared/errors.ts"
import { sendExpectsStructuredOutput } from "../../runtimes/claude-agent-sdk/sdk-options.ts"

// ---- Session lifecycle ----------------------------------------------------

/**
 * Wrap the dispatcher's emitter so session lifecycle events retire the entry
 * from `sessions` without each dispatcher having to know about the map. The
 * deletion policy is the crux of multi-turn context retention, so it lives in
 * one tested place. Exported for the co-located lifecycle test.
 *
 * Also stamps the parent-bound event with the id of the turn this loop is
 * serving (`turnRef.id`). The ref is per-LOOP and is only advanced by
 * `handleSend` for the session object that is still live, so a superseded loop's
 * late events keep carrying their OWN (old) turn id rather than being stamped
 * with the replacement's — which is the whole point: the renderer discards them.
 *
 * @param {(msg: any) => void} emitFn  forward an event to the parent (stdout)
 * @param {Map<string, any>} sessionsMap
 * @param {string} sessionId
 * @param {(() => any) | undefined} getOwner
 * @param {{ id?: string } | undefined} turnRef  mutable per-loop current turn id
 */
export function makeWrappedEmit(
  emitFn: Emit,
  sessionsMap: Map<string, HostSession>,
  sessionId: string,
  getOwner?: () => HostSession | null | undefined,
  turnRef?: { id?: string }
) {
  // Retire the map entry only when it still points at THIS session. After a
  // close-and-restart (see `handleSend` / `restartReason`) the OLD loop can emit
  // a late `session_ended` / `session_closed` for the same id — without this
  // identity check it would evict the freshly-registered replacement and strand
  // the new turn. `getOwner` is wired by `startSession`; when absent (unit
  // tests) or not yet resolved we fall back to the plain id match.
  const ownsEntry = () => {
    if (!getOwner) return true
    const owner = getOwner()
    return owner == null || sessionsMap.get(sessionId!) === owner
  }
  return (msg: Frame) => {
    // `session_closed` is an INTERNAL lifecycle signal from a multi-turn
    // dispatcher (ai-sdk) — its persistent loop has genuinely ended (input
    // closed or fatal error). It never goes on the wire; it just retires the
    // session entry. Intercept before forwarding.
    if (msg && msg.type === "session_closed" && msg.sessionId === sessionId) {
      if (ownsEntry()) sessionsMap.delete(sessionId!)
      return
    }
    // Stamp the turn id this loop is currently serving. Only session-scoped
    // messages carry one — `ready` / `log` go out through the raw `emit`, never
    // this wrapper. A turn-less send (older parent) leaves the field absent, and
    // the renderer treats absence as "can't tell" and keeps the event.
    const turnId = turnRef?.id
    emitFn(turnId && msg && typeof msg === "object" ? { ...msg, turnId } : msg)
    if (msg && msg.type === "session_ended" && msg.sessionId === sessionId) {
      // A multi-turn dispatcher (ai-sdk) keeps ONE live loop across turns and
      // accumulates conversation context in-process. A per-turn `session_ended`
      // must NOT tear it down — doing so dropped history every turn for every
      // non-Anthropic provider (and orphaned the loop). Such sessions are
      // removed only on `session_closed` (above) or an explicit `handleClose`.
      // Single-turn dispatchers (Anthropic, which rebuilds context via SDK
      // `resume`) are still cleaned up on `session_ended`.
      if (ownsEntry() && !sessionsMap.get(sessionId!)?.multiTurn) {
        sessionsMap.delete(sessionId!)
      }
    }
  }
}

/**
 * Build the `createEnvelopeEmitter` arguments for a send, or `null` when this
 * session carries no frozen execution spec.
 *
 * Split out of {@link startSession} so the mapping from send options to emitter
 * configuration is reachable by a test. It is pure, and every field it derives
 * is a defaulting decision that used to be invisible.
 *
 * @param {{ sessionId: string, sendOptions: any, turnRef: { id?: string }, emit: (msg: any) => void }} args
 */
export function envelopeEmitterParams({
  sessionId,
  sendOptions,
  turnRef,
  emit,
}: {
  sessionId: string
  sendOptions?: SendOptions
  turnRef: { id?: string }
  emit: Emit
}) {
  const execution = sendOptions?.execution
  if (!execution) return null
  return {
    sessionId,
    runId: execution.identity?.runId ?? sessionId,
    attemptId: execution.identity?.attemptId ?? "a1",
    parentRunId: execution.identity?.parentRunId,
    hostRef: execution.hostRef ?? "desktop-sidecar",
    runtime: execution.runtimeAdapter,
    turnRef,
    // Read once per loop, unlike `turnRef` which `handleSend` advances: only
    // the Claude rail supports `outputFormat`, and that rail restarts the
    // session on every send (`session_ended` evicts a non-multiTurn session),
    // so this emitter never outlives the options it was built from. A
    // multi-turn rail that later gains structured output would need a ref.
    expectStructuredOutput: sendExpectsStructuredOutput(sendOptions),
    emit,
  }
}

// ---- Inbound command handling --------------------------------------------

/**
 * Decide whether an already-registered session must be torn down and restarted
 * for an incoming `send`, instead of pushing the prompt into the live session.
 * Returns a short reason string (for the log line) or `null` to keep the
 * session and `pushUserMessage`. Exported for the co-located unit test.
 *
 * The crux is symmetry across both dispatch paths — a `send` arriving for a
 * session whose previous turn never cleanly ended (typically a timeout whose
 * best-effort interrupt couldn't break a wedged provider stream) must NOT push
 * the prompt into a stuck session: on the ai-sdk path it would queue behind the
 * dead turn; on the Anthropic path it would push into a query the SDK has
 * already abandoned. Either way the recovery prompt ("continue") would hang and
 * the renderer would just time out again, forever.
 *
 * @param {{ q?: { active?: unknown }, multiTurn?: unknown, sendOptions?: { cwd?: string, provider?: string } }} existing
 * @param {{ cwd?: string, provider?: string } | undefined} options
 * @returns {string | null}
 */
export function restartReason(existing: HostSession, options?: SendOptions) {
  // Working directory changed — the SDK must respawn to pick up the new cwd.
  if (options?.cwd !== undefined && options.cwd !== existing.sendOptions?.cwd) {
    return "cwd changed"
  }
  // Provider changed — the live session is on the WRONG dispatch path
  // (Anthropic single-turn `query()` vs the ai-sdk multi-turn loop), so its `q`
  // can't serve the new provider and an in-place `setModel` doesn't apply.
  // Respawn so the next turn re-dispatches on the new provider's runner. A
  // same-provider MODEL change is NOT a restart trigger — that's handled live
  // via `setModel` (Anthropic `Query.setModel` / the ai-sdk `q.setModel`),
  // which preserves the conversation. Default the provider on both sides so the
  // implicit "anthropic" never reads as a change. `options.provider` is only set
  // on a real `send` (the model picker also closes explicitly on a provider
  // switch); when absent we keep the session.
  if (
    options?.provider !== undefined &&
    (options.provider ?? "anthropic") !== (existing.sendOptions?.provider ?? "anthropic")
  ) {
    return "provider changed"
  }
  // ai-sdk (multi-turn) exposes a live `active` getter on its `q`: when true a
  // turn is genuinely in flight (e.g. a timeout's interrupt could not stop a
  // wedged stream before the renderer reused the session).
  if (typeof existing.q?.active === "boolean" && existing.q.active) {
    return "turn still active"
  }
  // Single-turn (Anthropic) sessions are retired from the map on EVERY
  // `session_ended` (resume rebuilds context next turn). So finding one still
  // registered here means its previous turn never ended — a stuck turn left
  // behind by a timeout. The Anthropic SDK exposes no `active` flag, so its
  // mere lingering presence is the signal. Restart rather than push into it.
  if (existing.multiTurn !== true) {
    return "stale single-turn session"
  }
  return null
}

/**
 * Hand a prompt to a session's LIVE loop, carrying this send's per-turn
 * identity across.
 *
 * A running loop was configured by the send that started it and ignores later
 * options wholesale, so anything that is per-TURN rather than per-session has
 * to be handed over explicitly here: the turn id its events are stamped with,
 * and the Router + Fusion ledger stamp (ADR-0188) — whose ABSENCE matters just
 * as much, since a switched-off surface must leave the next turn unledgered —
 * together with the paired device's execution context of this send, so the
 * turn's reservations are answerable by the device that sent it and, for a
 * turn the host sent itself, by no device at all.
 * Exported for the same reason `routeSteer` and `routeClose` are: the read
 * loop's session map is module-private.
 *
 * @param {{ turnRef?: { id?: string }, setNextTurnLedger?: (ledger: unknown, remoteExecutionContext?: unknown) => void, pushUserMessage: (prompt: unknown) => void }} existing
 * @param {{ turnId?: string, ledger?: unknown } | undefined} options
 * @param {string | unknown[]} prompt
 */
export function routeSendIntoLiveLoop(
  existing: HostSession,
  options: SendOptions | undefined,
  prompt: Prompt
) {
  // Only reached for a session we're pushing into in place; a restarted one
  // got a fresh ref, and the loop it replaced keeps its own.
  if (existing.turnRef) existing.turnRef.id = options?.turnId
  existing.setNextTurnLedger?.(options?.ledger, options?.remoteExecutionContext)
  existing.pushUserMessage!(prompt)
}

// Undo a compaction: restore the pre-compaction message snapshot into the live
// AI-SDK session. Only the generic path exposes `restoreConversation`; the
// Anthropic session self-manages context and has no such hook (no-op there).
// Unknown / already-closed sessions are a no-op — restore must never fault.
// Pure routing extracted for testability; `handleRestore` binds the module map.
export function routeRestore(
  sessionsMap: Map<string, HostSession>,
  msg: { sessionId?: string; messages?: unknown },
  logFn: Log = () => {}
) {
  const { sessionId, messages } = msg
  const s = sessionsMap.get(sessionId!)
  if (!s) {
    logFn("warn", `restore: no session ${sessionId}`)
    return false
  }
  if (typeof s.restoreConversation !== "function") return false
  try {
    return s.restoreConversation(messages) !== false
  } catch (err) {
    logFn("error", `restore failed: ${errorMessage(err)}`)
    return false
  }
}

export function routeClose(
  sessionsMap: Map<string, HostSession>,
  msg: { sessionId?: string; type?: string },
  logFn: Log = () => {}
) {
  const { sessionId } = msg
  const s = sessionsMap.get(sessionId!)
  if (!s) return false
  try {
    s.closeInput!()
    if (typeof s.q?.close === "function") s.q.close()
  } catch (err) {
    logFn("error", `close failed: ${errorMessage(err)}`)
  }
  // Settle any pending tool/approval round-trips so a renderer that never
  // answers can't keep promises (and the agent loop) alive past teardown. The
  // ai-sdk session has no `drainPending` (its `closeInput` aborts the in-flight
  // request); the Anthropic session drains here.
  try {
    s.drainPending?.("session closed")
  } catch (err) {
    logFn("error", `drainPending (close) failed: ${errorMessage(err)}`)
  }
  sessionsMap.delete(sessionId!)
  return true
}
