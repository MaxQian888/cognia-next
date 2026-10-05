/**
 * Transport-agnostic peer for Pi's native RPC mode (`pi --mode rpc`).
 *
 * Deliberately NOT built on {@link JsonRpcPeer}: Pi does not speak JSON-RPC.
 * Its frames are bare command objects (`{type, id, …}`) answered by
 * `{type: "response", command, success, data | error}`, and unsolicited events
 * are `{type: "<event_name>", …}`. The shape overlaps just enough that reusing
 * the JSON-RPC peer would appear to work while silently mis-routing every
 * event, so the correlation core is reimplemented here instead.
 *
 * Three behaviours were established by running Pi 0.84.1, not read from docs,
 * because each one defeats an obvious implementation (see ADR-0119):
 *
 *   1. Responses are NOT FIFO — an `abort` reply can land after the reply to a
 *      later `get_state`. Correlation is by `id` only; ordering means nothing.
 *   2. A malformed *inbound* frame does not kill Pi. It answers with
 *      `{type: "response", command: "parse", success: false}` carrying **no
 *      `id`**. A peer that assumes every response is correlatable leaks the
 *      pending request forever, so orphan responses are routed separately.
 *   3. Pi emits events (e.g. `thinking_level_changed`) interleaved with
 *      responses, including *before* the response to the command that caused
 *      them. Neither stream may block the other.
 *
 * Framing lives in {@link PiFrameDecoder} and is byte-level on purpose — see
 * its doc comment.
 */

import {
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_MAX_FRAME_BYTES,
  FrameError,
  LfFrameDecoder,
} from "@cognia/agent-runtime-kit/lf-frame-decoder"

/** Frames larger than this abort the session rather than buffer unboundedly. */
export const PI_MAX_FRAME_BYTES = DEFAULT_MAX_FRAME_BYTES
/** Ceiling on an *incomplete* frame — i.e. bytes held with no `\n` yet seen. */
export const PI_MAX_BUFFER_BYTES = DEFAULT_MAX_BUFFER_BYTES

/** A violation of the Pi wire contract. Terminal: the stream cannot resynchronise. */
export class PiFrameError extends FrameError {
  constructor(message: string) {
    super(message)
    this.name = "PiFrameError"
  }
}

/**
 * Pi's strict LF-only JSONL decoder: the shared byte-level
 * {@link LfFrameDecoder} with Pi's limits and error type.
 */
export class PiFrameDecoder extends LfFrameDecoder {
  constructor(
    maxFrameBytes: number = PI_MAX_FRAME_BYTES,
    maxBufferBytes: number = PI_MAX_BUFFER_BYTES
  ) {
    super({
      label: "Pi RPC",
      maxFrameBytes,
      maxBufferBytes,
      createError: (message) => new PiFrameError(message),
    })
  }
}

/**
 * Is this text a whole frame that merely lost its terminator?
 *
 * Parse is the only honest test. A length check cannot tell a complete 63k
 * frame from a truncated one, and a bracket count cannot either once a string
 * payload contains braces.
 */
export function isCompleteFrame(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).type === "string"
    )
  } catch {
    return false
  }
}

/**
 * Enough of a broken frame to recognise it, and no more.
 *
 * A truncated frame is the only evidence of what the agent was in the middle
 * of saying, so an error that quotes none of it leaves nothing to act on. It
 * is also agent output, which can be long and can carry anything, so this
 * takes the head and says how much it left behind.
 */
export function frameHint(residue: string, limit = 160): string {
  const head = residue.slice(0, limit).replace(/\s+/gu, " ").trim()
  return residue.length > limit ? `${head}…` : head
}

// ============================================================================
// Peer
// ============================================================================

/** An inbound frame that is a reply to one of our commands. */
export interface PiResponseFrame {
  type: "response"
  /** Echo of the command this answers. `"parse"` for a malformed-input reply. */
  command: string
  success: boolean
  id?: string
  data?: unknown
  error?: string
}

