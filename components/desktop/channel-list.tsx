"use client"

import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/ai/provider-default-model"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { buttonVariants } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Kbd } from "@/components/ui/kbd"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { SessionListLoading } from "@/components/ui/loading-states"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { PluginViewContainerPanel } from "@/components/shell/plugin-view-container-panel"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { useIsNarrow, useRangeSelection, useEdgeResize } from "@/hooks/ui"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { useConversationListModel } from "@/hooks/chat/use-conversation-list-model"
import { useConversationOrderFreeze } from "@/hooks/chat/use-conversation-order-freeze"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  useConversationReveal,
  type ConversationRevealStep,
} from "@/hooks/chat/use-conversation-reveal"
import { useChatHistorySearch } from "@/hooks/chat/use-chat-history-search"
import { useClientLiveQuery } from "@/hooks/data"
import { listCharacters } from "@/lib/db/characters"
import { listSessionStates } from "@/lib/db/session-state"
import { listTeams } from "@/lib/db/teams"
import { loggers } from "@cognia/logging"
import { avatarColor, type AvatarSubject } from "@/lib/ui/avatar"
import { SHELL_DOCK_TIMING_CLASS } from "@/lib/ui/shell-dock-motion"
import { cn } from "@/lib/utils"
import {
  useUIStore,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  type ChannelListView,
} from "@/stores/ui"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_SIDEBAR_SIDE, type SidebarSide } from "@/types/shell/sidebar"
import { createPortal } from "react-dom"
import { useTitleBarProjection } from "@/components/shell/title-bar-outlets"
import { useEdgePanelTransition } from "@/hooks/shell/use-edge-panel-transition"
import { useReportShellColumn } from "@/hooks/shell/use-report-shell-column"
import { useSidebarNavHost } from "@/hooks/shell/use-sidebar-nav-host"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { SidebarNavSection } from "@/components/shell/sidebar-nav-section"
import { SidebarRowsScope } from "@/components/shell/sidebar-row-roving"
import {
  SidebarCreateTeamRow,
  SidebarGuildSectionRows,
  splitGuildSections,
} from "@/components/shell/sidebar-guild-sections"
import { SidebarFooter } from "@/components/shell/sidebar-footer"
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher"
import { requestCommandPalette } from "@/lib/shell/command-palette-request"
import { densitySurfaceProps } from "@/lib/appearance/density-applier"
import { useProjectStore } from "@/stores/project/project-store"
import { PerfBoundary } from "@/lib/perf"
import {
  projectPendingReorder,
  resolveConversationDrop,
  resolveConversationDropPreview,
  type ConversationDropPreview,
  type PendingReorder,
} from "@/lib/chat/conversation-dnd"
import { useJumpFlash } from "@/hooks/chat/use-jump-flash"
import {
  trackConversationLayoutChanged,
  trackConversationOpened,
  trackConversationReordered,
  trackConversationSearched,
  trackConversationSectionToggled,
  trackConversationViewChanged,
} from "@/lib/telemetry/conversation-list-events"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type {
  ConversationGroupBy,
  ConversationSidebarMetadata,
  ConversationSidebarSettings,
  ConversationSidebarDensity,
  ConversationSidebarTitleMotion,
  ConversationSortBy,
} from "@cognia/agent-config-types"
import { conversationSectionKey, UNGROUPED_ID } from "@/lib/chat/conversation-list-model"
import type { ConversationGroupAxis, DateBucket } from "@/lib/chat/conversation-list-model"
import {
  CONVERSATION_GROUP_AXIS_ICON,
  CONVERSATION_UNGROUPED_LABEL_KEY,
} from "@/lib/chat/conversation-group-axis"
import {
  CONTENT_SEARCH_MIN_QUERY,
  describeConversationSearchScope,
  needsCrossWorkspaceSessions,
  resolveConversationSearchOptions,
  type ResolvedConversationSearchOptions,
} from "@/lib/chat/conversation-search-scope"
import {
  CONVERSATION_GROUP_BY_OPTIONS,
  CONVERSATION_SIDEBAR_METADATA_OPTIONS,
  resolveConversationGroupBy,
  resolveConversationSidebarMetadata,
  toggleConversationSidebarMetadata,
} from "@/lib/chat/conversation-grouping"
import {
  CONVERSATION_SORT_BY_OPTIONS,
  resolveConversationSortBy,
  sortSupportsManualOrder,
} from "@/lib/chat/conversation-filters"
import {
  ConversationFilterChips,
  ConversationFilterMenu,
  ConversationSearchScopeControl,
} from "@/components/chat/conversation-filter-controls"
import { useConversationFilterController } from "@/hooks/chat/use-conversation-filter-controller"
import { getModelDisplayName, getProviderDisplayName } from "@/lib/ai/icons"
import type { Character, ChatSession, SessionFolder, Team } from "@cognia/agent-config-types"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  MenuIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  TextSearchIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react"
import { ChannelListBulkActions } from "./channel-list-bulk-actions"
import { useChannelListActions } from "./channel-list/use-channel-list-actions"
import { SessionRow, type SessionRowMetadataItem } from "./session-row"

const log = loggers.ui

/**
 * Stable empty-folders identity. Passing an inline `folders ?? []` would mint a
 * fresh array every render and, since it's forwarded to every memoized
 * <SessionRow>, bust their memo on any sidebar re-render (cf. the `onSelect`
 * note below). Hoisting the fallback keeps the reference constant.
 */
const EMPTY_FOLDERS: SessionFolder[] = []

/**
 * How the dragged clone lands: a short ease onto the source row's final rect.
 * The source row is dimmed only while the overlay is up (`sideEffects`), so the
 * moment the clone arrives the real row is already at full strength — no
 * second fade to wait through before the landing mark shows.
 */
const CONVERSATION_DROP_ANIMATION: DropAnimation = {
  duration: 220,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.35" } } }),
}
const EMPTY_SESSION_METADATA: SessionRowMetadataItem[] = []

/**
 * The block the guild accordion's open row discloses — the search row and the
 * conversation list beneath it. One sidebar is on screen at a time, so a
 * constant id is enough to pair `aria-expanded` with `aria-controls`.
 */
const GUILD_PANEL_ID = "sidebar-guild-panel"

/**
 * Sticky treatment shared by every section header (date bucket, folder, group).
 *
 * Opaque enough that rows scrolling underneath don't bleed through, translucent
 * enough that a wallpaper still reads. A `background-color` and not a gradient —
 * the tonality rules only swap colors, so a gradient would paint over the
 * wallpaper the chat pane beside it is showing (globals.css §4d).
 */
const STICKY_SECTION_HEADER =
  "sticky top-0 z-10 bg-background/85 supports-[backdrop-filter]:bg-background/60 supports-[backdrop-filter]:backdrop-blur-sm"

/**
 * Collapsible section trigger (workspace / agent group, folder). The whole
 * header row is the hit target — a 24px-tall ghost button with its own hover
 * wash — rather than just the label glyphs, and the chevron rotates in place
 * instead of swapping icons so the toggle reads as one control.
 */
const SECTION_TRIGGER_CLASS =
  "h-6 min-w-0 flex-1 justify-start gap-1.5 rounded-md px-1.5 text-left font-normal text-muted-foreground hover:bg-accent/60 hover:text-foreground data-[state=open]:text-foreground/80"
const SECTION_LABEL_CLASS = "truncate text-[11px] font-semibold tracking-wider uppercase"
const SECTION_COUNT_CLASS =
  "shrink-0 rounded-pill bg-muted-foreground/10 px-1.5 py-px text-[10px] leading-4 font-medium text-muted-foreground/80 tabular-nums"

/** Chevron for a collapsible section: points right when folded, down when open. */
function SectionChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <ChevronRightIcon
      aria-hidden
      data-testid="section-chevron"
      data-collapsed={collapsed || undefined}
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200 motion-reduce:transition-none",
        !collapsed && "rotate-90"
      )}
    />
  )
}

/** Maps a date bucket to its `desktop.channelList` label key. */
/**
 * Rows past which a flat section switches to windowed rendering.
 *
 * High enough that an ordinary profile never pays for the machinery, low
 * enough that the lists which genuinely explode — a search across every
 * workspace, an alphabetical sort over years of conversations — do not paint
 * thousands of rows to show twenty.
 */
const VIRTUAL_ROW_THRESHOLD = 200

/** Row height used to place windowed rows before they have been measured. */
const VIRTUAL_ROW_ESTIMATE = 44

/**
 * A windowed list of conversation rows.
 *
 * Only used for flat, un-draggable sections (see the call site): a sortable
 * context whose items leave the DOM would break dragging, and a sticky group
 * header cannot survive its section being windowed away. Rows measure
 * themselves, so density and the optional preview line still decide their real
 * height.
 */
