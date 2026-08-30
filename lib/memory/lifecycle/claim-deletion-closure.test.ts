/** @jest-environment node */
const mockRevokeForMessages = jest.fn()
const mockRevokeForSession = jest.fn()
const mockCancelJobs = jest.fn()
const mockEnqueueRecheck = jest.fn()
const mockBulkGet = jest.fn()

jest.mock("@/lib/db/memory-governance", () => ({
  revokeMemoryEvidenceForMessages: (...a: unknown[]) => mockRevokeForMessages(...a),
  revokeMemoryEvidenceForSession: (...a: unknown[]) => mockRevokeForSession(...a),
  cancelMemoryJobsForSession: (...a: unknown[]) => mockCancelJobs(...a),
}))
jest.mock("./enqueue-reconcile", () => ({
  enqueueClaimRevalidation: (...a: unknown[]) => mockEnqueueRecheck(...a),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ memories: { bulkGet: (...a: unknown[]) => mockBulkGet(...a) } }),
}))

import {
  revokeClaimsForDeletedMessages,
  revokeClaimsForDeletedSession,
} from "./claim-deletion-closure"

const CLAIM = { id: "claim1", status: "active", projectMemoryKind: "constraint" }
const PERSONAL = { id: "personal1", status: "active" }

beforeEach(() => {
  jest.clearAllMocks()
  mockRevokeForMessages.mockResolvedValue(["claim1"])
  mockRevokeForSession.mockResolvedValue(["claim1"])
  mockCancelJobs.mockResolvedValue(1)
  mockEnqueueRecheck.mockResolvedValue(undefined)
  mockBulkGet.mockResolvedValue([CLAIM])
})

describe("revokeClaimsForDeletedMessages", () => {
  it("revokes the citations and queues a re-check for each claim", async () => {
    await expect(revokeClaimsForDeletedMessages(["m1", "m2"])).resolves.toBe(1)
    expect(mockRevokeForMessages).toHaveBeenCalledWith(["m1", "m2"])
    expect(mockEnqueueRecheck).toHaveBeenCalledWith("claim1")
  })

  it("does not queue work for personal memories that cited the same message", async () => {
    // `revalidateClaim` skips them, so a job per personal row would fill the
    // queue with work whose only possible outcome is `not_a_project_claim`.
    mockRevokeForMessages.mockResolvedValue(["claim1", "personal1"])
    mockBulkGet.mockResolvedValue([CLAIM, PERSONAL])
    await revokeClaimsForDeletedMessages(["m1"])
    expect(mockEnqueueRecheck).toHaveBeenCalledTimes(1)
    expect(mockEnqueueRecheck).toHaveBeenCalledWith("claim1")
  })

  it("does not re-queue a claim that is already invalidated", async () => {
    mockBulkGet.mockResolvedValue([{ ...CLAIM, status: "invalidated" }])
    await revokeClaimsForDeletedMessages(["m1"])
    expect(mockEnqueueRecheck).not.toHaveBeenCalled()
  })

  it("no-ops on an empty id list without touching the database", async () => {
    await expect(revokeClaimsForDeletedMessages([])).resolves.toBe(0)
    expect(mockRevokeForMessages).not.toHaveBeenCalled()
  })

  it("never lets a bookkeeping failure surface as a failed deletion", async () => {
    // The rows ARE deleted by the time this runs. Throwing here would report a
    // completed deletion as failed; the daily sweep repairs the gap.
    mockRevokeForMessages.mockRejectedValue(new Error("db closed"))
    await expect(revokeClaimsForDeletedMessages(["m1"])).resolves.toBe(0)
  })
})

describe("revokeClaimsForDeletedSession", () => {
  it("revokes by session, which is the only way to reach turn-level citations", async () => {
    // Those rows carry a sessionId and no messageId, so an id sweep leaves them
    // pointing at a conversation that no longer exists.
    await expect(revokeClaimsForDeletedSession("s1")).resolves.toBe(1)
    expect(mockRevokeForSession).toHaveBeenCalledWith("s1")
    expect(mockEnqueueRecheck).toHaveBeenCalledWith("claim1")
  })

  it("cancels the session's still-pending learning jobs", async () => {
    await revokeClaimsForDeletedSession("s1")
    expect(mockCancelJobs).toHaveBeenCalledWith("s1")
  })

  it("still queues the re-checks when job cancellation fails", async () => {
    mockCancelJobs.mockRejectedValue(new Error("nope"))
    await expect(revokeClaimsForDeletedSession("s1")).resolves.toBe(1)
    expect(mockEnqueueRecheck).toHaveBeenCalledWith("claim1")
  })

  it("no-ops on an empty session id", async () => {
    await expect(revokeClaimsForDeletedSession("")).resolves.toBe(0)
    expect(mockRevokeForSession).not.toHaveBeenCalled()
  })
})
