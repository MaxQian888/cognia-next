/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import { act } from "react"

import { useBackDismiss } from "./use-back-dismiss"

describe("useBackDismiss", () => {
  it("does nothing while closed", () => {
    const onDismiss = jest.fn()
    const before = window.history.length
    renderHook(() => useBackDismiss(false, onDismiss))
    expect(window.history.length).toBe(before)
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it("pushes a marker entry on open and dismisses on popstate", () => {
    const onDismiss = jest.fn()
    renderHook(({ open }) => useBackDismiss(open, onDismiss), {
      initialProps: { open: true },
    })
    expect((window.history.state as Record<string, unknown> | null)?.cogniaBackDismiss).toBe(true)
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("pops the marker entry when closed by other means (balanced stack)", () => {
    const backSpy = jest.spyOn(window.history, "back").mockImplementation(() => {})
    try {
      const onDismiss = jest.fn()
      const { rerender } = renderHook(({ open }) => useBackDismiss(open, onDismiss), {
        initialProps: { open: true },
      })
      rerender({ open: false })
      // Closed via scrim/button — the hook must unwind its own history entry.
      expect(backSpy).toHaveBeenCalledTimes(1)
      expect(onDismiss).not.toHaveBeenCalled()
    } finally {
      backSpy.mockRestore()
    }
  })

  it("does not pop the marker when the close came from the back button itself", () => {
    const backSpy = jest.spyOn(window.history, "back").mockImplementation(() => {})
    try {
      const onDismiss = jest.fn()
      const { rerender } = renderHook(({ open }) => useBackDismiss(open, onDismiss), {
        initialProps: { open: true },
      })
      act(() => {
        window.dispatchEvent(new PopStateEvent("popstate"))
      })
      expect(onDismiss).toHaveBeenCalledTimes(1)
      rerender({ open: false })
      expect(backSpy).not.toHaveBeenCalled()
    } finally {
      backSpy.mockRestore()
    }
  })

  it("uses the latest dismiss callback without re-arming the effect", () => {
    const first = jest.fn()
    const second = jest.fn()
    const { rerender } = renderHook(({ cb }: { cb: () => void }) => useBackDismiss(true, cb), {
      initialProps: { cb: first },
    })
    rerender({ cb: second })
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
