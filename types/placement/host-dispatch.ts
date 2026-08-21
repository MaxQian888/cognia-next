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
  | "succeeded"
  | "failed"
  /** Exhausted its attempts; needs a human, never retried automatically. */
  | "deadletter"

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
}
