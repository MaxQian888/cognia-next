import {
  nextDockPosition,
  resolveDropPosition,
  TERMINAL_DOCK_DRAG_ID,
  TERMINAL_DOCK_DROP_IDS,
} from "./dock-position"

describe("resolveDropPosition", () => {
  it("maps each drop zone to its edge", () => {
    expect(resolveDropPosition(TERMINAL_DOCK_DROP_IDS.right, "bottom")).toBe("right")
    expect(resolveDropPosition(TERMINAL_DOCK_DROP_IDS.bottom, "right")).toBe("bottom")
  })

  it("returns null when the drop lands on the zone the dock already occupies", () => {
    // A no-op move would still clear `maximized` and replay the slide.
    expect(resolveDropPosition(TERMINAL_DOCK_DROP_IDS.bottom, "bottom")).toBeNull()
    expect(resolveDropPosition(TERMINAL_DOCK_DROP_IDS.right, "right")).toBeNull()
  })

  it("returns null when the drag was released outside any zone", () => {
    expect(resolveDropPosition(null, "bottom")).toBeNull()
    expect(resolveDropPosition(undefined, "bottom")).toBeNull()
    expect(resolveDropPosition("", "bottom")).toBeNull()
  })

  it("returns null for an unrelated droppable", () => {
    expect(resolveDropPosition("some-other-list", "bottom")).toBeNull()
  })
})

describe("nextDockPosition", () => {
  it("toggles between the two edges", () => {
    expect(nextDockPosition("bottom")).toBe("right")
    expect(nextDockPosition("right")).toBe("bottom")
  })
})

describe("ids", () => {
  it("are distinct and stable", () => {
    expect(TERMINAL_DOCK_DRAG_ID).toBe("terminal-dock")
    expect(new Set(Object.values(TERMINAL_DOCK_DROP_IDS)).size).toBe(2)
    expect(Object.values(TERMINAL_DOCK_DROP_IDS)).not.toContain(TERMINAL_DOCK_DRAG_ID)
  })
})
