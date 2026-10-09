"use client"

/**
 * A single conversation row in the Inbox middle pane.
 *
 * Layout (master-list density, IM/email-client style):
 *   [avatar+platform]  Title              relative-time
 *                      last-message…      draft · unread · CU
 *
 * Avatar is a deterministic glyph (`lib/ui/avatar`) seeded by the conversation
 * title so legacy sessions without a stored avatar still get a stable hue,
 * with the `PlatformBadge` tucked into the corner. The secondary line shows
 * the latest message preview instead of the raw conversationKey.
 *
 * Extracted from `conversation-list.tsx` so it can carry its own test and keep
 * the list component focused on querying/sorting. The click target stays a
 * single shadcn Button with the per-row plugin actions kept *outside* it to
 * avoid nested-interactive a11y violations.
 *
 * Two activation models, chosen by the host:
 *  - **open** (no `onOpen`; the phone): a tap is `onSelect`, which the list
 *    maps to opening the chat.
 *  - **preview** (`onOpen` given; tablet / desktop): a click or Space selects
 *    the row for the triage pane (`onSelect`); a double-click or Enter opens
 *    the full chat (`onOpen`). The accessible name says "Preview …" so a
 *    screen reader does not promise a navigation that a click no longer makes.
 *
 * `leading` is a slot rendered before the click target, outside it, for a
 * control that must not nest inside the row button (the bulk-selection
 * checkbox, which the list draws over the avatar).
 *
 * Triage at a glance, on the second line's trailing edge so the row stays two
 * lines: up to two label dots (+n), the assignee's initials, a compact SLA
 * flag (only when overdue or due within half an hour — `lib/inbox/row-sla.ts`)
 * and a pending-approval shield, then the existing draft / unread / CU marks.
 * The `⋯` menu (`conversation-row-menu.tsx`) carries read state, pin, status,
 * snooze, assignee, labels and archive; the keyboard opens its quick lists.
 */

import { useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { MoreHorizontalIcon, PinIcon, ShieldAlertIcon, UserRoundIcon } from "lucide-react"
import type { ConversationAssignee, ConversationStatus } from "@/lib/db/conversation-overrides"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { avatarColor, avatarGlyph, initials } from "@/lib/ui/avatar"
import { HOVER_REVEAL_GROUP_BASE_CLASS } from "@/lib/ui/hover-reveal"
import { usePendingApprovalCount } from "@/hooks/connectors/use-pending-approval-count"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { LabelRow } from "@/types/labels"
import { triageTargetOf, type TriageAction } from "@/lib/inbox/bulk-triage"
import { remainingMinutes, rowSlaState } from "@/lib/inbox/row-sla"
import { PlatformBadge } from "./platform-badge"
import { UnreadPill } from "./unread-pill"
import { ComputerUseChip } from "./computer-use-chip"
import { ConversationRowMenu, type ConversationRowMenuMode } from "./conversation-row-menu"
import { ASSIGNEE_KIND_DOT, useAssigneeLabel } from "./triage-menu-items"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import type { ConversationRowItem } from "@/lib/inbox/conversation-grouping"

// The row's data shape lives with the pure grouping logic that sections it;
// re-exported so existing imports of it from here keep working.
export type { ConversationRowItem }

export interface ConversationRowProps {
  item: ConversationRowItem
  /** Pending-draft count for this conversation (badge); 0 hides it. */
  draftCount?: number
  /** This row is the one shown in the detail / preview pane. */
  isActive: boolean
  /** Click / Space / tap. Selects for preview, or opens when `onOpen` is absent. */
  onSelect: (conversationKey: string, sessionId: string) => void
  /** Double-click / Enter: open the full chat. Presence switches the row to preview mode. */
  onOpen?: (conversationKey: string, sessionId: string) => void
  /** Rendered before the click target, outside it (e.g. a selection checkbox). */
  leading?: ReactNode
  /** Checked in the list's bulk selection (tinted). */
  checked?: boolean
  /**
   * Touch selection mode: a tap toggles the check, so the button reports a
   * pressed state instead of promising to open or preview.
   */
  pressed?: boolean
  /** Label catalog, by id, for the label dots. Read once by the list. */
  labelsById?: ReadonlyMap<string, LabelRow>
  /** The list's ticking clock, so the SLA flag turns overdue on time. */
  now?: Date
  /** Run a triage action from the `⋯` menu. Absent → no menu. */
  onTriage?: (action: TriageAction) => void
  /** Controlled `⋯` menu: `null` closed, else which list it shows. */
  menuMode?: ConversationRowMenuMode | null
  onMenuModeChange?: (mode: ConversationRowMenuMode | null) => void
  /** Right-click / context-menu key on the row button. */
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void
  /**
   * The phone's action sheet. With no `onTriage` menu, the `⋯` opens this
   * instead: the visible (and keyboard / screen-reader) way to the sheet a
   * long-press opens.
   */
  onOpenActions?: () => void
}

/** Label dots drawn before collapsing into "+n". */
const ROW_LABEL_DOTS = 2

/** Dot color for the non-"open" lifecycle statuses surfaced in the row. */
const ROW_STATUS_DOT: Record<Exclude<ConversationStatus, "open">, string> = {
  pending: "bg-amber-500",
  snoozed: "bg-sky-500",
  resolved: "bg-muted-foreground",
}

export function ConversationRow({
  item,
  draftCount = 0,
  isActive,
  onSelect,
  onOpen,
  leading,
  checked = false,
  pressed,
  labelsById,
  now: nowProp,
  onTriage,
  menuMode = null,
  onMenuModeChange,
  onContextMenu,
  onOpenActions,
}: ConversationRowProps) {
  const t = useTranslations("inbox.conversationRow")
  const tSession = useTranslations("desktop.sessionRow")
  const tStatus = useTranslations("inbox.lifecycle.status")
  const format = useFormatter()
  // Anchor relativeTime to a stable render-time "now" so next-intl doesn't fall
  // back to reading the wall clock at format time (ENVIRONMENT_FALLBACK warning
  // + non-deterministic SSR/hydration output). The list passes its own ticking
  // clock so the SLA flag moves without a per-row timer.
  const mountNow = useNow()
  const rowButtonRef = useRef<HTMLButtonElement>(null)
  const now = nowProp ?? mountNow
  const { session, override, unreadCount, lastMessagePreview, lastMessageAt } = item
  const ck = session.platformBinding!.conversationKey
  const platform = session.platformBinding!.platform as PlatformKind
  const adapterId = session.platformBinding!.adapterId
  const name = session.title || ck
  const relative =
    typeof lastMessageAt === "number" ? format.relativeTime(new Date(lastMessageAt), now) : null
  const sla = rowSlaState(override, now.getTime())
  const labels = (override?.labelIds ?? [])
    .map((id) => labelsById?.get(id))
    .filter((label): label is LabelRow => label !== undefined)

  return (
    <div
      className={cn(
        "group/row @container/conversation-row relative flex w-full items-center gap-1 px-3 py-2 min-h-12 transition-colors",
        "md:min-h-11 md:py-1.5",
        // Hover must not apply on top of the active fill: `bg-muted/60` over
        // `bg-muted` made the *selected* row go paler than its neighbours.
        !isActive && "hover:bg-muted/60",
        // `bg-muted` and `bg-muted/60` are near-identical, so selection used to
        // vanish the moment the pointer moved. The rail is the unambiguous
        // marker; `start-0` (not `left-0`) keeps it correct under RTL, matching
        // the `-end-1` badge below.
        isActive &&
          "bg-muted before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full before:bg-primary",
        checked && !isActive && "bg-primary/5"
      )}
      data-testid={`conversation-row-${ck}`}
      data-session-id={session.id}
      data-checked={checked ? "true" : undefined}
    >
      {leading}
      <Button
        ref={rowButtonRef}
        type="button"
        variant="ghost"
        className="h-auto min-w-0 flex-1 justify-start gap-2.5 rounded-none p-0 text-left hover:bg-transparent"
        onClick={() => onSelect(ck, session.id)}
        onDoubleClick={onOpen ? () => onOpen(ck, session.id) : undefined}
        onContextMenu={onContextMenu}
        onKeyDown={
          onOpen
            ? (event) => {
                // Enter opens; Space keeps the native button click (select).
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return
                event.preventDefault()
                onOpen(ck, session.id)
              }
            : undefined
        }
        aria-current={isActive ? "true" : undefined}
        aria-pressed={pressed}
        aria-label={
          pressed !== undefined
            ? t("selectConversation", { name })
            : t(onOpen ? "previewConversation" : "openConversation", { name })
        }
        aria-keyshortcuts={onOpen && pressed === undefined ? "Enter" : undefined}
        data-selected={isActive ? "true" : undefined}
        // The keyboard model (`use-inbox-triage-keyboard`) finds and focuses
        // rows by this, and only acts while focus is on one of them.
        data-inbox-row-select={session.id}
        data-testid={`conversation-row-button-${ck}`}
      >
        {/* Deterministic glyph avatar + platform corner badge */}
        <span className="relative shrink-0">
          <Avatar className="size-9" aria-hidden>
            <AvatarFallback
              className="text-xs font-medium text-white"
              style={{ backgroundColor: avatarColor({ name }) }}
            >
              {avatarGlyph({ name })}
            </AvatarFallback>
          </Avatar>
          <span className="absolute -bottom-1 -end-1 rounded-full bg-background p-0.5 leading-none">
            <PlatformBadge platform={platform} iconOnly />
          </span>
        </span>

        {/* Two-line IM layout: time rides the title, badges ride the preview.
         * As a third flex column the timestamp ("8 minutes ago" ≈ 78px) ate
         * 30-40% of the row at the pane's 123-259px range and truncated the
         * title to nothing. */}
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-1.5">
            {session.pinned && <PinIcon className="size-3 shrink-0 text-muted-foreground" />}
            {override?.status && override.status !== "open" && (
              <span
                className={cn("size-2 shrink-0 rounded-full", ROW_STATUS_DOT[override.status])}
                title={tStatus(override.status)}
                aria-label={t("statusAria", { status: tStatus(override.status) })}
                data-testid={`conversation-row-status-${ck}`}
              />
            )}
            {/* Unread is carried by weight as well as by the pill — that is
             * how every mature client reads at a glance, and it needs no data
             * the row doesn't already have. */}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                unreadCount > 0 ? "font-semibold" : "font-medium"
              )}
            >
              {name}
            </span>
            {relative && (
              <span
                className="hidden shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground @[15rem]/conversation-row:inline"
                data-testid={`conversation-row-time-${ck}`}
              >
                {relative}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <p
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                unreadCount > 0 ? "text-foreground/80" : "text-muted-foreground"
              )}
            >
              {lastMessagePreview && lastMessagePreview.length > 0
                ? lastMessagePreview
                : t("noPreview")}
            </p>
            <span className="flex shrink-0 items-center gap-1">
              {labels.length > 0 && <RowLabelDots labels={labels} ck={ck} />}
              {override?.assignee && <RowAssigneeToken assignee={override.assignee} ck={ck} />}
              {sla && <RowSlaFlag sla={sla} ck={ck} />}
              <RowPendingApproval sessionId={session.id} ck={ck} />
              {draftCount > 0 && (
                <Badge
                  variant="warning"
                  className="h-4 px-1 text-[10px] leading-none"
                  aria-label={t("draftCountAria", { count: draftCount })}
                  data-testid={`conversation-row-draft-${ck}`}
                >
                  {t("draftCount", { count: draftCount })}
                </Badge>
              )}
              <UnreadPill count={unreadCount} />
              <ComputerUseChip active={override?.allowComputerUse === true} />
            </span>
          </div>
        </div>
      </Button>

      {onTriage && (
        <ConversationRowMenu
          target={triageTargetOf(item)}
          mode={menuMode}
          onModeChange={(mode) => onMenuModeChange?.(mode)}
          onTriage={onTriage}
          triggerLabel={tSession("actionsMenu")}
          onCloseFocus={() => {
            // A keyboard-opened quick list hands focus back to the row.
            const button = rowButtonRef.current
            button?.focus()
            return button != null
          }}
        />
      )}

      {!onTriage && onOpenActions && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          // 44px touch target around the glyph without widening the row.
          className="relative size-7 shrink-0 after:absolute after:-inset-2"
          onClick={onOpenActions}
          aria-label={tSession("actionsMenu")}
          aria-haspopup="dialog"
          data-testid={`conversation-row-actions-${ck}`}
        >
          <MoreHorizontalIcon className="size-3.5" aria-hidden />
        </Button>
      )}

      {/* Plugin contributions: per-row actions (archive, mute, transfer to
       * workflow, …). Hidden when no plugin contributes.
       *
       * Reveal-on-hover, matching `SidebarMenuAction showOnHover`: these were
       * permanently visible, competing with the conversation itself for a
       * ~200px row. `ml-auto` was dead here — the preceding sibling is
       * `flex-1`. The shared reveal policy keeps them reachable without a
       * hover (focus, an open plugin popup, a coarse pointer); the hover path
       * stays the named `row` group, and below `md` they are always shown. */}
      <PluginExtensionSlot
        point="inbox.conversation.actions"
        className={cn(
          "flex shrink-0 items-center gap-1 empty:hidden",
          HOVER_REVEAL_GROUP_BASE_CLASS,
          "group-hover/row:opacity-100 group-focus-within/row:opacity-100 max-md:opacity-100"
        )}
        context={{
          conversationKey: ck,
          adapterId,
          platform,
          sessionId: session.id,
          pinned: !!session.pinned,
          archived: session.archivedAt != null,
        }}
      />
    </div>
  )
}

