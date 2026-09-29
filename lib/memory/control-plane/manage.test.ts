const mockStore = jest.fn()
const mockGet = jest.fn()
const mockUpdate = jest.fn()
const mockPin = jest.fn()
const mockDelete = jest.fn()
const mockInvalidate = jest.fn()
const mockFeedback = jest.fn()
const mockList = jest.fn()
const mockEvidence = jest.fn()
const mockDeleteEvidence = jest.fn()
const mockAudit = jest.fn()
const mockSinkDelete = jest.fn()
const mockSinkUpsert = jest.fn()
const mockRecordMemoryConflictGovernance = jest.fn()
const mockReportGovernanceProjectionFailure = jest.fn()
const mockRestoreRevision = jest.fn()

jest.mock("@/lib/memory/api/store-memory", () => ({
  storeMemoryCore: (...args: unknown[]) => mockStore(...args),
}))
jest.mock("@/lib/db/memories", () => ({
  getMemory: (...args: unknown[]) => mockGet(...args),
  updateMemory: (...args: unknown[]) => mockUpdate(...args),
  setMemoryPinned: (...args: unknown[]) => mockPin(...args),
  hardDeleteMemory: (...args: unknown[]) => mockDelete(...args),
  invalidateMemory: (...args: unknown[]) => mockInvalidate(...args),
  recordRetrievalFeedback: (...args: unknown[]) => mockFeedback(...args),
  listMemories: (...args: unknown[]) => mockList(...args),
  restoreMemoryRevision: (...args: unknown[]) => mockRestoreRevision(...args),
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(async () => ({ memory: {} })) }))
jest.mock("@/lib/db/memory-governance", () => ({
  createMemoryEvidence: (...args: unknown[]) => mockEvidence(...args),
  deleteMemoryEvidence: (...args: unknown[]) => mockDeleteEvidence(...args),
  appendMemoryAuditEvent: (...args: unknown[]) => mockAudit(...args),
}))
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryVectorSink: jest.fn(async () => ({
    upsert: mockSinkUpsert,
    delete: mockSinkDelete,
  })),
}))
const mockNoteVectorFailure = jest.fn()
jest.mock("@/lib/memory/lifecycle/enqueue-reconcile", () => ({
  noteMemoryVectorFailure: (...args: unknown[]) => mockNoteVectorFailure(...args),
}))
jest.mock("@/lib/governance/producers/memory", () => ({
  recordMemoryConflictGovernance: (...args: unknown[]) =>
    mockRecordMemoryConflictGovernance(...args),
}))
jest.mock("@/lib/db/governance-ledger", () => ({
  reportGovernanceProjectionFailure: (...args: unknown[]) =>
    mockReportGovernanceProjectionFailure(...args),
}))

import { manageMemory } from "./manage"
import { getSettings } from "@/lib/db/settings"

const getSettingsMock = getSettings as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockGet.mockResolvedValue({ id: "m1", text: "old", version: 1 })
  mockStore.mockResolvedValue({ ok: true, memoryId: "new", stored: true })
  mockList.mockResolvedValue([])
  mockFeedback.mockResolvedValue(true)
  mockEvidence.mockResolvedValue({
    id: "evidence-merge",
    sourceId: "conflict-merge:a:b",
    createdAt: 250,
  })
  mockRecordMemoryConflictGovernance.mockResolvedValue("memory-resolution:test")
  mockReportGovernanceProjectionFailure.mockResolvedValue(undefined)
})

