"use client"

/**
 * The triage property list: everything an operator changes about a
 * conversation without replying to it, as label → control rows.
 *
 * Status (with the snooze presets), assignee, labels, response SLA, pending
 * approvals, last inbound and running delegations come from the shared
 * `ConversationStatusControls` — the same group the chat header's `⋯` shows —
 * so the two surfaces cannot drift. Two rows are this pane's own:
 *
 *  - **Reply mode** — the behaviour preset, through the same
 *    `ConversationModeControl` the chat header mounts.
 *  - **Read state** — an explicit Mark read / Mark unread. The pane never
 *    marks anything read on its own: previewing is not reading, and the
 *    unread count, OS notifications and the phone relay all key off it.
 */

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"
import { MailIcon, MailOpenIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { markSessionRead, markSessionUnread } from "@/lib/db/session-state"
import { effectiveStatus } from "@/lib/db/conversation-overrides"
import type { TriageConversation } from "@/hooks/inbox/use-triage-conversation"
import {
  ControlItem,
  ControlList,
  ConversationStatusControls,
} from "../conversation-control-groups"
import { ConversationModeControl } from "../conversation-mode-control"

export interface TriageControlsProps {
  conversation: TriageConversation
  /** Opens the per-conversation settings dialog (the `custom` mode destination). */
  onOpenSettings: () => void
}

export function TriageControls({ conversation, onOpenSettings }: TriageControlsProps) {
  const t = useTranslations("inbox.triage.controls")
  const format = useFormatter()
  const { session, conversationKey, adapterId, override, unreadCount } = conversation
  const [readPending, setReadPending] = useState(false)
  const snoozedUntil =
    effectiveStatus(override) === "snoozed" && typeof override?.snoozeUntil === "number"
      ? override.snoozeUntil
      : null

  const toggleRead = async () => {
    if (readPending) return
    setReadPending(true)
    const markingRead = unreadCount > 0
    try {
      if (markingRead) await markSessionRead(session.id)
      else await markSessionUnread(session.id)
    } catch {
      toast.error(t(markingRead ? "markReadFailed" : "markUnreadFailed"))
    } finally {
      setReadPending(false)
    }
  }

  return (
    <ControlList aria-label={t("aria")} data-testid="triage-controls">
      <ConversationStatusControls
        layout="list"
        conversationKey={conversationKey}
        sessionId={session.id}
        adapterId={adapterId}
        overrideRow={override}
      />
      {snoozedUntil !== null && (
        <ControlItem label={t("snoozedUntil")} layout="list" testId="control-snoozed-until">
          <time
            className="text-xs tabular-nums text-muted-foreground"
            dateTime={new Date(snoozedUntil).toISOString()}
          >
            {format.dateTime(new Date(snoozedUntil), {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </time>
        </ControlItem>
      )}
      <ControlItem label={t("replyMode")} layout="list" testId="control-reply-mode">
        <ConversationModeControl
          conversationKey={conversationKey}
          sessionId={session.id}
          adapterId={adapterId}
          overrideRow={override}
          onOpenAdvanced={onOpenSettings}
        />
      </ControlItem>
      <ControlItem label={t("readState")} layout="list" testId="control-read-state">
        <span
          className="text-xs text-muted-foreground tabular-nums"
          data-testid="triage-unread-state"
        >
          {unreadCount > 0 ? t("unreadCount", { count: unreadCount }) : t("allRead")}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => void toggleRead()}
          disabled={readPending}
          data-testid="triage-toggle-read"
        >
          {unreadCount > 0 ? (
            <MailOpenIcon className="size-3.5" aria-hidden />
          ) : (
            <MailIcon className="size-3.5" aria-hidden />
          )}
          {unreadCount > 0 ? t("markRead") : t("markUnread")}
        </Button>
      </ControlItem>
    </ControlList>
  )
}
