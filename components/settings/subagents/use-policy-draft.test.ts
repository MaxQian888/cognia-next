/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

import { usePolicyDraft } from "./use-policy-draft"

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

interface Form {
  enabled: boolean
  maxDepth: number
}
const base: Form = { enabled: false, maxDepth: 2 }

beforeEach(() => {
  toastError.mockReset()
})

describe("usePolicyDraft", () => {
  it("is clean until a field changes", () => {
    const { result } = renderHook(() => usePolicyDraft("nesting", base, async () => {}))
    expect(result.current.status).toBe("clean")
    expect(result.current.dirtyCount).toBe(0)

    act(() => result.current.setField("maxDepth", 3))
    expect(result.current.status).toBe("dirty")
    expect(result.current.dirtyCount).toBe(1)
  })

  it("runs dirty → saving → saved → clean and persists the draft", async () => {
    jest.useFakeTimers()
    let resolvePersist: (() => void) | undefined
    const persist = jest.fn(
      () =>
        new Promise<void>((res) => {
          resolvePersist = res
        })
    )
    const { result } = renderHook(() => usePolicyDraft("nesting", base, persist))

    act(() => result.current.setField("maxDepth", 4))
    act(() => result.current.save())
    expect(result.current.status).toBe("saving")

    await act(async () => {
      resolvePersist?.()
    })
    expect(persist).toHaveBeenCalledWith({ enabled: false, maxDepth: 4 })
    expect(result.current.status).toBe("saved")

    act(() => {
      jest.advanceTimersByTime(1500)
    })
    expect(result.current.status).toBe("clean")
    jest.useRealTimers()
  })

  it("surfaces a failed save and stays dirty so the edit is not lost", async () => {
    const persist = jest.fn().mockRejectedValue(new Error("disk full"))
    const { result } = renderHook(() => usePolicyDraft("nesting", base, persist))

    act(() => result.current.setField("maxDepth", 4))
    act(() => result.current.save())

    await waitFor(() => expect(result.current.status).toBe("dirty"))
    expect(toastError).toHaveBeenCalledWith("disk full")
    expect(result.current.draft.maxDepth).toBe(4)
  })

  it("discards back to the baseline", () => {
    const { result } = renderHook(() => usePolicyDraft("nesting", base, async () => {}))
    act(() => result.current.setField("maxDepth", 4))
    act(() => result.current.discard())
    expect(result.current.draft).toEqual(base)
    expect(result.current.status).toBe("clean")
  })

  it("drops a stale confirmation when the panel changes", async () => {
    jest.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => usePolicyDraft(id, base, async () => {}),
      { initialProps: { id: "nesting" } }
    )
    act(() => result.current.setField("maxDepth", 4))
    await act(async () => {
      result.current.save()
    })
    expect(result.current.status).toBe("saved")

    rerender({ id: "background" })
    expect(result.current.status).toBe("clean")
    jest.useRealTimers()
  })
})