/** Up to two label colour dots, then "+n"; the tooltip names them all. */
function RowLabelDots({ labels, ck }: { labels: readonly LabelRow[]; ck: string }) {
  const t = useTranslations("inbox.conversationRow")
  const names = labels.map((label) => label.name).join(", ")
  const extra = labels.length - ROW_LABEL_DOTS
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={t("labelsAria", { names })}
          className="flex items-center gap-0.5"
          data-testid={`conversation-row-labels-${ck}`}
        >
          {labels.slice(0, ROW_LABEL_DOTS).map((label) => (
            <span
              key={label.id}
              aria-hidden
              className="size-2 shrink-0 rounded-full border border-background bg-muted-foreground"
              style={label.color ? { backgroundColor: label.color } : undefined}
            />
          ))}
          {extra > 0 && (
            <span
              aria-hidden
              className="text-[10px] leading-none text-muted-foreground tabular-nums"
            >
              {t("labelsMore", { count: extra })}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{names}</TooltipContent>
    </Tooltip>
  )
}

/** The assignee as a small initials token; the tooltip gives the full label. */
function RowAssigneeToken({ assignee, ck }: { assignee: ConversationAssignee; ck: string }) {
  const t = useTranslations("inbox.assignee")
  const labelOf = useAssigneeLabel()
  const label = labelOf(assignee)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={t("aria", { assignee: label })}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold leading-none text-white",
            ASSIGNEE_KIND_DOT[assignee.kind]
          )}
          data-testid={`conversation-row-assignee-${ck}`}
          data-assignee-kind={assignee.kind}
        >
          {assignee.kind === "human" ? (
            <UserRoundIcon className="size-2.5" aria-hidden />
          ) : (
            <span aria-hidden>{initials(label)}</span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{t("aria", { assignee: label })}</TooltipContent>
    </Tooltip>
  )
}

