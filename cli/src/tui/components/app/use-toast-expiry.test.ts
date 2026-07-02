import { renderHook } from "@testing-library/react"

import { useToastExpiry, defaultToastTtl, type ToastTimers } from "./use-toast-expiry"
import type { Toast, TuiAction } from "../../state/types"

function fakeTimers() {
  let seq = 0
  const pending = new Map<number, { cb: () => void; ms: number }>()
  const timers: ToastTimers = {
    set: (cb, ms) => {
      const id = ++seq
      pending.set(id, { cb, ms })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clear: (h) => {
      pending.delete(h as unknown as number)
    },
  }
  const fireAll = () => {
    for (const { cb } of [...pending.values()]) cb()
  }
  return { timers, pending, fireAll }
}

const toast = (id: string, severity: Toast["severity"] = "info"): Toast => ({
  id,
  severity,
  message: id,
})

describe("defaultToastTtl", () => {
  it("gives errors the longest TTL", () => {
    expect(defaultToastTtl("error")).toBeGreaterThan(defaultToastTtl("warn"))
    expect(defaultToastTtl("warn")).toBeGreaterThan(defaultToastTtl("info"))
  })
})

describe("useToastExpiry", () => {
  it("schedules a dismiss for each toast using the severity TTL", () => {
    const { timers, pending } = fakeTimers()
    const dispatch = jest.fn()
    renderHook(() =>
      useToastExpiry([toast("a", "error"), toast("b", "info")], dispatch, { timers })
    )
    const durations = [...pending.values()].map((p) => p.ms).sort((x, y) => x - y)
    expect(durations).toEqual([defaultToastTtl("info"), defaultToastTtl("error")])
  })

  it("dispatches TOAST_DISMISS when a timer fires", () => {
    const { timers, fireAll } = fakeTimers()
    const dispatch = jest.fn()
    renderHook(() => useToastExpiry([toast("a")], dispatch, { timers }))
    fireAll()
    expect(dispatch).toHaveBeenCalledWith({ type: "TOAST_DISMISS", id: "a" })
  })

  it("schedules each toast only once across re-renders", () => {
    const { timers, pending } = fakeTimers()
    const dispatch = jest.fn()
    const { rerender } = renderHook(
      (props: { toasts: Toast[] }) => useToastExpiry(props.toasts, dispatch, { timers }),
      { initialProps: { toasts: [toast("a")] } }
    )
    rerender({ toasts: [toast("a"), toast("b")] })
    // One timer for a (scheduled once) + one for the new b = 2 total.
    expect(pending.size).toBe(2)
  })

  it("clears the timer for a toast removed before it fired", () => {
    const { timers, pending } = fakeTimers()
    const dispatch = jest.fn<void, [TuiAction]>()
    const { rerender } = renderHook(
      (props: { toasts: Toast[] }) => useToastExpiry(props.toasts, dispatch, { timers }),
      { initialProps: { toasts: [toast("a")] } }
    )
    expect(pending.size).toBe(1)
    rerender({ toasts: [] })
    expect(pending.size).toBe(0)
  })

  it("clears all pending timers on unmount", () => {
    const { timers, pending } = fakeTimers()
    const { unmount } = renderHook(() =>
      useToastExpiry([toast("a"), toast("b")], jest.fn(), { timers })
    )
    expect(pending.size).toBe(2)
    unmount()
    expect(pending.size).toBe(0)
  })

  it("uses the real global timers by default (schedule, dismiss, and clear on unmount)", () => {
    jest.useFakeTimers()
    try {
      const dispatch = jest.fn()
      // Two toasts: one is allowed to fire (exercises realTimers.set + the
      // dispatch), the hook is then unmounted (exercises realTimers.clear).
      const { rerender, unmount } = renderHook(
        (props: { toasts: Toast[] }) => useToastExpiry(props.toasts, dispatch),
        { initialProps: { toasts: [toast("a", "info"), toast("b", "error")] } }
      )
      jest.advanceTimersByTime(defaultToastTtl("info"))
      expect(dispatch).toHaveBeenCalledWith({ type: "TOAST_DISMISS", id: "a" })
      rerender({ toasts: [toast("b", "error")] })
      unmount() // clears the still-pending "b" timer via realTimers.clear
    } finally {
      jest.useRealTimers()
    }
  })
})
