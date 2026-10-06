import { hasLaunchableRuntime, isMigratable } from "@cognia/agent-contracts/ecosystem"
import { AIDER_CLI_EXECUTION_SEMANTICS, AIDER_CLI_PROTOCOL, aiderManifest } from "./manifest"

describe("aiderManifest", () => {
  it("is frozen data naming the aider-cli protocol and its semantics", () => {
    expect(Object.isFrozen(aiderManifest)).toBe(true)
    expect(Object.isFrozen(AIDER_CLI_EXECUTION_SEMANTICS)).toBe(true)
    expect(aiderManifest.protocols).toEqual([
      { protocol: AIDER_CLI_PROTOCOL, semantics: AIDER_CLI_EXECUTION_SEMANTICS },
    ])
  })

  it("publishes the ecosystem row the catalog lists", () => {
    expect(aiderManifest.ecosystem).toMatchObject({
      id: "aider",
      runtimeIds: ["aider"],
      sessionSourceIds: ["aider"],
      migrationVendor: null,
      pluginEcosystem: null,
    })
    expect(hasLaunchableRuntime(aiderManifest.ecosystem)).toBe(true)
    expect(isMigratable(aiderManifest.ecosystem)).toBe(false)
  })
})
