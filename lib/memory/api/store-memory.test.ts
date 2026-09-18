import { storeExternalMemory, storeMemoryCore, clampImportance } from "./store-memory"

const mockGetSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => mockGetSettings(),
}))

const mockConsolidate = jest.fn()
const mockBuildDeps = jest.fn()
jest.mock("@/lib/memory/write/run-memory-extraction", () => ({
  buildAutoExtractionDeps: (...args: unknown[]) => mockBuildDeps(...(args as [])),
}))

const mockCreateMemory = jest.fn()
const mockUpdateMemory = jest.fn()
jest.mock("@/lib/db/memories", () => ({
  createMemory: (...args: unknown[]) => mockCreateMemory(...(args as [])),
  updateMemory: (...args: unknown[]) => mockUpdateMemory(...(args as [])),
}))

const mockVectorSink = jest.fn()
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryVectorSink: (...args: unknown[]) => mockVectorSink(...(args as [])),
}))

const mockAppendAudit = jest.fn()
jest.mock("@/lib/db/memory-governance", () => ({
  appendMemoryAuditEvent: (...args: unknown[]) => mockAppendAudit(...(args as [])),
}))

const mockNoteVectorFailure = jest.fn()
jest.mock("@/lib/memory/lifecycle/enqueue-reconcile", () => ({
  noteMemoryVectorFailure: (...args: unknown[]) => mockNoteVectorFailure(...args),
}))

const mockReserve = jest.fn()
const mockAwaitOp = jest.fn()
const mockRecordOp = jest.fn()
const mockReleaseOp = jest.fn()
const mockRequestHash = jest.fn(async () => "req-hash")
jest.mock("@/lib/db/memory-operations", () => ({
  reserveMemoryOperation: (...args: unknown[]) => mockReserve(...(args as [])),
  awaitMemoryOperation: (...args: unknown[]) => mockAwaitOp(...(args as [])),
  recordMemoryOperation: (...args: unknown[]) => mockRecordOp(...(args as [])),
  releaseMemoryOperation: (...args: unknown[]) => mockReleaseOp(...(args as [])),
  memoryOperationRequestHash: (...args: unknown[]) => mockRequestHash(...(args as [])),
}))

const mockResolvePolicy = jest.fn()
jest.mock("@/lib/memory/agent-policy", () => ({
  resolvePersistedAgentMemoryPolicy: (...args: unknown[]) => mockResolvePolicy(...args),
  scopeAllowedByAgentMemoryPolicy: (
    policy: { canCreate: boolean; writableScopes: string[] },
    _operation: string,
    scope: string
  ) => policy.canCreate && policy.writableScopes.includes(scope),
}))

const PII_TEXT = "reach me at bob@example.com"
const ATTRIBUTION = { channel: "plugin" as const, pluginId: "com.example.notes" }

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
  mockConsolidate.mockResolvedValue({
    applied: [{ op: "ADD", memory: { id: "mem_added" }, candidate: { type: "semantic" } }],
  })
  mockBuildDeps.mockResolvedValue({ consolidate: mockConsolidate })
  mockCreateMemory.mockResolvedValue({ id: "mem_new", text: "stored" })
  mockVectorSink.mockResolvedValue(undefined)
  // Must be re-armed every test: `clearAllMocks` wipes call data but keeps a
  // `mockRejectedValue` set by an earlier case, and a bare jest.fn() returns
  // undefined — which the `.catch(...)` on the audit call would blow up on.
  mockAppendAudit.mockResolvedValue(undefined)
  mockResolvePolicy.mockResolvedValue({
    canCreate: true,
    writableScopes: ["global", "workspace", "character", "agent"],
  })
  mockReserve.mockResolvedValue({ state: "reserved" })
  mockAwaitOp.mockResolvedValue(undefined)
  mockRecordOp.mockResolvedValue(undefined)
  mockReleaseOp.mockResolvedValue(undefined)
})

