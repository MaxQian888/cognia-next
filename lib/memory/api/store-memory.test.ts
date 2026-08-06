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
})
