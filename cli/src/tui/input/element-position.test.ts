import type { DOMElement } from "ink"

import { absoluteTopLeft, type InkLayoutNode } from "./element-position"

/** Build a fake Ink/Yoga node chain from leaf → root (each with top/left). */
function node(top: number, left: number, parent?: InkLayoutNode): InkLayoutNode {
  return {
    yogaNode: { getComputedTop: () => top, getComputedLeft: () => left },
    parentNode: parent,
  }
}

describe("absoluteTopLeft", () => {
  it("sums computed top/left up the parent chain", () => {
    const root = node(1, 0)
    const mid = node(2, 3, root)
    const leaf = node(4, 5, mid)
    expect(absoluteTopLeft(leaf as unknown as DOMElement)).toEqual({ top: 7, left: 8 })
  })

  it("returns null for a null node", () => {
    expect(absoluteTopLeft(null)).toBeNull()
  })

  it("returns null when the node has no yogaNode (unlaid-out / test mock)", () => {
    expect(absoluteTopLeft({} as unknown as DOMElement)).toBeNull()
  })

  it("treats missing computed getters as zero", () => {
    const leaf: InkLayoutNode = { yogaNode: {}, parentNode: node(5, 6) }
    expect(absoluteTopLeft(leaf as unknown as DOMElement)).toEqual({ top: 5, left: 6 })
  })
})
