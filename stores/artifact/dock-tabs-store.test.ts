/** @jest-environment jsdom */
import {
  artifactTabKey,
  orderDockTabs,
  panelTabKey,
  parseDockTabKey,
  rememberedDockFor,
  useDockTabsStore,
  type DockTabKey,
} from "./dock-tabs-store"
import {
  CONTEXT_WORKBENCH_LAYOUT_LIMIT,
  CONTEXT_WORKBENCH_LAYOUT_MAX_AGE_MS,
} from "@/stores/context-workbench/context-workbench-store"

const A = artifactTabKey("a1")
const B = artifactTabKey("a2")
const P = panelTabKey("browser")
const N = panelTabKey("new-tab")

beforeEach(() => {
  window.localStorage.clear()
  useDockTabsStore.setState({ bySession: {} })
})

describe("tab keys", () => {
  it("round-trips both kinds", () => {
    expect(parseDockTabKey(P)).toEqual({ kind: "panel", panelId: "browser" })
    expect(parseDockTabKey(A)).toEqual({ kind: "artifact", artifactId: "a1" })
    // An artifact id may itself contain a colon.
    expect(parseDockTabKey(artifactTabKey("doc:1"))).toEqual({
      kind: "artifact",
      artifactId: "doc:1",
    })
  })
})

describe("orderDockTabs", () => {
  it("keeps the arrival order when nothing was arranged", () => {
    expect(orderDockTabs(undefined, [P, A, B])).toEqual([P, A, B])
  })

  it("keeps arranged tabs in place, appends newcomers and drops the gone", () => {
    expect(orderDockTabs([B, N, A], [A, B, P])).toEqual([B, A, P])
  })
})

describe("moveTab", () => {
  it("stores the whole strip as drawn, so unarranged tabs stay where they were", () => {
    const strip: DockTabKey[] = [P, A, B]
    useDockTabsStore.getState().moveTab("s1", strip, B, 0)
    expect(useDockTabsStore.getState().bySession.s1.order).toEqual([B, P, A])
  })

  it("ignores a move to the same place or of a tab not on the strip", () => {
    const before = useDockTabsStore.getState()
    before.moveTab("s1", [P, A], P, 0)
    before.moveTab("s1", [P, A], B, 1)
    expect(useDockTabsStore.getState()).toBe(before)
  })

  it("clamps the target into the strip", () => {
    useDockTabsStore.getState().moveTab("s1", [P, A, B], P, 99)
    expect(useDockTabsStore.getState().bySession.s1.order).toEqual([A, B, P])
  })
})

describe("replaceTab", () => {
  it("puts the tool where the New Tab page was", () => {
    useDockTabsStore.getState().replaceTab("s1", [A, N, B], N, P)
    expect(useDockTabsStore.getState().bySession.s1.order).toEqual([A, P, B])
  })

  it("leaves a tool already on the strip in its place", () => {
    useDockTabsStore.getState().replaceTab("s1", [P, A, N], N, P)
    expect(useDockTabsStore.getState().bySession.s1.order).toEqual([P, A])
  })

  it("ignores a tab that is not on the strip", () => {
    const before = useDockTabsStore.getState()
    before.replaceTab("s1", [A], N, P)
    expect(useDockTabsStore.getState()).toBe(before)
  })
})

describe("rememberDock", () => {
  it("remembers the dock per conversation", () => {
    useDockTabsStore.getState().rememberDock("s1", { open: true, dismissed: false })
    useDockTabsStore.getState().rememberDock("s2", { open: false, dismissed: true })
    expect(rememberedDockFor("s1")).toEqual({ open: true, dismissed: false })
    expect(rememberedDockFor("s2")).toEqual({ open: false, dismissed: true })
    expect(rememberedDockFor("s3")).toBeNull()
    expect(rememberedDockFor(null)).toBeNull()
  })

  it("does not churn on an unchanged dock", () => {
    useDockTabsStore.getState().rememberDock("s1", { open: true, dismissed: false })
    const before = useDockTabsStore.getState()
    before.rememberDock("s1", { open: true, dismissed: false })
    expect(useDockTabsStore.getState()).toBe(before)
  })

  it("keeps the arrangement when the dock is remembered, and vice versa", () => {
    useDockTabsStore.getState().moveTab("s1", [P, A], A, 0)
    useDockTabsStore.getState().rememberDock("s1", { open: false, dismissed: false })
    expect(useDockTabsStore.getState().bySession.s1).toMatchObject({
      order: [A, P],
      dock: { open: false, dismissed: false },
    })
  })
})

describe("persistence", () => {
  it("persists the memory and forgets it with the workbench's retention", () => {
    const now = Date.now()
    const entries = Object.fromEntries(
      Array.from({ length: CONTEXT_WORKBENCH_LAYOUT_LIMIT + 5 }, (_, index) => [
        `s${index}`,
        { order: [], dock: { open: true, dismissed: false }, lastUsedAt: now - index },
      ])
    )
    useDockTabsStore.setState({
      bySession: {
        ...entries,
        stale: {
          order: [],
          dock: { open: true, dismissed: false },
          lastUsedAt: now - CONTEXT_WORKBENCH_LAYOUT_MAX_AGE_MS - 1,
        },
      },
    })
    useDockTabsStore.getState().rememberDock("fresh", { open: false, dismissed: true })
    const raw = JSON.parse(window.localStorage.getItem("cognia-dock-tabs-v1") ?? "{}") as {
      state: { bySession: Record<string, unknown> }
    }
    const kept = Object.keys(raw.state.bySession)
    expect(kept).toHaveLength(CONTEXT_WORKBENCH_LAYOUT_LIMIT)
    expect(kept).toContain("fresh")
    expect(kept).not.toContain("stale")
  })
})
