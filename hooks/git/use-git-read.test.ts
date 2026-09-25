/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { useGitRead } from "./use-git-read"

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("useGitRead", () => {
  it("reports loading, then the answer", async () => {
    const fetcher = jest.fn(() => Promise.resolve("diff-a"))
    const { result } = renderHook(() => useGitRead("a", fetcher))
    expect(result.current.loading).toBe(true)
    expect(result.current.data).toBeUndefined()
    await waitFor(() => expect(result.current.data).toBe("diff-a"))
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it("never returns the previous key's answer for a new key", async () => {
    const pendingB = deferred<string>()
    const fetcher = jest.fn((key: string) =>
      key === "a" ? Promise.resolve("diff-a") : pendingB.promise
    )
    const { result, rerender } = renderHook(({ k }) => useGitRead(k, () => fetcher(k)), {
      initialProps: { k: "a" },
    })
    await waitFor(() => expect(result.current.data).toBe("diff-a"))

    rerender({ k: "b" })
    expect(result.current.data).toBeUndefined()
    expect(result.current.loading).toBe(true)

    await act(async () => pendingB.resolve("diff-b"))
    expect(result.current.data).toBe("diff-b")
  })

  it("surfaces a failure and clears it on retry", async () => {
    let fail = true
    const fetcher = jest.fn(() =>
      fail ? Promise.reject({ kind: "networkFailed", detail: "offline" }) : Promise.resolve("ok")
    )
    const { result } = renderHook(() => useGitRead("a", fetcher))
    await waitFor(() => expect(result.current.error).toBe("offline"))
    expect(result.current.loading).toBe(false)

    fail = false
    act(() => result.current.retry())
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.data).toBe("ok"))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("keeps the last good answer when a same-key refresh fails", async () => {
    let fail = false
    const fetcher = jest.fn(() =>
      fail ? Promise.reject(new Error("gone")) : Promise.resolve("v1")
    )
    const { result } = renderHook(() => useGitRead("a", fetcher))
    await waitFor(() => expect(result.current.data).toBe("v1"))

    fail = true
    act(() => result.current.retry())
    // Revalidating a held answer is not "loading": the answer stays up.
    expect(result.current.loading).toBe(false)
    expect(result.current.data).toBe("v1")
    await waitFor(() => expect(result.current.error).toBe("gone"))
    expect(result.current.data).toBe("v1")
  })

  it("fetches nothing while disabled or without a key", () => {
    const fetcher = jest.fn(() => Promise.resolve("x"))
    const { result, rerender } = renderHook(
      ({ k, enabled }: { k: string | null; enabled: boolean }) =>
        useGitRead(k, fetcher, { enabled }),
      { initialProps: { k: "a" as string | null, enabled: false } }
    )
    expect(result.current.loading).toBe(false)
    rerender({ k: null, enabled: true })
    expect(result.current.loading).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("re-reads the same key when re-enabled, keeping the held answer meanwhile", async () => {
    const second = deferred<string>()
    const fetcher = jest
      .fn<Promise<string>, []>()
      .mockResolvedValueOnce("v1")
      .mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook(
      ({ enabled }) => useGitRead("a", fetcher, { enabled }),
      {
        initialProps: { enabled: true },
      }
    )
    await waitFor(() => expect(result.current.data).toBe("v1"))

    rerender({ enabled: false })
    rerender({ enabled: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.current.data).toBe("v1")
    expect(result.current.loading).toBe(false)

    await act(async () => second.resolve("v2"))
    expect(result.current.data).toBe("v2")
  })

  it("drops an answer that lands after the key moved on", async () => {
    const slowA = deferred<string>()
    const fetcher = jest.fn((key: string) =>
      key === "a" ? slowA.promise : Promise.resolve("diff-b")
    )
    const { result, rerender } = renderHook(({ k }) => useGitRead(k, () => fetcher(k)), {
      initialProps: { k: "a" },
    })
    rerender({ k: "b" })
    await waitFor(() => expect(result.current.data).toBe("diff-b"))
    await act(async () => slowA.resolve("diff-a"))
    expect(result.current.data).toBe("diff-b")
  })

  it("drops a failure that lands after the key moved on", async () => {
    const slowA = deferred<string>()
    const fetcher = jest.fn((key: string) =>
      key === "a" ? slowA.promise : Promise.resolve("diff-b")
    )
    const { result, rerender } = renderHook(({ k }) => useGitRead(k, () => fetcher(k)), {
      initialProps: { k: "a" },
    })
    rerender({ k: "b" })
    await waitFor(() => expect(result.current.data).toBe("diff-b"))
    await act(async () => slowA.reject(new Error("stale failure")))
    expect(result.current.error).toBeNull()
    expect(result.current.data).toBe("diff-b")
  })

  it("restarts an in-flight read when the revision moves, and delivers only the newer answer", async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const fetcher = jest
      .fn<Promise<string>, []>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const onData = jest.fn()
    const { result, rerender } = renderHook(
      ({ revision }) => useGitRead("a", fetcher, { revision, onData }),
      { initialProps: { revision: 1 } }
    )
    rerender({ revision: 2 })
    expect(fetcher).toHaveBeenCalledTimes(2)

    // The superseded read lands first: neither delivered nor shown.
    await act(async () => first.resolve("before the edit"))
    expect(onData).not.toHaveBeenCalled()
    expect(result.current.data).toBeUndefined()

    await act(async () => second.resolve("after the edit"))
    expect(onData).toHaveBeenCalledTimes(1)
    expect(onData).toHaveBeenCalledWith("after the edit")
    expect(result.current.data).toBe("after the edit")
  })

  it("does not deliver an answer that lands after unmount", async () => {
    const slow = deferred<string>()
    const onData = jest.fn()
    const { unmount } = renderHook(() => useGitRead("a", () => slow.promise, { onData }))
    unmount()
    await act(async () => slow.resolve("late"))
    expect(onData).not.toHaveBeenCalled()
  })
})
