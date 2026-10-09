"use client"

/**
 * Conversation assignee control (CRM, schema v83). A compact chip showing who
 * owns the conversation (kind dot + label) and, on click, lets the operator
 * (re)assign it to themselves ("Me"), to one of the bound characters, to an
 * Agent Team, or unassign it. Writes via setAssignee, which records the
 * transition on the assignment-event trail AND syncs routing (slice 1A:
 * character / team → override routing, human → manual mode, unassign →
 * restore); the Notification Center is told afterwards. The app is
 * single-user, so "human" carries no id.
 *
 * Mirrors LifecycleStatusChip's shape (DropdownMenu + write + toast on error).
 */

import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"
import type { ConversationAssignee } from "@/lib/db/conversation-overrides"
import { notifyAssignmentChanged } from "@/lib/connectors/assignment/notify-assignment"
import {
  ASSIGNEE_KIND_DOT,
  AssigneeMenuItems,
  TRIAGE_DROPDOWN_KIT,
  useAssigneeLabel,
} from "./triage-menu-items"

export interface AssigneeChipProps {
  conversationKey: string
  sessionId: string
  /** Bus-level adapter id — stamped on the routing-sync audit row. */
  adapterId?: string
  assignee?: ConversationAssignee
}

export function AssigneeChip({
  conversationKey,
  sessionId,
  adapterId,
  assignee,
}: AssigneeChipProps) {
  const t = useTranslations("inbox.assignee")
  const labelOf = useAssigneeLabel()

  const apply = async (next: ConversationAssignee | null) => {
    try {
      await mutateConversationOverride({
        kind: "setAssignee",
        conversationKey,
        assignee: next,
        sessionId,
        via: "manual",
        adapterId,
      })
      await notifyAssignmentChanged({
        conversationKey,
        from: assignee ?? null,
        to: next,
        via: "manual",
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const label = labelOf(assignee)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          data-testid="assignee-chip"
          aria-label={t("aria", { assignee: label })}
        >
          <span
            className={cn(
              "size-2 rounded-full",
              assignee ? ASSIGNEE_KIND_DOT[assignee.kind] : "bg-muted-foreground"
            )}
            aria-hidden
          />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* Shared with the row menu, the keyboard's `i` menu, the bulk bar and
            the phone sheet (`triage-menu-items.tsx`). */}
        <AssigneeMenuItems
          kit={TRIAGE_DROPDOWN_KIT}
          current={assignee ?? null}
          onAssign={(next) => void apply(next)}
          routingNote
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
