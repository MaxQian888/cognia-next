/**
 * @jest-environment jsdom
 *
 * Coverage for `plugin-marketplace-store.ts`. The store is persisted to
 * localStorage via zustand/middleware; jsdom supplies an in-memory backing
 * store so persistence works without extra setup.
 */

import {
  usePluginMarketplaceStore,
  selectFavoriteCount,
  selectIsInstalling,
  selectInstallStage,
  selectOperationStage,
  selectMarketplaceSourceMode,
  selectComparisonIds,
  selectBrowseViewState,
  selectBrowseActiveTab,
} from "./plugin-marketplace-store"

const getStore = () => usePluginMarketplaceStore.getState()

beforeEach(() => {
  // The store ships a reset() action; use it instead of a private setState so
  // every persisted slice is brought back to its documented default.
  getStore().reset()
})

describe("favorites", () => {
  it("toggleFavorite adds an entry on first call, removes it on second", () => {
    getStore().toggleFavorite("p1")
    expect(getStore().isFavorite("p1")).toBe(true)
    expect(getStore().getFavoriteIds()).toEqual(["p1"])
    getStore().toggleFavorite("p1")
    expect(getStore().isFavorite("p1")).toBe(false)
    expect(getStore().getFavoriteIds()).toEqual([])
  })

  it("getFavoriteIds returns every favorited plugin id (order not asserted)", () => {
    getStore().toggleFavorite("a")
    getStore().toggleFavorite("b")
    expect(getStore().getFavoriteIds().sort()).toEqual(["a", "b"])
  })

  it("selectFavoriteCount counts favorites", () => {
    getStore().toggleFavorite("a")
    getStore().toggleFavorite("b")
    expect(selectFavoriteCount(getStore())).toBe(2)
  })
})

describe("recentlyViewed", () => {
  it("moves an already-viewed plugin to the front of the list on re-view", () => {
    getStore().addRecentlyViewed("a")
    getStore().addRecentlyViewed("b")
    getStore().addRecentlyViewed("a")
    expect(getStore().recentlyViewed).toEqual(["a", "b"])
  })

  it("caps the list at MAX_RECENTLY_VIEWED (20)", () => {
    for (let i = 0; i < 25; i++) {
      getStore().addRecentlyViewed(`p${i}`)
    }
    expect(getStore().recentlyViewed).toHaveLength(20)
    // Most recent first.
    expect(getStore().recentlyViewed[0]).toBe("p24")
  })

  it("clearRecentlyViewed empties the list", () => {
    getStore().addRecentlyViewed("a")
    getStore().clearRecentlyViewed()
    expect(getStore().recentlyViewed).toEqual([])
  })
})

describe("discoveryState", () => {
  it("setDiscoveryQuery updates the query and resets page to 1", () => {
    getStore().setDiscoveryPage(5)
    getStore().setDiscoveryQuery("react")
    expect(getStore().discoveryState.query).toBe("react")
    expect(getStore().discoveryState.page).toBe(1)
  })

  it("each filter setter resets page to 1", () => {
    const calls: [keyof ReturnType<typeof getStore>, unknown][] = [
      ["setDiscoverySort", "newest"],
      ["setDiscoveryCategoryFilter", "tools"],
      ["setDiscoveryQuickFilter", "trending"],
      ["setDiscoverySourceFilter", "marketplace"],
      ["setDiscoveryCompatibilityFilter", "compatible"],
    ]
    for (const [fn, value] of calls) {
      getStore().setDiscoveryPage(7)
      ;(getStore() as unknown as Record<string, (v: unknown) => void>)[fn as string](value)
      expect(getStore().discoveryState.page).toBe(1)
    }
  })

  it("setDiscoveryPage clamps to a minimum of 1", () => {
    getStore().setDiscoveryPage(-3)
    expect(getStore().discoveryState.page).toBe(1)
    getStore().setDiscoveryPage(0)
    expect(getStore().discoveryState.page).toBe(1)
  })

  it("setDiscoveryState merges partial updates onto the existing state", () => {
    getStore().setDiscoveryState({ pageSize: 50, query: "foo" })
    expect(getStore().discoveryState.pageSize).toBe(50)
    expect(getStore().discoveryState.query).toBe("foo")
  })

  it("resetDiscoveryState restores the documented defaults", () => {
    getStore().setDiscoveryQuery("nope")
    getStore().setDiscoveryCategoryFilter("themes")
    getStore().resetDiscoveryState()
    expect(getStore().discoveryState).toMatchObject({
      query: "",
      sortBy: "popular",
      categoryFilter: "all",
      page: 1,
      pageSize: 20,
    })
  })
})

