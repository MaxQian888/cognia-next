/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import { StandaloneSearchError } from "@/lib/search/standalone-answer"

import { useStandaloneSearch } from "./use-standalone-search"

describe("useStandaloneSearch", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useStandaloneSearch({ runImpl: jest.fn() as never }))
    expect(result.current.status).toBe("idle")
    expect(result.current.query).toBe("")
  })

  it("updates the query", () => {
    const { result } = renderHook(() => useStandaloneSearch({ runImpl: jest.fn() as never }))
    act(() => result.current.setQuery("hello"))
    expect(result.current.query).toBe("hello")
  })

  it("runs and stores the result", async () => {
    const answer = { query: "q", sources: [], provider: "exa" as const }
    const runImpl = jest.fn().mockResolvedValue(answer)
    const { result } = renderHook(() => useStandaloneSearch({ runImpl: runImpl as never }))
    act(() => result.current.setQuery("q"))
    await act(async () => {
      await result.current.run()
    })
    expect(result.current.status).toBe("done")
    expect(result.current.result).toEqual(answer)
    expect(runImpl).toHaveBeenCalledWith(expect.objectContaining({ query: "q" }))
  })

  it("captures a StandaloneSearchError code", async () => {
    const runImpl = jest.fn().mockRejectedValue(new StandaloneSearchError("no-model-provider", "x"))
    const { result } = renderHook(() => useStandaloneSearch({ runImpl: runImpl as never }))
    await act(async () => {
      await result.current.run()
    })
    expect(result.current.status).toBe("error")
    expect(result.current.errorCode).toBe("no-model-provider")
    expect(result.current.errorMessage).toBe("x")
  })

  it("maps a non-typed error to search-failed", async () => {
    const runImpl = jest.fn().mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useStandaloneSearch({ runImpl: runImpl as never }))
    await act(async () => {
      await result.current.run()
    })
    expect(result.current.errorCode).toBe("search-failed")
    expect(result.current.errorMessage).toBe("boom")
  })

  it("ignores results once cancelled mid-flight", async () => {
    let resolveRun: (v: unknown) => void = () => {}
    const runImpl = jest.fn().mockImplementation(
      () =>
        new Promise((res) => {
          resolveRun = res
        })
    )
    const { result } = renderHook(() => useStandaloneSearch({ runImpl: runImpl as never }))
    let pending: Promise<void>
    act(() => {
      pending = result.current.run()
    })
    expect(result.current.status).toBe("loading")
    act(() => result.current.cancel())
    expect(result.current.status).toBe("idle")
    await act(async () => {
      resolveRun({ query: "q", sources: [], provider: "exa" })
      await pending
    })
    // The resolved value is dropped because the controller was aborted.
    expect(result.current.result).toBeUndefined()
    expect(result.current.status).toBe("idle")
  })

  it("cancel is a no-op when not loading", () => {
    const { result } = renderHook(() => useStandaloneSearch({ runImpl: jest.fn() as never }))
    act(() => result.current.cancel())
    expect(result.current.status).toBe("idle")
  })

  it("constructs with the default runner when no options are passed", () => {
    const { result } = renderHook(() => useStandaloneSearch())
    expect(result.current.status).toBe("idle")
  })

  it("aborts a previous in-flight run when run is called again", () => {
    const runImpl = jest.fn().mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useStandaloneSearch({ runImpl: runImpl as never }))
    act(() => {
      void result.current.run()
    })
    act(() => {
      void result.current.run()
    })
    expect(runImpl).toHaveBeenCalledTimes(2)
  })

  it("stringifies a non-Error rejection", async () => {
    const runImpl = jest.fn().mockRejectedValue("weird failure")
    const { result } = renderHook(() => useStandaloneSearch({ runImpl: runImpl as never }))
    await act(async () => {
      await result.current.run()
    })
    expect(result.current.errorCode).toBe("search-failed")
    expect(result.current.errorMessage).toBe("weird failure")
  })

  it("swallows a rejection that lands after cancellation", async () => {
    let rejectRun: (e: unknown) => void = () => {}
    const runImpl = jest.fn().mockImplementation(
      () =>
        new Promise((_res, rej) => {
          rejectRun = rej
        })
    )
    const { result } = renderHook(() => useStandaloneSearch({ runImpl: runImpl as never }))
    let pending: Promise<void>
    act(() => {
      pending = result.current.run()
    })
    act(() => result.current.cancel())
    await act(async () => {
      rejectRun(new Error("late failure"))
      await pending
    })
    // Aborted → no error surfaced, stays idle.
    expect(result.current.status).toBe("idle")
    expect(result.current.errorCode).toBeUndefined()
  })
})
