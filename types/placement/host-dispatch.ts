/**
 * Durable host → target outbound dispatch.
 *
 * The 2026-08-20 audit found eleven cross-device dispatch paths and exactly one
 * that was durable, idempotent, and recoverable: `mobileOutboundQueue`, which
 * runs client → host. Everything in the *other* direction — a remote workflow
 * step, an `action.mobile.*` proxy call, a scheduler handoff — lived in memory
 * for the lifetime of one promise. A host that quit mid-dispatch simply lost it.
 *
 * This is the mirror-image queue. The semantics are deliberately copied from
 * `mobile-outbound-types.ts` (key minted once at enqueue and replayed on every
 * retry, exponential backoff, explicit dead-letter, a typed status machine)
 * because those semantics are correct and a second dialect of "roughly the same
 * queue" is how two subsystems drift apart. The *table* is separate because the
 * direction, the addressing, and the drain loop are all different.
 */

/**
 * What kind of work the row carries.
 *
 * One table with a discriminant rather than three tables: the runner, the
 * backoff, the dead-letter policy, and the recovery sweep are identical for all
 * three, and only the delivery call differs.
 */
export type HostDispatchDomain =
  /** A workflow step executing on a paired device (`action.mobile.*`). */
  | "mobile-step"
  /** A workflow step executing on an enrolled worker. */
  | "remote-step"
  /** A scheduled occurrence handed to the execution authority. */
  | "schedule-handoff"

export type HostDispatchStatus =
  | "pending"
  | "inflight"
  /** Delivery was acknowledged; the target still owes the durable result. */
  | "awaiting-result"
  | "succeeded"
  | "failed"
  | "cancelled"
  /** Exhausted its attempts; needs a human, never retried automatically. */
  | "deadletter"

/** Shared transport/storage limits for durable result assembly. */
export const HOST_DISPATCH_RESULT_CHUNK_CHARS = 32_768
export const HOST_DISPATCH_MAX_RESULT_CHARS = 8 * 1024 * 1024
export const HOST_DISPATCH_MAX_RESULT_CHUNKS = Math.ceil(
  HOST_DISPATCH_MAX_RESULT_CHARS / HOST_DISPATCH_RESULT_CHUNK_CHARS
)

export interface HostDispatchJobRow {
  /** UUIDv4 primary key. */
  id: string
  /** Local account that owns the row. Never inferred at drain time. */
  accountId: string
  domain: HostDispatchDomain
  /**
   * Where this is going, in the target's own vocabulary: a `hostRef` for a
   * worker, a `deviceId` for a paired device, a remote-host id for a handoff.
   */
  targetRef: string
  /** Delivery verb, interpreted by the domain's runner. */
  kind: string
  payload: Record<string, unknown>
  status: HostDispatchStatus
  attempts: number
  /** Attempts after which the row dead-letters rather than retrying forever. */
  maxAttempts: number
  lastError?: string
  createdAt: number
  updatedAt: number
  /** Epoch ms the runner may next attempt this row. */
  nextAttemptAt: number
  /** Overall deadline minted at enqueue; retries and restarts never extend it. */
  expiresAt: number
  /** Atomic claim lease. An expired lease is recoverable after a process crash. */
  leaseOwner?: string
  leaseExpiresAt?: number
  /**
   * Minted once at enqueue and replayed on every retry.
   *
   * This is what makes a retry safe: the receiving side dedupes on it, so a
   * host that crashed after sending but before recording the result does not
   * run the work twice when it comes back.
   */
  idempotencyKey: string
  /** The run this dispatch belongs to, when it is part of one. */
  runId?: string
  stepId?: string
  /** Free-form label for the queue UI. */
  label?: string
  /**
   * What the target minted for this dispatch — for a `schedule-handoff`, the
   * remote `runId`.
   *
   * The source Host deliberately does not mirror the remote run's events (that
   * would be a second execution journal for one run). It records the pointer so
   * the Runs surface can name where the work went and offer to open it there.
   * Its presence is also the admission watermark: once the target has minted a
   * run, cancelling at the source would leave that run orphaned.
   */
  remoteRunId?: string
  /** Persisted chunk assembly survives a Host process restart. */
  resultTotal?: number
  resultChunks?: Record<string, string>
  resultJson?: string
  terminalCode?: string
}