describe("sourceState (marketplace mode)", () => {
  it("setRemoteMode marks mode=remote and stamps updatedAt", () => {
    getStore().setRemoteMode()
    expect(getStore().sourceState.mode).toBe("remote")
    expect(getStore().sourceState.updatedAt).toBeTruthy()
    expect(selectMarketplaceSourceMode(getStore())).toBe("remote")
  })

  it("setFallbackMode records the failure category and redacts sensitive tokens", () => {
    getStore().setFallbackMode("auth", "request failed with Bearer sk-very-secret-1234567890")
    const src = getStore().sourceState
    expect(src.mode).toBe("degraded")
    expect(src.lastFailureCategory).toBe("auth")
    expect(src.lastErrorMessage).toContain("Bearer [redacted]")
    expect(src.lastErrorMessage).not.toContain("sk-very-secret")
  })

  it("setFallbackMode handles a missing message without throwing", () => {
    getStore().setFallbackMode("network")
    expect(getStore().sourceState.lastErrorMessage).toBe("")
  })

  it("setDemoMode clears the prior failure category", () => {
    getStore().setFallbackMode("rate_limit", "throttled")
    getStore().setDemoMode("entering demo")
    const src = getStore().sourceState
    expect(src.mode).toBe("demo")
    expect(src.lastFailureCategory).toBeUndefined()
    expect(src.lastErrorMessage).toContain("entering demo")
  })
})

describe("diagnostics", () => {
  it("recordDiagnostic prepends an entry and updates latestDiagnostic", () => {
    getStore().setRemoteMode()
    getStore().recordDiagnostic({
      operation: "search",
      category: "network",
      retryable: true,
      message: "timeout",
    })
    expect(getStore().diagnostics).toHaveLength(1)
    expect(getStore().latestDiagnostic?.operation).toBe("search")
    expect(getStore().latestDiagnostic?.sourceMode).toBe("remote")
  })

  it("recordDiagnostic redacts api keys in the recorded message", () => {
    getStore().recordDiagnostic({
      operation: "install",
      category: "auth",
      retryable: false,
      message: "auth failed api_key=hunter2hunter2",
    })
    expect(getStore().diagnostics[0].message).toContain("[redacted]")
  })

  it("caps the diagnostics log at MAX_DIAGNOSTICS (100)", () => {
    for (let i = 0; i < 150; i++) {
      getStore().recordDiagnostic({
        operation: "search",
        category: "network",
        retryable: true,
        message: `event-${i}`,
      })
    }
    expect(getStore().diagnostics).toHaveLength(100)
    // Newest first.
    expect(getStore().diagnostics[0].message).toBe("event-149")
  })

  it("clearDiagnostics empties the log and latestDiagnostic", () => {
    getStore().recordDiagnostic({
      operation: "search",
      category: "network",
      retryable: true,
      message: "x",
    })
    getStore().clearDiagnostics()
    expect(getStore().diagnostics).toEqual([])
    expect(getStore().latestDiagnostic).toBeUndefined()
  })
})

