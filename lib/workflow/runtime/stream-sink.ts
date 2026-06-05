/**
 * Stream sink — write-amplification guard between per-token LLM deltas and
 * the durable event log. Executors call `push()` as often as they like; the
 * sink coalesces into one `step_stream` event per flush window (timer OR
 * size cap, whichever fires first). The final full text still lands in
 * `step_completed.output`, so resume and history never depend on chunks.
 */

export interface StreamSinkLogger {
  stepStream: (stepId: string, delta: string, seq: number) => Promise<unknown>
}

export interface CreateStreamSinkInput {
  stepId: string
  logger: StreamSinkLogger
  /** Coalescing window; one event at most per `flushMs`. */
  flushMs?: number
  /** Size cap — a buffer larger than this flushes immediately. */
  maxBufferChars?: number
}

export interface StreamSink {
  /** Buffer one delta. Dropped after `final()`. */
  push: (delta: string) => void
  /** Force-write the current buffer (no-op when empty). */
  flush: () => void
  /** Flush remaining buffer and close. Idempotent; call on success AND abort. */
  final: () => void
}

const DEFAULT_FLUSH_MS = 120
const DEFAULT_MAX_BUFFER_CHARS = 800

export function createStreamSink(input: CreateStreamSinkInput): StreamSink {
  const flushMs = input.flushMs ?? DEFAULT_FLUSH_MS
  const maxBufferChars = input.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS

  let buffer = ""
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  function flush(): void {
    clearTimer()
    if (!buffer) return
    const delta = buffer
    buffer = ""
    // Fire-and-forget: appendEvent stamps its monotonic ts synchronously at
    // call time, so ordering is preserved without awaiting the Dexie write.
    void input.logger.stepStream(input.stepId, delta, seq++)
  }

  return {
    push(delta: string): void {
      if (closed || !delta) return
      buffer += delta
      if (buffer.length >= maxBufferChars) {
        flush()
        return
      }
      if (timer === undefined) {
        timer = setTimeout(flush, flushMs)
      }
    },
    flush,
    final(): void {
      if (closed) return
      closed = true
      flush()
    },
  }
}
