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

/** Frames larger than this abort the session rather than buffer unboundedly. */
export const PI_MAX_FRAME_BYTES = 16 * 1024 * 1024
/** Ceiling on an *incomplete* frame — i.e. bytes held with no `\n` yet seen. */
export const PI_MAX_BUFFER_BYTES = 32 * 1024 * 1024

const LF = 0x0a
const CR = 0x0d

/** A violation of the wire contract. Terminal: the stream cannot resynchronise. */
export class PiFrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PiFrameError"
  }
}

/**
 * Strict LF-only JSONL decoder.
 *
 * Byte-level rather than string-level, for two reasons that both produced real
 * corruption in testing:
 *
 *   - Node's `readline` (and anything else built on JS line-splitting) treats
 *     U+2028 / U+2029 as line terminators. `JSON.stringify` does not escape
 *     them, so one valid Pi frame whose payload contains U+2028 is shredded
 *     into several unparseable fragments. Splitting on the `0x0A` byte cannot
 *     make that mistake.
 *   - A transport chunk boundary can fall inside a multi-byte UTF-8 sequence.
 *     Decoding per chunk would emit replacement characters; decoding per
 *     *frame* cannot, because `0x0A` never appears inside a multi-byte UTF-8
 *     sequence.
 *
 * A single trailing `\r` is stripped so CRLF input still parses, but a lone
 * `\r` is NOT a delimiter — inside JSON a literal carriage return must be
 * escaped as `\\r`, so treating it as a boundary can only ever split a frame
 * that was fine.
 */
export class PiFrameDecoder {
  /** Complete-but-unterminated bytes, kept unjoined so we copy only once. */
  private chunks: Uint8Array[] = []
  private pendingBytes = 0
  private readonly decoder = new TextDecoder("utf-8")
  private readonly encoder = new TextEncoder()

  constructor(
    private readonly maxFrameBytes: number = PI_MAX_FRAME_BYTES,
    private readonly maxBufferBytes: number = PI_MAX_BUFFER_BYTES
  ) {}

  /** Bytes currently held for an unterminated frame. Exposed for diagnostics. */
  get bufferedBytes(): number {
    return this.pendingBytes
  }

  /**
   * Feed a transport chunk and return every frame it completed.
   *
   * Blank frames are dropped: Pi does not emit them, and a trailing newline on
   * the final write would otherwise surface as an empty frame to parse.
   */
  push(chunk: Uint8Array | string): string[] {
    const bytes = typeof chunk === "string" ? this.encoder.encode(chunk) : chunk
    const frames: string[] = []

    let offset = 0
    for (;;) {
      const nl = bytes.indexOf(LF, offset)
      if (nl === -1) break
      const frame = this.assemble(bytes.subarray(offset, nl))
      if (frame) frames.push(frame)
      offset = nl + 1
    }

    const rest = bytes.subarray(offset)
    if (rest.length > 0) {
      this.pendingBytes += rest.length
      if (this.pendingBytes > this.maxBufferBytes) {
        // Reset before throwing: the caller tears the session down, and a
        // retained multi-megabyte buffer would outlive it otherwise.
        this.reset()
        throw new PiFrameError(
          `Pi RPC frame exceeded the ${this.maxBufferBytes}-byte buffer ceiling with no newline`
        )
      }
      this.chunks.push(rest)
    }

    return frames
  }

  /**
   * Bytes still held for an unterminated frame at end-of-stream. A process
   * that exits mid-frame leaves a residue that is worth reporting rather than
   * silently discarding — it is usually a crash, not a clean shutdown.
   */
  flushResidue(): string | null {
    if (this.pendingBytes === 0) return null
    const residue = this.assemble(new Uint8Array(0))
    return residue || null
  }

  reset(): void {
    this.chunks = []
    this.pendingBytes = 0
  }

  /** Join buffered chunks with `tail` into one frame, then clear the buffer. */
  private assemble(tail: Uint8Array): string {
    const total = this.pendingBytes + tail.length
    if (total > this.maxFrameBytes) {
      this.reset()
      throw new PiFrameError(
        `Pi RPC frame of ${total} bytes exceeded the ${this.maxFrameBytes}-byte limit`
      )
    }

    let buf: Uint8Array
    if (this.pendingBytes === 0) {
      buf = tail
    } else {
      buf = new Uint8Array(total)
      let at = 0
      for (const c of this.chunks) {
        buf.set(c, at)
        at += c.length
      }
      buf.set(tail, at)
      this.reset()
    }

    const end = buf.length > 0 && buf[buf.length - 1] === CR ? buf.length - 1 : buf.length
    return this.decoder.decode(buf.subarray(0, end))
  }
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
   * Report end-of-stream. Any residue is a truncated frame — surfaced as a
   * protocol error, because a half-written frame means the process died
   * mid-send rather than closing cleanly.
   */
  endOfStream(): void {
    if (this.closed) return
    let residue: string | null = null
    try {
      residue = this.decoder.flushResidue()
    } catch {
      // An over-limit residue is already a lost cause; the reject below is the
      // signal that matters.
    }
    if (residue !== null && residue.trim() !== "") {
      this.opts.onProtocolError?.(
        new PiFrameError(`Pi RPC stream ended mid-frame (${residue.length} chars discarded)`)
      )
    }
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
