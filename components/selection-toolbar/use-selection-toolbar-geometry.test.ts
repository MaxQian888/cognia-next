/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const resizeMock = jest.fn()
jest.mock("@/lib/tauri/selection-toolbar", () => ({
  SELECTION_SHADOW_PAD: 20,
  resizeSelectionToolbar: (...args: unknown[]) => resizeMock(...args),
}))

let reduceMotion = false
jest.mock("motion/react", () => ({
  useReducedMotion: () => reduceMotion,
}))

import { useSelectionToolbarGeometry } from "./use-selection-toolbar-geometry"

const make = (rect: Partial<DOMRect>) => {
  const element = document.createElement("div")
  element.getBoundingClientRect = () => ({ ...rect }) as DOMRect
  return element
}

/** Attach elements whose `getBoundingClientRect` we control. */
function mountBoxes(handles: {
  shellRef: React.RefObject<HTMLDivElement | null>
  capsuleRef: React.RefObject<HTMLDivElement | null>
  ghostRef: React.RefObject<HTMLDivElement | null>
}) {
  handles.shellRef.current = make({ width: 200, height: 40, left: 0, top: 0 })
  handles.capsuleRef.current = make({ width: 200, height: 40, left: 20, top: 20 })
  handles.ghostRef.current = make({ width: 320, height: 40, left: 0, top: 0 })
}

/** Open the language list, which mounts as a sibling of the capsule. */
function attachPanel(
  handles: { panelRef: React.RefObject<HTMLElement | null> },
  rect: Partial<DOMRect>
) {
  handles.panelRef.current = make(rect)
}

function setRect(ref: React.RefObject<HTMLDivElement | null>, rect: Partial<DOMRect>) {
  ref.current!.getBoundingClientRect = () => ({ ...rect }) as DOMRect
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  reduceMotion = false
  resizeMock.mockResolvedValue({ placement: "above" })
})

afterEach(() => {
  jest.useRealTimers()
})