describe("clampImportance", () => {
  it("defaults to 7 and clamps into 1..10", () => {
    expect(clampImportance(undefined)).toBe(7)
    expect(clampImportance(Number.NaN)).toBe(7)
    expect(clampImportance(42)).toBe(10)
    expect(clampImportance(-3)).toBe(1)
    expect(clampImportance(5.6)).toBe(6)
  })
})

describe("storeMemoryCore", () => {
  it("rejects empty text and scopes missing their required identity", async () => {
    await expect(storeMemoryCore({ text: "  ", provenance: "system" })).rejects.toThrow(
      /non-empty 'text'/
    )
    await expect(
      storeMemoryCore({ text: "x", scope: "character", provenance: "system" })
    ).rejects.toThrow(/'characterId' is required/)
    await expect(
      storeMemoryCore({ text: "x", scope: "workspace", provenance: "system" })
    ).rejects.toThrow(/'projectId' is required/)
    await expect(
      storeMemoryCore({ text: "x", scope: "agent", provenance: "system" })
    ).rejects.toThrow(/'agentId' is required/)
  })

  it("rejects procedural memories from untrusted provenance", async () => {
    await expect(
      storeMemoryCore({ text: "always use pnpm", type: "procedural", provenance: "external" })
    ).rejects.toThrow(/user\/explicit provenance/)
    await expect(
      storeMemoryCore({ text: "always use pnpm", type: "procedural", provenance: "system" })
    ).rejects.toThrow(/user\/explicit provenance/)
    // Explicit stays allowed (the /remember + workflow-explicit path).
    const result = await storeMemoryCore({
      text: "always use pnpm",
      type: "procedural",
      provenance: "explicit",
    })
    expect(result.ok).toBe(true)
  })

  it("enforces the acting Agent create permission and writable scopes", async () => {
    mockResolvePolicy.mockResolvedValue({ canCreate: false, writableScopes: ["global"] })
    await expect(
      storeMemoryCore({
        text: "safe fact",
        provenance: "explicit",
        policyCharacterId: "agent-1",
      })
    ).resolves.toEqual({ ok: false, reason: "policy_denied" })

    mockResolvePolicy.mockResolvedValue({ canCreate: true, writableScopes: ["character"] })
    await expect(
      storeMemoryCore({
        text: "safe fact",
        provenance: "explicit",
        policyCharacterId: "agent-1",
        scope: "global",
      })
    ).resolves.toEqual({ ok: false, reason: "scope_denied" })
  })

  it("returns policy results for disabled / temporary / PII", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
    expect(await storeMemoryCore({ text: "x", provenance: "system" })).toEqual({
      ok: false,
      reason: "disabled",
    })
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, temporary: true } })
    expect(await storeMemoryCore({ text: "x", provenance: "system" })).toEqual({
      ok: false,
      reason: "temporary",
    })
    mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
    expect(await storeMemoryCore({ text: PII_TEXT, provenance: "system" })).toEqual({
      ok: false,
      reason: "pii_blocked",
    })
    expect(mockConsolidate).not.toHaveBeenCalled()
  })

  it("audits a PII block so the settings pane can count withheld writes", async () => {
    // The block used to return silently, leaving no record anywhere — the only
    // reason "N writes withheld" is reportable at all.
    await storeMemoryCore({
      text: PII_TEXT,
      provenance: "system",
      source: { sessionId: "s1" },
    })

    expect(mockAppendAudit).toHaveBeenCalledWith({
      action: "learn-denied",
      sessionId: "s1",
      reason: "pii_blocked",
      metadata: { provenance: "system", type: "semantic" },
    })
  })

  it("audits a PII block that survives redaction on the redact path", async () => {
    await storeMemoryCore({ text: PII_TEXT, provenance: "user", piiGate: "redact" })
    // Redaction may or may not clear the text; either way a block must audit and
    // a success must not.
    const blocked = mockAppendAudit.mock.calls.length > 0
    const stored = mockConsolidate.mock.calls.length > 0
    expect(blocked).toBe(!stored)
  })

  it("does not audit anything when the gate lets the write through", async () => {
    await storeMemoryCore({ text: "User ships on Fridays", provenance: "user" })
    expect(mockAppendAudit).not.toHaveBeenCalled()
  })

  it("still blocks when the audit write itself fails", async () => {
    mockAppendAudit.mockRejectedValue(new Error("db closed"))
    await expect(storeMemoryCore({ text: PII_TEXT, provenance: "system" })).resolves.toEqual({
      ok: false,
      reason: "pii_blocked",
    })
  })

  it("threads attribution into the consolidator and reports the ADDed id", async () => {
    const result = await storeMemoryCore({
      text: "User ships on Fridays",
      provenance: "external",
      attribution: ATTRIBUTION,
    })
    expect(result).toEqual({
      ok: true,
      stored: true,
      consolidated: true,
      memoryId: "mem_added",
      applied: ["ADD"],
    })
    expect(mockConsolidate).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: "external", attribution: ATTRIBUTION })
    )
  })

  it("forwards the complete namespace to consolidation", async () => {
    await storeMemoryCore({
      text: "Scoped fact",
      scope: "agent",
      projectId: "p1",
      agentId: "a1",
      branch: "main",
      pathPattern: "src",
      provenance: "explicit",
    })
    expect(mockConsolidate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "agent",
        projectId: "p1",
        agentId: "a1",
        branch: "main",
        pathPattern: "src",
      })
    )
  })

  it("returns conflict rows as stored and marks them for review", async () => {
    mockConsolidate.mockResolvedValue({
      applied: [
        {
          op: "CONFLICT",
          memory: { id: "mem_conflict" },
          targetId: "mem_existing",
          candidate: { type: "semantic" },
        },
      ],
    })
    const result = await storeMemoryCore({ text: "Conflicting fact", provenance: "explicit" })
    expect(result).toMatchObject({
      ok: true,
      stored: true,
      memoryId: "mem_conflict",
      applied: ["CONFLICT"],
    })
    expect(mockUpdateMemory).toHaveBeenCalledWith(
      "mem_conflict",
      expect.objectContaining({ reviewStatus: "conflict" })
    )
  })

  it("reports stored=false (ok) when the consolidator NOOPs", async () => {
    mockConsolidate.mockResolvedValue({ applied: [{ op: "NOOP" }] })
    const result = await storeMemoryCore({ text: "already known", provenance: "system" })
    expect(result).toEqual({ ok: true, stored: false, consolidated: true, applied: ["NOOP"] })
  })

  it("patches trimmed tags onto ADDed rows after consolidation", async () => {
    await storeMemoryCore({
      text: "fact",
      provenance: "external",
      tags: [" work ", "", "infra"],
    })
    expect(mockUpdateMemory).toHaveBeenCalledWith("mem_added", { tags: ["work", "infra"] })
  })

  it("falls back to a direct insert with attribution when no utility LLM exists", async () => {
    mockBuildDeps.mockResolvedValue(null)
    const result = await storeMemoryCore({
      text: "fact without llm",
      provenance: "external",
      attribution: ATTRIBUTION,
      tags: ["t1"],
    })
    expect(result).toEqual({
      ok: true,
      stored: true,
      consolidated: false,
      memoryId: "mem_new",
      applied: ["ADD"],
    })
    expect(mockCreateMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: "external",
        sourceChannel: "plugin",
        sourcePluginId: "com.example.notes",
        tags: ["t1"],
      })
    )
  })

  it("persists the scope rationale on the consolidated path", async () => {
    await storeMemoryCore({
      text: "fact",
      provenance: "explicit",
      scopeRationale: "user_configured_default",
    })
    expect(mockUpdateMemory).toHaveBeenCalledWith(
      "mem_added",
      expect.objectContaining({ scopeRationale: "user_configured_default" })
    )
  })

  it("persists the scope rationale on the degraded path", async () => {
    mockBuildDeps.mockResolvedValue(null)
    await storeMemoryCore({
      text: "fact",
      provenance: "explicit",
      scopeRationale: "session_workspace",
    })
    expect(mockCreateMemory).toHaveBeenCalledWith(
      expect.objectContaining({ scopeRationale: "session_workspace" })
    )
  })

  it("reports vector drift when the degraded path cannot index the new row", async () => {
    // Without this the fact is BM25-findable but missing from the vector index,
    // and nothing ever schedules a reconcile to notice.
    mockBuildDeps.mockResolvedValue(null)
    mockVectorSink.mockResolvedValue({
      upsert: jest.fn().mockRejectedValue(new Error("no backend")),
    })
    const result = await storeMemoryCore({ text: "fact", provenance: "explicit" })
    expect(result).toMatchObject({ ok: true, stored: true, consolidated: false })
    expect(mockNoteVectorFailure).toHaveBeenCalledTimes(1)
  })

  it("redact mode replaces PII and flags the result", async () => {
    const result = await storeMemoryCore({
      text: PII_TEXT,
      provenance: "system",
      piiGate: "redact",
    })
    expect(result.ok && result.piiRedacted).toBe(true)
    const candidate = mockConsolidate.mock.calls[0][0].candidates[0]
    expect(candidate.text).not.toContain("bob@example.com")
  })
})

