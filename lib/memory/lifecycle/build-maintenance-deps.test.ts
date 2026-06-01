import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@/types/memory/memory"

const mockBuildClient = jest.fn()
const mockBuildAutoDeps = jest.fn()
const mockDistillEpisodes = jest.fn()
const mockListMemories = jest.fn()
const mockInvalidate = jest.fn()

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

    const active = await deps!.decayDeps.listActive("global", "char_1")
    expect(mockListMemories).toHaveBeenCalledWith({
      scope: "global",
      status: "active",
      characterId: "char_1",
    })
    expect(active).toEqual([{ id: "m1" }])

    await deps!.decayDeps.invalidate("m1")
    expect(mockInvalidate).toHaveBeenCalledWith("m1")
  })
})
