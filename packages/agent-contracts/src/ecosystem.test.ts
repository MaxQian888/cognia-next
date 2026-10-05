import {
  hasLaunchableRuntime,
  isMigratable,
  semanticsForPreset,
  type AgentEcosystemEntry,
  type AgentProtocolIntegration,
} from "./ecosystem"
import { UNDECLARED_EXECUTION_SEMANTICS, type AgentExecutionSemantics } from "./semantics"

const entry: AgentEcosystemEntry = {
  id: "example",
  runtimeIds: [],
  sessionSourceIds: ["example"],
  migrationVendor: null,
  vendorRootKeys: [],
  configRootKey: null,
  probeRootKeys: [],
  pluginEcosystem: null,
  subagentSourceId: null,
  memoryAgentId: null,
}

describe("ecosystem entries", () => {
  it("tell history-only ecosystems from launchable ones", () => {
    expect(hasLaunchableRuntime(entry)).toBe(false)
    expect(hasLaunchableRuntime({ ...entry, runtimeIds: ["example-acp"] })).toBe(true)
  })

  it("mark only entries with a migration vendor as migratable", () => {
    expect(isMigratable(entry)).toBe(false)
    expect(isMigratable({ ...entry, migrationVendor: "example" })).toBe(true)
  })
})

describe("semanticsForPreset", () => {
  const refined: AgentExecutionSemantics = {
    ...UNDECLARED_EXECUTION_SEMANTICS,
    cancel: { scope: "turn", reconnectsAfterCancel: false },
  }
  const integration: AgentProtocolIntegration = {
    protocol: "example",
    semantics: UNDECLARED_EXECUTION_SEMANTICS,
    presetSemantics: { "example-fast": refined },
  }

  it("uses the preset refinement when one exists", () => {
    expect(semanticsForPreset(integration, "example-fast")).toBe(refined)
  })

  it("falls back to the protocol semantics for other or missing presets", () => {
    expect(semanticsForPreset(integration, "other")).toBe(UNDECLARED_EXECUTION_SEMANTICS)
    expect(semanticsForPreset(integration, undefined)).toBe(UNDECLARED_EXECUTION_SEMANTICS)
  })
})
