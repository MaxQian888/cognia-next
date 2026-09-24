"use client"

/**
 * The phone shell's conversation list — the navigation drawer's main column,
 * also what a browser window narrower than 768px gets.
 *
 * Layout (a ~262px column at 375px, ~308px at 430px):
 *
 *   ┌───────────────────────────────┐
 *   │ [🔍 Search chats…      ] [ + ] │  search owns the row; New chat beside it
 *   │ [ Chats | Archived ] [🔭] [⚲] │  view, search reach, filter & sort
 *   │ filter chips (only when set)  │
 *   ├───────────────────────────────┤
 *   │ PINNED                      2 │  windowed: headers + rows as one list
 *   │ (◉) Title…            14:32 3 │
 *   └───────────────────────────────┘
 *
 * Rendering contract:
 *   - The column is `min-w-0`. Titles are `nowrap`, and without it the
 *     column's min-content width was the longest title: the list measured
 *     842px in a 262px slot, the header controls and the swipe strip sat off
 *     screen, and titles clipped with no ellipsis.
 *   - Rows are windowed (`@tanstack/react-virtual`) over a flat item model
 *     (`mobile-channel-list-items.ts`) and memoized (`mobile-channel-row.tsx`).
 *     Opening the drawer on a 400-conversation profile used to mount every
 *     row in one ~700ms task; now it mounts a screenful.
 *   - Everything that outlives the drawer — characters, teams, unread state,
 *     the search, message-content search, scroll position — comes from
 *     `MobileChannelListSourceProvider`, which the shell mounts outside the
 *     drawer. Reopening does not refetch, re-sync or scroll back to the top.
 *   - No per-row entrance animation. The drawer's own slide is the entrance;
 *     the old uncapped stagger left row #200 of a search invisible for eight
 *     seconds and replayed on every open. Motion that remains (the swipe
 *     snap, chevrons) follows both the OS and the app's Reduce-motion setting
 *     through the global rules in `app/globals.css`.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { useTimeZone, useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ChevronRightIcon,
  FolderIcon,
  MessagesSquareIcon,
  PlusIcon,
} from "lucide-react"
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { LoadingRegion } from "@/components/ui/loading-region"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ConversationFilterChips,
  ConversationFilterMenu,
  ConversationSearchScopeControl,
} from "@/components/chat/conversation-filter-controls"
import { ThreadHandoffSourceDialog } from "@/components/thread-handoff/thread-handoff-source-dialog"
import {
  useConversationDayClock,
  useConversationListModel,
} from "@/hooks/chat/use-conversation-list-model"
import {
  useConversationReveal,
  type ConversationRevealStep,
} from "@/hooks/chat/use-conversation-reveal"
import { useConversationFilterController } from "@/hooks/chat/use-conversation-filter-controller"
import {
  CONVERSATION_GROUP_AXIS_ICON,
  CONVERSATION_UNGROUPED_LABEL_KEY,
} from "@/lib/chat/conversation-group-axis"
import {
  resolveConversationGroupBy,
  resolveConversationSidebarMetadata,
} from "@/lib/chat/conversation-grouping"
import {
  conversationSectionKey,
  UNGROUPED_ID,
  type ConversationGroupAxis,
  type DateBucket,
} from "@/lib/chat/conversation-list-model"
import { resolveConversationSearchOptions } from "@/lib/chat/conversation-search-scope"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import { SessionHandoffLockedError } from "@/lib/chat/session-write-guard"
import { markSessionRead } from "@/lib/db/session-state"
import { cn } from "@/lib/utils"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore, type ChannelListView } from "@/stores/ui"
import { loggers } from "@cognia/logging"
import type {
  Character,
  ChatSession,
  ConversationSidebarDensity,
  ConversationSidebarSettings,
  SessionFolder,
  Team,
} from "@cognia/agent-config-types"

import {
  MobileChannelListStandaloneSource,
  useMobileChannelListSource,
  useOptionalMobileChannelListSource,
  type MobileChannelScrollMemory,
} from "./mobile-channel-list-source"
import {
  buildMobileChannelListItems,
  findRowIndex,
  type MobileChannelListItem,
} from "./mobile-channel-list-items"
import {
  MobileChannelRow,
  type MobileChannelRowSettings,
  type MobileChannelSwipeActionId,
} from "./mobile-channel-row"
import { MobileChannelRowActions } from "./mobile-channel-row-actions"
import { MobileChannelDeleteConfirm } from "./mobile-channel-delete-confirm"
import { MobileChannelSearchField } from "./mobile-channel-search-field"

const log = loggers.ui

export interface MobileChannelListProps {
  sessions: readonly ChatSession[]
  /**
   * The session query has not answered yet (`useSessions().isLoadingSessions`).
   * Without it a cold start flashed "No chats yet" before the list arrived.
   */
  isLoadingSessions?: boolean
  activeSessionId: string | null
  onSelect: (id: string) => void
  onNewDirect: () => void
  onDelete: (id: string) => void | Promise<void>
  onRename: (id: string, title: string) => void | Promise<void>
  onArchive: (id: string) => void | Promise<void>
  onUnarchive: (id: string) => void | Promise<void>
  /** `useSessions().bulkSetPinned` — the one pin writer both shells use. */
  onSetPinned: (ids: readonly string[], pinned: boolean) => void | Promise<void>
  /** `useSessions().assignToFolder`; `null` takes the conversation out of its folder. */
  onAssignToFolder: (sessionId: string, folderId: string | null) => void | Promise<void>
  /** Conversation folders (display, collapse, and "Move to folder"). */
  folders?: readonly SessionFolder[]
}

