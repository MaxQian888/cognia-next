/**
 * Deterministic idempotency keys for triggers that more than one host can fire.
 *
 * The invocation ledger in `execution-authority.ts` is sound — deterministic
 * primary key, single-transaction insert, duplicate `add` resolving to the
 * existing row — and it was being bypassed. `dispatchTrigger` passed no key at
 * all, so every trigger minted a random invocation id and the ledger lookup was
 * skipped outright; the scheduler passed `${taskId}:${executionId}`, and the
 * execution row is minted per host, so two hosts firing the same cron occurrence
 * produced two different keys and ran the workflow twice.
 *
 * The fix is to derive the key from what the hosts *agree* on: the workflow, the
 * trigger, and the instant the schedule says it should fire.
 */

/**
 * Trigger kinds where "the same event" is a coherent idea across hosts.
 *
 * A manual click or a chat message is inherently one host's event — two of them
 * are two events, and collapsing them would swallow a run the user asked for.
 * Only time-derived and externally-identified triggers can legitimately arrive
 * at two hosts as the same occurrence.
 */
const SHARED_TRIGGER_KINDS = new Set([
  "trigger.cron",
  "trigger.schedule",
  "trigger.webhook",
  "trigger.connector.inbound",
  "trigger.connector.system",
])

/**
 * Granularity two hosts must agree to within.
 *
 * Cron cannot fire the same trigger twice inside one second, so rounding to a
 * second can never merge two genuine occurrences — but it does absorb the
 * sub-second clock skew between hosts that would otherwise mint two keys for
 * one fire.
 */
const ALIGNMENT_MS = 1_000

export interface TriggerIdempotencyInput {
  workflowId: string
  triggerKind: string
  triggerId?: string
  /** The scheduled instant, not the moment this host got around to it. */
  originAt?: number
}

export function isSharedTriggerKind(kind: string): boolean {
  return SHARED_TRIGGER_KINDS.has(kind)
}

/**
 * A key both hosts compute identically, or `undefined` when the trigger is
 * inherently single-host and must keep minting a fresh invocation.
 */
export function deterministicTriggerIdempotencyKey(
  input: TriggerIdempotencyInput
): string | undefined {
  if (!isSharedTriggerKind(input.triggerKind)) return undefined
  if (typeof input.originAt !== "number" || !Number.isFinite(input.originAt)) return undefined
  const aligned = Math.floor(input.originAt / ALIGNMENT_MS) * ALIGNMENT_MS
  // `triggerId` scopes the key to one trigger on the workflow: two cron
  // triggers on the same workflow firing in the same second are two runs.
  return `trg:${input.workflowId}:${input.triggerId ?? input.triggerKind}:${aligned}`
}

/**
 * The key for one scheduled occurrence of a task.
 *
 * Deliberately keyed on the occurrence, never on the local execution row: the
 * execution id is minted per host, which is what let the same cron tick run on
 * two machines.
 */
export function scheduledOccurrenceIdempotencyKey(input: {
  taskId: string
  scheduledFor?: number
  fallbackExecutionId: string
}): string {
  if (typeof input.scheduledFor === "number" && Number.isFinite(input.scheduledFor)) {
    const aligned = Math.floor(input.scheduledFor / ALIGNMENT_MS) * ALIGNMENT_MS
    return `sched:${input.taskId}:${aligned}`
  }
  // An ad-hoc "run now" has no scheduled instant to agree on, and two of them
  // really are two runs — fall back to the per-host execution id.
  return `${input.taskId}:${input.fallbackExecutionId}`
}
