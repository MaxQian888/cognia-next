/**
 * @jest-environment jsdom
 */
import { createRef } from "react"
import { act, renderHook } from "@testing-library/react"
import { foldMetrics, useOverflowFold } from "./use-overflow-fold"

const box = (top: number, height = 28) => ({ top, height })

describe("foldMetrics", () => {
  it("counts nothing when every chip shares the first row", () => {
    expect(foldMetrics([box(8), box(8), box(8)])).toEqual({ hidden: 0, firstRowBottom: 36 })
  })

  it("counts the chips that wrapped below", () => {
    expect(foldMetrics([box(8), box(8), box(44), box(44), box(80)]).hidden).toBe(3)
  })

  // The row is centred, so a short chip beside a tall one starts LOWER than the
  // row's top. Judging by `top` alone called it a second row and folded a row
  // that fitted.
  it("keeps a short, vertically centred chip on the first row", () => {
    const metrics = foldMetrics([box(15, 15), box(8, 28), box(8, 28), box(44, 28)])
    expect(metrics).toEqual({ hidden: 1, firstRowBottom: 36 })
  })

  it("tolerates sub-pixel drift within a row", () => {
    expect(foldMetrics([box(8, 28), box(8.5, 27.5)]).hidden).toBe(0)
  })

  it("is zero for an empty row", () => {
    expect(foldMetrics([])).toEqual({ hidden: 0, firstRowBottom: 0 })
  })

  // dnd-kit parks a fixed 1×1 live region inside the attachment chips. At
  // `top: -1` it was the topmost box, so the "first row" ended above every real
  // chip and a row that fitted folded completely.
  it("ignores a screen-reader box that is too small to be a chip", () => {
    const metrics = foldMetrics([{ top: -1, height: 1, width: 1 }, box(8), box(8), box(44)])
    expect(metrics).toEqual({ hidden: 1, firstRowBottom: 36 })
  })

  it("is zero when every box is sub-chip sized", () => {
    expect(foldMetrics([{ top: -1, height: 1, width: 1 }])).toEqual({
      hidden: 0,
      firstRowBottom: 0,
    })
  })
})

describe("useOverflowFold", () => {
  it("starts folded with nothing hidden — jsdom lays nothing out", () => {
    const { result } = renderHook(() => useOverflowFold(createRef<HTMLDivElement>()))
    expect(result.current.hiddenCount).toBe(0)
    expect(result.current.expanded).toBe(false)
  })

  it("toggles the expanded flag", () => {
    const { result } = renderHook(() => useOverflowFold(createRef<HTMLDivElement>()))
    act(() => result.current.toggle())
    expect(result.current.expanded).toBe(true)
    act(() => result.current.toggle())
    expect(result.current.expanded).toBe(false)
  })
})
