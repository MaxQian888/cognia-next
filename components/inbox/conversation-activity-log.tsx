"use client"

/**
 * Conversation activity log — the system-event timeline (edits, deletes, member
 * changes, read receipts, deferrals, help/welcome cards, IM goal start/block,
 * Computer-Use toggles) for the open conversation, interleaved with the CRM
 * assignment trail.
 *
 * Presentation only: `InboxNoticeArea` owns the queries and the disclosure, so
 * this no longer carries its own toggle.
 *
 * Deliberately a *separate* surface from the shared `<ChatPane />` message list
 * (which owns the actual messages) to keep that component untouched.
 */

import { useFormatter, useNow, useTranslations } from "next-intl"
import { ActivityIcon } from "lucide-react"
import type { AuditEntry, AuditKind } from "@/types/connectors/audit"
import type { AssignmentEventKind } from "@/lib/db/crm-types"
import type { ConversationAssignmentEventRow } from "@/lib/db/crm-types"
import { NoticeItem } from "./notices/notice-item"

/** Maps each surfaced audit kind to its dot-free i18n key under `inbox.activity.kind`. */
const KIND_LABEL_KEY: Partial<Record<AuditKind, string>> = {
  "inbound.edited": "inboundEdited",
  "inbound.deleted": "inboundDeleted",
  "inbound.read_indicator": "inboundReadIndicator",
  "inbound.member_added": "inboundMemberAdded",
  "inbound.member_removed": "inboundMemberRemoved",
  "inbound.reaction_added": "inboundReactionAdded",
  "inbound.reaction_removed": "inboundReactionRemoved",
  "inbound.poke": "inboundPoke",
  "inbound.request": "inboundRequest",
  "inbound.lifecycle": "inboundLifecycle",
  "inbound.deferred_quiet_hours": "inboundDeferredQuietHours",
  "inbound.deferred_muted": "inboundDeferredMuted",
  "inbound.help_served": "inboundHelpServed",
  "inbound.welcome_sent": "inboundWelcomeSent",
  "goal.started.im": "goalStartedIm",
  "goal.blocked.im": "goalBlockedIm",
  "override.computer_use_changed": "overrideComputerUseChanged",
  // Silent-reply diagnostics — why THIS conversation produced no reply.
  "inbound.policy_blocked": "inboundPolicyBlocked",
  "inbound.deferred_manual_mode": "inboundDeferredManualMode",
  "delivery.error": "deliveryError",
  "delivery.deadlettered": "deliveryDeadlettered",
  "plugin.inbound_blocked": "pluginInboundBlocked",
  "plugin.rate_blocked": "pluginRateBlocked",
  "plugin.transform_pii_blocked": "pluginTransformPiiBlocked",
  "notify.im_pii_blocked": "notifyImPiiBlocked",
  "workflow.dispatched": "workflowDispatched",
  "team.dispatched": "teamDispatched",
  "dispatch.rule_matched": "dispatchRuleMatched",
  // Chat management (W2 multi-bot).
  "conversation.created": "conversationCreated",
  "broadcast.enqueued": "broadcastEnqueued",
  "broadcast.partial_failure": "broadcastPartialFailure",
  // Task dispatch (W4 任务派发).
  "task.dispatched": "taskDispatched",
  // Sibling-bot guard + multi-identity team posting (W5 multi-bot same-group).
  "inbound.sibling_bot_ignored": "siblingBotIgnored",
  "inbound.sibling_bot_budget_exhausted": "siblingBotBudgetExhausted",
  "team.posted_as_bot": "teamPostedAsBot",
}

/** Maps each assignment-trail kind to its i18n key under `inbox.activity.assignment`. */
const ASSIGNMENT_LABEL_KEY: Record<AssignmentEventKind, string> = {
  assigned: "assigned",
  unassigned: "unassigned",
  reassigned: "reassigned",
  "status.open": "statusOpen",
  "status.pending": "statusPending",
  "status.snoozed": "statusSnoozed",
  "status.resolved": "statusResolved",
  "label.added": "labelAdded",
  "label.removed": "labelRemoved",
}

interface ActivityRow {
  id: string
  label: string
  /** Machine reason code (e.g. `pii_blocked`) shown after the label for diagnostics. */
  reason?: string
  at: number
}

export interface ConversationActivityNoticeProps {
  auditEntries: AuditEntry[]
  assignmentEvents: ConversationAssignmentEventRow[]
}

export function ConversationActivityNotice({
  auditEntries,
  assignmentEvents,
}: ConversationActivityNoticeProps) {
  const t = useTranslations("inbox.activity")
  const format = useFormatter()
  const now = useNow()

  // Interleave connector-audit rows and the CRM assignment trail into one
  // newest-first timeline. Both carry an `at` epoch so they sort cleanly.
  const entries: ActivityRow[] = [
    ...auditEntries.map((e) => ({
      id: e.id,
      label: KIND_LABEL_KEY[e.kind] ? t(`kind.${KIND_LABEL_KEY[e.kind]}`) : e.kind,
      reason: e.reason,
      at: e.at,
    })),
    ...assignmentEvents.map((e) => ({
      id: e.id,
      label: t(`assignment.${ASSIGNMENT_LABEL_KEY[e.kind]}`),
      at: e.at,
    })),
  ].sort((a, b) => b.at - a.at)

  if (entries.length === 0) return null

  return (
    <NoticeItem
      severity="info"
      icon={<ActivityIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      data-testid="conversation-activity-log"
      title={
        <span className="flex items-center gap-1.5 font-normal text-muted-foreground">
          {t("title")}
          <span className="text-[10px]">{t("count", { count: entries.length })}</span>
        </span>
      }
    >
      <ul className="mt-0.5" data-testid="activity-log-list">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="flex items-center gap-2 py-0.5"
            data-testid={`activity-row-${entry.id}`}
          >
            <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
            <span className="min-w-0 flex-1 truncate">
              {entry.label}
              {entry.reason ? (
                <span className="text-muted-foreground"> · {entry.reason}</span>
              ) : null}
            </span>
            <span className="whitespace-nowrap text-[10px] text-muted-foreground">
              {format.relativeTime(new Date(entry.at), now)}
            </span>
          </li>
        ))}
      </ul>
    </NoticeItem>
  )
}
