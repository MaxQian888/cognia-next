import { updateExternalMemory, forgetExternalMemory } from "./mutate-memory"
import type { Memory } from "@/types/memory/memory"

const mockGetSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => mockGetSettings(),
}))

const mockGetMemory = jest.fn()
jest.mock("@/lib/db/memories", () => ({
  getMemory: (...args: unknown[]) => mockGetMemory(...(args as [])),
}))

const mockVectorSink = jest.fn()
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryVectorSink: (...args: unknown[]) => mockVectorSink(...(args as [])),
}))

const mockRunMutation = jest.fn()
const mockRequestHash = jest.fn(async () => "req-hash")
jest.mock("@/lib/db/memory-operations", () => ({
  runMemoryMutation: (...args: unknown[]) => mockRunMutation(...(args as [])),
  memoryOperationRequestHash: (...args: unknown[]) => mockRequestHash(...(args as [])),
}))

const mockResolvePolicy = jest.fn()
jest.mock("@/lib/memory/agent-policy", () => ({
  resolvePersistedAgentMemoryPolicy: (...args: unknown[]) => mockResolvePolicy(...args),
  scopeAllowedByAgentMemoryPolicy: (
    policy: { canUpdate: boolean; canForget: boolean; writableScopes: string[] },
    operation: "update" | "forget",
    scope: string
  ) =>
    (operation === "update" ? policy.canUpdate : policy.canForget) &&
    policy.writableScopes.includes(scope),
}))

const PII_TEXT = "reach me at bob@example.com"

const ROW: Memory = {
  id: "m1",
  text: "old",
  scope: "global",
  type: "semantic",
  importance: 5,
  provenance: "external",
  evidenceState: "legacy",
  reviewStatus: "unreviewed",
  contaminationState: "unknown",
  sensitivity: "unknown",
  status: "active",
  tags: [],
  pinned: false,
  vectorDocId: "m1",
  version: 3,
  accessCount: 0,
  createdAt: 1,
  updatedAt: 1,
  lastAccessedAt: 1,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
  mockGetMemory.mockResolvedValue({ ...ROW })
  mockVectorSink.mockResolvedValue(undefined)
  mockResolvePolicy.mockResolvedValue({
    canUpdate: true,
    canForget: true,
    writableScopes: ["global", "workspace", "character", "agent"],
  })
  mockRunMutation.mockResolvedValue({ ok: true, version: 4 })
})

/** Run the caller-provided apply callback against a row — what the real
 *  transaction does — and return the patch/audits it produced. */
function appliedPatch(row: Partial<Memory> = {}) {
  const request = mockRunMutation.mock.calls.at(-1)?.[0] as {
    apply: (existing: Memory) => { patch: Partial<Memory>; audits?: { action: string }[] }
  }
  return request.apply({ ...ROW, ...row })
}

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
    expect(mockRunMutation).not.toHaveBeenCalled()
  })

  it("maps the patch inside the mutation transaction", async () => {
    const result = await updateExternalMemory("m1", {
      text: "new text",
      importance: 42,
      tags: [" a ", "", "b"],
      key: "k1",
    })
    expect(result).toEqual({ ok: true, version: 4 })
    const { patch, audits } = appliedPatch()
    expect(patch).toEqual({
      text: "new text",
      importance: 10,
      tags: ["a", "b"],
      key: "k1",
    })
    expect(audits).toEqual([{ action: "revised", reason: "external_update" }])
  })

  it("enforces Agent update permission and writable scope", async () => {
    mockResolvePolicy.mockResolvedValue({
      canUpdate: false,
      canForget: true,
      writableScopes: ["global"],
    })
    await expect(updateExternalMemory("m1", { importance: 5 })).resolves.toEqual({
      ok: false,
      reason: "policy_denied",
    })

    mockResolvePolicy.mockResolvedValue({
      canUpdate: true,
      canForget: true,
      writableScopes: ["character"],
    })
    await expect(updateExternalMemory("m1", { importance: 5 })).resolves.toEqual({
      ok: false,
      reason: "scope_denied",
    })
  })

  it("resolves the governing policy from the caller binding, not request fields", async () => {
    await updateExternalMemory(
      "m1",
      { text: "x" },
      {
        caller: {
          principalId: "plugin:demo",
          transport: "plugin",
          policyCharacterId: "agent-1",
          sessionId: "sess-9",
        },
      }
    )
    expect(mockResolvePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: "agent-1", sessionId: "sess-9" })
    )
  })

  it("denies a row outside the caller's authorized namespaces", async () => {
    mockGetMemory.mockResolvedValue({ ...ROW, scope: "workspace", projectId: "p1" })
    const outcome = await updateExternalMemory(
      "m1",
      { text: "x" },
      {
        caller: {
          principalId: "plugin:demo",
          transport: "plugin",
          namespaces: { projects: ["p-other"] },
        },
      }
    )
    expect(outcome).toEqual({ ok: false, reason: "unauthorized_namespace" })
    expect(mockRunMutation).not.toHaveBeenCalled()
  })

  it("threads expectedVersion and operationId into the mutation", async () => {
    await updateExternalMemory(
      "m1",
      { text: "x" },
      {
        caller: { principalId: "plugin:demo", transport: "plugin" },
        expectedVersion: 3,
        operationId: "op-7",
      }
    )
    expect(mockRequestHash).toHaveBeenCalledWith("update", { id: "m1", patch: { text: "x" } })
    expect(mockRunMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 3,
        operation: {
          principalId: "plugin:demo",
          operationId: "op-7",
          requestHash: "req-hash",
          kind: "update",
        },
      })
    )
  })

  it("surfaces CAS and idempotency failures from the transaction", async () => {
    mockRunMutation.mockResolvedValue({ ok: false, reason: "version_conflict", currentVersion: 5 })
    expect(await updateExternalMemory("m1", { text: "x" }, { expectedVersion: 3 })).toEqual({
      ok: false,
      reason: "version_conflict",
      currentVersion: 5,
    })
    mockRunMutation.mockResolvedValue({ ok: false, reason: "idempotency_key_reused" })
    expect(await updateExternalMemory("m1", { text: "x" }, { operationId: "op" })).toEqual({
      ok: false,
      reason: "idempotency_key_reused",
    })
  })

  it("supports pinning and records the governance action", async () => {
    expect(await updateExternalMemory("m1", { pinned: true })).toEqual({ ok: true, version: 4 })
    const { patch, audits } = appliedPatch({ pinned: false })
    expect(patch).toEqual({ pinned: true })
    expect(audits).toContainEqual({ action: "pinned", reason: "external_update" })
  })

  it("re-upserts the vector doc on a text change, best-effort", async () => {
    const upsert = jest.fn().mockResolvedValue(undefined)
    mockVectorSink.mockResolvedValue({ upsert })
    await updateExternalMemory("m1", { text: "new text" })
    expect(upsert).toHaveBeenCalledWith("m1", "new text")

    mockVectorSink.mockResolvedValue({
      upsert: jest.fn().mockRejectedValue(new Error("vec down")),
    })
    expect(await updateExternalMemory("m1", { text: "again" })).toEqual({ ok: true, version: 4 })
  })

  it("skips the vector sink for non-text patches and rows without a vector doc", async () => {
    await updateExternalMemory("m1", { importance: 5 })
    expect(mockVectorSink).not.toHaveBeenCalled()

    mockGetMemory.mockResolvedValue({ ...ROW, id: "m2", vectorDocId: undefined })
    await updateExternalMemory("m2", { text: "new" })
    expect(mockVectorSink).not.toHaveBeenCalled()
  })
})