describe("operationState", () => {
  it("startPluginOperation sets stage=installing for installs", () => {
    const r = getStore().startPluginOperation("p1", "install", "1.0.0")
    expect(r.skipped).toBe(false)
    expect(r.operationKey).toBe("install:p1:1.0.0")
    expect(getStore().getPluginOperationState("p1")?.stage).toBe("installing")
    expect(getStore().getActiveOperationKey("p1")).toBe("install:p1:1.0.0")
  })

  it("startPluginOperation sets stage=updating for updates", () => {
    getStore().startPluginOperation("p1", "update", "2.0.0")
    expect(getStore().getPluginOperationState("p1")?.stage).toBe("updating")
  })

  it("startPluginOperation skips duplicate, non-errored requests with the same key", () => {
    getStore().startPluginOperation("p1", "install", "1.0.0")
    const r2 = getStore().startPluginOperation("p1", "install", "1.0.0")
    expect(r2.skipped).toBe(true)
  })

  it("startPluginOperation does NOT skip when the previous stage was error", () => {
    getStore().startPluginOperation("p1", "install", "1.0.0")
    getStore().failPluginOperation("p1", "network", "boom", true, "install")
    const r2 = getStore().startPluginOperation("p1", "install", "1.0.0")
    expect(r2.skipped).toBe(false)
    expect(getStore().getPluginOperationState("p1")?.stage).toBe("installing")
  })

  it("startPluginOperation defaults the version key to 'latest'", () => {
    const r = getStore().startPluginOperation("p1", "install")
    expect(r.operationKey).toBe("install:p1:latest")
  })

  it("completePluginOperation flips the stage to installed and clears errors", () => {
    getStore().startPluginOperation("p1", "install", "1.0.0")
    getStore().failPluginOperation("p1", "network", "earlier", true, "install")
    getStore().completePluginOperation("p1")
    const op = getStore().getPluginOperationState("p1")
    expect(op?.stage).toBe("installed")
    expect(op?.lastErrorCategory).toBeUndefined()
    expect(op?.lastErrorMessage).toBeUndefined()
  })

  it("completePluginOperation seeds a fresh entry when called on an unknown plugin", () => {
    getStore().completePluginOperation("never-seen")
    expect(getStore().getPluginOperationState("never-seen")?.stage).toBe("installed")
  })

  it("failPluginOperation stamps an error stage and redacts the message", () => {
    getStore().startPluginOperation("p1", "install", "1.0.0")
    getStore().failPluginOperation(
      "p1",
      "auth",
      "Bearer sk-1234567890 was rejected",
      false,
      "install"
    )
    const op = getStore().getPluginOperationState("p1")
    expect(op?.stage).toBe("error")
    expect(op?.lastErrorCategory).toBe("auth")
    expect(op?.lastErrorMessage).toContain("Bearer [redacted]")
    expect(op?.retryable).toBe(false)
  })

  it("failPluginOperation synthesizes an operation key when none was started yet", () => {
    getStore().failPluginOperation("p-fresh", "validation", "bad manifest", false)
    expect(getStore().getPluginOperationState("p-fresh")?.operationKey).toContain("p-fresh")
  })

  it("retryPluginOperation bumps retryCount and clears error fields", () => {
    getStore().startPluginOperation("p1", "install", "1.0.0")
    getStore().failPluginOperation("p1", "network", "boom", true, "install")
    expect(getStore().getPluginOperationState("p1")?.retryCount).toBe(0)
    getStore().retryPluginOperation("p1", "install", "1.0.0")
    const op = getStore().getPluginOperationState("p1")
    expect(op?.retryCount).toBe(1)
    expect(op?.stage).toBe("installing")
    expect(op?.lastErrorCategory).toBeUndefined()
  })

  it("retryPluginOperation returns the original skip signal when the operation is already in-flight", () => {
    getStore().startPluginOperation("p1", "install", "1.0.0")
    const r = getStore().retryPluginOperation("p1", "install", "1.0.0")
    expect(r.skipped).toBe(true)
    // retryCount should NOT advance when the start was a no-op.
    expect(getStore().getPluginOperationState("p1")?.retryCount).toBe(0)
  })

  it("selectOperationStage returns 'idle' for unknown plugins", () => {
    expect(selectOperationStage("ghost")(getStore())).toBe("idle")
  })
})