describe("manageMemory", () => {
  it("routes manual creation through the PII-gated deliberate store", async () => {
    await manageMemory({
      kind: "create",
      text: "fact",
      type: "semantic",
      importance: 5,
      tags: [],
      scope: "workspace",
      projectId: "project-1",
    })
    expect(mockStore).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: "explicit",
        piiGate: "redact",
        scope: "workspace",
        projectId: "project-1",
      })
    )
  })

  it("redacts, versions, evidences, and reindexes a manual edit", async () => {
    const result = await manageMemory({
      kind: "update",
      id: "m1",
      patch: { text: "email me at dev@example.com" },
    })
    expect(mockUpdate).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ bumpVersion: true, evidenceState: "supported" })
    )
    expect(mockSinkUpsert).toHaveBeenCalled()
    expect(mockEvidence).toHaveBeenCalledWith(expect.objectContaining({ memoryId: "m1" }))
    expect(result).toMatchObject({ ok: true, piiRedacted: true })
  })

  it("deletes canonical, vector, and evidence state while retaining an audit event", async () => {
    await manageMemory({ kind: "delete", id: "m1" })
    expect(mockSinkDelete).toHaveBeenCalledWith(["m1"])
    expect(mockDelete).toHaveBeenCalledWith("m1")
    expect(mockDeleteEvidence).toHaveBeenCalledWith("m1")
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "deleted" }))
  })

  it("records pin and review decisions", async () => {
    await manageMemory({ kind: "pin", id: "m1", pinned: true })
    await manageMemory({ kind: "review", id: "m1", status: "verified" })
    expect(mockPin).toHaveBeenCalledWith("m1", true)
    expect(mockUpdate).toHaveBeenCalledWith("m1", { reviewStatus: "verified" })
  })

  it("invalidate soft-deletes, clears the vector doc, and audits", async () => {
    mockGet.mockResolvedValue({ id: "m1", text: "old", version: 1, vectorDocId: "vec-1" })
    const result = await manageMemory({ kind: "invalidate", id: "m1", supersededById: "m2" })
    expect(mockInvalidate).toHaveBeenCalledWith("m1", "m2")
    expect(mockSinkDelete).toHaveBeenCalledWith(["vec-1"])
    expect(mockDelete).not.toHaveBeenCalled()
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "invalidated", reason: "user_undo" })
    )
    expect(result).toEqual({ ok: true, memoryId: "m1" })
  })

  it("invalidate skips vector cleanup when the row was never indexed", async () => {
    await manageMemory({ kind: "invalidate", id: "m1" })
    expect(mockInvalidate).toHaveBeenCalledWith("m1", undefined)
    expect(mockSinkDelete).not.toHaveBeenCalled()
  })

  it("resolve-conflict keep verifies the winner and supersedes the loser", async () => {
    mockGet.mockImplementation(async (id: string) => ({
      id,
      text: id,
      version: 1,
      vectorDocId: `vec-${id}`,
      conflictWithIds: id === "a" ? ["b"] : ["a"],
    }))
    const result = await manageMemory({
      kind: "resolve-conflict",
      keepId: "a",
      dropId: "b",
      mode: "keep",
    })
    expect(mockUpdate).toHaveBeenCalledWith("a", { reviewStatus: "verified", conflictWithIds: [] })
    expect(mockInvalidate).toHaveBeenCalledWith("b", "a")
    expect(mockSinkDelete).toHaveBeenCalledWith(["vec-b"])
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "promoted", memoryId: "a", reason: "conflict_resolved" })
    )
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "invalidated", memoryId: "b" })
    )
    expect(mockRecordMemoryConflictGovernance).toHaveBeenCalledWith(
      expect.objectContaining({
        keep: expect.objectContaining({ id: "a" }),
        drop: expect.objectContaining({ id: "b" }),
        mode: "keep",
        actorId: "local-user",
      })
    )
    expect(result).toEqual({ ok: true, memoryId: "a" })
  })

  it("resolve-conflict refuses a revision snapshot on either side", async () => {
    mockGet.mockImplementation(async (id: string) => ({
      id,
      text: id,
      version: 1,
      ...(id === "snap" ? { revisionOf: "a", status: "invalidated" } : {}),
    }))
    for (const [keepId, dropId] of [
      ["snap", "b"],
      ["a", "snap"],
    ]) {
      await expect(
        manageMemory({ kind: "resolve-conflict", keepId, dropId, mode: "keep" })
      ).resolves.toEqual({ ok: false, reason: "not_found" })
    }
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockInvalidate).not.toHaveBeenCalled()
  })

  it("resolve-conflict keep-both verifies both sides and drops nothing", async () => {
    mockGet.mockImplementation(async (id: string) => ({
      id,
      text: id,
      version: 1,
      conflictWithIds: id === "a" ? ["b"] : ["a"],
    }))
    await manageMemory({ kind: "resolve-conflict", keepId: "a", dropId: "b", mode: "keep-both" })
    expect(mockUpdate).toHaveBeenCalledWith("a", { reviewStatus: "verified", conflictWithIds: [] })
    expect(mockUpdate).toHaveBeenCalledWith("b", { reviewStatus: "verified", conflictWithIds: [] })
    expect(mockInvalidate).not.toHaveBeenCalled()
  })

  it("resolve-conflict merge writes the PII-gated text and reindexes", async () => {
    mockGet.mockImplementation(async (id: string) =>
      id === "a" && mockGet.mock.calls.length > 2
        ? {
            id,
            text: "User migrated from npm to pnpm in 2026",
            version: 2,
            vectorDocId: "vec-a",
            conflictWithIds: [],
          }
        : {
            id,
            text: id,
            version: 1,
            vectorDocId: `vec-${id}`,
            conflictWithIds: [],
          }
    )
    const result = await manageMemory({
      kind: "resolve-conflict",
      keepId: "a",
      dropId: "b",
      mode: "merge",
      mergedText: "User migrated from npm to pnpm in 2026",
    })
    expect(mockUpdate).toHaveBeenCalledWith(
      "a",
      expect.objectContaining({
        text: "User migrated from npm to pnpm in 2026",
        bumpVersion: true,
        // The merged-away text is preserved as a revision tagged with why.
        revisionReason: "conflict-merge",
        reviewStatus: "verified",
      })
    )
    expect(mockSinkUpsert).toHaveBeenCalledWith("vec-a", "User migrated from npm to pnpm in 2026")
    expect(mockEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: "a", sourceId: "conflict-merge:a:b" })
    )
    expect(mockRecordMemoryConflictGovernance).toHaveBeenCalledWith(
      expect.objectContaining({
        keep: expect.objectContaining({ id: "a", text: "a", version: 1 }),
        result: expect.objectContaining({
          id: "a",
          text: "User migrated from npm to pnpm in 2026",
          version: 2,
        }),
        resolutionEvidence: {
          id: "evidence-merge",
          sourceId: "conflict-merge:a:b",
          createdAt: 250,
        },
      })
    )
    expect(mockInvalidate).toHaveBeenCalledWith("b", "a")
    expect(result).toEqual({ ok: true, memoryId: "a" })
  })

  it("resolve-conflict returns not_found when either side is missing", async () => {
    mockGet.mockImplementation(async (id: string) => (id === "a" ? { id, version: 1 } : undefined))
    expect(
      await manageMemory({ kind: "resolve-conflict", keepId: "a", dropId: "gone", mode: "keep" })
    ).toEqual({ ok: false, reason: "not_found" })
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockInvalidate).not.toHaveBeenCalled()
  })

  it("swallows vector failures on delete/invalidate/update but notes them for reconcile", async () => {
    mockGet.mockResolvedValue({ id: "m1", text: "old", version: 1, vectorDocId: "vec-1" })
    mockSinkDelete.mockRejectedValue(new Error("backend down"))
    mockSinkUpsert.mockRejectedValue(new Error("backend down"))

    await expect(manageMemory({ kind: "delete", id: "m1" })).resolves.toEqual({
      ok: true,
      memoryId: "m1",
    })
    await expect(manageMemory({ kind: "invalidate", id: "m1" })).resolves.toEqual({
      ok: true,
      memoryId: "m1",
    })
    await expect(
      manageMemory({ kind: "update", id: "m1", patch: { text: "new text" } })
    ).resolves.toMatchObject({ ok: true })
    expect(mockNoteVectorFailure).toHaveBeenCalledTimes(3)
  })

  it("resolve-conflict survives vector failures on merge and drop legs", async () => {
    mockGet.mockImplementation(async (id: string) => ({
      id,
      text: id,
      version: 1,
      vectorDocId: `vec-${id}`,
      conflictWithIds: [],
    }))
    mockSinkUpsert.mockRejectedValue(new Error("down"))
    mockSinkDelete.mockRejectedValue(new Error("down"))
    await expect(
      manageMemory({
        kind: "resolve-conflict",
        keepId: "a",
        dropId: "b",
        mode: "merge",
        mergedText: "merged fact",
      })
    ).resolves.toEqual({ ok: true, memoryId: "a" })
    expect(mockNoteVectorFailure).toHaveBeenCalledTimes(2)
  })

  it("returns not_found without mutating", async () => {
    mockGet.mockResolvedValue(undefined)
    expect(await manageMemory({ kind: "delete", id: "missing" })).toEqual({
      ok: false,
      reason: "not_found",
    })
  })

  it("clears through the governed delete path", async () => {
    mockList.mockResolvedValue([{ id: "m1" }, { id: "m2" }])
    mockGet.mockImplementation(async (id) => ({ id, version: 1 }))
    const result = await manageMemory({ kind: "clear" })
    expect(mockDelete).toHaveBeenCalledTimes(2)
    expect(mockSinkDelete).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: true, clearedCount: 2 })
  })

  it("clears everything — active and invalidated — when no query is given", async () => {
    // `listMemories()` returns both statuses when `status` is unset, so an
    // unscoped clear must not silently leave history behind.
    mockList.mockResolvedValue([])
    mockGet.mockImplementation(async (id) => ({ id, version: 1 }))
    await manageMemory({ kind: "clear" })
    expect(mockList).toHaveBeenCalledWith(undefined)
  })

  it("scopes the clear to the query it is given", async () => {
    mockList.mockResolvedValue([{ id: "w1" }])
    mockGet.mockImplementation(async (id) => ({ id, version: 1 }))
    const result = await manageMemory({
      kind: "clear",
      query: { scope: "workspace", projectId: "project_1" },
    })
    expect(mockList).toHaveBeenCalledWith({ scope: "workspace", projectId: "project_1" })
    expect(mockDelete).toHaveBeenCalledTimes(1)
    expect(mockDelete).toHaveBeenCalledWith("w1")
    expect(result).toEqual({ ok: true, clearedCount: 1 })
  })

  it("can purge only the invalidated rows", async () => {
    mockList.mockResolvedValue([{ id: "i1" }, { id: "i2" }, { id: "i3" }])
    mockGet.mockImplementation(async (id) => ({ id, version: 1 }))
    const result = await manageMemory({ kind: "clear", query: { status: "invalidated" } })
    // Clearing forgotten memories also clears revision history.
    expect(mockList).toHaveBeenCalledWith({ status: "invalidated", includeRevisions: true })
    expect(result).toEqual({ ok: true, clearedCount: 3 })
  })
})

