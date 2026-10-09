"use client"

/**
 * The action sheet behind a long-press on a phone Inbox row.
 *
 * The phone has no `⋯` hover menu and no keyboard, so this sheet is where its
 * whole triage vocabulary lives — the same options the desktop row menu and
 * bulk bar offer, drawn as large touch rows through the sheet kit
 * (`components/mobile/shell/session-row-sheet-kit.tsx`), with submenus as
 * second pages:
 *
 *   Preview · Select · Mark read/unread · Pin · Status ▸ · Snooze ▸ ·
 *   Assign ▸ · Labels ▸ · Archive
 *
 * Pattern and focus handling follow `mobile-channel-row-actions.tsx`. Every
 * write is a `TriageAction` the host runs through `useTriageActions`.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  AlarmClockIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckSquareIcon,
  CircleDotIcon,
  EyeIcon,
  MailIcon,
  MailOpenIcon,
  PinIcon,
  PinOffIcon,
  TagIcon,
  UserRoundIcon,
} from "lucide-react"

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { LABEL_MANAGER_HREF } from "@/components/inbox/label-picker"
import { PlatformBadge } from "@/components/inbox/platform-badge"
import {
  AssigneeMenuItems,
  LabelMenuItems,
  SnoozeMenuItems,
  StatusMenuItems,
  type TriageMenuKit,
} from "@/components/inbox/triage-menu-items"
import {
  SHEET_MENU_KIT,
  SessionRowSheetMenu,
  SheetHeading,
} from "@/components/mobile/shell/session-row-sheet-kit"
import {
  labelStateAcross,
  labelToggleAction,
  triageTargetOf,
  type TriageAction,
} from "@/lib/inbox/bulk-triage"
import type { ConversationRowItem } from "@/lib/inbox/conversation-grouping"
import type { PlatformKind } from "@/types/connectors/platform-kind"

/**
 * The sheet kit plus a plain group heading: the triage lists head their
 * groups ("Characters", "Teams", "Labels"), and the sheet's own `Label` is a
 * warning note.
 */
export const TRIAGE_SHEET_KIT: TriageMenuKit = { ...SHEET_MENU_KIT, Heading: SheetHeading }

export interface MobileConversationRowActionsProps {
  /** The conversation the sheet is for; `null` closes it. */
  row: ConversationRowItem | null
  onClose: () => void
  /** Open the triage preview drawer for this row. */
  onPreview: (row: ConversationRowItem) => void
  /** Start (or extend) selection mode with this row checked. Absent → no item. */
  onSelect?: (row: ConversationRowItem) => void
  /** Run a triage action on this row. */
  onRun: (action: TriageAction, row: ConversationRowItem) => void
}

export function MobileConversationRowActions(props: MobileConversationRowActionsProps) {
  const { row, onClose } = props
  // Keep the last row on screen while the sheet animates out; clearing it
  // with the prop would empty the sheet mid-slide.
  const [shown, setShown] = useState<ConversationRowItem | null>(row)
  if (row && row !== shown) setShown(row)

  return (
    <Drawer
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DrawerContent
        data-testid="mobile-conversation-actions"
        // A sideways drag on this sheet is not a request to put the navigation
        // drawer away underneath it (`hooks/ui/use-edge-swipe.ts`).
        data-edge-swipe-ignore=""
        className="pb-[env(safe-area-inset-bottom)]"
      >
        {shown ? <ActionsBody key={shown.session.id} {...props} row={shown} /> : null}
      </DrawerContent>
    </Drawer>
  )
}

