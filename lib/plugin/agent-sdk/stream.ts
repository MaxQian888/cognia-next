/**
 * Push-queue backing for {@link PluginAgentRun}.
 *
 * The executor produces stream events imperatively (text deltas + tool calls);
 * the plugin author consumes them with `for await`. This adapter bridges the
 * two: producers call `push()` / `close()` / `fail()`, consumers async-iterate.
 * Modeled on the external-agent streaming shape
 * (`lib/ai/agent/external/protocol-adapter.ts`).
 *
 * Buffering is unbounded but bounded in practice by a single agent turn; events
 * pushed before the consumer attaches are queued and replayed in order.
 */

import type {
  PluginAgentRun,
  PluginAgentRunResult,
  PluginAgentStreamEvent,
} from "@/types/plugin/plugin-agent-sdk"

export interface PluginAgentRunController {
  /** The live handle handed to the plugin. */
  run: PluginAgentRun
  /** Emit one event to consumers. No-op after close/fail. */
  push: (event: PluginAgentStreamEvent) => void
  /** Resolve the run with its final result (also emits a `result` event). */
  close: (result: PluginAgentRunResult) => void
  /** Reject the run + terminate iteration with an error. */
  fail: (error: unknown) => void
}

/**
 * Create a controllable {@link PluginAgentRun}. `onCancel` is invoked once when
 * the consumer calls `run.cancel()` (wire it to the run's AbortController).
 */
export function createPluginAgentRun(
  agentId: string,
  onCancel: () => void
): PluginAgentRunController {
  const queue: PluginAgentStreamEvent[] = []
  // Pending iterator waiters (resolve when an event arrives or the stream ends).
  let pendingResolve: ((r: IteratorResult<PluginAgentStreamEvent>) => void) | null = null
  let pendingReject: ((err: unknown) => void) | null = null
  let ended = false
  let failure: unknown = null
  let cancelled = false

  let resolveResult!: (r: PluginAgentRunResult) => void
  let rejectResult!: (err: unknown) => void
  const resultPromise = new Promise<PluginAgentRunResult>((res, rej) => {
    resolveResult = res
    rejectResult = rej
  })
  // The result promise may settle before anyone awaits it; swallow the default
  // unhandled-rejection so a fail() without an awaiter doesn't crash the process.
  resultPromise.catch(() => undefined)

  const settleNext = () => {
    if (!pendingResolve) return
    if (queue.length > 0) {
      const event = queue.shift() as PluginAgentStreamEvent
      const resolve = pendingResolve
      pendingResolve = null
      pendingReject = null
      resolve({ value: event, done: false })
      return
    }
    if (failure != null) {
      const reject = pendingReject
      pendingResolve = null
      pendingReject = null
      reject?.(failure)
      return
    }
    if (ended) {
      const resolve = pendingResolve
      pendingResolve = null
      pendingReject = null
      resolve({ value: undefined, done: true })
    }
  }

  const push = (event: PluginAgentStreamEvent) => {
    if (ended || failure != null) return
    queue.push(event)
    settleNext()
  }

  const close = (result: PluginAgentRunResult) => {
    if (ended || failure != null) return
    queue.push({ type: "result", result })
    ended = true
    resolveResult(result)
    settleNext()
  }

  const fail = (error: unknown) => {
    if (ended || failure != null) return
    failure = error ?? new Error("plugin agent run failed")
    rejectResult(failure)
    settleNext()
  }

  const iterator: AsyncIterator<PluginAgentStreamEvent> = {
    next() {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift() as PluginAgentStreamEvent, done: false })
      }
      if (failure != null) return Promise.reject(failure)
      if (ended) return Promise.resolve({ value: undefined, done: true })
      return new Promise<IteratorResult<PluginAgentStreamEvent>>((resolve, reject) => {
        pendingResolve = resolve
        pendingReject = reject
      })
    },
    return() {
      ended = true
      settleNext()
      return Promise.resolve({ value: undefined, done: true })
    },
  }

  const run: PluginAgentRun = {
    agentId,
    result: resultPromise,
    cancel() {
      if (cancelled) return
      cancelled = true
      onCancel()
    },
    [Symbol.asyncIterator]() {
      return iterator
    },
  }

  return { run, push, close, fail }
}
