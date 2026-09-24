"use client"

/**
 * Long-lived data and state behind the mobile conversation list.
 *
 * The list lives inside the navigation drawer, and Radix unmounts a closed
 * `SheetContent`. Everything the list read for itself therefore started over
 * on every open: the `characters` Dexie-first read kicked a sync pull (which
 * bypasses the orchestrator's re-entrancy gate), two live queries re-subscribed
 * and rendered twice on the way in, the message-search index scheduled another
 * drain, and the scroll position and search box reset to empty.
 *
 * This provider is mounted by the shell next to the drawer, outside its
 * content, so all of that survives the drawer closing:
 *
 *   - `characters` (passed in: the shell already reads them for its header),
 *     `teams` and per-session unread state, live;
 *   - the search box (immediate text) and the debounced query the grouping
 *     model and the message-content search consume;
 *   - the message-content search itself;
 *   - the list's scroll offset and row measurements, so reopening the drawer
 *     lands where the user left it.
 *
 * Two contexts, not one. The search field subscribes to the immediate text,
 * which changes on every keystroke; the list subscribes to the rest, which
 * changes only once the debounce settles. Typing re-renders the field and
 * nothing else.
 *
 * `MobileChannelListStandaloneSource` is the same provider for a list rendered
 * without the shell (Storybook, isolated tests): it performs the `characters`
 * read the shell would otherwise hand in.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import type { VirtualItem } from "@tanstack/react-virtual"

import { useClientLiveQuery, useDexieFirstQuery } from "@/hooks/data"
import {
  useChatHistorySearch,
  type UseChatHistorySearchResult,
} from "@/hooks/chat/use-chat-history-search"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { resolveConversationGroupBy } from "@/lib/chat/conversation-grouping"
import {
  needsCrossWorkspaceSessions,
  resolveConversationSearchOptions,
} from "@/lib/chat/conversation-search-scope"
import { listCharacters } from "@/lib/db/characters"
import { listSessionStates, type SessionStateRow } from "@/lib/db/session-state"
import { listTeams } from "@/lib/db/teams"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import type { Character, Team } from "@cognia/agent-config-types"

/** Debounce between the search box and the (O(n log n)) grouping model. */
export const MOBILE_CHANNEL_SEARCH_DEBOUNCE_MS = 150

/** Row cap for the message-content search — the same cap the desktop uses. */
const CONTENT_SEARCH_LIMIT = 200

const EMPTY_CHARACTERS: readonly Character[] = []
const EMPTY_TEAMS: readonly Team[] = []
const EMPTY_STATES: readonly SessionStateRow[] = []

export interface MobileChannelScrollSnapshot {
  /** `scrollTop` of the list when the drawer last closed. */
  offset: number
  /** Measured row sizes (`Virtualizer.takeSnapshot()`), so restoring is exact. */
  measurements: VirtualItem[]
}

/**
 * Where the list was scrolled to. Imperative on purpose: writing it happens on
 * every scroll frame, and nothing on screen depends on it until the next open,
 * so it must not be React state.
 */
export interface MobileChannelScrollMemory {
  read: () => MobileChannelScrollSnapshot
  saveOffset: (offset: number) => void
  saveMeasurements: (measurements: VirtualItem[]) => void
}

export function createMobileChannelScrollMemory(): MobileChannelScrollMemory {
  let snapshot: MobileChannelScrollSnapshot = { offset: 0, measurements: [] }
  return {
    read: () => snapshot,
    saveOffset: (offset) => {
      snapshot = { ...snapshot, offset: Math.max(0, offset) }
    },
    saveMeasurements: (measurements) => {
      snapshot = { ...snapshot, measurements }
    },
  }
}

export interface MobileChannelListSource {
  characters: readonly Character[]
  teams: readonly Team[]
  sessionStates: readonly SessionStateRow[]
  /** Debounced search text — what the grouping model filters by. */
  query: string
  /**
   * The box holds text, debounced or not. Flips only on empty ⇄ non-empty, so
   * the list can ask "is a search narrowing me?" without subscribing to every
   * keystroke.
   */
  hasSearchText: boolean
  clearSearch: () => void
  contentSearch: UseChatHistorySearchResult
  scrollMemory: MobileChannelScrollMemory
}

export interface MobileChannelSearchField {
  value: string
  onChange: (next: string) => void
  onClear: () => void
}

const SourceContext = createContext<MobileChannelListSource | null>(null)
const SearchFieldContext = createContext<MobileChannelSearchField | null>(null)