function ActionsBody({
  row,
  onClose,
  onPreview,
  onSelect,
  onRun,
}: MobileConversationRowActionsProps & { row: ConversationRowItem }) {
  const t = useTranslations("mobile.inbox.rowActions")
  const tMenu = useTranslations("inbox.triageMenu")
  const tSession = useTranslations("desktop.sessionRow")
  const router = useRouter()
  const target = triageTargetOf(row)
  const binding = row.session.platformBinding
  const title = row.session.title || binding?.conversationKey || ""
  const K = TRIAGE_SHEET_KIT
  const run = (action: TriageAction) => onRun(action, row)

  return (
    <>
      <DrawerHeader className="gap-1 pb-2 text-left md:text-left">
        <DrawerTitle className="flex min-w-0 items-center gap-2 text-base">
          {binding ? (
            <span aria-hidden className="contents">
              <PlatformBadge platform={binding.platform as PlatformKind} iconOnly />
            </span>
          ) : null}
          <span className="truncate">{title}</span>
        </DrawerTitle>
        <DrawerDescription className="sr-only">{t("description")}</DrawerDescription>
      </DrawerHeader>
      <SessionRowSheetMenu label={title} onPicked={onClose}>
        <K.Item onSelect={() => onPreview(row)} data-testid="mobile-row-action-preview">
          <EyeIcon aria-hidden />
          {t("preview")}
        </K.Item>
        {onSelect ? (
          <K.Item onSelect={() => onSelect(row)} data-testid="mobile-row-action-select">
            <CheckSquareIcon aria-hidden />
            {tSession("select")}
          </K.Item>
        ) : null}
        <K.Separator />
        <K.Item
          onSelect={() => run(target.unread ? { kind: "markRead" } : { kind: "markUnread" })}
          data-testid="mobile-row-action-read"
        >
          {target.unread ? <MailOpenIcon aria-hidden /> : <MailIcon aria-hidden />}
          {tSession(target.unread ? "markRead" : "markUnread")}
        </K.Item>
        <K.Item
          onSelect={() => run({ kind: "setPinned", pinned: !target.pinned })}
          data-testid="mobile-row-action-pin"
        >
          {target.pinned ? <PinOffIcon aria-hidden /> : <PinIcon aria-hidden />}
          {tSession(target.pinned ? "unpin" : "pin")}
        </K.Item>
        <K.Sub>
          <K.SubTrigger data-testid="mobile-row-action-status">
            <CircleDotIcon aria-hidden />
            {tMenu("status")}
          </K.SubTrigger>
          <K.SubContent>
            <StatusMenuItems
              kit={K}
              current={target.status}
              includeSnooze={false}
              onSetStatus={(status) => run({ kind: "setStatus", status })}
            />
          </K.SubContent>
        </K.Sub>
        <K.Sub>
          <K.SubTrigger data-testid="mobile-row-action-snooze">
            <AlarmClockIcon aria-hidden />
            {tMenu("snooze")}
          </K.SubTrigger>
          <K.SubContent>
            <SnoozeMenuItems
              kit={K}
              snoozed={target.status === "snoozed"}
              onSnooze={(_key, until) =>
                run({ kind: "setStatus", status: "snoozed", snoozeUntil: until })
              }
              onWake={() => run({ kind: "setStatus", status: "open" })}
            />
          </K.SubContent>
        </K.Sub>
        <K.Sub>
          <K.SubTrigger data-testid="mobile-row-action-assign">
            <UserRoundIcon aria-hidden />
            {tMenu("assign")}
          </K.SubTrigger>
          <K.SubContent>
            <AssigneeMenuItems
              kit={K}
              current={target.assignee ?? null}
              onAssign={(assignee) => run({ kind: "setAssignee", assignee })}
            />
          </K.SubContent>
        </K.Sub>
        <K.Sub>
          <K.SubTrigger data-testid="mobile-row-action-labels">
            <TagIcon aria-hidden />
            {tMenu("labels")}
          </K.SubTrigger>
          <K.SubContent>
            <LabelMenuItems
              kit={K}
              stateOf={(labelId) => labelStateAcross(labelId, [target])}
              onToggle={(labelId, state) => run(labelToggleAction(labelId, state))}
              onManage={() => router.push(LABEL_MANAGER_HREF)}
            />
          </K.SubContent>
        </K.Sub>
        <K.Separator />
        <K.Item
          onSelect={() => run({ kind: "setArchived", archived: !target.archived })}
          data-testid="mobile-row-action-archive"
        >
          {target.archived ? <ArchiveRestoreIcon aria-hidden /> : <ArchiveIcon aria-hidden />}
          {tSession(target.archived ? "unarchive" : "archive")}
        </K.Item>
      </SessionRowSheetMenu>
    </>
  )
}
