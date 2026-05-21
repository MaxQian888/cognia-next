/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import { useResizableLayout } from "./use-resizable-layout"

const KEY = "test-resizable"

beforeEach(() => {
  localStorage.clear()
})

describe("useResizableLayout", () => {
  it("returns undefined defaultLayout when no value is stored", () => {
    const { result } = renderHook(() => useResizableLayout(KEY))
    expect(result.current.defaultLayout).toBeUndefined()
  })

  it("seeds defaultLayout from localStorage on mount", () => {
    localStorage.setItem(KEY, JSON.stringify({ main: 70, detail: 30 }))
    const { result } = renderHook(() => useResizableLayout(KEY))
    expect(result.current.defaultLayout).toEqual({ main: 70, detail: 30 })
  })

  it("ignores malformed JSON or non-numeric values", () => {
    localStorage.setItem(KEY, "{not json")
    const { result } = renderHook(() => useResizableLayout(KEY))
    expect(result.current.defaultLayout).toBeUndefined()

    localStorage.setItem(KEY, JSON.stringify({ main: "x", detail: null }))
    const { result: r2 } = renderHook(() => useResizableLayout(KEY))
    expect(r2.current.defaultLayout).toBeUndefined()
  })

  it("persists onLayoutChanged callbacks to localStorage", () => {
    const { result } = renderHook(() => useResizableLayout(KEY))
    act(() => {
      result.current.onLayoutChanged({ main: 65, detail: 35 })
    })
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ main: 65, detail: 35 })
  })

  it("skips repeated writes of the same layout", () => {
    const spy = jest.spyOn(Storage.prototype, "setItem")
    const { result } = renderHook(() => useResizableLayout(KEY))
    act(() => {
      result.current.onLayoutChanged({ main: 60, detail: 40 })
      result.current.onLayoutChanged({ main: 60, detail: 40 })
    })
    // Only the first changed call should have written.
    const writes = spy.mock.calls.filter((c) => c[0] === KEY)
    expect(writes).toHaveLength(1)
    spy.mockRestore()
  })

  it("survives localStorage exceptions silently", () => {
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error("quota")
    }
    const { result } = renderHook(() => useResizableLayout(KEY))
    expect(() => act(() => result.current.onLayoutChanged({ main: 50, detail: 50 }))).not.toThrow()
    Storage.prototype.setItem = orig
  })
})
