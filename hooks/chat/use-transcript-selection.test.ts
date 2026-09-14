/** @jest-environment jsdom */

import { createElement, type ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"

import {
  TranscriptSelectionHostContext,
  useTranscriptSelection,
  useTranscriptSelectionHost,
} from "./use-transcript-selection"

const IDS = ["m1", "m2", "m3", "m4"]

function setup(sessionId: string | null = "s1", selectableIds: readonly string[] = IDS) {
  return renderHook((props) => useTranscriptSelection(props), {
    initialProps: { sessionId, selectableIds },
  })
}

const ticked = (selected: ReadonlySet<string>) => [...selected].sort()

describe("useTranscriptSelection", () => {
  it("starts off, and a tick turns the mode on", () => {
    const { result } = setup()
    expect(result.current.active).toBe(false)
    act(() => result.current.toggle("m2"))
    expect(result.current.active).toBe(true)
    expect(ticked(result.current.selected)).toEqual(["m2"])
  })

  // A plain click in this mode must not throw away what was already picked.
  it("adds and removes with plain clicks", () => {
    const { result } = setup()
    act(() => result.current.toggle("m1"))
    act(() => result.current.toggle("m3"))
    expect(ticked(result.current.selected)).toEqual(["m1", "m3"])
    act(() => result.current.toggle("m1"))
    expect(ticked(result.current.selected)).toEqual(["m3"])
  })

  it("extends a range with Shift, keeping earlier ticks", () => {
    const { result } = setup("s1", ["m0", ...IDS])
    act(() => result.current.toggle("m0"))
    act(() => result.current.toggle("m2"))
    act(() => result.current.toggle("m4", { shiftKey: true }))
    expect(ticked(result.current.selected)).toEqual(["m0", "m2", "m3", "m4"])
  })

  it("selects all, clears while staying on, and exits", () => {
    const { result } = setup()
    act(() => result.current.toggle("m1"))
    act(() => result.current.selectAll())
    expect(ticked(result.current.selected)).toEqual(IDS)
    act(() => result.current.clear())
    expect(result.current.selected.size).toBe(0)
    expect(result.current.active).toBe(true)
    act(() => result.current.exit())
    expect(result.current.active).toBe(false)
  })

  it("forgets a message that leaves the transcript", () => {
    const { result, rerender } = setup()
    act(() => result.current.toggle("m2"))
    act(() => result.current.toggle("m3"))
    rerender({ sessionId: "s1", selectableIds: ["m1", "m3", "m4"] })
    expect(ticked(result.current.selected)).toEqual(["m3"])
    expect(result.current.isSelectable("m2")).toBe(false)
  })

  it("ends the mode when the transcript shows another conversation", () => {
    const { result, rerender } = setup()
    act(() => result.current.toggle("m2"))
    rerender({ sessionId: "s2", selectableIds: IDS })
    expect(result.current.active).toBe(false)
    expect(result.current.selected.size).toBe(0)
  })

  describe("start, from a message's menu", () => {
    it("opens the mode with that message ticked", () => {
      const { result } = setup()
      act(() => result.current.start("m3"))
      expect(result.current.active).toBe(true)
      expect(ticked(result.current.selected)).toEqual(["m3"])
    })

    // A toggle would untick it; "Select" on a ticked message means keep it.
    it("does not untick a message that is already ticked", () => {
      const { result } = setup()
      act(() => result.current.toggle("m3"))
      act(() => result.current.start("m3"))
      expect(ticked(result.current.selected)).toEqual(["m3"])
    })

    it("opens the mode without a tick for a message it cannot select", () => {
      const { result } = setup()
      act(() => result.current.start("streaming-tail"))
      expect(result.current.active).toBe(true)
      expect(result.current.selected.size).toBe(0)
    })
  })
})

describe("useTranscriptSelectionHost", () => {
  // A read-only transcript renders the same message component with no mode to
  // open, so the menu must be able to tell.
  it("is null outside a transcript that provides it", () => {
    const { result } = renderHook(() => useTranscriptSelectionHost())
    expect(result.current).toBeNull()
  })

  it("reaches the providing transcript's start", () => {
    const start = jest.fn()
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(TranscriptSelectionHostContext.Provider, { value: { start } }, children)
    const { result } = renderHook(() => useTranscriptSelectionHost(), { wrapper })
    result.current!.start("m1")
    expect(start).toHaveBeenCalledWith("m1")
  })
})
