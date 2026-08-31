import { BUILT_IN_PROVIDER_IDS } from "@cognia/provider-types/built-in-provider-catalog"
import {
  buildBuiltInProviderContractMatrix,
  buildCustomProviderContract,
} from "./provider-contract-matrix"

describe("provider contract matrix", () => {
  it("covers every catalog provider exactly once with reachable runtime and persistence data", () => {
    const matrix = buildBuiltInProviderContractMatrix()
    expect(matrix.map((contract) => contract.id)).toEqual(BUILT_IN_PROVIDER_IDS)
    for (const contract of matrix) {
      expect(contract.protocol).toBeTruthy()
      expect(contract.runtimeAdapter).toBeTruthy()
      expect(contract.parameterSchema.providerId).toBe(contract.id)
      expect(contract.persistenceTarget).toBe("providerSettings")
      expect(contract.modelSources).toEqual(["catalog", "discovered", "manual"])
    }
  })

  it("preserves local credential requirements and excludes native Ollama-only controls", () => {
    const local = buildBuiltInProviderContractMatrix().filter(
      (contract) => contract.kind === "local"
    )
    expect(local.length).toBeGreaterThan(0)
    for (const contract of local) {
      expect(contract.parameterSchema.parameters).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: expect.stringMatching(/^ollama\./) }),
        ])
      )
    }
    expect(local.find((entry) => entry.id === "ollama")?.credentials).toBe("keyless")
    expect(local.find((entry) => entry.id === "cliproxyapi")?.credentials).toBe("api-key")
  })

  it("inherits protocol schemas for custom providers while persisting to their own rows", () => {
    const contract = buildCustomProviderContract({
      id: "corp-gateway",
      protocol: "anthropic",
      name: "Corp Gateway",
    })
    expect(contract).toMatchObject({
      id: "corp-gateway",
      protocol: "anthropic",
      persistenceTarget: "customProviders",
      runtimeAdapter: "anthropic",
    })
    expect(contract.parameterSchema.providerId).toBe("corp-gateway")
    expect(contract.parameterSchema.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "anthropic.thinking.enabled" })])
    )
  })
})
