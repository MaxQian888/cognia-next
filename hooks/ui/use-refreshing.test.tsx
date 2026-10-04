import { act, renderHook } from "@testing-library/react"

import { useRefreshing } from "./use-refreshing"

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("useRefreshing", () => {
  it("is refreshing for exactly as long as the refresh runs", async () => {
    const pending = deferred()
    const { result } = renderHook(() => useRefreshing(() => pending.promise))
    expect(result.current.refreshing).toBe(false)

    let run!: Promise<void>
    act(() => {
      run = result.current.run()
    })
    expect(result.current.refreshing).toBe(true)

    await act(async () => {
      pending.resolve()
      await run
    })
    expect(result.current.refreshing).toBe(false)
  })

  it("ignores a second click while one read is still in flight", async () => {
    const pending = deferred()
    const refresh = jest.fn(() => pending.promise)
    const { result } = renderHook(() => useRefreshing(refresh))
    let first!: Promise<void>
    act(() => {
      first = result.current.run()
      void result.current.run()
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    await act(async () => {
      pending.resolve()
      await first
    })
  })

  it("clears the flag when the refresh fails, and leaves the error to the caller", async () => {
    const pending = deferred()
    const { result } = renderHook(() => useRefreshing(() => pending.promise))
    let run!: Promise<void>
    act(() => {
      run = result.current.run()
    })
    await act(async () => {
      pending.reject(new Error("host down"))
      await expect(run).rejects.toThrow("host down")
    })
    expect(result.current.refreshing).toBe(false)
  })
})
