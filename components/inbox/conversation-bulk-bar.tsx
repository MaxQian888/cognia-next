"use client"

/**
 * The Inbox list's bulk bar: what the list header becomes while rows are
 * checked (tablet / desktop).
 *
 *   [☑ all] 3 selected            [read] [resolve] [snooze▾] [archive] [⋯] [✕]
 *
 * It sits in the header's own 48px row, so checking a row never shifts the
 * list. The list pane is narrow (a 288px tablet column, a ~25% desktop panel),
 * so the frequent actions are icon buttons with tooltips and the rest live in
 * `⋯`: mark read / unread, pin or unpin, assignee and labels (tri-state across
 * the checked rows).
 *
 * The keyboard's `s` / `i` / `l` open these menus while rows are checked:
 * `menu` controls which one is open — `snooze` the snooze menu, `assign` /
 * `label` the `⋯` menu showing just that list.
 *
 * Every action is a `TriageAction` the list runs over the checked rows
 * (`useTriageActions` → `lib/inbox/bulk-triage.ts`).
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
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { ConversationAssignee } from "@/lib/db/conversation-overrides"
import {
  labelStateAcross,
  labelToggleAction,
  toggleTriageAction,
  triageTargetOf,
  type TriageAction,
  type TriageTarget,
} from "@/lib/inbox/bulk-triage"
import type { ConversationRowItem } from "@/lib/inbox/conversation-grouping"
import { LABEL_MANAGER_HREF } from "./label-picker"
import {
  AssigneeMenuItems,
  LabelMenuItems,
  SnoozeMenuItems,
  TRIAGE_DROPDOWN_KIT,
} from "./triage-menu-items"

/** Which bulk menu the keyboard has open. */
export type BulkBarMenu = "snooze" | "assign" | "label"

/** What the checked rows have in common — shared by the toolbar and the phone dock. */
export interface BulkSelectionFacts {
  targets: TriageTarget[]
  readAction: TriageAction
  pinAction: TriageAction
  archiveAction: TriageAction
  /** Every checked row is snoozed: offer "Wake now". */
  allSnoozed: boolean
  /** The assignee every checked row shares, `undefined` when they differ. */
  commonAssignee: ConversationAssignee | null | undefined
}

export function bulkSelectionFacts(rows: readonly ConversationRowItem[]): BulkSelectionFacts {
  const targets = rows.map(triageTargetOf)
  const first = targets[0]?.assignee ?? null
  const shared = targets.every((target) => {
    const assignee = target.assignee ?? null
    if (!assignee || !first) return assignee === first
    return assignee.kind === first.kind && (assignee.id ?? null) === (first.id ?? null)
  })
  return {
    targets,
    readAction: toggleTriageAction("read", targets),
    pinAction: toggleTriageAction("pin", targets),
    archiveAction: toggleTriageAction("archive", targets),
    allSnoozed: targets.length > 0 && targets.every((target) => target.status === "snoozed"),
    commonAssignee: shared ? first : undefined,
  }
}

export interface ConversationBulkBarProps {
  /** The checked rows (visible ones only). */
  rows: readonly ConversationRowItem[]
  /** Rows a reader can see — "select all" checks these. */
  visibleCount: number
  onSelectAll: () => void
  onClear: () => void
  onRun: (action: TriageAction) => void
  /** Keyboard-opened menu; `null` / absent when none. */
  menu?: BulkBarMenu | null
  onMenuChange?: (menu: BulkBarMenu | null) => void
}

