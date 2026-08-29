/**
 * Apply Settings → Scheduled Tasks → "Defaults for new tasks" to a create draft.
 *
 * The defaults card has always persisted `SchedulerPermissionPolicy.taskDefaults`
 * (timezone, notification triggers/channels/webhook, execution timeout, retries,
 * missed-run + concurrency policy), and nothing anywhere read the field back:
 * `TaskForm` seeded every one of those inputs from `DEFAULT_EXECUTION_CONFIG` /
 * `DEFAULT_NOTIFICATION_CONFIG` literals instead. So the whole card was a form
 * that saved and then changed nothing. This is the missing read.
 *
 * Precedence, widest to narrowest — each layer only fills what the next one
 * left unset:
 *
 *   1. `TaskForm`'s own literals (whatever this function leaves `undefined`).
 *   2. These user defaults.
 *   3. The handed-over draft (`consumeScheduledTaskDraft`, the composer's
 *      "schedule this"), which named concrete values on purpose.
 *
 * Editing an existing task never goes through here — its stored config is the
 * only truth, and re-seeding it from today's defaults would silently rewrite a
 * task the user configured months ago.
 */

import type { CreateScheduledTaskInput, TaskDefaults } from "@/types/scheduler"

/** True when the value carries no information for the merge. */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === "string") return value.trim() === ""
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Merge `defaults` UNDER `draft`. Returns `undefined` only when the result
 * would carry nothing at all, so callers can keep passing `undefined` to
 * `TaskForm` and let it use its own literals.
 */
export function seedTaskDefaults(
  defaults: TaskDefaults | undefined,
  draft?: Partial<CreateScheduledTaskInput>
): Partial<CreateScheduledTaskInput> | undefined {
  const notification = mergeUnder(defaults?.notification, draft?.notification)
  const config = mergeUnder(defaults?.execution, draft?.config)

  // The timezone default belongs to the trigger, and a trigger without a
  // `type` is not a trigger — so it is only seeded onto a draft that already
  // has one. A blank create sheet gets its timezone from `TaskForm`'s own
  // `initialValues?.trigger?.timezone || "UTC"` fallback, which is why the
  // form ALSO consults the default (see `defaultTimezone` below).
  let trigger = draft?.trigger
  if (trigger && isEmpty(trigger.timezone) && !isEmpty(defaults?.timezone)) {
    trigger = { ...trigger, timezone: defaults?.timezone }
  }

  const seeded: Partial<CreateScheduledTaskInput> = {
    ...draft,
    ...(notification ? { notification } : {}),
    ...(config ? { config } : {}),
    ...(trigger ? { trigger } : {}),
  }
  return Object.keys(seeded).length > 0 ? seeded : undefined
}

/**
 * The timezone a blank create sheet should start on. Separate from
 * {@link seedTaskDefaults} because a blank sheet has no trigger object to
 * attach it to yet.
 */
export function defaultTaskTimezone(defaults: TaskDefaults | undefined): string | undefined {
  const tz = defaults?.timezone?.trim()
  return tz ? tz : undefined
}

/** Shallow merge where every `base` key is used only if `over` left it empty. */
function mergeUnder<T extends object>(
  base: Partial<T> | undefined,
  over: Partial<T> | undefined
): Partial<T> | undefined {
  if (!base && !over) return undefined
  if (!base) return over
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(over ?? {})) {
    if (!isEmpty(value)) out[key] = value
  }
  // Drop keys the default itself left empty so the form's own literals still
  // win over a default the user cleared (an empty channel list is "no
  // preference", not "notify nowhere" — the latter is the `none` channel).
  for (const key of Object.keys(out)) {
    if (isEmpty(out[key])) delete out[key]
  }
  return Object.keys(out).length > 0 ? (out as Partial<T>) : undefined
}
