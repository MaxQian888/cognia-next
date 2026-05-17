/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"
import { useRafThrottle } from "./use-raf-throttle"

interface RafQueue {
  next: (() => void) | null
  rafCalls: number
  cancelCalls: number
}

function installRafMock(): RafQueue {
  const queue: RafQueue = { next: null, rafCalls: 0, cancelCalls: 0 }
  ;(
    globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }
  ).requestAnimationFrame = (cb) => {
    queue.rafCalls++
    queue.next = cb
    return 1
  }
  ;(globalThis as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame =
    () => {
      queue.cancelCalls++
      queue.next = null
    }
  return queue
}

function drain(queue: RafQueue): void {
  const cb = queue.next
  queue.next = null
  if (cb) cb()
}

describe("useRafThrottle", () => {
  let queue: RafQueue
  beforeEach(() => {
    queue = installRafMock()
  })

  it("coalesces multiple call()s into a single frame; latest args win", () => {
    const fn = jest.fn()
    const { result } = renderHook(() => useRafThrottle<[number]>(fn))

    act(() => {
      result.current.call(1)
      result.current.call(2)
      result.current.call(3)
    })

    expect(queue.rafCalls).toBe(1)
    expect(fn).not.toHaveBeenCalled()

    act(() => drain(queue))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(3)
  })

  it("schedules a new frame after the previous one drained", () => {
    const fn = jest.fn()
    const { result } = renderHook(() => useRafThrottle<[number]>(fn))

    act(() => result.current.call(1))
    act(() => drain(queue))
    expect(fn).toHaveBeenCalledWith(1)

    act(() => result.current.call(2))
    expect(queue.rafCalls).toBe(2)
    act(() => drain(queue))
    expect(fn).toHaveBeenCalledWith(2)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("flush() invokes immediately with the latest args and cancels the pending frame", () => {
    const fn = jest.fn()
    const { result } = renderHook(() => useRafThrottle<[number]>(fn))

    act(() => {
      result.current.call(7)
      result.current.flush()
    })

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(7)
    expect(queue.cancelCalls).toBe(1)

    // Draining the cleared queue is a no-op.
    act(() => drain(queue))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("flush() with no pending args is a no-op", () => {
    const fn = jest.fn()
    const { result } = renderHook(() => useRafThrottle(fn))
    act(() => result.current.flush())
    expect(fn).not.toHaveBeenCalled()
  })

  it("cancel() discards pending args without invoking", () => {
    const fn = jest.fn()
    const { result } = renderHook(() => useRafThrottle<[number]>(fn))

    act(() => {
      result.current.call(99)
      result.current.cancel()
    })
    expect(queue.cancelCalls).toBe(1)
    act(() => drain(queue))
    expect(fn).not.toHaveBeenCalled()
  })

  it("returns stable handle identities across renders", () => {
    const { result, rerender } = renderHook(({ fn }) => useRafThrottle(fn), {
      initialProps: { fn: () => {} },
    })
    const first = result.current
    rerender({ fn: () => {} })
    expect(result.current.call).toBe(first.call)
    expect(result.current.flush).toBe(first.flush)
    expect(result.current.cancel).toBe(first.cancel)
  })

  it("invokes the LATEST closure even when call identity is stable", () => {
    const fnA = jest.fn()
    const fnB = jest.fn()
    const { result, rerender } = renderHook(({ fn }) => useRafThrottle(fn), {
      initialProps: { fn: fnA },
    })
    rerender({ fn: fnB })

    act(() => result.current.call())
    act(() => drain(queue))
    expect(fnA).not.toHaveBeenCalled()
    expect(fnB).toHaveBeenCalledTimes(1)
  })

  it("cancels the pending frame on unmount", () => {
    const fn = jest.fn()
    const { result, unmount } = renderHook(() => useRafThrottle<[number]>(fn))
    act(() => result.current.call(1))
    unmount()
    expect(queue.cancelCalls).toBe(1)
    expect(queue.next).toBeNull()
    expect(fn).not.toHaveBeenCalled()
  })

  it("falls back to synchronous invocation when requestAnimationFrame is absent", () => {
    delete (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame
    const fn = jest.fn()
    const { result } = renderHook(() => useRafThrottle<[string]>(fn))
    act(() => result.current.call("immediate"))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith("immediate")
  })
})
