/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { SHELL_DOCK_DURATION_MS } from "@/lib/ui/shell-dock-motion"

import { useEdgePanelTransition } from "./use-edge-panel-transition"

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe("useEdgePanelTransition", () => {
  it("stays off until the panel's state actually changes", () => {
    const { result } = renderHook(({ open }) => useEdgePanelTransition(open), {
      initialProps: { open: false },
    })
    expect(result.current).toBe(false)
  })

  it("arms on the same render the state flips, so the class and the size land together", () => {
    const { result, rerender } = renderHook(({ open }) => useEdgePanelTransition(open), {
      initialProps: { open: false },
    })
    rerender({ open: true })
    expect(result.current).toBe(true)
  })

  it("stands down once the animation has run", () => {
    const { result, rerender } = renderHook(({ open }) => useEdgePanelTransition(open), {
      initialProps: { open: false },
    })
    rerender({ open: true })
    act(() => {
      jest.advanceTimersByTime(SHELL_DOCK_DURATION_MS * 2)
    })
    expect(result.current).toBe(false)
  })

  it("stays off for a resize, which reuses the same CSS property", () => {
    // A standing transition would rubber-band a drag against the pointer.
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean; size: number }) => useEdgePanelTransition(open),
      { initialProps: { open: true, size: 200 } }
    )
    rerender({ open: true, size: 340 })
    expect(result.current).toBe(false)
  })

  it("restarts the window when a toggle arrives mid-animation", () => {
    const { result, rerender } = renderHook(({ open }) => useEdgePanelTransition(open), {
      initialProps: { open: false },
    })
    rerender({ open: true })
    act(() => {
      jest.advanceTimersByTime(SHELL_DOCK_DURATION_MS * 0.8)
    })
    rerender({ open: false })
    // The second toggle must not inherit what was left of the first's timer.
    act(() => {
      jest.advanceTimersByTime(SHELL_DOCK_DURATION_MS * 0.5)
    })
    expect(result.current).toBe(true)
    act(() => {
      jest.advanceTimersByTime(SHELL_DOCK_DURATION_MS * 2)
    })
    expect(result.current).toBe(false)
  })

  it("scales the window with the motion-speed preference", () => {
    const element = document.createElement("div")
    element.style.setProperty("--motion-duration-scale", "3")
    document.body.append(element)
    const { result, rerender } = renderHook(
      ({ open }) => useEdgePanelTransition(open, { element }),
      {
        initialProps: { open: false },
      }
    )
    rerender({ open: true })
    act(() => {
      jest.advanceTimersByTime(SHELL_DOCK_DURATION_MS * 2)
    })
    // A fixed timer would have dropped the class here, snapping the last third.
    expect(result.current).toBe(true)
    act(() => {
      jest.advanceTimersByTime(SHELL_DOCK_DURATION_MS * 2)
    })
    expect(result.current).toBe(false)
    element.remove()
  })

  it("reports nothing while disabled, for a hand-off that must land instantly", () => {
    const { result, rerender } = renderHook(
      ({ open, enabled }) => useEdgePanelTransition(open, { enabled }),
      { initialProps: { open: false, enabled: false } }
    )
    rerender({ open: true, enabled: false })
    expect(result.current).toBe(false)
  })
})
