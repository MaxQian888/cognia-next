/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

const useLiveQueryMock = jest.fn()
jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: (...args: unknown[]) => useLiveQueryMock(...args),
}))
jest.mock("@/lib/db/sites", () => ({ listSiteBuildLogs: jest.fn(async () => []) }))

import * as db from "@/lib/db/sites"
import { useSiteBuildLogs } from "./use-site-build-logs"

beforeEach(() => {
  jest.clearAllMocks()
  useLiveQueryMock.mockReturnValue(undefined)
})

function capture() {
  let run: (() => Promise<unknown>) | undefined
  useLiveQueryMock.mockImplementation((fn: () => Promise<unknown>) => {
    run = fn
    return undefined
  })
  return () => run!
}

it("reads only the named version's phases", async () => {
  const read = capture()
  renderHook(() => useSiteBuildLogs("ver_1"))
  await read()()
  expect(db.listSiteBuildLogs).toHaveBeenCalledWith("ver_1")
})

it("reads nothing with no version open", async () => {
  // The rows are the biggest in the subsystem after the archives; a closed
  // viewer must not touch them.
  const read = capture()
  renderHook(() => useSiteBuildLogs(null))
  await expect(read()()).resolves.toEqual([])
  expect(db.listSiteBuildLogs).not.toHaveBeenCalled()
})

it("reports loading until the first snapshot resolves", () => {
  const { result, rerender } = renderHook(() => useSiteBuildLogs("ver_1"))
  expect(result.current.loading).toBe(true)
  const first = result.current.logs
  rerender()
  expect(result.current.logs).toBe(first)
})

it("passes the resolved rows through", () => {
  const rows = [{ id: "ver_1:build", phase: "build" }]
  useLiveQueryMock.mockReturnValue(rows)
  const { result } = renderHook(() => useSiteBuildLogs("ver_1"))
  expect(result.current.logs).toBe(rows)
  expect(result.current.loading).toBe(false)
})
