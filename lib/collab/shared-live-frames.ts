/**
 * A member's live view of a shared run (ADR-0241): the frames a session's v2
 * stream delivers, after the rules that keep an overlay honest.
 *
 * The codec (`live-frames.ts`) marks a reply stale only on a gap, and the
 * hook (`use-transcript-live-turn.ts`) times out only a settled reply. A
 * crashed executor sends nothing, so on their own a streaming overlay would
 * stay forever. This registry closes those holes with the codec's own `reset`
 * frame, so the reducer and the hook stay as they are:
 *
 * - **Silence (R6).** A streaming reply with no frame for
 *   {@link SHARED_LIVE_SILENCE_MS} is reset.
 * - **Redaction (R2).** A `message.redacted` for the drawn reply resets it at
 *   once, and every later frame for that message is refused.
 * - **Run end (R2-7).** After `run.completed`/`run.failed`, streaming frames
 *   are refused until the next `run.started`. A settled reply stays (the hook
 *   keeps it until the pull reads past it); a reply still streaming then is
 *   the executor's crash, and it is reset once the next pull has applied.
 * - **Ended replies (R2-6).** A reply that settled or was reset never draws
 *   again, so a delayed keyframe cannot revive it.
 * - **Close.** A socket close or a teardown resets the drawn reply.
 *
 * Keyed by the shared (server) session id: frames name it, and the stream
 * that delivers them is opened per shared session.
 */

import type { TranscriptLiveFrame } from "@/lib/chat/transcript/live-frames"

/** Three keyframe periods without a frame: the executor is gone. */
export const SHARED_LIVE_SILENCE_MS = 6_000

type Listener = (frame: TranscriptLiveFrame) => void

interface LiveSession {
  listeners: Set<Listener>
  /** The reply on screen: its last frame. */
  drawn?: TranscriptLiveFrame
  ended: Set<string>
  /** A run ended since the last `run.started`. */
  runEnded: boolean
  silence?: ReturnType<typeof setTimeout>
}

const sessions = new Map<string, LiveSession>()

function sessionOf(sharedSessionId: string): LiveSession {
  let session = sessions.get(sharedSessionId)
  if (!session) {
    session = { listeners: new Set(), ended: new Set(), runEnded: false }
    sessions.set(sharedSessionId, session)
  }
  return session
}

function emit(session: LiveSession, frame: TranscriptLiveFrame): void {
  for (const listener of session.listeners) listener(frame)
}

function clearSilence(session: LiveSession): void {
  if (session.silence !== undefined) clearTimeout(session.silence)
  session.silence = undefined
}

/** End the drawn reply: members fall back to what is stored. */
function resetDrawn(session: LiveSession, messageId?: string): void {
  const drawn = session.drawn
  if (!drawn || (messageId !== undefined && drawn.messageId !== messageId)) return
  clearSilence(session)
  session.ended.add(drawn.messageId)
  session.drawn = undefined
  emit(session, {
    ...drawn,
    seq: drawn.seq + 1,
    base: 0,
    keyframe: true,
    state: "reset",
    parts: [],
  })
}

/** One live frame from the stream. */
export function publishSharedLiveFrame(sharedSessionId: string, frame: TranscriptLiveFrame): void {
  if (frame.sessionId !== sharedSessionId) return
  const session = sessionOf(sharedSessionId)
  if (session.ended.has(frame.messageId)) return
  if (frame.state === "streaming" && session.runEnded) return
  if (frame.state === "streaming") {
    // A reply the executor moved past is over (one live reply at a time).
    if (session.drawn && session.drawn.messageId !== frame.messageId)
      session.ended.add(session.drawn.messageId)
    session.drawn = frame
    clearSilence(session)
    session.silence = setTimeout(() => resetDrawn(session, frame.messageId), SHARED_LIVE_SILENCE_MS)
  } else {
    clearSilence(session)
    session.ended.add(frame.messageId)
    session.drawn = frame.state === "settled" ? frame : undefined
  }
  emit(session, frame)
}

function payloadOf(event: unknown): { kind?: unknown; payload: Record<string, unknown> } {
  if (!event || typeof event !== "object") return { payload: {} }
  const record = event as { kind?: unknown; payload?: unknown }
  return {
    kind: record.kind,
    payload:
      record.payload && typeof record.payload === "object"
        ? (record.payload as Record<string, unknown>)
        : {},
  }
}

/** A stored event the stream announced. Only redaction and run boundaries matter here. */
export function noteSharedLiveEvent(sharedSessionId: string, event: unknown): void {
  const session = sessions.get(sharedSessionId)
  if (!session) return
  const { kind, payload } = payloadOf(event)
  if (kind === "message.redacted" && typeof payload.targetMessageId === "string") {
    session.ended.add(payload.targetMessageId)
    resetDrawn(session, payload.targetMessageId)
  } else if (kind === "run.started") {
    session.runEnded = false
  } else if (kind === "run.completed" || kind === "run.failed") {
    session.runEnded = true
  }
}

/**
 * A pull applied these events, in order. The registry learns run boundaries
 * from them too, not only from the socket: a run that started while the
 * socket was down is announced by the reconnect's pull alone. A reply still
 * streaming after its run ended is then the executor's crash.
 */
export function noteSharedLivePull(sharedSessionId: string, events: readonly unknown[]): void {
  const session = sessions.get(sharedSessionId)
  if (!session) return
  for (const event of events) noteSharedLiveEvent(sharedSessionId, event)
  if (session.runEnded && session.drawn?.state === "streaming") resetDrawn(session)
}

/** The stream closed, or the session is torn down. */
export function endSharedLive(sharedSessionId: string): void {
  const session = sessions.get(sharedSessionId)
  if (!session) return
  if (session.drawn?.state === "streaming") resetDrawn(session)
  else clearSilence(session)
}

export function subscribeSharedLive(sharedSessionId: string, listener: Listener): () => void {
  const session = sessionOf(sharedSessionId)
  session.listeners.add(listener)
  return () => {
    session.listeners.delete(listener)
    if (session.listeners.size === 0 && !session.drawn) {
      clearSilence(session)
      // Keep the ended ids while frames may still arrive; drop an idle entry.
      if (session.ended.size === 0) sessions.delete(sharedSessionId)
    }
  }
}

export function resetSharedLiveForTesting(): void {
  for (const session of sessions.values()) clearSilence(session)
  sessions.clear()
}
