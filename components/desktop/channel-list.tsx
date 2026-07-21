"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import { SessionListLoading } from "@/components/ui/loading-states"
import { PluginViewContainerPanel } from "@/components/shell/plugin-view-container-panel"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { useIsNarrow, useRangeSelection, useEdgeResize } from "@/hooks/ui"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { useConversationListModel } from "@/hooks/chat/use-conversation-list-model"
import { useClientLiveQuery } from "@/hooks/data"
import { listCharacters } from "@/lib/db/characters"
import { listSessionStates } from "@/lib/db/session-state"
import { searchSessionsByContent } from "@/lib/db/messages"
import { getTeam } from "@/lib/db/teams"
import { loggers } from "@cognia/logging"
import { avatarColor } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import {
  useUIStore,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  type ChannelListView,
} from "@/stores/ui"
import { useSettingsStore } from "@/stores/settings"
import { PerfBoundary } from "@/lib/perf"
import { resolveConversationDrop } from "@/lib/chat/conversation-dnd"
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core"
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type {
  ConversationSidebarSettings,
  ConversationSidebarDensity,
  ConversationSearchScope,
} from "@cognia/agent-config-types"
import { conversationSectionKey } from "@/lib/chat/conversation-list-model"
import type { DateBucket } from "@/lib/chat/conversation-list-model"
import type { Character, ChatSession, SessionFolder, Team } from "@cognia/agent-config-types"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import {
  ArchiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  MailIcon,
  MenuIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
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
import { ChannelListBulkToolbar } from "./channel-list-bulk-toolbar"
import { SessionRow } from "./session-row"

const log = loggers.ui

/**
 * Stable empty-folders identity. Passing an inline `folders ?? []` would mint a
 * fresh array every render and, since it's forwarded to every memoized
 * <SessionRow>, bust their memo on any sidebar re-render (cf. the `onSelect`
 * note below). Hoisting the fallback keeps the reference constant.
 */
const EMPTY_FOLDERS: SessionFolder[] = []

/** Maps a date bucket to its `desktop.channelList` label key. */
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
  onCreateFolder?: (name: string) => void | Promise<unknown>
  onRenameFolder?: (id: string, name: string) => void | Promise<void>
  onDeleteFolder?: (id: string) => void | Promise<void>
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
  // shared with the chat-header toggle, the title/status bars, the View menu,
  // and ⌘B, so every surface stays in lockstep. The rail stays mounted and
  // animates its width to 0 — collapsing is smooth and reclaims the WHOLE
  // column (no leftover strip); the toggle control lives in the active
  // conversation's header, not here.
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  // Enable the width transition ONLY for the brief collapse/expand animation —
  // never while the user drag-resizes (resize mutates the same `width`, and a
  // live transition would make the drag rubber-band). A short timer clears it.
  const [animatingCollapse, setAnimatingCollapse] = useState(false)
  const prevCollapsedRef = useRef(sidebarCollapsed)
  useEffect(() => {
    if (prevCollapsedRef.current === sidebarCollapsed) return
    prevCollapsedRef.current = sidebarCollapsed
    setAnimatingCollapse(true)
    const timer = setTimeout(() => setAnimatingCollapse(false), 220)
    return () => clearTimeout(timer)
  }, [sidebarCollapsed])

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
        <SheetContent side="left" className="w-72 p-0">
          <SheetHeader className="px-3 pt-3 pb-1">
            <SheetTitle className="text-sm">{t("conversationsTitle")}</SheetTitle>
          </SheetHeader>
          <ChannelListBody {...props} onSelect={handleSelect} />
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <aside
      className={cn(
        "relative hidden h-full shrink-0 flex-col bg-background md:flex",
        sidebarCollapsed ? "border-r-0" : "border-r",
        // Clip during collapse (and while animating) so the fixed-width inner
        // layer is hidden rather than spilling; leave it un-clipped when idle
        // so the resize handle can protrude past the right edge.
        (sidebarCollapsed || animatingCollapse) && "overflow-hidden",
        // Same 200ms and the same motion-speed multiplier the artifact dock
        // uses, so both rails collapse at one pace.
        animatingCollapse &&
          "transition-[width] duration-[calc(200ms*var(--motion-duration-scale,1))] ease-in-out"
      )}
      style={{ width: sidebarCollapsed ? 0 : width }}
      aria-label={t("conversationsTitle")}
      aria-hidden={sidebarCollapsed || undefined}
      inert={sidebarCollapsed || undefined}
      data-bg-target="chat"
      data-collapsed={sidebarCollapsed || undefined}
    >
      {/* Fixed-width inner layer: keeps the list from reflowing as the aside's
          width animates to 0 — the content is clipped, not squished. */}
      <div className="flex h-full min-h-0 flex-col" style={{ width }}>
        <ChannelListBody {...props} onSelect={handleSelect} />
      </div>
      {!sidebarCollapsed && (
        <SidebarResizeHandle width={width} onChange={setSidebarWidth} onReset={resetWidth} />
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
}: {
  width: number
  onChange: (width: number) => void
  onReset: () => void
}) {
  const t = useTranslations("desktop.channelList")
  const { dragging, onPointerDown, onPointerMove, onPointerUp, onKeyDown, onDoubleClick } =
    useEdgeResize({
      width,
      min: SIDEBAR_WIDTH_MIN,
      max: SIDEBAR_WIDTH_MAX,
      onChange,
      onReset,
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
        "absolute inset-y-0 right-0 z-10 w-1.5 translate-x-1/2 cursor-col-resize",
        "hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none",
        dragging && "bg-primary/40"
      )}
    />
  )
}

