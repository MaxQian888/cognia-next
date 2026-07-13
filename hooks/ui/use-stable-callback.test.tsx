/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import { useStableCallback } from "./use-stable-callback"

describe("useStableCallback", () => {
  it("keeps the same identity across re-renders with changing closures", () => {
    const { result, rerender } = renderHook(({ value }) => useStableCallback(() => value), {
      initialProps: { value: 1 },
    })
    const first = result.current
    rerender({ value: 2 })
    expect(result.current).toBe(first)
  })

  it("invokes the latest closure, not the one from the first render", () => {
    const { result, rerender } = renderHook(({ value }) => useStableCallback(() => value), {
      initialProps: { value: 1 },
    })
    const stable = result.current
    expect(stable()).toBe(1)
    rerender({ value: 42 })
    expect(stable()).toBe(42)
  })

  it("forwards arguments and the return value", () => {
    const impl = jest.fn((a: number, b: string) => `${b}:${a}`)
    const { result } = renderHook(() => useStableCallback(impl))
    expect(result.current(7, "x")).toBe("x:7")
    expect(impl).toHaveBeenCalledWith(7, "x")
  })
})
