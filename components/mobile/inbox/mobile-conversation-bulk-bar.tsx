"use client"

/**
 * The phone's bulk bar: a dock at the bottom of the Inbox list while the list
 * is in selection mode.
 *
 *   3 selected                         Select all · Clear
 *   [Read]  [Resolve]  [Snooze]  [Archive]  [More]
 *
 * It is the last row of the list's column, not a `fixed` overlay. `/inbox` is
 * a viewport-owning route (`lib/shell/full-viewport-routes.ts`), so the compact
 * shell already sizes this column to end exactly above the tab bar — the dock
 * therefore sits on the tab bar without the `COMPACT_ABOVE_TAB_BAR_BOTTOM`
 * offset a floating control needs, and it cannot cover the last row of the
 * list, which a fixed bar would.
 *
 * Every button is a 44px+ touch target with an icon and a label. Snooze and
 * More open a sheet (the same option lists as the desktop menus, drawn through
 * the sheet kit), where Assign and Labels are second pages.
 *
 * Shares `bulkSelectionFacts` with the desktop toolbar, so a toggle means the
 * same thing on both.
 */

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  AlarmClockIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckCircle2Icon,
  MailIcon,
  MailOpenIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  TagIcon,
  UserRoundIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { bulkSelectionFacts } from "@/components/inbox/conversation-bulk-bar"
import { LABEL_MANAGER_HREF } from "@/components/inbox/label-picker"
import {
  AssigneeMenuItems,
  LabelMenuItems,
  SnoozeMenuItems,
} from "@/components/inbox/triage-menu-items"
import { SessionRowSheetMenu } from "@/components/mobile/shell/session-row-sheet-kit"
import { impact } from "@/lib/capacitor/haptics"
import { labelStateAcross, labelToggleAction, type TriageAction } from "@/lib/inbox/bulk-triage"
import type { ConversationRowItem } from "@/lib/inbox/conversation-grouping"
import { cn } from "@/lib/utils"
import { TRIAGE_SHEET_KIT } from "./mobile-conversation-row-actions"

export interface MobileConversationBulkBarProps {
  rows: readonly ConversationRowItem[]
  visibleCount: number
  onSelectAll: () => void
  onClear: () => void
  onRun: (action: TriageAction) => void
}

type Sheet = "snooze" | "more" | null

const DOCK_BUTTON = cn(
  "flex h-auto min-h-14 flex-col items-center justify-center gap-1 rounded-none px-1 py-1.5",
  "text-[11px] font-medium leading-none [&_svg]:size-5"
)