function VirtualRows({
  sessions,
  renderRow,
}: {
  sessions: ChatSession[]
  /**
   * Renders one row, given the positioning the virtualizer needs on its `<li>`.
   * `SessionRow` already accepts both (`nodeRef` / `nodeStyle`) because a drag
   * positions the same element the same way.
   */
  renderRow: (
    session: ChatSession,
    positioning: { nodeRef: (el: HTMLElement | null) => void; nodeStyle: CSSProperties }
  ) => ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // TanStack Virtual returns non-memoizable functions; the React Compiler
  // correctly skips it. Nothing to fix on our side.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: sessions.length,
    // The section scrolls inside the list's own ScrollArea viewport, which is
    // this element's nearest scrollable ancestor.
    getScrollElement: () =>
      scrollRef.current?.closest<HTMLElement>("[data-slot=scroll-area-viewport]") ?? null,
    estimateSize: () => VIRTUAL_ROW_ESTIMATE,
    overscan: 8,
    getItemKey: (index) => sessions[index]!.id,
  })
  const items = virtualizer.getVirtualItems()
  return (
    <div ref={scrollRef} data-testid="channel-list-virtual-rows">
      {/* The rows position themselves: wrapping each one would nest an `<li>`
          inside an `<li>`, and the row already takes a ref and a style for
          exactly this reason. */}
      <ul className="relative flex flex-col" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) =>
          renderRow(sessions[item.index]!, {
            nodeRef: (el) => {
              if (el) {
                el.dataset.index = String(item.index)
                virtualizer.measureElement(el)
              }
            },
            nodeStyle: {
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${item.start}px)`,
            },
          })
        )}
      </ul>
    </div>
  )
}

const BUCKET_LABEL_KEY: Record<DateBucket, string> = {
  today: "bucketToday",
  yesterday: "bucketYesterday",
  prev7: "bucketPrev7",
  prev30: "bucketPrev30",
  older: "bucketOlder",
}

interface Props {
  sessions: ChatSession[]
  /**
   * True while the Dexie session query hasn't resolved yet (cold start). Lets
   * the list show a skeleton instead of flashing the empty state before the
   * first read lands. Defaults to false.
   */
  loading?: boolean
  activeSessionId: string | null
  onSelect: (id: string) => void
  onNewDirect: () => void
  onNewTeamConversation: (teamId: string) => void
  onDelete: (id: string) => void | Promise<void>
  onRename: (id: string, title: string) => void | Promise<void>
  onTogglePinned?: (id: string, pinned: boolean) => void | Promise<void>
  onArchive?: (id: string) => void | Promise<void>
  onUnarchive?: (id: string) => void | Promise<void>
  onBulkDelete?: (ids: string[]) => void | Promise<void>
  onBulkSetPinned?: (ids: string[], pinned: boolean) => void | Promise<void>
  onBulkArchive?: (ids: string[]) => void | Promise<void>
  onBulkUnarchive?: (ids: string[]) => void | Promise<void>
  /** Conversation folders for this workspace (conversation-list overhaul). */
  folders?: SessionFolder[]
  /**
   * Create a folder and resolve with it. The list opens the new folder's name
   * for editing straight away, so the created row is never left sitting under
   * the placeholder name.
   */
  onCreateFolder?: (name: string) => void | Promise<SessionFolder | unknown>
  onRenameFolder?: (id: string, name: string) => void | Promise<void>
  onDeleteFolder?: (id: string) => void | Promise<void>
  /**
   * Persist a manual folder order. Without it the folder header's move
   * up / down items are hidden — `SessionFolder.order` is the field they
   * write, and it is the axis the list model sorts sections by.
   */
  onReorderFolders?: (ids: string[]) => void | Promise<void>
  onAssignToFolder?: (sessionId: string, folderId: string | null) => void | Promise<void>
  /**
   * Persist a manual ordering of one conversation section (drag-reorder).
   * `sectionKey` is the `conversationSectionKey` of the section dragged in.
   */
  onReorderSessions?: (ids: string[], sectionKey: string) => void | Promise<void>
}

/**
 * The mid sidebar (~260px). Lists sessions filtered by the currently selected
 * guild from `useUIStore`. On narrow viewports it collapses to a sheet
 * triggered by a hamburger button at the very top-left.
 */
export function ChannelList(props: Props) {
  const t = useTranslations("desktop.channelList")
  const isNarrow = useIsNarrow()
  const [openMobile, setOpenMobile] = useState(false)
  const width = useUIStore((s) => s.sidebarWidth)
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth)
  const resetWidth = useCallback(() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT), [setSidebarWidth])

  // Conversation-sidebar collapse. Single source of truth in the ui-store,
  // shared with the title bar's sidebar toggle, the status bar, the View menu,
  // and ⌘B, so every surface stays in lockstep. The rail stays mounted and
  // animates its width to 0 — collapsing is smooth and reclaims the WHOLE
  // column (no leftover strip); the list header exposes the quick-collapse
  // action while the global shortcut and View menu share the same state.
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  // The rail's header renders into the title bar's start outlet when the
  // workspace enables projection (`title-bar-outlets.tsx`), and stands down
  // while collapsed so an invisible column leaves nothing in the bar. The bar
  // sizes that outlet from the width reported below.
  // Which edge the sidebar takes — the same preference the nav rail follows
  // (`types/shell/sidebar.ts`), so the two chat columns stay together instead
  // of the navigation jumping sides when the user lands on `/`.
  const sidebarSide = useSettingsStore((s) => s.settings?.sidebarSide ?? DEFAULT_SIDEBAR_SIDE)
  // The rail's header renders into the title bar's *start* outlet — the
  // leading column's zone. On the right edge there is no such zone to take
  // (the end zone belongs to the artifact dock's header), so the sidebar keeps
  // its own 40px header there and the icon column stays beside it, unfolded.
  const headerOutlet = useTitleBarProjection("start", {
    active: !sidebarCollapsed && !isNarrow && sidebarSide === "left",
  })
  const asideRef = useRef<HTMLElement | null>(null)
  useReportShellColumn("sidebar", asideRef)
  // Enable the width transition ONLY for the brief collapse/expand animation —
  // never while the user drag-resizes (resize mutates the same `width`, and a
  // live transition would make the drag rubber-band). Shared with the nav rail,
  // the status bar and the terminal dock, which have the same problem for the
  // same reason — including the part where the flag has to be raised during
  // render so the class and the new width reach the DOM in one commit.
  const animatingCollapse = useEdgePanelTransition(sidebarCollapsed, { element: asideRef })

  // Stable identity: passed down as `onSelect`, it feeds `handleSessionSelect`
  // (a useCallback that lists it as a dep). An inline function here changed
  // every render → busted EVERY memoized <SessionRow> on any sidebar
  // re-render (a full history-list re-render). useCallback keeps the rows'
  // memo effective so a re-render touches only the rows that actually changed.
  const { onSelect } = props
  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id)
      if (isNarrow) setOpenMobile(false)
    },
    [onSelect, isNarrow]
  )

  const handleSheetChange = (next: boolean) => {
    log.info("channel-list sheet toggle", { open: next })
    setOpenMobile(next)
  }

  if (isNarrow) {
    return (
      <Sheet open={openMobile} onOpenChange={handleSheetChange}>
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("openSessions")}
            className="absolute top-2 left-2 z-10 md:hidden"
          >
            <MenuIcon className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72 bg-transparent p-0">
          <div
            className="flex h-full min-h-0 flex-col bg-background"
            data-bg-target="chat"
            data-slot="sidebar-inner"
          >
            <SheetHeader className="px-3 pt-3 pb-1">
              <SheetTitle className="text-sm">{t("conversationsTitle")}</SheetTitle>
            </SheetHeader>
            <ChannelListBody {...props} onSelect={handleSelect} surface="sheet" />
          </div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <aside
      ref={asideRef}
      id="conversation-sidebar"
      className={cn(
        "relative hidden h-full shrink-0 flex-col bg-muted/15 md:flex",
        // The seam goes on the side facing the chat pane, which flips with the
        // edge the sidebar takes.
        sidebarCollapsed
          ? "border-r-0 border-l-0"
          : sidebarSide === "right"
            ? "border-l"
            : "border-r",
        // Clip during collapse (and while animating) so the fixed-width inner
        // layer is hidden rather than spilling; leave it un-clipped when idle
        // so the resize handle can protrude past the right edge.
        (sidebarCollapsed || animatingCollapse) && "overflow-hidden",
        // One clock for every shell edge panel — this rail, the artifact dock
        // and the terminal dock all collapse at `SHELL_DOCK_TIMING_CLASS`'s
        // pace. They used to claim parity in a comment while running 200ms
        // `ease-in-out` against the dock's 280ms `MOBILE_EASE`.
        animatingCollapse && `transition-[width] ${SHELL_DOCK_TIMING_CLASS}`
      )}
      style={{ width: sidebarCollapsed ? 0 : width }}
      aria-label={t("conversationsTitle")}
      aria-hidden={sidebarCollapsed || undefined}
      inert={sidebarCollapsed || undefined}
      data-bg-target="chat"
      // Deliberately NOT `data-slot="sidebar-inner"`. That slot's wallpaper
      // rule (globals.css, "when a wallpaper is painting under a shadcn
      // sidebar") tints with `--sidebar` at a hardcoded 55% / 8px blur — a
      // second slab stacked under the body's own `data-tonality` surface, and
      // keyed to a different base colour than the header and message area. The
      // rail carries one tint now, owned by `ChannelListBody` below.
      data-collapsed={sidebarCollapsed || undefined}
    >
      {/* Fixed-width inner layer: keeps the list from reflowing as the aside's
          width animates to 0 — the content is clipped, not squished. */}
      <div className="flex h-full min-h-0 flex-col" style={{ width }}>
        <ChannelListBody {...props} onSelect={handleSelect} headerOutlet={headerOutlet} />
      </div>
      {!sidebarCollapsed && (
        <SidebarResizeHandle
          width={width}
          onChange={setSidebarWidth}
          onReset={resetWidth}
          // The handle lives on the inboard edge — the one facing the chat
          // pane — so dragging it always widens toward the content.
          side={sidebarSide}
        />
      )}
    </aside>
  )
}

/**
 * Draggable divider on the right edge of the conversation sidebar. Controlled
 * width lives in `useUIStore`; a11y mirrors `ResizableHandle` (focusable
 * `role="separator"` with value + orientation). Double-click / Enter resets.
 */
function SidebarResizeHandle({
  width,
  onChange,
  onReset,
  side = "left",
}: {
  width: number
  onChange: (width: number) => void
  onReset: () => void
  /** Which edge of the window the sidebar occupies. */
  side?: SidebarSide
}) {
  const t = useTranslations("desktop.channelList")
  const onRight = side === "right"
  const { dragging, onPointerDown, onPointerMove, onPointerUp, onKeyDown, onDoubleClick } =
    useEdgeResize({
      width,
      min: SIDEBAR_WIDTH_MIN,
      max: SIDEBAR_WIDTH_MAX,
      onChange,
      onReset,
      // A right-docked sidebar grows as the pointer moves *left*, so the hook
      // has to invert the delta — that is exactly what its `edge` option is.
      edge: onRight ? "left" : "right",
    })
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t("resizeHandle")}
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
      className={cn(
        "absolute inset-y-0 z-10 w-1.5 cursor-col-resize",
        onRight ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2",
        "hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none",
        dragging && "bg-primary/40"
      )}
    />
  )
}

function ChannelListBody({
  headerOutlet = null,
  surface = "rail",
  sessions,
  loading,
  activeSessionId,
  onSelect,
  onNewDirect,
  onNewTeamConversation,
  onDelete,
  onRename,
  onTogglePinned,
  onArchive,
  onUnarchive,
  onBulkDelete,
  onBulkSetPinned,
  onBulkArchive,
  onBulkUnarchive,
  folders,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onReorderFolders,
  onAssignToFolder,
  onReorderSessions,
}: Props & {
  /**
   * Title-bar outlet for the header, or `null` to draw it inline. Only the
   * desktop rail passes one; the mobile Sheet keeps its header where it is.
   */
  headerOutlet?: HTMLElement | null
  /**
   * `rail` (default) — the desktop aside, which can be collapsed to a 0-width
   * column and is what the app-wide focus-search shortcut expands. `sheet` —
   * the narrow-viewport Sheet, which is never collapsed and must not touch the
   * desktop collapse preference.
   */
  surface?: "rail" | "sheet"
}) {
  const t = useTranslations("desktop.channelList")
  // Filter vocabulary is shared with the mobile list — see
  // `components/chat/conversation-filter-controls.tsx`.
  const tFilters = useTranslations("conversationFilters")
  const selectedGuild = useUIStore((s) => s.selectedGuild)

  // Behavior preferences (Settings → Conversation). Absent settings fall back
  // to today's defaults so the sidebar renders identically before load.
  const sidebarSettings = useSettingsStore((s) => s.settings?.conversationSidebar)
  // ADR-0127: appearance-level density (Settings → Appearance → Density →
  // "sidebar"), distinct from the conversation-sidebar row density below. The
  // list root is the `sidebar` density surface so `--density-*` resolve here.
  const appearanceDensity = useSettingsStore((s) => s.settings?.density)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const saveSettings = useSettingsStore((s) => s.save)
  const density: ConversationSidebarDensity = sidebarSettings?.density ?? "comfortable"
  const showPreview = sidebarSettings?.showPreview ?? false
  const showCustomIcons = sidebarSettings?.showCustomIcons ?? true
  const showTimestamps = sidebarSettings?.showTimestamps ?? true
  const groupBy = resolveConversationGroupBy(sidebarSettings)
  const sortBy = resolveConversationSortBy(sidebarSettings)
  const showUnreadBadges = sidebarSettings?.showUnreadBadges ?? true
  // What a query is allowed to reach: workspaces, archived rows, message
  // content. One resolved object rather than three settings read from three
  // unrelated places — see `lib/chat/conversation-search-scope.ts`.
  const searchOptions = useMemo(
    () => resolveConversationSearchOptions(sidebarSettings),
    [sidebarSettings]
  )
  const metadataFields = useMemo(
    () => resolveConversationSidebarMetadata(sidebarSettings),
    [sidebarSettings]
  )
  const titleMotion: ConversationSidebarTitleMotion = sidebarSettings?.titleMotion ?? "hover"
  const sidebarSettingsRef = useRef(sidebarSettings)
  const sidebarSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingSidebarSavesRef = useRef(0)
  useEffect(() => {
    // Ignore intermediate store snapshots while optimistic writes are queued.
    // The queue's final write already carries the complete merged value; an
    // earlier snapshot must not roll the merge base back between user clicks.
    if (pendingSidebarSavesRef.current === 0) {
      sidebarSettingsRef.current = sidebarSettings
    }
  }, [sidebarSettings])
  const saveSidebarSettings = useCallback(
    (patch: Partial<ConversationSidebarSettings>) => {
      const next = { ...sidebarSettingsRef.current, ...patch }
      // Advance the merge base before the async store write resolves. A user
      // can reopen the menu and toggle another option immediately; merging
      // against the optimistic value prevents that second write from
      // restoring the first option's stale value.
      sidebarSettingsRef.current = next
      pendingSidebarSavesRef.current += 1
      void trackConversationLayoutChanged(patch)
      sidebarSaveQueueRef.current = sidebarSaveQueueRef.current
        .then(() => saveSettings({ conversationSidebar: next }))
        .catch((error) => {
          log.warn("channel-list display settings save failed", { error: String(error) })
        })
        .finally(() => {
          pendingSidebarSavesRef.current -= 1
        })
    },
    [saveSettings]
  )
  // Narrow once: this component is only ever rendered for the chat
  // (DM/team) guilds. The shell branches on `kind === "canvas"`
  // upstream and renders the CanvasDocumentRail instead.
  const chatGuild = useMemo(
    () =>
      selectedGuild.kind === "canvas" || selectedGuild.kind === "plugin-view"
        ? ({ kind: "dm" } as const)
        : selectedGuild,
    [selectedGuild]
  )
  const characters = useClientLiveQuery<Character[]>(() => listCharacters(), [], [])
  const characterById = useMemo(() => {
    const map = new Map<string, Character>()
    for (const c of characters ?? []) map.set(c.id, c)
    return map
  }, [characters])

  const sessionStates = useClientLiveQuery(() => listSessionStates(), [], [])
  // Two derivations of the same table on purpose: `unreadIds` drives the unread
  // *filter* and *sort*, which must keep working when the user has turned the
  // per-row badges off — hiding a badge is a display choice, not a statement
  // that unread no longer exists.
  const unreadIds = useMemo(() => {
    const ids = new Set<string>()
    for (const s of sessionStates ?? []) if (s.unreadCount > 0) ids.add(s.sessionId)
    return ids
  }, [sessionStates])
  const unreadById = useMemo(() => {
    const map = new Map<string, number>()
    if (!showUnreadBadges) return map
    for (const s of sessionStates ?? []) {
      if (s.unreadCount > 0) map.set(s.sessionId, s.unreadCount)
    }
    return map
  }, [sessionStates, showUnreadBadges])

  const teams = useClientLiveQuery<Team[]>(() => listTeams(), [], [])
  const teamById = useMemo(() => new Map((teams ?? []).map((item) => [item.id, item])), [teams])
  const team = chatGuild.kind === "team" ? teamById.get(chatGuild.teamId) : undefined

  // The expanded desktop rail (its title projected into the bar) is the
  // workspace sidebar: it also hosts the shell navigation as rows and the
  // guild accordion, so the 56px icon column can step aside
  // (`sidebarHostsNav`). The mobile Sheet, a collapsed rail (no outlet) and a
  // plugin view that replaces the list all leave the icon column in charge.
  const merged = headerOutlet !== null
  useSidebarNavHost(
    merged && selectedGuild.kind !== "canvas" && selectedGuild.kind !== "plugin-view"
  )

  // Filter the session list by selected guild — but only under `groupBy: "team"`.
  //
  // The rail's Direct-messages / Team buttons are one way to organize the list,
  // and grouping is now the general form of that idea: picking any other axis
  // means the rail no longer decides what the list contains, so a team
  // conversation shows up inside its workspace / date / agent section like any
  // other. (Phase D) Sessions with `kind === "workflow-editor"` are scoped to
  // the workflow editor's chat tab and never surface in the main channel list —
  // they appear ONLY inside the editor itself. `kind === "subagent"` sessions
  // (ADR-0062) are hidden imported-subagent inner transcripts, reachable only by
  // drilling in from a parent turn's SubagentPart — never in the list, search,
  // or a bucket.
  const filtered = useMemo(() => {
    const visible = filterExposedSessions(sessions, "main-list")
    if (groupBy !== "team") return visible
    if (chatGuild.kind === "team") {
      return visible.filter((s) => s.kind === "team" && s.teamId === chatGuild.teamId)
    }
    // DM bucket: anything that isn't a team session.
    return visible.filter((s) => s.kind !== "team")
  }, [sessions, chatGuild, groupBy])

  // Search owns only the debounced model query here. The immediate field value
  // lives inside `ChannelListSearch`, so each keystroke repaints the input
  // without traversing the grouping model, DnD contexts, and every row.
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")

  // Active ⇄ Archived view — read straight from the persisted UI store, like
  // `collapsedFolderIds` below. A local mirror seeded once at mount could not
  // see another writer switch the view (the mobile list, or the reveal ladder
  // that has to bring a freshly created conversation back into sight) and wrote
  // its stale copy back over theirs.
  const view = useUIStore((s) => s.channelListView)
  const setPersistedView = useUIStore((s) => s.setChannelListView)
  const setView = useCallback(
    (next: ChannelListView) => {
      setPersistedView(next)
      void trackConversationViewChanged(next)
    },
    [setPersistedView]
  )

  // Folder collapse lives in the UI store, and is read straight from it — no
  // local mirror. A copy seeded once at mount could not see the mobile list
  // (or any other surface) collapsing a folder, and its write-back then
  // overwrote that surface's value with the stale snapshot. One source of
  // truth, one writer.
  const persistedCollapsed = useUIStore((s) => s.collapsedFolderIds)
  const toggleCollapsedFolder = useUIStore((s) => s.toggleCollapsedFolder)
  const collapsedFolderIds = useMemo<ReadonlySet<string>>(
    () => new Set(persistedCollapsed),
    [persistedCollapsed]
  )
  const toggleFolderCollapsed = useCallback(
    (id: string) => {
      // Read the outcome before the write: telemetry is a side effect and the
      // store action is the thing that flips it.
      void trackConversationSectionToggled(`folder:${id}`, !collapsedFolderIds.has(id))
      toggleCollapsedFolder(id)
    },
    [collapsedFolderIds, toggleCollapsedFolder]
  )

  // Folders only group the active view (archived chats stay in date buckets).
  const modelFolders = view === "archived" ? undefined : folders

  // Group axes the model can't resolve on its own — it stays pure, so the
  // display names come from here.
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  // Which workspaces the *content* index is asked about — the same reach the
  // session list is loaded with, so title hits and message hits never disagree
  // about which conversations exist.
  const scopeProjectId = needsCrossWorkspaceSessions(groupBy, searchOptions)
    ? undefined
    : (activeProjectId ?? undefined)
  const contentSearch = useChatHistorySearch(query, {
    enabled: searchOptions.content,
    projectId: scopeProjectId,
    // The index is asked for both sides whenever the query may cross the
    // archive split; the model still decides which of them survive.
    includeArchived: searchOptions.includeArchived || view === "archived",
    collapseBySession: true,
    limit: 200,
  })
  const contentMatchIds = useMemo<ReadonlySet<string> | undefined>(() => {
    if (!searchOptions.content || query.trim().length < CONTENT_SEARCH_MIN_QUERY) return undefined
    return new Set(contentSearch.results.map((result) => result.sessionId))
  }, [searchOptions.content, query, contentSearch.results])
  // Message search needs two characters (`useChatHistorySearch`'s
  // `minQueryLength`); titles match from one. Without saying so, a one-character
  // query silently degrades to title-only and reads as a broken index.
  const contentBelowMinQuery =
    searchOptions.content &&
    query.trim().length > 0 &&
    query.trim().length < CONTENT_SEARCH_MIN_QUERY
  // A content query resolves a beat after the title hits. Until it settles the
  // result set is incomplete, so the list must not claim there is nothing.
  const contentPending = searchOptions.content && contentSearch.loading && query.trim().length > 0
  const contentTruncated =
    contentSearch.moreOlderHistory || contentSearch.indexIncomplete || contentSearch.error !== null
  const workspaceGroups = useMemo(
    () => projects.map((p) => ({ id: p.id, name: p.name })),
    [projects]
  )
  const workspaceById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  )
  const agentGroups = useMemo(
    () => (characters ?? []).map((c) => ({ id: c.id, name: c.name })),
    [characters]
  )
  const groupCollapseOverrides = useUIStore((s) => s.groupCollapseOverrides)
  const setGroupCollapsedInStore = useUIStore((s) => s.setGroupCollapsed)
  const setGroupCollapsed = useCallback(
    (key: string, collapsed: boolean) => {
      setGroupCollapsedInStore(key, collapsed)
      void trackConversationSectionToggled(key, collapsed)
    },
    [setGroupCollapsedInStore]
  )

  // Filters, sort, saved presets and the per-facet option candidates all come
  // from one controller shared with the mobile list. Active filters live in
  // the UI store (layout state, like the archive view) so the choice survives
  // reloads; presets ride in the settings blob so they follow the profile. The
  // chip row below keeps a narrowed list from ever looking like a lost one.
  const viewSessions = useMemo(
    () =>
      filtered.filter((s) => (view === "archived" ? s.archivedAt != null : s.archivedAt == null)),
    [filtered, view]
  )
  const filterController = useConversationFilterController({
    sessions: viewSessions,
    workspaces: workspaceGroups,
    folders: modelFolders,
    characters: characters ?? undefined,
    teams: teams ?? undefined,
    sidebarSettings,
    saveSidebarSettings,
  })
  const { filters, activeFilters, filterContext } = filterController
  const resetConversationFilters = filterController.actions.reset

  // Grouping/filtering/sorting/search now live in the shared headless model
  // (pinned → folders → the chosen axis, or a flat result list while searching).
  const {
    sections,
    total,
    filteredCount,
    visibleCount,
    orderedIds,
    contentOnlyIds,
    activeFilterCount,
  } = useConversationListModel({
    sessions: filtered,
    folders: modelFolders,
    query,
    view,
    collapsedFolderIds,
    groupBy,
    sortBy,
    filters,
    unreadIds,
    filterContext,
    workspaces: workspaceGroups,
    agents: agentGroups,
    activeWorkspaceId: activeProjectId,
    groupCollapseOverrides,
    contentMatchIds: searchOptions.content ? contentMatchIds : undefined,
    searchIncludesArchived: searchOptions.includeArchived,
  })

  // Remount token for the search field: it owns the immediate input value, so
  // clearing `query` from out here (the reveal ladder below) has to reach it.
  const [searchResetToken, setSearchResetToken] = useState(0)
  // A conversation that was just created has to be visible in this list. The
  // narrowing state is sticky and persisted — Archived view, a search still in
  // the field, a quick filter left on since yesterday — so without this the new
  // chat opens in the pane while the sidebar shows no trace of it. One rung is
  // undone per pass, cheapest first, and only while the row is genuinely
  // off screen.
  const revealListed = useCallback(
    (id: string) => filtered.some((session) => session.id === id),
    [filtered]
  )
  const revealVisible = useCallback((id: string) => orderedIds.includes(id), [orderedIds])
  const revealSteps = useCallback(
    (id: string): ConversationRevealStep[] => {
      // Last rung: the row is in a section the user folded away.
      const holder = sections.find(
        (section) =>
          (section.kind === "folder" || section.kind === "group") &&
          section.collapsed &&
          section.sessions.some((session) => session.id === id)
      )
      return [
        { active: view !== "active", undo: () => setView("active") },
        {
          active: query.length > 0,
          undo: () => {
            setQuery("")
            setSearchResetToken((token) => token + 1)
          },
        },
        { active: activeFilterCount > 0, undo: resetConversationFilters },
        {
          active: holder != null,
          undo: () => {
            if (holder?.kind === "folder") toggleFolderCollapsed(holder.folder.id)
            else if (holder?.kind === "group")
              setGroupCollapsed(conversationSectionKey(holder), false)
          },
        },
      ]
    },
    [
      sections,
      view,
      setView,
      query,
      setQuery,
      activeFilterCount,
      resetConversationFilters,
      toggleFolderCollapsed,
      setGroupCollapsed,
    ]
  )
  useConversationReveal({
    activeSessionId,
    listed: revealListed,
    visible: revealVisible,
    steps: revealSteps,
  })

  // One search event per settled query (debounced upstream, so this is per
  // pause in typing, not per keystroke): waits for the content index when that
  // scope is on, and reports the length of the query, never its text.
  const reportedSearchRef = useRef<string | null>(null)
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      reportedSearchRef.current = null
      return
    }
    if (contentPending) return
    // Names the reach, never the text: which axes were widened is the useful
    // signal, and it is not derived from anything the user typed.
    const scope = describeConversationSearchScope(searchOptions)
    const stamp = `${scope}:${trimmed}`
    if (reportedSearchRef.current === stamp) return
    reportedSearchRef.current = stamp
    void trackConversationSearched({
      scope,
      query: trimmed,
      resultCount: filteredCount,
      truncated: contentTruncated,
    })
  }, [query, searchOptions, contentPending, filteredCount, contentTruncated])

  // Per-row accent: team sessions inherit the team color, DM sessions inherit
  // their character color. Replaces the old per-character group accent.
  const accentFor = useCallback(
    (s: ChatSession): string | undefined => {
      if (s.kind === "team") {
        const sessionTeam = s.teamId ? teamById.get(s.teamId) : undefined
        return sessionTeam ? avatarColor(sessionTeam) : undefined
      }
      const character = s.characterId ? characterById.get(s.characterId) : null
      return character ? avatarColor(character) : undefined
    },
    [teamById, characterById]
  )

  const iconFor = useCallback(
    (s: ChatSession): AvatarSubject | undefined => {
      if (!showCustomIcons) return undefined
      const subject =
        s.kind === "team"
          ? s.teamId
            ? teamById.get(s.teamId)
            : undefined
          : s.characterId
            ? characterById.get(s.characterId)
            : undefined
      if (!subject) return undefined
      return {
        name: subject.name,
        avatarColor: subject.avatarColor,
        avatarEmoji: subject.avatarEmoji,
        avatarImageUrl: "avatarImage" in subject ? subject.avatarImage?.webDataUrl : undefined,
      }
    },
    [characterById, showCustomIcons, teamById]
  )

  const metadataBySessionId = useMemo(() => {
    const result = new Map<string, SessionRowMetadataItem[]>()
    for (const session of filtered) {
      const character = session.characterId ? characterById.get(session.characterId) : undefined
      const values: Record<ConversationSidebarMetadata, string | undefined> = {
        agent:
          session.kind === "team"
            ? session.teamId
              ? teamById.get(session.teamId)?.name
              : undefined
            : character?.name,
        model: getModelDisplayName(
          session.model ?? character?.model ?? defaultModel ?? ANTHROPIC_DEFAULT_MODEL
        ),
        provider: getProviderDisplayName(
          session.providerOverride ?? character?.providerId ?? defaultProvider ?? "anthropic"
        ),
        workspace: session.projectId ? workspaceById.get(session.projectId) : undefined,
      }
      const metadata = metadataFields.flatMap((kind) => {
        const value = values[kind]
        return value ? [{ kind, value }] : []
      })
      result.set(session.id, metadata)
    }
    return result
  }, [
    characterById,
    defaultModel,
    defaultProvider,
    filtered,
    metadataFields,
    teamById,
    workspaceById,
  ])
  const metadataFor = useCallback(
    (session: ChatSession) => metadataBySessionId.get(session.id) ?? EMPTY_SESSION_METADATA,
    [metadataBySessionId]
  )

  const selection = useRangeSelection(orderedIds)
  const { selected, handleClick, selectAll, clear, isSelected, lastInteractionWasModified } =
    selection

  // Keyboard-navigation focus ring (independent of the multi-selection).
  const [focusedId, setFocusedId] = useState<string | null>(null)

  // Clear the multi-selection AND the keyboard focus whenever the user pivots
  // to a different guild/view — the visual context changes and stale state
  // would confuse the bulk-toolbar count / focus ring. `clear` is a stable
  // callback (`useCallback(..., [])` inside the hook) so it never trips this.
  useEffect(() => {
    clear()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusedId(null)
  }, [chatGuild, view, clear])

  const {
    handleNewDirect,
    handleNewTeamConversation,
    rowActions,
    renamingFolderId,
    handleNewFolder,
    handleFolderRenameSettled,
    handleMoveFolder,
  } = useChannelListActions({
    folders: folders ?? EMPTY_FOLDERS,
    newFolderName: t("newFolderName"),
    onNewDirect,
    onNewTeamConversation,
    onDelete,
    onRename,
    onTogglePinned,
    onArchive,
    onUnarchive,
    onBulkDelete,
    onBulkSetPinned,
    onBulkArchive,
    onBulkUnarchive,
    onCreateFolder,
    onReorderFolders,
    onAssignToFolder,
  })

  const handleSessionSelect = useCallback(
    (id: string, e: ReactMouseEvent) => {
      const modified = e.ctrlKey || e.metaKey || e.shiftKey
      handleClick(id, e)
      // Plain click activates the session in the chat panel; modifier-bearing
      // clicks only mutate the selection. This mirrors Explorer / Finder.
      if (!modified) {
        void trackConversationOpened(id, "click")
        onSelect(id)
      }
    },
    [handleClick, onSelect]
  )
  const handleToggleSelection = useCallback(
    (id: string) => {
      handleClick(id, { ctrlKey: true, metaKey: false, shiftKey: false })
    },
    [handleClick]
  )

  // Branched sessions show a small lineage chip; clicking it activates the
  // parent conversation in the chat panel (no selection-mutation).
  const handleJumpToParent = useCallback(
    (parentId: string) => {
      void trackConversationOpened(parentId, "parent-link")
      onSelect(parentId)
    },
    [onSelect]
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const handleContainerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      const typing =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        target.closest('[role="menu"],[role="dialog"]') != null

      if (e.key === "Escape") {
        if (selected.size > 0) {
          e.preventDefault()
          clear()
        } else if (focusedId) {
          e.preventDefault()
          setFocusedId(null)
        }
        return
      }
      const isCtrlA = (e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")
      if (isCtrlA && orderedIds.length > 0) {
        e.preventDefault()
        selectAll()
        return
      }
      // Row navigation is disabled while typing in the search box / inside a
      // menu or dialog (mirrors the log-panel shortcut guards).
      if (typing) return

      if (e.key === "/") {
        e.preventDefault()
        searchInputRef.current?.focus()
        return
      }
      if (orderedIds.length === 0) return
      const current = focusedId ? orderedIds.indexOf(focusedId) : -1
      const focusAt = (index: number) => {
        e.preventDefault()
        setFocusedId(orderedIds[Math.min(orderedIds.length - 1, Math.max(0, index))])
      }
      if (e.key === "ArrowDown" || e.key === "j") focusAt(current < 0 ? 0 : current + 1)
      else if (e.key === "ArrowUp" || e.key === "k")
        focusAt(current < 0 ? orderedIds.length - 1 : current - 1)
      else if (e.key === "Home") focusAt(0)
      else if (e.key === "End") focusAt(orderedIds.length - 1)
      else if (e.key === "Enter" && focusedId) {
        e.preventDefault()
        void trackConversationOpened(focusedId, "keyboard")
        onSelect(focusedId)
      }
    },
    [clear, orderedIds, selectAll, selected.size, focusedId, onSelect]
  )

  // App-wide shortcuts for the list, live while it is mounted (`useAppShortcut`
  // is mount-scoped, so `/settings` and the other routes never see them):
  //
  // - `/` (`app.search.focus`) focuses the conversation search from anywhere on
  //   the chat route, not only once focus is already inside the rail (which is
  //   all the container handler above can do). A collapsed rail is expanded
  //   first — the field is `inert` while collapsed, so the focus has to wait
  //   for the frame that renders it back.
  // - ⌘⌥[ / ⌘⌥] step the *active* conversation through the list's visible
  //   order (`orderedIds`, after grouping / filters / search), so the composer
  //   never has to lose focus to move between chats.
  const railCollapsed = useUIStore((s) => surface === "rail" && s.sidebarCollapsed)
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed)
  const [searchFocusRequest, setSearchFocusRequest] = useState(0)
  useEffect(() => {
    if (searchFocusRequest === 0 || railCollapsed) return
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }, [searchFocusRequest, railCollapsed])
  const focusSearch = useCallback(() => {
    log.info("channel-list focus-search shortcut", { expand: railCollapsed })
    if (railCollapsed) setSidebarCollapsed(false)
    setSearchFocusRequest((n) => n + 1)
  }, [railCollapsed, setSidebarCollapsed])
  useAppShortcut("app.search.focus", focusSearch, { preventDefault: true })
  const stepActiveConversation = useCallback(
    (delta: 1 | -1) => {
      if (orderedIds.length === 0) return
      const current = activeSessionId ? orderedIds.indexOf(activeSessionId) : -1
      // No active conversation (or one the current view hides): start from
      // the end the step comes from, the way the arrow keys do.
      const target =
        current === -1
          ? delta === 1
            ? 0
            : orderedIds.length - 1
          : Math.min(orderedIds.length - 1, Math.max(0, current + delta))
      const next = orderedIds[target]
      if (!next || next === activeSessionId) return
      log.info("channel-list step conversation", { delta })
      void trackConversationOpened(next, "keyboard")
      setFocusedId(next)
      onSelect(next)
    },
    [orderedIds, activeSessionId, onSelect]
  )
  const stepNext = useCallback(() => stepActiveConversation(1), [stepActiveConversation])
  const stepPrevious = useCallback(() => stepActiveConversation(-1), [stepActiveConversation])
  useAppShortcut("shell.conversation.next", stepNext, {
    allowInEditable: true,
    preventDefault: true,
  })
  useAppShortcut("shell.conversation.previous", stepPrevious, {
    allowInEditable: true,
    preventDefault: true,
  })

  // Drag-and-drop: reorder any conversation section or drop a conversation onto
  // a folder. Only under the default recency sort — every other mode derives its
  // order from session data, so a persisted manual order would be ignored and
  // the grip would be promising something the list cannot keep.
  const reorderable = sortSupportsManualOrder(sortBy)
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  // The order the user just dropped, projected over the model until the live
  // query re-emits with it persisted (see `projectPendingReorder`). Without
  // this the drop lands a few frames *before* the store: @dnd-kit resets its
  // transforms, every row glides back to where it started, and the real
  // reorder then arrives as an instant DOM swap — two similar rows read as
  // "nothing happened". Rendering the dropped order in the same tick as the
  // drop lets the overlay's drop animation carry the row into its final slot.
  const [pendingReorder, setPendingReorder] = useState<PendingReorder | null>(null)
  // The row being dragged — drives the DragOverlay clone that follows the
  // pointer while the source row stays put as a placeholder.
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const projectedReorder = useMemo(
    () => projectPendingReorder(sections, pendingReorder),
    [sections, pendingReorder]
  )
  // Hold the order still while the pointer is in the list — the one moment a
  // moving row costs something. Read from the DOM rather than derived: whether
  // the pointer is over the list is a fact about the surface, not the model.
  const [pointerInList, setPointerInList] = useState(false)
  const displaySections = useConversationOrderFreeze({
    sections: projectedReorder.sections,
    hovering: pointerInList,
    // Search results are ranked by relevance and a drag already owns the order
    // it is previewing; a freeze on top of either would be a third story about
    // where a row is.
    disabled: query.trim().length > 0 || activeDragId !== null,
  })
  // Drop the projection the moment it stops being needed: `settled` means the
  // store now carries the dropped order; `stale` means the store moved
  // elsewhere and the snapshot must not override it. Either way it must not
  // linger and re-apply later against an order it never saw. Reset during
  // render (React's "adjust state from props" pattern) rather than in an
  // effect, so the frame that shows the store's order is the same frame that
  // forgets the projection — no cascade, no one-frame flash of a dead override.
  if (pendingReorder && projectedReorder.status !== "applied") setPendingReorder(null)
  // Maps each session id to the ordered ids of the section it renders in (and
  // that section's stable key), so a drop can reorder that section (pinned /
  // date bucket / folder / recent) and tag the persisted order with the
  // section it belongs to. Search results aren't reorderable and are
  // intentionally excluded. Built from the *displayed* order so a second drag
  // that starts before the store caught up still reasons about what is on
  // screen.
  const sectionIdsBySession = useMemo(() => {
    const map = new Map<string, { ids: string[]; key: string }>()
    for (const section of displaySections) {
      if (section.kind === "search") continue
      const ids = section.sessions.map((s) => s.id)
      const key = conversationSectionKey(section)
      for (const id of ids) map.set(id, { ids, key })
    }
    return map
  }, [displaySections])
  const [dropPreview, setDropPreview] = useState<ConversationDropPreview | null>(null)
  // "This is the row you just moved": the same landing mark conversation
  // jumps use, so a reorder between look-alike rows still answers which one
  // moved once the drop animation has finished.
  const {
    flash: flashSettled,
    flashId: settledId,
    flashNonce: settledNonce,
    holdMs: settleHoldMs,
  } = useJumpFlash()
  const handleDragStart = useCallback((e: DragStartEvent) => {
    setActiveDragId(String(e.active.id))
  }, [])
  const handleDragCancel = useCallback(() => {
    setActiveDragId(null)
    setDropPreview(null)
  }, [])
  const handleDragOver = useCallback(
    (e: DragOverEvent) => {
      const activeId = String(e.active.id)
      const overId = e.over ? String(e.over.id) : null
      const overSection = overId ? sectionIdsBySession.get(overId) : undefined
      setDropPreview(
        overId && overSection
          ? resolveConversationDropPreview(activeId, overId, overSection.ids)
          : null
      )
    },
    [sectionIdsBySession]
  )
  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveDragId(null)
      setDropPreview(null)
      // Reorder is scoped to the section the drop target lives in.
      const overId = e.over ? String(e.over.id) : null
      const overSection = overId ? sectionIdsBySession.get(overId) : undefined
      const action = resolveConversationDrop(
        e.active ? { id: String(e.active.id), data: e.active.data.current } : null,
        e.over ? { id: overId!, data: e.over.data.current } : null,
        overSection?.ids ?? []
      )
      if (!action) return
      if (action.type === "assign") {
        void rowActions.onAssignToFolder?.(action.sessionId, action.folderId)
        return
      }
      if (!overSection || !onReorderSessions) return
      void trackConversationReordered({
        sectionKey: overSection.key,
        before: overSection.ids,
        after: action.ids,
        via: e.activatorEvent instanceof KeyboardEvent ? "keyboard" : "pointer",
      })
      // Snapshot the *store's* order for this section (not the displayed one):
      // the projection overrides exactly that snapshot and steps aside the
      // moment the live query moves. Persist first so a synchronous throw
      // never leaves a projection with nothing behind it.
      const stored = sections.find((s) => conversationSectionKey(s) === overSection.key)
      const baseIds = stored ? stored.sessions.map((s) => s.id) : overSection.ids
      const pending: PendingReorder = { sectionKey: overSection.key, baseIds, ids: action.ids }
      const persisted = onReorderSessions(action.ids, overSection.key)
      setPendingReorder(pending)
      flashSettled(String(e.active.id))
      // A rejected write means the store will never catch up — let go rather
      // than keep showing an order that does not exist.
      Promise.resolve(persisted).catch((error: unknown) => {
        log.warn("channel-list reorder persist failed", { error: String(error) })
        setPendingReorder((current) => (current === pending ? null : current))
      })
    },
    [sectionIdsBySession, sections, rowActions, onReorderSessions, flashSettled]
  )

  // Toolbar visibility: show when ≥2 are selected OR when a single row was
  // selected via a modifier (so the user can still pin/unpin/delete just
  // that one row without round-tripping through the per-row menu). Plain
  // single click — the normal "open this conversation" gesture — never
  // pops the toolbar so it stays out of the way.
  const toolbarVisible = selected.size >= 2 || (selected.size === 1 && lastInteractionWasModified)
  // While the rail's search field is expanded (focused or holding text) it
  // owns its row; the filter and the list actions beside it hide until it
  // lets go (see `ChannelListSearch`).
  const [searchExpanded, setSearchExpanded] = useState(false)

  // Canvas guild has its own dedicated rail; do not render the chat
  // session list when the user is in canvas mode.
  if (selectedGuild.kind === "canvas") {
    return null
  }
  // A plugin view container owns the middle column — render its panel
  // (B1) instead of the chat session list.
  if (selectedGuild.kind === "plugin-view") {
    return <PluginViewContainerPanel containerId={selectedGuild.containerId} />
  }
  // The list's own actions (display options, archived toggle, new). Drawn in
  // the title row when that row is inline; when the title is projected into
  // the title bar they move down beside the search field instead — three
  // list-management buttons in the window chrome read as clutter.
  const headerActionProps: HeaderActionsProps = {
    selectedGuild: chatGuild,
    team: team ?? null,
    view,
    density,
    showPreview,
    showCustomIcons,
    showTimestamps,
    groupBy,
    sortBy,
    showUnreadBadges,
    searchOptions,
    metadataFields,
    titleMotion,
    onUpdateDisplay: saveSidebarSettings,
    onToggleView: () => setView(view === "active" ? "archived" : "active"),
    onNewFolder: view === "active" && onCreateFolder ? handleNewFolder : undefined,
    onNewDirect: handleNewDirect,
    onNewTeamConversation: handleNewTeamConversation,
  }
  // The guild accordion around the list: Direct Messages first, then every
  // team; the open section's rows sit above the search field and the closed
  // ones after it are pinned under the list (`sidebar-guild-sections.tsx`).
  const guildSections = splitGuildSections(teams ?? [], chatGuild)
  // A closed section's context menu can start a conversation there without
  // opening it first; `null` is the Direct Messages row.
  const handleGuildNewConversation = (teamId: string | null) => {
    if (teamId) handleNewTeamConversation(teamId)
    else handleNewDirect()
  }

  const rows = (
    // Permanent, like the chat surfaces' own boundaries (`chat:list`,
    // `chat:message`): the sidebar re-renders on every session write, every
    // unread tick and every filter change, so `react:sidebar:channel-list` in
    // the PerfHud is how a regression here is seen at all. It was added as a
    // one-off diagnostic; the question it asked (does the history list churn?)
    // is exactly the one that keeps coming back.
    <PerfBoundary id="sidebar:channel-list">
      <div
        ref={containerRef}
        // Flat `bg-background/70`, not a gradient. `bg-gradient-to-b
        // from-background/70 to-background/35` is a `background-image`, and the
        // tonality rules only swap `background-color` — so the gradient painted
        // over the wallpaper the chat pane beside it was showing (the same
        // defect as the composer bar, see globals.css §4d). One flat surface
        // also matches the chat header, which is on this same tier.
        className="flex h-full flex-col bg-background/70 outline-none"
        data-tonality="translucent"
        tabIndex={0}
        onKeyDown={handleContainerKeyDown}
        {...densitySurfaceProps("sidebar", appearanceDensity)}
      >
        <Header outlet={headerOutlet} {...headerActionProps} />
        {merged ? (
          // Outside the scrolling band below: the sidebar's primary action
          // does not scroll away behind eight pinned features and six teams.
          <SidebarNewConversationButton
            guild={chatGuild}
            onNewDirect={handleNewDirect}
            onNewTeamConversation={handleNewTeamConversation}
          />
        ) : null}
        {merged ? (
          // Everything above the search field shares one bounded, scrolling
          // band. The nav rows, the plugin view containers and the accordion
          // sections *before* the open one all grow with what the user has —
          // pin eight features and join six teams and an unbounded block
          // pushed the conversation list toward zero height. Half the rail at
          // most, the same shape as the `after` band below the list.
          <div
            className="flex max-h-[45%] shrink-0 flex-col overflow-x-hidden overflow-y-auto"
            data-testid="sidebar-nav-band"
          >
            <SidebarNavSection className="pt-1" />
            <SidebarGuildSectionRows
              rows={guildSections.before}
              openKey={guildSections.openKey}
              onNewConversation={handleGuildNewConversation}
              panelId={GUILD_PANEL_ID}
              className="pt-1"
              testId="sidebar-guild-rows-before"
            />
          </div>
        ) : null}
        <div
          // What the open accordion row discloses: this search row plus the
          // list under it (`aria-controls` on that row points here).
          id={merged ? GUILD_PANEL_ID : undefined}
          className={cn(
            "flex items-center gap-1.5",
            // Under a heading row (an open team) the field aligns with the
            // rows' boxes (8px in) and sits closer to it. With Chats open
            // there is no heading and the row above is the last navigation
            // entry, so it takes the full gap instead — that space is what
            // separates "where to go" from "which conversation". The Sheet
            // keeps its own roomier row.
            merged
              ? guildSections.before.length > 0
                ? "px-2 pt-1 pb-2"
                : "px-2 pt-2 pb-2"
              : "px-3 pt-2.5 pb-2.5"
          )}
        >
          <ChannelListSearch
            key={searchResetToken}
            inputRef={searchInputRef}
            onQueryChange={setQuery}
            onExpandedChange={setSearchExpanded}
          />
          {searchExpanded ? null : (
            <>
              {/* Beside the field it governs: how far a query looks is not a
                  display preference and does not belong in a settings page. */}
              <ConversationSearchScopeControl
                model={filterController}
                side="right"
                triggerClassName="size-9 rounded-lg"
                testId="channel-list-search-scope"
              />
              <ConversationFilterMenu
                model={filterController}
                side="right"
                triggerClassName="size-9 rounded-lg"
                testId="channel-list-filter-trigger"
              />
              {/* The list's own actions, beside the field they act on and in
                  the same place whichever section is open — they used to ride
                  the open accordion row, which moved them every time the user
                  picked a team and left them nowhere at all once the Chats
                  heading went away. The mobile Sheet keeps its inline header
                  row instead (`Header`). */}
              {merged ? <HeaderActions layout="compact" {...headerActionProps} /> : null}
            </>
          )}
        </div>
        {merged && view === "archived" ? (
          // Where you are, now that neither a heading row nor the archived
          // toggle is on screen: a chip that says it and takes you back.
          <div className="px-2 pb-2">
            <button
              type="button"
              onClick={() => setView("active")}
              aria-label={t("viewActive")}
              title={t("viewActive")}
              data-testid="channel-list-archived-chip"
              className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 pr-1.5 pl-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArchiveIcon className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{t("archivedTitleSuffix")}</span>
              <XIcon className="size-3 shrink-0" aria-hidden />
            </button>
          </div>
        ) : null}
        <ConversationFilterChips
          model={filterController}
          // What is on screen, so folding a group moves the number. The empty
          // state below still branches on `filteredCount` — collapsing
          // everything is not "your filters matched nothing".
          shown={visibleCount}
          total={total}
          className="px-3 pb-2"
          testId="channel-list-filter-chips"
        />
        <ChannelListBulkActions
          visible={toolbarVisible}
          selected={selected}
          orderedIds={orderedIds}
          sessions={filtered}
          archived={view === "archived"}
          onDelete={rowActions.onBulkDelete}
          onSetPinned={rowActions.onBulkSetPinned}
          onArchive={rowActions.onBulkArchive}
          onUnarchive={rowActions.onBulkUnarchive}
          folders={modelFolders}
          onMoveToFolder={rowActions.onBulkAssignToFolder}
          onClear={clear}
        />
        {contentBelowMinQuery ? (
          <p className="px-3 pb-1 text-[11px] text-muted-foreground" role="status">
            {t("searchContentMinQuery", { count: CONTENT_SEARCH_MIN_QUERY })}
          </p>
        ) : contentTruncated && query.trim() ? (
          <p className="px-3 pb-1 text-[11px] text-muted-foreground" role="status">
            {t("searchTruncated")}
          </p>
        ) : null}
        <Separator className="opacity-60" />
        <ScrollArea
          className="flex-1 [&_[data-slot=scroll-area-scrollbar]]:hidden [&_[data-slot=scroll-area-viewport]>div]:!block"
          onMouseEnter={() => setPointerInList(true)}
          onMouseLeave={() => setPointerInList(false)}
        >
          {loading && total === 0 ? (
            <SessionListLoading />
          ) : total === 0 ? (
            <ConversationListEmptyState
              archived={view === "archived"}
              team={chatGuild.kind === "team"}
              onCreate={
                view === "archived"
                  ? undefined
                  : chatGuild.kind === "team"
                    ? () => handleNewTeamConversation(chatGuild.teamId)
                    : handleNewDirect
              }
            />
          ) : filteredCount === 0 && contentPending ? (
            // Message hits land a beat after the title hits, so until the index
            // answers the result set is incomplete. Claiming "no results for X"
            // here and then filling the list a moment later is the worst of both
            // — it reads as a miss and then contradicts itself.
            <p
              className="px-4 py-6 text-center text-xs text-muted-foreground"
              role="status"
              data-testid="channel-list-search-pending"
            >
              {t("searchingMessages")}
            </p>
          ) : filteredCount === 0 ? (
            // Three different reasons a non-empty view can show nothing, and
            // they need different exits: refine the query, drop the filters, or
            // both. A single "no results" line leaves the user hunting for the
            // filter they forgot they set.
            <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
              <p className="text-xs text-muted-foreground">
                {query.trim()
                  ? t("emptySearch", { query: query.trim() })
                  : t("emptyFiltered", { count: activeFilters })}
              </p>
              {activeFilters > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={resetConversationFilters}
                  data-testid="channel-list-empty-clear-filters"
                >
                  {tFilters("clearAll")}
                </Button>
              ) : null}
            </div>
          ) : (
            <DndContext
              sensors={dndSensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <ConversationSections
                sections={displaySections}
                dropPreview={dropPreview}
                activeDragId={activeDragId}
                settled={
                  settledId ? { id: settledId, nonce: settledNonce, holdMs: settleHoldMs } : null
                }
                activeSessionId={activeSessionId}
                focusedId={focusedId}
                density={density}
                showPreview={showPreview}
                showTimestamps={showTimestamps}
                searchQuery={query.trim()}
                contentOnlyIds={contentOnlyIds}
                reorderable={reorderable}
                metadataFor={metadataFor}
                titleMotion={titleMotion}
                unreadById={unreadById}
                isSelected={isSelected}
                onToggleSelection={handleToggleSelection}
                accentFor={accentFor}
                iconFor={iconFor}
                folders={folders ?? EMPTY_FOLDERS}
                onSelect={handleSessionSelect}
                onDelete={rowActions.onDelete}
                onRename={rowActions.onRename}
                onTogglePinned={rowActions.onTogglePinned}
                onArchive={rowActions.onArchive}
                onUnarchive={rowActions.onUnarchive}
                onAssignToFolder={rowActions.onAssignToFolder}
                onToggleFolder={toggleFolderCollapsed}
                onToggleGroup={setGroupCollapsed}
                onRenameFolder={onRenameFolder}
                onDeleteFolder={onDeleteFolder}
                onMoveFolder={handleMoveFolder}
                renamingFolderId={renamingFolderId}
                onFolderRenameSettled={handleFolderRenameSettled}
                onJumpToParent={handleJumpToParent}
              />
            </DndContext>
          )}
        </ScrollArea>
        {merged ? (
          <>
            {/* The closed sections below the list stay in view; a long team
                list scrolls inside its own band rather than eating the list. */}
            <div className="flex max-h-[40%] shrink-0 flex-col overflow-y-auto border-t py-1">
              <SidebarGuildSectionRows
                rows={guildSections.after}
                openKey={guildSections.openKey}
                onNewConversation={handleGuildNewConversation}
                testId="sidebar-guild-rows-after"
              />
              <SidebarCreateTeamRow />
            </div>
            <SidebarFooter />
          </>
        ) : null}
      </div>
    </PerfBoundary>
  )
  // Merged mode stacks four row groups around the list (nav, the accordion
  // above and below it, the footer). One tab stop and arrow keys for all of
  // them — and the scope is what stops a row's ArrowDown from reaching the
  // list's own focus ring below (`sidebar-row-roving.tsx`). The scope takes
  // this component's root rather than adding a wrapper, which would break the
  // flex column the layout depends on.
  return merged ? <SidebarRowsScope containerRef={containerRef}>{rows}</SidebarRowsScope> : rows
}

