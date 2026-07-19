import { runMemoryStore } from "./memory-store"
import type { StoreMemoryCoreInput, StoreMemoryCoreResult } from "@/lib/memory/api/store-memory"
import type { StepExecutionContext } from "@/types/workflow/visual"

const mockStoreMemoryCore = jest.fn<Promise<StoreMemoryCoreResult>, [StoreMemoryCoreInput]>()
jest.mock("@/lib/memory/api/store-memory", () => ({
  storeMemoryCore: (input: StoreMemoryCoreInput) => mockStoreMemoryCore(input),
}))

const PII_TEXT = "reach me at bob@example.com"

function makeCtx(params: Record<string, unknown>): StepExecutionContext {
  return {
    runId: "run1",
    workflowId: "wf1",
    stepId: "n1",
    params,
    upstream: {},
    trigger: { kind: "trigger.manual", payload: {} } as StepExecutionContext["trigger"],
    signal: new AbortController().signal,
    log: jest.fn(),
    resolveSecret: jest.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockStoreMemoryCore.mockResolvedValue({
    ok: true,
    stored: true,
    consolidated: true,
    memoryId: "mem_new",
    applied: ["ADD"],
  })
})

describe("runMemoryStore", () => {
  it("rejects empty text and character scope without characterId", async () => {
    await expect(runMemoryStore(makeCtx({}))).rejects.toThrow(/non-empty 'text'/)
    await expect(runMemoryStore(makeCtx({ text: "x", scope: "character" }))).rejects.toThrow(
      /'characterId' is required/
    )
    expect(mockStoreMemoryCore).not.toHaveBeenCalled()
  })

  it("validates workspace/agent ids and forwards the complete namespace", async () => {
    await expect(runMemoryStore(makeCtx({ text: "x", scope: "workspace" }))).rejects.toThrow(
      /'projectId' is required/
    )
    await expect(runMemoryStore(makeCtx({ text: "x", scope: "agent" }))).rejects.toThrow(
      /'agentId' is required/
    )

    await runMemoryStore(
      makeCtx({
        text: "Agent-private fact",
        scope: "agent",
        projectId: "project1",
        agentId: "agent1",
        branch: "main",
        pathPattern: "lib/memory",
      })
    )
    expect(mockStoreMemoryCore).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "agent",
        projectId: "project1",
        agentId: "agent1",
        branch: "main",
        pathPattern: "lib/memory",
      })
    )
  })

  it("rejects procedural memories without explicit provenance", async () => {
    await expect(
      runMemoryStore(makeCtx({ text: "always use pnpm", type: "procedural" }))
    ).rejects.toThrow(/provenance 'explicit'/)

    const result = await runMemoryStore(
      makeCtx({ text: "always use pnpm", type: "procedural", provenance: "explicit" })
    )

    expect((result.output as { stored: boolean }).stored).toBe(true)
    expect(mockStoreMemoryCore).toHaveBeenCalledWith(
      expect.objectContaining({ type: "procedural", provenance: "explicit" })
    )
  })

  it("throws a clear error when memory is disabled", async () => {
    mockStoreMemoryCore.mockResolvedValue({ ok: false, reason: "disabled" })
    await expect(runMemoryStore(makeCtx({ text: "x" }))).rejects.toThrow(/disabled/)
  })

  it("no-ops with a warning in temporary mode", async () => {
    mockStoreMemoryCore.mockResolvedValue({ ok: false, reason: "temporary" })
    const ctx = makeCtx({ text: "x" })

    const result = await runMemoryStore(ctx)

    expect(result.output).toEqual({ stored: false, reason: "temporary_mode" })
    expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("temporary"))
  })

  it("blocks PII by default", async () => {
    mockStoreMemoryCore.mockResolvedValue({ ok: false, reason: "pii_blocked" })

    await expect(runMemoryStore(makeCtx({ text: PII_TEXT }))).rejects.toThrow(/contains PII/)
    expect(mockStoreMemoryCore).toHaveBeenCalledWith(
      expect.objectContaining({ text: PII_TEXT, piiGate: "block" })
    )
  })

  it("delegates redaction policy and flags the output", async () => {
    mockStoreMemoryCore.mockResolvedValue({
      ok: true,
      stored: true,
      consolidated: true,
      applied: ["ADD"],
      piiRedacted: true,
    })

    const result = await runMemoryStore(makeCtx({ text: PII_TEXT, piiGate: "redact" }))

    expect((result.output as { piiRedacted?: boolean }).piiRedacted).toBe(true)
    expect(mockStoreMemoryCore).toHaveBeenCalledWith(
      expect.objectContaining({ text: PII_TEXT, piiGate: "redact" })
    )
  })

  it("delegates all workflow inputs to the shared memory API", async () => {
    const result = await runMemoryStore(
      makeCtx({
        text: "  User ships on Fridays  ",
        scope: "character",
        characterId: "char1",
        type: "episodic",
        importance: 9,
        key: "ship-day",
        provenance: "explicit",
      })
    )

    expect(result.output).toEqual({ stored: true, consolidated: true, applied: ["ADD"] })
    expect(mockStoreMemoryCore).toHaveBeenCalledWith({
      text: "User ships on Fridays",
      scope: "character",
      characterId: "char1",
      projectId: undefined,
      agentId: undefined,
      branch: undefined,
      pathPattern: undefined,
      type: "episodic",
      key: "ship-day",
      importance: 9,
      provenance: "explicit",
      piiGate: "block",
    })
  })

  it("reports stored=false when consolidation NOOPs", async () => {
    mockStoreMemoryCore.mockResolvedValue({
      ok: true,
      stored: false,
      consolidated: true,
      applied: ["NOOP"],
    })

    const result = await runMemoryStore(makeCtx({ text: "already known" }))

    expect(result.output).toEqual({ stored: false, consolidated: true, applied: ["NOOP"] })
  })

  it("maps degraded shared-core results without duplicating fallback persistence", async () => {
    mockStoreMemoryCore.mockResolvedValue({
      ok: true,
      stored: true,
      consolidated: false,
      memoryId: "mem_new",
      applied: ["ADD"],
    })
    const ctx = makeCtx({ text: "fact without llm" })

    const result = await runMemoryStore(ctx)

    expect(result.output).toEqual({
      stored: true,
      consolidated: false,
      memoryId: "mem_new",
    })
    expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("without consolidation"))
  })

  it("preserves the shared core's redaction flag on degraded results", async () => {
    mockStoreMemoryCore.mockResolvedValue({
      ok: true,
      stored: true,
      consolidated: false,
      memoryId: "mem_redacted",
      applied: ["ADD"],
      piiRedacted: true,
    })

    const result = await runMemoryStore(makeCtx({ text: PII_TEXT, piiGate: "redact" }))

    expect(result.output).toEqual({
      stored: true,
      consolidated: false,
      memoryId: "mem_redacted",
      piiRedacted: true,
    })
  })

  it("delegates raw importance so the shared core remains the single clamping implementation", async () => {
    await runMemoryStore(makeCtx({ text: "fact", importance: 42 }))

    expect(mockStoreMemoryCore).toHaveBeenCalledWith(expect.objectContaining({ importance: 42 }))
  })

  it("marks shared-core failures as non-retryable", async () => {
    mockStoreMemoryCore.mockRejectedValueOnce(new Error("database unavailable"))
    const errorResult = runMemoryStore(makeCtx({ text: "fact" }))
    await expect(errorResult).rejects.toThrow("database unavailable")
    await expect(errorResult).rejects.toMatchObject({ retryable: false })

    mockStoreMemoryCore.mockRejectedValueOnce("unknown failure")
    await expect(runMemoryStore(makeCtx({ text: "fact" }))).rejects.toThrow("unknown failure")
  })
})
