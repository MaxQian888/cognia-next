import { hasLaunchableRuntime, isMigratable, type AgentEcosystemEntry } from "./types"

const base: AgentEcosystemEntry = {
  id: "example",
  runtimeIds: [],
  sessionSourceIds: [],
  migrationVendor: null,
  vendorRootKeys: [],
  configRootKey: null,
  probeRootKeys: [],
  pluginEcosystem: null,
  subagentSourceId: null,
  memoryAgentId: null,
}

describe("hasLaunchableRuntime", () => {
  it("is false for a history-only ecosystem", () => {
    expect(hasLaunchableRuntime(base)).toBe(false)
  })

  it("is true once a runtime is listed", () => {
    expect(hasLaunchableRuntime({ ...base, runtimeIds: ["codex-acp"] })).toBe(true)
  })
})

describe("isMigratable", () => {
  it("is false without a migration vendor", () => {
    expect(isMigratable(base)).toBe(false)
  })

  it("is true with one", () => {
    expect(isMigratable({ ...base, migrationVendor: "codex" })).toBe(true)
  })
})
