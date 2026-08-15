/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import { useDraftField } from "./use-draft-field"

describe("useDraftField", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("updates the value synchronously and commits on the trailing edge", () => {
    const commit = jest.fn()
    const { result } = renderHook(() => useDraftField("sk-old", commit, { identity: "openai" }))

    act(() => result.current.onChange("s"))
    act(() => result.current.onChange("sk"))
    act(() => result.current.onChange("sk-new"))
    expect(result.current.value).toBe("sk-new")
    expect(result.current.isDirty).toBe(true)
    expect(commit).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(400)
    })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith("sk-new")
  })

  it("commits immediately on blur and on Enter", () => {
    const commit = jest.fn()
    const { result } = renderHook(() => useDraftField("", commit, { identity: "openai" }))

    act(() => result.current.onChange("abc"))
    act(() => result.current.onBlur())
    expect(commit).toHaveBeenLastCalledWith("abc")

    act(() => result.current.onChange("abcd"))
    act(() =>
      result.current.onKeyDown({ key: "Enter" } as unknown as React.KeyboardEvent<HTMLElement>)
    )
    expect(commit).toHaveBeenLastCalledWith("abcd")
    // Non-Enter keys do nothing.
    act(() => result.current.onChange("abcde"))
    act(() => result.current.onKeyDown({ key: "a" } as unknown as React.KeyboardEvent<HTMLElement>))
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it("re-hydrates when the identity changes and drops the pending draft", () => {
    const commit = jest.fn()
    const { result, rerender } = renderHook(
      ({ id, committed }) => useDraftField(committed, commit, { identity: id }),
      { initialProps: { id: "openai", committed: "sk-openai" } }
    )
    act(() => result.current.onChange("typing"))
    rerender({ id: "anthropic", committed: "sk-anthropic" })
    expect(result.current.value).toBe("sk-anthropic")
    expect(result.current.isDirty).toBe(false)
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    // The abandoned draft for openai must not be written to anthropic.
    expect(commit).not.toHaveBeenCalled()
  })

  it("adopts an upstream change when the field is clean, keeps the draft when dirty", () => {
    const commit = jest.fn()
    const { result, rerender } = renderHook(
      ({ committed }) => useDraftField(committed, commit, { identity: "openai" }),
      { initialProps: { committed: "one" } }
    )
    // Clean → upstream wins (e.g. an import rewrote the key).
    rerender({ committed: "two" })
    expect(result.current.value).toBe("two")

    // Dirty → the user's keystrokes win over an unrelated settings write.
    act(() => result.current.onChange("two-typing"))
    rerender({ committed: "three" })
    expect(result.current.value).toBe("two-typing")
    expect(result.current.isDirty).toBe(true)
  })

  it("treats the upstream echo of its own commit as clean", () => {
    const commit = jest.fn()
    const { result, rerender } = renderHook(
      ({ committed }) => useDraftField(committed, commit, { identity: "openai" }),
      { initialProps: { committed: "" } }
    )
    act(() => result.current.onChange("sk-x"))
    act(() => {
      jest.advanceTimersByTime(400)
    })
    expect(commit).toHaveBeenCalledWith("sk-x")
    // Store round-trips the value back.
    rerender({ committed: "sk-x" })
    expect(result.current.isDirty).toBe(false)
    expect(result.current.value).toBe("sk-x")
  })

  it("commits a still-pending draft on unmount", () => {
    const commit = jest.fn()
    const { result, unmount } = renderHook(() => useDraftField("", commit, { identity: "x" }))
    act(() => result.current.onChange("pending"))
    unmount()
    expect(commit).toHaveBeenCalledWith("pending")
  })

  it("commits synchronously when debounceMs is 0", () => {
    const commit = jest.fn()
    const { result } = renderHook(() => useDraftField("", commit, { identity: "x", debounceMs: 0 }))
    act(() => result.current.onChange("now"))
    expect(commit).toHaveBeenCalledWith("now")
  })
})
