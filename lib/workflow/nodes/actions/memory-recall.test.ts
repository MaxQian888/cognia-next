import { runMemoryRecall } from "./memory-recall"
import type { StepExecutionContext } from "@/types/workflow/visual"

const mockGetSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => mockGetSettings(),
}))

const mockTryBuildMemoryDeps = jest.fn()
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryDeps: (...args: unknown[]) => mockTryBuildMemoryDeps(...(args as [])),
}))

const mockRetrieveMemories = jest.fn()
jest.mock("@/lib/memory/retrieve/retriever", () => ({
  retrieveMemories: (...args: unknown[]) => mockRetrieveMemories(...(args as [])),
}))

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
  mockTryBuildMemoryDeps.mockResolvedValue({ loadCandidates: jest.fn() })
  mockRetrieveMemories.mockResolvedValue([
    {
      memory: {
        id: "mem1",
        text: "User prefers pnpm",
        type: "semantic",
        scope: "global",
        importance: 7,
      },
      relevance: 0.9,
      score: 0.8,
    },
  ])
})

describe("runMemoryRecall", () => {
  it("rejects an empty query (non-retryable)", async () => {
    await expect(runMemoryRecall(makeCtx({}))).rejects.toThrow(/non-empty 'query'/)
    try {
      await runMemoryRecall(makeCtx({ query: " " }))
    } catch (err) {
      expect((err as Error & { retryable?: boolean }).retryable).toBe(false)
    }
  })

  it("requires characterId for character scope", async () => {
    await expect(runMemoryRecall(makeCtx({ query: "q", scope: "character" }))).rejects.toThrow(
      /'characterId' is required/
    )
  })

  it("returns mapped entries on the happy path", async () => {
    const result = await runMemoryRecall(makeCtx({ query: "package manager", topK: 3 }))
    const output = result.output as { entries: Array<Record<string, unknown>>; degraded: boolean }
    expect(output.degraded).toBe(false)
    expect(output.entries).toEqual([
      expect.objectContaining({
        id: "mem1",
        text: "User prefers pnpm",
        relevance: 0.9,
        score: 0.8,
      }),
    ])
    expect(mockRetrieveMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        queryText: "package manager",
        topK: 3,
        relevanceFloor: 0.1,
        characterId: undefined,
      }),
      expect.anything()
    )
  })

  it("passes characterId through for character scope", async () => {
    await runMemoryRecall(makeCtx({ query: "q", scope: "character", characterId: "char1" }))
    expect(mockRetrieveMemories).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: "char1" }),
      expect.anything()
    )
  })

  it("degrades (no throw) when memory is disabled", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
    const ctx = makeCtx({ query: "q" })
    const result = await runMemoryRecall(ctx)
    expect(result.output).toEqual({ entries: [], degraded: true, reason: "memory_disabled" })
    expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("disabled"))
    expect(mockRetrieveMemories).not.toHaveBeenCalled()
  })

  it("degrades (no throw) when the backend is unavailable", async () => {
    mockTryBuildMemoryDeps.mockResolvedValue(undefined)
    const ctx = makeCtx({ query: "q" })
    const result = await runMemoryRecall(ctx)
    expect(result.output).toEqual({ entries: [], degraded: true, reason: "backend_unavailable" })
  })

  it("forwards the types filter", async () => {
    await runMemoryRecall(makeCtx({ query: "q", types: ["procedural"] }))
    expect(mockRetrieveMemories).toHaveBeenCalledWith(
      expect.objectContaining({ types: ["procedural"] }),
      expect.anything()
    )
  })

  it("forwards the configured decay half-life to the retriever", async () => {
    mockGetSettings.mockResolvedValue({ memory: { decayHalfLifeDays: 12 } })
    await runMemoryRecall(makeCtx({ query: "q" }))
    expect(mockRetrieveMemories).toHaveBeenCalledWith(
      expect.objectContaining({ recencyHalfLifeDays: 12 }),
      expect.anything()
    )
  })
})