describe("forgetExternalMemory", () => {
  it("enforces the Agent forget permission", async () => {
    mockResolvePolicy.mockResolvedValue({
      canUpdate: true,
      canForget: false,
      writableScopes: ["global"],
    })
    await expect(
      forgetExternalMemory("m1", {
        caller: { principalId: "plugin:demo", transport: "plugin", policyCharacterId: "agent-1" },
      })
    ).resolves.toEqual({
      ok: false,
      reason: "policy_denied",
    })
    expect(mockRunMutation).not.toHaveBeenCalled()
  })

  it("soft-invalidates an existing row inside the mutation transaction", async () => {
    const deleteDocuments = jest.fn().mockResolvedValue(undefined)
    mockVectorSink.mockResolvedValue({ delete: deleteDocuments })
    expect(await forgetExternalMemory("m1")).toEqual({ ok: true, version: 4 })
    const { patch, audits } = appliedPatch({ status: "active" })
    expect(patch.status).toBe("invalidated")
    expect(patch.invalidatedAt).toEqual(expect.any(Number))
    expect(audits).toEqual([{ action: "invalidated", reason: "external_forget" }])
    expect(deleteDocuments).toHaveBeenCalledWith(["m1"])
  })

  it("treats an already-forgotten row as a settled no-op", async () => {
    await forgetExternalMemory("m1")
    const { patch, audits } = appliedPatch({ status: "invalidated" })
    expect(patch).toEqual({})
    expect(audits).toEqual([])
  })

  it("denies a row outside the caller's authorized namespaces", async () => {
    mockGetMemory.mockResolvedValue({ ...ROW, scope: "character", characterId: "c-9" })
    const outcome = await forgetExternalMemory("m1", {
      caller: {
        principalId: "companion:dev-1",
        transport: "companion",
        namespaces: { characterIds: ["c-1"] },
      },
    })
    expect(outcome).toEqual({ ok: false, reason: "unauthorized_namespace" })
    expect(mockRunMutation).not.toHaveBeenCalled()
  })

  it("is allowed in temporary mode (forgetting reduces data)", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, temporary: true } })
    expect(await forgetExternalMemory("m1")).toEqual({ ok: true, version: 4 })
  })

  it("returns policy results for disabled / missing row", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
    expect(await forgetExternalMemory("m1")).toEqual({ ok: false, reason: "disabled" })
    mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
    mockGetMemory.mockResolvedValue(undefined)
    expect(await forgetExternalMemory("m1")).toEqual({ ok: false, reason: "not_found" })
    expect(mockRunMutation).not.toHaveBeenCalled()
  })
})
