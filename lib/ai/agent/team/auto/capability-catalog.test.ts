import {
  EMPTY_CAPABILITY_CATALOG,
  MAX_CATALOG_IDS_PER_BUCKET,
  gatherCapabilityCatalog,
} from "./capability-catalog"
import type { KnownCapabilityIds } from "@/lib/ai/agent/team/capability-audit"

jest.mock("@/lib/ai/agent/team/capability-audit", () => ({
  buildKnownCapabilityIds: jest.fn(async () => ({
    skillIds: new Set(["host-skill"]),
    mcpServerIds: new Set(),
    nativeAnthropicToolIds: new Set(),
    characterPackIds: new Set(),
    externalAgentPresetIds: new Set(),
    subagentIds: new Set(),
    a2uiTemplateIds: new Set(),
    sharedMemoryAdapterIds: new Set(),
  })),
}))

function known(overrides: Partial<KnownCapabilityIds> = {}): KnownCapabilityIds {
  return {
    skillIds: new Set(),
    mcpServerIds: new Set(),
    nativeAnthropicToolIds: new Set(),
    characterPackIds: new Set(),
    externalAgentPresetIds: new Set(),
    subagentIds: new Set(),
    a2uiTemplateIds: new Set(),
    sharedMemoryAdapterIds: new Set(),
    ...overrides,
  }
}

describe("gatherCapabilityCatalog", () => {
  it("projects known-id sets into sorted arrays across the six buckets", async () => {
    const catalog = await gatherCapabilityCatalog({
      buildKnownIds: async () =>
        known({
          skillIds: new Set(["zeta", "alpha"]),
          subagentIds: new Set(["workflow-debugger", "workflow-designer"]),
          externalAgentPresetIds: new Set(["claude-code"]),
        }),
    })
    expect(catalog.skillIds).toEqual(["alpha", "zeta"])
    expect(catalog.subagentIds).toEqual(["workflow-debugger", "workflow-designer"])
    expect(catalog.externalAgentPresetIds).toEqual(["claude-code"])
    expect(catalog.mcpServerIds).toEqual([])
  })

  it("does not expose the a2uiTemplate / shared-memory buckets", async () => {
    const catalog = await gatherCapabilityCatalog({
      buildKnownIds: async () => known({ a2uiTemplateIds: new Set(["t1"]) }),
    })
    expect(catalog).not.toHaveProperty("a2uiTemplateIds")
    expect(catalog).not.toHaveProperty("sharedMemoryAdapterIds")
  })

  it("caps each bucket at MAX_CATALOG_IDS_PER_BUCKET", async () => {
    const big = new Set(Array.from({ length: 200 }, (_, i) => `s${String(i).padStart(3, "0")}`))
    const catalog = await gatherCapabilityCatalog({
      buildKnownIds: async () => known({ skillIds: big }),
    })
    expect(catalog.skillIds).toHaveLength(MAX_CATALOG_IDS_PER_BUCKET)
    expect(catalog.skillIds[0]).toBe("s000")
  })

  it("defaults to the live audit builder when no dep is injected", async () => {
    const catalog = await gatherCapabilityCatalog()
    expect(catalog.skillIds).toEqual(["host-skill"])
    expect(Object.keys(catalog).sort()).toEqual(
      [
        "characterPackIds",
        "externalAgentPresetIds",
        "mcpServerIds",
        "nativeAnthropicToolIds",
        "skillIds",
        "subagentIds",
      ].sort()
    )
  })

  it("EMPTY_CAPABILITY_CATALOG has all six empty buckets", () => {
    expect(Object.values(EMPTY_CAPABILITY_CATALOG).every((v) => v.length === 0)).toBe(true)
  })
})
