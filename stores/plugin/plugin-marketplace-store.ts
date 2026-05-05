/**
 * Plugin Marketplace Store
 * Persists favorites, recently viewed, discovery query state, and user preferences.
 *
 * Uses plain objects (Record/Array) instead of Map/Set for robust JSON serialization.
 */

import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
import type { PluginSource } from "@/types/plugin"
import type {
  InstallProgressInfo,
  InstallStage,
  SortOption,
  CategoryFilter,
  QuickFilter,
} from "@/components/plugin/marketplace/components/marketplace-types"

// =============================================================================
// Types
// =============================================================================

interface UserReview {
  pluginId: string
  rating: number
  content: string
  date: string
}

export type MarketplaceSourceMode = "remote" | "degraded" | "demo"

export type MarketplaceErrorCategory =
  | "network"
  | "auth"
  | "rate_limit"
  | "validation"
  | "unsupported_env"
  | "install_conflict"
  | "unknown"

export type PluginOperationStage = "idle" | "installing" | "updating" | "installed" | "error"
export type DiscoverySourceFilter = "all" | PluginSource | "marketplace"
export type DiscoveryCompatibilityFilter = "all" | "compatible" | "warning" | "blocked"

export interface MarketplaceDiscoveryState {
  query: string
  sortBy: SortOption
  categoryFilter: CategoryFilter
  quickFilter: QuickFilter
  sourceFilter: DiscoverySourceFilter
  compatibilityFilter: DiscoveryCompatibilityFilter
  page: number
  pageSize: number
}

interface MarketplaceSourceState {
  mode: MarketplaceSourceMode
  lastFailureCategory?: MarketplaceErrorCategory
  lastErrorMessage?: string
  updatedAt?: string
}

interface PluginOperationState {
  stage: PluginOperationStage
  operationKey?: string
  targetVersion?: string
  retryCount: number
  lastErrorCategory?: MarketplaceErrorCategory
  lastErrorMessage?: string
  retryable?: boolean
  updatedAt: string
}

interface MarketplaceDiagnostic {
  operation: "search" | "detail" | "install" | "update" | "retry"
  category: MarketplaceErrorCategory
  retryable: boolean
  message: string
  pluginId?: string
  operationKey?: string
  sourceMode: MarketplaceSourceMode
  occurredAt: string
}

interface PluginMarketplaceState {
  // Favorites (stored as Record for native JSON serialization)
  favorites: Record<string, true>
  toggleFavorite: (pluginId: string) => void
  isFavorite: (pluginId: string) => boolean
  getFavoriteIds: () => string[]

  // Recently viewed
  recentlyViewed: string[]
  addRecentlyViewed: (pluginId: string) => void
  clearRecentlyViewed: () => void

  // Canonical discovery state
  discoveryState: MarketplaceDiscoveryState
  setDiscoveryQuery: (query: string) => void
  setDiscoverySort: (sortBy: SortOption) => void
  setDiscoveryCategoryFilter: (categoryFilter: CategoryFilter) => void
  setDiscoveryQuickFilter: (quickFilter: QuickFilter) => void
  setDiscoverySourceFilter: (sourceFilter: DiscoverySourceFilter) => void
  setDiscoveryCompatibilityFilter: (compatibilityFilter: DiscoveryCompatibilityFilter) => void
  setDiscoveryPage: (page: number) => void
  setDiscoveryState: (updates: Partial<MarketplaceDiscoveryState>) => void
  resetDiscoveryState: () => void

  // Marketplace source mode and diagnostics
  sourceState: MarketplaceSourceState
  setRemoteMode: () => void
  setFallbackMode: (category: MarketplaceErrorCategory, message?: string) => void
  setDemoMode: (message?: string) => void
  diagnostics: MarketplaceDiagnostic[]
  latestDiagnostic?: MarketplaceDiagnostic
  recordDiagnostic: (diagnostic: Omit<MarketplaceDiagnostic, "occurredAt" | "sourceMode">) => void
  clearDiagnostics: () => void

