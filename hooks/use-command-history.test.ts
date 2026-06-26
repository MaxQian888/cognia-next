/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import {
  useCommandHistory,
  handleHistoryArrowKey,
  type UseCommandHistory,
} from "./use-command-history"

// Single-line recall: caret is irrelevant (always on the first & last line),
// so pass caret 0 / value length and a collapsed selection.
function up(value: string, caret = 0) {
  return { value, caret, collapsed: true } as const
}
function down(value: string, caret = value.length) {
  return { value, caret, collapsed: true } as const
}

describe("useCommandHistory", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("records non-empty entries (trimmed) and ignores blanks", () => {
    const { result } = renderHook(() => useCommandHistory())
    act(() => result.current.record("  first  "))
    act(() => result.current.record(""))
    act(() => result.current.record("   "))
    act(() => result.current.record("second"))
    expect(result.current.size).toBe(2)
  })

  it("dedups: re-recording an existing entry moves it to the front", () => {
    const { result } = renderHook(() => useCommandHistory())
    act(() => result.current.record("a"))
    act(() => result.current.record("b"))
    act(() => result.current.record("a"))
    expect(result.current.size).toBe(2)
    // Newest first → ↑ returns "a".
    expect(result.current.recall("up", up("draft"))).toBe("a")
  })

  it("↑ walks back newest→oldest and stops at the oldest", () => {
    const { result } = renderHook(() => useCommandHistory())
    act(() => result.current.record("one"))
    act(() => result.current.record("two"))
    act(() => result.current.record("three")) // newest

    expect(result.current.recall("up", up("live"))).toBe("three")
    expect(result.current.recall("up", up("three"))).toBe("two")
    expect(result.current.recall("up", up("two"))).toBe("one")
    // Clamped at the oldest.
    expect(result.current.recall("up", up("one"))).toBe("one")
  })

  it("↓ walks forward and restores the stashed draft past the newest", () => {
    const { result } = renderHook(() => useCommandHistory())
    act(() => result.current.record("one"))
    act(() => result.current.record("two"))

    expect(result.current.recall("up", up("my draft"))).toBe("two") // stash "my draft"
    expect(result.current.recall("up", up("two"))).toBe("one")
    expect(result.current.recall("down", down("one"))).toBe("two")
    // Past the newest → the stashed live draft returns.
    expect(result.current.recall("down", down("two"))).toBe("my draft")
  })

  it("↓ does nothing (null) when not navigating", () => {
    const { result } = renderHook(() => useCommandHistory())
    act(() => result.current.record("one"))
    expect(result.current.recall("down", down("anything"))).toBeNull()
  })

  it("↑ returns null with no history so the default arrow behavior runs", () => {
    const { result } = renderHook(() => useCommandHistory())
    expect(result.current.recall("up", up("draft"))).toBeNull()
  })

  it("noteEdit() exits recall mode so the next ↑ re-stashes the live draft", () => {
    const { result } = renderHook(() => useCommandHistory())
    act(() => result.current.record("one"))
    act(() => result.current.record("two"))

    expect(result.current.recall("up", up("draftA"))).toBe("two")
    act(() => result.current.noteEdit())
    // Fresh engagement stashes the new draft, restored on ↓ past newest.
    expect(result.current.recall("up", up("draftB"))).toBe("two")
    expect(result.current.recall("down", down("two"))).toBe("draftB")
  })

  it("does not recall while a selection is active (collapsed: false)", () => {
    const { result } = renderHook(() => useCommandHistory())
    act(() => result.current.record("one"))
    expect(result.current.recall("up", { value: "x", caret: 0, collapsed: false })).toBeNull()
  })

  describe("multi-line gating", () => {
    it("↑ only steps history on the first line, else lets the caret move up", () => {
      const { result } = renderHook(() => useCommandHistory())
      act(() => result.current.record("past"))
      const value = "line1\nline2"
      // Caret on the second line → null (default line-up movement).
      expect(
        result.current.recall("up", { value, caret: value.length, collapsed: true })
      ).toBeNull()
      // Caret on the first line → recall.
      expect(result.current.recall("up", { value, caret: 2, collapsed: true })).toBe("past")
    })

    it("↓ only steps forward on the last line while navigating", () => {
      const { result } = renderHook(() => useCommandHistory())
      act(() => result.current.record("a"))
      act(() => result.current.record("b"))
      // Engage history.
      expect(result.current.recall("up", up("draft"))).toBe("b")
      expect(result.current.recall("up", up("b"))).toBe("a")
      const recalled = "x\ny"
      // Caret on the first line of a recalled multi-line value → null.
      expect(
        result.current.recall("down", { value: recalled, caret: 1, collapsed: true })
      ).toBeNull()
      // Caret on the last line → step forward.
      expect(
        result.current.recall("down", { value: recalled, caret: recalled.length, collapsed: true })
      ).toBe("b")
    })
  })

  describe("persistence", () => {
    it("mirrors entries to localStorage under persistKey (capped)", () => {
      const { result } = renderHook(() => useCommandHistory({ persistKey: "k", limit: 2 }))
      act(() => result.current.record("a"))
      act(() => result.current.record("b"))
      act(() => result.current.record("c"))
      const stored = JSON.parse(window.localStorage.getItem("k") ?? "[]")
      expect(stored).toEqual(["c", "b"]) // newest first, capped at 2
      expect(result.current.size).toBe(2)
    })

    it("hydrates initial entries from localStorage", () => {
      window.localStorage.setItem("k", JSON.stringify(["seed2", "seed1"]))
      const { result } = renderHook(() => useCommandHistory({ persistKey: "k" }))
      expect(result.current.size).toBe(2)
      expect(result.current.recall("up", up("draft"))).toBe("seed2")
    })

    it("ignores malformed persisted JSON", () => {
      window.localStorage.setItem("k", "{not json")
      const { result } = renderHook(() => useCommandHistory({ persistKey: "k" }))
      expect(result.current.size).toBe(0)
    })

    it("ignores a persisted non-array value", () => {
      window.localStorage.setItem("k", JSON.stringify({ a: 1 }))
      const { result } = renderHook(() => useCommandHistory({ persistKey: "k" }))
      expect(result.current.size).toBe(0)
    })

    it("reloads when the persistKey changes", () => {
      window.localStorage.setItem("k1", JSON.stringify(["one"]))
      window.localStorage.setItem("k2", JSON.stringify(["two", "alsotwo"]))
      const { result, rerender } = renderHook(({ key }) => useCommandHistory({ persistKey: key }), {
        initialProps: { key: "k1" },
      })
      expect(result.current.size).toBe(1)
      rerender({ key: "k2" })
      expect(result.current.size).toBe(2)
      expect(result.current.recall("up", up("draft"))).toBe("two")
    })

    it("stays in-memory only with no persistKey", () => {
      const { result } = renderHook(() => useCommandHistory())
      act(() => result.current.record("a"))
      expect(window.localStorage.length).toBe(0)
    })
  })
})

