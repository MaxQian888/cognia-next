/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

const mockUseLiveQuery = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (factory: () => unknown, deps: unknown[]) => mockUseLiveQuery(factory, deps),
}))

type JobPredicate = (job: { status: string }) => boolean

const mockToArray = jest.fn()
const mockFilter = jest.fn((_predicate: JobPredicate) => ({ toArray: mockToArray }))
const mockEquals = jest.fn((_key: string) => ({ filter: mockFilter }))
const mockWhere = jest.fn((_index: string) => ({ equals: mockEquals }))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ connectorInboundJobs: { where: mockWhere } }),
}))

import { useInboundRecoveryJobs } from "./use-inbound-recovery-jobs"

beforeEach(() => {
  jest.clearAllMocks()
  mockToArray.mockResolvedValue([])
})

/** Runs the live-query factory the hook handed to dexie-react-hooks. */
async function runFactory(): Promise<unknown> {
  const factory = mockUseLiveQuery.mock.calls.at(-1)![0] as () => Promise<unknown>
  return factory()
}

describe("useInboundRecoveryJobs", () => {
  it("returns an empty array before the query resolves", () => {
    mockUseLiveQuery.mockReturnValue(undefined)
    expect(renderHook(() => useInboundRecoveryJobs("ck")).result.current).toEqual([])
  })

  it("passes rows straight through", () => {
    const rows = [{ id: "j1" }]
    mockUseLiveQuery.mockReturnValue(rows)
    expect(renderHook(() => useInboundRecoveryJobs("ck")).result.current).toBe(rows)
  })

  it("queries the conversation for jobs awaiting recovery", async () => {
    mockUseLiveQuery.mockReturnValue([])
    renderHook(() => useInboundRecoveryJobs("lark:a:c1"))
    await runFactory()

    expect(mockWhere).toHaveBeenCalledWith("conversationKey")
    expect(mockEquals).toHaveBeenCalledWith("lark:a:c1")
    expect(mockToArray).toHaveBeenCalled()

    const predicate = mockFilter.mock.calls[0]![0]
    expect(predicate({ status: "recovery_required" })).toBe(true)
    expect(predicate({ status: "done" })).toBe(false)
  })

  // The non-conversation Inbox routes mount the notice area unconditionally.
  it("skips the query entirely without a conversation key", async () => {
    mockUseLiveQuery.mockReturnValue([])
    renderHook(() => useInboundRecoveryJobs(undefined))
    await expect(runFactory()).resolves.toEqual([])
    expect(mockWhere).not.toHaveBeenCalled()
  })

  it("re-subscribes when the conversation changes", () => {
    mockUseLiveQuery.mockReturnValue([])
    const { rerender } = renderHook(({ ck }) => useInboundRecoveryJobs(ck), {
      initialProps: { ck: "a" },
    })
    expect(mockUseLiveQuery.mock.calls.at(-1)![1]).toEqual(["a"])
    rerender({ ck: "b" })
    expect(mockUseLiveQuery.mock.calls.at(-1)![1]).toEqual(["b"])
  })
})
