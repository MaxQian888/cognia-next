/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import { act } from "@testing-library/react"
import { useAutoSuggestions } from "./use-auto-suggestions"

const aiRef = { current: { autoSuggestions: true, suggestionDelay: 1000 } }
jest.mock("@/stores/canvas/canvas-settings-store", () => ({
  useCanvasSettingsStore: <T>(selector: (s: { settings: { ai: typeof aiRef.current } }) => T): T =>
    selector({ settings: { ai: aiRef.current } }),
}))

describe("useAutoSuggestions", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    aiRef.current = { autoSuggestions: true, suggestionDelay: 1000 }
  })
  afterEach(() => jest.useRealTimers())

  function setup(props: Parameters<typeof useAutoSuggestions>[0]) {
    return renderHook((p: Parameters<typeof useAutoSuggestions>[0]) => useAutoSuggestions(p), {
      initialProps: props,
    })
  }

  it("does not fire on the first content seen for a document", () => {
    const trigger = jest.fn()
    setup({ enabled: true, documentId: "a", content: "hello", trigger })
    act(() => jest.advanceTimersByTime(2000))
    expect(trigger).not.toHaveBeenCalled()
  })

  it("fires after the debounce once content changes within the same document", () => {
    const trigger = jest.fn()
    const { rerender } = setup({ enabled: true, documentId: "a", content: "hello", trigger })
    rerender({ enabled: true, documentId: "a", content: "hello world", trigger })
    act(() => jest.advanceTimersByTime(999))
    expect(trigger).not.toHaveBeenCalled()
    act(() => jest.advanceTimersByTime(1))
    expect(trigger).toHaveBeenCalledTimes(1)
  })

  it("coalesces rapid edits into a single trigger", () => {
    const trigger = jest.fn()
    const { rerender } = setup({ enabled: true, documentId: "a", content: "h", trigger })
    rerender({ enabled: true, documentId: "a", content: "he", trigger })
    act(() => jest.advanceTimersByTime(500))
    rerender({ enabled: true, documentId: "a", content: "hel", trigger })
    act(() => jest.advanceTimersByTime(500))
    expect(trigger).not.toHaveBeenCalled()
    act(() => jest.advanceTimersByTime(500))
    expect(trigger).toHaveBeenCalledTimes(1)
  })

  it("does not fire when disabled or autoSuggestions is off", () => {
    const trigger = jest.fn()
    const { rerender } = setup({ enabled: false, documentId: "a", content: "x", trigger })
    rerender({ enabled: false, documentId: "a", content: "xy", trigger })
    act(() => jest.advanceTimersByTime(2000))
    expect(trigger).not.toHaveBeenCalled()

    aiRef.current.autoSuggestions = false
    const { rerender: rerender2 } = setup({ enabled: true, documentId: "b", content: "x", trigger })
    rerender2({ enabled: true, documentId: "b", content: "xy", trigger })
    act(() => jest.advanceTimersByTime(2000))
    expect(trigger).not.toHaveBeenCalled()
  })

  it("re-primes (no fire) when switching documents", () => {
    const trigger = jest.fn()
    const { rerender } = setup({ enabled: true, documentId: "a", content: "one", trigger })
    rerender({ enabled: true, documentId: "b", content: "two", trigger }) // switch doc
    act(() => jest.advanceTimersByTime(2000))
    expect(trigger).not.toHaveBeenCalled()
  })
})
