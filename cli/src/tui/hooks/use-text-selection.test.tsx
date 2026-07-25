import React from "react"
import { act, render } from "@testing-library/react"

import { useTextSelection, type UseTextSelectionArgs } from "./use-text-selection"
import type { FrameBuffer } from "../selection/frame-buffer"
import type { SelectionController } from "../selection/selection-controller"

function fakeFrames(lines: string[] = ["hello world"]): FrameBuffer & { emitFrame: () => void } {
  const listeners = new Set<() => void>()
  return {
    stdout: null as never,
    frame: () => lines,
    plain: () => lines,
    raw: () => {},
    onFrame: (cb) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    emitFrame: () => {
      for (const cb of listeners) cb()
    },
  }
}

const NO_MODS = { ctrl: false, alt: false, shift: false }

type ControllerRef = { current: SelectionController | null }

/** Publishes the REF, not a render-time snapshot of `.current`: the hook fills
 * the ref in an effect, so reading `.current` during render is always null. */
function Harness({
  args,
  onRef,
}: {
  args: UseTextSelectionArgs
  onRef: (r: ControllerRef) => void
}) {
  onRef(useTextSelection(args))
  return null
}

function baseArgs(over: Partial<UseTextSelectionArgs> = {}): UseTextSelectionArgs {
  return {
    frames: fakeFrames(),
    mode: "auto-copy",
    copy: () => ({ ok: true }),
    notify: jest.fn(),
    failureMessage: (reason) => `failed: ${reason}`,
    now: () => 1000,
    ...over,
  }
}

/** Render the harness and hand back the controller ref. */
function mount(args: UseTextSelectionArgs) {
  let ref: ControllerRef = { current: null }
  const view = render(<Harness args={args} onRef={(r) => (ref = r)} />)
  return { ...view, ref, args }
}

/** Drag from `(1, from)` to `(1, to)` and let go. */
function dragAndRelease(controller: SelectionController, from: number, to: number): void {
  controller.handleMouse({ kind: "click", row: 1, col: from, mods: NO_MODS })
  controller.handleMouse({ kind: "drag", row: 1, col: to, mods: NO_MODS })
  controller.handleMouse({ kind: "release", row: 1, col: to, mods: NO_MODS })
}

/** Let the controller's copy promise settle (jsdom has no `setImmediate`). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("useTextSelection", () => {
  it("yields no controller when there is no frame buffer", () => {
    const { ref } = mount(baseArgs({ frames: undefined }))
    expect(ref.current).toBeNull()
  })

  it("mounts a controller once a frame buffer is present", () => {
    const { ref } = mount(baseArgs())
    expect(ref.current).not.toBeNull()
  })

  it("reports a completed copy through notify with the character count", async () => {
    const notify = jest.fn()
    const copy = jest.fn(() => ({ ok: true }) as const)
    const { ref } = mount(baseArgs({ notify, copy }))
    act(() => dragAndRelease(ref.current!, 1, 5))
    await act(flush)
    expect(copy).toHaveBeenCalledWith("hello")
    expect(notify).toHaveBeenCalledWith("Copied 5 characters to the clipboard.")
  })

  it("singularises the character count", async () => {
    const notify = jest.fn()
    const { ref } = mount(baseArgs({ notify }))
    act(() => {
      const c = ref.current!
      c.handleMouse({ kind: "click", row: 1, col: 1, mods: NO_MODS })
      // Move away and back: the gesture counts as a drag, but selects one cell.
      c.handleMouse({ kind: "drag", row: 1, col: 3, mods: NO_MODS })
      c.handleMouse({ kind: "drag", row: 1, col: 1, mods: NO_MODS })
      c.handleMouse({ kind: "release", row: 1, col: 1, mods: NO_MODS })
    })
    await act(flush)
    expect(notify).toHaveBeenCalledWith("Copied 1 character to the clipboard.")
  })

  it("routes a clipboard failure through failureMessage", async () => {
    const notify = jest.fn()
    const { ref } = mount(
      baseArgs({ notify, copy: () => ({ ok: false, reason: "unavailable" as const }) })
    )
    act(() => dragAndRelease(ref.current!, 1, 5))
    await act(flush)
    expect(notify).toHaveBeenCalledWith("failed: unavailable")
  })

  it("picks up a mode change without re-creating the controller", () => {
    const args = baseArgs({ mode: "off" })
    const { ref, rerender } = mount(args)
    const first = ref.current
    // `off` declines everything…
    expect(first!.handleMouse({ kind: "click", row: 1, col: 1, mods: NO_MODS })).toBe(false)
    rerender(<Harness args={{ ...args, mode: "manual" }} onRef={() => {}} />)
    expect(ref.current).toBe(first)
    // …and the SAME instance now selects, proving the mode is read live.
    first!.handleMouse({ kind: "click", row: 1, col: 1, mods: NO_MODS })
    first!.handleMouse({ kind: "drag", row: 1, col: 5, mods: NO_MODS })
    expect(first!.hasSelection()).toBe(true)
  })

  it("clears and disposes the controller on unmount", () => {
    const frames = fakeFrames()
    const { ref, unmount } = mount(baseArgs({ frames, mode: "manual" }))
    const held = ref.current!
    held.handleMouse({ kind: "click", row: 1, col: 1, mods: NO_MODS })
    held.handleMouse({ kind: "drag", row: 1, col: 5, mods: NO_MODS })
    expect(held.hasSelection()).toBe(true)
    unmount()
    expect(held.hasSelection()).toBe(false)
    expect(ref.current).toBeNull()
    // The frame subscription is gone, so a later commit reaches nothing.
    expect(() => frames.emitFrame()).not.toThrow()
  })

  it("tears the controller down when the frame buffer goes away", () => {
    const args = baseArgs({ mode: "manual" })
    const { ref, rerender } = mount(args)
    expect(ref.current).not.toBeNull()
    rerender(<Harness args={{ ...args, frames: undefined }} onRef={(r) => Object.assign(ref, r)} />)
    expect(ref.current).toBeNull()
  })
})
