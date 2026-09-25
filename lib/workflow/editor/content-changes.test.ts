import type { EdgeChange, NodeChange } from "@xyflow/react"

import { isEdgeEdit, isNodeEdit } from "./content-changes"

describe("isNodeEdit", () => {
  it("counts adds, removals, replacements and moves", () => {
    const edits: NodeChange[] = [
      { type: "add", item: { id: "n", position: { x: 0, y: 0 }, data: {} } },
      { type: "remove", id: "n" },
      { type: "replace", id: "n", item: { id: "n", position: { x: 0, y: 0 }, data: {} } },
      { type: "position", id: "n", position: { x: 1, y: 2 }, dragging: true },
    ]
    for (const change of edits) expect(isNodeEdit(change)).toBe(true)
  })

  it("ignores the measurement React Flow makes after mount", () => {
    expect(
      isNodeEdit({ type: "dimensions", id: "n", dimensions: { width: 200, height: 60 } })
    ).toBe(false)
  })

  it("counts a resize a person made", () => {
    expect(
      isNodeEdit({
        type: "dimensions",
        id: "n",
        dimensions: { width: 320, height: 200 },
        resizing: true,
        setAttributes: true,
      })
    ).toBe(true)
    expect(isNodeEdit({ type: "dimensions", id: "n", setAttributes: "width" })).toBe(true)
  })

  it("never counts selection", () => {
    expect(isNodeEdit({ type: "select", id: "n", selected: true })).toBe(false)
  })
})

describe("isEdgeEdit", () => {
  it("counts structural changes and ignores selection", () => {
    const edge = { id: "e", source: "a", target: "b" }
    const cases: Array<[EdgeChange, boolean]> = [
      [{ type: "add", item: edge }, true],
      [{ type: "remove", id: "e" }, true],
      [{ type: "replace", id: "e", item: edge }, true],
      [{ type: "select", id: "e", selected: true }, false],
    ]
    for (const [change, expected] of cases) expect(isEdgeEdit(change)).toBe(expected)
  })
})
