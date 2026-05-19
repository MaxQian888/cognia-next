/**
 * Chat-middleware runner.
 *
 * Composes the active middleware chain Koa-style and invokes the terminal
 * handler (the real send call) at the end. Each middleware runs inside:
 *   - a `Promise.race` against its per-middleware timeout — on timeout the
 *     middleware is *skipped* and the chain proceeds with the previous
 *     middleware's output (or the original request if it was outermost),
 *   - a try/catch — exceptions log + skip, never propagate to the main
 *     pipeline,
 *   - failure-counter bookkeeping — 3 consecutive (timeout OR throw)
 *     failures trip the breaker, disabling the middleware until the
 *     plugin re-enables or the user clicks "retry" in settings.
 *
 * On a successful run, the counter resets to zero.
 *
 * The runner is intentionally light — the actual middleware list is read
 * fresh on each turn via `listActiveChatMiddlewares()` so a middleware
 * tripped mid-turn doesn't run in the next turn even if it's still in the
 * registry.
 *
 * ADR-0026 §4 §A.
 */

import type {
  ChatMiddlewareRequest,
  ChatMiddlewareResponse,
  ChatMiddleware,
} from "@/types/plugin/plugin-chat-middleware"
import {
  listActiveChatMiddlewares,
  recordMiddlewareFailure,
  recordMiddlewareSuccess,
  type ChatMiddlewareRegistration,
} from "./registry"

export interface ChatMiddlewareRunReport {
  /** Middlewares that ran successfully (their `fullId`). */
  succeeded: string[]
  /** Middlewares that timed out (their `fullId`). */
  timedOut: string[]
  /** Middlewares that threw (their `fullId` + error message). */
  threw: Array<{ fullId: string; message: string }>
  /**
   * Middlewares whose breaker tripped during this run (i.e. failure
   * counter crossed 3). They are removed from subsequent turns.
   */
  trippedBreakers: string[]
}

export interface RunChatMiddlewareChainOptions {
  /** AbortSignal threaded into each middleware via the request object. */
  signal?: AbortSignal
  /**
   * Override the middleware list (for tests). Defaults to the global
   * `listActiveChatMiddlewares()` snapshot at call time.
   */
  middlewares?: ChatMiddlewareRegistration[]
  /**
   * Optional hook fired after the chain completes — receives the run
   * report. Useful for telemetry / settings-UI surfacing.
   */
  onReport?: (report: ChatMiddlewareRunReport) => void
}

/**
 * Execute the middleware chain. `terminal` is the real send call —
 * receives the (possibly transformed) request and returns the host's
 * raw response. The runner returns the final transformed response after
 * all middlewares have wrapped it.
 */
export async function runChatMiddlewareChain(
  request: ChatMiddlewareRequest,
  terminal: (req: ChatMiddlewareRequest) => Promise<ChatMiddlewareResponse>,
  options: RunChatMiddlewareChainOptions = {}
): Promise<{ response: ChatMiddlewareResponse; report: ChatMiddlewareRunReport }> {
  const chain = options.middlewares ?? listActiveChatMiddlewares()
  const report: ChatMiddlewareRunReport = {
    succeeded: [],
    timedOut: [],
    threw: [],
    trippedBreakers: [],
  }

  // Build the chain back-to-front so the outermost middleware sees the
  // original request first.
  let runner: (req: ChatMiddlewareRequest) => Promise<ChatMiddlewareResponse> = (req) =>
    terminal(req)

  for (let i = chain.length - 1; i >= 0; i--) {
    const entry = chain[i]!
    const next = runner
    runner = async (req: ChatMiddlewareRequest): Promise<ChatMiddlewareResponse> => {
      const callMiddleware = (): Promise<ChatMiddlewareResponse> =>
        Promise.resolve(entry.fn(req, () => next(req)))

      const result = await raceWithTimeout(callMiddleware(), entry.timeoutMs)
      if (result.kind === "timeout") {
        report.timedOut.push(entry.fullId)
        const tripped = recordMiddlewareFailure(entry.fullId, "timeout")
        if (tripped && !report.trippedBreakers.includes(entry.fullId)) {
          report.trippedBreakers.push(entry.fullId)
        }
        // Skip this middleware — proceed with the original request via next.
        return next(req)
      }
      if (result.kind === "error") {
        report.threw.push({ fullId: entry.fullId, message: result.message })
        const tripped = recordMiddlewareFailure(entry.fullId, result.message)
        if (tripped && !report.trippedBreakers.includes(entry.fullId)) {
          report.trippedBreakers.push(entry.fullId)
        }
        return next(req)
      }
      // Success.
      report.succeeded.push(entry.fullId)
      recordMiddlewareSuccess(entry.fullId)
      return result.value
    }
  }

  const finalRequest: ChatMiddlewareRequest = options.signal
    ? { ...request, signal: options.signal }
    : request

  const response = await runner(finalRequest)
  options.onReport?.(report)
  return { response, report }
}

type RaceResult<T> =
  | { kind: "success"; value: T }
  | { kind: "timeout" }
  | { kind: "error"; message: string }

async function raceWithTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<RaceResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      p.then((v) => ({ ok: true as const, v })),
      new Promise<{ ok: false; reason: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs)
      }),
    ])
    if (value.ok) return { kind: "success", value: value.v }
    return { kind: "timeout" }
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Re-export for tests that want to compose the chain without the registry.
 */
export type { ChatMiddleware }