/** Maps a date bucket to its `mobile.home` label key. */
const BUCKET_LABEL_KEY: Record<DateBucket, string> = {
  today: "bucketToday",
  yesterday: "bucketYesterday",
  prev7: "bucketPrev7",
  prev30: "bucketPrev30",
  older: "bucketOlder",
}

type ActionFailure =
  "rename" | "pin" | "unpin" | "archive" | "unarchive" | "delete" | "move" | "markRead"

const NO_FOLDERS: readonly SessionFolder[] = []
const SKELETON_ROWS = 6

/** Refused by the session write guard because the row is mid-handoff. */
export function isSessionHandoffLocked(error: unknown): boolean {
  if (error instanceof SessionHandoffLockedError) return true
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "session_handoff_locked"
  )
}

export function MobileChannelList(props: MobileChannelListProps) {
  // The shell provides the source from outside the drawer so it survives the
  // drawer closing. Rendered anywhere else (Storybook, an isolated test), the
  // list brings its own.
  const source = useOptionalMobileChannelListSource()
  if (source) return <MobileChannelListBody {...props} />
  return (
    <MobileChannelListStandaloneSource>
      <MobileChannelListBody {...props} />
    </MobileChannelListStandaloneSource>
  )
}

function MobileChannelListBody({
  sessions,
  isLoadingSessions = false,
  activeSessionId,
  onSelect,
  onNewDirect,
  onDelete,
  onRename,
  onArchive,
  onUnarchive,
  onSetPinned,
  onAssignToFolder,
  folders = NO_FOLDERS,
}: MobileChannelListProps) {
  const t = useTranslations("mobile.home")
  const tShell = useTranslations("mobile.shell")
  // Filter vocabulary shared with the desktop sidebar.
  const tFilters = useTranslations("conversationFilters")
  // Success toasts shared with the desktop sidebar's row and bulk actions.
  const tBulk = useTranslations("desktop.channelList.bulk")
  const {
    characters,
    teams,
    sessionStates,
    query,
    hasSearchText,
    clearSearch,
    contentSearch,
    scrollMemory,
  } = useMobileChannelListSource()

  const exposedSessions = useMemo(() => filterExposedSessions(sessions, "main-list"), [sessions])
  const timeZone = useTimeZone()
  const dayNow = useConversationDayClock(timeZone)
  const sessionsById = useMemo(
    () => new Map(exposedSessions.map((session) => [session.id, session])),
    [exposedSessions]
  )

  // Active ⇄ Archived view + folder collapse — read straight from the persisted
  // UI store (shared with the desktop sidebar) so the choice survives reloads.
  // Straight, not mirrored: a local copy seeded once at mount could not see the
  // other surface — or the reveal ladder below — move the view, and wrote its
  // stale value back over theirs.
  const view = useUIStore((s) => s.channelListView)
  const setView = useUIStore((s) => s.setChannelListView)
  const persistedCollapsed = useUIStore((s) => s.collapsedFolderIds)
  const toggleFolder = useUIStore((s) => s.toggleCollapsedFolder)
  const collapsedFolderIds = useMemo<ReadonlySet<string>>(
    () => new Set(persistedCollapsed),
    [persistedCollapsed]
  )
  const groupCollapseOverrides = useUIStore((s) => s.groupCollapseOverrides)
  const setGroupCollapsed = useUIStore((s) => s.setGroupCollapsed)

  // Behavior preferences (Settings → Conversation → sidebar), shared with the
  // desktop sidebar. Absent settings fall back to the same defaults it uses.
  const sidebarSettings = useSettingsStore((s) => s.settings?.conversationSidebar)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const saveSettings = useSettingsStore((s) => s.save)
  const density: ConversationSidebarDensity = sidebarSettings?.density ?? "comfortable"
  const showPreview = sidebarSettings?.showPreview ?? false
  const showTimestamps = sidebarSettings?.showTimestamps ?? true
  const showCustomIcons = sidebarSettings?.showCustomIcons ?? true
  const groupBy = resolveConversationGroupBy(sidebarSettings)
  const showUnreadBadges = sidebarSettings?.showUnreadBadges !== false
  const searchOptions = useMemo(
    () => resolveConversationSearchOptions(sidebarSettings),
    [sidebarSettings]
  )
  const metadataFields = useMemo(
    () => resolveConversationSidebarMetadata(sidebarSettings),
    [sidebarSettings]
  )
  // The mobile list has no optimistic save queue: merge the patch into the
  // settings the store currently holds and write straight through.
  const saveSidebarSettings = useCallback(
    (patch: Partial<ConversationSidebarSettings>) =>
      void saveSettings({ conversationSidebar: { ...sidebarSettings, ...patch } }),
    [saveSettings, sidebarSettings]
  )

  const characterById = useMemo(() => {
    const map = new Map<string, Character>()
    for (const character of characters) map.set(character.id, character)
    return map
  }, [characters])
  const teamById = useMemo(() => {
    const map = new Map<string, Team>()
    for (const team of teams) map.set(team.id, team)
    return map
  }, [teams])
  // `unreadIds` feeds the unread filter/sort and must stay independent of the
  // badge display setting — hiding a badge is a display choice, not a claim
  // that nothing is unread.
  const unreadCountById = useMemo(() => {
    const map = new Map<string, number>()
    for (const state of sessionStates) {
      if (state.unreadCount > 0) map.set(state.sessionId, state.unreadCount)
    }
    return map
  }, [sessionStates])
  const unreadIds = useMemo<ReadonlySet<string>>(
    () => new Set(unreadCountById.keys()),
    [unreadCountById]
  )

  // Group axes the pure model can't resolve on its own.
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const workspaceGroups = useMemo(
    () => projects.map((p) => ({ id: p.id, name: p.name })),
    [projects]
  )
  const workspaceNameById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects]
  )
  const agentGroups = useMemo(
    () => characters.map((c) => ({ id: c.id, name: c.name })),
    [characters]
  )
  const teamGroups = useMemo(() => teams.map((team) => ({ id: team.id, name: team.name })), [teams])

  const searching = query.trim().length > 0
  const contentMatchIds = useMemo<ReadonlySet<string> | undefined>(() => {
    if (!searchOptions.content || !searching) return undefined
    return new Set(contentSearch.results.map((result) => result.sessionId))
  }, [searchOptions.content, searching, contentSearch.results])
  // A content query resolves a beat after the title hits; until it settles the
  // result set is incomplete and the list must not claim there is nothing.
  const contentPending = searchOptions.content && contentSearch.loading && searching
  const contentTruncated =
    contentSearch.moreOlderHistory ||
    contentSearch.indexIncomplete ||
    contentSearch.error !== null

  // Sort, quick filters and saved presets are shared with the desktop sidebar —
  // one controller over the same settings blob and UI-store slice — so a phone
  // and a desktop looking at the same profile agree about which conversations
  // exist and in what order.
  const viewSessions = useMemo(
    () =>
      exposedSessions.filter((s) =>
        view === "archived" ? s.archivedAt != null : s.archivedAt == null
      ),
    [exposedSessions, view]
  )
  const filterController = useConversationFilterController({
    sessions: viewSessions,
    workspaces: workspaceGroups,
    folders,
    characters,
    teams: teamGroups,
    sidebarSettings,
    saveSidebarSettings,
  })
  const { filters, activeFilters, sortBy, filterContext } = filterController
  const resetConversationFilters = filterController.actions.reset

  // Shared grouping model: pinned → folders → the chosen axis, or a flat result
  // list while searching (mirrors the desktop sidebar via the same headless hook).
  const {
    sections,
    total,
    filteredCount,
    visibleCount,
    activeFilterCount,
    orderedIds,
    contentOnlyIds,
  } = useConversationListModel({
    // Date buckets and row stamps judged by one clock in the formatter's zone,
    // as on the desktop sidebar: the list's "Today" and a row's clock face can
    // never disagree, and both roll over at the user's midnight.
    now: dayNow,
    timeZone,
    sessions: exposedSessions,
    folders: view === "archived" ? undefined : folders,
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
    teams: teamGroups,
    activeWorkspaceId: activeProjectId,
    groupCollapseOverrides,
    contentMatchIds: searchOptions.content ? contentMatchIds : undefined,
    searchIncludesArchived: searchOptions.includeArchived,
  })

  // Same contract as the desktop sidebar: a conversation that was just created
  // has to be visible here. The narrowing state (Archived view, the search
  // field, quick filters, a folded section) is persisted and would otherwise
  // leave the new chat open in the pane with no row to show for it.
  const revealListed = useCallback((id: string) => sessionsById.has(id), [sessionsById])
  // `orderedIds` is the model's own flattened render order, already excluding
  // the members of a collapsed folder or group — the same array the desktop
  // sidebar asks.
  const revealVisible = useCallback((id: string) => orderedIds.includes(id), [orderedIds])
  const revealSteps = useCallback(
    (id: string): ConversationRevealStep[] => {
      const holder = sections.find(
        (section) =>
          (section.kind === "folder" || section.kind === "group") &&
          section.collapsed &&
          section.sessions.some((session) => session.id === id)
      )
      return [
        { active: view !== "active", undo: () => setView("active") },
        { active: hasSearchText, undo: clearSearch },
        { active: activeFilterCount > 0, undo: resetConversationFilters },
        {
          active: holder != null,
          undo: () => {
            if (holder?.kind === "folder") toggleFolder(holder.folder.id)
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
      hasSearchText,
      clearSearch,
      activeFilterCount,
      resetConversationFilters,
      toggleFolder,
      setGroupCollapsed,
    ]
  )
  useConversationReveal({
    activeSessionId,
    listed: revealListed,
    visible: revealVisible,
    steps: revealSteps,
  })

  const items = useMemo(
    () =>
      buildMobileChannelListItems({
        sections,
        narrowed: searching || activeFilterCount > 0,
        truncated: contentTruncated && searching,
        pending: filteredCount === 0 && contentPending,
        empty: filteredCount === 0 && !contentPending,
      }),
    [sections, searching, activeFilterCount, contentTruncated, filteredCount, contentPending]
  )

  // ---- Row state and actions ---------------------------------------------

  const [actionsId, setActionsId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [handoffId, setHandoffId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const actionsSession = actionsId ? (sessionsById.get(actionsId) ?? null) : null
  const deleteSession = deleteId ? (sessionsById.get(deleteId) ?? null) : null
  const handoffSession = handoffId ? (sessionsById.get(handoffId) ?? null) : null
  const renaming = renamingId && sessionsById.has(renamingId) ? renamingId : null

  /**
   * Run one row write and surface its failure. Every one of these used to be
   * fire-and-forget: a refused write (a handed-off conversation, a failed
   * Dexie transaction) became an unhandled rejection and the row simply did
   * not change.
   */
  const runWrite = useCallback(
    async (
      op: ActionFailure,
      session: ChatSession,
      write: () => void | Promise<void>
    ): Promise<boolean> => {
      if (session.handoffLock && op !== "markRead") {
        toast.error(t("actionLocked"))
        return false
      }
      try {
        await write()
        return true
      } catch (error) {
        const locked = isSessionHandoffLocked(error)
        log.warn("mobile channel action failed", {
          op,
          sessionId: session.id,
          locked,
          error: error instanceof Error ? error.message : String(error),
        })
        if (locked) toast.error(t("actionLocked"))
        else
          toast.error(t(`actionFailed.${op}`), {
            description: error instanceof Error ? error.message : String(error),
          })
        return false
      }
    },
    [t]
  )

  const togglePin = useCallback(
    async (session: ChatSession) => {
      const next = !session.pinned
      if (await runWrite(next ? "pin" : "unpin", session, () => onSetPinned([session.id], next))) {
        toast.success(tBulk(next ? "pinSuccess" : "unpinSuccess", { count: 1 }))
      }
    },
    [runWrite, onSetPinned, tBulk]
  )
  const unarchive = useCallback(
    async (session: ChatSession) => {
      if (await runWrite("unarchive", session, () => onUnarchive(session.id))) {
        toast.success(tBulk("unarchiveSuccess", { count: 1 }))
      }
    },
    [runWrite, onUnarchive, tBulk]
  )
  const toggleArchive = useCallback(
    async (session: ChatSession) => {
      if (session.archivedAt != null) {
        await unarchive(session)
        return
      }
      if (await runWrite("archive", session, () => onArchive(session.id))) {
        // The row leaves the active view, so the way back is offered right here.
        toast.success(tBulk("archiveSuccess", { count: 1 }), {
          action: { label: t("undo"), onClick: () => void unarchive(session) },
        })
      }
    },
    [runWrite, onArchive, unarchive, tBulk, t]
  )
  const moveToFolder = useCallback(
    async (session: ChatSession, folderId: string | null) => {
      if (await runWrite("move", session, () => onAssignToFolder(session.id, folderId))) {
        toast.success(tBulk("moveSuccess", { count: 1 }))
      }
    },
    [runWrite, onAssignToFolder, tBulk]
  )
  const markRead = useCallback(
    (session: ChatSession) => void runWrite("markRead", session, () => markSessionRead(session.id)),
    [runWrite]
  )
  const confirmDelete = useCallback(
    (session: ChatSession) => {
      setDeleteId(null)
      void runWrite("delete", session, () => onDelete(session.id))
    },
    [runWrite, onDelete]
  )
  const commitRename = useCallback(
    (id: string, title: string) => {
      setRenamingId(null)
      const session = sessionsById.get(id)
      if (session) void runWrite("rename", session, () => onRename(id, title))
    },
    [sessionsById, runWrite, onRename]
  )

  // Rows get id-taking callbacks whose identity never changes, read through a
  // ref that is refreshed after every commit. A callback that closed over the
  // session map would change on every session write and re-render every
  // memoized row on screen for a change to one of them.
  const latest = useRef({ onSelect, sessionsById, togglePin, toggleArchive, commitRename })
  useEffect(() => {
    latest.current = { onSelect, sessionsById, togglePin, toggleArchive, commitRename }
  })
  const handleRowSelect = useCallback((id: string) => latest.current.onSelect(id), [])
  const handleOpenActions = useCallback((id: string) => setActionsId(id), [])
  const handleSwipeAction = useCallback((id: string, action: MobileChannelSwipeActionId) => {
    const session = latest.current.sessionsById.get(id)
    if (!session) return
    if (action === "more") setActionsId(id)
    else if (action === "delete") setDeleteId(id)
    else if (action === "pin") void latest.current.togglePin(session)
    else void latest.current.toggleArchive(session)
  }, [])
  const handleCommitRename = useCallback(
    (id: string, title: string) => latest.current.commitRename(id, title),
    []
  )
  const handleCancelRename = useCallback(
    (id: string) => setRenamingId((current) => (current === id ? null : current)),
    []
  )

  // ---- Rendering -----------------------------------------------------------

  const groupAxis: ConversationGroupAxis | null =
    !searching && (groupBy === "workspace" || groupBy === "agent" || groupBy === "team")
      ? groupBy
      : null
  const rowSettings = useMemo<MobileChannelRowSettings>(
    () => ({
      density,
      showPreview,
      showTimestamps,
      showCustomIcons,
      metadataFields,
      defaultModel,
      defaultProvider,
      groupAxis,
    }),
    [
      density,
      showPreview,
      showTimestamps,
      showCustomIcons,
      metadataFields,
      defaultModel,
      defaultProvider,
      groupAxis,
    ]
  )

  const actionsHintId = useId()
  const archived = view === "archived"

  const renderItem = useCallback(
    (item: MobileChannelListItem): ReactNode => {
      switch (item.kind) {
        case "notice":
          if (item.notice === "truncated") {
            return (
              <p
                className="px-4 pt-2 pb-1 text-center text-[11px] text-muted-foreground"
                role="status"
                data-testid="mobile-channel-search-truncated"
              >
                {t("searchTruncated")}
              </p>
            )
          }
          if (item.notice === "pending") {
            // Message hits land a beat after the title hits. Saying "nothing
            // matched" here and then filling the list contradicts itself.
            return (
              <p
                className="px-4 py-8 text-center text-xs text-muted-foreground"
                role="status"
                data-testid="mobile-channel-search-pending"
              >
                {t("searchingMessages")}
              </p>
            )
          }
          return (
            <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground" data-testid="mobile-channel-empty">
                {searching
                  ? t("emptyFiltered", { query })
                  : activeFilters > 0
                    ? // Distinct from "you have no chats": the exit here is
                      // dropping a filter, not starting a conversation.
                      t("emptyFilters", { count: activeFilters })
                    : archived
                      ? t("emptyArchived")
                      : t("emptyChats")}
              </p>
              {activeFilters > 0 && !searching ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  onClick={resetConversationFilters}
                  data-testid="mobile-channel-clear-filters"
                >
                  {tFilters("clearAll")}
                </Button>
              ) : null}
            </div>
          )
        case "folder-empty":
          return (
            <p
              className="py-2 pr-3 pl-10 text-xs text-muted-foreground"
              data-testid={`mobile-channel-folder-empty-${item.folderId}`}
            >
              {t("folderEmpty")}
            </p>
          )
        case "header":
          return (
            <SectionHeader
              item={item}
              label={sectionLabel(item, t)}
              countLabel={t("sectionCount", { count: item.count })}
              onToggleFolder={toggleFolder}
              onToggleGroup={setGroupCollapsed}
            />
          )
        case "row": {
          const session = item.session
          return (
            <MobileChannelRow
              session={session}
              active={session.id === activeSessionId}
              unread={showUnreadBadges ? (unreadCountById.get(session.id) ?? 0) : 0}
              contentMatch={contentOnlyIds.has(session.id)}
              character={session.characterId ? characterById.get(session.characterId) : undefined}
              team={session.teamId ? teamById.get(session.teamId) : undefined}
              workspaceName={session.projectId ? workspaceNameById.get(session.projectId) : undefined}
              settings={rowSettings}
              renaming={renaming === session.id}
              actionsHintId={actionsHintId}
              onSelect={handleRowSelect}
              onOpenActions={handleOpenActions}
              onSwipeAction={handleSwipeAction}
              onCommitRename={handleCommitRename}
              onCancelRename={handleCancelRename}
              now={dayNow}
            />
          )
        }
      }
    },
    [
      t,
      tFilters,
      searching,
      query,
      activeFilters,
      archived,
      resetConversationFilters,
      toggleFolder,
      setGroupCollapsed,
      activeSessionId,
      showUnreadBadges,
      unreadCountById,
      contentOnlyIds,
      characterById,
      teamById,
      workspaceNameById,
      rowSettings,
      renaming,
      actionsHintId,
      handleRowSelect,
      handleOpenActions,
      handleSwipeAction,
      handleCommitRename,
      handleCancelRename,
      dayNow,
    ]
  )

  const estimateSize = useCallback(
    (item: MobileChannelListItem) => estimateItemSize(item, rowSettings),
    [rowSettings]
  )

  return (
    <div
      // `min-w-0` + `flex-1`: this column sits in a flex row beside the guild
      // rail and must take the width it is given, not its content's.
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col"
      data-testid="mobile-channel-list"
    >
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-3 pt-2 pb-1">
        <div className="flex min-w-0 items-center gap-2">
          <MobileChannelSearchField />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onNewDirect}
            aria-label={tShell("newChat")}
            data-testid="mobile-channel-new"
            className="size-11 shrink-0"
          >
            <PlusIcon className="size-5" />
          </Button>
        </div>
        <div className="flex min-w-0 items-center gap-1">
          <ViewTabs view={view} onChange={setView} />
          {/* Same pair as the desktop sidebar, in the same order: reach, then
              narrowing. */}
          <ConversationSearchScopeControl
            model={filterController}
            triggerClassName="size-11 shrink-0"
            testId="mobile-channel-search-scope"
          />
          <ConversationFilterMenu
            model={filterController}
            triggerClassName="size-11"
            testId="mobile-channel-filter"
          />
        </div>
      </div>

      <ConversationFilterChips
        model={filterController}
        // Rows on screen, not rows that survived the filters — same contract as
        // the desktop sidebar.
        shown={visibleCount}
        total={total}
        className="shrink-0 border-b border-border px-3 py-1.5"
        testId="mobile-channel-filter-chips"
      />

      <p id={actionsHintId} className="sr-only">
        {t("rowActionsHint")}
      </p>

      <LoadingRegion
        loading={isLoadingSessions}
        label={t("loadingChats")}
        className="flex min-h-0 flex-1 flex-col"
        fallback={<ChannelListSkeleton density={density} />}
      >
        {isLoadingSessions ? null : (
          <VirtualItems
            items={items}
            renderItem={renderItem}
            estimateSize={estimateSize}
            scrollMemory={scrollMemory}
            activeSessionId={activeSessionId}
            keepMountedId={renaming}
          />
        )}
      </LoadingRegion>

      <MobileChannelRowActions
        session={actionsSession}
        unread={actionsSession ? (unreadCountById.get(actionsSession.id) ?? 0) : 0}
        folders={folders}
        onClose={() => setActionsId(null)}
        onRename={(session) => setRenamingId(session.id)}
        onTogglePin={(session) => void togglePin(session)}
        onMarkRead={markRead}
        onToggleArchive={(session) => void toggleArchive(session)}
        onMoveToFolder={(session, folderId) => void moveToFolder(session, folderId)}
        onContinueOnDevice={(session) => setHandoffId(session.id)}
        onDelete={(session) => setDeleteId(session.id)}
      />
      <MobileChannelDeleteConfirm
        session={deleteSession}
        onCancel={() => setDeleteId(null)}
        onConfirm={confirmDelete}
      />
      {/* Mounted only while open: the dialog holds live queries over paired
          devices, handoff tickets and the dispatch queue. */}
      {handoffSession ? (
        <ThreadHandoffSourceDialog
          session={handoffSession}
          open
          onOpenChange={(open) => {
            if (!open) setHandoffId(null)
          }}
        />
      ) : null}
    </div>
  )
}

function sectionLabel(
  item: Extract<MobileChannelListItem, { kind: "header" }>,
  t: (key: string) => string
): string {
  const section = item.section
  switch (section.kind) {
    case "pinned":
      return t("pinned")
    case "date":
      return t(BUCKET_LABEL_KEY[section.bucket])
    case "recent":
      return t("recent")
    case "search":
      return t("results")
    case "folder":
      return section.folder.name
    case "group":
      return section.group.id === UNGROUPED_ID
        ? t(CONVERSATION_UNGROUPED_LABEL_KEY[section.axis])
        : section.group.name
  }
}

/** Header test ids, kept from the sectioned list so the seams stay stable. */
function headerTestId(item: Extract<MobileChannelListItem, { kind: "header" }>): string {
  const section = item.section
  switch (section.kind) {
    case "pinned":
      return "mobile-channel-pinned"
    case "date":
      return `mobile-channel-bucket-${section.bucket}`
    case "recent":
      return "mobile-channel-recent"
    case "search":
      return "mobile-channel-results"
    case "folder":
      return `mobile-channel-folder-${section.folder.id}`
    case "group":
      return `mobile-channel-group-${item.sectionKey}`
  }
}

function SectionHeader({
  item,
  label,
  countLabel,
  onToggleFolder,
  onToggleGroup,
}: {
  item: Extract<MobileChannelListItem, { kind: "header" }>
  label: string
  countLabel: string
  onToggleFolder: (folderId: string) => void
  onToggleGroup: (key: string, collapsed: boolean) => void
}) {
  const section = item.section
  const count = (
    <>
      <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground tabular-nums" aria-hidden>
        {item.count}
      </span>
      <span className="sr-only">{countLabel}</span>
    </>
  )
  const text = (
    <span className="min-w-0 truncate text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      {label}
    </span>
  )

  if (section.kind === "folder" || section.kind === "group") {
    const Icon = section.kind === "folder" ? FolderIcon : CONVERSATION_GROUP_AXIS_ICON[section.axis]
    const expanded = !section.collapsed
    return (
      <button
        type="button"
        onClick={() =>
          section.kind === "folder"
            ? onToggleFolder(section.folder.id)
            : onToggleGroup(item.sectionKey, !section.collapsed)
        }
        aria-expanded={expanded}
        data-testid={headerTestId(item)}
        className="flex min-h-11 w-full min-w-0 items-center gap-1.5 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-accent/60"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            expanded && "rotate-90"
          )}
        />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {text}
        {count}
      </button>
    )
  }
  return (
    <h2
      className="flex h-8 min-w-0 items-end px-3 pb-1"
      data-testid={headerTestId(item)}
    >
      {text}
      {count}
    </h2>
  )
}

