"use client"

/**
 * Conversation list for the Inbox middle pane.
 *
 * A controlled view. The shell owns the data (`useConversationRows`, one
 * subscription shared with the triage pane) and the URL-held view state
 * (`useInboxUrlState`: grouping, filters, previewed row); this component
 * filters, sections and draws.
 *
 * Sectioning is `groupConversationRows` (`lib/inbox/conversation-grouping.ts`):
 * status grouping is Pinned / Unread / Read, adapter and platform grouping make
 * one section per scope with pinned → unread → read inside, and resolved /
 * archived conversations are collapsible tail sections. Each section has a
 * sticky header; collapse choices persist in the layout store.
 *
 * Activation (`selectionMode`):
 *  - `preview` (tablet / desktop): click or Space selects the row into the
 *    triage pane; double-click or Enter opens the full chat.
 *  - `open` (phone): a tap opens the chat, as before — there is no pane.
 *
 * Keyboard and bulk triage (tablet / desktop, `preview` mode):
 *  - the list container runs the triage keymap (`use-inbox-triage-keyboard`,
 *    `?` lists it) over `visibleConversationRows`, the order drawn here;
 *  - each row carries a checkbox over its avatar — shown on hover, on focus,
 *    on a coarse pointer, and on every row once any is checked — and the
 *    header turns into the bulk bar (`conversation-bulk-bar.tsx`) while rows
 *    are checked;
 *  - the row's `⋯` menu, the keyboard and the bulk bar all run
 *    `TriageAction`s through `useTriageActions`.
 *
 * The phone (`open` mode) has no hover and no keyboard: a long-press opens the
 * row's action sheet (`mobile-conversation-row-actions.tsx`), a swipe right
 * reveals Read / Unread and a swipe left Resolve and Archive, and the host's
 * "Select" button (`touchSelecting`) turns taps into checks with a bulk dock
 * at the bottom of the column.
 *
 * `renderRowLeading` still lets a host put its own control before a row's
 * click target without nesting it inside the button.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react"
import { useNow, useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckCircle2Icon,
  CheckCircleIcon,
  CircleIcon,
  KeyboardIcon,
  MailIcon,
  MailOpenIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { LongPress } from "@/components/interactions/long-press"
import { SwipeRow, type SwipeAction } from "@/components/interactions/swipe-row"
import { MobileConversationBulkBar } from "@/components/mobile/inbox/mobile-conversation-bulk-bar"
import { MobileConversationRowActions } from "@/components/mobile/inbox/mobile-conversation-row-actions"
import { usePendingDraftCounts } from "@/hooks/connectors/use-pending-drafts"
import { useConversationLabelMap } from "@/hooks/connectors/use-conversation-labels"
import {
  focusRowButton,
  useInboxTriageKeyboard,
  type InboxRowCommandKind,
} from "@/hooks/inbox/use-inbox-triage-keyboard"
import { useTriageActions } from "@/hooks/inbox/use-triage-actions"
import { useRangeSelection } from "@/hooks/ui/use-range-selection"
import { STAGGER_CONTAINER, STAGGER_CHILD } from "@/lib/ui/motion"
import { toggleTriageAction, triageTargetOf, type TriageAction } from "@/lib/inbox/bulk-triage"
import {
  groupConversationRows,
  visibleConversationRows,
  type ConversationSection,
  type GroupingAdapter,
} from "@/lib/inbox/conversation-grouping"
import { inboxScopeHref } from "@/lib/inbox/conversation-href"
import type { InboxGrouping, InboxListFilter } from "@/lib/inbox/inbox-url-state"
import { cn } from "@/lib/utils"
import { useInboxLayoutStore } from "@/stores/inbox/inbox-layout-store"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { ConversationSearchInput } from "./search/conversation-search-input"
import { ConversationRow, type ConversationRowItem } from "./conversation-row"
import type { ConversationRowMenuMode } from "./conversation-row-menu"
import { ConversationBulkBar, type BulkBarMenu } from "./conversation-bulk-bar"
import { ConversationListFilterMenu } from "./conversation-list-filter-menu"
import { ConversationSectionHeader } from "./conversation-section-header"
import { InboxShortcutsHelp } from "./inbox-shortcuts-help"
import { PlatformBadge } from "./platform-badge"
import { StateCard } from "./state/state-card"

export type ConversationSelectionMode = "preview" | "open"

export interface ConversationListProps {
  /** `undefined` while the first read is in flight (skeleton, not empty state). */
  rows: ConversationRowItem[] | undefined
  /** A failed read (captured upstream so it cannot escape the pane boundary). */
  error?: Error | null
  onRetry?: () => void
  /** Labels and orders adapter / platform sections. */
  adapters?: readonly GroupingAdapter[]
  grouping: InboxGrouping
  filters: readonly InboxListFilter[]
  onToggleFilter: (filter: InboxListFilter) => void
  onClearFilters: () => void
  /** The route's scope: a section for the scope itself gets no "open scope" link. */
  adapterId?: string
  platformKind?: string
  /** The session in the detail / preview pane. */
  selectedSessionId?: string | null
  selectionMode: ConversationSelectionMode
  /** Preview mode: a row was selected. Open mode: never called. */
  onSelectSession?: (row: ConversationRowItem) => void
  /** Open the full chat for a row. */
  onOpenSession: (row: ConversationRowItem) => void
  /** Optional control rendered before each row's click target. */
  renderRowLeading?: (row: ConversationRowItem) => ReactNode
  /** Preview mode: the keyboard's Escape cleared the checks and now clears the preview. */
  onClearPreview?: () => void
  /**
   * Open mode (phone): "Preview" from a row's long-press sheet. The host shows
   * the triage pane in a drawer.
   */
  onPreviewSession?: (row: ConversationRowItem) => void
  /** Open mode: the host's "Select" toggle — taps check rows instead of opening. */
  touchSelecting?: boolean
  onTouchSelectingChange?: (selecting: boolean) => void
}

