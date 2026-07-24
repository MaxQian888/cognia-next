const mockEnqueue = jest.fn()
jest.mock("@/lib/db/memory-governance", () => ({
  enqueueMemoryJob: (...args: unknown[]) => mockEnqueue(...args),
}))

import {
  __resetVectorFailureCount,
  enqueueDailyVectorReconcile,
  noteMemoryVectorFailure,
} from "./enqueue-reconcile"

beforeEach(() => {
  jest.clearAllMocks()
  __resetVectorFailureCount()
  mockEnqueue.mockResolvedValue({ id: "job-1" })
})

describe("enqueueDailyVectorReconcile", () => {
  it("enqueues with a day-bucketed dedupe key and reuseCompleted", async () => {
    await enqueueDailyVectorReconcile(Date.UTC(2026, 6, 23, 15, 30))
    expect(mockEnqueue).toHaveBeenCalledWith(
      {
        dedupeKey: "vector-reconcile:2026-07-23",
        kind: "vector-reconcile",
        scope: "global",
        provenance: "system",
        evidenceIds: [],
      },
      { reuseCompleted: true }
    )
  })

  it("same day → same dedupe key; next day → new key", async () => {
    await enqueueDailyVectorReconcile(Date.UTC(2026, 6, 23, 1))
    await enqueueDailyVectorReconcile(Date.UTC(2026, 6, 23, 23))
    await enqueueDailyVectorReconcile(Date.UTC(2026, 6, 24, 1))
    const keys = mockEnqueue.mock.calls.map((c) => (c[0] as { dedupeKey: string }).dedupeKey)
    expect(keys).toEqual([
      "vector-reconcile:2026-07-23",
      "vector-reconcile:2026-07-23",
      "vector-reconcile:2026-07-24",
    ])
  })

  it("swallows enqueue failures", async () => {
    mockEnqueue.mockRejectedValueOnce(new Error("db closed"))
    await expect(enqueueDailyVectorReconcile()).resolves.toBeUndefined()
  })
})

describe("noteMemoryVectorFailure", () => {
  it("enqueues only on every third failure, then resets the counter", async () => {
    noteMemoryVectorFailure(1)
    noteMemoryVectorFailure(2)
    expect(mockEnqueue).not.toHaveBeenCalled()
    noteMemoryVectorFailure(3)
    await Promise.resolve()
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: "vector-reconcile:failures:3" }),
      { reuseCompleted: true }
    )
    // Counter reset — two more failures don't trigger again.
    noteMemoryVectorFailure(4)
    noteMemoryVectorFailure(5)
    await Promise.resolve()
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })
})
