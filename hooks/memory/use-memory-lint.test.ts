/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import type { Memory } from "@/types/memory/memory"
import type { MemoryLintReport } from "@/lib/memory/lint/run-memory-lint"

jest.mock("@/lib/memory/lint/run-memory-lint", () => ({ runMemoryLint: jest.fn() }))

import { runMemoryLint } from "@/lib/memory/lint/run-memory-lint"
import { useMemoryLint } from "./use-memory-lint"

const runMock = runMemoryLint as jest.MockedFunction<typeof runMemoryLint>

const NOW = 1_700_000_000_000

function mem(id: string, updatedAt = NOW): Memory {
  return {
    id,
    scope: "global",
    type: "semantic",
    text: id,
    tags: [],
    importance: 5,
    createdAt: NOW,
    updatedAt,
    lastAccessedAt: NOW,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
  }
}

function report(scanned: number): MemoryLintReport {
  return { findings: [], contradictionCheck: "ran", scanned }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let the hook's deferred `setTimeout(0)` fire and any settled promises flush. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
  })
}

beforeEach(() => {
  runMock.mockReset()
  runMock.mockImplementation(async (options) => report(options?.memories?.length ?? 0))
})

describe("useMemoryLint", () => {
  it("does not lint while inactive", async () => {
    const { result } = renderHook(() => useMemoryLint([mem("a")], false))
    await flush()
    expect(runMock).not.toHaveBeenCalled()
    expect(result.current.report).toBeUndefined()
    expect(result.current.loading).toBe(false)
  })

  it("lints the given memories once active and exposes the report", async () => {
    const memories = [mem("a"), mem("b")]
    const { result } = renderHook(() => useMemoryLint(memories, true))
    await waitFor(() => expect(result.current.report).toEqual(report(2)))
    expect(result.current.loading).toBe(false)
    expect(runMock).toHaveBeenCalledTimes(1)
    expect(runMock).toHaveBeenCalledWith({ memories })
  })

  it("reports loading while a run is in flight", async () => {
    const pending = deferred<MemoryLintReport>()
    runMock.mockReturnValueOnce(pending.promise)
    const { result } = renderHook(() => useMemoryLint([mem("a")], true))
    await waitFor(() => expect(result.current.loading).toBe(true))
    await act(async () => {
      pending.resolve(report(1))
      await pending.promise
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.report).toEqual(report(1))
  })

  it("starts linting when the tab becomes active", async () => {
    const memories = [mem("a")]
    const { result, rerender } = renderHook(({ active }) => useMemoryLint(memories, active), {
      initialProps: { active: false },
    })
    await flush()
    expect(runMock).not.toHaveBeenCalled()
    rerender({ active: true })
    await waitFor(() => expect(result.current.report).toEqual(report(1)))
    expect(runMock).toHaveBeenCalledTimes(1)
  })

  it("does not re-lint when only the array identity changes", async () => {
    const { result, rerender } = renderHook(({ memories }) => useMemoryLint(memories, true), {
      initialProps: { memories: [mem("a"), mem("b")] },
    })
    await waitFor(() => expect(result.current.report).toBeDefined())
    // A fresh live-query emission: new array, new objects, same count + newest updatedAt.
    rerender({ memories: [mem("a"), mem("b")] })
    await flush()
    expect(runMock).toHaveBeenCalledTimes(1)
  })

  it("re-lints when the row count changes", async () => {
    const { result, rerender } = renderHook(({ memories }) => useMemoryLint(memories, true), {
      initialProps: { memories: [mem("a")] },
    })
    await waitFor(() => expect(result.current.report).toEqual(report(1)))
    rerender({ memories: [mem("a"), mem("b")] })
    await waitFor(() => expect(result.current.report).toEqual(report(2)))
    expect(runMock).toHaveBeenCalledTimes(2)
  })

  it("re-lints when the newest updatedAt changes", async () => {
    const { result, rerender } = renderHook(({ memories }) => useMemoryLint(memories, true), {
      initialProps: { memories: [mem("a", NOW)] },
    })
    await waitFor(() => expect(result.current.report).toBeDefined())
    rerender({ memories: [mem("a", NOW + 1)] })
    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(2))
  })

  it("re-lints on refresh()", async () => {
    const memories = [mem("a")]
    const { result } = renderHook(() => useMemoryLint(memories, true))
    await waitFor(() => expect(result.current.report).toBeDefined())
    act(() => result.current.refresh())
    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(2))
  })

  it("keeps refresh() stable across renders", async () => {
    const memories = [mem("a")]
    const { result, rerender } = renderHook(() => useMemoryLint(memories, true))
    const first = result.current.refresh
    rerender()
    expect(result.current.refresh).toBe(first)
    await flush()
  })

  it("drops a stale result that settles after a newer run", async () => {
    const first = deferred<MemoryLintReport>()
    const second = deferred<MemoryLintReport>()
    runMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook(({ memories }) => useMemoryLint(memories, true), {
      initialProps: { memories: [mem("a")] },
    })
    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(1))
    rerender({ memories: [mem("a"), mem("b")] })
    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(2))

    await act(async () => {
      second.resolve(report(2))
      await second.promise
    })
    await act(async () => {
      first.resolve(report(1))
      await first.promise
    })
    await flush()
    expect(result.current.report).toEqual(report(2))
    expect(result.current.loading).toBe(false)
  })

  it("does not start a run whose timer was cancelled by a quick deactivate", async () => {
    const memories = [mem("a")]
    const { rerender } = renderHook(({ active }) => useMemoryLint(memories, active), {
      initialProps: { active: true },
    })
    rerender({ active: false })
    await flush()
    expect(runMock).not.toHaveBeenCalled()
  })

  it("clears the report when a run fails", async () => {
    const { result, rerender } = renderHook(({ memories }) => useMemoryLint(memories, true), {
      initialProps: { memories: [mem("a")] },
    })
    await waitFor(() => expect(result.current.report).toEqual(report(1)))
    runMock.mockRejectedValueOnce(new Error("vector read failed"))
    rerender({ memories: [mem("a"), mem("b")] })
    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.report).toBeUndefined())
    expect(result.current.loading).toBe(false)
  })

  it("ignores results that settle after unmount", async () => {
    const pending = deferred<MemoryLintReport>()
    runMock.mockReturnValueOnce(pending.promise)
    const errors = jest.spyOn(console, "error").mockImplementation(() => {})
    const { unmount } = renderHook(() => useMemoryLint([mem("a")], true))
    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(1))
    unmount()
    await act(async () => {
      pending.resolve(report(1))
      await pending.promise
    })
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})
