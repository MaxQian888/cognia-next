import { updateExternalMemory, forgetExternalMemory } from "./mutate-memory"

const mockGetSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => mockGetSettings(),
}))

const mockGetMemory = jest.fn()
const mockUpdateMemory = jest.fn()
const mockInvalidateMemory = jest.fn()
jest.mock("@/lib/db/memories", () => ({
  getMemory: (...args: unknown[]) => mockGetMemory(...(args as [])),
  updateMemory: (...args: unknown[]) => mockUpdateMemory(...(args as [])),
  invalidateMemory: (...args: unknown[]) => mockInvalidateMemory(...(args as [])),
}))

const mockVectorSink = jest.fn()
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryVectorSink: (...args: unknown[]) => mockVectorSink(...(args as [])),
}))

const mockAppendAudit = jest.fn()
jest.mock("@/lib/db/memory-governance", () => ({
  appendMemoryAuditEvent: (...args: unknown[]) => mockAppendAudit(...args),
}))

const PII_TEXT = "reach me at bob@example.com"

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
  mockGetMemory.mockResolvedValue({ id: "m1", text: "old", vectorDocId: "m1", pinned: false })
  mockVectorSink.mockResolvedValue(undefined)
  mockAppendAudit.mockResolvedValue(undefined)
})

describe("updateExternalMemory", () => {
  it("rejects an empty text patch and an empty patch", async () => {
    await expect(updateExternalMemory("m1", { text: "  " })).rejects.toThrow(/non-empty/)
    await expect(updateExternalMemory("m1", {})).rejects.toThrow(/at least one field/)
  })

  it("returns policy results for disabled / temporary / PII / missing row", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
    expect(await updateExternalMemory("m1", { text: "x" })).toEqual({
      ok: false,
      reason: "disabled",
    })
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, temporary: true } })
    expect(await updateExternalMemory("m1", { text: "x" })).toEqual({
      ok: false,
      reason: "temporary",
    })
    mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
    expect(await updateExternalMemory("m1", { text: PII_TEXT })).toEqual({
      ok: false,
      reason: "pii_blocked",
    })
    mockGetMemory.mockResolvedValue(undefined)
    expect(await updateExternalMemory("m1", { text: "x" })).toEqual({
      ok: false,
      reason: "not_found",
    })
    expect(mockUpdateMemory).not.toHaveBeenCalled()
  })

  it("maps the patch: text bumps version, importance clamps, tags trim", async () => {
    const result = await updateExternalMemory("m1", {
      text: "new text",
      importance: 42,
      tags: [" a ", "", "b"],
      key: "k1",
    })
    expect(result).toEqual({ ok: true })
    expect(mockUpdateMemory).toHaveBeenCalledWith("m1", {
      text: "new text",
      bumpVersion: true,
      importance: 10,
      tags: ["a", "b"],
      key: "k1",
    })
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "revised", memoryId: "m1" })
    )
  })

  it("supports pinning and records the governance action", async () => {
    expect(await updateExternalMemory("m1", { pinned: true })).toEqual({ ok: true })
    expect(mockUpdateMemory).toHaveBeenCalledWith("m1", { pinned: true })
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "pinned", memoryId: "m1" })
    )
  })

  it("re-upserts the vector doc on a text change, best-effort", async () => {
    const upsert = jest.fn().mockResolvedValue(undefined)
    mockVectorSink.mockResolvedValue({ upsert })
    await updateExternalMemory("m1", { text: "new text" })
    expect(upsert).toHaveBeenCalledWith("m1", "new text")

    // Sink failure never fails the update.
    mockVectorSink.mockResolvedValue({
      upsert: jest.fn().mockRejectedValue(new Error("vec down")),
    })
    expect(await updateExternalMemory("m1", { text: "again" })).toEqual({ ok: true })
  })

  it("skips the vector sink for non-text patches and rows without a vector doc", async () => {
    await updateExternalMemory("m1", { importance: 5 })
    expect(mockVectorSink).not.toHaveBeenCalled()

    mockGetMemory.mockResolvedValue({ id: "m2", text: "old" }) // no vectorDocId
    await updateExternalMemory("m2", { text: "new" })
    expect(mockVectorSink).not.toHaveBeenCalled()
  })
})

describe("forgetExternalMemory", () => {
  it("soft-invalidates an existing row", async () => {
    const deleteDocuments = jest.fn().mockResolvedValue(undefined)
    mockVectorSink.mockResolvedValue({ delete: deleteDocuments })
    expect(await forgetExternalMemory("m1")).toEqual({ ok: true })
    expect(mockInvalidateMemory).toHaveBeenCalledWith("m1")
    expect(deleteDocuments).toHaveBeenCalledWith(["m1"])
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "invalidated", memoryId: "m1" })
    )
  })

  it("is allowed in temporary mode (forgetting reduces data)", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, temporary: true } })
    expect(await forgetExternalMemory("m1")).toEqual({ ok: true })
  })

  it("returns policy results for disabled / missing row", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
    expect(await forgetExternalMemory("m1")).toEqual({ ok: false, reason: "disabled" })
    mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
    mockGetMemory.mockResolvedValue(undefined)
    expect(await forgetExternalMemory("m1")).toEqual({ ok: false, reason: "not_found" })
    expect(mockInvalidateMemory).not.toHaveBeenCalled()
  })
})
