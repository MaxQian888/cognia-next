/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

const mockGet = jest.fn()
const mockUseLiveQuery = jest.fn()

jest.mock("dexie-react-hooks", () => ({
  // Execute the supplied query against the mocked db so we exercise the real
  // query body, then surface a synchronous value for assertions.
  useLiveQuery: (fn: () => unknown) => mockUseLiveQuery(fn),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ adapterInstances: { get: (id: string) => mockGet(id) } }),
}))

import { useAdapterInstance } from "./use-adapter-instance"

describe("useAdapterInstance", () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockUseLiveQuery.mockReset()
  })

  it("returns the live-queried adapter row", () => {
    const row = { id: "a1", displayName: "Bot" }
    mockUseLiveQuery.mockReturnValue(row)
    const { result } = renderHook(() => useAdapterInstance("a1"))
    expect(result.current).toBe(row)
  })

  it("queries adapterInstances.get by id when a window + id are present", () => {
    mockUseLiveQuery.mockImplementation((fn: () => unknown) => fn())
    renderHook(() => useAdapterInstance("a1"))
    expect(mockGet).toHaveBeenCalledWith("a1")
  })

  it("does not query when adapterId is empty", () => {
    mockUseLiveQuery.mockImplementation((fn: () => unknown) => fn())
    renderHook(() => useAdapterInstance(undefined))
    expect(mockGet).not.toHaveBeenCalled()
  })
})
