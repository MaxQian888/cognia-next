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
  readonly idleMs: number

  constructor(timeoutMs: number) {
    super(`provider stream produced no events for ${timeoutMs}ms`)
    this.name = "StreamIdleTimeoutError"
    this.idleMs = timeoutMs
  }
}

export interface IdleTimeoutOptions {
  /**
   * Read before each wait. While it answers true the gap is not bounded: the
   * stream is silent on purpose (a tool is executing, or waiting on a
   * permission prompt inside its `execute`), and the tool's own timeout bounds
   * that wait instead. The consumer updates what it reads between events, so
   * the answer is current when the next wait starts.
   */
  suspended?: () => boolean
}

/**
 * Async-iterate `stream` (an AsyncIterable) with an idle bound: every pending
 * `next()` is raced against `timeoutMs`. Normal completion (`done`) is not a
 * timeout — only a gap between events is.
 */
export async function* withIdleTimeout<T>(
  stream: AsyncIterable<T>,
  timeoutMs: number = STREAM_IDLE_TIMEOUT_MS,
  options: IdleTimeoutOptions = {}
): AsyncGenerator<T, void, undefined> {
  const iterator = stream[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    for (;;) {
      const next = iterator.next()
      // Give the pending `next` a handled rejection branch so a stream that
      // fails right as the watchdog fires is not an unhandled rejection.
      next.catch(() => {})
      const result = options.suspended?.()
        ? await next
        : await Promise.race([
            next,
            new Promise<never>((_, reject) => {
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

/**
 * Keep `executing` current from one AI SDK `fullStream` part: a locally run
 * `tool-call` starts executing, and its `tool-result` / `tool-error` /
 * `tool-output-denied` ends it. Provider-executed calls are excluded (their
 * results stream from the provider, so a gap there is a provider stall), and
 * so are calls whose input failed validation (they never execute; the SDK
 * answers them with a `tool-error` at once). Pass the set to
 * {@link withIdleTimeout}'s `suspended`.
 */
export function trackExecutingToolCall(executing: Set<string>, part: unknown): void {
  if (!part || typeof part !== "object") return
  const evt = part as {
    type?: unknown
    toolCallId?: unknown
    providerExecuted?: unknown
    invalid?: unknown
  }
  if (typeof evt.toolCallId !== "string" || evt.toolCallId.length === 0) return
  switch (evt.type) {
    case "tool-call":
      if (evt.providerExecuted !== true && evt.invalid !== true) executing.add(evt.toolCallId)
      return
    case "tool-result":
    case "tool-error":
    case "tool-output-denied":
      executing.delete(evt.toolCallId)
      return
  }
}
