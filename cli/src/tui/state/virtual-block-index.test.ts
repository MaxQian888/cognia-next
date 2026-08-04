/** @jest-environment node */
import {
  anchorAtRow,
  buildVirtualBlockIndex,
  rowForAnchor,
  virtualWindow,
} from "./virtual-block-index"

describe("VirtualBlockIndex", () => {
  const blocks = [
    { id: "a", rows: 3 },
    { id: "b", rows: 5 },
    { id: "c", rows: 2 },
    { id: "d", rows: 10 },
  ]

  it("builds prefix sums and exact row boundaries", () => {
    const index = buildVirtualBlockIndex(blocks)
    expect(index.prefixRows).toEqual([0, 3, 8, 10, 20])
    expect(index.totalRows).toBe(20)
    expect(anchorAtRow(index, 0)).toEqual({ blockId: "a", intraRow: 0 })
    expect(anchorAtRow(index, 7)).toEqual({ blockId: "b", intraRow: 4 })
    expect(anchorAtRow(index, 19)).toEqual({ blockId: "d", intraRow: 9 })
  })

  it("preserves a block anchor when heights before it change", () => {
    const before = buildVirtualBlockIndex(blocks)
    const anchor = anchorAtRow(before, 9)
    const after = buildVirtualBlockIndex([
      { id: "a", rows: 8 },
      { id: "b", rows: 2 },
      { id: "c", rows: 4 },
      { id: "d", rows: 10 },
    ])
    expect(anchor).toEqual({ blockId: "c", intraRow: 1 })
    expect(rowForAnchor(after, anchor)).toBe(11)
  })

  it("renders only the viewport plus two viewport heights of overscan per side", () => {
    const many = buildVirtualBlockIndex(
      Array.from({ length: 1000 }, (_, i) => ({ id: `b${i}`, rows: 10 }))
    )
    const window = virtualWindow(many, 5000, 24, 2)
    expect(window.start).toBe(495)
    expect(window.end).toBe(508)
    expect(window.padTop + window.renderedRows + window.padBottom).toBe(10_000)
    expect(window.renderedRows).toBeLessThanOrEqual(24 * 5 + 20)
  })

  it("clamps top/bottom windows without losing rows", () => {
    const index = buildVirtualBlockIndex(blocks)
    expect(virtualWindow(index, -100, 5, 2)).toMatchObject({ start: 0, padTop: 0 })
    const bottom = virtualWindow(index, 999, 5, 2)
    expect(bottom.end).toBe(blocks.length)
    expect(bottom.padTop + bottom.renderedRows + bottom.padBottom).toBe(20)
  })
})