/**
 * Render-time filter: the text query (case-insensitive substring over title,
 * conversationKey and preview) AND every active filter.
 */
function buildFilterPredicate(
  query: string,
  filters: readonly InboxListFilter[]
): (item: ConversationRowItem) => boolean {
  const needle = query.trim().toLowerCase()
  const active = new Set(filters)
  return (item) => {
    if (active.has("unread") && item.unreadCount <= 0) return false
    if (active.has("pinned") && !item.session.pinned) return false
    if (active.has("pending") && item.override?.status !== "pending") return false
    if (active.has("snoozed") && item.override?.status !== "snoozed") return false
    if (!needle) return true
    const ck = item.session.platformBinding?.conversationKey ?? ""
    const hay = [item.session.title, ck, item.lastMessagePreview ?? ""]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
    return hay.includes(needle)
  }
}

/** DOM id for a section's row list (the header's `aria-controls` target). */
function sectionListId(sectionId: string): string {
  return `inbox-section-${sectionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`
}

export function ConversationList({
  rows,
  error,
  onRetry,
  adapters,
  grouping,
  filters,
  onToggleFilter,
  onClearFilters,
  adapterId,
  platformKind,
  selectedSessionId,
  selectionMode,
  onSelectSession,
  onOpenSession,
  renderRowLeading,
  onClearPreview,
  onPreviewSession,
  touchSelecting = false,
  onTouchSelectingChange,
}: ConversationListProps) {
  const t = useTranslations("inbox.conversationList")
  const tSections = useTranslations("inbox.sections")
  const tPlatform = useTranslations("inbox.platformBadge")
  const tSession = useTranslations("desktop.sessionRow")
  const tBulk = useTranslations("inbox.bulk")
  const reduce = useReducedMotion()
  const draftCounts = usePendingDraftCounts()
  const labelsById = useConversationLabelMap()
  // One ticking clock for every row's SLA flag, instead of a timer per row.
  const now = useNow({ updateInterval: 60_000 })
  const { run } = useTriageActions()
  const collapsedSections = useInboxLayoutStore((s) => s.collapsedSections)
  const setSectionCollapsed = useInboxLayoutStore((s) => s.setSectionCollapsed)
  const [searchQuery, setSearchQuery] = useState("")
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const touch = selectionMode === "open"
  /** The row whose `⋯` menu is open, and which list it shows. */
  const [rowMenu, setRowMenu] = useState<{
    sessionId: string
    mode: ConversationRowMenuMode
  } | null>(null)
  const [bulkMenu, setBulkMenu] = useState<BulkBarMenu | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  /** Phone: the row whose long-press sheet is open. */
  const [actionsRow, setActionsRow] = useState<ConversationRowItem | null>(null)

  const sections = useMemo(() => {
    if (!rows) return null
    const filtered = rows.filter(buildFilterPredicate(searchQuery, filters))
    return groupConversationRows(filtered, grouping, {
      adapters,
      collapsed: collapsedSections,
    })
  }, [rows, searchQuery, filters, grouping, adapters, collapsedSections])

  const visibleRows = useMemo(() => (sections ? visibleConversationRows(sections) : []), [sections])
  const visibleIds = useMemo(() => visibleRows.map((row) => row.session.id), [visibleRows])
  const selection = useRangeSelection(visibleIds)
  const checkedRows = useMemo(
    () => visibleRows.filter((row) => selection.selected.has(row.session.id)),
    [visibleRows, selection.selected]
  )

  // Leaving the phone's selection mode drops its checks. Compared during
  // render (the documented "previous value" pattern) rather than in an effect.
  const [wasTouchSelecting, setWasTouchSelecting] = useState(touchSelecting)
  if (wasTouchSelecting !== touchSelecting) {
    setWasTouchSelecting(touchSelecting)
    if (!touchSelecting) selection.clear()
  }

  const runOn = useCallback(
    (action: TriageAction, targets: readonly ConversationRowItem[]) =>
      run(action, targets.map(triageTargetOf)),
    [run]
  )

  /**
   * Run an action that takes the focused row out of sight (resolve, archive)
   * and keep the keyboard on the list: focus — and, if it was previewed,
   * preview — the next row (or the previous one at the end).
   */
  const runAndAdvance = useCallback(
    (action: TriageAction, row: ConversationRowItem) => {
      const index = visibleIds.indexOf(row.session.id)
      const neighbour = visibleRows[index + 1] ?? visibleRows[index - 1]
      void runOn(action, [row])
      if (!neighbour) return
      if (row.session.id === selectedSessionId) onSelectSession?.(neighbour)
      focusRowButton(listRef.current, neighbour.session.id)
    },
    [visibleIds, visibleRows, runOn, selectedSessionId, onSelectSession]
  )

  const runBulk = useCallback(
    async (action: TriageAction) => {
      const result = await runOn(action, checkedRows)
      // Everything landed: the selection has done its job. A partial failure
      // keeps it, so a retry reaches exactly the same rows.
      if (result.failed.length === 0) {
        selection.clear()
        if (touch) onTouchSelectingChange?.(false)
      }
    },
    [runOn, checkedRows, selection, touch, onTouchSelectingChange]
  )

  const toggleCheck = useCallback(
    (sessionId: string, extend = false) => {
      if (extend && selection.anchorId) {
        selection.handleClick(sessionId, { ctrlKey: true, metaKey: false, shiftKey: true })
      } else {
        selection.handleClick(sessionId, { ctrlKey: true, metaKey: false, shiftKey: false })
      }
    },
    [selection]
  )

  const onRowCommand = useCallback(
    (kind: InboxRowCommandKind, targets: ConversationRowItem[], scope: "checked" | "row") => {
      const targetsOf = targets.map(triageTargetOf)
      const single = scope === "row" ? targets[0] : undefined
      switch (kind) {
        case "toggleRead":
          void (scope === "checked"
            ? runBulk(toggleTriageAction("read", targetsOf))
            : runOn(toggleTriageAction("read", targetsOf), targets))
          return
        case "togglePin":
          void (scope === "checked"
            ? runBulk(toggleTriageAction("pin", targetsOf))
            : runOn(toggleTriageAction("pin", targetsOf), targets))
          return
        case "toggleArchive": {
          const action = toggleTriageAction("archive", targetsOf)
          if (single) runAndAdvance(action, single)
          else void runBulk(action)
          return
        }
        case "resolve": {
          const action: TriageAction = { kind: "setStatus", status: "resolved" }
          if (single) runAndAdvance(action, single)
          else void runBulk(action)
          return
        }
        case "snooze":
        case "assign":
        case "label": {
          const mode = kind
          if (single) setRowMenu({ sessionId: single.session.id, mode })
          else setBulkMenu(mode)
          return
        }
      }
    },
    [runOn, runBulk, runAndAdvance]
  )

  const keyboard = useInboxTriageKeyboard({
    enabled: !touch,
    rows: visibleRows,
    previewSessionId: selectedSessionId ?? null,
    checked: selection.selected,
    anchorId: selection.anchorId,
    onPreview: (row) => onSelectSession?.(row),
    onOpen: (row) => onOpenSession(row),
    onToggleCheck: (sessionId) => toggleCheck(sessionId),
    onSelectIds: selection.selectIds,
    onSelectAll: selection.selectAll,
    onClearChecked: selection.clear,
    onClearPreview: () => onClearPreview?.(),
    onFocusSearch: () => {
      searchRef.current?.focus()
      searchRef.current?.select()
    },
    onHelp: () => setHelpOpen(true),
    onRowCommand,
  })

  // A preview chosen from outside the list (a deep link, Back from the chat)
  // should not leave its row scrolled out of sight. DOM-only, no state.
  useEffect(() => {
    if (!selectedSessionId) return
    // Matched by dataset rather than a selector, so no id needs escaping.
    const row = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-session-id]") ?? []
    ).find((element) => element.dataset.sessionId === selectedSessionId)
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" })
  }, [selectedSessionId, sections])

  const sectionLabel = (section: ConversationSection): string => {
    switch (section.kind) {
      case "adapter":
        return section.adapterName ?? tSections("unknownAdapter", { id: section.adapterId ?? "" })
      case "platform": {
        const kind = section.platform ?? ""
        return tPlatform.has(`names.${kind}`) ? tPlatform(`names.${kind}`) : kind
      }
      default:
        return tSections(section.kind)
    }
  }

  const sectionScopeHref = (section: ConversationSection): string | undefined => {
    if (section.kind === "adapter" && section.adapterId && section.adapterId !== adapterId) {
      return inboxScopeHref({ kind: "adapter", adapterId: section.adapterId })
    }
    if (section.kind === "platform" && section.platform && section.platform !== platformKind) {
      return inboxScopeHref({ kind: "platform", platform: section.platform })
    }
    return undefined
  }

  const showBulkBar = !touch && checkedRows.length > 0

  // One 48px row — matching the chat header seam plus the rail — then a
  // removable-pill strip only while filters are on. While rows are checked
  // (tablet / desktop) the bulk bar takes the same row, so nothing shifts.
  const header = (
    <>
      {showBulkBar ? (
        <ConversationBulkBar
          rows={checkedRows}
          visibleCount={visibleRows.length}
          onSelectAll={selection.selectAll}
          onClear={selection.clear}
          onRun={(action) => void runBulk(action)}
          menu={bulkMenu}
          onMenuChange={setBulkMenu}
        />
      ) : (
        <div className="flex h-[var(--chrome-h)] shrink-0 items-center gap-1.5 border-b px-2 md:px-3">
          {/* Below `lg` the sidebar is off-canvas on tablet and a sheet on the
            phone, so both need this opener. It was `md:hidden`, which left a
            tablet with no way to reach the adapter list at all. */}
          <SidebarTrigger
            className="-ms-1 size-9 shrink-0 lg:hidden"
            aria-label={t("openSidebar")}
            data-testid="conversation-list-open-sidebar"
          />
          <ConversationSearchInput
            value={searchQuery}
            onDebouncedChange={setSearchQuery}
            className="min-w-0 flex-1"
            inputRef={searchRef}
          />
          <ConversationListFilterMenu
            active={new Set(filters)}
            onToggle={onToggleFilter}
            onClear={onClearFilters}
          />
          {!touch && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  onClick={() => setHelpOpen(true)}
                  aria-label={t("shortcuts")}
                  aria-keyshortcuts="?"
                  data-testid="conversation-list-shortcuts"
                >
                  <KeyboardIcon className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("shortcuts")}</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
      {filters.length > 0 && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-1.5"
          role="group"
          aria-label={t("filter.aria")}
          data-testid="conversation-filter-chips"
        >
          {filters.map((chip) => (
            <Button
              key={chip}
              type="button"
              variant="secondary"
              size="sm"
              className="h-6 gap-1 rounded-pill px-2 text-[11px]"
              onClick={() => onToggleFilter(chip)}
              aria-label={t("filter.remove", { label: t(`filter.${chip}`) })}
              data-testid={`conversation-filter-chip-${chip}`}
            >
              {t(`filter.${chip}`)}
              <XIcon className="size-3" aria-hidden />
            </Button>
          ))}
        </div>
      )}
    </>
  )

  if (error) {
    return (
      <div className="@container/conversation-list flex h-full min-h-0 flex-col">
        {header}
        <div className="min-h-0 flex-1" data-testid="conversation-list-error">
          <StateCard.Error description={t("loadFailed")} onRetry={onRetry} />
        </div>
      </div>
    )
  }

  // The header renders during loading too, so search + filters do not pop in
  // and shove the list down on every open and every project switch.
  if (!sections) {
    return (
      <div className="@container/conversation-list flex h-full min-h-0 flex-col">
        {header}
        <div className="min-h-0 flex-1" data-testid="conversation-list-loading">
          <StateCard.Loading rows={6} />
        </div>
      </div>
    )
  }

  const liveCount = sections.reduce(
    (total, section) => total + (section.tail ? 0 : section.rows.length),
    0
  )
  const isFiltering = Boolean(searchQuery.trim()) || filters.length > 0

  const handleOpen = (row: ConversationRowItem) => onOpenSession(row)
  const handleSelect = (row: ConversationRowItem) => {
    if (touch && touchSelecting) toggleCheck(row.session.id)
    else if (selectionMode === "preview" && onSelectSession) onSelectSession(row)
    else handleOpen(row)
  }
  const anyChecked = checkedRows.length > 0

  /**
   * The check over a row's avatar. Pointer: a real checkbox (Shift-click
   * extends from the anchor), revealed on hover / focus / coarse pointers and
   * on every row once any is checked. Phone selection mode: a decorative mark
   * — the row button itself toggles, and reports it through `aria-pressed`.
   */
  const renderCheck = (item: ConversationRowItem, checked: boolean, name: string) => {
    if (touch) {
      if (!touchSelecting) return null
      return (
        <span
          aria-hidden
          className="pointer-events-none absolute start-3 top-1/2 z-10 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background"
          data-testid={`conversation-row-touch-check-${item.session.id}`}
        >
          {checked ? (
            <CheckCircle2Icon className="size-6 fill-primary text-primary-foreground" />
          ) : (
            <CircleIcon className="size-6 text-muted-foreground" />
          )}
        </span>
      )
    }
    return (
      <span
        data-inbox-row-check={item.session.id}
        className={cn(
          // Wider than the 36px avatar so the platform badge on its corner is
          // covered too, and a 44px touch target on coarse pointers.
          "absolute start-2 top-1/2 z-10 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-background transition-opacity motion-reduce:transition-none",
          checked || anyChecked
            ? "opacity-100"
            : "pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
        )}
      >
        <Checkbox
          checked={checked}
          onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
            // Handled here (with the Shift state) instead of letting Radix
            // flip its own state.
            event.preventDefault()
            toggleCheck(item.session.id, event.shiftKey)
          }}
          aria-label={t("checkRow", { name })}
          className="size-4.5"
          data-testid={`conversation-row-check-${item.session.id}`}
        />
      </span>
    )
  }

  const swipeActionsFor = (
    item: ConversationRowItem
  ): { left: SwipeAction[]; right: SwipeAction[] } => {
    // A list being picked from is not swiped: a sideways slip there is a
    // scroll, not a request to archive.
    if (touchSelecting) return { left: [], right: [] }
    const target = triageTargetOf(item)
    return {
      left: [
        {
          id: "read",
          label: tSession(target.unread ? "markRead" : "markUnread"),
          icon: target.unread ? (
            <MailOpenIcon className="size-4" />
          ) : (
            <MailIcon className="size-4" />
          ),
          className: "bg-sky-600 text-white hover:bg-sky-600/90",
          onSelect: () =>
            void runOn(target.unread ? { kind: "markRead" } : { kind: "markUnread" }, [item]),
        },
      ],
      right: [
        {
          id: "resolve",
          label: tBulk("resolve"),
          icon: <CheckCircleIcon className="size-4" />,
          className: "bg-emerald-600 text-white hover:bg-emerald-600/90",
          onSelect: () => void runOn({ kind: "setStatus", status: "resolved" }, [item]),
        },
        {
          id: "archive",
          label: tSession(target.archived ? "unarchive" : "archive"),
          icon: target.archived ? (
            <ArchiveRestoreIcon className="size-4" />
          ) : (
            <ArchiveIcon className="size-4" />
          ),
          onSelect: () => void runOn({ kind: "setArchived", archived: !target.archived }, [item]),
        },
      ],
    }
  }

  const renderRow = (item: ConversationRowItem) => {
    const ck = item.session.platformBinding!.conversationKey
    const id = item.session.id
    const checked = selection.selected.has(id)
    const name = item.session.title || ck
    const hostLeading = renderRowLeading?.(item)
    const check = renderCheck(item, checked, name)
    const row = (
      <ConversationRow
        item={item}
        draftCount={draftCounts.get(ck) ?? 0}
        isActive={id === selectedSessionId}
        checked={checked}
        pressed={touch && touchSelecting ? checked : undefined}
        labelsById={labelsById}
        now={now}
        onSelect={() => handleSelect(item)}
        onOpen={selectionMode === "preview" ? () => handleOpen(item) : undefined}
        leading={
          check || hostLeading ? (
            <>
              {check}
              {hostLeading}
            </>
          ) : undefined
        }
        onTriage={touch ? undefined : (action) => void runOn(action, [item])}
        menuMode={rowMenu?.sessionId === id ? rowMenu.mode : null}
        onMenuModeChange={(mode) => setRowMenu(mode ? { sessionId: id, mode } : null)}
        onOpenActions={touch ? () => setActionsRow(item) : undefined}
        onContextMenu={
          touch
            ? (event) => {
                // Right-click, Shift+F10 and the context-menu key reach the same
                // sheet a long-press opens.
                event.preventDefault()
                setActionsRow(item)
              }
            : undefined
        }
      />
    )
    if (!touch) {
      return (
        <motion.li key={id} variants={STAGGER_CHILD}>
          {row}
        </motion.li>
      )
    }
    const swipe = swipeActionsFor(item)
    return (
      <motion.li key={id} variants={STAGGER_CHILD}>
        <SwipeRow leftActions={swipe.left} rightActions={swipe.right} actionWidth={72}>
          <LongPress onLongPress={() => setActionsRow(item)} className="block">
            {row}
          </LongPress>
        </SwipeRow>
      </motion.li>
    )
  }

  return (
    <div className="@container/conversation-list flex h-full min-h-0 flex-col">
      {header}

      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-scrollbar]]:hidden">
        <div
          ref={listRef}
          aria-label={t("header")}
          role="region"
          // Focusable so the keymap works once a click lands on the list's
          // background; rows remain the tab stops.
          tabIndex={touch ? undefined : -1}
          onKeyDown={keyboard.onKeyDown}
          className="outline-none"
          data-testid="conversation-list"
        >
          {liveCount === 0 && (
            <div className="px-3 py-4" data-testid="conversation-list-empty">
              <StateCard.Empty
                title={isFiltering ? t("emptyFiltered.title") : t("empty")}
                description={isFiltering ? t("emptyFiltered.description") : t("emptyDescription")}
              />
              {isFiltering && (
                <Button
                  variant="link"
                  size="sm"
                  className="mt-2 h-6 w-full px-1 text-xs"
                  onClick={() => {
                    setSearchQuery("")
                    onClearFilters()
                  }}
                  data-testid="conversation-filter-reset"
                >
                  {t("emptyFiltered.reset")}
                </Button>
              )}
            </div>
          )}

          {sections.map((section) => {
            const listId = sectionListId(section.id)
            const label = sectionLabel(section)
            return (
              <section
                key={section.id}
                aria-label={label}
                className={section.tail ? "border-t" : undefined}
                data-testid={`conversation-section-${section.id}`}
              >
                <ConversationSectionHeader
                  sectionId={section.id}
                  label={label}
                  icon={
                    section.platform ? (
                      <PlatformBadge platform={section.platform as PlatformKind} iconOnly />
                    ) : undefined
                  }
                  count={section.rows.length}
                  // Every row of the Unread section is unread, so the pill would
                  // only repeat the section's own count.
                  unreadCount={section.kind === "unread" ? 0 : section.unreadCount}
                  collapsed={section.collapsed}
                  onToggle={() => setSectionCollapsed(section.id, !section.collapsed)}
                  controlsId={listId}
                  scopeHref={sectionScopeHref(section)}
                />
                {/* Always present so `aria-controls` resolves; rows mount only
                    while expanded. Flat and divided, no cards. */}
                <motion.ul
                  id={listId}
                  hidden={section.collapsed}
                  className="divide-y divide-border/60"
                  initial={reduce ? false : "initial"}
                  animate="animate"
                  variants={STAGGER_CONTAINER}
                >
                  {section.collapsed ? null : section.rows.map(renderRow)}
                </motion.ul>
              </section>
            )
          })}
        </div>
      </ScrollArea>

      {touch && touchSelecting && (
        <MobileConversationBulkBar
          rows={checkedRows}
          visibleCount={visibleRows.length}
          onSelectAll={selection.selectAll}
          onClear={selection.clear}
          onRun={(action) => void runBulk(action)}
        />
      )}

      {touch ? (
        <MobileConversationRowActions
          row={actionsRow}
          onClose={() => setActionsRow(null)}
          onPreview={(item) => onPreviewSession?.(item)}
          onSelect={
            onTouchSelectingChange
              ? (item) => {
                  onTouchSelectingChange(true)
                  if (!selection.selected.has(item.session.id)) toggleCheck(item.session.id)
                }
              : undefined
          }
          onRun={(action, item) => void runOn(action, [item])}
        />
      ) : (
        <InboxShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
      )}
    </div>
  )
}
