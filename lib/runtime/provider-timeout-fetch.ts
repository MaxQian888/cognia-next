// Provider `fetch` wrapper enforcing the two timeouts a stalled LLM request
// needs: a headers (TTFB) bound and an idle-chunk bound on the streamed body.
// Neither the AI SDK nor the platform fetch applies either one, so a provider
// that accepts the request and then goes silent would hang the turn forever —
// the only exit was the user's abort. Modeled on opencode's provider timeouts
// (v1.18.27): five-minute defaults, `false` disables each independently.
//
// Wired at `createFeatureProviderModel` — the single seam every webview-side
// provider call passes through (standalone BYOK chat, plugin/provider
// operations). The sidecar dispatch path enforces the same idle bound in its
// own event loop (`sidecar/dispatch/stream-watchdog.mjs`); it cannot import
// this module because `sidecar/` is a separate Node project.

export const PROVIDER_HEADERS_TIMEOUT_MS = 5 * 60_000
export const PROVIDER_CHUNK_TIMEOUT_MS = 5 * 60_000

export type ProviderTimeoutKind = "headers" | "idle-chunk"

export class ProviderTimeoutError extends Error {
  readonly kind: ProviderTimeoutKind
  readonly timeoutMs: number

  constructor(kind: ProviderTimeoutKind, timeoutMs: number) {
    super(
      kind === "headers"
        ? `Provider did not send response headers within ${timeoutMs}ms`
        : `Provider stream produced no chunks for ${timeoutMs}ms`
    )
    this.name = "ProviderTimeoutError"
    this.kind = kind
    this.timeoutMs = timeoutMs
  }
}

export interface ProviderTimeoutOptions {
  /** Max wait for response headers. `false` disables. Default 5 min. */
  headersMs?: number | false
  /** Max gap between streamed body chunks. `false` disables. Default 5 min. */
  chunkMs?: number | false
}

/**
 * Re-emit `body` with an idle-gap bound: every `read()` on the source reader
 * is raced against `timeoutMs`. On timeout the source is cancelled and the
 * replacement stream errors with {@link ProviderTimeoutError}, so a stalled
 * SSE body fails the read loop instead of parking it.
 */
function wrapBodyWithIdleTimeout(
  body: ReadableStream<Uint8Array>,
  timeoutMs: number
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = reader.read()
      // The losing `next` may still settle after a timeout rejects below; give
      // it a handled rejection branch so a late failure is not unhandled.
      next.catch(() => undefined)
      try {
        const result = await Promise.race([
          next,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new ProviderTimeoutError("idle-chunk", timeoutMs)),
              timeoutMs
            )
            // The timeout must not pin the event loop on its own (Node tests).
            ;(timer as { unref?: () => void }).unref?.()
          }),
        ])
        clear()
        if (result.done) {
          controller.close()
          return
        }
        controller.enqueue(result.value)
      } catch (err) {
        clear()
        // Fire-and-forget: a reader stuck in a never-settling read() does not
        // answer cancel() either — awaiting it would hang the error path.
        reader.cancel(err).catch(() => undefined)
        controller.error(err)
      }
    },
    cancel(reason) {
      clear()
      return reader.cancel(reason)
    },
  })
}

/**
 * Wrap a `fetch` so the response-headers wait and the per-chunk idle gap are
 * both bounded. The caller's `init.signal` still governs — a user abort wins
 * over (and is distinct from) either timeout. Bodies that are not streams
 * (null body, fully-buffered responses) pass through unwrapped.
 */
export function withProviderTimeouts(
  fetchImpl: typeof globalThis.fetch,
  options: ProviderTimeoutOptions = {}
): typeof globalThis.fetch {
  const headersMs = options.headersMs ?? PROVIDER_HEADERS_TIMEOUT_MS
  const chunkMs = options.chunkMs ?? PROVIDER_CHUNK_TIMEOUT_MS

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const callerSignal = init?.signal ?? null
    const ctrl = new AbortController()
    // Rejects when the caller aborts — a signal-aware fetch would settle on its
    // own, but this guard makes abort work even against a fetch that ignores
    // the signal entirely.
    let rejectOnCallerAbort: ((reason?: unknown) => void) | undefined
    const callerAborted = new Promise<never>((_, reject) => {
      rejectOnCallerAbort = reject
    })
    const onAbort = () => {
      ctrl.abort(callerSignal?.reason)
      rejectOnCallerAbort?.(callerSignal?.reason)
    }
    if (callerSignal) {
      if (callerSignal.aborted) onAbort()
      else callerSignal.addEventListener("abort", onAbort, { once: true })
    }

    const request = fetchImpl(input, { ...init, signal: ctrl.signal })
    // Same late-rejection guard as the chunk race: when a timeout or caller
    // abort wins, the underlying fetch still settles (aborted) later.
    request.catch(() => undefined)
    try {
      let response: Response
      let timer: ReturnType<typeof setTimeout> | undefined
      const guards: Array<Promise<never>> = [callerAborted]
      if (headersMs !== false) {
        guards.push(
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const err = new ProviderTimeoutError("headers", headersMs)
              ctrl.abort(err)
              reject(err)
            }, headersMs)
            ;(timer as { unref?: () => void }).unref?.()
          })
        )
      }
      try {
        response = await Promise.race([request, ...guards])
      } finally {
        clearTimeout(timer)
      }
      if (chunkMs === false || !response.body) return response
      return new Response(wrapBodyWithIdleTimeout(response.body, chunkMs), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } finally {
      callerSignal?.removeEventListener("abort", onAbort)
    }
  }) as typeof globalThis.fetch
}
