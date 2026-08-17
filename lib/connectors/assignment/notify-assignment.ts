/**
 * Assignment-change notification (IM delegation slice 1A).
 *
 * `setAssignee` syncs routing / mode but is a pure DB primitive; the operator
 * still needs to SEE that a conversation landed on their plate (or left it),
 * so every assignment transition surfaces through the Notification Center
 * (`center` + `toast`) with a deep link back to the conversation. Coalesced
 * per conversation via `dedupeKey = assign:<conversationKey>` so a rapid
 * reassign burst produces one row with a bumped count instead of a pile.
 *
 * PATTERN NOTE — like `IM_FAILURE_NOTICE` in `lib/connectors/runtime.ts`,
 * these strings cannot use next-intl (this runs outside the React tree and
 * from the escalation sweep), so the canned texts are inline bilingual
 * "zh / en" and live in ONE named table for a future locale-bag refactor.
 */

import type { ConversationAssignee } from "@/lib/db/conversation-overrides"
import { notify } from "@/lib/notifications/runtime"

export const ASSIGNMENT_NOTICE = {
  assigned: {
    title: "会话已分配 / Conversation assigned",
    body: (to: string) => `已分配给 ${to} / Assigned to ${to}`,
  },
  reassigned: {
    title: "会话已改派 / Conversation reassigned",
    body: (from: string, to: string) => `${from} → ${to}`,
  },
  unassigned: {
    title: "会话已取消分配 / Conversation unassigned",
    body: (from: string) => `原分配 ${from} 已解除 / ${from} no longer holds this conversation`,
  },
} as const

/** Human label for an assignee in notification text (bilingual for `human`). */
export function describeAssignee(assignee: ConversationAssignee | null | undefined): string {
  if (!assignee) return "无 / none"
  if (assignee.kind === "human") return "人工 / me"
  const name = assignee.label?.trim() || assignee.id?.trim() || "?"
  return assignee.kind === "team"
    ? `团队 ${name} / team ${name}`
    : `角色 ${name} / character ${name}`
}

export interface NotifyAssignmentChangedInput {
  conversationKey: string
  from: ConversationAssignee | null | undefined
  to: ConversationAssignee | null | undefined
  /** Provenance recorded on the trail ("manual", "sla-escalation", …). */
  via: string
}

/** Deep link into the inbox conversation. */
export function assignmentHref(conversationKey: string): string {
  return `/inbox/c?key=${encodeURIComponent(conversationKey)}`
}

/**
 * Notify the operator that a conversation's assignee changed. Best-effort:
 * never throws (a notification failure must not undo the assignment). No-op
 * when nothing actually changed.
 */
export async function notifyAssignmentChanged(input: NotifyAssignmentChangedInput): Promise<void> {
  const from = input.from ?? null
  const to = input.to ?? null
  if (sameAssignee(from, to)) return
  const kind = !to ? "unassigned" : from ? "reassigned" : "assigned"
  const notice = ASSIGNMENT_NOTICE[kind]
  const body =
    kind === "assigned"
      ? ASSIGNMENT_NOTICE.assigned.body(describeAssignee(to))
      : kind === "reassigned"
        ? ASSIGNMENT_NOTICE.reassigned.body(describeAssignee(from), describeAssignee(to))
        : ASSIGNMENT_NOTICE.unassigned.body(describeAssignee(from))
  try {
    await notify({
      source: "connector",
      level: input.via === "sla-escalation" ? "warning" : "info",
      title: notice.title,
      body: `${body}（${input.via}）`,
      channels: ["center", "toast"],
      href: assignmentHref(input.conversationKey),
      groupKey: input.conversationKey,
      dedupeKey: `assign:${input.conversationKey}`,
      sourceRef: { kind: "conversation", id: input.conversationKey },
      // "You now hold this conversation" is directed; everything else is ambient.
      directed: to?.kind === "human",
      meta: { kind, via: input.via, from, to },
    })
  } catch {
    // Best-effort — see doc comment.
  }
}

function sameAssignee(a: ConversationAssignee | null, b: ConversationAssignee | null): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.kind === b.kind && (a.id ?? undefined) === (b.id ?? undefined)
}
