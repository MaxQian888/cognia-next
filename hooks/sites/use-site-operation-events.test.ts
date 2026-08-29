/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

const useLiveQueryMock = jest.fn()
jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: (...args: unknown[]) => useLiveQueryMock(...args),
}))

jest.mock("@/lib/db/sites", () => ({ listSiteOperationEvents: jest.fn(async () => []) }))

import * as db from "@/lib/db/sites"
import { useSiteOperationEvents } from "./use-site-operation-events"

beforeEach(() => {
  jest.clearAllMocks()
  useLiveQueryMock.mockReturnValue(undefined)
})

function capture() {
  let run: (() => Promise<unknown>) | undefined
  let deps: unknown[] | undefined
  useLiveQueryMock.mockImplementation((fn: () => Promise<unknown>, dependencies: unknown[]) => {
    run = fn
    deps = dependencies
    return undefined
  })
  return () => ({ run: run!, deps: deps! })
}

it("reads exactly the named operation's events", async () => {
  const read = capture()
  renderHook(() => useSiteOperationEvents("op-1"))
  await read().run()
  expect(db.listSiteOperationEvents).toHaveBeenCalledWith("op-1")
  expect(read().deps).toEqual(["op-1"])
})

it("reads nothing when there is no operation to watch", async () => {
  const read = capture()
  renderHook(() => useSiteOperationEvents(null))
  await expect(read().run()).resolves.toEqual([])
  expect(db.listSiteOperationEvents).not.toHaveBeenCalled()
})

it("returns a stable empty array before the first snapshot resolves", () => {
  const { result, rerender } = renderHook(() => useSiteOperationEvents("op-1"))
  const first = result.current
  rerender()
  // A fresh `[]` per render would re-run every downstream memo that lists it
  // as a dependency.
  expect(result.current).toBe(first)
  expect(first).toEqual([])
})

it("passes the resolved snapshot through", () => {
  const events = [{ id: "e1", operationId: "op-1", sequence: 1, type: "queued", createdAt: 1 }]
  useLiveQueryMock.mockReturnValue(events)
  const { result } = renderHook(() => useSiteOperationEvents("op-1"))
  expect(result.current).toBe(events)
})
