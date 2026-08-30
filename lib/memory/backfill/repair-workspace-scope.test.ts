const mockList = jest.fn()
const mockRelocate = jest.fn()
const mockGetSession = jest.fn()
const mockAudit = jest.fn()

jest.mock("@/lib/db/memories", () => ({
  listWorkspaceMemoriesMissingProject: (...a: unknown[]) => mockList(...a),
  relocateMemoryNamespace: (...a: unknown[]) => mockRelocate(...a),
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: (...a: unknown[]) => mockGetSession(...a) }))
jest.mock("@/lib/db/memory-governance", () => ({
  appendMemoryAuditEvent: (...a: unknown[]) => mockAudit(...a),
}))

import { repairWorkspaceScopedMemories } from "./repair-workspace-scope"

beforeEach(() => {
  jest.clearAllMocks()
  mockList.mockResolvedValue([])
  mockRelocate.mockResolvedValue(undefined)
  mockGetSession.mockResolvedValue(undefined)
  mockAudit.mockResolvedValue(undefined)
})

describe("repairWorkspaceScopedMemories", () => {
  it("does nothing on a healthy database", async () => {
    await expect(repairWorkspaceScopedMemories()).resolves.toEqual({ repaired: 0, downgraded: 0 })
    expect(mockRelocate).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it("recovers the workspace from the row's source session", async () => {
    mockList.mockResolvedValue([{ id: "m1", sourceSessionId: "ses_1" }])
    mockGetSession.mockResolvedValue({ id: "ses_1", projectId: "proj_1" })
    await expect(repairWorkspaceScopedMemories()).resolves.toEqual({ repaired: 1, downgraded: 0 })
    expect(mockRelocate).toHaveBeenCalledWith("m1", {
      projectId: "proj_1",
      scopeRationale: "repaired_from_source_session",
    })
  })

  it("downgrades to global when no workspace can be recovered", async () => {
    // Readable in a wider scope beats unreadable forever.
    mockList.mockResolvedValue([{ id: "m2" }])
    await expect(repairWorkspaceScopedMemories()).resolves.toEqual({ repaired: 0, downgraded: 1 })
    expect(mockRelocate).toHaveBeenCalledWith("m2", {
      scope: "global",
      scopeRationale: "repaired_scope_downgrade",
    })
  })

  it("downgrades when the source session is gone", async () => {
    mockList.mockResolvedValue([{ id: "m3", sourceSessionId: "ses_gone" }])
    mockGetSession.mockRejectedValue(new Error("missing"))
    await expect(repairWorkspaceScopedMemories()).resolves.toEqual({ repaired: 0, downgraded: 1 })
  })

  it("writes one content-free audit row per repaired memory", async () => {
    mockList.mockResolvedValue([{ id: "m1", sourceSessionId: "ses_1" }])
    mockGetSession.mockResolvedValue({ id: "ses_1", projectId: "proj_1" })
    await repairWorkspaceScopedMemories()
    expect(mockAudit).toHaveBeenCalledWith({
      action: "revised",
      memoryId: "m1",
      sessionId: "ses_1",
      reason: "workspace_scope_repair",
      metadata: { recovered: true },
    })
  })

  it("keeps going when one row fails to move", async () => {
    mockList.mockResolvedValue([{ id: "bad" }, { id: "good" }])
    mockRelocate.mockRejectedValueOnce(new Error("locked"))
    await expect(repairWorkspaceScopedMemories()).resolves.toEqual({ repaired: 0, downgraded: 1 })
    expect(mockRelocate).toHaveBeenCalledTimes(2)
  })

  it("never rejects when the query itself fails", async () => {
    mockList.mockRejectedValue(new Error("db down"))
    await expect(repairWorkspaceScopedMemories()).resolves.toEqual({ repaired: 0, downgraded: 0 })
  })

  it("forwards the batch bound", async () => {
    await repairWorkspaceScopedMemories(25)
    expect(mockList).toHaveBeenCalledWith(25)
  })
})
