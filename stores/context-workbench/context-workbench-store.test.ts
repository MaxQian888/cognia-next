import {
  CONTEXT_WORKBENCH_LAYOUT_MAX_AGE_MS,
  createContextWorkbenchStoreForTesting,
  pruneContextWorkbenchLayouts,
} from "./context-workbench-store"

describe("context workbench layout store", () => {
  it("isolates state by instance and resource key", () => {
    const store = createContextWorkbenchStoreForTesting()
    const first = "window-a::canvas:doc-1"
    const second = "window-b::canvas:doc-1"

    store.getState().activatePanel(first, "comments", "wide", true)

    expect(store.getState().layouts[first]).toMatchObject({
      activePanelId: "comments",
      mode: "wide",
      userPinned: true,
    })
    expect(store.getState().layouts[second]).toBeUndefined()
  })

  it("queues automatic reveals while pinned and lets explicit navigation switch independently", () => {
    const store = createContextWorkbenchStoreForTesting()
    const key = "window-a::workflow:wf-1"

    expect(store.getState().smartReveal(key, "inspect", "wide")).toBe(true)
    store.getState().navigatePanel(key, "ai", "narrow")
    store.getState().setUserPinned(key, true)
    expect(store.getState().smartReveal(key, "inspect", "wide")).toBe(false)
    expect(store.getState().layouts[key]).toMatchObject({
      activePanelId: "ai",
      pendingPanelIds: ["inspect"],
      userPinned: true,
    })

    store.getState().navigatePanel(key, "review", "focus")
    expect(store.getState().layouts[key]).toMatchObject({
      activePanelId: "review",
      mode: "focus",
      pendingPanelIds: ["inspect"],
      userPinned: true,
    })
  })

  it("tracks first activation and clamps persisted width", () => {
    const store = createContextWorkbenchStoreForTesting()
    const key = "window-a::artifact:a-1"
    store.getState().activatePanel(key, "review", "wide", false)
    store.getState().activatePanel(key, "review", "wide", false)
    store.getState().setWidth(key, 2000)

    expect(store.getState().layouts[key]?.activatedPanelIds).toEqual(["review"])
    expect(store.getState().layouts[key]?.width).toBe(960)
  })

  it("updates mode, pin state, minimum width, and removes a scope", () => {
    const store = createContextWorkbenchStoreForTesting()
    const key = "window-a::project:p:r:a.ts"

    store.getState().setMode(key, "focus")
    store.getState().setUserPinned(key, true)
    store.getState().setWidth(key, 20)
    expect(store.getState().layouts[key]).toMatchObject({
      mode: "focus",
      userPinned: true,
      width: 240,
    })

    store.getState().removeScope(key)
    expect(store.getState().layouts[key]).toBeUndefined()
  })

  it("falls back deterministically when an active panel becomes unavailable", () => {
    const store = createContextWorkbenchStoreForTesting()
    const key = "window-a::canvas:doc-1"
    store.getState().navigatePanel(key, "plugin:removed", "wide")
    store.getState().setUserPinned(key, true)
    store.getState().smartReveal(key, "review", "wide")

    store.getState().reconcilePanels(key, ["comments", "review"], "comments")

    expect(store.getState().layouts[key]).toMatchObject({
      activePanelId: "comments",
      mode: "wide",
      userPinned: false,
      pendingPanelIds: ["review"],
    })
  })

  it("retains at most 200 recent scopes and evicts entries unused for 30 days", () => {
    const now = Date.UTC(2026, 6, 18)
    const layouts = Object.fromEntries(
      Array.from({ length: 205 }, (_, index) => [
        `scope-${index}`,
        {
          mode: "narrow" as const,
          width: 360,
          activePanelId: null,
          userPinned: false,
          activatedPanelIds: [],
          pendingPanelIds: [],
          lastUsedAt: now - index,
        },
      ])
    )
    layouts.stale = {
      ...layouts["scope-0"]!,
      lastUsedAt: now - CONTEXT_WORKBENCH_LAYOUT_MAX_AGE_MS - 1,
    }

    const pruned = pruneContextWorkbenchLayouts(layouts, now)

    expect(Object.keys(pruned)).toHaveLength(200)
    expect(pruned.stale).toBeUndefined()
    expect(pruned["scope-0"]).toBeDefined()
    expect(pruned["scope-204"]).toBeUndefined()
  })

  it("persists and clears an explicit resource-session reassociation", () => {
    const store = createContextWorkbenchStoreForTesting()
    store.getState().setSessionOverride("project:p:r:new.ts", "old-session")
    expect(store.getState().sessionOverrides["project:p:r:new.ts"]).toBe("old-session")
    store.getState().setSessionOverride("project:p:r:new.ts", null)
    expect(store.getState().sessionOverrides["project:p:r:new.ts"]).toBeUndefined()
  })
})
