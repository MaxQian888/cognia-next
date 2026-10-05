/**
 * Strict LF-only frame decoding for newline-delimited JSON transports.
 *
 * Shared by every adapter that owns a byte-level stdout framing (`raw`
 * framing on the process host): Pi RPC and the DeepSeek Harness SDK runtime.
 * Each caller names its stream so a violation says whose wire broke.
 */

/** Frames larger than this abort the session rather than buffer unboundedly. */
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024
/** Ceiling on an *incomplete* frame — i.e. bytes held with no `\n` yet seen. */
export const DEFAULT_MAX_BUFFER_BYTES = 32 * 1024 * 1024

const LF = 0x0a
const CR = 0x0d

/** A violation of the wire contract. Terminal: the stream cannot resynchronise. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FrameError"
  }
}

export interface LfFrameDecoderOptions {
  /** Stream name used in errors, e.g. `"Pi RPC"`. */
  label: string
  maxFrameBytes?: number
  maxBufferBytes?: number
  /** Build the error thrown on a violation; defaults to {@link FrameError}. */
  createError?: (message: string) => Error
}

/**
 * Strict LF-only JSONL decoder.
 *
 * Byte-level rather than string-level, for two reasons that both produced real
 * corruption in testing:
 *
 *   - Node's `readline` (and anything else built on JS line-splitting) treats
 *     U+2028 / U+2029 as line terminators. `JSON.stringify` does not escape
 *     them, so one valid frame whose payload contains U+2028 is shredded into
 *     several unparseable fragments. Splitting on the `0x0A` byte cannot make
 *     that mistake.
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
export class LfFrameDecoder {
  /** Complete-but-unterminated bytes, kept unjoined so we copy only once. */
  private chunks: Uint8Array[] = []
  private pendingBytes = 0
  private readonly decoder = new TextDecoder("utf-8")
  private readonly encoder = new TextEncoder()
  private readonly label: string
  private readonly maxFrameBytes: number
  private readonly maxBufferBytes: number
  private readonly createError: (message: string) => Error

  constructor(options: LfFrameDecoderOptions) {
    this.label = options.label
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES
    this.createError = options.createError ?? ((message) => new FrameError(message))
  }

  /** Bytes currently held for an unterminated frame. Exposed for diagnostics. */
  get bufferedBytes(): number {
    return this.pendingBytes
  }

  /**
   * Feed a transport chunk and return every frame it completed.
   *
   * Blank frames are dropped: a trailing newline on the final write would
   * otherwise surface as an empty frame to parse.
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
        throw this.createError(
          `${this.label} frame exceeded the ${this.maxBufferBytes}-byte buffer ceiling with no newline`
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
      throw this.createError(
        `${this.label} frame of ${total} bytes exceeded the ${this.maxFrameBytes}-byte limit`
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