describe("installProgress", () => {
  it("setInstallProgress mirrors stage→operationState via mapInstallStageToOperationStage", () => {
    getStore().setInstallProgress("p1", { stage: "downloading", progress: 0.4 })
    expect(getStore().getPluginOperationState("p1")?.stage).toBe("installing")
    expect(getStore().isInstalling("p1")).toBe(true)
  })

  it("setInstallProgress translates stage=complete to operationState=installed", () => {
    getStore().setInstallProgress("p1", { stage: "complete" })
    expect(getStore().getPluginOperationState("p1")?.stage).toBe("installed")
  })

  it("setInstallProgress translates stage=done to operationState=installed", () => {
    getStore().setInstallProgress("p1", { stage: "done" })
    expect(getStore().getPluginOperationState("p1")?.stage).toBe("installed")
  })

  it("setInstallProgress with stage=error captures the redacted message", () => {
    getStore().setInstallProgress("p1", {
      stage: "error",
      error: "request failed: api-key=hunter2hunter2",
    })
    const op = getStore().getPluginOperationState("p1")
    expect(op?.stage).toBe("error")
    expect(op?.lastErrorMessage).toContain("[redacted]")
  })

  it("setInstallProgress with stage=error falls back to the progress message when error is missing", () => {
    getStore().setInstallProgress("p1", { stage: "error", message: "checksum mismatch" })
    expect(getStore().getPluginOperationState("p1")?.lastErrorMessage).toContain(
      "checksum mismatch"
    )
  })

  it("setInstallProgress maps stage=idle correctly", () => {
    getStore().setInstallProgress("p1", { stage: "idle" })
    expect(getStore().getPluginOperationState("p1")?.stage).toBe("idle")
  })

  it("clearInstallProgress removes the entry but leaves operationState intact", () => {
    getStore().setInstallProgress("p1", { stage: "downloading" })
    getStore().clearInstallProgress("p1")
    expect(getStore().getInstallProgress("p1")).toBeUndefined()
    expect(getStore().getPluginOperationState("p1")?.stage).toBe("installing")
  })

  it("isInstalling treats an in-flight operation as installing even when no progress entry exists", () => {
    getStore().startPluginOperation("p1", "install")
    expect(getStore().isInstalling("p1")).toBe(true)
  })

  it("isInstalling returns false for unknown plugins", () => {
    expect(getStore().isInstalling("ghost")).toBe(false)
  })

  it("isInstalling returns false when operationState is installed and progress is idle", () => {
    getStore().setInstallProgress("p1", { stage: "complete" })
    expect(getStore().isInstalling("p1")).toBe(false)
  })

  it("selectInstallStage falls back to 'idle' when no progress is recorded", () => {
    expect(selectInstallStage("ghost")(getStore())).toBe("idle")
  })

  it("selectIsInstalling delegates to the store action", () => {
    getStore().startPluginOperation("p1", "install")
    expect(selectIsInstalling("p1")(getStore())).toBe(true)
  })
})