function ChannelListBody({
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
  onAssignToFolder,
  onReorderSessions,
}: Props) {
  const t = useTranslations("desktop.channelList")
  const selectedGuild = useUIStore((s) => s.selectedGuild)

  // Behavior preferences (Settings → Conversation). Absent settings fall back
  // to today's defaults so the sidebar renders identically before load.
  const sidebarSettings = useSettingsStore((s) => s.settings?.conversationSidebar)
  const saveSettings = useSettingsStore((s) => s.save)
  const density: ConversationSidebarDensity = sidebarSettings?.density ?? "comfortable"
  const showPreview = sidebarSettings?.showPreview ?? false
  const groupByDate = sidebarSettings?.groupByDate ?? true
  const showUnreadBadges = sidebarSettings?.showUnreadBadges ?? true
  const searchScope: ConversationSearchScope = sidebarSettings?.searchScope ?? "title"
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
  const unreadById = useMemo(() => {
    const map = new Map<string, number>()
    if (!showUnreadBadges) return map
    for (const s of sessionStates ?? []) {
      if (s.unreadCount > 0) map.set(s.sessionId, s.unreadCount)
    }
    return map
  }, [sessionStates, showUnreadBadges])

  const team = useClientLiveQuery<Team | undefined>(
    () => (chatGuild.kind === "team" ? getTeam(chatGuild.teamId) : Promise.resolve(undefined)),
    [chatGuild],
    undefined
  )

  // Filter the session list by selected guild. (Phase D) Sessions with
  // `kind === "workflow-editor"` are scoped to the workflow editor's chat
  // tab and never surface in the main channel list — they appear ONLY
  // inside the editor itself. `kind === "subagent"` sessions (ADR-0062) are
  // hidden imported-subagent inner transcripts, reachable only by drilling in
  // from a parent turn's SubagentPart — never in the list, search, or a bucket.
  const filtered = useMemo(() => {
    const visible = filterExposedSessions(sessions, "main-list")
    if (chatGuild.kind === "team") {
      return visible.filter((s) => s.kind === "team" && s.teamId === chatGuild.teamId)
    }
    // DM bucket: anything that isn't a team session.
    return visible.filter((s) => s.kind !== "team")
  }, [sessions, chatGuild])

  // Search box: keep the field value immediate but debounce the value fed
  // to the grouping model so typing doesn't re-bucket on every keystroke.
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchInput, setSearchInput] = useState("")
  const [query, setQuery] = useState("")
  // Destructure the stable `call`/`cancel` identities — the handle object
  // itself is a fresh literal each render, so depending on it would re-run the
  // guild-change effect (and wipe the multi-selection) on every render.
  const { call: debouncedSetQuery, cancel: cancelDebouncedQuery } = useDebouncedCallback(
    (next: string) => setQuery(next),
    150
  )
  const handleSearchChange = useCallback(
    (next: string) => {
      setSearchInput(next)
      debouncedSetQuery(next)
    },
    [debouncedSetQuery]
  )
  const clearSearch = useCallback(() => {
    setSearchInput("")
    cancelDebouncedQuery()
    setQuery("")
  }, [cancelDebouncedQuery])

  // Active ⇄ Archived view — seeded from and written back to the persisted UI
  // store so the choice survives reloads. Local state keeps re-render cheap.
  const persistedView = useUIStore((s) => s.channelListView)
  const setPersistedView = useUIStore((s) => s.setChannelListView)
  const [view, setViewState] = useState<ChannelListView>(persistedView)
  const setView = useCallback(
    (next: ChannelListView) => {
      setViewState(next)
      setPersistedView(next)
    },
    [setPersistedView]
  )

  // Folder collapse — seeded from the persisted store, mirrored back on change.
  const persistedCollapsed = useUIStore((s) => s.collapsedFolderIds)
  const setPersistedCollapsed = useUIStore((s) => s.setCollapsedFolders)
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<ReadonlySet<string>>(
    () => new Set(persistedCollapsed)
  )
  const toggleFolderCollapsed = useCallback((id: string) => {
    setCollapsedFolderIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  useEffect(() => {
    setPersistedCollapsed([...collapsedFolderIds])
  }, [collapsedFolderIds, setPersistedCollapsed])

  // Opt-in message-content search: when enabled, resolve the set of session ids
  // whose message text matches the (debounced) query. Bounded scan; a truncated
  // result surfaces a "may be incomplete" note rather than silently dropping
  // matches. Scoped to the current workspace via any visible session's project.
  const scopeProjectId = filtered.find((s) => s.projectId)?.projectId
  const [contentMatchIds, setContentMatchIds] = useState<ReadonlySet<string> | undefined>(undefined)
  const [contentTruncated, setContentTruncated] = useState(false)
  useEffect(() => {
    if (searchScope !== "titleAndContent" || query.trim().length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setContentMatchIds(undefined)
      setContentTruncated(false)
      return
    }
    let cancelled = false
    void searchSessionsByContent(query, { projectId: scopeProjectId })
      .then((res) => {
        if (cancelled) return
        setContentMatchIds(res.ids)
        setContentTruncated(res.truncated)
        if (res.truncated) log.warn("channel-list content-search truncated", { query })
      })
      .catch((err) => {
        if (!cancelled) log.warn("channel-list content-search failed", { error: String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [searchScope, query, scopeProjectId])

  // Folders only group the active view (archived chats stay in date buckets).
  const modelFolders = view === "archived" ? undefined : folders

  // Grouping/filtering/search now live in the shared headless model
  // (pinned → folders → date buckets, or a flat result list while searching).
  const { sections, total, filteredCount, orderedIds } = useConversationListModel({
    sessions: filtered,
    folders: modelFolders,
    query,
    view,
    collapsedFolderIds,
    groupByDate,
    contentMatchIds: searchScope === "titleAndContent" ? contentMatchIds : undefined,
  })

  // Per-row accent: team sessions inherit the team color, DM sessions inherit
  // their character color. Replaces the old per-character group accent.
  const accentFor = useCallback(
    (s: ChatSession): string | undefined => {
      if (s.kind === "team") return team ? avatarColor(team) : undefined
      const character = s.characterId ? characterById.get(s.characterId) : null
      return character ? avatarColor(character) : undefined
    },
    [team, characterById]
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

  const handleNewDirect = () => {
    log.info("channel-list new-direct")
    onNewDirect()
  }
  const handleNewTeamConversation = (teamId: string) => {
    log.info("channel-list new-team-conversation", { teamId })
    onNewTeamConversation(teamId)
  }

  const handleSessionSelect = useCallback(
    (id: string, e: ReactMouseEvent) => {
      const modified = e.ctrlKey || e.metaKey || e.shiftKey
      handleClick(id, e)
      // Plain click activates the session in the chat panel; modifier-bearing
      // clicks only mutate the selection. This mirrors Explorer / Finder.
      if (!modified) {
        onSelect(id)
      }
    },
    [handleClick, onSelect]
  )

  // Branched sessions show a small lineage chip; clicking it activates the
  // parent conversation in the chat panel (no selection-mutation).
  const handleJumpToParent = useCallback((parentId: string) => onSelect(parentId), [onSelect])

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
        onSelect(focusedId)
      }
    },
    [clear, orderedIds, selectAll, selected.size, focusedId, onSelect]
  )

  // Drag-and-drop: reorder any conversation section or drop a conversation onto
  // a folder. A short activation distance keeps plain clicks from starting drags.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  )
  // Maps each session id to the ordered ids of the section it renders in (and
  // that section's stable key), so a drop can reorder that section (pinned /
  // date bucket / folder / recent) and tag the persisted order with the
  // section it belongs to. Search results aren't reorderable and are
  // intentionally excluded.
  const sectionIdsBySession = useMemo(() => {
    const map = new Map<string, { ids: string[]; key: string }>()
    for (const section of sections) {
      if (section.kind === "search") continue
      const ids = section.sessions.map((s) => s.id)
      const key = conversationSectionKey(section)
      for (const id of ids) map.set(id, { ids, key })
    }
    return map
  }, [sections])
  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      // Reorder is scoped to the section the drop target lives in.
      const overId = e.over ? String(e.over.id) : null
      const overSection = overId ? sectionIdsBySession.get(overId) : undefined
      const action = resolveConversationDrop(
        e.active ? { id: String(e.active.id), data: e.active.data.current } : null,
        e.over ? { id: overId!, data: e.over.data.current } : null,
        overSection?.ids ?? []
      )
      if (!action) return
      if (action.type === "assign") void onAssignToFolder?.(action.sessionId, action.folderId)
      else if (overSection) void onReorderSessions?.(action.ids, overSection.key)
    },
    [sectionIdsBySession, onAssignToFolder, onReorderSessions]
  )

  // Toolbar visibility: show when ≥2 are selected OR when a single row was
  // selected via a modifier (so the user can still pin/unpin/delete just
  // that one row without round-tripping through the per-row menu). Plain
  // single click — the normal "open this conversation" gesture — never
  // pops the toolbar so it stays out of the way.
  const toolbarVisible = selected.size >= 2 || (selected.size === 1 && lastInteractionWasModified)

  const handleBulkDeleteClick = useCallback(async () => {
    if (!onBulkDelete || selected.size === 0) return
    const ids = [...selected]
    await onBulkDelete(ids)
    clear()
  }, [onBulkDelete, selected, clear])

  const handleBulkSetPinnedClick = useCallback(
    async (pinned: boolean) => {
      if (!onBulkSetPinned || selected.size === 0) return
      const ids = [...selected]
      await onBulkSetPinned(ids, pinned)
      clear()
    },
    [onBulkSetPinned, selected, clear]
  )

  const handleBulkArchiveClick = useCallback(async () => {
    if (!onBulkArchive || selected.size === 0) return
    const ids = [...selected]
    await onBulkArchive(ids)
    clear()
  }, [onBulkArchive, selected, clear])

  const handleBulkUnarchiveClick = useCallback(async () => {
    if (!onBulkUnarchive || selected.size === 0) return
    const ids = [...selected]
    await onBulkUnarchive(ids)
    clear()
  }, [onBulkUnarchive, selected, clear])

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
  return (
    // Diagnostic: surfaces sidebar re-renders as `react:sidebar:channel-list`
    // in the PerfHud so we can confirm whether the history list churns.
    // Revert this PerfBoundary once the question is settled.
    <PerfBoundary id="sidebar:channel-list">
      <div
        ref={containerRef}
        className="flex h-full flex-col outline-none"
        tabIndex={0}
        onKeyDown={handleContainerKeyDown}
      >
        <Header
          selectedGuild={chatGuild}
          team={team ?? null}
          view={view}
          density={density}
          showPreview={showPreview}
          groupByDate={groupByDate}
          showUnreadBadges={showUnreadBadges}
          searchScope={searchScope}
          onUpdateDisplay={saveSidebarSettings}
          onToggleView={() => setView(view === "active" ? "archived" : "active")}
          onNewFolder={
            view === "active" && onCreateFolder
              ? () => void onCreateFolder(t("newFolderName"))
              : undefined
          }
          onNewDirect={handleNewDirect}
          onNewTeamConversation={handleNewTeamConversation}
        />
        <div className="px-3 pb-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="search"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && searchInput) {
                  e.preventDefault()
                  e.stopPropagation()
                  clearSearch()
                }
              }}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchAria")}
              className="h-8 pr-9 pl-7 text-sm"
            />
            {searchInput ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute top-1/2 right-1 size-6 -translate-y-1/2"
                aria-label={t("clearSearch")}
                onClick={clearSearch}
              >
                <XIcon className="size-3.5" />
              </Button>
            ) : (
              <Kbd className="absolute top-1/2 right-1.5 h-5 -translate-y-1/2">/</Kbd>
            )}
          </div>
        </div>
        {toolbarVisible ? (
          <ChannelListBulkToolbar
            count={selected.size}
            archived={view === "archived"}
            onDelete={handleBulkDeleteClick}
            onPin={() => handleBulkSetPinnedClick(true)}
            onUnpin={() => handleBulkSetPinnedClick(false)}
            onArchive={handleBulkArchiveClick}
            onUnarchive={handleBulkUnarchiveClick}
            onClear={clear}
          />
        ) : null}
        {contentTruncated && query.trim() ? (
          <p className="px-3 pb-1 text-[11px] text-muted-foreground" role="status">
            {t("searchTruncated")}
          </p>
        ) : null}
        <Separator />
        <ScrollArea className="flex-1">
          {loading && total === 0 ? (
            <SessionListLoading />
          ) : total === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">
              {view === "archived"
                ? t("emptyArchived")
                : chatGuild.kind === "team"
                  ? t("emptyTeam")
                  : t("emptyDm")}
            </p>
          ) : filteredCount === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">
              {t("emptySearch", { query: searchInput.trim() })}
            </p>
          ) : (
            <DndContext
              sensors={dndSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <ConversationSections
                sections={sections}
                orderedIds={orderedIds}
                activeSessionId={activeSessionId}
                focusedId={focusedId}
                density={density}
                showPreview={showPreview}
                unreadById={unreadById}
                isSelected={isSelected}
                accentFor={accentFor}
                folders={folders ?? EMPTY_FOLDERS}
                onSelect={handleSessionSelect}
                onDelete={onDelete}
                onRename={onRename}
                onTogglePinned={onTogglePinned}
                onArchive={onArchive}
                onUnarchive={onUnarchive}
                onAssignToFolder={onAssignToFolder}
                onToggleFolder={toggleFolderCollapsed}
                onRenameFolder={onRenameFolder}
                onDeleteFolder={onDeleteFolder}
                onJumpToParent={handleJumpToParent}
              />
            </DndContext>
          )}
        </ScrollArea>
      </div>
    </PerfBoundary>
  )
}

