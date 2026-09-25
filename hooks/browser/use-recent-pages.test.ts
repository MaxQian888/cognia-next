/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

let mockRows: Array<{ url: string }> | undefined = []
const mockQueries: Array<() => unknown> = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (querier: () => unknown) => {
    mockQueries.push(querier)
    return mockRows
  },
}))
jest.mock("@/lib/db/browser-history", () => ({
  listRecentBrowserVisits: jest.fn().mockResolvedValue([]),
  clearBrowserHistory: jest.fn(),
}))
jest.mock("@cognia/logging", () => ({ loggers: { store: { warn: jest.fn() } } }))

import { loggers } from "@cognia/logging"
import { clearBrowserHistory, listRecentBrowserVisits } from "@/lib/db/browser-history"
import { RECENT_PAGES_LIMIT, useRecentPages } from "./use-recent-pages"

const clearHistory = clearBrowserHistory as jest.Mock

beforeEach(() => {
  mockRows = []
  mockQueries.length = 0
  clearHistory.mockReset().mockResolvedValue(undefined)
  ;(listRecentBrowserVisits as jest.Mock).mockClear()
})

it("lists the persisted visits as addresses, newest first as stored", () => {
  mockRows = [{ url: "https://b.example/" }, { url: "https://a.example/" }]
  const { result } = renderHook(() => useRecentPages())
  expect(result.current.recent).toEqual(["https://b.example/", "https://a.example/"])
})

it("asks the store for the menu's worth by default, or the caller's limit", () => {
  renderHook(() => useRecentPages())
  void mockQueries.at(-1)?.()
  expect(listRecentBrowserVisits).toHaveBeenLastCalledWith(RECENT_PAGES_LIMIT)

  renderHook(() => useRecentPages(4))
  void mockQueries.at(-1)?.()
  expect(listRecentBrowserVisits).toHaveBeenLastCalledWith(4)
})

it("reads as empty before the first query settles", () => {
  mockRows = undefined
  const { result } = renderHook(() => useRecentPages())
  expect(result.current.recent).toEqual([])
})

it("clears the store and says so", async () => {
  const { result } = renderHook(() => useRecentPages())
  let cleared: boolean | undefined
  await act(async () => {
    cleared = await result.current.clear()
  })
  expect(clearHistory).toHaveBeenCalledTimes(1)
  expect(cleared).toBe(true)
})

it("reports a refused clear instead of throwing", async () => {
  clearHistory.mockRejectedValue(new Error("locked"))
  const { result } = renderHook(() => useRecentPages())
  let cleared: boolean | undefined
  await act(async () => {
    cleared = await result.current.clear()
  })
  expect(cleared).toBe(false)
  expect(loggers.store.warn).toHaveBeenCalled()
})