describe("user reviews + search history + view mode", () => {
  it("submitReview stores a review keyed by pluginId and timestamps it as YYYY-MM-DD", () => {
    getStore().submitReview("p1", 5, "great plugin")
    const review = getStore().getUserReview("p1")
    expect(review).toMatchObject({ pluginId: "p1", rating: 5, content: "great plugin" })
    expect(review?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("addSearchHistory skips whitespace-only queries", () => {
    getStore().addSearchHistory("   ")
    expect(getStore().searchHistory).toEqual([])
  })

  it("addSearchHistory moves a re-searched query to the front", () => {
    getStore().addSearchHistory("react")
    getStore().addSearchHistory("vue")
    getStore().addSearchHistory("react")
    expect(getStore().searchHistory).toEqual(["react", "vue"])
  })

  it("addSearchHistory caps at MAX_SEARCH_HISTORY (50)", () => {
    for (let i = 0; i < 60; i++) {
      getStore().addSearchHistory(`q${i}`)
    }
    expect(getStore().searchHistory).toHaveLength(50)
  })

  it("clearSearchHistory empties the list", () => {
    getStore().addSearchHistory("react")
    getStore().clearSearchHistory()
    expect(getStore().searchHistory).toEqual([])
  })

  it("setViewMode persists the requested view", () => {
    getStore().setViewMode("list")
    expect(getStore().viewMode).toBe("list")
    getStore().setViewMode("grid")
    expect(getStore().viewMode).toBe("grid")
  })
})

describe("browseViewState", () => {
  it("setBrowseViewState merges partial updates", () => {
    getStore().setBrowseViewState({ selectedPluginId: "p1", scrollOffset: 120 })
    expect(getStore().browseViewState).toMatchObject({
      selectedPluginId: "p1",
      scrollOffset: 120,
      detailOpen: false,
      activeTab: "browse",
    })
  })

  it("selectBrowseViewState + selectBrowseActiveTab read derived state", () => {
    getStore().setBrowseViewState({ activeTab: "installed" })
    expect(selectBrowseViewState(getStore()).activeTab).toBe("installed")
    expect(selectBrowseActiveTab(getStore())).toBe("installed")
  })
})

describe("comparison set", () => {
  it("addToComparison appends unique ids up to the 2-item cap", () => {
    getStore().addToComparison("a")
    getStore().addToComparison("b")
    expect(getStore().comparisonIds).toEqual(["a", "b"])
    getStore().addToComparison("c")
    expect(getStore().comparisonIds).toEqual(["a", "b"])
  })

  it("addToComparison ignores duplicate ids", () => {
    getStore().addToComparison("a")
    getStore().addToComparison("a")
    expect(getStore().comparisonIds).toEqual(["a"])
  })

  it("removeFromComparison drops a single id", () => {
    getStore().addToComparison("a")
    getStore().addToComparison("b")
    getStore().removeFromComparison("a")
    expect(getStore().comparisonIds).toEqual(["b"])
  })

  it("clearComparison empties the set and closes the panel", () => {
    getStore().addToComparison("a")
    getStore().setComparisonOpen(true)
    getStore().clearComparison()
    expect(getStore().comparisonIds).toEqual([])
    expect(getStore().comparisonOpen).toBe(false)
  })

  it("setComparisonOpen toggles the panel flag", () => {
    getStore().setComparisonOpen(true)
    expect(getStore().comparisonOpen).toBe(true)
    getStore().setComparisonOpen(false)
    expect(getStore().comparisonOpen).toBe(false)
  })

  it("selectComparisonIds reads the comparison list", () => {
    getStore().addToComparison("a")
    expect(selectComparisonIds(getStore())).toEqual(["a"])
  })
})

describe("persist.migrate", () => {
  type StoreWithPersist = {
    persist: { getOptions: () => { migrate: (s: unknown, v: number) => unknown; version: number } }
  }
  const persist = (usePluginMarketplaceStore as unknown as StoreWithPersist).persist.getOptions()

  it("v0 → adds the discoveryState block", () => {
    const out = persist.migrate({}, 0) as { discoveryState?: { query: string } }
    expect(out.discoveryState).toMatchObject({ query: "", sortBy: "popular" })
  })

  it("v2 → adds the browseViewState block", () => {
    const out = persist.migrate({}, 2) as { browseViewState?: { activeTab: string } }
    expect(out.browseViewState).toMatchObject({
      selectedPluginId: null,
      scrollOffset: 0,
      detailOpen: false,
      activeTab: "browse",
    })
  })

  it("v3 (current) → returns the persisted state untouched", () => {
    const persisted = { favorites: { x: true } }
    const out = persist.migrate(persisted, 3) as { favorites: Record<string, true> }
    expect(out.favorites).toEqual({ x: true })
  })

  it("null persisted state returns an empty object after migration", () => {
    const out = persist.migrate(null, 0) as Record<string, unknown>
    expect(out.discoveryState).toBeDefined()
  })
})

describe("persist.partialize", () => {
  type StoreWithPersist = {
    persist: { getOptions: () => { partialize: (s: unknown) => unknown } }
  }
  const persist = (usePluginMarketplaceStore as unknown as StoreWithPersist).persist.getOptions()

  it("keeps the user-facing state and drops transient slices", () => {
    getStore().toggleFavorite("a")
    getStore().setInstallProgress("a", { stage: "downloading" })
    getStore().recordDiagnostic({
      operation: "search",
      category: "network",
      retryable: true,
      message: "x",
    })
    getStore().addToComparison("a")
    const slice = persist.partialize(getStore()) as Record<string, unknown>
    expect(slice.favorites).toEqual({ a: true })
    expect(slice.installProgress).toBeUndefined()
    expect(slice.diagnostics).toBeUndefined()
    expect(slice.sourceState).toBeUndefined()
    expect(slice.operationState).toBeUndefined()
    expect(slice.comparisonIds).toBeUndefined()
  })
})

describe("reset()", () => {
  it("scrubs every persisted slice back to defaults", () => {
    getStore().toggleFavorite("p1")
    getStore().addRecentlyViewed("p1")
    getStore().setDiscoveryQuery("react")
    getStore().setFallbackMode("network", "boom")
    getStore().startPluginOperation("p1", "install", "1.0.0")
    getStore().setInstallProgress("p1", { stage: "downloading" })
    getStore().submitReview("p1", 5, "great")
    getStore().addSearchHistory("react")
    getStore().setViewMode("list")
    getStore().setBrowseViewState({ selectedPluginId: "p1", activeTab: "installed" })
    getStore().addToComparison("p1")

    getStore().reset()

    expect(getStore().favorites).toEqual({})
    expect(getStore().recentlyViewed).toEqual([])
    expect(getStore().discoveryState.query).toBe("")
    expect(getStore().sourceState.mode).toBe("remote")
    expect(getStore().operationState).toEqual({})
    expect(getStore().installProgress).toEqual({})
    expect(getStore().userReviews).toEqual({})
    expect(getStore().searchHistory).toEqual([])
    expect(getStore().viewMode).toBe("grid")
    expect(getStore().browseViewState).toMatchObject({ activeTab: "browse" })
    expect(getStore().comparisonIds).toEqual([])
  })
})
