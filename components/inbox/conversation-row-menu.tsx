"use client"

/**
 * The Inbox row's `⋯` menu.
 *
 * Two shapes from one trigger:
 *  - `full` (a click on `⋯`): read state, pin, status, snooze, assignee,
 *    labels and archive — the triage a row could only reach by opening the
 *    chat header's overflow before.
 *  - a quick list (`snooze` / `assign` / `label`), opened by the keyboard's
 *    `s` / `i` / `l` on the focused row: just that list, top level, anchored
 *    to the row the operator is looking at.
 *
 * Content is a component of its own, mounted by Radix only while the menu is
 * open, so its reads (characters, teams, the label catalog) run for the one
 * open menu, never once per row.
 *
 * Every choice is a `TriageAction`; the list runs it through
 * `useTriageActions`, the same path the bulk bar and the phone sheet use.
 */

import { useTranslations } from "next-intl"
import {
  AlarmClockIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  CircleDotIcon,
  MailIcon,
  MailOpenIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  TagIcon,
  UserRoundIcon,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  labelStateAcross,
  labelToggleAction,
  type TriageAction,
  type TriageTarget,
} from "@/lib/inbox/bulk-triage"
import { LABEL_MANAGER_HREF } from "./label-picker"
import {
  AssigneeMenuItems,
  LabelMenuItems,
  SnoozeMenuItems,
  StatusMenuItems,
  TRIAGE_DROPDOWN_KIT,
} from "./triage-menu-items"

/** Which list the menu shows: everything, or one quick list. */
export type ConversationRowMenuMode = "full" | "snooze" | "assign" | "label"

export interface ConversationRowMenuProps {
  target: TriageTarget
  /** `null` = closed. */
  mode: ConversationRowMenuMode | null
  onModeChange: (mode: ConversationRowMenuMode | null) => void
  onTriage: (action: TriageAction) => void
  /** Accessible name of the trigger. */
  triggerLabel: string
  /**
   * Where focus goes when a keyboard-opened quick list closes: back to the
   * row button the operator was on, not to the `⋯` trigger.
   */
  onCloseFocus?: () => boolean
}

export function ConversationRowMenu({
  target,
  mode,
  onModeChange,
  onTriage,
  triggerLabel,
  onCloseFocus,
}: ConversationRowMenuProps) {
  return (
    <DropdownMenu open={mode !== null} onOpenChange={(open) => onModeChange(open ? "full" : null)}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={triggerLabel}
          data-testid={`conversation-row-menu-${target.conversationKey}`}
        >
          <MoreHorizontalIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-48"
        onCloseAutoFocus={(event) => {
          if (mode !== "full" && onCloseFocus?.()) event.preventDefault()
        }}
      >
        {/* Radix mounts content only while open, so the reads inside run
            for the one open menu, not for every row. */}
        <ConversationRowMenuContent mode={mode ?? "full"} target={target} onTriage={onTriage} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ConversationRowMenuContent({
  mode,
  target,
  onTriage,
}: {
  mode: ConversationRowMenuMode
  target: TriageTarget
  onTriage: (action: TriageAction) => void
}) {
  const t = useTranslations("inbox.triageMenu")
  const tSession = useTranslations("desktop.sessionRow")
  const router = useRouter()
  const kit = TRIAGE_DROPDOWN_KIT
  const snoozed = target.status === "snoozed"

  const snoozeItems = (
    <SnoozeMenuItems
      kit={kit}
      snoozed={snoozed}
      onSnooze={(_key, until) =>
        onTriage({ kind: "setStatus", status: "snoozed", snoozeUntil: until })
      }
      onWake={() => onTriage({ kind: "setStatus", status: "open" })}
    />
  )
  const assigneeItems = (
    <AssigneeMenuItems
      kit={kit}
      current={target.assignee ?? null}
      onAssign={(assignee) => onTriage({ kind: "setAssignee", assignee })}
    />
  )
  const labelItems = (
    <LabelMenuItems
      kit={kit}
      stateOf={(labelId) => labelStateAcross(labelId, [target])}
      onToggle={(labelId, state) => onTriage(labelToggleAction(labelId, state))}
      onManage={() => router.push(LABEL_MANAGER_HREF)}
    />
  )

  if (mode === "snooze") {
    return (
      <>
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("snooze")}
        </DropdownMenuLabel>
        {snoozeItems}
      </>
    )
  }
  if (mode === "assign") {
    return (
      <>
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("assign")}
        </DropdownMenuLabel>
        {assigneeItems}
      </>
    )
  }
  if (mode === "label") return labelItems

  return (
    <>
      <DropdownMenuItem
        onSelect={() => onTriage(target.unread ? { kind: "markRead" } : { kind: "markUnread" })}
        data-testid="row-menu-toggle-read"
      >
        {target.unread ? <MailOpenIcon className="size-4" /> : <MailIcon className="size-4" />}
        {tSession(target.unread ? "markRead" : "markUnread")}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => onTriage({ kind: "setPinned", pinned: !target.pinned })}
        data-testid="row-menu-toggle-pin"
      >
        {target.pinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
        {tSession(target.pinned ? "unpin" : "pin")}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="row-menu-status">
          <CircleDotIcon className="size-4" />
          {t("status")}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <StatusMenuItems
            kit={kit}
            current={target.status}
            includeSnooze={false}
            onSetStatus={(status) => onTriage({ kind: "setStatus", status })}
          />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="row-menu-snooze">
          <AlarmClockIcon className="size-4" />
          {t("snooze")}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>{snoozeItems}</DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="row-menu-assign">
          <UserRoundIcon className="size-4" />
          {t("assign")}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>{assigneeItems}</DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="row-menu-labels">
          <TagIcon className="size-4" />
          {t("labels")}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>{labelItems}</DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => onTriage({ kind: "setArchived", archived: !target.archived })}
        data-testid="row-menu-toggle-archive"
      >
        {target.archived ? (
          <ArchiveRestoreIcon className="size-4" />
        ) : (
          <ArchiveIcon className="size-4" />
        )}
        {tSession(target.archived ? "unarchive" : "archive")}
      </DropdownMenuItem>
    </>
  )
}