function ViewTabs({
  view,
  onChange,
}: {
  view: ChannelListView
  onChange: (next: ChannelListView) => void
}) {
  const t = useTranslations("mobile.home")
  const options: { value: ChannelListView; label: string; hint: string; Icon: typeof ArchiveIcon }[] =
    [
      {
        value: "active",
        label: t("viewTabActive"),
        hint: t("viewActive"),
        Icon: MessagesSquareIcon,
      },
      {
        value: "archived",
        label: t("viewTabArchived"),
        hint: t("viewArchived"),
        Icon: ArchiveIcon,
      },
    ]
  const refs = useRef<Record<ChannelListView, HTMLButtonElement | null>>({
    active: null,
    archived: null,
  })
  return (
    <div
      role="radiogroup"
      aria-label={t("viewTabsLabel")}
      className="flex h-10 min-w-0 flex-1 items-center gap-0.5 rounded-lg bg-muted p-0.5"
      data-testid="mobile-channel-view-tabs"
      onKeyDown={(e) => {
        // Radio-group keys: the arrows move the choice and the focus together.
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return
        e.preventDefault()
        const next: ChannelListView = view === "active" ? "archived" : "active"
        onChange(next)
        refs.current[next]?.focus()
      }}
    >
      {options.map(({ value, label, hint, Icon }) => {
        const checked = view === value
        return (
          <button
            key={value}
            ref={(el) => {
              refs.current[value] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            title={hint}
            onClick={() => onChange(value)}
            data-testid={`mobile-channel-view-${value}`}
            className={cn(
              // Painted at 36px inside the 40px track; `touch-hit` extends the
              // hit area to the 44px floor on a touch screen.
              "touch-hit flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
              checked
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground active:bg-background/60"
            )}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{label}</span>
          </button>
        )
      })}
    </div>
  )
}

function ChannelListSkeleton({ density }: { density: ConversationSidebarDensity }) {
  const compact = density === "compact"
  return (
    <div className="flex flex-col py-1" data-testid="mobile-channel-loading">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div
          key={index}
          className={cn("flex items-center gap-3 px-3", compact ? "h-11" : "h-14")}
        >
          <Skeleton className={cn("shrink-0 rounded-full", compact ? "size-8" : "size-10")} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** First-paint size guess per item; real sizes are measured once mounted. */
function estimateItemSize(item: MobileChannelListItem, settings: MobileChannelRowSettings): number {
  switch (item.kind) {
    case "notice":
      return item.notice === "truncated" ? 32 : 96
    case "folder-empty":
      return 32
    case "header":
      return item.section.kind === "folder" || item.section.kind === "group" ? 44 : 32
    case "row": {
      const compact = settings.density === "compact"
      let size = compact ? 44 : 56
      if (settings.metadataFields.length > 0) size += 16
      if (settings.showPreview && item.session.lastMessagePreview) size += 16
      return size
    }
  }
}

/**
 * The windowed scroll area. Its own component so a scroll frame re-renders the
 * positioned wrappers and nothing else: the rows inside are memoized, and the
 * list above does not observe the virtualizer.
 */
function VirtualItems({
  items,
  renderItem,
  estimateSize,
  scrollMemory,
  activeSessionId,
  keepMountedId,
}: {
  items: MobileChannelListItem[]
  renderItem: (item: MobileChannelListItem) => ReactNode
  estimateSize: (item: MobileChannelListItem) => number
  scrollMemory: MobileChannelScrollMemory
  activeSessionId: string | null
  /** A row that must stay mounted even when scrolled out of the window. */
  keepMountedId: string | null
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Where the drawer was left, read once per open.
  const [restored] = useState(() => scrollMemory.read())
  const keepMountedIndex = keepMountedId ? findRowIndex(items, keepMountedId) : -1
  // The row being renamed holds focus and an on-screen keyboard; unmounting it
  // because the keyboard shrank the viewport would drop the edit.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range)
      if (keepMountedIndex < 0 || indexes.includes(keepMountedIndex)) return indexes
      return [...indexes, keepMountedIndex].sort((a, b) => a - b)
    },
    [keepMountedIndex]
  )
  const getItemKey = useCallback((index: number) => items[index]!.key, [items])
  const estimate = useCallback((index: number) => estimateSize(items[index]!), [items, estimateSize])
  // TanStack Virtual returns non-memoizable functions; nothing to fix here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimate,
    getItemKey,
    overscan: 8,
    rangeExtractor,
    initialOffset: restored.offset,
    initialMeasurementsCache: restored.measurements,
  })

  // Keep the measurements for the next open so the restored offset lands on
  // the same row rather than on an estimate of where it was.
  useEffect(
    () => () => scrollMemory.saveMeasurements(virtualizer.takeSnapshot()),
    [virtualizer, scrollMemory]
  )

  // Bring the open conversation into view — on open, and whenever it changes
  // while the drawer is up. `auto` alignment leaves a row that is already on
  // screen where it is, so a restored scroll position is not overridden.
  const activeIndex = activeSessionId ? findRowIndex(items, activeSessionId) : -1
  const revealedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeSessionId || activeIndex < 0) return
    if (revealedRef.current === activeSessionId) return
    revealedRef.current = activeSessionId
    virtualizer.scrollToIndex(activeIndex, { align: "auto" })
  }, [activeSessionId, activeIndex, virtualizer])

  const virtualItems = virtualizer.getVirtualItems()
  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      onScroll={(e) => scrollMemory.saveOffset(e.currentTarget.scrollTop)}
      data-mobile-channel-scroll=""
      data-testid="mobile-channel-scroll"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((virtualItem) => {
          const item = items[virtualItem.index]!
          return (
            <div
              key={virtualItem.key}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              data-item-kind={item.kind}
              data-section={
                item.kind === "row" || item.kind === "header" ? item.sectionKey : undefined
              }
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${virtualItem.start}px)` }}
            >
              {renderItem(item)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