describe("storeExternalMemory", () => {
  it("stores with external provenance and block-only PII gate", async () => {
    const result = await storeExternalMemory({ text: "User prefers dark mode" }, ATTRIBUTION)
    expect(result.ok).toBe(true)
    expect(mockConsolidate).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: "external",
        attribution: ATTRIBUTION,
        candidates: [expect.objectContaining({ type: "semantic", importance: 7 })],
      })
    )
    expect(await storeExternalMemory({ text: PII_TEXT }, ATTRIBUTION)).toEqual({
      ok: false,
      reason: "pii_blocked",
    })
  })

  it("rejects procedural even when smuggled past the type union", async () => {
    await expect(
      storeExternalMemory(
        { text: "x", type: "procedural" as unknown as "semantic" },
        { channel: "mcp" }
      )
    ).rejects.toThrow(/may not create procedural/)
  })

  it("denies a target namespace outside the caller's authorized set", async () => {
    const result = await storeExternalMemory(
      { text: "fact", scope: "workspace", projectId: "p1" },
      ATTRIBUTION,
      {
        principalId: "plugin:demo",
        transport: "plugin",
        namespaces: { projects: ["p-other"] },
      }
    )
    expect(result).toEqual({ ok: false, reason: "unauthorized_namespace" })
    expect(mockConsolidate).not.toHaveBeenCalled()
  })

  it("resolves policy from the caller binding — never the request's sessionId", async () => {
    await storeExternalMemory({ text: "fact", source: { sessionId: "req-sess" } }, ATTRIBUTION, {
      principalId: "plugin:demo",
      transport: "plugin",
      policyCharacterId: "agent-1",
    })
    expect(mockResolvePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: "agent-1", sessionId: undefined })
    )
  })

  describe("operationId idempotency", () => {
    it("reserves the key, executes, and records the receipt", async () => {
      const result = await storeExternalMemory({ text: "fact", operationId: "op-1" }, ATTRIBUTION, {
        principalId: "plugin:demo",
        transport: "plugin",
      })
      expect(result.ok).toBe(true)
      expect(mockRequestHash).toHaveBeenCalledWith("store", {
        text: "fact",
        importance: 7,
      })
      expect(mockReserve).toHaveBeenCalledWith({
        principalId: "plugin:demo",
        operationId: "op-1",
        requestHash: "req-hash",
        kind: "store",
      })
      expect(mockConsolidate).toHaveBeenCalledTimes(1)
      expect(mockRecordOp).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "plugin:demo:op-1",
          kind: "store",
          requestHash: "req-hash",
          memoryId: "mem_added",
          resultCode: "ok",
        })
      )
      expect(mockReleaseOp).not.toHaveBeenCalled()
    })

    it("replays a recorded receipt without re-running the consolidator", async () => {
      mockReserve.mockResolvedValue({
        state: "replay",
        receipt: { memoryId: "mem_prior", resultCode: "ok" },
      })
      const result = await storeExternalMemory({ text: "fact", operationId: "op-1" }, ATTRIBUTION)
      expect(result).toEqual({
        ok: true,
        stored: true,
        consolidated: true,
        memoryId: "mem_prior",
        applied: [],
      })
      expect(mockConsolidate).not.toHaveBeenCalled()
      expect(mockRecordOp).not.toHaveBeenCalled()
    })

    it("replays the receipt's recorded outcome, not a generic success shape", async () => {
      // The first call degraded to a direct insert (`consolidated: false`) —
      // the replay must answer the same, or the retry reports a write path
      // that never ran.
      mockReserve.mockResolvedValue({
        state: "replay",
        receipt: {
          memoryId: "mem_prior",
          resultCode: "ok",
          resultConsolidated: false,
          resultApplied: ["ADD"],
        },
      })
      const result = await storeExternalMemory({ text: "fact", operationId: "op-1" }, ATTRIBUTION)
      expect(result).toEqual({
        ok: true,
        stored: true,
        consolidated: false,
        memoryId: "mem_prior",
        applied: ["ADD"],
      })
      expect(mockConsolidate).not.toHaveBeenCalled()
    })

    it("refuses the same operation id carrying a different request", async () => {
      mockReserve.mockResolvedValue({ state: "conflict" })
      const result = await storeExternalMemory({ text: "fact", operationId: "op-1" }, ATTRIBUTION)
      expect(result).toEqual({ ok: false, reason: "idempotency_key_reused" })
      expect(mockConsolidate).not.toHaveBeenCalled()
    })

    it("waits out an in-flight twin and replays its receipt", async () => {
      mockReserve.mockResolvedValue({ state: "in_flight" })
      mockAwaitOp.mockResolvedValue({ memoryId: "mem_twin", resultCode: "ok" })
      const result = await storeExternalMemory({ text: "fact", operationId: "op-1" }, ATTRIBUTION)
      expect(result).toEqual({
        ok: true,
        stored: true,
        consolidated: true,
        memoryId: "mem_twin",
        applied: [],
      })
      expect(mockConsolidate).not.toHaveBeenCalled()
    })

    it("proceeds with its own execution when the in-flight wait times out", async () => {
      mockReserve.mockResolvedValue({ state: "in_flight" })
      mockAwaitOp.mockResolvedValue(undefined)
      const result = await storeExternalMemory({ text: "fact", operationId: "op-1" }, ATTRIBUTION)
      expect(result.ok).toBe(true)
      expect(mockConsolidate).toHaveBeenCalledTimes(1)
    })

    it("releases the reservation on a denied store so a corrected retry is free", async () => {
      mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
      const result = await storeExternalMemory({ text: "fact", operationId: "op-1" }, ATTRIBUTION)
      expect(result).toEqual({ ok: false, reason: "disabled" })
      expect(mockReleaseOp).toHaveBeenCalledWith("local-user", "op-1", "req-hash")
      expect(mockRecordOp).not.toHaveBeenCalled()
    })

    it("releases the reservation when the consolidator NOOPs (nothing applied)", async () => {
      mockConsolidate.mockResolvedValue({ applied: [{ op: "NOOP" }] })
      const result = await storeExternalMemory(
        { text: "already known", operationId: "op-1" },
        ATTRIBUTION
      )
      expect(result).toMatchObject({ ok: true, stored: false })
      expect(mockReleaseOp).toHaveBeenCalledWith("local-user", "op-1", "req-hash")
      expect(mockRecordOp).not.toHaveBeenCalled()
    })

    it("releases the reservation when the store throws, so a retry skips the wait", async () => {
      await expect(
        storeExternalMemory({ text: "fact", scope: "workspace", operationId: "op-1" }, ATTRIBUTION)
      ).rejects.toThrow("'projectId' is required")
      expect(mockReleaseOp).toHaveBeenCalledWith("local-user", "op-1", "req-hash")
      expect(mockRecordOp).not.toHaveBeenCalled()
    })

    it("skips the ledger entirely without an operationId", async () => {
      await storeExternalMemory({ text: "fact" }, ATTRIBUTION)
      expect(mockReserve).not.toHaveBeenCalled()
      expect(mockRecordOp).not.toHaveBeenCalled()
    })
  })
})