function Header({
  selectedGuild,
  team,
  view,
  density,
  showPreview,
  groupByDate,
  showUnreadBadges,
  searchScope,
  onUpdateDisplay,
  onToggleView,
  onNewFolder,
  onNewDirect,
  onNewTeamConversation,
}: {
  selectedGuild: { kind: "dm" } | { kind: "team"; teamId: string }
  team: Team | null
  view: "active" | "archived"
  density: ConversationSidebarDensity
  showPreview: boolean
  groupByDate: boolean
  showUnreadBadges: boolean
  searchScope: ConversationSearchScope
  onUpdateDisplay: (patch: Partial<ConversationSidebarSettings>) => void
  onToggleView: () => void
  onNewFolder?: () => void
  onNewDirect: () => void
  onNewTeamConversation: (teamId: string) => void
}) {
  const t = useTranslations("desktop.channelList")
  const isTeam = selectedGuild.kind === "team"
  const ctaLabel = isTeam ? t("newConversation") : t("newChat")
  const isArchived = view === "archived"
  const viewLabel = isArchived ? t("viewActive") : t("viewArchived")
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-3">
      <div className="flex min-w-0 items-center gap-2">
        {isTeam ? (
          <UsersIcon
            className="size-4 shrink-0"
            style={{
              color: team ? avatarColor(team) : undefined,
            }}
          />
        ) : (
          <MailIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-sm font-semibold tracking-tight">
          {isTeam ? (team?.name ?? t("teamFallback")) : t("directMessages")}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {onNewFolder ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={onNewFolder}
            aria-label={t("newFolder")}
            title={t("newFolder")}
          >
            <FolderPlusIcon className="size-4" />
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={t("displayOptions")}
              title={t("displayOptions")}
            >
              <SlidersHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
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
              checked={groupByDate}
              onCheckedChange={(checked) => onUpdateDisplay({ groupByDate: Boolean(checked) })}
            >
              {t("groupByDate")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={showUnreadBadges}
              onCheckedChange={(checked) => onUpdateDisplay({ showUnreadBadges: Boolean(checked) })}
            >
              {t("showUnreadBadges")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={searchScope === "titleAndContent"}
              onCheckedChange={(checked) =>
                onUpdateDisplay({ searchScope: checked ? "titleAndContent" : "title" })
              }
            >
              {t("searchMessageContent")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
      </div>
    </div>
  )
}

function ConversationSections({
  sections,
  orderedIds,
  activeSessionId,
  focusedId,
  density,
  showPreview,
  unreadById,
  isSelected,
  accentFor,
  folders,
  onSelect,
  onDelete,
  onRename,
  onTogglePinned,
  onArchive,
  onUnarchive,
  onAssignToFolder,
  onToggleFolder,
  onRenameFolder,
  onDeleteFolder,
  onJumpToParent,
}: {
  sections: import("@/lib/chat/conversation-list-model").ConversationSection[]
  orderedIds: string[]
  activeSessionId: string | null
  focusedId: string | null
  density: ConversationSidebarDensity
  showPreview: boolean
  unreadById: Map<string, number>
  isSelected: (id: string) => boolean
  accentFor: (session: ChatSession) => string | undefined
  folders: SessionFolder[]
  onSelect: (id: string, e: ReactMouseEvent) => void
  onDelete: (id: string) => void | Promise<void>
  onRename: (id: string, title: string) => void | Promise<void>
  onTogglePinned?: (id: string, pinned: boolean) => void | Promise<void>
  onArchive?: (id: string) => void | Promise<void>
  onUnarchive?: (id: string) => void | Promise<void>
  onAssignToFolder?: (sessionId: string, folderId: string | null) => void | Promise<void>
  onToggleFolder: (id: string) => void
  onRenameFolder?: (id: string, name: string) => void | Promise<void>
  onDeleteFolder?: (id: string) => void | Promise<void>
  onJumpToParent?: (parentSessionId: string) => void
}) {
  const t = useTranslations("desktop.channelList")

  const renderRow = (s: ChatSession) => (
    <SortableSessionRow
      key={s.id}
      session={s}
      active={s.id === activeSessionId}
      selected={isSelected(s.id)}
      focused={s.id === focusedId}
      density={density}
      showPreview={showPreview}
      accentColor={accentFor(s)}
      unread={unreadById.get(s.id)}
      folders={folders}
      onSelect={onSelect}
      onDelete={onDelete}
      onRename={onRename}
      onTogglePinned={onTogglePinned}
      onArchive={onArchive}
      onUnarchive={onUnarchive}
      onAssignToFolder={onAssignToFolder}
      onJumpToParent={onJumpToParent}
    />
  )

  return (
    <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
      <div className="flex flex-col gap-3 p-2">
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
                renderRow={renderRow}
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
          return (
            <section key={key} aria-label={label ?? t("searchAria")}>
              {label ? (
                <div className="flex items-center gap-2 px-2 pb-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {label}
                  </span>
                </div>
              ) : null}
              <ul className="flex flex-col gap-0.5">{section.sessions.map(renderRow)}</ul>
            </section>
          )
        })}
      </div>
    </SortableContext>
  )
}

/**
 * A conversation row wired for @dnd-kit sorting: draggable (grip handle) and a
 * drop target so pinned rows can be reordered. Dropping onto a folder header is
 * handled by that header's own droppable — see {@link FolderSection}.
 */
function SortableSessionRow(props: ComponentProps<typeof SessionRow>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.session.id,
    data: { type: "session", folderId: props.session.folderId ?? null },
  })
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  }
  return (
    <SessionRow
      {...props}
      dragRef={setNodeRef}
      dragListeners={listeners as unknown as Record<string, unknown>}
      dragAttributes={attributes as unknown as Record<string, unknown>}
      dragStyle={style}
      dragging={isDragging}
    />
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
  renderRow,
}: {
  folder: SessionFolder
  collapsed: boolean
  sessions: ChatSession[]
  onToggle: () => void
  onRename?: (id: string, name: string) => void | Promise<void>
  onDelete?: (id: string) => void | Promise<void>
  renderRow: (s: ChatSession) => ReactNode
}) {
  const t = useTranslations("desktop.channelList")
  const { setNodeRef, isOver } = useDroppable({
    id: `folder:${folder.id}`,
    data: { type: "folder", folderId: folder.id },
  })
  return (
    <section
      ref={setNodeRef}
      aria-label={folder.name}
      className={cn("rounded-md", isOver && "bg-primary/10 ring-1 ring-primary/40")}
    >
      <FolderSectionHeader
        folder={folder}
        collapsed={collapsed}
        count={sessions.length}
        onToggle={onToggle}
        onRename={onRename}
        onDelete={onDelete}
      />
      {collapsed ? null : (
        <ul className="flex flex-col gap-0.5">
          {sessions.length === 0 ? (
            <li className="px-3 py-1 text-[11px] text-muted-foreground">{t("emptyFolder")}</li>
          ) : (
            sessions.map(renderRow)
          )}
        </ul>
      )}
    </section>
  )
}

