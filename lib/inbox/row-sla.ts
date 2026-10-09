/**
 * The SLA signal a conversation ROW shows.
 *
 * The triage pane and the chat header carry the full `SlaBadge` ("Due in 2h",
 * escalation level). A list row has room for one glance, and a deadline three
 * hours out is not news, so the row only speaks up when the clock matters:
 * overdue, or due within {@link SLA_NEAR_DUE_MS}. Everything else stays quiet.
 */

import { isOverdue } from "@/lib/connectors/sla"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"

/** A reply due within this window is flagged on the row. */
export const SLA_NEAR_DUE_MS = 30 * 60 * 1000

export type RowSlaState = { kind: "overdue" } | { kind: "nearDue"; remainingMs: number }

export function rowSlaState(
  override: Pick<ConversationOverrideRow, "nextResponseDueAt" | "status"> | undefined,
  now: number
): RowSlaState | null {
  const due = override?.nextResponseDueAt
  if (!due || override?.status === "resolved") return null
  if (isOverdue(override, now)) return { kind: "overdue" }
  const remainingMs = due - now
  return remainingMs <= SLA_NEAR_DUE_MS ? { kind: "nearDue", remainingMs } : null
}

/** Minutes left, rounded up so "due in 0m" never shows while time remains. */
export function remainingMinutes(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 60_000))
}
