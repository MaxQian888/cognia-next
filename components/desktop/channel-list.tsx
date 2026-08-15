"use client"

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
import { useChatHistorySearch } from "@/hooks/chat/use-chat-history-search"
import { useClientLiveQuery } from "@/hooks/data"
import { listCharacters } from "@/lib/db/characters"
import { listSessionStates } from "@/lib/db/session-state"
import { listTeams } from "@/lib/db/teams"
import { loggers } from "@cognia/logging"
import { avatarColor, type AvatarSubject } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import {
  useUIStore,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  type ChannelListView,
} from "@/stores/ui"
import { useSettingsStore } from "@/stores/settings"
import { densitySurfaceProps } from "@/lib/appearance/density-applier"
import { useProjectStore } from "@/stores/project/project-store"
import { PerfBoundary } from "@/lib/perf"
import {
  resolveConversationDrop,
  resolveConversationDropPreview,
  type ConversationDropPreview,
} from "@/lib/chat/conversation-dnd"
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
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
  ConversationSearchScope,
  ConversationSidebarTitleMotion,
} from "@cognia/agent-config-types"
import { conversationSectionKey, UNGROUPED_ID } from "@/lib/chat/conversation-list-model"
import type { DateBucket } from "@/lib/chat/conversation-list-model"
import {
  CONVERSATION_GROUP_BY_OPTIONS,
  CONVERSATION_SIDEBAR_METADATA_OPTIONS,
  resolveConversationGroupBy,
  resolveConversationSidebarMetadata,
  toggleConversationSidebarMetadata,
} from "@/lib/chat/conversation-grouping"
import { getModelDisplayName, getProviderDisplayName } from "@/lib/ai/icons"
import type { Character, ChatSession, SessionFolder, Team } from "@cognia/agent-config-types"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import {
  ArchiveIcon,
  BotIcon,
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
  useLayoutEffect,
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
import { SessionRow, type SessionRowMetadataItem } from "./session-row"

const log = loggers.ui

/**
 * Stable empty-folders identity. Passing an inline `folders ?? []` would mint a
 * fresh array every render and, since it's forwarded to every memoized
 * <SessionRow>, bust their memo on any sidebar re-render (cf. the `onSelect`
 * note below). Hoisting the fallback keeps the reference constant.
 */
const EMPTY_FOLDERS: SessionFolder[] = []
const EMPTY_SESSION_METADATA: SessionRowMetadataItem[] = []

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
  // column (no leftover strip); the list header exposes the quick-collapse
  // action while the global shortcut and View menu share the same state.
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  // Enable the width transition ONLY for the brief collapse/expand animation —
  // never while the user drag-resizes (resize mutates the same `width`, and a
  // live transition would make the drag rubber-band). A short timer clears it.
  const [animatingCollapse, setAnimatingCollapse] = useState(false)
  const prevCollapsedRef = useRef(sidebarCollapsed)
  // This must run before paint: a passive effect lets the browser commit the
  // new width first, so collapse/expand appears to jump for one frame.
  useLayoutEffect(() => {
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
        <SheetContent side="left" className="w-72 bg-transparent p-0">
          <div
            className="flex h-full min-h-0 flex-col bg-background"
            data-bg-target="chat"
            data-slot="sidebar-inner"
          >
            <SheetHeader className="px-3 pt-3 pb-1">
              <SheetTitle className="text-sm">{t("conversationsTitle")}</SheetTitle>
            </SheetHeader>
            <ChannelListBody {...props} onSelect={handleSelect} />
          </div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <aside
      id="conversation-sidebar"
      className={cn(
        "relative hidden h-full shrink-0 flex-col bg-muted/15 md:flex",
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
      data-slot="sidebar-inner"
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
  const groupBy = resolveConversationGroupBy(sidebarSettings)
  const showUnreadBadges = sidebarSettings?.showUnreadBadges ?? true
  const searchScope: ConversationSearchScope = sidebarSettings?.searchScope ?? "title"
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

  const teams = useClientLiveQuery<Team[]>(() => listTeams(), [], [])
  const teamById = useMemo(() => new Map((teams ?? []).map((item) => [item.id, item])), [teams])
  const team = chatGuild.kind === "team" ? teamById.get(chatGuild.teamId) : undefined

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

  // Folders only group the active view (archived chats stay in date buckets).
  const modelFolders = view === "archived" ? undefined : folders

  // Group axes the model can't resolve on its own — it stays pure, so the
  // display names come from here.
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  // The workspace grouping intentionally spans every project; every other
  // grouping stays scoped to the active one.
  const scopeProjectId = groupBy === "workspace" ? undefined : (activeProjectId ?? undefined)
  const contentSearch = useChatHistorySearch(query, {
    enabled: searchScope === "titleAndContent",
    projectId: scopeProjectId,
    includeArchived: view === "archived",
    collapseBySession: true,
    limit: 200,
  })
  const contentMatchIds = useMemo<ReadonlySet<string> | undefined>(() => {
    if (searchScope !== "titleAndContent" || query.trim().length < 2) return undefined
    return new Set(contentSearch.results.map((result) => result.sessionId))
  }, [searchScope, query, contentSearch.results])
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
  const setGroupCollapsed = useUIStore((s) => s.setGroupCollapsed)

  // Grouping/filtering/search now live in the shared headless model
  // (pinned → folders → the chosen axis, or a flat result list while searching).
  const { sections, total, filteredCount, orderedIds } = useConversationListModel({
    sessions: filtered,
    folders: modelFolders,
    query,
    view,
    collapsedFolderIds,
    groupBy,
    workspaces: workspaceGroups,
    agents: agentGroups,
    activeWorkspaceId: activeProjectId,
    groupCollapseOverrides,
    contentMatchIds: searchScope === "titleAndContent" ? contentMatchIds : undefined,
  })

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
          session.model ?? character?.model ?? defaultModel ?? "claude-sonnet-4-5"
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
  const handleToggleSelection = useCallback(
    (id: string) => {
      handleClick(id, { ctrlKey: true, metaKey: false, shiftKey: false })
    },
    [handleClick]
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
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
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
  const [dropPreview, setDropPreview] = useState<ConversationDropPreview | null>(null)
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
        className="flex h-full flex-col bg-gradient-to-b from-background/70 to-background/35 outline-none"
        data-tonality="translucent"
        tabIndex={0}
        onKeyDown={handleContainerKeyDown}
        {...densitySurfaceProps("sidebar", appearanceDensity)}
      >
        <Header
          selectedGuild={chatGuild}
          team={team ?? null}
          view={view}
          density={density}
          showPreview={showPreview}
          showCustomIcons={showCustomIcons}
          groupBy={groupBy}
          showUnreadBadges={showUnreadBadges}
          searchScope={searchScope}
          metadataFields={metadataFields}
          titleMotion={titleMotion}
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
        <ChannelListSearch inputRef={searchInputRef} onQueryChange={setQuery} />
        <ChannelListBulkActions
          visible={toolbarVisible}
          selected={selected}
          orderedIds={orderedIds}
          sessions={filtered}
          archived={view === "archived"}
          onDelete={onBulkDelete}
          onSetPinned={onBulkSetPinned}
          onArchive={onBulkArchive}
          onUnarchive={onBulkUnarchive}
          onClear={clear}
        />
        {contentTruncated && query.trim() ? (
          <p className="px-3 pb-1 text-[11px] text-muted-foreground" role="status">
            {t("searchTruncated")}
          </p>
        ) : null}
        <Separator className="opacity-60" />
        <ScrollArea className="flex-1 [&_[data-slot=scroll-area-scrollbar]]:hidden [&_[data-slot=scroll-area-viewport]>div]:!block">
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
          ) : filteredCount === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">
              {t("emptySearch", { query: query.trim() })}
            </p>
          ) : (
            <DndContext
              sensors={dndSensors}
              collisionDetection={closestCenter}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              onDragCancel={() => setDropPreview(null)}
            >
              <ConversationSections
                sections={sections}
                dropPreview={dropPreview}
                activeSessionId={activeSessionId}
                focusedId={focusedId}
                density={density}
                showPreview={showPreview}
                metadataFor={metadataFor}
                titleMotion={titleMotion}
                unreadById={unreadById}
                isSelected={isSelected}
                onToggleSelection={handleToggleSelection}
                accentFor={accentFor}
                iconFor={iconFor}
                folders={folders ?? EMPTY_FOLDERS}
                onSelect={handleSessionSelect}
                onDelete={onDelete}
                onRename={onRename}
                onTogglePinned={onTogglePinned}
                onArchive={onArchive}
                onUnarchive={onUnarchive}
                onAssignToFolder={onAssignToFolder}
                onToggleFolder={toggleFolderCollapsed}
                onToggleGroup={setGroupCollapsed}
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

function ChannelListSearch({
  inputRef,
  onQueryChange,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  onQueryChange: (query: string) => void
}) {
  const t = useTranslations("desktop.channelList")
  const [value, setValue] = useState("")
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
    <div className="px-3 pb-2.5">
      <InputGroup className="h-9 rounded-xl border-transparent bg-muted/60 shadow-none">
        <InputGroupAddon align="inline-start" className="pr-0 pl-2">
          <SearchIcon className="size-3.5" aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          type="search"
          value={value}
          onChange={(event) => updateValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && value) {
              event.preventDefault()
              event.stopPropagation()
              clear()
            }
          }}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchAria")}
          className="h-9 px-2 text-sm [&::-webkit-search-cancel-button]:hidden"
        />
        <InputGroupAddon align="inline-end" className="pr-1 pl-0">
          {value ? (
            <InputGroupButton size="icon-xs" aria-label={t("clearSearch")} onClick={clear}>
              <XIcon className="size-3.5" />
            </InputGroupButton>
          ) : (
            <Kbd className="h-5">/</Kbd>
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
  const Icon = archived ? ArchiveIcon : team ? UsersIcon : MailIcon

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

function Header({
  selectedGuild,
  team,
  view,
  density,
  showPreview,
  showCustomIcons,
  groupBy,
  showUnreadBadges,
  searchScope,
  metadataFields,
  titleMotion,
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
  showCustomIcons: boolean
  groupBy: ConversationGroupBy
  showUnreadBadges: boolean
  searchScope: ConversationSearchScope
  metadataFields: ConversationSidebarMetadata[]
  titleMotion: ConversationSidebarTitleMotion
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
              onCheckedChange={(checked) =>
                onUpdateDisplay({ titleMotion: checked ? "hover" : "off" })
              }
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
  dropPreview,
  activeSessionId,
  focusedId,
  density,
  showPreview,
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
  onJumpToParent,
}: {
  sections: import("@/lib/chat/conversation-list-model").ConversationSection[]
  dropPreview: ConversationDropPreview | null
  activeSessionId: string | null
  focusedId: string | null
  density: ConversationSidebarDensity
  showPreview: boolean
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
    metadata: metadataFor(s),
    titleMotion,
    accentColor: accentFor(s),
    iconSubject: iconFor(s),
    unread: unreadById.get(s.id),
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
  const renderSortableRow = (s: ChatSession) => (
    <SortableSessionRow
      key={s.id}
      {...rowProps(s)}
      dropPosition={dropPreview?.targetId === s.id ? dropPreview.position : undefined}
    />
  )
  const renderStaticRow = (s: ChatSession) => <SessionRow key={s.id} {...rowProps(s)} />

  return (
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
                  ? t(section.axis === "workspace" ? "ungroupedWorkspace" : "ungroupedAgent")
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
        const rows = (
          <ul className="flex flex-col gap-0.5">
            {section.sessions.map(section.kind === "search" ? renderStaticRow : renderSortableRow)}
          </ul>
        )
        return (
          <section key={key} aria-label={label ?? t("searchAria")}>
            {label ? (
              <div className="flex items-center gap-2 px-2 pb-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {label}
                </span>
              </div>
            ) : null}
            {section.kind === "search" ? (
              rows
            ) : (
              <SortableContext
                id={key}
                items={section.sessions.map((session) => session.id)}
                strategy={verticalListSortingStrategy}
              >
                {rows}
              </SortableContext>
            )}
          </section>
        )
      })}
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
    data: { type: "session", folderId: props.session.folderId ?? null },
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  return (
    <SessionRow
      {...props}
      dragRef={setNodeRef}
      dragListeners={listeners as unknown as Record<string, unknown>}
      dragAttributes={attributes as unknown as Record<string, unknown>}
      dragActivatorRef={setActivatorNodeRef}
      dragStyle={style}
      dragging={isDragging}
    />
  )
}

/**
 * A workspace / agent group. Deliberately not a drop target: dragging a
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
  axis: "workspace" | "agent"
  name: string
  collapsed: boolean
  sessions: ChatSession[]
  onToggle: () => void
  renderRow: (s: ChatSession) => ReactNode
}) {
  const Icon = axis === "workspace" ? FolderIcon : BotIcon
  return (
    <Collapsible asChild open={!collapsed} onOpenChange={onToggle}>
      <section
        aria-label={name}
        className="rounded-md transition-colors duration-200 data-[state=open]:bg-muted/10"
      >
        <div className="flex items-center gap-1 px-2 pb-1">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-auto min-w-0 flex-1 justify-start gap-1.5 p-0 text-left font-normal hover:bg-transparent"
              aria-label={name}
            >
              {collapsed ? (
                <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
              )}
              <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {name}
                {sessions.length > 0 ? (
                  <span className="ml-1 normal-case opacity-60">{sessions.length}</span>
                ) : null}
              </span>
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
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
          />
        </div>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
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
}: {
  folder: SessionFolder
  collapsed: boolean
  count: number
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
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {collapsed ? (
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
          )}
          <FolderIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
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
        </div>
      ) : (
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-auto min-w-0 flex-1 justify-start gap-1.5 p-0 text-left font-normal hover:bg-transparent"
            aria-label={folder.name}
          >
            {collapsed ? (
              <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
            )}
            <FolderIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {folder.name}
              {count > 0 ? <span className="ml-1 normal-case opacity-60">{count}</span> : null}
            </span>
          </Button>
        </CollapsibleTrigger>
      )}
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
