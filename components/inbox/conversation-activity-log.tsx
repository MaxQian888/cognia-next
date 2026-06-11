"use client"

/**
 * Conversation activity log — a collapsible strip in the Inbox detail pane that
 * lists system events (edits, deletes, member changes, read receipts, deferrals,
 * help/welcome cards, IM goal start/block, Computer-Use toggles) for the open
 * conversation. Reads `connectorAudit` via `useConversationActivity`; renders
 * nothing when there's no activity, so quiet conversations stay uncluttered.
 *
 * Deliberately a *separate* surface from the shared `<ChatPane />` message list
 * (which owns the actual messages) to keep that component untouched.
 */

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { ActivityIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConversationActivity } from "@/hooks/connectors/use-conversation-activity"
import { useConversationAssignmentEvents } from "@/hooks/connectors/use-conversation-assignment-events"
import type { AuditKind } from "@/types/connectors/audit"
import type { AssignmentEventKind } from "@/lib/db/crm-types"

/** Maps each surfaced audit kind to its dot-free i18n key under `inbox.activity.kind`. */
const KIND_LABEL_KEY: Partial<Record<AuditKind, string>> = {
  "inbound.edited": "inboundEdited",
  "inbound.deleted": "inboundDeleted",
  "inbound.read_indicator": "inboundReadIndicator",
  "inbound.member_added": "inboundMemberAdded",
  "inbound.member_removed": "inboundMemberRemoved",
  "inbound.deferred_quiet_hours": "inboundDeferredQuietHours",
  "inbound.deferred_muted": "inboundDeferredMuted",
  "inbound.help_served": "inboundHelpServed",
  "inbound.welcome_sent": "inboundWelcomeSent",
  "goal.started.im": "goalStartedIm",
  "goal.blocked.im": "goalBlockedIm",
  "override.computer_use_changed": "overrideComputerUseChanged",
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
  at: number
}

export function ConversationActivityLog({ conversationKey }: { conversationKey: string }) {
  const t = useTranslations("inbox.activity")
  const format = useFormatter()
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  const auditEntries = useConversationActivity(conversationKey)
  const assignmentEvents = useConversationAssignmentEvents(conversationKey)

  // Interleave connector-audit rows and the CRM assignment trail into one
  // newest-first timeline. Both carry an `at` epoch so they sort cleanly.
  const entries: ActivityRow[] = [
    ...auditEntries.map((e) => ({
      id: e.id,
      label: KIND_LABEL_KEY[e.kind] ? t(`kind.${KIND_LABEL_KEY[e.kind]}`) : e.kind,
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
    <div className="shrink-0 border-b" data-testid="conversation-activity-log">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-1.5 rounded-none px-3 py-1.5 text-xs text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t("toggle")}
        data-testid="activity-log-toggle"
      >
        {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        <ActivityIcon className="size-3" />
        <span>{t("title")}</span>
        <span className="ml-1 text-[10px]">{t("count", { count: entries.length })}</span>
      </Button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            className="overflow-hidden px-3 pb-2"
            data-testid="activity-log-list"
          >
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-2 py-0.5 text-xs"
                data-testid={`activity-row-${entry.id}`}
              >
                <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                <span className="flex-1 truncate">{entry.label}</span>
                <span className="whitespace-nowrap text-[10px] text-muted-foreground">
                  {format.relativeTime(new Date(entry.at))}
                </span>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}