  // Operation state
  operationState: Record<string, PluginOperationState>
  startPluginOperation: (
    pluginId: string,
    operation: "install" | "update",
    targetVersion?: string
  ) => { operationKey: string; skipped: boolean }
  completePluginOperation: (pluginId: string) => void
  failPluginOperation: (
    pluginId: string,
    category: MarketplaceErrorCategory,
    message: string,
    retryable: boolean,
    operation?: "install" | "update"
  ) => void
  retryPluginOperation: (
    pluginId: string,
    operation: "install" | "update",
    targetVersion?: string
  ) => { operationKey: string; skipped: boolean }
  getPluginOperationState: (pluginId: string) => PluginOperationState | undefined
  getActiveOperationKey: (pluginId: string) => string | undefined

  // Install progress tracking (not persisted — transient state)
  installProgress: Record<string, InstallProgressInfo>
  setInstallProgress: (pluginId: string, progress: InstallProgressInfo) => void
  clearInstallProgress: (pluginId: string) => void
  getInstallProgress: (pluginId: string) => InstallProgressInfo | undefined
  isInstalling: (pluginId: string) => boolean

  // User reviews
  userReviews: Record<string, UserReview>
  submitReview: (pluginId: string, rating: number, content: string) => void
  getUserReview: (pluginId: string) => UserReview | undefined

  // Search history
  searchHistory: string[]
  addSearchHistory: (query: string) => void
  clearSearchHistory: () => void

  // View preferences
  viewMode: "grid" | "list"
  setViewMode: (mode: "grid" | "list") => void

  // Browse view state (preserves state across tab switches)
  browseViewState: {
    selectedPluginId: string | null
    scrollOffset: number
    detailOpen: boolean
    activeTab: string // 'browse' | 'installed' | 'favorites' | 'collections' | 'recent'
  }
  setBrowseViewState: (updates: Partial<PluginMarketplaceState["browseViewState"]>) => void

  // Comparison state
  comparisonIds: string[]
  comparisonOpen: boolean
  addToComparison: (id: string) => void
  removeFromComparison: (id: string) => void
  clearComparison: () => void
  setComparisonOpen: (open: boolean) => void

  // Reset
  reset: () => void
}

// =============================================================================
// Constants
// =============================================================================

const MAX_RECENTLY_VIEWED = 20
const MAX_SEARCH_HISTORY = 50
const MAX_DIAGNOSTICS = 100

const DEFAULT_DISCOVERY_STATE: MarketplaceDiscoveryState = {
  query: "",
  sortBy: "popular",
  categoryFilter: "all",
  quickFilter: "all",
  sourceFilter: "all",
  compatibilityFilter: "all",
  page: 1,
  pageSize: 20,
}

const DEFAULT_SOURCE_STATE: MarketplaceSourceState = {
  mode: "remote",
}

// =============================================================================
// Helpers
// =============================================================================

function redactSensitiveError(input: string): string {
  if (!input) return ""
  return input
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted]")
    .replace(/\bsk_[A-Za-z0-9_-]{8,}\b/g, "[redacted-token]")
    .replace(/api[_-]?key[=: ]+[A-Za-z0-9_-]{6,}/gi, "api-key=[redacted]")
    .slice(0, 500)
}

function mapInstallStageToOperationStage(stage: InstallStage): PluginOperationStage {
  if (stage === "complete" || stage === "done") return "installed"
  if (stage === "error") return "error"
  if (stage === "idle") return "idle"
  return "installing"
}

function nowIso(): string {
  return new Date().toISOString()
}

// =============================================================================
// Store
// =============================================================================