/** An inbound frame that is not a reply — `message_update`, `agent_settled`, … */
export interface PiEventFrame {
  type: string
  [key: string]: unknown
}

export interface PiRpcPeerOptions {
  /** Write one already-serialized frame (the peer appends the newline). */
  writeRaw: (frame: string) => Promise<void> | void
  /** An unsolicited event frame. */
  onEvent?: (event: PiEventFrame) => void
  /**
   * A response that could not be correlated. In practice this is Pi rejecting
   * something we wrote (`command: "parse"`), which carries no `id` — a real
   * protocol fault worth surfacing, but never a reason to fail a pending
   * request that is still legitimately in flight.
   */
  onOrphanResponse?: (response: PiResponseFrame) => void
  /**
   * A frame that is not JSON, or not an object with a string `type`. Terminal
   * by contract: unlike ACP, Pi emits nothing but protocol frames on stdout,
   * so noise means the stream is no longer trustworthy.
   */
  onProtocolError?: (error: PiFrameError) => void
  /** Default per-command timeout in ms. Control commands are fast. */
  defaultTimeout?: number
}

interface PendingCommand {
  command: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export class PiRpcPeer {
  private commandSeq = 0
  private readonly pending = new Map<string, PendingCommand>()
  private readonly decoder = new PiFrameDecoder()
  private readonly defaultTimeout: number
  private closed = false

  constructor(private readonly opts: PiRpcPeerOptions) {
    this.defaultTimeout = opts.defaultTimeout ?? 10000
  }

  /** In-flight command count. Exposed so the adapter can assert quiescence. */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * Write one frame with NO correlation id and no reply expectation.
   *
   * `extension_ui_response` is the case this exists for. Verified against Pi
   * 0.84.1's `dist/modes/rpc/rpc-mode.js`:
   *
   * ```js
   * if (parsed.type === "extension_ui_response") {
   *   const pending = pendingExtensionRequests.get(response.id)
   *   if (pending) { pendingExtensionRequests.delete(response.id); pending.resolve(response) }
   *   return   // no response frame is ever written back
   * }
   * ```
   *
   * Two consequences make `sendCommand` actively wrong here. Its frame is
   * `{...params, type, id}`, so the correlation id OVERWRITES the dialog id and
   * `pendingExtensionRequests.get()` misses — the extension is never resolved
   * and stays blocked. And since Pi returns without replying, the caller then
   * waits out the full command timeout before failing.
   */
  sendFrame(frame: Record<string, unknown>): Promise<void> | void {
    if (this.closed) return
    // No trailing newline, exactly like `sendCommand`: the transport owns
    // framing. The Rust host appends `\n` unconditionally, so adding one here
    // would emit a stray blank line.
    return this.opts.writeRaw(JSON.stringify(frame))
  }

  /**
   * Send a command and resolve with its `data`.
   *
   * Rejects on timeout, transport failure, or `success: false`. Note that a
   * resolved promise means Pi *accepted* the command — for `prompt` that is
   * explicitly not completion, which only `agent_settled` signals.
   */
  sendCommand<T = unknown>(
    type: string,
    params: Record<string, unknown> = {},
    timeout: number = this.defaultTimeout
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`Pi RPC peer is closed (command: ${type})`))
    }

    const id = `cognia-${++this.commandSeq}`
    const frame = JSON.stringify({ ...params, type, id })

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi RPC command timed out: ${type}`))
      }, timeout)

      this.pending.set(id, {
        command: type,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: timeoutId,
      })

      const abandon = (error: unknown) => {
        clearTimeout(timeoutId)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      // `writeRaw` can fail either synchronously (a closed stdin throws on the
      // spot) or asynchronously. Only catching the rejection would leak the
      // pending entry and its timer on the synchronous path.
      let written: Promise<void> | void
      try {
        written = this.opts.writeRaw(frame)
      } catch (error) {
        abandon(error)
        return
      }
      Promise.resolve(written).catch(abandon)
    })
  }

  /**
   * Feed raw transport bytes into the peer.
   *
   * Never throws: a framing violation is reported through `onProtocolError`
   * so the caller can tear the session down on its own terms rather than
   * unwinding a stdout event handler.
   */
  ingest(chunk: Uint8Array | string): void {
    if (this.closed) return

    let frames: string[]
    try {
      frames = this.decoder.push(chunk)
    } catch (error) {
      this.fail(error instanceof PiFrameError ? error : new PiFrameError(String(error)))
      return
    }

    for (const frame of frames) {
      if (this.closed) return
      this.route(frame)
    }
  }

  /**
   * Report end-of-stream.
   *
   * Whatever is left in the decoder is a frame that never got its newline, and
   * there are two very different reasons for that. The process died halfway
   * through writing, which is a protocol error worth reporting. Or the process
   * finished the frame and exited without a trailing newline, which is what a
   * lot of programs do on their last line and is not an error at all.
   *
   * Telling them apart is a `JSON.parse`. Reporting the truncation without
   * trying threw away complete final frames and, because the report is
   * terminal, failed the whole turn over the last message of it: a 63k-char
   * reply was discarded and the user was told the stream "ended mid-frame",
   * which described the newline and not one word of what they had lost.
   */
  endOfStream(): void {
    if (this.closed) return
    let residue: string | null = null
    try {
      residue = this.decoder.flushResidue()
    } catch {
      // An over-limit residue is already a lost cause; the report below is the
      // signal that matters.
    }
    if (residue === null || residue.trim() === "") return
    if (isCompleteFrame(residue)) {
      // A whole frame, delivered exactly as if the newline had arrived.
      this.route(residue)
      return
    }
    this.opts.onProtocolError?.(
      new PiFrameError(
        `Pi RPC stream ended mid-frame (${residue.length} chars discarded): ${frameHint(residue)}`
      )
    )
  }

  /** Reject every in-flight command. Call on disconnect so callers don't hang. */
  rejectAll(reason: string): void {
    const inFlight = [...this.pending.values()]
    this.pending.clear()
    for (const p of inFlight) {
      clearTimeout(p.timeout)
      p.reject(new Error(`${reason} (command: ${p.command})`))
    }
  }

  /** Idempotent. After this the peer accepts no further traffic in either direction. */
  close(reason = "Pi RPC peer closed"): void {
    if (this.closed) return
    this.closed = true
    this.rejectAll(reason)
    this.decoder.reset()
  }

  private route(frame: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(frame)
    } catch {
      this.fail(new PiFrameError(`Pi RPC emitted a non-JSON frame (${frame.length} chars)`))
      return
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.fail(new PiFrameError("Pi RPC frame was not a JSON object"))
      return
    }

    const record = parsed as Record<string, unknown>
    if (typeof record.type !== "string") {
      this.fail(new PiFrameError("Pi RPC frame is missing a string `type`"))
      return
    }

    if (record.type === "response") {
      this.handleResponse(record as unknown as PiResponseFrame)
      return
    }

    this.opts.onEvent?.(record as PiEventFrame)
  }

  private handleResponse(response: PiResponseFrame): void {
    const id = typeof response.id === "string" ? response.id : undefined
    const pending = id ? this.pending.get(id) : undefined

    if (!pending) {
      // Either Pi rejecting our input (no id), or a reply to a command we
      // already timed out. Both are informational — never touch `pending`.
      this.opts.onOrphanResponse?.(response)
      return
    }

    clearTimeout(pending.timeout)
    this.pending.delete(id!)

    if (response.success) {
      pending.resolve(response.data)
    } else {
      const detail = response.error ?? "unknown error"
      pending.reject(new Error(`Pi RPC command failed: ${pending.command}: ${detail}`))
    }
  }

  /** A framing/protocol fault is terminal: report it, then close. */
  private fail(error: PiFrameError): void {
    this.opts.onProtocolError?.(error)
    this.close(error.message)
  }
}
