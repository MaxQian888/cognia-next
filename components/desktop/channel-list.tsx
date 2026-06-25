"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { SessionListLoading } from "@/components/ui/loading-states"
import { PluginViewContainerPanel } from "@/components/shell/plugin-view-container-panel"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { useIsNarrow, useRangeSelection } from "@/hooks/ui"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { useConversationListModel } from "@/hooks/chat/use-conversation-list-model"
import { useClientLiveQuery } from "@/hooks/data"
import { listCharacters } from "@/lib/db/characters"
import { listSessionStates } from "@/lib/db/session-state"
import { getTeam } from "@/lib/db/teams"
import { loggers } from "@/lib/logging"
import { avatarColor } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import { useUIStore } from "@/stores/ui"
import { PerfBoundary } from "@/lib/perf"
import type { DateBucket } from "@/lib/chat/conversation-list-model"
import type { Character, ChatSession, SessionFolder, Team } from "@/lib/claude/types"
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
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
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
      className="hidden h-full w-64 shrink-0 flex-col border-r bg-background md:flex"
      aria-label={t("conversationsTitle")}
      data-bg-target="chat"
    >
      <ChannelListBody {...props} onSelect={handleSelect} />
    </aside>
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
}: Props) {
  const t = useTranslations("desktop.channelList")
  const selectedGuild = useUIStore((s) => s.selectedGuild)
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
    for (const s of sessionStates ?? []) {
      if (s.unreadCount > 0) map.set(s.sessionId, s.unreadCount)
    }
    return map
  }, [sessionStates])

  const team = useClientLiveQuery<Team | undefined>(
    () => (chatGuild.kind === "team" ? getTeam(chatGuild.teamId) : Promise.resolve(undefined)),
    [chatGuild],
    undefined
  )

  // Filter the session list by selected guild. (Phase D) Sessions with
  // `kind === "workflow-editor"` are scoped to the workflow editor's chat
  // tab and never surface in the main channel list — they appear ONLY
  // inside the editor itself.
  const filtered = useMemo(() => {
    const visible = sessions.filter((s) => s.kind !== "workflow-editor")
    if (chatGuild.kind === "team") {
      return visible.filter((s) => s.kind === "team" && s.teamId === chatGuild.teamId)
    }
    // DM bucket: anything that isn't a team session.
    return visible.filter((s) => s.kind !== "team")
  }, [sessions, chatGuild])

  // Search box: keep the field value immediate but debounce the value fed
  // to the grouping model so typing doesn't re-bucket on every keystroke.
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

  // Active ⇄ Archived view (local, ephemeral — resets on remount).
  const [view, setView] = useState<"active" | "archived">("active")

  // Folder collapse is local/ephemeral — resets on reload (UX-acceptable and
  // keeps the persisted UI store untouched).
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  )
  const toggleFolderCollapsed = useCallback((id: string) => {
    setCollapsedFolderIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

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

  // Clear the multi-selection whenever the user pivots to a different
  // guild — the visual context changes and stale "selected" rows would
  // confuse the bulk-toolbar count. `clear` is a stable callback (it's
  // `useCallback(..., [])` inside the hook) so its identity never trips
  // this effect.
  useEffect(() => {
    clear()
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
      if (e.key === "Escape") {
        if (selected.size > 0) {
          e.preventDefault()
          clear()
        }
        return
      }
      const isCtrlA = (e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")
      if (isCtrlA && orderedIds.length > 0) {
        e.preventDefault()
        selectAll()
      }
    },
    [clear, orderedIds.length, selectAll, selected.size]
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
          onToggleView={() => setView((v) => (v === "active" ? "archived" : "active"))}
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
              type="search"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchAria")}
              className="h-8 pr-7 pl-7 text-sm"
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
            ) : null}
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
            <ConversationSections
              sections={sections}
              activeSessionId={activeSessionId}
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
  onToggleView,
  onNewFolder,
  onNewDirect,
  onNewTeamConversation,
}: {
  selectedGuild: { kind: "dm" } | { kind: "team"; teamId: string }
  team: Team | null
  view: "active" | "archived"
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
  activeSessionId,
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
  activeSessionId: string | null
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
    <SessionRow
      key={s.id}
      session={s}
      active={s.id === activeSessionId}
      selected={isSelected(s.id)}
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
    <div className="flex flex-col gap-3 p-2">
      {sections.map((section) => {
        if (section.kind === "folder") {
          const { folder, collapsed } = section
          return (
            <section key={`folder:${folder.id}`} aria-label={folder.name}>
              <FolderSectionHeader
                folder={folder}
                collapsed={collapsed}
                count={section.sessions.length}
                onToggle={() => onToggleFolder(folder.id)}
                onRename={onRenameFolder}
                onDelete={onDeleteFolder}
              />
              {collapsed ? null : (
                <ul className="flex flex-col gap-0.5">
                  {section.sessions.length === 0 ? (
                    <li className="px-3 py-1 text-[11px] text-muted-foreground">
                      {t("emptyFolder")}
                    </li>
                  ) : (
                    section.sessions.map(renderRow)
                  )}
                </ul>
              )}
            </section>
          )
        }

        const label =
          section.kind === "pinned"
            ? t("sectionPinned")
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
