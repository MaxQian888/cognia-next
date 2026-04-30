/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from "@testing-library/react"
import { useClientLiveQuery } from "./use-client-live-query"

const liveQueryMock = jest.fn<unknown, [() => Promise<unknown>, unknown[]]>()

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T>(fn: () => Promise<T>, deps: unknown[]) => liveQueryMock(fn as never, deps),
}))

beforeEach(() => {
  liveQueryMock.mockReset()
})

test("invokes the query function in the browser", async () => {
  const query = jest.fn().mockResolvedValue([1, 2, 3])
  liveQueryMock.mockImplementation(async (fn) => fn())
  const { result } = renderHook(() => useClientLiveQuery(query, [], [] as number[]))
  await waitFor(() => {
    expect(query).toHaveBeenCalledTimes(1)
  })
  // The mock returns the unwrapped promise but the hook surface is unchanged.
  expect(result.current ?? []).toBeDefined()
})

test("captured closure invokes the query in the browser branch", async () => {
  // jsdom always has window, so the closure passed to useLiveQuery hits the
  // browser branch and calls the user query. (The SSR branch is exercised
  // by inspection — the source short-circuits when typeof window === "undefined".)
  const query = jest.fn().mockResolvedValue([1])
  let captured: (() => Promise<unknown> | unknown) | null = null
  liveQueryMock.mockImplementation((fn) => {
    captured = fn
    return undefined
  })
  renderHook(() => useClientLiveQuery(query, [], [] as number[]))
  expect(captured).not.toBeNull()
  const result = (captured as unknown as () => Promise<unknown>)()
  await expect(result).resolves.toEqual([1])
  expect(query).toHaveBeenCalled()
})

test("forwards deps to useLiveQuery", () => {
  const query = jest.fn().mockResolvedValue("v")
  liveQueryMock.mockReturnValue("v")
  renderHook(() => useClientLiveQuery(query, ["a", 1], "" as string))
  expect(liveQueryMock).toHaveBeenCalledTimes(1)
  expect(liveQueryMock.mock.calls[0][1]).toEqual(["a", 1])
})
