/**
 * Admission helpers shared by every turn driver that funnels through the
 * {@link ExecutionBroker}. Keeps the acquire → run → release dance (and the
 * caller-signal ⊕ lease-signal combination) in one tested place so the
 * chokepoints (`run-and-capture`, chat `send()`) don't each re-implement it.
 */

import { getExecutionBroker } from "./broker"
import type { ExecutionBroker } from "./broker"
import type { ExecutionLease, ExecutionLeaseRequest } from "./types"

/**
 * Combine any number of `AbortSignal`s into one. The returned signal aborts as
 * soon as the FIRST input aborts. Call `cleanup()` when done to detach the
 * listeners (so a long-lived caller signal doesn't leak references). Returns
 * `undefined` when no live signal is supplied (nothing to combine).
 */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined | null>
): { signal: AbortSignal; cleanup: () => void } | undefined {
  const live = signals.filter((s): s is AbortSignal => Boolean(s))
  if (live.length === 0) return undefined
  if (live.length === 1) return { signal: live[0], cleanup: () => undefined }

  const controller = new AbortController()
  const onAbort = () => controller.abort()

  const already = live.find((s) => s.aborted)
  if (already) {
    controller.abort()
    return { signal: controller.signal, cleanup: () => undefined }
  }

  for (const s of live) s.addEventListener("abort", onAbort, { once: true })
  const cleanup = () => {
    for (const s of live) {
      try {
        s.removeEventListener("abort", onAbort)
      } catch {
        /* DOM-shim differences — swallow */
      }
    }
  }
  return { signal: controller.signal, cleanup }
}

/**
 * Acquire a broker lease, run `fn` with it, and release exactly once — `"ok"`
 * on success, `"cancelled"` when the lease was cancelled, `"error"` otherwise.
 * The lease (and therefore its `signal`) is passed to `fn`. Re-throws whatever
 * `fn` throws after releasing.
 */
export async function runWithExecutionLease<T>(
  request: ExecutionLeaseRequest,
  fn: (lease: ExecutionLease) => Promise<T>,
  broker: ExecutionBroker = getExecutionBroker()
): Promise<T> {
  const lease = await broker.acquire(request)
  try {
    const result = await fn(lease)
    lease.release("ok")
    return result
  } catch (err) {
    lease.release(lease.cancelled ? "cancelled" : "error")
    throw err
  }
}
