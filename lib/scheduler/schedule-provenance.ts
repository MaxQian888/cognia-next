/**
 * Where an IM-authored schedule came from: the conversation and the person
 * who typed `/schedule` there (`lib/connectors/commands/schedule.ts`).
 *
 * It lives in the task's payload under {@link SCHEDULE_PROVENANCE_KEY} and two
 * things trust it. `/tasks` and the per-conversation quotas list a
 * conversation's schedules by it, and the outbound policy engine (ADR-0239)
 * treats that conversation as the task's origin thread, which it may deliver
 * to without asking. A provenance anyone could write would therefore be a way
 * to authorize a recipient, so the scheduler owns it:
 *
 * - `createTask` drops any provenance in the input payload and records only
 *   the one passed as its trusted option, which only the host-side `/schedule`
 *   handler passes. The paired-device RPC, the scheduler skill, plugins,
 *   workflow nodes and imports all go through the input payload alone.
 * - `updateTask` and `importTasks` never write it: an update keeps the stored
 *   value whatever the patch says, and an imported task arrives without one.
 *
 * Pure: no database or scheduler imports.
 */

import type { ScheduledTaskPayload } from "@/types/scheduler"

export const SCHEDULE_PROVENANCE_KEY = "scheduleProvenance"

export interface ImScheduleProvenance {
  source: "im"
  adapterId: string
  conversationKey: string
  /** The platform user id (`sender.remoteUserId`) of the person who scheduled it. */
  senderId: string
}

function isProvenance(value: unknown): value is ImScheduleProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (
    v.source === "im" &&
    typeof v.adapterId === "string" &&
    v.adapterId.length > 0 &&
    typeof v.conversationKey === "string" &&
    v.conversationKey.length > 0 &&
    typeof v.senderId === "string" &&
    v.senderId.length > 0
  )
}

/** The provenance a stored task carries, or `null` when it has none or it is malformed. */
export function readScheduleProvenance(task: {
  payload?: ScheduledTaskPayload
}): ImScheduleProvenance | null {
  const raw = (task.payload as Record<string, unknown> | undefined)?.[SCHEDULE_PROVENANCE_KEY]
  return isProvenance(raw) ? raw : null
}

/** `payload` without a provenance key; the same object when it has none. */
export function withoutScheduleProvenance<T extends ScheduledTaskPayload | undefined>(
  payload: T
): T {
  if (!payload || !(SCHEDULE_PROVENANCE_KEY in payload)) return payload
  const { [SCHEDULE_PROVENANCE_KEY]: _dropped, ...rest } = payload as Record<string, unknown>
  return rest as T
}

/**
 * The payload to store for a new task: the input's own fields, with the
 * provenance replaced by `trusted` (or removed when there is none).
 */
export function payloadWithTrustedProvenance(
  payload: ScheduledTaskPayload | undefined,
  trusted: ImScheduleProvenance | undefined
): ScheduledTaskPayload | undefined {
  const rest = withoutScheduleProvenance(payload)
  if (!trusted) return rest
  return { ...(rest ?? {}), [SCHEDULE_PROVENANCE_KEY]: { ...trusted } }
}
