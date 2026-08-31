/**
 * Admission helpers shared by every turn driver that funnels through the
 * {@link ExecutionBroker}. Keeps the acquire → run → release dance (and the
 * caller-signal ⊕ lease-signal combination) in one tested place so the
 * chokepoints (`run-and-capture`, chat `send()`) don't each re-implement it.
 */

import { getExecutionBroker } from "./broker"
import type { ExecutionBroker } from "./broker"
import type { ExecutionLease, ExecutionLeaseRequest } from "./types"
export { combineAbortSignals } from "@cognia/plugin-sdk/api/abort"

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