function ChannelListSearch({
  inputRef,
  onQueryChange,
  onExpandedChange,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  onQueryChange: (query: string) => void
  /**
   * Fires as the field takes / gives back the row. It is "expanded" while
   * focused or holding text; the row's other controls hide meanwhile so the
   * field has the rail's full width to type in. Focus is what `/` gives it,
   * so the shortcut expands it too.
   */
  onExpandedChange?: (expanded: boolean) => void
}) {
  const t = useTranslations("desktop.channelList")
  const [value, setValue] = useState("")
  // The `/` hint only earns its slot while the shortcut still does something:
  // once the field is focused (or holds text) it is noise, so it yields to the
  // caret / the clear button.
  const [focused, setFocused] = useState(false)
  const expanded = focused || value.length > 0
  useEffect(() => {
    onExpandedChange?.(expanded)
  }, [expanded, onExpandedChange])
  // Global search: hand the words already typed to the command palette, which
  // searches every conversation's history, commands and files — the rail's
  // field only narrows this list.
  const openGlobalSearch = useCallback(() => {
    // Land on the *Chats* tab: the words came from a conversation search, so
    // that is the scope they were meant for (ADR-0129).
    requestCommandPalette({ query: value.trim() || undefined, scope: "chats" })
  }, [value])
  const { call: debouncedQueryChange, cancel: cancelQueryChange } = useDebouncedCallback(
    onQueryChange,
    150
  )

  const updateValue = useCallback(
    (next: string) => {
      setValue(next)
      debouncedQueryChange(next)
    },
    [debouncedQueryChange]
  )
  const clear = useCallback(() => {
    setValue("")
    cancelQueryChange()
    onQueryChange("")
  }, [cancelQueryChange, onQueryChange])

  return (
    <div
      className="min-w-0 flex-1"
      data-testid="channel-list-search"
      data-expanded={expanded || undefined}
    >
      <InputGroup
        className={cn(
          "h-9 rounded-lg border-border/40 bg-muted/40 shadow-none transition-colors",
          "hover:bg-muted/60",
          // Softer focus treatment than the form default — this sits in a rail,
          // not a form, so a 3px halo reads as an alarm rather than a caret.
          "has-[[data-slot=input-group-control]:focus-visible]:border-ring/50 has-[[data-slot=input-group-control]:focus-visible]:bg-background/60 has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/25"
        )}
      >
        <InputGroupAddon align="inline-start" className="pr-0 pl-2.5">
          <SearchIcon
            className={cn(
              "size-3.5 transition-colors",
              focused ? "text-foreground/80" : "text-muted-foreground/70"
            )}
            aria-hidden
          />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          type="search"
          value={value}
          onChange={(event) => updateValue(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // Text → clear it; empty → hand the row back to the actions.
              event.preventDefault()
              event.stopPropagation()
              if (value) clear()
              else event.currentTarget.blur()
            } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              // ⌘/Ctrl+Enter from the field: take this query global.
              event.preventDefault()
              openGlobalSearch()
            }
          }}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchAria")}
          aria-keyshortcuts="/"
          className="h-9 px-2 text-sm [&::-webkit-search-cancel-button]:hidden"
        />
        <InputGroupAddon align="inline-end" className="gap-0.5 pr-1.5 pl-0">
          {expanded ? (
            // The escape hatch out of "narrow this list": the same words, but
            // across every conversation. Sits at the field's end so it reads
            // as part of the search, and only while the field is in use.
            <InputGroupButton
              size="icon-xs"
              aria-label={t("globalSearch")}
              title={t("globalSearchHint")}
              // The press must not blur the field first: on an empty field
              // blur collapses the row and this button unmounts before its
              // click can fire — the pointer lands on nothing.
              onPointerDown={(event) => event.preventDefault()}
              onClick={openGlobalSearch}
              className="rounded-md"
              data-testid="channel-list-global-search"
            >
              <TextSearchIcon className="size-3.5" />
            </InputGroupButton>
          ) : null}
          {value ? (
            <InputGroupButton
              size="icon-xs"
              aria-label={t("clearSearch")}
              onClick={clear}
              className="rounded-md"
            >
              <XIcon className="size-3.5" />
            </InputGroupButton>
          ) : focused ? null : (
            // Decorative shortcut hint (the input carries `aria-keyshortcuts`),
            // drawn as a keycap outline so it doesn't read as a badge or a
            // literal slash inside the field.
            <span title={t("searchShortcutHint")} className="flex">
              <Kbd
                aria-hidden
                className="h-[18px] min-w-[18px] rounded-[5px] border border-border/60 bg-background/70 px-1 text-[10px] leading-none font-medium text-muted-foreground/80 shadow-[inset_0_-1px_0_0_color-mix(in_oklab,var(--border)_60%,transparent)]"
              >
                /
              </Kbd>
            </span>
          )}
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