/** Overdue, or due within the near-due window. Quiet otherwise. */
function RowSlaFlag({ sla, ck }: { sla: NonNullable<ReturnType<typeof rowSlaState>>; ck: string }) {
  const t = useTranslations("inbox.conversationRow")
  const overdue = sla.kind === "overdue"
  const minutes = sla.kind === "nearDue" ? remainingMinutes(sla.remainingMs) : 0
  return (
    <span
      role="img"
      aria-label={overdue ? t("slaOverdueAria") : t("slaDueAria", { minutes })}
      title={overdue ? t("slaOverdueAria") : t("slaDueAria", { minutes })}
      className={cn(
        "shrink-0 rounded-sm px-1 text-[10px] font-medium leading-4 tabular-nums",
        overdue
          ? "bg-destructive/10 text-destructive"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
      )}
      data-testid={`conversation-row-sla-${ck}`}
      data-sla={sla.kind}
    >
      {overdue ? t("slaOverdue") : t("slaDue", { minutes })}
    </span>
  )
}

/**
 * HITL approvals waiting in this conversation. Backed by the in-process
 * approval registry through `useSyncExternalStore` — no database read, so one
 * per row costs a subscription, not a query.
 */
function RowPendingApproval({ sessionId, ck }: { sessionId: string; ck: string }) {
  const t = useTranslations("inbox.pendingApprovals")
  const count = usePendingApprovalCount(sessionId)
  if (count <= 0) return null
  return (
    <ShieldAlertIcon
      role="img"
      aria-label={t("count", { count })}
      className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
      data-testid={`conversation-row-approvals-${ck}`}
    />
  )
}
