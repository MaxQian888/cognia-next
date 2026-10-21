/**
 * The plugin contract's share of `lib/connectors/outbound-runner.ts`, which re-exports these.
 */
import type { CircuitBreakerSnapshot } from "./circuit-breaker"
import type { TokenBucketSnapshot } from "./rate-limit"

/**
 * Snapshot of the per-adapter outbound runtime state. The heartbeat probe
 * writes this into the `adapter.heartbeat` audit row so the Health Detail
 * panel can render current circuit / rate-limit metadata without holding
 * a reference to the runner.
 */
export interface AdapterRuntimeStateSnapshot {
  breaker: CircuitBreakerSnapshot
  bucket: TokenBucketSnapshot
}
