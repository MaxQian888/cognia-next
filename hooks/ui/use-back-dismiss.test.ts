/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import { act } from "react"

import { useBackDismiss } from "./use-back-dismiss"

/** Let the microtask a closing overlay waits on run. */
async function afterCommit() {
  await act(async () => {
    await Promise.resolve()
  })
}

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

  it("pops the marker entry when closed by other means (balanced stack)", async () => {
    const backSpy = jest.spyOn(window.history, "back").mockImplementation(() => {})
    try {
      const onDismiss = jest.fn()
      const { rerender } = renderHook(({ open }) => useBackDismiss(open, onDismiss), {
        initialProps: { open: true },
      })
      rerender({ open: false })
      await afterCommit()
      // Closed via scrim/button — the hook must unwind its own history entry.
      expect(backSpy).toHaveBeenCalledTimes(1)
      expect(onDismiss).not.toHaveBeenCalled()
    } finally {
      backSpy.mockRestore()
    }
  })

  it("does not pop the marker when the close came from the back button itself", async () => {
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
      await afterCommit()
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

  // One commit closes a sheet and opens what its row asked for. A pop the
  // browser delivers after the new overlay is listening would close it.
  describe("an overlay that opens as another closes", () => {
    it("takes over the closing overlay's entry instead of popping and pushing", async () => {
      const backSpy = jest.spyOn(window.history, "back").mockImplementation(() => {})
      const pushSpy = jest.spyOn(window.history, "pushState")
      const replaceSpy = jest.spyOn(window.history, "replaceState")
      try {
        const sheet = jest.fn()
        const next = jest.fn()
        const { rerender } = renderHook(
          ({ a, b }: { a: boolean; b: boolean }) => {
            useBackDismiss(a, sheet)
            useBackDismiss(b, next)
          },
          { initialProps: { a: true, b: false } }
        )
        expect(pushSpy).toHaveBeenCalledTimes(1)
        rerender({ a: false, b: true })
        await afterCommit()
        expect(backSpy).not.toHaveBeenCalled()
        expect(pushSpy).toHaveBeenCalledTimes(1)
        expect(replaceSpy).toHaveBeenCalledWith({ cogniaBackDismiss: true }, "")
        expect(next).not.toHaveBeenCalled()

        // The back button now reaches the overlay that is open.
        act(() => {
          window.dispatchEvent(new PopStateEvent("popstate"))
        })
        expect(next).toHaveBeenCalledTimes(1)
        expect(sheet).not.toHaveBeenCalled()
      } finally {
        backSpy.mockRestore()
        pushSpy.mockRestore()
        replaceSpy.mockRestore()
      }
    })

    it("still pops, and the next overlay pushes, when they are separate commits", async () => {
      const backSpy = jest.spyOn(window.history, "back").mockImplementation(() => {})
      const pushSpy = jest.spyOn(window.history, "pushState")
      try {
        const { rerender } = renderHook(
          ({ a, b }: { a: boolean; b: boolean }) => {
            useBackDismiss(a, jest.fn())
            useBackDismiss(b, jest.fn())
          },
          { initialProps: { a: true, b: false } }
        )
        rerender({ a: false, b: false })
        await afterCommit()
        expect(backSpy).toHaveBeenCalledTimes(1)
        rerender({ a: false, b: true })
        expect(pushSpy).toHaveBeenCalledTimes(2)
      } finally {
        backSpy.mockRestore()
        pushSpy.mockRestore()
      }
    })

    // With two entries closing, the top one belongs to the second; taking it
    // over would leave the first one's pop to remove the new overlay's entry.
    it("takes over nothing when two close at once", async () => {
      const backSpy = jest.spyOn(window.history, "back").mockImplementation(() => {})
      const replaceSpy = jest.spyOn(window.history, "replaceState")
      try {
        const { rerender } = renderHook(
          ({ a, b, c }: { a: boolean; b: boolean; c: boolean }) => {
            useBackDismiss(a, jest.fn())
            useBackDismiss(b, jest.fn())
            useBackDismiss(c, jest.fn())
          },
          { initialProps: { a: true, b: true, c: false } }
        )
        rerender({ a: false, b: false, c: true })
        await afterCommit()
        expect(replaceSpy).not.toHaveBeenCalled()
        expect(backSpy).toHaveBeenCalledTimes(2)
      } finally {
        backSpy.mockRestore()
        replaceSpy.mockRestore()
      }
    })
  })
})