function FolderSectionHeader({
  folder,
  collapsed,
  count,
  onToggle,
  onRename,
  onDelete,
}: {
  folder: SessionFolder
  collapsed: boolean
  count: number
  onToggle: () => void
  onRename?: (id: string, name: string) => void | Promise<void>
  onDelete?: (id: string) => void | Promise<void>
}) {
  const t = useTranslations("desktop.channelList")
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(folder.name)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const commit = () => {
    const next = draft.trim()
    if (next && next !== folder.name) void onRename?.(folder.id, next)
    setEditing(false)
  }

  return (
    <div className="group/folder flex items-center gap-1 px-2 pb-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        aria-expanded={!collapsed}
        aria-label={folder.name}
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
        )}
        <FolderIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        {editing ? (
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                commit()
              } else if (e.key === "Escape") {
                e.preventDefault()
                setDraft(folder.name)
                setEditing(false)
              }
            }}
            onBlur={commit}
            className="h-5 px-1 py-0 text-[11px]"
            aria-label={t("renameFolder")}
          />
        ) : (
          <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {folder.name}
            {count > 0 ? <span className="ml-1 normal-case opacity-60">{count}</span> : null}
          </span>
        )}
      </button>
      {(onRename || onDelete) && !editing ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-5 opacity-0 group-hover/folder:opacity-100 data-[state=open]:opacity-100"
              aria-label={t("folderActions")}
            >
              <MoreHorizontalIcon className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
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
