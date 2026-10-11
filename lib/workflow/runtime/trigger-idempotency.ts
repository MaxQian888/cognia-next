/**
 * Occurrence keys for triggers (ADR-0136 §4, ADR-0224 A9).
 *
 * The invocation ledger in `execution-authority.ts` is sound — deterministic
 * primary key, single-transaction insert, duplicate `add` resolving to the
 * existing row — and it only works when the caller passes a key. The key must
 * name the occurrence, never the moment or the host that noticed it:
 *
 * - **Time-derived triggers** (cron, schedule) key on the slot the schedule
 *   named. The cron daemon reports the slot, not its wake time, so a host that
 *   slept through the slot and fires it late computes the same key.
 * - **Event triggers** (webhook, connector, integration) key on the source's
 *   own id for the event: a provider delivery id, a platform message id. A
 *   timestamp is never an event's identity — two webhooks in the same second
 *   are two runs. An event with no such id gets no key and runs once per
 *   arrival.
 * - **Everything else** (a manual click, a chat message) is one host's event:
 *   two of them are two runs, so it never gets a key.
 *
 * What the ledger absorbs: the ledger lives in each host's own account
 * database. A key therefore absorbs a duplicate on the host that holds it —
 * a redelivered webhook, a connector event replayed after a restart, a slot
 * reached by two fire paths. Two hosts compute the same key for the same
 * occurrence, but nothing shares a ledger between them, so this does not stop
 * two hosts running it. Placement (ADR-0136 §3) keeps a schedule on one host;
 * the key is what a cross-host fence would compare.
 */

/** Triggers whose occurrence is a slot of a schedule. */
const SLOT_TRIGGER_KINDS = new Set(["trigger.cron", "trigger.schedule"])

/** Triggers whose occurrence is identified by the source that sent it. */
const EVENT_TRIGGER_KINDS = new Set([
  "trigger.webhook",
  "trigger.connector.inbound",
  "trigger.connector.system",
  "trigger.integration.event",
])

/**
 * Granularity a slot is aligned to.
 *
 * Cron cannot fire the same trigger twice inside one second, so rounding to a
 * second can never merge two genuine slots, and it absorbs a sub-second
 * difference between two clocks that computed the same slot.
 */
const ALIGNMENT_MS = 1_000

export interface TriggerIdempotencyInput {
  workflowId: string
  triggerKind: string
  triggerId?: string
  /** For a slot trigger, the scheduled instant, not when a host got to it. */
  originAt?: number
  /** For an event trigger, the source's own id for the event. */
  occurrenceKey?: string
}

/** True when the trigger kind can be keyed at all. */
export function isSharedTriggerKind(kind: string): boolean {
  return SLOT_TRIGGER_KINDS.has(kind) || EVENT_TRIGGER_KINDS.has(kind)
}

/** Align an instant to the slot granularity. */
export function alignOccurrenceInstant(ms: number): number {
  return Math.floor(ms / ALIGNMENT_MS) * ALIGNMENT_MS
}

/**
 * The occurrence's key, or `undefined` when the trigger has no occurrence
 * identity and must mint a fresh invocation.
 */
export function deterministicTriggerIdempotencyKey(
  input: TriggerIdempotencyInput
): string | undefined {
  // `triggerId` scopes the key to one trigger on the workflow: two cron
  // triggers on the same workflow firing in the same second are two runs.
  const scope = `trg:${input.workflowId}:${input.triggerId ?? input.triggerKind}`
  if (SLOT_TRIGGER_KINDS.has(input.triggerKind)) {
    if (typeof input.originAt !== "number" || !Number.isFinite(input.originAt)) return undefined
    return `${scope}:${alignOccurrenceInstant(input.originAt)}`
  }
  if (EVENT_TRIGGER_KINDS.has(input.triggerKind)) {
    const occurrence = input.occurrenceKey?.trim()
    return occurrence ? `${scope}:occ:${occurrence}` : undefined
  }
  return undefined
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
    return `sched:${input.taskId}:${alignOccurrenceInstant(input.scheduledFor)}`
  }
  // An ad-hoc "run now" has no scheduled instant to agree on, and two of them
  // really are two runs — fall back to the per-host execution id.
  return `${input.taskId}:${input.fallbackExecutionId}`
}