describe("manageMemory retrieval-feedback", () => {
  it("records the verdict and audits it, without patching the memory", async () => {
    const result = await manageMemory({
      kind: "retrieval-feedback",
      id: "m1",
      verdict: "helpful",
    })
    expect(result).toEqual({ ok: true, memoryId: "m1" })
    expect(mockFeedback).toHaveBeenCalledWith("m1", "helpful")
    // Not `updateMemory`: that always stamps `updatedAt` and would re-tokenise
    // the whole BM25 corpus on every vote.
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockAudit).toHaveBeenCalledWith({
      action: "feedback",
      memoryId: "m1",
      reason: "retrieval_helpful",
    })
  })

  it.each(["wrong", "outdated"] as const)(
    "never turns a %s verdict into a review status",
    async (verdict) => {
      await manageMemory({ kind: "retrieval-feedback", id: "m1", verdict })
      expect(mockUpdate).not.toHaveBeenCalled()
      expect(mockInvalidate).not.toHaveBeenCalled()
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "feedback", reason: `retrieval_${verdict}` })
      )
    }
  )

  it("reports not_found when the memory is gone, and writes no audit row", async () => {
    mockFeedback.mockResolvedValue(false)
    const result = await manageMemory({
      kind: "retrieval-feedback",
      id: "gone",
      verdict: "helpful",
    })
    expect(result).toEqual({ ok: false, reason: "not_found" })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it("does not write an evidence row — the counters are the record", async () => {
    await manageMemory({ kind: "retrieval-feedback", id: "m1", verdict: "outdated" })
    expect(mockEvidence).not.toHaveBeenCalled()
  })
})

