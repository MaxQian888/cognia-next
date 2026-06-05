import { runMemoryStore } from "./memory-store"
import type { StepExecutionContext } from "@/types/workflow/visual"

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
  mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
  mockConsolidate.mockResolvedValue({ applied: [{ op: "ADD" }] })
  mockBuildDeps.mockResolvedValue({ consolidate: mockConsolidate })
  mockCreateMemory.mockResolvedValue({ id: "mem_new", text: "stored" })
  mockVectorSink.mockResolvedValue(undefined)
})

describe("runMemoryStore", () => {
  it("rejects empty text and character scope without characterId", async () => {
    await expect(runMemoryStore(makeCtx({}))).rejects.toThrow(/non-empty 'text'/)
    await expect(runMemoryStore(makeCtx({ text: "x", scope: "character" }))).rejects.toThrow(
      /'characterId' is required/
    )
  })

  it("rejects procedural memories without explicit provenance", async () => {
    await expect(
      runMemoryStore(makeCtx({ text: "always use pnpm", type: "procedural" }))
    ).rejects.toThrow(/provenance 'explicit'/)
    // Explicit provenance is allowed.
    const result = await runMemoryStore(
      makeCtx({ text: "always use pnpm", type: "procedural", provenance: "explicit" })
    )
    expect((result.output as { stored: boolean }).stored).toBe(true)
  })

  it("throws a clear error when memory is disabled", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
    await expect(runMemoryStore(makeCtx({ text: "x" }))).rejects.toThrow(/disabled/)
  })

  it("no-ops with a warning in temporary mode", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, temporary: true } })
    const ctx = makeCtx({ text: "x" })
    const result = await runMemoryStore(ctx)
    expect(result.output).toEqual({ stored: false, reason: "temporary_mode" })
    expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("temporary"))
  })

  it("blocks PII by default", async () => {
    await expect(runMemoryStore(makeCtx({ text: PII_TEXT }))).rejects.toThrow(/contains PII/)
    expect(mockConsolidate).not.toHaveBeenCalled()
  })

  it("redacts PII when piiGate is redact and flags the output", async () => {
    const result = await runMemoryStore(makeCtx({ text: PII_TEXT, piiGate: "redact" }))
    expect((result.output as { piiRedacted?: boolean }).piiRedacted).toBe(true)
    const candidate = mockConsolidate.mock.calls[0][0].candidates[0]
    expect(candidate.text).not.toContain("bob@example.com")
  })

  it("consolidates through the shared pipeline on the happy path", async () => {
    const result = await runMemoryStore(
      makeCtx({ text: "User ships on Fridays", importance: 9, key: "ship-day" })
    )
    const output = result.output as Record<string, unknown>
    expect(output).toEqual({ stored: true, consolidated: true, applied: ["ADD"] })
    expect(mockConsolidate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "global",
        provenance: "system",
        candidates: [
          expect.objectContaining({
            type: "semantic",
            text: "User ships on Fridays",
            importance: 9,
            key: "ship-day",
          }),
        ],
      })
    )
  })

  it("reports stored=false when consolidation NOOPs", async () => {
    mockConsolidate.mockResolvedValue({ applied: [{ op: "NOOP" }] })
    const result = await runMemoryStore(makeCtx({ text: "already known" }))
    expect((result.output as { stored: boolean }).stored).toBe(false)
  })

  it("falls back to a direct insert when no utility LLM is available", async () => {
    mockBuildDeps.mockResolvedValue(null)
    const ctx = makeCtx({ text: "fact without llm" })
    const result = await runMemoryStore(ctx)
    const output = result.output as Record<string, unknown>
    expect(output.consolidated).toBe(false)
    expect(output.stored).toBe(true)
    expect(output.memoryId).toBe("mem_new")
    expect(mockCreateMemory).toHaveBeenCalledWith(
      expect.objectContaining({ text: "fact without llm", provenance: "system" })
    )
    expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("without consolidation"))
  })

  it("upserts the vector and links vectorDocId in the fallback path", async () => {
    mockBuildDeps.mockResolvedValue(null)
    const upsert = jest.fn().mockResolvedValue(undefined)
    mockVectorSink.mockResolvedValue({ upsert })
    await runMemoryStore(makeCtx({ text: "fact" }))
    expect(upsert).toHaveBeenCalledWith("mem_new", "stored")
    expect(mockUpdateMemory).toHaveBeenCalledWith("mem_new", { vectorDocId: "mem_new" })
  })

  it("swallows vector failures in the fallback path (memory still stored)", async () => {
    mockBuildDeps.mockResolvedValue(null)
    mockVectorSink.mockResolvedValue({ upsert: jest.fn().mockRejectedValue(new Error("vec down")) })
    const result = await runMemoryStore(makeCtx({ text: "fact" }))
    expect((result.output as { stored: boolean }).stored).toBe(true)
  })

  it("clamps importance into 1..10", async () => {
    await runMemoryStore(makeCtx({ text: "fact", importance: 42 }))
    expect(mockConsolidate.mock.calls[0][0].candidates[0].importance).toBe(10)
  })
})
