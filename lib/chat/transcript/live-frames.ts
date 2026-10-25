/**
 * Live in-flight replies for a member agent turn (`transcript://live`, P6e).
 *
 * A member's agent runs in their person brain, not in the Host's sidecar, so
 * the sidecar's `claude://message` stream never carries it. The brain already
 * projects the agent's events into the assistant message it persists; it
 * sends the same parts to the member's devices as they change:
 *
 * - A **patch** keeps the first `base` parts of the previous frame and
 *   replaces the rest with `parts`. Projected parts are replaced, not edited,
 *   so a part that did not change is the same object and stays in the prefix.
 * - A **keyframe** (`base` 0) carries the whole message. The first frame of a
 *   reply is one, then one every {@link TRANSCRIPT_LIVE_KEYFRAME_MS}, so a
 *   device that joined late or missed a frame catches up within that.
 * - `settled` is the final keyframe, sent just before the brain writes the
 *   reply for good. Its `afterRevision` is the transcript revision the brain
 *   had persisted before it, so a device keeps drawing the finished reply
 *   until its timeline has read past that revision. `reset` means "stop drawing this reply live": a frame
 *   over {@link TRANSCRIPT_LIVE_FRAME_MAX_BYTES} is never sent, and the
 *   device reads the persisted transcript instead.
 *
 * The Host rebuilds every frame from these keys, refuses one over 256 KiB,
 * delivers it only to the person's own devices and never replays it
 * (`crates/cognia-companion/src/ws_bridge.rs`). A frame is a view of the
 * reply, never its record: the persisted message stays authoritative.
 */

import type { UIMessage } from "ai"

export const TRANSCRIPT_LIVE_TOPIC = "transcript://live"
/** How often the brain sends the changed tail of a live reply. */
export const TRANSCRIPT_LIVE_INTERVAL_MS = 100
/** How often a live reply is resent whole. */
export const TRANSCRIPT_LIVE_KEYFRAME_MS = 2_000
/** The brain's own budget; the Host's hard ceiling is 256 KiB. */
export const TRANSCRIPT_LIVE_FRAME_MAX_BYTES = 200 * 1024
const MAX_ID_LENGTH = 256

export type TranscriptLivePart = UIMessage["parts"][number]
export type TranscriptLiveFrameState = "streaming" | "settled" | "reset"