export interface MobileChannelListSourceProviderProps {
  /** Characters, read once by the owner (the shell reads them for its header). */
  characters: readonly Character[] | undefined
  children: ReactNode
}

export function MobileChannelListSourceProvider({
  characters,
  children,
}: MobileChannelListSourceProviderProps) {
  // Teams feed the `team` grouping axis and the team filter facet; unread
  // state feeds the unread filter/sort and the row badges.
  const teams = useClientLiveQuery<readonly Team[]>(() => listTeams(), [], EMPTY_TEAMS)
  const sessionStates = useClientLiveQuery<readonly SessionStateRow[]>(
    () => listSessionStates(),
    [],
    EMPTY_STATES
  )

  // Search box: the field value is immediate, the value fed to the grouping
  // model is debounced so typing doesn't re-bucket on every keystroke (mirrors
  // the desktop sidebar).
  const [input, setInput] = useState("")
  const [query, setQuery] = useState("")
  const { call: debouncedSetQuery, cancel: cancelDebouncedQuery } = useDebouncedCallback(
    (next: string) => setQuery(next),
    MOBILE_CHANNEL_SEARCH_DEBOUNCE_MS
  )
  const onChange = useCallback(
    (next: string) => {
      setInput(next)
      debouncedSetQuery(next)
    },
    [debouncedSetQuery]
  )
  const clearSearch = useCallback(() => {
    setInput("")
    cancelDebouncedQuery()
    setQuery("")
  }, [cancelDebouncedQuery])

  // Same resolved reach as the desktop sidebar — one object, three axes.
  const sidebarSettings = useSettingsStore((s) => s.settings?.conversationSidebar)
  const searchOptions = useMemo(
    () => resolveConversationSearchOptions(sidebarSettings),
    [sidebarSettings]
  )
  const groupBy = resolveConversationGroupBy(sidebarSettings)
  const view = useUIStore((s) => s.channelListView)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const contentSearch = useChatHistorySearch(query, {
    enabled: searchOptions.content,
    projectId: needsCrossWorkspaceSessions(groupBy, searchOptions)
      ? undefined
      : (activeProjectId ?? undefined),
    includeArchived: searchOptions.includeArchived || view === "archived",
    collapseBySession: true,
    limit: CONTENT_SEARCH_LIMIT,
  })

  const [scrollMemory] = useState(createMobileChannelScrollMemory)

  const hasSearchText = input.length > 0 || query.length > 0
  const source = useMemo<MobileChannelListSource>(
    () => ({
      characters: characters ?? EMPTY_CHARACTERS,
      teams: teams ?? EMPTY_TEAMS,
      sessionStates: sessionStates ?? EMPTY_STATES,
      query,
      hasSearchText,
      clearSearch,
      contentSearch,
      scrollMemory,
    }),
    [
      characters,
      teams,
      sessionStates,
      query,
      hasSearchText,
      clearSearch,
      contentSearch,
      scrollMemory,
    ]
  )
  const field = useMemo<MobileChannelSearchField>(
    () => ({ value: input, onChange, onClear: clearSearch }),
    [input, onChange, clearSearch]
  )

  return (
    <SourceContext.Provider value={source}>
      <SearchFieldContext.Provider value={field}>{children}</SearchFieldContext.Provider>
    </SourceContext.Provider>
  )
}

/**
 * The provider for a list rendered outside the shell. Reads `characters` the
 * way the shell does — Dexie-first, with one sync kick for the table.
 */
export function MobileChannelListStandaloneSource({ children }: { children: ReactNode }) {
  const { data: characters } = useDexieFirstQuery<Character[]>({
    query: () => listCharacters(),
    deps: [],
    initial: [],
    table: "characters",
  })
  return (
    <MobileChannelListSourceProvider characters={characters}>{children}</MobileChannelListSourceProvider>
  )
}

/** `null` outside a provider — callers decide whether to self-provision. */
export function useOptionalMobileChannelListSource(): MobileChannelListSource | null {
  return useContext(SourceContext)
}

export function useMobileChannelListSource(): MobileChannelListSource {
  const source = useContext(SourceContext)
  if (!source) {
    throw new Error("useMobileChannelListSource must be used inside MobileChannelListSourceProvider")
  }
  return source
}

export function useMobileChannelSearchField(): MobileChannelSearchField {
  const field = useContext(SearchFieldContext)
  if (!field) {
    throw new Error(
      "useMobileChannelSearchField must be used inside MobileChannelListSourceProvider"
    )
  }
  return field
}
