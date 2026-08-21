/**
 * Platform-neutral stream primitives for the Agent RPC peer.
 *
 * The peer used to bind directly to Node (`node:readline` for line framing,
 * `Buffer.byteLength` for the frame budget, `node:stream` for the transport
 * types). That confined the whole SDK — client, sessions, event replay — to
 * Node, so the desktop WebView could not speak Agent RPC to a worker without a
 * second, parallel implementation of everything above the wire.
 *
 * Nothing here is a reimplementation of Node streams. It is the *minimum* the
 * peer actually consumes, declared structurally so a real `node:stream`
 * `Readable`/`Writable` satisfies it unchanged, plus two in-memory ends for
 * callers that multiplex frames over some other transport (a WebSocket, a
 * Tauri IPC channel) instead of a child process's stdio.
 */

/**
 * `any[]` is deliberate and matches `@types/node`'s own emitter signatures. A
 * narrower `unknown[]`/`never[]` rest parameter makes a real `node:stream`
 * `Readable` *fail* to satisfy these interfaces (its listeners are typed
 * `(...args: any[]) => void`, and `any` is not assignable to `never`), which
 * would defeat the entire point of declaring the transport structurally.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StreamListener = (...args: any[]) => void

/** The read side of an Agent RPC transport. `node:stream`'s `Readable` satisfies this. */
export interface RpcReadable {
  on(event: string, listener: StreamListener): unknown
  once(event: string, listener: StreamListener): unknown
  off(event: string, listener: StreamListener): unknown
}

/** The write side of an Agent RPC transport. `node:stream`'s `Writable` satisfies this. */
export interface RpcWritable {
  write(chunk: string): boolean
  on(event: string, listener: StreamListener): unknown
  once(event: string, listener: StreamListener): unknown
  off(event: string, listener: StreamListener): unknown
}

/**
 * UTF-8 byte length without `Buffer` or a `TextEncoder` allocation.
 *
 * The peer measures every inbound line and every outbound frame against the
 * negotiated 16 MiB limit, so this runs on the hot path for payloads that can
 * themselves be megabytes; encoding the string just to read `.length` would
 * double peak memory on exactly the frames most at risk of exceeding it.
 *
 * Lone surrogates are counted as the 3-byte replacement character, matching
 * `Buffer.byteLength` and `TextEncoder` — a frame must not measure smaller here
 * than it does on the wire.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

export interface LineReader {
  close(): void
}

export interface LineReaderHandlers {
  onLine(line: string): void
  onClose(): void
  onError?(error: Error): void
}

/**
 * Split a readable's chunks into newline-delimited lines.
 *
 * Replaces `readline.createInterface({ crlfDelay: Infinity })` with the subset
 * the peer relies on: CRLF and LF both terminate a line, a `\r` split across
 * two chunks does not produce a spurious empty line, and a trailing partial
 * line is flushed once before close — all behaviours `consumeLine` already
 * depended on. Binary chunks are decoded as streaming UTF-8 so a multi-byte
 * character straddling a chunk boundary survives.
 */
export function createLineReader(readable: RpcReadable, handlers: LineReaderHandlers): LineReader {
  const decoder = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8")
  let buffer = ""
  let closed = false

  const flushLines = (final: boolean) => {
    // A trailing `\r` may be the first half of a CRLF whose `\n` lands in the
    // next chunk. Hold it back unless this is the final flush.
    let searchable = buffer
    let carry = ""
    if (!final && searchable.endsWith("\r")) {
      carry = "\r"
      searchable = searchable.slice(0, -1)
    }
    const segments = searchable.split("\n")
    buffer = (segments.pop() ?? "") + carry
    for (const segment of segments) {
      handlers.onLine(segment.endsWith("\r") ? segment.slice(0, -1) : segment)
    }
  }

  const onData = (chunk: unknown) => {
    if (closed) return
    if (typeof chunk === "string") {
      buffer += chunk
    } else if (decoder && (chunk instanceof Uint8Array || ArrayBuffer.isView(chunk))) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    } else {
      buffer += String(chunk)
    }
    flushLines(false)
  }

  const finish = () => {
    if (closed) return
    closed = true
    flushLines(true)
    if (buffer) {
      const line = buffer
      buffer = ""
      handlers.onLine(line)
    }
    handlers.onClose()
  }

  const onError = (error: unknown) => {
    handlers.onError?.(error instanceof Error ? error : new Error(String(error)))
  }

  readable.on("data", onData as StreamListener)
  readable.once("end", finish as StreamListener)
  readable.once("close", finish as StreamListener)
  readable.on("error", onError as StreamListener)

  return {
    close() {
      if (closed) return
      closed = true
      readable.off("data", onData as StreamListener)
      readable.off("end", finish as StreamListener)
      readable.off("close", finish as StreamListener)
      readable.off("error", onError as StreamListener)
      handlers.onClose()
    },
  }
}

type EmitterHandlers = Map<string, Set<StreamListener>>

class MinimalEmitter {
  private readonly handlers: EmitterHandlers = new Map()
  private readonly onceHandlers = new WeakSet<StreamListener>()

  on(event: string, listener: StreamListener): unknown {
    const set = this.handlers.get(event) ?? new Set()
    set.add(listener)
    this.handlers.set(event, set)
    return this
  }

  once(event: string, listener: StreamListener): unknown {
    this.onceHandlers.add(listener)
    return this.on(event, listener)
  }

  off(event: string, listener: StreamListener): unknown {
    this.handlers.get(event)?.delete(listener)
    return this
  }

  protected emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.handlers.get(event) ?? [])]) {
      if (this.onceHandlers.has(listener)) this.handlers.get(event)?.delete(listener)
      listener(...args)
    }
  }
}

/**
 * The read side of a transport whose bytes arrive out-of-band.
 *
 * Callers `push` each inbound frame as it is demultiplexed and `end` when the
 * connection drops. It stands in for a `PassThrough` used purely as a conduit,
 * without pulling `node:stream` into a browser bundle.
 */
export class RpcStreamSource extends MinimalEmitter implements RpcReadable {
  private ended = false

  push(chunk: string): void {
    if (this.ended) return
    this.emit("data", chunk)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.emit("end")
    this.emit("close")
  }

  fail(error: Error): void {
    if (this.ended) return
    this.emit("error", error)
  }
}

/**
 * The write side of a transport that carries one newline-free frame per send.
 *
 * The peer writes `${json}\n`; every transport that multiplexes Agent RPC —
 * the headless brain bridge and the desktop IPC channel alike — must hand the
 * host exactly one frame per message with the delimiter stripped, because the
 * ingress rejects frames containing a newline outright.
 */
export class RpcFrameSink extends MinimalEmitter implements RpcWritable {
  private buffer = ""
  private ended = false

  constructor(private readonly sendFrame: (frame: string) => void) {
    super()
  }

  write(chunk: string): boolean {
    if (this.ended) return false
    this.buffer += chunk
    const frames = this.buffer.split("\n")
    this.buffer = frames.pop() ?? ""
    try {
      for (const frame of frames) {
        if (frame) this.sendFrame(frame)
      }
    } catch (error) {
      // Surfaced as a stream error so the peer tears the connection down the
      // same way it would for a broken pipe, rather than throwing into
      // whichever `call()` happened to be writing.
      this.emit("error", error instanceof Error ? error : new Error(String(error)))
      return false
    }
    return true
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.buffer = ""
    this.emit("close")
  }
}
