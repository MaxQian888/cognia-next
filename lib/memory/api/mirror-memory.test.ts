const mockUpdate = jest.fn()
const mockPin = jest.fn()
const mockInvalidate = jest.fn()
const mockAudit = jest.fn()

jest.mock("@/lib/db/memories", () => ({
  updateMemory: (...a: unknown[]) => mockUpdate(...a),
  setMemoryPinned: (...a: unknown[]) => mockPin(...a),
  invalidateMemory: (...a: unknown[]) => mockInvalidate(...a),
}))
jest.mock("@/lib/db/memory-governance", () => ({
  appendMemoryAuditEvent: (...a: unknown[]) => mockAudit(...a),
}))

import { applyMirroredMemoryMutation } from "./mirror-memory"

beforeEach(() => {
  jest.clearAllMocks()
  mockUpdate.mockResolvedValue(undefined)
  mockPin.mockResolvedValue(undefined)
  mockInvalidate.mockResolvedValue(undefined)
  mockAudit.mockResolvedValue(undefined)
})

describe("applyMirroredMemoryMutation", () => {
  it("bumps the version on a text edit, matching the desktop authority", async () => {
    await expect(
      applyMirroredMemoryMutation({ kind: "update", id: "m1", patch: { text: "next" } })
    ).resolves.toEqual({ ok: true })
    expect(mockUpdate).toHaveBeenCalledWith("m1", { text: "next", bumpVersion: true })
    expect(mockAudit).toHaveBeenCalledWith({
      action: "revised",
      memoryId: "m1",
      reason: "mobile_mirror",
    })
  })

  it("audits a pin and an unpin distinctly", async () => {
    await applyMirroredMemoryMutation({ kind: "update", id: "m1", patch: { pinned: true } })
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "pinned" }))
    mockAudit.mockClear()
    await applyMirroredMemoryMutation({ kind: "update", id: "m1", patch: { pinned: false } })
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "unpinned" }))
  })

  it("soft-deletes on forget", async () => {
    await expect(applyMirroredMemoryMutation({ kind: "forget", id: "m2" })).resolves.toEqual({
      ok: true,
    })
    expect(mockInvalidate).toHaveBeenCalledWith("m2")
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "invalidated" }))
  })

  // The mirror must not repeat the authority's work: a phone has no vector sink
  // and a tombstone belongs to whoever actually performed the deletion.
  it("never writes vectors or tombstones", async () => {
    const memories = jest.requireMock("@/lib/db/memories") as Record<string, unknown>
    await applyMirroredMemoryMutation({ kind: "forget", id: "m2" })
    expect(Object.keys(memories)).toEqual(["updateMemory", "setMemoryPinned", "invalidateMemory"])
    expect(memories.hardDeleteMemory).toBeUndefined()
  })

  it("refuses an empty patch instead of writing an empty row", async () => {
    await expect(
      applyMirroredMemoryMutation({ kind: "update", id: "m1", patch: {} })
    ).resolves.toEqual({ ok: false, reason: "empty_patch" })
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockPin).not.toHaveBeenCalled()
  })

  it("never throws, because the authoritative write is already queued", async () => {
    mockUpdate.mockRejectedValue(new Error("db down"))
    await expect(
      applyMirroredMemoryMutation({ kind: "update", id: "m1", patch: { text: "x" } })
    ).resolves.toEqual({ ok: false, reason: "failed" })
  })

  it("survives an audit failure without failing the mirror", async () => {
    mockAudit.mockRejectedValue(new Error("ledger down"))
    await expect(applyMirroredMemoryMutation({ kind: "forget", id: "m2" })).resolves.toEqual({
      ok: true,
    })
  })
})
