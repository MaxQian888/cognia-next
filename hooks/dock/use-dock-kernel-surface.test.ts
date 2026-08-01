/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import { useDockKernelSurface } from "./use-dock-kernel-surface"

const KEY = "cognia-dock-kernel-surfaces-v1"

beforeEach(() => window.localStorage.clear())

describe("useDockKernelSurface", () => {
  it("reports the flag for the host it was asked about", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ chat: false, project: true }))
    expect(renderHook(() => useDockKernelSurface("chat")).result.current).toBe(false)
    expect(renderHook(() => useDockKernelSurface("project")).result.current).toBe(true)
  })

  it("ships chat on the Dock when nothing has been stored", () => {
    expect(renderHook(() => useDockKernelSurface("chat")).result.current).toBe(true)
  })

  it("holds its answer for the life of the mount", () => {
    // The flag selects the layout *engine*, and the two keep their state in
    // different stores — swapping a live dockview grid for a workbench with
    // panels in flight is a worse failure than needing a reload.
    const { result, rerender } = renderHook(() => useDockKernelSurface("chat"))
    expect(result.current).toBe(true)

    act(() => window.localStorage.setItem(KEY, JSON.stringify({ chat: false })))
    rerender()
    expect(result.current).toBe(true)

    // …and a fresh mount, which is what a reload gives you, picks it up.
    expect(renderHook(() => useDockKernelSurface("chat")).result.current).toBe(false)
  })
})
