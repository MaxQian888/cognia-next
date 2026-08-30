const mockEnqueue = jest.fn()
jest.mock("@/lib/db/memory-governance", () => ({
  enqueueMemoryJob: (...args: unknown[]) => mockEnqueue(...args),
}))

import {
  __resetVectorFailureCount,
  enqueueClaimRevalidation,
  enqueueDailyClaimRevalidation,
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

describe("claim revalidation triggers", () => {
  it("targets one claim and does NOT reuse a completed job", async () => {
    // A transcript window is mined once; a claim can need re-checking many
    // times over its life. Reusing yesterday's completed row would make every
    // deletion after the first a silent no-op.
    await enqueueClaimRevalidation("mem9")
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "project-claim-revalidate",
        dedupeKey: "project-claim-revalidate:mem9",
        memoryId: "mem9",
      })
    )
    expect(mockEnqueue.mock.calls[0]).toHaveLength(1)
  })

  it("ignores an empty memory id rather than queuing an untargeted job", async () => {
    await enqueueClaimRevalidation("")
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("buckets the backstop sweep to one per day and leaves it untargeted", async () => {
    await enqueueDailyClaimRevalidation(Date.parse("2026-08-30T22:00:00Z"))
    const [draft, options] = mockEnqueue.mock.calls[0]!
    expect(draft).toMatchObject({
      dedupeKey: "project-claim-revalidate:sweep:2026-08-30",
      kind: "project-claim-revalidate",
    })
    expect(draft.memoryId).toBeUndefined()
    expect(options).toEqual({ reuseCompleted: true })
  })

  it("swallows an enqueue failure — the sweep is the backstop, not the point", async () => {
    mockEnqueue.mockRejectedValue(new Error("db closed"))
    await expect(enqueueClaimRevalidation("mem9")).resolves.toBeUndefined()
  })
})