export const usePluginMarketplaceStore = create<PluginMarketplaceState>()(
  persist(
    (set, get) => ({
      // Favorites
      favorites: {},

      toggleFavorite: (pluginId) => {
        set((state) => {
          const next = { ...state.favorites }
          if (next[pluginId]) {
            delete next[pluginId]
          } else {
            next[pluginId] = true
          }
          return { favorites: next }
        })
      },

      isFavorite: (pluginId) => !!get().favorites[pluginId],

      getFavoriteIds: () => Object.keys(get().favorites),

      // Recently viewed
      recentlyViewed: [],

      addRecentlyViewed: (pluginId) => {
        set((state) => {
          const filtered = state.recentlyViewed.filter((id) => id !== pluginId)
          return {
            recentlyViewed: [pluginId, ...filtered].slice(0, MAX_RECENTLY_VIEWED),
          }
        })
      },

      clearRecentlyViewed: () => set({ recentlyViewed: [] }),

      // Canonical discovery state
      discoveryState: { ...DEFAULT_DISCOVERY_STATE },

      setDiscoveryQuery: (query) =>
        set((state) => ({
          discoveryState: {
            ...state.discoveryState,
            query,
            page: 1,
          },
        })),

      setDiscoverySort: (sortBy) =>
        set((state) => ({
          discoveryState: {
            ...state.discoveryState,
            sortBy,
            page: 1,
          },
        })),

      setDiscoveryCategoryFilter: (categoryFilter) =>
        set((state) => ({
          discoveryState: {
            ...state.discoveryState,
            categoryFilter,
            page: 1,
          },
        })),

      setDiscoveryQuickFilter: (quickFilter) =>
        set((state) => ({
          discoveryState: {
            ...state.discoveryState,
            quickFilter,
            page: 1,
          },
        })),

      setDiscoverySourceFilter: (sourceFilter) =>
        set((state) => ({
          discoveryState: {
            ...state.discoveryState,
            sourceFilter,
            page: 1,
          },
        })),

      setDiscoveryCompatibilityFilter: (compatibilityFilter) =>
        set((state) => ({
          discoveryState: {
            ...state.discoveryState,
            compatibilityFilter,
            page: 1,
          },
        })),

      setDiscoveryPage: (page) =>
        set((state) => ({
          discoveryState: {
            ...state.discoveryState,
            page: Math.max(1, page),
          },
        })),

      setDiscoveryState: (updates) =>
        set((state) => ({
          discoveryState: {
            ...state.discoveryState,
            ...updates,
          },
        })),

      resetDiscoveryState: () => set({ discoveryState: { ...DEFAULT_DISCOVERY_STATE } }),

      // Source mode and diagnostics
      sourceState: { ...DEFAULT_SOURCE_STATE },
      diagnostics: [],
      latestDiagnostic: undefined,

      setRemoteMode: () =>
        set({
          sourceState: {
            mode: "remote",
            updatedAt: nowIso(),
          },
        }),

      setFallbackMode: (category, message) =>
        set({
          sourceState: {
            mode: "degraded",
            lastFailureCategory: category,
            lastErrorMessage: redactSensitiveError(message || ""),
            updatedAt: nowIso(),
          },
        }),

      setDemoMode: (message) =>
        set({
          sourceState: {
            mode: "demo",
            lastFailureCategory: undefined,
            lastErrorMessage: redactSensitiveError(message || ""),
            updatedAt: nowIso(),
          },
        }),

      recordDiagnostic: (diagnostic) => {
        const sourceMode = get().sourceState.mode
        const entry: MarketplaceDiagnostic = {
          ...diagnostic,
          message: redactSensitiveError(diagnostic.message),
          occurredAt: nowIso(),
          sourceMode,
        }
        set((state) => ({
          diagnostics: [entry, ...state.diagnostics].slice(0, MAX_DIAGNOSTICS),
          latestDiagnostic: entry,
        }))
      },

      clearDiagnostics: () => set({ diagnostics: [], latestDiagnostic: undefined }),

      // Operation state
      operationState: {},

      startPluginOperation: (pluginId, operation, targetVersion) => {
        const key = `${operation}:${pluginId}:${targetVersion || "latest"}`
        let skipped = false

        set((state) => {
          const previous = state.operationState[pluginId]
          if (previous?.operationKey === key && previous.stage !== "error") {
            skipped = true
            return state
          }

          const nextStage: PluginOperationStage = operation === "update" ? "updating" : "installing"

          return {
            operationState: {
              ...state.operationState,
              [pluginId]: {
                stage: nextStage,
                operationKey: key,
                targetVersion,
                retryCount: previous?.retryCount || 0,
                updatedAt: nowIso(),
              },
            },
          }
        })

        return { operationKey: key, skipped }
      },

      completePluginOperation: (pluginId) => {
        set((state) => ({
          operationState: {
            ...state.operationState,
            [pluginId]: {
              ...(state.operationState[pluginId] || {
                retryCount: 0,
              }),
              stage: "installed",
              lastErrorCategory: undefined,
              lastErrorMessage: undefined,
              retryable: undefined,
              updatedAt: nowIso(),
            },
          },
        }))
      },

      failPluginOperation: (pluginId, category, message, retryable, operation = "install") => {
        const previous = get().operationState[pluginId]
        const key =
          previous?.operationKey ||
          `${operation}:${pluginId}:${previous?.targetVersion || "latest"}`

        set((state) => ({
          operationState: {
            ...state.operationState,
            [pluginId]: {
              ...(state.operationState[pluginId] || {
                retryCount: 0,
              }),
              stage: "error",
              operationKey: key,
              lastErrorCategory: category,
              lastErrorMessage: redactSensitiveError(message),
              retryable,
              updatedAt: nowIso(),
            },
          },
        }))
      },

      retryPluginOperation: (pluginId, operation, targetVersion) => {
        const startResult = get().startPluginOperation(pluginId, operation, targetVersion)
        if (startResult.skipped) {
          return startResult
        }

        set((state) => {
          const previous = state.operationState[pluginId]
          return {
            operationState: {
              ...state.operationState,
              [pluginId]: {
                ...(previous || {
                  stage: operation === "update" ? "updating" : "installing",
                }),
                stage: operation === "update" ? "updating" : "installing",
                operationKey: startResult.operationKey,
                retryCount: (previous?.retryCount || 0) + 1,
                lastErrorCategory: undefined,
                lastErrorMessage: undefined,
                retryable: undefined,
                updatedAt: nowIso(),
              },
            },
          }
        })

        return startResult
      },

      getPluginOperationState: (pluginId) => get().operationState[pluginId],
      getActiveOperationKey: (pluginId) => get().operationState[pluginId]?.operationKey,

      // Install progress (transient, not persisted)
      installProgress: {},

      setInstallProgress: (pluginId, progress) => {
        set((state) => ({
          installProgress: { ...state.installProgress, [pluginId]: progress },
          operationState: {
            ...state.operationState,
            [pluginId]: {
              ...(state.operationState[pluginId] || {
                retryCount: 0,
              }),
              stage: mapInstallStageToOperationStage(progress.stage),
              lastErrorMessage:
                progress.stage === "error"
                  ? redactSensitiveError(progress.error || progress.message || "")
                  : undefined,
              updatedAt: nowIso(),
            },
          },
        }))
      },

      clearInstallProgress: (pluginId) => {
        set((state) => {
          const next = { ...state.installProgress }
          delete next[pluginId]
          return { installProgress: next }
        })
      },

      getInstallProgress: (pluginId) => get().installProgress[pluginId],

      isInstalling: (pluginId) => {
        const operation = get().operationState[pluginId]
        if (operation?.stage === "installing" || operation?.stage === "updating") {
          return true
        }
        const progress = get().installProgress[pluginId]
        if (!progress) return false
        return !["idle", "complete", "error"].includes(progress.stage)
      },

      // User reviews
      userReviews: {},

      submitReview: (pluginId, rating, content) => {
        set((state) => ({
          userReviews: {
            ...state.userReviews,
            [pluginId]: {
              pluginId,
              rating,
              content,
              date: new Date().toISOString().split("T")[0],
            },
          },
        }))
      },

      getUserReview: (pluginId) => get().userReviews[pluginId],

      // Search history
      searchHistory: [],

      addSearchHistory: (query) => {
        if (!query.trim()) return
        set((state) => {
          const filtered = state.searchHistory.filter((q) => q !== query)
          return {
            searchHistory: [query, ...filtered].slice(0, MAX_SEARCH_HISTORY),
          }
        })
      },

      clearSearchHistory: () => set({ searchHistory: [] }),

      // View preferences
      viewMode: "grid",
      setViewMode: (mode) => set({ viewMode: mode }),

      // Browse view state
      browseViewState: {
        selectedPluginId: null,
        scrollOffset: 0,
        detailOpen: false,
        activeTab: "browse",
      },
      setBrowseViewState: (updates) =>
        set((state) => ({
          browseViewState: { ...state.browseViewState, ...updates },
        })),

      // Comparison
      comparisonIds: [],
      comparisonOpen: false,
      addToComparison: (id) =>
        set((state) => {
          if (state.comparisonIds.includes(id) || state.comparisonIds.length >= 2) return state
          return { comparisonIds: [...state.comparisonIds, id] }
        }),
      removeFromComparison: (id) =>
        set((state) => ({
          comparisonIds: state.comparisonIds.filter((cid) => cid !== id),
        })),
      clearComparison: () => set({ comparisonIds: [], comparisonOpen: false }),
      setComparisonOpen: (open) => set({ comparisonOpen: open }),

      // Reset
      reset: () =>
        set({
          favorites: {},
          recentlyViewed: [],
          discoveryState: { ...DEFAULT_DISCOVERY_STATE },
          sourceState: { ...DEFAULT_SOURCE_STATE },
          diagnostics: [],
          latestDiagnostic: undefined,
          operationState: {},
          installProgress: {},
          userReviews: {},
          searchHistory: [],
          viewMode: "grid",
          browseViewState: {
            selectedPluginId: null,
            scrollOffset: 0,
            detailOpen: false,
            activeTab: "browse",
          },
          comparisonIds: [],
          comparisonOpen: false,
        }),
    }),
    {
      name: "cognia-plugin-marketplace",
      version: 3,
      storage: createJSONStorage(() => localStorage),
      migrate: (state, version) => {
        const persisted = (state || {}) as Record<string, unknown>
        if (version < 2) {
          return {
            ...persisted,
            discoveryState: DEFAULT_DISCOVERY_STATE,
          }
        }
        if (version < 3) {
          return {
            ...persisted,
            browseViewState: {
              selectedPluginId: null,
              scrollOffset: 0,
              detailOpen: false,
              activeTab: "browse",
            },
          }
        }
        return persisted
      },
      partialize: (state) => ({
        favorites: state.favorites,
        recentlyViewed: state.recentlyViewed,
        discoveryState: state.discoveryState,
        userReviews: state.userReviews,
        searchHistory: state.searchHistory,
        viewMode: state.viewMode,
        browseViewState: state.browseViewState,
        // installProgress, sourceState, diagnostics, operationState, comparisonIds are transient
      }),
    }
  )
)

// =============================================================================
// Selectors
// =============================================================================

export const selectFavoriteCount = (state: PluginMarketplaceState) =>
  Object.keys(state.favorites).length

export const selectIsInstalling = (pluginId: string) => (state: PluginMarketplaceState) =>
  state.isInstalling(pluginId)

export const selectInstallStage =
  (pluginId: string) =>
  (state: PluginMarketplaceState): InstallStage => {
    const progress = state.installProgress[pluginId]
    return progress?.stage || "idle"
  }

export const selectOperationStage =
  (pluginId: string) =>
  (state: PluginMarketplaceState): PluginOperationStage =>
    state.operationState[pluginId]?.stage || "idle"

export const selectMarketplaceSourceMode = (state: PluginMarketplaceState) => state.sourceState.mode

export const selectComparisonIds = (state: PluginMarketplaceState) => state.comparisonIds

export const selectBrowseViewState = (state: PluginMarketplaceState) => state.browseViewState

export const selectBrowseActiveTab = (state: PluginMarketplaceState) =>
  state.browseViewState.activeTab
