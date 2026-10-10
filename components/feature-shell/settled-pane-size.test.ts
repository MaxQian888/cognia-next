/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { useSettledPaneSize } from "./settled-pane-size"

const size = (inPixels: number) => ({ asPercentage: 0, inPixels })

describe("useSettledPaneSize", () => {
  it("reports the last dragged width once the layout settles", () => {
    const onSizeChange = jest.fn()
    const { result } = renderHook(() => useSettledPaneSize(onSizeChange))
    act(() => {
      result.current.onResize(size(250), "left", size(248))
      result.current.onResize(size(300), "left", size(250))
    })
    expect(onSizeChange).not.toHaveBeenCalled()
    act(() => result.current.flush())
    expect(onSizeChange).toHaveBeenCalledTimes(1)
    expect(onSizeChange).toHaveBeenCalledWith(300)
    act(() => result.current.flush())
    expect(onSizeChange).toHaveBeenCalledTimes(1)
  })

  it("ignores the mount call and collapsed widths", () => {
    const onSizeChange = jest.fn()
    const { result } = renderHook(() => useSettledPaneSize(onSizeChange))
    act(() => {
      result.current.onResize(size(248), "left", undefined)
      result.current.flush()
      result.current.onResize(size(0), "left", size(248))
      result.current.flush()
    })
    expect(onSizeChange).not.toHaveBeenCalled()
  })

  it("is inert without a listener", () => {
    const { result } = renderHook(() => useSettledPaneSize(undefined))
    expect(() =>
      act(() => {
        result.current.onResize(size(260), "left", size(248))
        result.current.flush()
      })
    ).not.toThrow()
  })
})
