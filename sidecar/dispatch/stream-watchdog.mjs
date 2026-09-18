/**
 * Idle-gap watchdog for a provider event stream. The AI SDK surfaces a stuck
 * HTTP body as an async iterator that simply never yields again — without a
 * bound here, a provider that holds the connection open but stops sending
 * parks the turn forever. This mirrors the webview-side idle-chunk bound in
 * `lib/runtime/provider-timeout-fetch.ts` (same default: five minutes, the
 * opencode v1.18.27 value); the logic is duplicated rather than shared because
 * `sidecar/` is a separate Node project that cannot import `lib/` TypeScript.
 *
 * On timeout the source iterator is `return()`ed so the underlying stream
 * gets its cancellation, then a {@link StreamIdleTimeoutError} propagates.
 * The dispatch loop routes it through the normal error classification, where
 * it lands as `timeout_after_send` — retryable before output, terminal after.
 */

export const STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export class StreamIdleTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`provider stream produced no events for ${timeoutMs}ms`)
    this.name = "StreamIdleTimeoutError"
    this.idleMs = timeoutMs
  }
}

/**
 * Async-iterate `stream` (an AsyncIterable) with an idle bound: every pending
 * `next()` is raced against `timeoutMs`. Normal completion (`done`) is not a
 * timeout — only a gap between events is.
 *
 * @param {AsyncIterable<unknown>} stream
 * @param {number} timeoutMs
 */
export async function* withIdleTimeout(stream, timeoutMs = STREAM_IDLE_TIMEOUT_MS) {
  const iterator = stream[Symbol.asyncIterator]()
  let timer
  try {
    for (;;) {
      const next = iterator.next()
      // Give the pending `next` a handled rejection branch so a stream that
      // fails right as the watchdog fires is not an unhandled rejection.
      next.catch(() => {})
      const result = await Promise.race([
        next,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new StreamIdleTimeoutError(timeoutMs)), timeoutMs)
          // A watchdog must never keep the process alive on its own.
          timer.unref?.()
        }),
      ])
      clearTimeout(timer)
      timer = undefined
      if (result.done) return
      yield result.value
    }
  } catch (err) {
    // Cancel upstream so the HTTP body / SSE reader is released. Fire-and-
    // forget: an iterator suspended on a never-settling promise never answers
    // `return()` either, and awaiting it would hang the error path itself.
    iterator.return?.().catch(() => {})
    throw err
  } finally {
    clearTimeout(timer)
  }
}