export interface TranscriptLiveFrame {
  sessionId: string
  /** The assistant message the brain persists for this turn. */
  messageId: string
  /** The member's message the turn answers. */
  replyTo: string
  /** 1 for a reply's first frame, then one more per frame. */
  seq: number
  /** How many parts of the previous frame stay; 0 for a keyframe. */
  base: number
  keyframe: boolean
  state: TranscriptLiveFrameState
  /** The parts from index `base` on. */
  parts: TranscriptLivePart[]
  /** `settled` only: the transcript revision persisted before this frame. */
  afterRevision?: number
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function isCount(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
}

/** The shape the Host admits, checked again where frames arrive. */
export function isTranscriptLiveFrame(value: unknown): value is TranscriptLiveFrame {
  if (!value || typeof value !== "object") return false
  const frame = value as Record<string, unknown>
  if (
    !isId(frame.sessionId) ||
    !isId(frame.messageId) ||
    !isId(frame.replyTo) ||
    !isCount(frame.seq, 1) ||
    !isCount(frame.base, 0) ||
    typeof frame.keyframe !== "boolean" ||
    (frame.state !== "streaming" && frame.state !== "settled" && frame.state !== "reset") ||
    !Array.isArray(frame.parts) ||
    frame.parts.some((part) => !part || typeof part !== "object" || Array.isArray(part))
  )
    return false
  if (frame.keyframe && frame.base !== 0) return false
  if (frame.state === "settled" && !frame.keyframe) return false
  if (frame.state === "reset" && frame.parts.length > 0) return false
  if (
    frame.afterRevision !== undefined &&
    (frame.state !== "settled" || !isCount(frame.afterRevision, 0))
  )
    return false
  return true
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export interface TranscriptLiveEncoderOptions {
  sessionId: string
  messageId: string
  replyTo: string
  now: () => number
  maxBytes?: number
  keyframeMs?: number
}

/**
 * The brain's side: turns successive part arrays of one reply into frames.
 * `next` answers `null` when there is nothing to send.
 */
export function createTranscriptLiveEncoder(options: TranscriptLiveEncoderOptions) {
  const maxBytes = options.maxBytes ?? TRANSCRIPT_LIVE_FRAME_MAX_BYTES
  const keyframeMs = options.keyframeMs ?? TRANSCRIPT_LIVE_KEYFRAME_MS
  let sent: readonly TranscriptLivePart[] | null = null
  let lastKeyframeAt = 0
  let seq = 0
  /** A reply too large to send stays off the wire until a keyframe fits. */
  let suppressed = false

  const frame = (
    state: TranscriptLiveFrameState,
    base: number,
    parts: TranscriptLivePart[],
    keyframe: boolean
  ): TranscriptLiveFrame => ({
    sessionId: options.sessionId,
    messageId: options.messageId,
    replyTo: options.replyTo,
    seq: ++seq,
    base,
    keyframe,
    state,
    parts,
  })

  const reset = (): TranscriptLiveFrame => {
    suppressed = true
    sent = null
    return frame("reset", 0, [], true)
  }

  return {
    next(
      parts: readonly TranscriptLivePart[],
      state: "streaming" | "settled" = "streaming",
      afterRevision?: number
    ): TranscriptLiveFrame | null {
      const now = options.now()
      const keyframeDue = sent === null || now - lastKeyframeAt >= keyframeMs
      if (suppressed && state === "streaming" && now - lastKeyframeAt < keyframeMs) return null
      const keyframe = state === "settled" || suppressed || keyframeDue
      let base = 0
      if (!keyframe && sent) {
        const limit = Math.min(sent.length, parts.length)
        while (base < limit && sent[base] === parts[base]) base += 1
        if (base === parts.length && base === sent.length) return null
      }
      if (keyframe) lastKeyframeAt = now
      const candidate = frame(state, base, parts.slice(base), keyframe)
      if (state === "settled" && afterRevision !== undefined)
        candidate.afterRevision = afterRevision
      if (byteLength(JSON.stringify(candidate)) > maxBytes) {
        seq -= 1
        return suppressed ? null : reset()
      }
      suppressed = false
      sent = parts
      return candidate
    },
    /** End the live reply without content: no parts, or a reply never sent. */
    reset(): TranscriptLiveFrame | null {
      if (seq === 0) return null
      return reset()
    },
  }
}

/** A device's view of one live reply. */
export interface TranscriptLiveTurn {
  sessionId: string
  messageId: string
  replyTo: string
  seq: number
  parts: TranscriptLivePart[]
  state: "streaming" | "settled"
  /** A frame went missing: hold what is drawn until the next keyframe. */
  stale: boolean
  /** Settled: keep drawing until the timeline's revision passes this. */
  afterRevision?: number
}

/** The device's side: fold one frame into the reply it is drawing. */
export function applyTranscriptLiveFrame(
  current: TranscriptLiveTurn | null,
  frame: TranscriptLiveFrame
): TranscriptLiveTurn | null {
  if (frame.state === "reset") {
    return current && current.messageId !== frame.messageId ? current : null
  }
  const state = frame.state === "settled" ? "settled" : "streaming"
  const fresh = (): TranscriptLiveTurn => ({
    sessionId: frame.sessionId,
    messageId: frame.messageId,
    replyTo: frame.replyTo,
    seq: frame.seq,
    parts: frame.parts,
    state,
    stale: false,
    ...(frame.afterRevision !== undefined ? { afterRevision: frame.afterRevision } : {}),
  })
  if (!current || current.messageId !== frame.messageId) {
    // A patch without the keyframe it builds on cannot be drawn.
    return frame.keyframe ? fresh() : current?.state === "settled" ? current : null
  }
  if (frame.seq <= current.seq) return current
  if (frame.keyframe) return fresh()
  if (current.stale) return current
  if (frame.seq !== current.seq + 1 || frame.base > current.parts.length) {
    return { ...current, stale: true }
  }
  return {
    ...current,
    seq: frame.seq,
    parts: [...current.parts.slice(0, frame.base), ...frame.parts],
    state,
  }
}
