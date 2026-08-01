import { DOCK_MAX_REGIONS, dockViewportClassOf, projectDockLayout } from "./responsive"
import type { DockPanelInstance } from "@/types/dock/instance"

function instances(...ids: string[]): DockPanelInstance[] {
  return ids.map((id) => ({
    instanceId: id,
    panelId: `panel-${id}`,
    kind: "panel" as const,
    mode: "pinned" as const,
    dirty: false,
    activated: true,
  }))
}

describe("dockViewportClassOf", () => {
  it("mirrors the app's breakpoints", () => {
    expect(dockViewportClassOf(375)).toBe("mobile")
    expect(dockViewportClassOf(767)).toBe("mobile")
    expect(dockViewportClassOf(768)).toBe("tablet")
    expect(dockViewportClassOf(1023)).toBe("tablet")
    expect(dockViewportClassOf(1024)).toBe("desktop")
  })
})

describe("projectDockLayout", () => {
  const groups = [
    { instanceIds: ["a"], activeInstanceId: "a" },
    { instanceIds: ["b", "c"], activeInstanceId: "c" },
    { instanceIds: ["d"], activeInstanceId: "d" },
  ]
  const all = instances("a", "b", "c", "d")

  it("leaves a desktop layout exactly as authored", () => {
    const projected = projectDockLayout({ viewport: "desktop", groups, instances: all })
    expect(projected.collapsed).toBe(false)
    expect(projected.regions.map((r) => r.instanceIds)).toEqual([["a"], ["b", "c"], ["d"]])
    expect(projected.regions.every((r) => r.fraction === 1 / 3)).toBe(true)
  })

  it("folds a tablet down to two regions without losing a panel", () => {
    const projected = projectDockLayout({ viewport: "tablet", groups, instances: all })
    expect(projected.collapsed).toBe(true)
    // The overflow joins the *last* surviving region, so the primary surface on
    // the left is left undisturbed.
    expect(projected.regions.map((r) => r.instanceIds)).toEqual([["a"], ["b", "c", "d"]])
    expect(projected.regions).toHaveLength(DOCK_MAX_REGIONS.tablet)
  })

  it("folds a phone down to one region holding every panel", () => {
    const projected = projectDockLayout({ viewport: "mobile", groups, instances: all })
    expect(projected.regions).toHaveLength(1)
    expect(projected.regions[0]?.instanceIds).toEqual(["a", "b", "c", "d"])
    expect(projected.regions[0]?.fraction).toBe(1)
  })

  it("does not report a collapse when nothing had to merge", () => {
    const projected = projectDockLayout({
      viewport: "tablet",
      groups: groups.slice(0, 2),
      instances: all,
    })
    expect(projected.collapsed).toBe(false)
  })

  it("keeps the tab the user is looking at active in its region", () => {
    const projected = projectDockLayout({
      viewport: "tablet",
      groups,
      instances: all,
      activeInstanceId: "d",
    })
    expect(projected.regions[1]?.activeInstanceId).toBe("d")
    // A region that does not hold the active tab keeps its own.
    expect(projected.regions[0]?.activeInstanceId).toBe("a")
  })

  it("falls back to a region's remembered tab, then to its first", () => {
    const projected = projectDockLayout({
      viewport: "desktop",
      groups: [
        { instanceIds: ["b", "c"], activeInstanceId: "c" },
        { instanceIds: ["a"], activeInstanceId: "gone" },
      ],
      instances: all,
      activeInstanceId: "not-here",
    })
    expect(projected.regions[0]?.activeInstanceId).toBe("c")
    expect(projected.regions[1]?.activeInstanceId).toBe("a")
  })

  it("drops ids the instance table no longer knows", () => {
    const projected = projectDockLayout({
      viewport: "desktop",
      groups: [{ instanceIds: ["a", "ghost"] }, { instanceIds: ["ghost-2"] }],
      instances: instances("a"),
    })
    expect(projected.regions).toHaveLength(1)
    expect(projected.regions[0]?.instanceIds).toEqual(["a"])
  })

  it("projects an empty layout to no regions", () => {
    expect(projectDockLayout({ viewport: "mobile", groups: [], instances: [] })).toEqual({
      viewport: "mobile",
      regions: [],
      collapsed: false,
    })
    expect(
      projectDockLayout({ viewport: "desktop", groups: [{ instanceIds: [] }], instances: all })
        .regions
    ).toEqual([])
  })

  it("does not duplicate a panel that already lives in the surviving region", () => {
    const projected = projectDockLayout({
      viewport: "mobile",
      groups: [{ instanceIds: ["a", "b"] }, { instanceIds: ["b", "c"] }],
      instances: all,
    })
    expect(projected.regions[0]?.instanceIds).toEqual(["a", "b", "c"])
  })

  it("never mutates the groups it was handed", () => {
    // The stored layout is always the desktop one; a projection that edited it
    // would lose the user's arrangement the moment they opened a phone.
    const source = [{ instanceIds: ["a"] }, { instanceIds: ["b"] }, { instanceIds: ["c"] }]
    const before = JSON.stringify(source)
    projectDockLayout({ viewport: "mobile", groups: source, instances: all })
    expect(JSON.stringify(source)).toBe(before)
  })
})
