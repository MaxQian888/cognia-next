import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@/types/memory/memory"

const mockBuildClient = jest.fn()
const mockBuildAutoDeps = jest.fn()
const mockDistillEpisodes = jest.fn()
const mockListMemories = jest.fn()
const mockInvalidate = jest.fn()
const mockUpdateMemory = jest.fn()
const mockCreateEvidence = jest.fn()
const mockAppendAudit = jest.fn()

jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...a: unknown[]) => mockBuildClient(...a),
}))
jest.mock("@/lib/memory/write/run-memory-extraction", () => ({
  buildAutoExtractionDeps: (...a: unknown[]) => mockBuildAutoDeps(...a),
}))
jest.mock("@/lib/memory/write/run-episodic-distill", () => ({
  distillEpisodes: (...a: unknown[]) => mockDistillEpisodes(...a),
}))
jest.mock("@/lib/db/memories", () => ({
  listMemories: (...a: unknown[]) => mockListMemories(...a),
  invalidateMemory: (...a: unknown[]) => mockInvalidate(...a),
  updateMemory: (...a: unknown[]) => mockUpdateMemory(...a),
}))
jest.mock("@/lib/db/memory-governance", () => ({
  createMemoryEvidence: (...a: unknown[]) => mockCreateEvidence(...a),
  appendMemoryAuditEvent: (...a: unknown[]) => mockAppendAudit(...a),
}))

import { buildEpisodicMaintenanceDeps } from "./build-maintenance-deps"

function cfg(over: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...over }
}
const params = { session: null, appSettings: null }

beforeEach(() => {
  jest.clearAllMocks()
  mockBuildClient.mockReturnValue({ complete: jest.fn() })
  mockBuildAutoDeps.mockResolvedValue({ extract: jest.fn(), consolidate: jest.fn() })
})

describe("buildEpisodicMaintenanceDeps", () => {
  it("returns null when no LLM client is available", async () => {
    mockBuildClient.mockReturnValue(null)
    expect(await buildEpisodicMaintenanceDeps(params, cfg())).toBeNull()
  })

  it("returns null when the auto-extraction deps cannot be built", async () => {
    mockBuildAutoDeps.mockResolvedValue(null)
    expect(await buildEpisodicMaintenanceDeps(params, cfg())).toBeNull()
  })

  it("wires distill (client) + consolidate (reused) + decay (db)", async () => {
    const consolidate = jest.fn()
    mockBuildAutoDeps.mockResolvedValue({ extract: jest.fn(), consolidate })
    mockDistillEpisodes.mockResolvedValue([{ type: "episodic", text: "x", importance: 5 }])
    mockListMemories.mockResolvedValue([{ id: "m1" }])

    const deps = await buildEpisodicMaintenanceDeps(params, cfg())
    expect(deps).toBeDefined()
    expect(deps!.distillDeps.consolidate).toBe(consolidate)

    await deps!.distillDeps.distill([{ role: "user", text: "hi" }])
    expect(mockDistillEpisodes).toHaveBeenCalled()

    const active = await deps!.decayDeps.listActive("workspace", {
      projectId: "project_1",
      branch: "main",
    })
    expect(mockListMemories).toHaveBeenCalledWith({
      scope: "workspace",
      status: "active",
      projectId: "project_1",
      branch: "main",
      exactNamespace: true,
    })
    expect(active).toEqual([{ id: "m1" }])

    await deps!.decayDeps.invalidate("m1")
    expect(mockInvalidate).toHaveBeenCalledWith("m1")

    await deps!.recordDistillation?.(
      {
        transcript: [],
        scope: "workspace",
        projectId: "project_1",
        provenance: "user",
        contaminationState: "external-context",
        source: { sessionId: "session_1" },
        config: cfg(),
      },
      [{ op: "ADD", memory: { id: "mem_1" } } as never]
    )
    expect(mockUpdateMemory).toHaveBeenCalledWith(
      "mem_1",
      expect.objectContaining({
        evidenceState: "supported",
        contaminationState: "external-context",
      })
    )
    expect(mockCreateEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: "mem_1", sourceId: "session-distill:session_1" })
    )
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: "mem_1", reason: "session_distillation" })
    )
  })

  it("wires recordDecay to one audit event per invalidated id", async () => {
    const deps = await buildEpisodicMaintenanceDeps(params, cfg())

    await deps!.recordDecay?.({ reason: "idle", memoryIds: ["m1", "m2"], sessionId: "s1" })

    expect(mockAppendAudit).toHaveBeenCalledTimes(2)
    expect(mockAppendAudit).toHaveBeenNthCalledWith(1, {
      action: "invalidated",
      memoryId: "m1",
      sessionId: "s1",
      reason: "idle",
    })
    expect(mockAppendAudit).toHaveBeenNthCalledWith(2, {
      action: "invalidated",
      memoryId: "m2",
      sessionId: "s1",
      reason: "idle",
    })
  })

  it("stamps the capacity reason distinctly from idle", async () => {
    const deps = await buildEpisodicMaintenanceDeps(params, cfg())
    await deps!.recordDecay?.({ reason: "capacity", memoryIds: ["m9"] })
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: "m9", reason: "capacity" })
    )
  })
})
