/**
 * Conversation SLA helpers (CRM maturation). Pure functions that compute
 * response-due deadlines and overdue state. Quiet-hours windows are excluded
 * from the SLA budget — a deadline that would land inside a quiet window is
 * pushed to when the window ends — reusing the connector outbound-runner's
 * quiet-hours math so the two subsystems agree on "when is the channel asleep".
 */

import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import { isInQuietHours, msUntilQuietEnd } from "@/lib/connectors/outbound-runner"
import { readForResolution, setSlaDue } from "@/lib/db/conversation-overrides"

export interface QuietHours {
  from: string
  to: string
  tz: string
}

/**
 * Compute an SLA due timestamp `targetMinutes` after `fromMs`. When quiet hours
 * are supplied and the naive deadline falls inside a quiet window, the deadline
 * is moved to the end of that window (the operator isn't expected to answer
 * while the channel is quiet). One hop is enough for the single contiguous
 * window the quiet-hours model supports.
 */
export function computeDueAt(
  fromMs: number,
  targetMinutes: number,
  quietHours?: QuietHours | null
): number {
  const naive = fromMs + Math.max(0, targetMinutes) * 60_000
  if (!quietHours) return naive
  if (!isInQuietHours(naive, quietHours.from, quietHours.to, quietHours.tz)) return naive
  return naive + msUntilQuietEnd(naive, quietHours.to, quietHours.tz)
}

/**
 * Whether the conversation has breached its next-response SLA: a due time set,
 * in the past, and the conversation is not already resolved.
 */
export function isOverdue(
  row: Pick<ConversationOverrideRow, "nextResponseDueAt" | "status"> | undefined,
  now: number = Date.now()
): boolean {
  if (!row?.nextResponseDueAt) return false
  if (row.status === "resolved") return false
  return row.nextResponseDueAt < now
}

/**
 * Stamp `nextResponseDueAt` for a conversation from
 * `override.slaResponseMinutes ?? adapter.defaultSlaResponseMinutes`
 * (IM delegation slice 1B — bot-wide SLA default). Idempotent: only writes
 * when the row has no pending deadline (`nextResponseDueAt === undefined`),
 * so calling it from BOTH the bus inbound step (which cannot create the
 * override row before the first platform session exists) and the runtime
 * right after `createPlatformSession` never double-stamps. Quiet hours: the
 * conversation window first, then the adapter window (same precedence the
 * outbound runner uses). Returns true when a deadline was written.
 *
 * Deps are injectable so the runtime test can pin the call without Dexie.
 */
export async function stampSlaDeadline(
  input: {
    conversationKey: string
    sessionId: string
    adapter: Pick<AdapterInstanceRow, "defaultSlaResponseMinutes" | "quietHours">
    now?: number
  },
  deps: {
    readOverride?: (conversationKey: string) => Promise<ConversationOverrideRow | undefined>
    setSlaDue?: (
      conversationKey: string,
      due: { nextResponseDueAt?: number },
      sessionId?: string
    ) => Promise<void>
  } = {}
): Promise<boolean> {
  const readOverride = deps.readOverride ?? readForResolution
  const write = deps.setSlaDue ?? setSlaDue
  const row = await readOverride(input.conversationKey)
  if (row?.nextResponseDueAt !== undefined) return false
  const minutes = row?.slaResponseMinutes ?? input.adapter.defaultSlaResponseMinutes
  if (!minutes || minutes <= 0) return false
  const now = input.now ?? Date.now()
  await write(
    input.conversationKey,
    {
      nextResponseDueAt: computeDueAt(
        now,
        minutes,
        row?.quietHours ?? input.adapter.quietHours ?? null
      ),
    },
    input.sessionId
  )
  return true
}