describe("handleHistoryArrowKey", () => {
  function stubHistory(recallReturn: string | null): UseCommandHistory {
    return {
      recall: jest.fn(() => recallReturn),
      noteEdit: jest.fn(),
      record: jest.fn(),
      size: 0,
    }
  }

  function fakeEvent(
    key: string,
    opts: {
      value?: string
      selectionStart?: number
      selectionEnd?: number
      isComposing?: boolean
      setSelectionRange?: jest.Mock
      focus?: jest.Mock
    } = {}
  ) {
    const el = {
      value: opts.value ?? "",
      selectionStart: opts.selectionStart ?? 0,
      selectionEnd: opts.selectionEnd ?? 0,
      setSelectionRange: opts.setSelectionRange ?? jest.fn(),
      focus: opts.focus ?? jest.fn(),
    }
    return {
      event: {
        key,
        currentTarget: el,
        nativeEvent: { isComposing: opts.isComposing ?? false },
        preventDefault: jest.fn(),
      } as unknown as ReactKeyboardEvent<HTMLTextAreaElement>,
      el,
    }
  }

  const flushRaf = () => act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())))

  it("ignores non-arrow keys", () => {
    const history = stubHistory("x")
    const setValue = jest.fn()
    const { event } = fakeEvent("Enter")
    expect(handleHistoryArrowKey(event, history, setValue)).toBe(false)
    expect(history.recall).not.toHaveBeenCalled()
    expect(setValue).not.toHaveBeenCalled()
  })

  it("ignores arrows while an IME composition is active", () => {
    const history = stubHistory("x")
    const setValue = jest.fn()
    const { event } = fakeEvent("ArrowUp", { isComposing: true })
    expect(handleHistoryArrowKey(event, history, setValue)).toBe(false)
    expect(history.recall).not.toHaveBeenCalled()
  })

  it("returns false (no preventDefault) when recall declines", () => {
    const history = stubHistory(null)
    const setValue = jest.fn()
    const { event } = fakeEvent("ArrowDown", {
      value: "mid\nline",
      selectionStart: 2,
      selectionEnd: 2,
    })
    expect(handleHistoryArrowKey(event, history, setValue)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(setValue).not.toHaveBeenCalled()
  })

  it("applies a recalled value, preventing default and restoring the caret", async () => {
    const history = stubHistory("recalled")
    const setValue = jest.fn()
    const setSelectionRange = jest.fn()
    const focus = jest.fn()
    const { event, el } = fakeEvent("ArrowUp", { setSelectionRange, focus })
    expect(handleHistoryArrowKey(event, history, setValue)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(setValue).toHaveBeenCalledWith("recalled")
    await flushRaf()
    expect(setSelectionRange).toHaveBeenCalledWith("recalled".length, "recalled".length)
    expect(focus).toHaveBeenCalled()
    expect(el.value).toBe("") // helper never mutates the DOM value directly
  })

  it("swallows a caret-restore error when the element detached", async () => {
    const history = stubHistory("recalled")
    const setValue = jest.fn()
    const setSelectionRange = jest.fn(() => {
      throw new Error("detached")
    })
    const { event } = fakeEvent("ArrowUp", { setSelectionRange })
    expect(handleHistoryArrowKey(event, history, setValue)).toBe(true)
    expect(setValue).toHaveBeenCalledWith("recalled")
    await expect(flushRaf()).resolves.toBeUndefined()
  })
})
