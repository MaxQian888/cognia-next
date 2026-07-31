"use client"

/**
 * Backpressure-aware writer for xterm.js.
 *
 * Coalesces inbound PTY chunks (one per `Channel<TerminalEvent>` message)
 * into a single `term.write(buf, ack)` call per animation frame. Tracks
 * the byte count that hasn't yet been acknowledged by xterm; once it
 * exceeds the high-watermark, drains pending chunks to a holding buffer
 * and tells the caller to pause the PTY (via `onPause`). When ack count
 * drops below the low-watermark, calls `onResume`.
 *
 * This is the renderer side of the durable host's bounded-output flow
 * control. See https://xtermjs.org/docs/guides/flowcontrol/ for the
 * upstream guidance the watermarks come from.
 *
 * Design choices:
 *   * Hard-coded watermarks (5 MB / 1 MB) — VS Code's defaults. Promote
 *     to settings if a tuning need emerges.
 *   * The `scheduler` argument is injected so tests can step time
 *     deterministically without relying on real rAF / setTimeout.
 *   * `flushNow` is exposed for tests + the kill path so a session
 *     teardown doesn't leak the pending buffer.
 */

const HIGH_WATERMARK_BYTES = 5 * 1024 * 1024
const LOW_WATERMARK_BYTES = 1 * 1024 * 1024

export interface TermLike {
  write(data: Uint8Array, callback?: () => void): void
}

export type Scheduler = (cb: () => void) => unknown

export interface BackpressureOptions {
  term: TermLike
  onPause?: () => void
  onResume?: () => void
  scheduler?: Scheduler
  highWatermark?: number
  lowWatermark?: number
}

export class TerminalBackpressure {
  private readonly term: TermLike
  private readonly onPause: (() => void) | undefined
  private readonly onResume: (() => void) | undefined
  private readonly schedule: Scheduler
  private readonly high: number
  private readonly low: number

  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private unackedBytes = 0
  private scheduled = false
  private paused = false
  private disposed = false

  constructor(opts: BackpressureOptions) {
    this.term = opts.term
    this.onPause = opts.onPause
    this.onResume = opts.onResume
    this.schedule = opts.scheduler ?? defaultScheduler()
    this.high = opts.highWatermark ?? HIGH_WATERMARK_BYTES
    this.low = opts.lowWatermark ?? LOW_WATERMARK_BYTES
  }

  push(chunk: Uint8Array): void {
    if (this.disposed || chunk.length === 0) return
    this.pending.push(chunk)
    this.pendingBytes += chunk.length
    if (this.pendingBytes + this.unackedBytes >= this.high && !this.paused) {
      this.paused = true
      this.onPause?.()
    }
    if (!this.scheduled) {
      this.scheduled = true
      this.schedule(() => this.flush())
    }
  }

  /** Force-flush the pending buffer outside the next-frame cadence. */
  flushNow(): void {
    if (this.scheduled) {
      // The scheduled flush will see `pending.length === 0` and short-circuit.
    }
    this.flush()
  }

  dispose(): void {
    this.disposed = true
    this.pending = []
    this.pendingBytes = 0
  }

  /** Test/inspection. */
  get inFlightBytes(): number {
    return this.pendingBytes + this.unackedBytes
  }

  get isPaused(): boolean {
    return this.paused
  }

  private flush(): void {
    this.scheduled = false
    if (this.disposed || this.pending.length === 0) return
    const merged = mergeChunks(this.pending, this.pendingBytes)
    this.pending = []
    this.pendingBytes = 0
    this.unackedBytes += merged.length
    this.term.write(merged, () => this.ack(merged.length))
  }

  private ack(bytes: number): void {
    this.unackedBytes = Math.max(0, this.unackedBytes - bytes)
    if (this.paused && this.unackedBytes + this.pendingBytes <= this.low) {
      this.paused = false
      this.onResume?.()
    }
  }
}

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function defaultScheduler(): Scheduler {
  if (typeof requestAnimationFrame !== "undefined") {
    return (cb) => requestAnimationFrame(cb)
  }
  // SSR / node test env without jsdom rAF — fall through to microtask.
  return (cb) => queueMicrotask(cb)
}
