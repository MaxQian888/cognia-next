"use client"

/**
 * Everything the conversation manager page (`/conversations`, ADR-0213)
 * renders and does, assembled from the pieces the conversation lists already
 * share — nothing here re-implements a list rule:
 *
 * - rows: `useSessions({ crossWorkspace: true })` (exposed, deduped, every
 *   workspace — a history manager is not scoped to the open workspace; the
 *   Workspace facet narrows it), cut by tab and ordered by the shared list
 *   model in its `flat` mode;
 * - filters, sort and saved views: the shared filter controller, with this
 *   page's own state owner (`useConversationManagerStore`), so narrowing the
 *   table never narrows the sidebar; saved view definitions stay the profile's;
 * - search: the same title ranker, plus the message-content index on request;
 * - writes: `useConversationRowActions` over `useSessions`' routed writers —
 *   the handoff gate, the toasts, Undo and telemetry the lists have;
 * - row decorations (avatar, agent, model, workspace): `createRowDecorations`.
 *
 * The page is not the chat: no write here opens "the next conversation" after
 * a removal (`activeSessionId: null`), and opening a row navigates through the
 * session link (`SessionLinkConsumer` switches workspace and activates it).
 */

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useRouter } from "next/navigation"
import { useTimeZone } from "next-intl"
import type {
  Character,
  ChatSession,
  ConversationSidebarSettings,
} from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"

import { createRowDecorations } from "@/components/desktop/channel-list/row-decorations"
import { useConversationFilterController } from "@/hooks/chat/use-conversation-filter-controller"
import {
  useConversationDayClock,
  useConversationListModel,
} from "@/hooks/chat/use-conversation-list-model"
import { useConversationRowActions } from "@/hooks/chat/use-conversation-row-actions"
import { useChatHistorySearch } from "@/hooks/chat/use-chat-history-search"
import { useSessionModelLanes, recordedRuntimeRef } from "@/hooks/chat/use-session-model-lanes"
import { useSessionRunStatusMap } from "@/hooks/chat/use-session-run-status-map"
import { useSessions } from "@/hooks/chat/use-sessions"
import { useClientLiveQuery } from "@/hooks/data"
import { useOrderedTeams } from "@/hooks/shell/use-ordered-teams"
import { inFlightIdSet } from "@/lib/chat/aggregate-run-state"
import { branchWholeConversation } from "@/lib/chat/branch-whole-conversation"
import { CONTENT_SEARCH_MIN_QUERY } from "@/lib/chat/conversation-search-scope"
import { buildSessionHref } from "@/lib/chat/message-permalink"
import { resolveSessionModelIdentity, sessionModelLabels } from "@/lib/chat/session-model-identity"
import {
  countConversationsByTab,
  type ConversationManagerCounts,
  type ConversationManagerTab,
} from "@/lib/conversations/conversation-manager"
import { listCharacters } from "@/lib/db/characters"
import { listSessionStates } from "@/lib/db/session-state"
import { useConversationManagerStore } from "@/stores/conversations"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"

const log = loggers.ui

const EMPTY_CHARACTERS: Character[] = []
const EMPTY_STATES: { sessionId: string; unreadCount: number }[] = []
const EMPTY_ROWS: ChatSession[] = []

/** The columns the table reads beside the title. */
const MANAGER_METADATA = ["agent", "model", "workspace"] as const

