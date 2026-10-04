// View state of the conversation manager page (`/conversations`, ADR-0213).
//
// The page keeps its own sort, quick filters, selected saved view and message
// search switch, persisted per device — narrowing a management table must not
// narrow the conversation sidebar behind it, so none of this is the sidebar's
// UI-store state. The saved view *definitions* stay shared (they ride in the
// settings blob). The tab is session state, set by the page and its `?tab=`
// deep link.

import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { ConversationFilters, ConversationSortBy } from "@cognia/agent-config-types"

import {
  DEFAULT_CONVERSATION_SORT_BY,
  resolveConversationFilters,
} from "@/lib/chat/conversation-filters"
import type { ConversationManagerTab } from "@/lib/conversations/conversation-manager"
import { persistLocalStorage } from "@/stores/persist-storage"

interface ConversationManagerState {
  // Persisted preferences
  sortBy: ConversationSortBy
  filters: ConversationFilters
  activeViewId: string | null
  /** Let the search field reach message content, not only titles. */
  searchContent: boolean

  // Session state
  tab: ConversationManagerTab

  setSortBy: (sortBy: ConversationSortBy) => void
  setFilters: (filters: ConversationFilters) => void
  resetFilters: () => void
  setActiveViewId: (id: string | null) => void
  setSearchContent: (enabled: boolean) => void
  setTab: (tab: ConversationManagerTab) => void
}

export const useConversationManagerStore = create<ConversationManagerState>()(
  persist(
    (set) => ({
      sortBy: DEFAULT_CONVERSATION_SORT_BY,
      filters: resolveConversationFilters(undefined),
      activeViewId: null,
      searchContent: false,

      tab: "active",

      setSortBy: (sortBy) => set({ sortBy }),
      // Normalized on write, like the sidebar's store, so a partial (or a blob
      // from an older build) never leaves an unreadable field behind.
      setFilters: (filters) => set({ filters: resolveConversationFilters(filters) }),
      resetFilters: () =>
        set({ filters: resolveConversationFilters(undefined), activeViewId: null }),
      setActiveViewId: (activeViewId) => set({ activeViewId }),
      setSearchContent: (searchContent) => set({ searchContent }),
      setTab: (tab) => set({ tab }),
    }),
    {
      name: "conversation-manager-prefs",
      version: 1,
      storage: persistLocalStorage(),
      partialize: (s) => ({
        sortBy: s.sortBy,
        filters: s.filters,
        activeViewId: s.activeViewId,
        searchContent: s.searchContent,
      }),
    }
  )
)