function ConversationListEmptyState({
  archived,
  team,
  onCreate,
}: {
  archived: boolean
  team: boolean
  onCreate?: () => void
}) {
  const t = useTranslations("desktop.channelList")
  const title = archived ? t("conversationsTitle") : team ? t("newConversation") : t("newChat")
  const description = archived ? t("emptyArchived") : team ? t("emptyTeam") : t("emptyDm")
  const actionLabel = team ? t("newConversation") : t("newChat")
  const Icon = archived ? ArchiveIcon : team ? UsersIcon : MessagesSquareIcon

  return (
    <Empty className="min-h-48 gap-4 rounded-none border-0 px-5 py-10">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="rounded-xl bg-muted/70 text-muted-foreground">
          <Icon className="size-5" />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        <EmptyDescription className="text-xs">{description}</EmptyDescription>
      </EmptyHeader>
      {onCreate ? (
        <EmptyContent>
          <Button size="sm" onClick={onCreate}>
            <PlusIcon className="size-4" />
            {actionLabel}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}

/**
 * "New conversation" — the sidebar's first control, above the navigation,
 * where every conventional chat app puts it. It creates in whichever section
 * is selected (Chats, or the open team), so it is *one* fixed affordance
 * rather than a "+" that travels with the open accordion row — and the label
 * names the target, which is what the row it replaced used to say.
 *
 * Sized to `SidebarRow` (32px, the same gutter and type) so it lines up with
 * the nav rows beneath it, but bordered: this one acts rather than navigates.
 */
function SidebarNewConversationButton({
  guild,
  onNewDirect,
  onNewTeamConversation,
}: {
  guild: { kind: "dm" } | { kind: "team"; teamId: string }
  onNewDirect: () => void
  onNewTeamConversation: (teamId: string) => void
}) {
  const t = useTranslations("desktop.channelList")
  const label = guild.kind === "team" ? t("newConversation") : t("newChat")
  return (
    <div className="shrink-0 px-2 pt-2 pb-1">
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          if (guild.kind === "team") onNewTeamConversation(guild.teamId)
          else onNewDirect()
        }}
        title={label}
        data-testid="sidebar-new-conversation"
        className="h-8 w-full min-w-0 justify-start gap-2.5 rounded-md border-border/60 bg-background/50 px-2 text-[13px] font-normal shadow-none hover:bg-accent hover:text-accent-foreground"
      >
        <PlusIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{label}</span>
      </Button>
    </div>
  )
}

/**
 * The rail's title row: which guild the list is showing. Inline it also carries
 * `HeaderActions`; projected into the title bar (`title-bar-outlets.tsx`) it
 * carries the title alone — the bar is chrome, and three list-management
 * buttons up there read as clutter beside the window controls. The actions
 * then sit in the search row, next to the field they act on.
 */
function Header({
  outlet,
  selectedGuild,
  team,
  ...actions
}: { outlet: HTMLElement | null } & HeaderActionsProps) {
  const t = useTranslations("desktop.channelList")
  const isTeam = selectedGuild.kind === "team"
  const title = (
    <div className="flex min-w-0 items-center gap-2">
      {isTeam ? (
        <UsersIcon
          className="size-4 shrink-0"
          style={{
            color: team ? avatarColor(team) : undefined,
          }}
        />
      ) : (
        <MessagesSquareIcon className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate text-sm font-semibold tracking-tight">
        {isTeam ? (team?.name ?? t("teamFallback")) : t("directMessages")}
      </span>
      {/* Where you are when the archived toggle lives behind ⋯: the title says
          so, and the same menu item is the way back. */}
      {actions.view === "archived" ? (
        <span
          className="truncate text-sm text-muted-foreground"
          data-testid="channel-list-archived-suffix"
        >
          · {t("archivedTitleSuffix")}
        </span>
      ) : null}
    </div>
  )
  // Projected: the title bar's start outlet is already sized to this rail, so
  // the row only lays its content out. Inline: `h-10` + `border-b`, the same
  // 40px and bottom rule the chat and workbench headers draw when they are
  // not projected either, so the three columns still read as one bar.
  // Projected: the bar's start outlet is sized to this rail. What goes there
  // is the *sidebar's* identity — the workspace switcher (initial · name ·
  // chevron), the way a Slack/Claude sidebar is headed by its workspace — not
  // the guild title: with the guild accordion inside the sidebar the open
  // section's own row already says "Direct Messages" / the team's name.
  // Inline (the mobile Sheet): `h-10` + `border-b` guild title with the
  // list actions beside it, the same 40px the other column headers draw.
  return outlet ? (
    createPortal(
      <div
        data-testid="channel-list-header"
        className="flex h-full min-w-0 flex-1 items-center gap-2 px-2"
      >
        <WorkspaceSwitcher variant="wide" className="min-w-0" />
      </div>,
      outlet
    )
  ) : (
    <div
      data-testid="channel-list-header"
      className="flex h-[var(--chrome-h)] shrink-0 items-center justify-between gap-2 border-b px-3"
    >
      {title}
      <HeaderActions selectedGuild={selectedGuild} team={team} {...actions} />
    </div>
  )
}

interface HeaderActionsProps {
  className?: string
  /**
   * `row` — the inline title row (the mobile Sheet): display-options menu ·
   * archived toggle · new, three buttons. `compact` — the ⋯ button beside the
   * search field in the merged sidebar, with the archived toggle and the same
   * display options folded into it. "New" is not here in that mode: it heads
   * the sidebar (`SidebarNewConversationButton`), so a 296px rail keeps a
   * full-width search field and one button beside it.
   */
  layout?: "row" | "compact"
  selectedGuild: { kind: "dm" } | { kind: "team"; teamId: string }
  team: Team | null
  view: "active" | "archived"
  density: ConversationSidebarDensity
  showPreview: boolean
  showCustomIcons: boolean
  showTimestamps: boolean
  groupBy: ConversationGroupBy
  sortBy: ConversationSortBy
  showUnreadBadges: boolean
  searchOptions: ResolvedConversationSearchOptions
  metadataFields: ConversationSidebarMetadata[]
  titleMotion: ConversationSidebarTitleMotion
  onUpdateDisplay: (patch: Partial<ConversationSidebarSettings>) => void
  onToggleView: () => void
  onNewFolder?: () => void
  onNewDirect: () => void
  onNewTeamConversation: (teamId: string) => void
}

/** Display options · archived toggle · new — the list's own actions. */
function HeaderActions({
  className,
  layout = "row",
  selectedGuild,
  view,
  density,
  showPreview,
  showCustomIcons,
  showTimestamps,
  groupBy,
  sortBy,
  showUnreadBadges,
  searchOptions,
  metadataFields,
  titleMotion,
  onUpdateDisplay,
  onToggleView,
  onNewFolder,
  onNewDirect,
  onNewTeamConversation,
}: HeaderActionsProps) {
  const t = useTranslations("desktop.channelList")
  const isTeam = selectedGuild.kind === "team"
  const ctaLabel = isTeam ? t("newConversation") : t("newChat")
  const isArchived = view === "archived"
  const viewLabel = isArchived ? t("viewActive") : t("viewArchived")
  const compact = layout === "compact"
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          // Compact sits in the search row next to the filter trigger, so it
          // takes that row's 36px square; inline it is one of three 28px
          // buttons on a 40px title row.
          className={compact ? "size-9 rounded-lg" : "size-7"}
          aria-label={compact ? t("listActions") : t("displayOptions")}
          title={compact ? t("listActions") : t("displayOptions")}
          data-testid="channel-list-actions-menu"
        >
          {compact ? (
            <MoreHorizontalIcon className="size-4" />
          ) : (
            <SlidersHorizontalIcon className="size-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        // Compact: a flyout to the right, off the rail and over the chat, so a
        // long menu is not clipped by the rail's edge or laid over the list it
        // configures. Inline (the title row): a plain drop-down, as before.
        side={compact ? "right" : "bottom"}
        align={compact ? "start" : "end"}
        className="w-56"
      >
        {compact ? (
          <>
            <DropdownMenuItem onSelect={onToggleView} data-testid="channel-list-toggle-view">
              <ArchiveIcon className="size-4" />
              {viewLabel}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {onNewFolder ? (
          <>
            <DropdownMenuItem onSelect={onNewFolder}>
              <FolderPlusIcon className="size-4" />
              {t("newFolder")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel>{t("displayOptions")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={density === "compact"}
          onCheckedChange={(checked) =>
            onUpdateDisplay({ density: checked ? "compact" : "comfortable" })
          }
        >
          {t("compactDensity")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={showPreview}
          onCheckedChange={(checked) => onUpdateDisplay({ showPreview: Boolean(checked) })}
        >
          {t("showPreview")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={showCustomIcons}
          onCheckedChange={(checked) => onUpdateDisplay({ showCustomIcons: Boolean(checked) })}
        >
          {t("showCustomIcons")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={showTimestamps}
          onCheckedChange={(checked) => onUpdateDisplay({ showTimestamps: Boolean(checked) })}
        >
          {t("showTimestamps")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("metadata.label")}
        </DropdownMenuLabel>
        {CONVERSATION_SIDEBAR_METADATA_OPTIONS.map((field) => (
          <DropdownMenuCheckboxItem
            key={field}
            checked={metadataFields.includes(field)}
            onCheckedChange={(checked) =>
              onUpdateDisplay({
                metadata: toggleConversationSidebarMetadata(
                  metadataFields,
                  field,
                  Boolean(checked)
                ),
              })
            }
          >
            {t(`metadata.${field}`)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuCheckboxItem
          checked={titleMotion === "hover"}
          onCheckedChange={(checked) => onUpdateDisplay({ titleMotion: checked ? "hover" : "off" })}
        >
          {t("titleMotion")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("groupBy.label")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={groupBy}
          onValueChange={(value) => onUpdateDisplay({ groupBy: value as ConversationGroupBy })}
        >
          {CONVERSATION_GROUP_BY_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {t(`groupBy.options.${option}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {/* Sort sits beside grouping, the setting it pairs with — the filter
            menu carries the same radio group, because that is where a narrowed
            list is being shaped. Both write `conversationSidebar.sortBy`. */}
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("sortBy.label")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sortBy}
          onValueChange={(value) => onUpdateDisplay({ sortBy: value as ConversationSortBy })}
        >
          {CONVERSATION_SORT_BY_OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              key={option}
              value={option}
              data-testid={`channel-list-sort-${option}`}
            >
              {t(`sortBy.options.${option}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={showUnreadBadges}
          onCheckedChange={(checked) => onUpdateDisplay({ showUnreadBadges: Boolean(checked) })}
        >
          {t("showUnreadBadges")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={searchOptions.content}
          onCheckedChange={(checked) =>
            onUpdateDisplay({ search: { ...searchOptions, content: Boolean(checked) } })
          }
        >
          {t("searchMessageContent")}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  const newButton = (
    <Button
      size="icon"
      variant="ghost"
      className="size-7"
      onClick={() => {
        if (selectedGuild.kind === "team") {
          onNewTeamConversation(selectedGuild.teamId)
        } else {
          onNewDirect()
        }
      }}
      aria-label={ctaLabel}
      title={ctaLabel}
    >
      <PlusIcon className="size-4" />
    </Button>
  )
  return (
    <div className={cn("flex shrink-0 items-center gap-0.5", className)}>
      {compact ? (
        menu
      ) : (
        <>
          {menu}
          <Button
            size="icon"
            variant="ghost"
            className={cn("size-7", isArchived && "text-primary")}
            onClick={onToggleView}
            aria-label={viewLabel}
            aria-pressed={isArchived}
            title={viewLabel}
          >
            <ArchiveIcon className="size-4" />
          </Button>
          {newButton}
        </>
      )}
    </div>
  )
}

function ConversationSections({
  sections,
  dropPreview,
  activeDragId,
  settled,
  activeSessionId,
  focusedId,
  density,
  showPreview,
  showTimestamps,
  searchQuery,
  contentOnlyIds,
  reorderable,
  metadataFor,
  titleMotion,
  unreadById,
  isSelected,
  onToggleSelection,
  accentFor,
  iconFor,
  folders,
  onSelect,
  onDelete,
  onRename,
  onTogglePinned,
  onArchive,
  onUnarchive,
  onAssignToFolder,
  onToggleFolder,
  onToggleGroup,
  onRenameFolder,
  onDeleteFolder,
  onMoveFolder,
  renamingFolderId,
  onFolderRenameSettled,
  onJumpToParent,
}: {
  sections: readonly import("@/lib/chat/conversation-list-model").ConversationSection[]
  dropPreview: ConversationDropPreview | null
  /** Row currently being dragged — rendered again as the pointer-following overlay. */
  activeDragId: string | null
  /** Row that was just dropped into a new slot; carries the landing mark for `holdMs`. */
  settled: { id: string; nonce: number; holdMs: number } | null
  activeSessionId: string | null
  focusedId: string | null
  density: ConversationSidebarDensity
  showPreview: boolean
  showTimestamps: boolean
  /** Trimmed active query — emphasized inside matching titles. */
  searchQuery: string
  /** Hits that matched message content only; they get an explanatory marker. */
  contentOnlyIds: ReadonlySet<string>
  /** False under a non-recency sort: no grip handles, no sortable contexts. */
  reorderable: boolean
  metadataFor: (session: ChatSession) => SessionRowMetadataItem[]
  titleMotion: ConversationSidebarTitleMotion
  unreadById: Map<string, number>
  isSelected: (id: string) => boolean
  onToggleSelection: (id: string) => void
  accentFor: (session: ChatSession) => string | undefined
  iconFor: (session: ChatSession) => AvatarSubject | undefined
  folders: SessionFolder[]
  onSelect: (id: string, e: ReactMouseEvent) => void
  onDelete: (id: string) => void | Promise<void>
  onRename: (id: string, title: string) => void | Promise<void>
  onTogglePinned?: (id: string, pinned: boolean) => void | Promise<void>
  onArchive?: (id: string) => void | Promise<void>
  onUnarchive?: (id: string) => void | Promise<void>
  onAssignToFolder?: (sessionId: string, folderId: string | null) => void | Promise<void>
  onToggleFolder: (id: string) => void
  onToggleGroup: (key: string, collapsed: boolean) => void
  onRenameFolder?: (id: string, name: string) => void | Promise<void>
  onDeleteFolder?: (id: string) => void | Promise<void>
  /** Move a folder one place up or down the manual order; absent = not offered. */
  onMoveFolder?: (id: string, delta: -1 | 1) => void
  /** Folder whose name opens for editing on mount — the one just created. */
  renamingFolderId?: string | null
  /** Fired once that folder's inline editor has been committed or dismissed. */
  onFolderRenameSettled?: (id: string) => void
  onJumpToParent?: (parentSessionId: string) => void
}) {
  const t = useTranslations("desktop.channelList")

  const rowProps = (s: ChatSession): ComponentProps<typeof SessionRow> => ({
    session: s,
    active: s.id === activeSessionId,
    selected: isSelected(s.id),
    focused: s.id === focusedId,
    density,
    showPreview,
    showTimestamp: showTimestamps,
    searchQuery: searchQuery || undefined,
    contentMatch: contentOnlyIds.has(s.id),
    metadata: metadataFor(s),
    titleMotion,
    accentColor: accentFor(s),
    iconSubject: iconFor(s),
    unread: unreadById.get(s.id),
    settleFlash:
      settled?.id === s.id ? { nonce: settled.nonce, holdMs: settled.holdMs } : undefined,
    folders,
    onSelect,
    onToggleSelection,
    onDelete,
    onRename,
    onTogglePinned,
    onArchive,
    onUnarchive,
    onAssignToFolder,
    onJumpToParent,
  })
  const renderSortableRow = (s: ChatSession) =>
    reorderable ? (
      <SortableSessionRow
        key={s.id}
        {...rowProps(s)}
        dropPosition={dropPreview?.targetId === s.id ? dropPreview.position : undefined}
      />
    ) : (
      <SessionRow key={s.id} {...rowProps(s)} />
    )
  const renderStaticRow = (s: ChatSession) => <SessionRow key={s.id} {...rowProps(s)} />
  /**
   * A row the virtualizer places itself. Never a `SortableSessionRow`: dragging
   * needs every item of its sortable context in the DOM, which is precisely
   * what windowing takes away — hence the `!sortable` guard at the call site.
   */
  const renderPositionedRow = (
    s: ChatSession,
    positioning: { nodeRef: (el: HTMLElement | null) => void; nodeStyle: CSSProperties }
  ) => <SessionRow key={s.id} {...rowProps(s)} {...positioning} />

  // The pointer-following clone. The source row stays in the list as a
  // dimmed placeholder (see `SortableSessionRow`) and shifts into the target
  // slot with its neighbours, so on drop the overlay only has to glide onto
  // it — a row visibly *travels* to where it now lives, which is the whole
  // difference between "moved" and "nothing happened" for two similar rows.
  const activeDragSession = activeDragId
    ? (sections.flatMap((section) => section.sessions).find((s) => s.id === activeDragId) ?? null)
    : null
  // Folder sections in render order — the move up / down items grey out at the
  // two ends rather than silently doing nothing.
  const folderIds = sections.flatMap((section) =>
    section.kind === "folder" ? [section.folder.id] : []
  )

  return (
    <div className="flex flex-col gap-2 p-2">
      {sections.map((section) => {
        if (section.kind === "folder") {
          const { folder, collapsed } = section
          return (
            <FolderSection
              key={`folder:${folder.id}`}
              folder={folder}
              collapsed={collapsed}
              sessions={section.sessions}
              onToggle={() => onToggleFolder(folder.id)}
              onRename={onRenameFolder}
              onDelete={onDeleteFolder}
              onMove={onMoveFolder}
              first={folderIds[0] === folder.id}
              last={folderIds[folderIds.length - 1] === folder.id}
              autoRename={renamingFolderId === folder.id}
              onRenameSettled={onFolderRenameSettled}
              renderRow={renderSortableRow}
            />
          )
        }

        if (section.kind === "group") {
          const key = conversationSectionKey(section)
          return (
            <GroupSection
              key={key}
              sectionKey={key}
              axis={section.axis}
              name={
                section.group.id === UNGROUPED_ID
                  ? t(CONVERSATION_UNGROUPED_LABEL_KEY[section.axis])
                  : section.group.name
              }
              collapsed={section.collapsed}
              sessions={section.sessions}
              onToggle={() => onToggleGroup(key, !section.collapsed)}
              renderRow={renderSortableRow}
            />
          )
        }

        const label =
          section.kind === "pinned"
            ? t("sectionPinned")
            : section.kind === "recent"
              ? t("sectionRecent")
              : section.kind === "date"
                ? t(BUCKET_LABEL_KEY[section.bucket])
                : null
        const key = section.kind === "date" ? `date:${section.bucket}` : section.kind
        const sortable = section.kind !== "search" && reorderable
        // Virtualize only a long, flat, un-draggable list. That is exactly
        // where the rows pile up — a search across every workspace, or a
        // title / unread sort, both of which the model already renders as one
        // section — and it is the one place where windowing costs nothing:
        // no sticky group header to keep pinned, and no dnd-kit sortable
        // context whose items would vanish from the DOM mid-drag.
        const virtualize =
          !sortable &&
          (section.kind === "search" || section.kind === "recent") &&
          section.sessions.length > VIRTUAL_ROW_THRESHOLD
        const renderRow = section.kind === "search" ? renderStaticRow : renderSortableRow
        const rows = virtualize ? (
          <VirtualRows sessions={section.sessions} renderRow={renderPositionedRow} />
        ) : (
          <ul className="flex flex-col gap-0.5">
            {section.sessions.map((session) => renderRow(session))}
          </ul>
        )
        return (
          <section key={key} aria-label={label ?? t("searchAria")}>
            {label ? (
              <SectionHeading label={label} count={section.sessions.length} />
            ) : section.kind === "search" ? (
              <SectionHeading label={t("sectionResults")} count={section.sessions.length} />
            ) : null}
            {sortable ? (
              <SortableContext
                id={key}
                items={section.sessions.map((session) => session.id)}
                strategy={verticalListSortingStrategy}
              >
                {rows}
              </SortableContext>
            ) : (
              rows
            )}
          </section>
        )
      })}
      <ConversationDragOverlay
        session={activeDragSession}
        rowProps={activeDragSession ? rowProps(activeDragSession) : null}
      />
    </div>
  )
}

/**
 * Pointer-following clone of the dragged conversation row, portaled to the
 * body so the sidebar's own overflow / width animation never clips it.
 *
 * `dropAnimation` is what makes a reorder legible: on release the clone glides
 * from wherever the pointer let go onto the source row — which, thanks to the
 * synchronous projection in `ChannelListBody`, is already sitting in the slot
 * the row will keep. Under reduced motion the clone simply disappears and the
 * landing mark alone says where the row went.
 */
function ConversationDragOverlay({
  session,
  rowProps,
}: {
  session: ChatSession | null
  rowProps: ComponentProps<typeof SessionRow> | null
}) {
  const { reduce } = useFlowMotion()
  // The desktop shell is client-only (`dynamic({ ssr: false })`), so there is
  // no server pass to disagree with; guard anyway so a bare render never throws.
  if (typeof document === "undefined") return null
  return createPortal(
    <DragOverlay dropAnimation={reduce ? null : CONVERSATION_DROP_ANIMATION} zIndex={60}>
      {session && rowProps ? (
        <ul
          data-testid="conversation-drag-overlay"
          className="cursor-grabbing rounded-lg bg-background/95 shadow-lg ring-1 ring-border/60 supports-[backdrop-filter]:bg-background/80 supports-[backdrop-filter]:backdrop-blur-sm"
        >
          <SessionRow
            {...rowProps}
            // The clone is a picture of the row, not a second instance of it:
            // no landing mark, no drop edge, no drag handle to grab.
            settleFlash={undefined}
            dropPosition={undefined}
            focused={false}
          />
        </ul>
      ) : null}
    </DragOverlay>,
    document.body
  )
}

/**
 * Section label. Sticky against the ScrollArea viewport so the bucket a row
 * belongs to stays on screen while scrolling a long history — without it, a
 * date-grouped list loses its only orientation cue after the first screenful.
 */
function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div
      className={cn(
        "flex h-7 items-center gap-1.5 px-2.5 pb-0.5 text-muted-foreground",
        STICKY_SECTION_HEADER
      )}
    >
      <span className={SECTION_LABEL_CLASS}>{label}</span>
      {count > 0 ? <span className={SECTION_COUNT_CLASS}>{count}</span> : null}
    </div>
  )
}

/**
 * A conversation row wired for @dnd-kit sorting: draggable (grip handle) and a
 * drop target so pinned rows can be reordered. Dropping onto a folder header is
 * handled by that header's own droppable — see {@link FolderSection}.
 */
function SortableSessionRow(props: ComponentProps<typeof SessionRow>) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props.session.id,
    // `projectId` rides along so a drop onto a folder header can reject a
    // cross-workspace assignment (`resolveConversationDrop`).
    data: {
      type: "session",
      folderId: props.session.folderId ?? null,
      projectId: props.session.projectId ?? null,
    },
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  return (
    <SessionRow
      {...props}
      nodeRef={setNodeRef}
      dragListeners={listeners as unknown as Record<string, unknown>}
      dragAttributes={attributes as unknown as Record<string, unknown>}
      dragActivatorRef={setActivatorNodeRef}
      nodeStyle={style}
      dragging={isDragging}
    />
  )
}

/**
 * A workspace / agent / team group. Deliberately not a drop target: dragging a
 * conversation into another workspace would have to re-scope every row it owns
 * (artifacts, terminals, memories), which is a move operation, not a reorder.
 */
function GroupSection({
  sectionKey,
  axis,
  name,
  collapsed,
  sessions,
  onToggle,
  renderRow,
}: {
  sectionKey: string
  axis: ConversationGroupAxis
  name: string
  collapsed: boolean
  sessions: ChatSession[]
  onToggle: () => void
  renderRow: (s: ChatSession) => ReactNode
}) {
  const Icon = CONVERSATION_GROUP_AXIS_ICON[axis]
  return (
    <Collapsible asChild open={!collapsed} onOpenChange={onToggle}>
      <section
        aria-label={name}
        className="rounded-md transition-colors duration-200 data-[state=open]:bg-muted/10"
      >
        <div className={cn("flex h-7 items-center px-1 pb-0.5", STICKY_SECTION_HEADER)}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={SECTION_TRIGGER_CLASS}
              aria-label={name}
            >
              <SectionChevron collapsed={collapsed} />
              <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />
              <span className={SECTION_LABEL_CLASS}>{name}</span>
              {sessions.length > 0 ? (
                <span className={SECTION_COUNT_CLASS}>{sessions.length}</span>
              ) : null}
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="overflow-hidden pt-0.5 data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
          <SortableContext
            id={sectionKey}
            items={sessions.map((session) => session.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex flex-col gap-0.5">{sessions.map(renderRow)}</ul>
          </SortableContext>
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

/**
 * Folder group whose header is a drop target: dragging a conversation onto it
 * assigns the session to the folder (@dnd-kit `useDroppable`).
 */
function FolderSection({
  folder,
  collapsed,
  sessions,
  onToggle,
  onRename,
  onDelete,
  onMove,
  first,
  last,
  autoRename,
  onRenameSettled,
  renderRow,
}: {
  folder: SessionFolder
  collapsed: boolean
  sessions: ChatSession[]
  onToggle: () => void
  onRename?: (id: string, name: string) => void | Promise<void>
  onDelete?: (id: string) => void | Promise<void>
  /** Move this folder one place up / down the manual order. */
  onMove?: (id: string, delta: -1 | 1) => void
  first?: boolean
  last?: boolean
  /** Open the name for editing right away (a folder just created here). */
  autoRename?: boolean
  onRenameSettled?: (id: string) => void
  renderRow: (s: ChatSession) => ReactNode
}) {
  const t = useTranslations("desktop.channelList")
  const { setNodeRef, isOver } = useDroppable({
    id: `folder:${folder.id}`,
    data: { type: "folder", folderId: folder.id, projectId: folder.projectId ?? null },
  })
  return (
    <Collapsible asChild open={!collapsed} onOpenChange={onToggle}>
      <section
        aria-label={folder.name}
        className="rounded-md transition-colors duration-200 data-[state=open]:bg-muted/10"
      >
        <div
          ref={setNodeRef}
          className={cn("rounded-md", isOver && "bg-primary/10 ring-1 ring-primary/40")}
        >
          <FolderSectionHeader
            folder={folder}
            collapsed={collapsed}
            count={sessions.length}
            onRename={onRename}
            onDelete={onDelete}
            onMove={onMove}
            first={first}
            last={last}
            autoRename={autoRename}
            onRenameSettled={onRenameSettled}
          />
        </div>
        <CollapsibleContent className="overflow-hidden pt-0.5 data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
          <SortableContext
            id={`folder:${folder.id}`}
            items={sessions.map((session) => session.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex flex-col gap-0.5">
              {sessions.length === 0 ? (
                <li className="px-3 py-1 text-[11px] text-muted-foreground">{t("emptyFolder")}</li>
              ) : (
                sessions.map(renderRow)
              )}
            </ul>
          </SortableContext>
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

function FolderSectionHeader({
  folder,
  collapsed,
  count,
  onRename,
  onDelete,
  onMove,
  first = false,
  last = false,
  autoRename = false,
  onRenameSettled,
}: {
  folder: SessionFolder
  collapsed: boolean
  count: number
  onRename?: (id: string, name: string) => void | Promise<void>
  onDelete?: (id: string) => void | Promise<void>
  onMove?: (id: string, delta: -1 | 1) => void
  first?: boolean
  last?: boolean
  autoRename?: boolean
  onRenameSettled?: (id: string) => void
}) {
  const t = useTranslations("desktop.channelList")
  // A just-created folder mounts straight into its editor, with the
  // placeholder name selected so typing replaces it.
  const [editing, setEditing] = useState(autoRename)
  const [draft, setDraft] = useState(folder.name)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const settle = () => {
    setEditing(false)
    if (autoRename) onRenameSettled?.(folder.id)
  }
  const commit = () => {
    const next = draft.trim()
    if (next && next !== folder.name) void onRename?.(folder.id, next)
    settle()
  }

  return (
    <div
      className={cn(
        "group/folder flex h-7 items-center gap-0.5 px-1 pb-0.5",
        STICKY_SECTION_HEADER
      )}
    >
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 text-muted-foreground">
          <SectionChevron collapsed={collapsed} />
          <FolderIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
          <Input
            autoFocus
            // Select the placeholder so the first keystroke replaces it.
            onFocus={(event) => event.currentTarget.select()}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                commit()
              } else if (e.key === "Escape") {
                e.preventDefault()
                setDraft(folder.name)
                settle()
              }
            }}
            onBlur={commit}
            className="h-5 px-1 py-0 text-[11px]"
            aria-label={t("renameFolder")}
          />
        </div>
      ) : (
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={SECTION_TRIGGER_CLASS}
            aria-label={folder.name}
          >
            <SectionChevron collapsed={collapsed} />
            <FolderIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
            <span className={SECTION_LABEL_CLASS}>{folder.name}</span>
            {count > 0 ? <span className={SECTION_COUNT_CLASS}>{count}</span> : null}
          </Button>
        </CollapsibleTrigger>
      )}
      {(onRename || onDelete || onMove) && !editing ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/folder:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              aria-label={t("folderActions")}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onMove ? (
              <>
                <DropdownMenuItem
                  disabled={first}
                  onSelect={() => onMove(folder.id, -1)}
                  data-testid={`folder-move-up-${folder.id}`}
                >
                  <ArrowUpIcon className="mr-2 size-4" />
                  {t("moveFolderUp")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={last}
                  onSelect={() => onMove(folder.id, 1)}
                  data-testid={`folder-move-down-${folder.id}`}
                >
                  <ArrowDownIcon className="mr-2 size-4" />
                  {t("moveFolderDown")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            {onRename ? (
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <PencilIcon className="mr-2 size-4" />
                {t("renameFolder")}
              </DropdownMenuItem>
            ) : null}
            {onDelete ? (
              <DropdownMenuItem
                onSelect={() => setConfirmOpen(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2Icon className="mr-2 size-4" />
                {t("deleteFolder")}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="max-w-[90vw] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("deleteFolderConfirmTitle", { name: folder.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("deleteFolderConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="w-full sm:w-auto">{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive", className: "w-full sm:w-auto" })}
              onClick={() => {
                setConfirmOpen(false)
                void onDelete?.(folder.id)
              }}
            >
              {t("deleteFolder")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
