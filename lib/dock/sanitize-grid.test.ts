import { DOCK_PANEL_COMPONENT, DOCK_TAB_COMPONENT, sanitizeDockGrid } from "./sanitize-grid"

const leaf = (id: string, views: string[], activeView?: string, size = 100) => ({
  type: "leaf",
  data: { id, views, ...(activeView ? { activeView } : {}) },
  size,
})

const grid = (
  root: unknown,
  panels: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
) => ({
  grid: { root, width: 800, height: 600, orientation: "HORIZONTAL" },
  panels,
  ...extra,
})

describe("sanitizeDockGrid", () => {
  it("keeps a well-formed grid and normalises its panel entries", () => {
    const result = sanitizeDockGrid(
      grid(leaf("g1", ["a", "b"], "b"), {
        a: { id: "a", contentComponent: "whatever", title: "A" },
        b: { id: "b" },
      }),
      ["a", "b"]
    )
    expect(result.droppedPanelIds).toEqual([])
    expect(result.missingInstanceIds).toEqual([])
    expect(result.grid?.panels).toEqual({
      a: {
        id: "a",
        contentComponent: DOCK_PANEL_COMPONENT,
        tabComponent: DOCK_TAB_COMPONENT,
        title: "A",
        params: {},
      },
      b: {
        id: "b",
        contentComponent: DOCK_PANEL_COMPONENT,
        tabComponent: DOCK_TAB_COMPONENT,
        params: {},
      },
    })
  })

  it("replaces params wholesale rather than filtering them", () => {
    // A hand-edited preset must not be able to reach a renderer's props at all.
    const result = sanitizeDockGrid(
      grid(leaf("g1", ["a"]), {
        a: { id: "a", params: { src: "javascript:alert(1)", nested: { deep: true } } },
      }),
      ["a"]
    )
    expect((result.grid?.panels as Record<string, { params: unknown }>).a.params).toEqual({})
  })

  it("forces the content and tab components to the ones the host registered", () => {
    const result = sanitizeDockGrid(
      grid(leaf("g1", ["a"]), { a: { id: "a", contentComponent: "evil", tabComponent: "evil" } }),
      ["a"]
    )
    const panel = (result.grid?.panels as Record<string, Record<string, unknown>>).a
    expect(panel.contentComponent).toBe(DOCK_PANEL_COMPONENT)
    expect(panel.tabComponent).toBe(DOCK_TAB_COMPONENT)
  })

  it("drops panels the instance table does not know about", () => {
    const result = sanitizeDockGrid(grid(leaf("g1", ["a", "ghost"]), {}), ["a"])
    expect(result.droppedPanelIds).toEqual(["ghost"])
    expect(Object.keys(result.grid?.panels ?? {})).toEqual(["a"])
  })

  it("reports instances the grid never mentions so the host can re-add them", () => {
    const result = sanitizeDockGrid(grid(leaf("g1", ["a"]), {}), ["a", "b"])
    expect(result.missingInstanceIds).toEqual(["b"])
  })

  it("removes a leaf left empty by the pruning", () => {
    const result = sanitizeDockGrid(
      grid({
        type: "branch",
        data: [leaf("g1", ["a"]), leaf("g2", ["ghost"])],
      }),
      ["a"]
    )
    // The surviving single child is hoisted rather than left as a one-child
    // branch, which would render a splitter the user cannot remove.
    expect(result.grid?.grid).toMatchObject({ root: { type: "leaf" } })
  })

  it("returns a null grid when nothing survives", () => {
    const result = sanitizeDockGrid(grid(leaf("g1", ["ghost"]), {}), ["a"])
    expect(result.grid).toBeNull()
    expect(result.missingInstanceIds).toEqual(["a"])
  })

  it("keeps a genuine multi-child branch intact", () => {
    const result = sanitizeDockGrid(
      grid({ type: "branch", size: 300, data: [leaf("g1", ["a"]), leaf("g2", ["b"])] }),
      ["a", "b"]
    )
    const root = (result.grid?.grid as { root: { type: string; data: unknown[] } }).root
    expect(root.type).toBe("branch")
    expect(root.data).toHaveLength(2)
  })

  it("repairs an activeView pointing at a dropped panel", () => {
    const result = sanitizeDockGrid(grid(leaf("g1", ["a", "ghost"], "ghost"), {}), ["a"])
    const root = (result.grid?.grid as { root: { data: { activeView: string } } }).root
    expect(root.data.activeView).toBe("a")
  })

  it("keeps an activeGroup only when that group survived", () => {
    const kept = sanitizeDockGrid(grid(leaf("g1", ["a"]), {}, { activeGroup: "g1" }), ["a"])
    expect(kept.grid?.activeGroup).toBe("g1")

    const stale = sanitizeDockGrid(grid(leaf("g1", ["a"]), {}, { activeGroup: "gone" }), ["a"])
    expect(stale.grid?.activeGroup).toBeUndefined()
  })

  it("drops floating and popout groups rather than restoring stale geometry", () => {
    const result = sanitizeDockGrid(
      grid(
        leaf("g1", ["a"]),
        {},
        {
          floatingGroups: [{ data: { id: "f1" }, position: { top: 0, left: 0 } }],
          popoutGroups: [{ data: { id: "p1" }, url: "http://evil" }],
        }
      ),
      ["a"]
    )
    expect(result.grid).not.toHaveProperty("floatingGroups")
    expect(result.grid).not.toHaveProperty("popoutGroups")
  })

  it("survives every shape of malformed input", () => {
    for (const raw of [null, undefined, 42, "grid", [], {}, { grid: null }, { grid: [] }]) {
      const result = sanitizeDockGrid(raw, ["a"])
      expect(result.grid).toBeNull()
      expect(result.missingInstanceIds).toEqual(["a"])
    }
  })

  it("ignores nodes and views of the wrong type", () => {
    const result = sanitizeDockGrid(
      grid({
        type: "branch",
        data: [
          null,
          "leaf",
          { type: "leaf" },
          { type: "leaf", data: { id: "g1", views: ["a", 7, null] } },
          { type: "unknown", data: {} },
        ],
      }),
      ["a"]
    )
    const root = (result.grid?.grid as { root: { type: string; data: { views: string[] } } }).root
    expect(root.type).toBe("leaf")
    expect(root.data.views).toEqual(["a"])
  })

  it("falls back to sane dimensions and orientation", () => {
    const result = sanitizeDockGrid(
      { grid: { root: leaf("g1", ["a"]), width: "wide", orientation: "VERTICAL" }, panels: {} },
      ["a"]
    )
    expect(result.grid?.grid).toMatchObject({ width: 0, height: 0, orientation: "VERTICAL" })
  })

  it("synthesises a group id when the persisted leaf has none", () => {
    const result = sanitizeDockGrid(grid({ type: "leaf", data: { views: ["a"] } }, {}), ["a"])
    const root = (result.grid?.grid as { root: { data: { id: string } } }).root
    expect(root.data.id).toBe("group-a")
  })

  it("preserves a leaf's locked flag and node sizing", () => {
    const result = sanitizeDockGrid(
      grid({
        type: "branch",
        data: [
          {
            type: "leaf",
            data: { id: "g1", views: ["a"], locked: true },
            size: 120,
            visible: false,
          },
          leaf("g2", ["b"]),
        ],
      }),
      ["a", "b"]
    )
    const root = (result.grid?.grid as { root: { data: Array<Record<string, unknown>> } }).root
    expect(root.data[0]).toMatchObject({ size: 120, visible: false })
    expect((root.data[0] as { data: { locked: boolean } }).data.locked).toBe(true)
  })
  it("hoists a single surviving child while keeping the branch's own size", () => {
    const withSize = sanitizeDockGrid(
      grid({ type: "branch", size: 250, data: [leaf("g1", ["a"], undefined, 90)] }),
      ["a"]
    )
    expect((withSize.grid?.grid as { root: { size: number } }).root.size).toBe(250)

    const withoutSize = sanitizeDockGrid(
      grid({ type: "branch", data: [leaf("g1", ["a"], undefined, 90)] }),
      ["a"]
    )
    expect((withoutSize.grid?.grid as { root: { size: number } }).root.size).toBe(90)
  })

  it("walks nested branches when collecting groups and views", () => {
    const result = sanitizeDockGrid(
      grid(
        {
          type: "branch",
          data: [
            { type: "branch", data: [leaf("g1", ["a"]), leaf("g2", ["b"])] },
            leaf("g3", ["c"]),
          ],
        },
        {},
        { activeGroup: "g2" }
      ),
      ["a", "b", "c"]
    )
    expect(Object.keys(result.grid?.panels ?? {}).sort()).toEqual(["a", "b", "c"])
    expect(result.grid?.activeGroup).toBe("g2")
  })

  it("tolerates a grid whose panels map is not an object", () => {
    const result = sanitizeDockGrid(
      {
        grid: { root: leaf("g1", ["a"]), width: 1, height: 1, orientation: "HORIZONTAL" },
        panels: "nope",
      },
      ["a"]
    )
    expect((result.grid?.panels as Record<string, unknown>).a).toBeDefined()
  })

  it("drops a leaf whose size is not a finite number", () => {
    const result = sanitizeDockGrid(
      grid({
        type: "branch",
        data: [
          { type: "leaf", data: { id: "g1", views: ["a"] }, size: Number.NaN },
          leaf("g2", ["b"]),
        ],
      }),
      ["a", "b"]
    )
    const root = (result.grid?.grid as { root: { data: Array<Record<string, unknown>> } }).root
    expect(root.data[0]).not.toHaveProperty("size")
  })
  it("drops a branch whose data is not an array, and one whose children all vanish", () => {
    expect(sanitizeDockGrid(grid({ type: "branch", data: "nope" }), ["a"]).grid).toBeNull()
    expect(
      sanitizeDockGrid(
        grid({ type: "branch", data: [leaf("g1", ["ghost"]), leaf("g2", ["gone"])] }),
        ["a"]
      ).grid
    ).toBeNull()
  })

  it("drops a leaf whose views are not an array", () => {
    expect(
      sanitizeDockGrid(grid({ type: "leaf", data: { id: "g1", views: "a" } }), ["a"]).grid
    ).toBeNull()
  })
})