export function useConversationManager({ query }: { query: string }) {
  const router = useRouter()
  const tab = useConversationManagerStore((s) => s.tab)
  const setTab = useConversationManagerStore((s) => s.setTab)
  const sortBy = useConversationManagerStore((s) => s.sortBy)
  const setSortBy = useConversationManagerStore((s) => s.setSortBy)
  const searchContent = useConversationManagerStore((s) => s.searchContent)
  const setSearchContent = useConversationManagerStore((s) => s.setSearchContent)
  const storedFilters = useConversationManagerStore((s) => s.filters)
  const setFilters = useConversationManagerStore((s) => s.setFilters)
  const resetFilters = useConversationManagerStore((s) => s.resetFilters)
  const activeViewId = useConversationManagerStore((s) => s.activeViewId)
  const setActiveViewId = useConversationManagerStore((s) => s.setActiveViewId)

  const {
    sessions,
    folders,
    isLoadingSessions,
    remove,
    rename,
    bulkRemove,
    bulkSetPinned,
    archive,
    unarchive,
    bulkArchive,
    bulkUnarchive,
    assignToFolder,
    bulkAssignToFolder,
  } = useSessions({ crossWorkspace: true })
  const characters = useClientLiveQuery<Character[]>(() => listCharacters(), [], EMPTY_CHARACTERS)
  const sessionStates = useClientLiveQuery(() => listSessionStates(), [], EMPTY_STATES)
  const { teams } = useOrderedTeams()
  const projects = useProjectStore((s) => s.projects)
  const runStatusById = useSessionRunStatusMap()
  const requestChatHome = useUIStore((s) => s.requestChatHome)

  // The profile's sidebar settings, with this page's own sort and search reach
  // laid over them: the controller reads sort, grouping and reach from one
  // blob, and the page must neither follow the sidebar's nor move it.
  const sidebarSettings = useSettingsStore((s) => s.settings?.conversationSidebar)
  const saveSettings = useSettingsStore((s) => s.save)
  const sidebarSettingsRef = useRef(sidebarSettings)
  useEffect(() => {
    sidebarSettingsRef.current = sidebarSettings
  }, [sidebarSettings])
  const pageSettings = useMemo<ConversationSidebarSettings>(
    () => ({
      ...(sidebarSettings ?? {}),
      sortBy,
      // A history manager reaches every workspace (the facet narrows it) and
      // splits the archive by tab, so only the content switch is the page's.
      search: { workspace: "all", includeArchived: false, content: searchContent },
    }),
    [sidebarSettings, sortBy, searchContent]
  )
  const savePageSettings = useCallback(
    (patch: Partial<ConversationSidebarSettings>) => {
      // Grouping does not apply to a flat table; the page's own fields stay
      // here; anything else (saved views, hidden built-ins) is the profile's.
      const { sortBy: nextSort, search, groupBy: _groupBy, ...shared } = patch
      if (nextSort) setSortBy(nextSort)
      if (search && typeof search.content === "boolean") setSearchContent(search.content)
      if (Object.keys(shared).length > 0) {
        void saveSettings({ conversationSidebar: { ...sidebarSettingsRef.current, ...shared } })
      }
    },
    [saveSettings, setSortBy, setSearchContent]
  )
  const filterState = useMemo(
    () => ({
      filters: storedFilters,
      setFilters,
      reset: resetFilters,
      activeViewId,
      setActiveViewId,
    }),
    [storedFilters, setFilters, resetFilters, activeViewId, setActiveViewId]
  )

  const workspaceGroups = useMemo(
    () => projects.map((project) => ({ id: project.id, name: project.name })),
    [projects]
  )
  const workspaceNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  )
  const teamGroups = useMemo(
    () => (teams ?? []).map((team) => ({ id: team.id, name: team.name })),
    [teams]
  )
  const tabSessions = useMemo(
    () =>
      sessions.filter((session) =>
        tab === "archived" ? session.archivedAt != null : session.archivedAt == null
      ),
    [sessions, tab]
  )
  const filterController = useConversationFilterController({
    sessions: tabSessions,
    workspaces: workspaceGroups,
    folders,
    characters: characters ?? undefined,
    teams: teamGroups,
    sidebarSettings: pageSettings,
    saveSidebarSettings: savePageSettings,
    filterState,
  })
  const { filters, filterContext } = filterController

  const unreadCountById = useMemo(() => {
    const counts = new Map<string, number>()
    for (const state of sessionStates ?? EMPTY_STATES) {
      if (state.unreadCount > 0) counts.set(state.sessionId, state.unreadCount)
    }
    return counts
  }, [sessionStates])
  const unreadIds = useMemo(() => new Set(unreadCountById.keys()), [unreadCountById])
  const runningIds = useMemo(() => inFlightIdSet(runStatusById), [runStatusById])

  const contentSearch = useChatHistorySearch(query, {
    enabled: searchContent,
    includeArchived: tab === "archived",
    collapseBySession: true,
    limit: 200,
  })
  const trimmed = query.trim()
  const contentMatchIds = useMemo<ReadonlySet<string> | undefined>(() => {
    if (!searchContent || trimmed.length < CONTENT_SEARCH_MIN_QUERY) return undefined
    return new Set(contentSearch.results.map((result) => result.sessionId))
  }, [searchContent, trimmed, contentSearch.results])

  const timeZone = useTimeZone()
  const dayNow = useConversationDayClock(timeZone)
  const model = useConversationListModel({
    sessions,
    query,
    view: tab,
    now: dayNow,
    timeZone,
    sortBy,
    filters,
    unreadIds,
    runningIds: filters.running ? runningIds : undefined,
    filterContext,
    contentMatchIds,
    flat: true,
  })
  const rows = model.sections[0]?.sessions ?? EMPTY_ROWS
  const counts = useMemo<ConversationManagerCounts>(
    () => countConversationsByTab(sessions),
    [sessions]
  )
  // Every archived conversation, whatever the filters show — what "Empty
  // archive" deletes and says it deletes.
  const archivedSessions = useMemo(
    () => sessions.filter((session) => session.archivedAt != null && session.kind !== "subagent"),
    [sessions]
  )

  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions]
  )
  const sessionsByIdRef = useRef(sessionsById)
  useEffect(() => {
    sessionsByIdRef.current = sessionsById
  }, [sessionsById])
  const resolveSessions = useCallback(
    (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const session = sessionsByIdRef.current.get(id)
        return session ? [session] : []
      }),
    []
  )

  const openConversation = useCallback(
    (id: string) => {
      log.info("conversation manager open conversation")
      router.push(`/${buildSessionHref(id)}`)
    },
    [router]
  )
  const startConversation = useCallback(() => {
    log.info("conversation manager new chat")
    requestChatHome({ kind: "dm" })
    router.push("/")
  }, [requestChatHome, router])

  const { rowActions, extraActions, exportSessionId, closeExport } = useConversationRowActions({
    onDelete: remove,
    onRename: rename,
    onTogglePinned: (id, pinned) => bulkSetPinned([id], pinned),
    onArchive: archive,
    onUnarchive: unarchive,
    onBulkDelete: bulkRemove,
    onBulkSetPinned: bulkSetPinned,
    onBulkArchive: bulkArchive,
    onBulkUnarchive: bulkUnarchive,
    onAssignToFolder: assignToFolder,
    onBulkAssignToFolder: bulkAssignToFolder,
    onBranch: branchWholeConversation,
    resolveSessions,
    // A management table, not the chat: nothing opens in a removed row's place.
    activeSessionId: null,
    onSelect: openConversation,
  })

  const { sessionRuntimeRefs, defaultRuntimeRef, agentNameOf } = useSessionModelLanes()
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const showCustomIcons = sidebarSettings?.showCustomIcons ?? true
  const characterById = useMemo(
    () => new Map((characters ?? EMPTY_CHARACTERS).map((character) => [character.id, character])),
    [characters]
  )
  const teamById = useMemo(() => new Map((teams ?? []).map((team) => [team.id, team])), [teams])
  const decorations = useMemo(
    () =>
      createRowDecorations({
        characterById,
        teamById,
        workspaceNameById,
        metadataFields: MANAGER_METADATA,
        showCustomIcons,
        merged: false,
        modelLabelsOf: (session, character) =>
          sessionModelLabels(
            resolveSessionModelIdentity(session, {
              character,
              sessionRuntimeRef: recordedRuntimeRef(sessionRuntimeRefs, session.id),
              defaultRuntimeRef,
              defaultModel,
              defaultProvider,
              agentNameOf,
            })
          ),
      }),
    [
      characterById,
      teamById,
      workspaceNameById,
      showCustomIcons,
      sessionRuntimeRefs,
      defaultRuntimeRef,
      defaultModel,
      defaultProvider,
      agentNameOf,
    ]
  )

  return {
    tab,
    setTab,
    loading: isLoadingSessions,
    counts,
    rows,
    model,
    filterController,
    sortBy,
    setSortBy,
    searchContent,
    setSearchContent,
    content: {
      belowMinQuery:
        searchContent && trimmed.length > 0 && trimmed.length < CONTENT_SEARCH_MIN_QUERY,
      pending: searchContent && contentSearch.loading && trimmed.length > 0,
      failed: searchContent && contentSearch.error !== null && trimmed.length > 0,
      truncated:
        trimmed.length > 0 && (contentSearch.moreOlderHistory || contentSearch.indexIncomplete),
    },
    sessions,
    archivedSessions,
    folders,
    unreadIds,
    unreadCountById,
    runStatusById,
    decorations,
    workspaceNameById,
    rowActions,
    extraActions,
    exportSession: exportSessionId ? (sessionsById.get(exportSessionId) ?? null) : null,
    closeExport,
    openConversation,
    startConversation,
  }
}

export type ConversationManagerData = ReturnType<typeof useConversationManager>
export type { ConversationManagerTab }