export function ConversationBulkBar({
  rows,
  visibleCount,
  onSelectAll,
  onClear,
  onRun,
  menu = null,
  onMenuChange,
}: ConversationBulkBarProps) {
  const t = useTranslations("inbox.bulk")
  const tMenu = useTranslations("inbox.triageMenu")
  const tSession = useTranslations("desktop.sessionRow")
  const router = useRouter()
  const facts = useMemo(() => bulkSelectionFacts(rows), [rows])
  const count = rows.length
  const allChecked = count > 0 && count >= visibleCount
  const readsRead = facts.readAction.kind === "markRead"
  const pinning = facts.pinAction.kind === "setPinned" && facts.pinAction.pinned
  const archiving = facts.archiveAction.kind === "setArchived" && facts.archiveAction.archived
  // Each menu opens from a click (local state) or from the keyboard (`menu`);
  // fully controlled either way, so Radix never flips between modes.
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const keyboardMore: "assign" | "label" | null =
    menu === "assign" || menu === "label" ? menu : null

  const iconButton = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    testId: string
  ) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={onClick}
          aria-label={label}
          data-testid={testId}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )

  const assigneeItems = (
    <AssigneeMenuItems
      kit={TRIAGE_DROPDOWN_KIT}
      current={facts.commonAssignee}
      onAssign={(assignee) => onRun({ kind: "setAssignee", assignee })}
    />
  )
  const labelItems = (
    <LabelMenuItems
      kit={TRIAGE_DROPDOWN_KIT}
      stateOf={(labelId) => labelStateAcross(labelId, facts.targets)}
      onToggle={(labelId, state) => onRun(labelToggleAction(labelId, state))}
      onManage={() => router.push(LABEL_MANAGER_HREF)}
    />
  )

  return (
    <div
      role="toolbar"
      aria-label={t("toolbarAria", { count })}
      className="flex h-[var(--chrome-h)] shrink-0 items-center gap-1 border-b bg-primary/5 px-2 md:px-3"
      data-testid="conversation-bulk-bar"
    >
      <Checkbox
        checked={allChecked ? true : "indeterminate"}
        onCheckedChange={() => (allChecked ? onClear() : onSelectAll())}
        aria-label={allChecked ? t("clear") : t("selectAll", { count: visibleCount })}
        className="ms-1 shrink-0"
        data-testid="conversation-bulk-select-all"
      />
      {/* At the list's default width the six actions leave room for a number,
          not a phrase ("2 sele…"), so the phrase is spoken there and shown
          only once the column is wide enough to hold it. */}
      <span
        className="min-w-0 flex-1 truncate ps-1.5 text-xs font-medium tabular-nums"
        aria-live="polite"
        data-testid="conversation-bulk-count"
      >
        <span className="sr-only @[24rem]/conversation-list:not-sr-only">
          {t("count", { count })}
        </span>
        <span aria-hidden className="@[24rem]/conversation-list:hidden">
          {count}
        </span>
      </span>

      {iconButton(
        tSession(readsRead ? "markRead" : "markUnread"),
        readsRead ? <MailOpenIcon className="size-4" /> : <MailIcon className="size-4" />,
        () => onRun(facts.readAction),
        "conversation-bulk-read"
      )}
      {iconButton(
        t("resolve"),
        <CheckCircle2Icon className="size-4" />,
        () => onRun({ kind: "setStatus", status: "resolved" }),
        "conversation-bulk-resolve"
      )}

      <DropdownMenu
        open={snoozeOpen || menu === "snooze"}
        onOpenChange={(open) => {
          setSnoozeOpen(open)
          if (!open && menu === "snooze") onMenuChange?.(null)
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label={tMenu("snooze")}
                data-testid="conversation-bulk-snooze"
              >
                <AlarmClockIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{tMenu("snooze")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {tMenu("snooze")}
          </DropdownMenuLabel>
          <SnoozeMenuItems
            kit={TRIAGE_DROPDOWN_KIT}
            snoozed={facts.allSnoozed}
            onSnooze={(_key, until) =>
              onRun({ kind: "setStatus", status: "snoozed", snoozeUntil: until })
            }
            onWake={() => onRun({ kind: "setStatus", status: "open" })}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {iconButton(
        tSession(archiving ? "archive" : "unarchive"),
        archiving ? <ArchiveIcon className="size-4" /> : <ArchiveRestoreIcon className="size-4" />,
        () => onRun(facts.archiveAction),
        "conversation-bulk-archive"
      )}

      <DropdownMenu
        open={moreOpen || keyboardMore !== null}
        onOpenChange={(open) => {
          setMoreOpen(open)
          if (!open && keyboardMore !== null) onMenuChange?.(null)
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label={t("more")}
            data-testid="conversation-bulk-more"
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {keyboardMore === "assign" ? (
            <>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {tMenu("assign")}
              </DropdownMenuLabel>
              {assigneeItems}
            </>
          ) : keyboardMore === "label" ? (
            labelItems
          ) : (
            <>
              <DropdownMenuItem
                onSelect={() => onRun({ kind: "markRead" })}
                data-testid="conversation-bulk-mark-read"
              >
                <MailOpenIcon className="size-4" />
                {tSession("markRead")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onRun({ kind: "markUnread" })}
                data-testid="conversation-bulk-mark-unread"
              >
                <MailIcon className="size-4" />
                {tSession("markUnread")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onRun(facts.pinAction)}
                data-testid="conversation-bulk-pin"
              >
                {pinning ? <PinIcon className="size-4" /> : <PinOffIcon className="size-4" />}
                {tSession(pinning ? "pin" : "unpin")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="conversation-bulk-assign">
                  <UserRoundIcon className="size-4" />
                  {tMenu("assign")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>{assigneeItems}</DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="conversation-bulk-labels">
                  <TagIcon className="size-4" />
                  {tMenu("labels")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>{labelItems}</DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {iconButton(t("clear"), <XIcon className="size-4" />, onClear, "conversation-bulk-clear")}
    </div>
  )
}