describe("manageMemory revision snapshots", () => {
  const SNAPSHOT = {
    id: "snap1",
    text: "older wording",
    version: 1,
    status: "invalidated",
    revisionOf: "m1",
    supersededById: "m1",
  }

  it("refuses to edit, pin, review, invalidate or restore through a snapshot id", async () => {
    mockGet.mockResolvedValue({ ...SNAPSHOT })
    const commands = [
      { kind: "update", id: "snap1", patch: { text: "rewrite" } },
      { kind: "pin", id: "snap1", pinned: true },
      { kind: "review", id: "snap1", status: "verified" },
      { kind: "invalidate", id: "snap1" },
      { kind: "retrieval-feedback", id: "snap1", verdict: "helpful" },
      { kind: "restore-revision", id: "snap1", revisionId: "m1" },
    ] as const
    for (const command of commands) {
      await expect(manageMemory(command)).resolves.toEqual({ ok: false, reason: "not_found" })
    }
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockPin).not.toHaveBeenCalled()
    expect(mockInvalidate).not.toHaveBeenCalled()
    expect(mockFeedback).not.toHaveBeenCalled()
    expect(mockRestoreRevision).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it("still lets a snapshot be deleted", async () => {
    mockGet.mockResolvedValue({ ...SNAPSHOT })
    await expect(manageMemory({ kind: "delete", id: "snap1" })).resolves.toEqual({
      ok: true,
      memoryId: "snap1",
    })
    expect(mockDelete).toHaveBeenCalledWith("snap1")
  })
})

describe("manageMemory restore-revision", () => {
  beforeEach(() => {
    mockGet.mockResolvedValue({ id: "m1", text: "current", version: 3, vectorDocId: "vec-m1" })
    mockRestoreRevision.mockResolvedValue({
      ok: true,
      memory: { id: "m1", text: "older wording", version: 4, vectorDocId: "vec-m1" },
    })
  })

  it("restores, re-indexes, evidences and audits the revision", async () => {
    const result = await manageMemory({ kind: "restore-revision", id: "m1", revisionId: "snap1" })
    expect(result).toEqual({ ok: true, memoryId: "m1" })
    expect(mockRestoreRevision).toHaveBeenCalledWith("m1", "snap1")
    expect(mockSinkUpsert).toHaveBeenCalledWith("vec-m1", "older wording")
    expect(mockEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: "m1",
        kind: "manual",
        sourceId: "restore:m1:snap1",
        contaminationState: "clean",
        reviewed: true,
      })
    )
    expect(mockAudit).toHaveBeenCalledWith({
      action: "revised",
      memoryId: "m1",
      reason: "restored",
      metadata: { revisionId: "snap1", version: 4 },
    })
  })

  it("falls back to the memory id as the vector doc id when the row was never indexed", async () => {
    mockGet.mockResolvedValue({ id: "m1", text: "current", version: 3 })
    await manageMemory({ kind: "restore-revision", id: "m1", revisionId: "snap1" })
    expect(mockSinkUpsert).toHaveBeenCalledWith("m1", "older wording")
  })

  it("skips the embedder when the restored text would leak PII, but still restores", async () => {
    mockRestoreRevision.mockResolvedValue({
      ok: true,
      memory: { id: "m1", text: "mail bob@example.com", version: 4 },
    })
    const result = await manageMemory({ kind: "restore-revision", id: "m1", revisionId: "snap1" })
    expect(result).toEqual({ ok: true, memoryId: "m1" })
    expect(mockSinkUpsert).not.toHaveBeenCalled()
    // The replaced text's vector must not keep matching.
    expect(mockSinkDelete).toHaveBeenCalledWith(["vec-m1"])
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ reason: "restored" }))
  })

  it("notes a vector failure without failing the restore", async () => {
    mockSinkUpsert.mockRejectedValueOnce(new Error("embedder down"))
    const result = await manageMemory({ kind: "restore-revision", id: "m1", revisionId: "snap1" })
    expect(result).toEqual({ ok: true, memoryId: "m1" })
    expect(mockNoteVectorFailure).toHaveBeenCalledTimes(1)
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ reason: "restored" }))
  })

  it("treats an unchanged restore as ok with no side effects", async () => {
    mockRestoreRevision.mockResolvedValue({ ok: false, reason: "unchanged" })
    const result = await manageMemory({ kind: "restore-revision", id: "m1", revisionId: "snap1" })
    expect(result).toEqual({ ok: true, memoryId: "m1" })
    expect(mockSinkUpsert).not.toHaveBeenCalled()
    expect(mockEvidence).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it("maps not_found and not_a_revision to not_found", async () => {
    for (const reason of ["not_found", "not_a_revision"]) {
      mockRestoreRevision.mockResolvedValueOnce({ ok: false, reason })
      await expect(
        manageMemory({ kind: "restore-revision", id: "m1", revisionId: "snap1" })
      ).resolves.toEqual({ ok: false, reason: "not_found" })
    }
    expect(mockAudit).not.toHaveBeenCalled()
    expect(mockEvidence).not.toHaveBeenCalled()
  })

  it("returns not_found when the live memory is gone", async () => {
    mockGet.mockResolvedValue(undefined)
    await expect(
      manageMemory({ kind: "restore-revision", id: "m1", revisionId: "snap1" })
    ).resolves.toEqual({ ok: false, reason: "not_found" })
    expect(mockRestoreRevision).not.toHaveBeenCalled()
  })

  it("refuses in temporary mode and when memory is disabled", async () => {
    getSettingsMock.mockResolvedValueOnce({ memory: { temporary: true } })
    await expect(
      manageMemory({ kind: "restore-revision", id: "m1", revisionId: "snap1" })
    ).resolves.toEqual({ ok: false, reason: "temporary" })
    getSettingsMock.mockResolvedValueOnce({ memory: { enabled: false } })
    await expect(
      manageMemory({ kind: "restore-revision", id: "m1", revisionId: "snap1" })
    ).resolves.toEqual({ ok: false, reason: "disabled" })
    expect(mockRestoreRevision).not.toHaveBeenCalled()
  })
})