describe("useSelectionToolbarGeometry", () => {
  it("sizes the window to the widest hover state plus shadow padding", async () => {
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    await act(async () => {
      rerender({ key: "b" })
    })

    // Ghost (320) beats the collapsed shell (200), so the window never has to
    // resize while the pointer sweeps the row.
    expect(resizeMock).toHaveBeenCalledWith(320 + 40, 40 + 40, [
      { x: 20, y: 20, width: 200, height: 40 },
    ])
  })

  it("reports the capsule rect, not the window box, so the padding is not a dead zone", async () => {
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    await act(async () => {
      rerender({ key: "b" })
    })
    const [width, height, [capsule]] = resizeMock.mock.calls[0]
    expect(capsule.width).toBeLessThan(width)
    expect(capsule.height).toBeLessThan(height)
  })

  it("reports the open language list as a second rect, so clicking it is not a click away", async () => {
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    await act(async () => {
      rerender({ key: "b" })
    })
    expect(resizeMock.mock.calls[0][2]).toHaveLength(1)

    // The list is a sibling of the capsule with the shell's gap between them,
    // so its rect has to travel separately — a bounding box would hand Rust
    // that gap, and the corners beside the narrower of the two, as "inside".
    attachPanel(result.current, { width: 160, height: 120, left: 40, top: 148 })
    await act(async () => {
      rerender({ key: "locale-open" })
    })
    expect(resizeMock.mock.calls[1][2]).toEqual([
      { x: 20, y: 20, width: 200, height: 40 },
      { x: 40, y: 148, width: 160, height: 120 },
    ])

    // Closing it drops the rect again, rather than leaving a stale hit target
    // over whatever the user clicks next.
    result.current.panelRef.current = null
    await act(async () => {
      rerender({ key: "locale-closed" })
    })
    expect(resizeMock.mock.calls[2][2]).toHaveLength(1)
  })

  it("surfaces the placement Rust chose", async () => {
    resizeMock.mockResolvedValue({ placement: "below" })
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    await act(async () => {
      rerender({ key: "b" })
    })
    expect(result.current.placement).toBe("below")
    expect(result.current.measured).toBe(true)
  })

  it("does not re-send an unchanged measurement", async () => {
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    await act(async () => {
      rerender({ key: "b" })
    })
    await act(async () => {
      rerender({ key: "c" })
    })
    expect(resizeMock).toHaveBeenCalledTimes(1)
  })

  it("grows immediately but defers shrinking until the collapse animation ends", async () => {
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    await act(async () => {
      rerender({ key: "b" })
    })
    expect(resizeMock).toHaveBeenCalledTimes(1)

    // Language panel opens: taller. Applied at once so the panel is never clipped.
    setRect(result.current.shellRef, { width: 200, height: 200, left: 0, top: 0 })
    await act(async () => {
      rerender({ key: "open" })
    })
    expect(resizeMock).toHaveBeenCalledTimes(2)
    expect(resizeMock.mock.calls[1][1]).toBe(200 + 40)

    // Panel closes: shorter. Held back so the window does not crop the
    // collapse mid-flight.
    setRect(result.current.shellRef, { width: 200, height: 40, left: 0, top: 0 })
    await act(async () => {
      rerender({ key: "closed" })
    })
    expect(resizeMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      jest.advanceTimersByTime(220)
    })
    expect(resizeMock).toHaveBeenCalledTimes(3)
    expect(resizeMock.mock.calls[2][1]).toBe(40 + 40)
  })

  it("shrinks without delay under reduced motion, since nothing is animating", async () => {
    reduceMotion = true
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    await act(async () => {
      rerender({ key: "b" })
    })
    setRect(result.current.shellRef, { width: 200, height: 20, left: 0, top: 0 })
    await act(async () => {
      rerender({ key: "small" })
    })
    expect(resizeMock).toHaveBeenCalledTimes(2)
  })

  it("sends a hit-rect-only change straight away, because nothing moves on screen", async () => {
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    await act(async () => {
      rerender({ key: "b" })
    })
    // Hovering widens the capsule inside an unchanged window.
    setRect(result.current.capsuleRef, { width: 260, height: 40, left: 0, top: 20 })
    await act(async () => {
      rerender({ key: "hover" })
    })
    expect(resizeMock).toHaveBeenCalledTimes(2)
    expect(resizeMock.mock.calls[1][2][0].width).toBe(260)
  })

  it("stays quiet until the refs are attached", async () => {
    const { rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    await act(async () => {
      rerender({ key: "b" })
    })
    expect(resizeMock).not.toHaveBeenCalled()
  })

  it("abandons a pending shrink when the content changes again first", async () => {
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    await act(async () => {
      rerender({ key: "b" })
    })

    setRect(result.current.shellRef, { width: 200, height: 20, left: 0, top: 0 })
    await act(async () => {
      rerender({ key: "shrinking" })
    })
    expect(resizeMock).toHaveBeenCalledTimes(1)

    // The panel re-opens before the shrink lands: the stale small size must
    // never be sent, or the window would crop the panel it just grew for.
    setRect(result.current.shellRef, { width: 200, height: 300, left: 0, top: 0 })
    await act(async () => {
      rerender({ key: "regrown" })
    })
    await act(async () => {
      jest.advanceTimersByTime(500)
    })
    expect(resizeMock).toHaveBeenCalledTimes(2)
    expect(resizeMock.mock.calls[1][1]).toBe(300 + 40)
  })

  it("keeps a placeholder placement when there is no candidate to anchor to", async () => {
    resizeMock.mockResolvedValue({ placement: "above" })
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    await act(async () => {
      rerender({ key: "b" })
    })
    expect(result.current.placement).toBe("above")
  })

  it("uses the shell width when it already exceeds the widest hover state", async () => {
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    // An open language panel can be wider than any hover state.
    setRect(result.current.shellRef, { width: 500, height: 240, left: 0, top: 0 })
    await act(async () => {
      rerender({ key: "wide" })
    })
    expect(resizeMock.mock.calls[0][0]).toBe(500 + 40)
  })

  it("treats a zero-sized element as not yet laid out", async () => {
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    // A capsule mid-mount measures 0x0; sending that would collapse the window.
    setRect(result.current.capsuleRef, { width: 0, height: 0, left: 0, top: 0 })
    await act(async () => {
      rerender({ key: "b" })
    })
    expect(resizeMock).not.toHaveBeenCalled()
  })

  it("falls back to the shell width when the ghost has not rendered", async () => {
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    result.current.ghostRef.current = null
    await act(async () => {
      rerender({ key: "b" })
    })
    expect(resizeMock.mock.calls[0][0]).toBe(200 + 40)
  })

  it("cancels a pending shrink on unmount rather than firing into a dead window", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ key }) => useSelectionToolbarGeometry(key),
      { initialProps: { key: "a" } }
    )
    mountBoxes(result.current)
    await act(async () => {
      rerender({ key: "b" })
    })
    setRect(result.current.shellRef, { width: 200, height: 20, left: 0, top: 0 })
    await act(async () => {
      rerender({ key: "shrinking" })
    })
    expect(resizeMock).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {
      jest.advanceTimersByTime(500)
    })
    expect(resizeMock).toHaveBeenCalledTimes(1)
  })

  it("re-measures on demand when nothing else changed", async () => {
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    await act(async () => {
      rerender({ key: "b" })
    })
    setRect(result.current.shellRef, { width: 400, height: 40, left: 0, top: 0 })
    await act(async () => {
      result.current.remeasure()
    })
    expect(resizeMock).toHaveBeenCalledTimes(2)
  })

  it("still reveals the window when the resize call is rejected", async () => {
    // `measured` gates the reveal. Leaving it false on a rejected resize is
    // how a missing ACL grant turned into a toolbar that never appeared at
    // all — a wrongly-sized toolbar beats an invisible one.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    resizeMock.mockRejectedValueOnce(new Error("Command not found"))
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    await act(async () => {
      rerender({ key: "b" })
    })
    expect(result.current.measured).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("retries the same box after a rejected resize instead of deduping it away", async () => {
    // The equality guard normally suppresses an unchanged measurement. A
    // rejected send never landed, so it must not count as sent.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    resizeMock.mockRejectedValueOnce(new Error("Command not found"))
    const { result, rerender } = renderHook(({ key }) => useSelectionToolbarGeometry(key), {
      initialProps: { key: "a" },
    })
    mountBoxes(result.current)
    await act(async () => {
      rerender({ key: "b" })
    })
    await act(async () => {
      result.current.remeasure()
    })
    expect(resizeMock).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
