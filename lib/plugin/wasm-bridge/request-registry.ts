/**
 * Per-request `AbortController` lifecycle for the WASM capability bridge.
 *
 * Three properties this module exists to guarantee:
 *
 * 1. **Exactly one response per requestId.** [`settleRequest`] returns `true`
 *    once and `false` forever after. A handler that resolves *after* its abort
 *    finds the request already settled and drops its result silently — that is
 *    how "discard late results" is implemented.
 * 2. **No leaked controllers.** Every path clears the timer and deletes the map
 *    entry in a `finally`, so a throwing handler cannot leak one.
 * 3. **No cross-request interference.** A duplicate `requestId` is rejected
 *    rather than clobbering the live entry.
 *
 * Rust owns the authoritative timeout and emits a cancel frame when it fires.
 * The local timer here is belt-and-braces: a lost cancel event must not leave a
 * controller (and its provider stream) alive forever.
 */

import type { WasmCancelReason, WasmRendererRequest } from "./protocol"

interface PendingRequest {
  pluginId: string
  operation: string
  controller: AbortController
  abortReason?: WasmCancelReason
  timeoutTimer: ReturnType<typeof setTimeout>
  settled: boolean
}

const pending = new Map<string, PendingRequest>()

export class DuplicateRequestError extends Error {
  constructor(requestId: string) {
    super(`duplicate requestId: ${requestId}`)
    this.name = "DuplicateRequestError"
  }
}

/**
 * Register a request and return its abort signal.
 *
 * @throws {DuplicateRequestError} when `requestId` is already in flight.
 */
export function beginRequest(request: WasmRendererRequest, onTimeout: () => void): AbortSignal {
  if (pending.has(request.requestId)) {
    throw new DuplicateRequestError(request.requestId)
  }

  const controller = new AbortController()
  const timeoutTimer = setTimeout(() => {
    // Mark the reason before aborting so the rejection classifies as TIMEOUT
    // rather than a bare CANCELLED.
    const entry = pending.get(request.requestId)
    if (entry && !entry.settled) {
      entry.abortReason = "timeout"
      entry.controller.abort()
    }
    onTimeout()
  }, request.timeoutMs)

  pending.set(request.requestId, {
    pluginId: request.pluginId,
    operation: request.operation,
    controller,
    timeoutTimer,
    settled: false,
  })

  return controller.signal
}

/** Why a request was aborted, for error classification. `undefined` if it wasn't. */
export function abortReasonFor(requestId: string): WasmCancelReason | undefined {
  return pending.get(requestId)?.abortReason
}

/**
 * Abort one request. Idempotent; unknown ids are a no-op.
 *
 * Does NOT remove the entry — the handler still needs `abortReasonFor` when its
 * promise rejects, and [`settleRequest`] performs the removal.
 */
export function cancelRequest(requestId: string, reason: WasmCancelReason): void {
  const entry = pending.get(requestId)
  if (!entry || entry.settled) return
  entry.abortReason = reason
  entry.controller.abort()
}

/**
 * Claim the right to send the single response for a request.
 *
 * Returns `true` exactly once per `requestId`; every later call returns `false`.
 * Callers must not invoke the response command unless this returned `true`.
 */
export function settleRequest(requestId: string): boolean {
  const entry = pending.get(requestId)
  if (!entry || entry.settled) return false
  entry.settled = true
  clearTimeout(entry.timeoutTimer)
  pending.delete(requestId)
  return true
}

/** Abort every in-flight request belonging to one plugin. Returns the count. */
export function abortAllForPlugin(pluginId: string, reason: WasmCancelReason): number {
  let count = 0
  for (const [requestId, entry] of pending) {
    if (entry.pluginId !== pluginId || entry.settled) continue
    entry.abortReason = reason
    entry.controller.abort()
    count += 1
    void requestId
  }
  return count
}

/**
 * Abort everything in flight. Returns the count.
 *
 * `settle: true` also closes the response gate for each request, which is what
 * the install teardown needs: the listeners are gone and the host is going
 * away, so there is nobody to answer. Without it, a handler that *ignores* its
 * abort signal — a provider SDK that does not honour `AbortSignal`, say — would
 * resolve after unmount, find the gate still open, and emit a response through
 * a dead bridge.
 *
 * The cancel-event path deliberately does NOT settle: there the guest is still
 * waiting, and its one response is the handler's abort rejection.
 */
export function abortAll(reason: WasmCancelReason, opts: { settle?: boolean } = {}): number {
  let count = 0
  for (const [requestId, entry] of [...pending]) {
    if (entry.settled) continue
    entry.abortReason = reason
    entry.controller.abort()
    count += 1
    if (opts.settle) {
      clearTimeout(entry.timeoutTimer)
      entry.settled = true
      pending.delete(requestId)
    }
  }
  return count
}

export function pendingCount(): number {
  return pending.size
}

export function __resetWasmRequestRegistryForTesting(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timeoutTimer)
  }
  pending.clear()
}
