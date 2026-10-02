/**
 * Phase-scoped reading of signaling frames.
 *
 * The transport buffers every frame in arrival order, so a frame that arrives
 * before its phase starts is never lost (listeners are effectively registered
 * before each send). Each phase states exactly which frame it accepts — by
 * kind, room, sender session and nonce — and drops anything else as stale, so
 * a later phase can never be satisfied by an earlier phase's leftover.
 */

import type { ReasonCode } from "../../../../../lib/status/contract"

import { DeadlineError, ProbeAbortedError, withDeadline } from "./deadline"
import { ProbeTransportError, type ProbeSocket } from "./types"

/** A phase failed with a bounded, publishable reason. */
export class ProbePhaseError extends Error {
  constructor(readonly reason: ReasonCode) {
    super(reason)
    this.name = "ProbePhaseError"
  }
}

/** The server frames the probe reads (mirror of `ServerFrame` in proto.rs). */
export type ServerFrame = { kind: string; [key: string]: unknown }

export interface ExpectOptions {
  /** Absolute time (per `now`) by which the frame must arrive. */
  deadlineAt: number
  /** Reason recorded when the deadline passes first. */
  timeoutReason: ReasonCode
  /** Reason recorded when the relay answers with an `error` frame. */
  errorReason: ReasonCode
}

/**
 * Decide whether `frame` is the one a phase waits for. Return a value to
 * accept it, `undefined` to drop it as unrelated/stale, or throw a
 * `ProbePhaseError` when it is the right frame with the wrong content.
 */
export type FrameMatcher<T> = (frame: ServerFrame) => T | undefined

export class FrameChannel {
  /** Frames dropped because no phase wanted them (diagnostics/tests). */
  dropped = 0

  constructor(
    readonly socket: ProbeSocket,
    private readonly now: () => number,
    private readonly signal: AbortSignal
  ) {}

  /** Send one JSON frame; a socket that already closed fails the phase. */
  send(frame: Record<string, unknown>): void {
    const text = JSON.stringify(frame)
    try {
      this.socket.send(text)
    } catch (error) {
      if (this.signal.aborted) throw new ProbeAbortedError()
      if (error instanceof ProbeTransportError) throw new ProbePhaseError("ws_closed")
      throw error
    }
  }

  async expect<T>(match: FrameMatcher<T>, opts: ExpectOptions): Promise<T> {
    for (;;) {
      const remaining = opts.deadlineAt - this.now()
      if (remaining <= 0) throw new ProbePhaseError(opts.timeoutReason)
      let text: string
      try {
        // A small grace lets a well-behaved adapter report its own timeout
        // first; the local timer is the backstop for one that never does.
        text = await withDeadline(this.socket.next(remaining), remaining + 50, this.signal)
      } catch (error) {
        throw this.classify(error, opts.timeoutReason)
      }
      const frame = parseFrame(text)
      if (!frame) {
        this.dropped += 1
        continue
      }
      if (frame.kind === "error") throw new ProbePhaseError(opts.errorReason)
      const value = match(frame)
      if (value !== undefined) return value
      this.dropped += 1
    }
  }

  private classify(error: unknown, timeoutReason: ReasonCode): Error {
    if (this.signal.aborted || error instanceof ProbeAbortedError) return new ProbeAbortedError()
    if (error instanceof DeadlineError) return new ProbePhaseError(timeoutReason)
    if (error instanceof ProbeTransportError) {
      if (error.reason === "timeout") return new ProbePhaseError(timeoutReason)
      return new ProbePhaseError("ws_closed")
    }
    return error instanceof Error ? error : new Error(String(error))
  }
}

function parseFrame(text: string): ServerFrame | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const kind = (value as { kind?: unknown }).kind
  return typeof kind === "string" ? (value as ServerFrame) : null
}

/** Narrow an unknown nested value to a plain object, or undefined. */
export function objectAt(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