export function MobileConversationBulkBar({
  rows,
  visibleCount,
  onSelectAll,
  onClear,
  onRun,
}: MobileConversationBulkBarProps) {
  const t = useTranslations("inbox.bulk")
  const tMenu = useTranslations("inbox.triageMenu")
  const tSession = useTranslations("desktop.sessionRow")
  const tMobile = useTranslations("mobile.inbox.selection")
  const router = useRouter()
  const [sheet, setSheet] = useState<Sheet>(null)
  const facts = useMemo(() => bulkSelectionFacts(rows), [rows])
  const count = rows.length
  const none = count === 0
  const allChecked = count > 0 && count >= visibleCount
  const readsRead = facts.readAction.kind === "markRead"
  const pinning = facts.pinAction.kind === "setPinned" && facts.pinAction.pinned
  const archiving = facts.archiveAction.kind === "setArchived" && facts.archiveAction.archived
  const K = TRIAGE_SHEET_KIT

  const run = (action: TriageAction) => {
    void impact("light")
    onRun(action)
  }

  return (
    <div
      role="toolbar"
      aria-label={t("toolbarAria", { count })}
      className="shrink-0 border-t bg-background"
      data-testid="mobile-conversation-bulk-bar"
    >
      <div className="flex min-h-11 items-center gap-2 ps-4 pe-1">
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium tabular-nums"
          aria-live="polite"
          data-testid="mobile-bulk-count"
        >
          {none ? tMobile("hint") : t("count", { count })}
        </span>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 px-3 text-sm"
          onClick={allChecked ? onClear : onSelectAll}
          disabled={visibleCount === 0}
          data-testid="mobile-bulk-select-all"
        >
          {allChecked ? t("clear") : t("selectAllShort")}
        </Button>
      </div>
      <div className="grid grid-cols-5 border-t">
        <Button
          type="button"
          variant="ghost"
          className={DOCK_BUTTON}
          disabled={none}
          onClick={() => run(facts.readAction)}
          data-testid="mobile-bulk-read"
        >
          {readsRead ? <MailOpenIcon aria-hidden /> : <MailIcon aria-hidden />}
          {readsRead ? t("readShort") : t("unreadShort")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={DOCK_BUTTON}
          disabled={none}
          onClick={() => run({ kind: "setStatus", status: "resolved" })}
          data-testid="mobile-bulk-resolve"
        >
          <CheckCircle2Icon aria-hidden />
          {t("resolve")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={DOCK_BUTTON}
          disabled={none}
          onClick={() => setSheet("snooze")}
          data-testid="mobile-bulk-snooze"
        >
          <AlarmClockIcon aria-hidden />
          {tMenu("snooze")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={DOCK_BUTTON}
          disabled={none}
          onClick={() => run(facts.archiveAction)}
          data-testid="mobile-bulk-archive"
        >
          {archiving ? <ArchiveIcon aria-hidden /> : <ArchiveRestoreIcon aria-hidden />}
          {tSession(archiving ? "archive" : "unarchive")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={DOCK_BUTTON}
          disabled={none}
          onClick={() => setSheet("more")}
          data-testid="mobile-bulk-more"
        >
          <MoreHorizontalIcon aria-hidden />
          {t("more")}
        </Button>
      </div>

      <Drawer open={sheet !== null} onOpenChange={(open) => {
          if (!open) setSheet(null)
        }}>
        <DrawerContent
          data-testid="mobile-bulk-sheet"
          data-edge-swipe-ignore=""
          className="pb-[env(safe-area-inset-bottom)]"
        >
          <DrawerHeader className="gap-1 pb-2 text-left md:text-left">
            <DrawerTitle className="text-base">
              {sheet === "snooze" ? tMenu("snooze") : t("count", { count })}
            </DrawerTitle>
            <DrawerDescription className="sr-only">{tMobile("sheetDescription")}</DrawerDescription>
          </DrawerHeader>
          {sheet ? (
            <SessionRowSheetMenu
              key={sheet}
              label={t("toolbarAria", { count })}
              onPicked={() => setSheet(null)}
            >
              {sheet === "snooze" ? (
                <SnoozeMenuItems
                  kit={K}
                  snoozed={facts.allSnoozed}
                  onSnooze={(_key, until) =>
                    run({ kind: "setStatus", status: "snoozed", snoozeUntil: until })
                  }
                  onWake={() => run({ kind: "setStatus", status: "open" })}
                />
              ) : (
                <>
                  <K.Item
                    onSelect={() => run({ kind: "markRead" })}
                    data-testid="mobile-bulk-mark-read"
                  >
                    <MailOpenIcon aria-hidden />
                    {tSession("markRead")}
                  </K.Item>
                  <K.Item
                    onSelect={() => run({ kind: "markUnread" })}
                    data-testid="mobile-bulk-mark-unread"
                  >
                    <MailIcon aria-hidden />
                    {tSession("markUnread")}
                  </K.Item>
                  <K.Item onSelect={() => run(facts.pinAction)} data-testid="mobile-bulk-pin">
                    {pinning ? <PinIcon aria-hidden /> : <PinOffIcon aria-hidden />}
                    {tSession(pinning ? "pin" : "unpin")}
                  </K.Item>
                  <K.Separator />
                  <K.Sub>
                    <K.SubTrigger data-testid="mobile-bulk-assign">
                      <UserRoundIcon aria-hidden />
                      {tMenu("assign")}
                    </K.SubTrigger>
                    <K.SubContent>
                      <AssigneeMenuItems
                        kit={K}
                        current={facts.commonAssignee}
                        onAssign={(assignee) => run({ kind: "setAssignee", assignee })}
                      />
                    </K.SubContent>
                  </K.Sub>
                  <K.Sub>
                    <K.SubTrigger data-testid="mobile-bulk-labels">
                      <TagIcon aria-hidden />
                      {tMenu("labels")}
                    </K.SubTrigger>
                    <K.SubContent>
                      <LabelMenuItems
                        kit={K}
                        stateOf={(labelId) => labelStateAcross(labelId, facts.targets)}
                        onToggle={(labelId, state) => run(labelToggleAction(labelId, state))}
                        onManage={() => router.push(LABEL_MANAGER_HREF)}
                      />
                    </K.SubContent>
                  </K.Sub>
                </>
              )}
            </SessionRowSheetMenu>
          ) : null}
        </DrawerContent>
      </Drawer>
    </div>
  )
}
