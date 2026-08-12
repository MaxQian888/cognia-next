import {
  CONTEXT_WORKBENCH_LAYOUT_MAX_AGE_MS,
  createContextWorkbenchStoreForTesting,
  pruneContextWorkbenchLayouts,
  useContextWorkbenchStore,
  type ContextWorkbenchLayout,
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
          panelWidths: {},
          activePanelId: null,
          userPinned: false,
          activatedPanelIds: [],
          pendingPanelIds: [],
          lastUsedAt: now - index,
          splitPanelId: null,
          splitRatio: 50,
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

  it("never persists the focus takeover, in or out", () => {
    const options = useContextWorkbenchStore.persist.getOptions()
    const focused: Record<string, ContextWorkbenchLayout> = {
      "window-a::canvas:doc-1": {
        mode: "focus",
        width: 360,
        panelWidths: {},
        activePanelId: "comments",
        userPinned: false,
        activatedPanelIds: ["comments"],
        pendingPanelIds: [],
        lastUsedAt: Date.now(),
        splitPanelId: null,
        splitRatio: 50,
      },
    }

    // Writing out: a reload must not come back covering the whole window —
    // least of all when the user collapsed the dock on the way out.
    const written = options.partialize?.({
      ...useContextWorkbenchStore.getState(),
      layouts: focused,
    }) as { layouts: Record<string, ContextWorkbenchLayout> }
    expect(written.layouts["window-a::canvas:doc-1"]).toMatchObject({
      mode: "narrow",
      activePanelId: "comments",
    })

    // Reading back: snapshots written before this rule still have to recover.
    const merged = options.merge?.(
      { layouts: focused, sessionOverrides: {} },
      useContextWorkbenchStore.getState()
    ) as { layouts: Record<string, ContextWorkbenchLayout> }
    expect(merged.layouts["window-a::canvas:doc-1"]?.mode).toBe("narrow")
    const migrated = options.migrate?.({ layouts: focused, sessionOverrides: {} }, 1) as {
      layouts: Record<string, ContextWorkbenchLayout>
    }
    expect(migrated.layouts["window-a::canvas:doc-1"]?.mode).toBe("narrow")
  })

  it("keeps focus live in memory for as long as the user holds it", () => {
    const store = createContextWorkbenchStoreForTesting()
    const key = "window-a::canvas:doc-1"
    store.getState().navigatePanel(key, "comments", "narrow")

    store.getState().setMode(key, "focus")
    expect(store.getState().layouts[key]?.mode).toBe("focus")
    store.getState().setWidth(key, 500)
    expect(store.getState().layouts[key]?.mode).toBe("focus")
  })

  it("records a session-scoped activation without touching the visible panel or width", () => {
    const store = createContextWorkbenchStoreForTesting()
    const key = "window-a::session:s-1"

    store.getState().navigatePanel(key, "comments", "narrow")
    store.getState().setWidth(key, 500, "comments")
    store.getState().markPanelActivated(key, "browser")

    expect(store.getState().layouts[key]).toMatchObject({
      activePanelId: "comments",
      width: 500,
      activatedPanelIds: ["comments", "browser"],
    })

    // Idempotent — a second call for an already-recorded panel is a no-op.
    const before = store.getState().layouts
    store.getState().markPanelActivated(key, "browser")
    expect(store.getState().layouts).toBe(before)
  })

  describe("per-panel width memory", () => {
    it("does not record a width when the caller names no panel", () => {
      const store = createContextWorkbenchStoreForTesting()
      const key = "window-a::canvas:doc-1"
      store.getState().navigatePanel(key, "comments", "narrow")
      store.getState().setWidth(key, 500)

      expect(store.getState().layouts[key]?.width).toBe(500)
      expect(store.getState().layouts[key]?.panelWidths).toEqual({})
    })

    it("restores the width the user dragged to for that panel when it comes back", () => {
      const store = createContextWorkbenchStoreForTesting()
      const key = "window-a::canvas:doc-1"

      store.getState().navigatePanel(key, "comments", "narrow")
      store.getState().setWidth(key, 500, "comments")
      store.getState().navigatePanel(key, "inspect", "narrow")
      store.getState().setWidth(key, 700, "inspect")

      expect(store.getState().layouts[key]?.width).toBe(700)

      store.getState().navigatePanel(key, "comments", "narrow")
      expect(store.getState().layouts[key]?.width).toBe(500)
      expect(store.getState().layouts[key]?.panelWidths).toEqual({
        comments: 500,
        inspect: 700,
      })
    })

    it("leaves the live width alone for a panel that was never dragged", () => {
      const store = createContextWorkbenchStoreForTesting()
      const key = "window-a::canvas:doc-1"

      store.getState().navigatePanel(key, "comments", "narrow")
      store.getState().setWidth(key, 620, "comments")
      store.getState().navigatePanel(key, "review", "narrow")

      expect(store.getState().layouts[key]?.width).toBe(620)
    })

    it("restores through every reveal route, including a plugin smartReveal", () => {
      const store = createContextWorkbenchStoreForTesting()
      const key = "window-a::artifact:a-1"

      store.getState().activatePanel(key, "demo:panel", "narrow")
      store.getState().setWidth(key, 480, "demo:panel")
      store.getState().navigatePanel(key, "review", "narrow")
      store.getState().setWidth(key, 320, "review")

      expect(store.getState().smartReveal(key, "demo:panel", "narrow")).toBe(true)
      expect(store.getState().layouts[key]?.width).toBe(480)
    })

    it("does not restore a width for a reveal that was queued behind a pin", () => {
      const store = createContextWorkbenchStoreForTesting()
      const key = "window-a::artifact:a-1"

      store.getState().navigatePanel(key, "demo:panel", "narrow")
      store.getState().setWidth(key, 480, "demo:panel")
      store.getState().navigatePanel(key, "review", "narrow")
      store.getState().setWidth(key, 320, "review")
      store.getState().setUserPinned(key, true)

      expect(store.getState().smartReveal(key, "demo:panel", "narrow")).toBe(false)
      // The pinned surface stayed on `review`, so its width must stay too.
      expect(store.getState().layouts[key]?.width).toBe(320)
      expect(store.getState().layouts[key]?.pendingPanelIds).toEqual(["demo:panel"])
    })

    it("restores the fallback panel's width when the active one disappears", () => {
      const store = createContextWorkbenchStoreForTesting()
      const key = "window-a::canvas:doc-1"

      store.getState().navigatePanel(key, "comments", "narrow")
      store.getState().setWidth(key, 500, "comments")
      store.getState().navigatePanel(key, "demo:panel", "narrow")
      store.getState().setWidth(key, 800, "demo:panel")

      // The plugin behind `demo:panel` is disabled — reconcile hands the scope
      // back to `comments`, which has a remembered width of its own.
      store.getState().reconcilePanels(key, ["comments"], "comments")
      expect(store.getState().layouts[key]?.width).toBe(500)
    })

    it("leaves the width alone on a reconcile that does not change the active panel", () => {
      const store = createContextWorkbenchStoreForTesting()
      const key = "window-a::canvas:doc-1"

      store.getState().navigatePanel(key, "comments", "narrow")
      store.getState().setWidth(key, 500, "comments")
      // A width the user dragged *after* the memory was written must not be
      // reverted by the reconcile that runs on every mount.
      store.getState().setWidth(key, 640)
      store.getState().reconcilePanels(key, ["comments", "review"], "comments")
      expect(store.getState().layouts[key]?.width).toBe(640)
    })

    it("stores the clamped width, so an out-of-bounds drag cannot be replayed later", () => {
      const store = createContextWorkbenchStoreForTesting()
      const key = "window-a::canvas:doc-1"

      store.getState().navigatePanel(key, "comments", "narrow")
      store.getState().setWidth(key, 5000, "comments")
      expect(store.getState().layouts[key]?.panelWidths.comments).toBe(960)

      store.getState().setWidth(key, 10, "comments")
      expect(store.getState().layouts[key]?.panelWidths.comments).toBe(240)
    })

    it("re-clamps and sanitises widths restored from disk", () => {
      const now = Date.now()
      const pruned = pruneContextWorkbenchLayouts(
        {
          "window-a::canvas:doc-1": {
            mode: "narrow",
            width: 360,
            // Out-of-range and non-numeric entries are what a bounds change or a
            // hand-edited localStorage snapshot actually looks like.
            panelWidths: { comments: 5000, inspect: 10, broken: "wide" as unknown as number },
            activePanelId: "comments",
            userPinned: false,
            activatedPanelIds: ["comments"],
            pendingPanelIds: [],
            lastUsedAt: now,
            splitPanelId: null,
            splitRatio: 50,
          },
        },
        now
      )
      expect(pruned["window-a::canvas:doc-1"]?.panelWidths).toEqual({
        comments: 960,
        inspect: 240,
      })
    })

    it("defaults panelWidths for a layout persisted before the field existed", () => {
      const now = Date.now()
      const legacy = {
        "window-a::canvas:doc-1": {
          mode: "narrow" as const,
          width: 360,
          activePanelId: "comments",
          userPinned: false,
          activatedPanelIds: ["comments"],
          pendingPanelIds: [],
          lastUsedAt: now,
        } as unknown as ContextWorkbenchLayout,
      }
      expect(
        pruneContextWorkbenchLayouts(legacy, now)["window-a::canvas:doc-1"]?.panelWidths
      ).toEqual({})
    })
  })

  it("persists and clears an explicit resource-session reassociation", () => {
    const store = createContextWorkbenchStoreForTesting()
    store.getState().setSessionOverride("project:p:r:new.ts", "old-session")
    expect(store.getState().sessionOverrides["project:p:r:new.ts"]).toBe("old-session")
    store.getState().setSessionOverride("project:p:r:new.ts", null)
    expect(store.getState().sessionOverrides["project:p:r:new.ts"]).toBeUndefined()
  })
})
