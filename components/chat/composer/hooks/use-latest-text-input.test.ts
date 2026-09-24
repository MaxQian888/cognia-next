/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import { useCallback, useState } from "react"

import { useLatestTextInput } from "./use-latest-text-input"

/** Mirrors `PromptInputProvider`: a fresh object per value, stable setters. */
function useProviderText(initial = "") {
  const [value, setValue] = useState(initial)
  const clear = useCallback(() => setValue(""), [])
  return { value, setInput: setValue, clear }
}

describe("useLatestTextInput", () => {
  it("keeps one identity while the text changes", () => {
    const { result } = renderHook(() => {
      const provider = useProviderText("a")
      return { provider, latest: useLatestTextInput(provider) }
    })
    const first = result.current.latest
    act(() => result.current.provider.setInput("ab"))
    act(() => result.current.provider.setInput("abc"))
    expect(result.current.latest).toBe(first)
  })

  it("reads the latest committed text", () => {
    const { result } = renderHook(() => {
      const provider = useProviderText("a")
      return { provider, latest: useLatestTextInput(provider) }
    })
    const handle = result.current.latest
    act(() => result.current.provider.setInput("typed"))
    expect(handle.value).toBe("typed")
  })

  it("makes its own writes readable in the same handler", () => {
    const { result } = renderHook(() => {
      const provider = useProviderText("a")
      return { provider, latest: useLatestTextInput(provider) }
    })
    let seen = ""
    act(() => {
      result.current.latest.setInput("next")
      seen = result.current.latest.value
    })
    expect(seen).toBe("next")
    expect(result.current.provider.value).toBe("next")

    act(() => {
      result.current.latest.clear()
      seen = result.current.latest.value
    })
    expect(seen).toBe("")
    expect(result.current.provider.value).toBe("")
  })

  it("rebuilds only when the provider's setters change", () => {
    const setA = jest.fn()
    const setB = jest.fn()
    const clear = jest.fn()
    const { result, rerender } = renderHook(
      ({ set }) => useLatestTextInput({ value: "x", setInput: set, clear }),
      { initialProps: { set: setA } }
    )
    const first = result.current
    rerender({ set: setA })
    expect(result.current).toBe(first)
    rerender({ set: setB })
    expect(result.current).not.toBe(first)
    result.current.setInput("y")
    expect(setB).toHaveBeenCalledWith("y")
    expect(setA).not.toHaveBeenCalled()
  })
})
