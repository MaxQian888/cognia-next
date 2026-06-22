import {
  PLUGIN_CAPABILITY_CONTRACTS,
  getPluginCapabilityContract,
  validatePluginCapabilities,
} from "./plugin-capabilities"

describe("plugin capability contracts", () => {
  const fieldDrivenModuleBridgeContracts = [
    ["workspace-backend", "workspaceBackends"],
    ["message-renderer", "messageRenderers"],
    ["density-preset", "densityPresets"],
    ["chat-middleware", "chatMiddlewares"],
    ["modal-mount", "modalMounts"],
    ["terminal-completion", "terminalCompletionProviders"],
    ["routing-strategy", "routingStrategies"],
    ["deployment-filter", "deploymentFilters"],
    ["protocol-adapter", "protocolAdapters"],
    ["tool-route", "toolRoutes"],
    ["context-provider", "contextProviders"],
  ] as const

  it("accepts the automation + companion capability tags (no longer 'unknown')", () => {
    for (const id of ["automation", "companion"] as const) {
      const contract = getPluginCapabilityContract(id)
      expect(contract).toBeDefined()
      expect(contract?.support).toBe("experimental")
    }
    const outcome = validatePluginCapabilities(["automation", "companion"])
    expect(outcome.allowed).toBe(true)
    expect(outcome.diagnostics.some((d) => d.code === "plugin.capability.unknown")).toBe(false)
  })

  it("covers each canonical plugin capability exactly once", () => {
    const ids = PLUGIN_CAPABILITY_CONTRACTS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(
      expect.arrayContaining([
        "tools",
        "components",
        "modes",
        "skills",
        "media",
        "canvas",
        "ai-provider",
        "themes",
        "commands",
        "hooks",
        "processors",
        "providers",
        "exporters",
        "importers",
        "a2ui",
        "python",
        "scheduler",
      ])
    )
  })

  it("promotes field-driven module bridge surfaces into canonical capability contracts", () => {
    const ids = fieldDrivenModuleBridgeContracts.map(([id]) => id)
    const outcome = validatePluginCapabilities(ids)

    expect(outcome.allowed).toBe(true)
    expect(outcome.diagnostics.some((d) => d.code === "plugin.capability.unknown")).toBe(false)

    for (const [id, manifestField] of fieldDrivenModuleBridgeContracts) {
      expect(getPluginCapabilityContract(id)).toEqual(
        expect.objectContaining({
          id,
          support: "supported",
          manifestFields: [manifestField],
          hostBindings: expect.arrayContaining(["lib/plugin/contracts/module-bridge-map.ts"]),
          typescriptSdk: expect.arrayContaining([`packages/plugin-sdk/src/define/define-${id}.ts`]),
        })
      )
    }
  })

  it("exposes support level and runtime metadata for a capability", () => {
    expect(getPluginCapabilityContract("tools")).toEqual(
      expect.objectContaining({
        id: "tools",
        support: "supported",
        manifestFields: expect.any(Array),
        hostBindings: expect.any(Array),
        typescriptSdk: expect.any(Array),
        pythonSdk: expect.any(Array),
        builtinContributionPaths: expect.any(Array),
        runtimeBinding: expect.any(String),
        docs: expect.any(String),
        requiredTests: expect.any(Array),
      })
    )
  })

  it("records SDK contract surfaces and host bindings for every supported capability", () => {
    const supportedContracts = PLUGIN_CAPABILITY_CONTRACTS.filter(
      (entry) => entry.support === "supported"
    )

    for (const contract of supportedContracts) {
      expect(contract.hostBindings.length).toBeGreaterThan(0)
      expect(contract.typescriptSdk.length).toBeGreaterThan(0)
      expect(contract.pythonSdk.length).toBeGreaterThan(0)
    }
  })

  it("marks media, canvas, and ai-provider capability contracts as supported", () => {
    expect(getPluginCapabilityContract("media")).toEqual(
      expect.objectContaining({
        id: "media",
        support: "supported",
        requiredTests: expect.arrayContaining(["lib/plugin/api/media-api.test.ts"]),
      })
    )

    expect(getPluginCapabilityContract("canvas")).toEqual(
      expect.objectContaining({
        id: "canvas",
        support: "supported",
        requiredTests: expect.arrayContaining(["lib/plugin/api/canvas-api.test.ts"]),
      })
    )

    expect(getPluginCapabilityContract("ai-provider")).toEqual(
      expect.objectContaining({
        id: "ai-provider",
        support: "supported",
        requiredTests: expect.arrayContaining(["lib/plugin/api/ai-provider-api.test.ts"]),
      })
    )
  })

  it("records built-in contribution paths for primary runtime capabilities", () => {
    const toolsContract = getPluginCapabilityContract("tools")
    const commandsContract = getPluginCapabilityContract("commands")
    const hooksContract = getPluginCapabilityContract("hooks")

    expect(toolsContract?.builtinContributionPaths?.length).toBeGreaterThan(0)
    expect(commandsContract?.builtinContributionPaths?.length).toBeGreaterThan(0)
    expect(hooksContract?.builtinContributionPaths?.length).toBeGreaterThan(0)
    expect(toolsContract?.builtinContributionPaths).toEqual(
      expect.arrayContaining([
        "plugins/workspace-tools/src/index.ts",
        "plugins/clipboard-tools/src/index.ts",
        "plugins/web-tools/src/index.ts",
      ])
    )
    expect(commandsContract?.builtinContributionPaths).toEqual(
      expect.arrayContaining([
        "plugins/workspace-tools/src/index.ts",
        "plugins/clipboard-tools/src/index.ts",
        "plugins/web-tools/src/index.ts",
      ])
    )
    expect(hooksContract?.builtinContributionPaths).toEqual(
      expect.arrayContaining([
        "plugins/workspace-tools/src/index.ts",
        "plugins/clipboard-tools/src/index.ts",
        "plugins/web-tools/src/index.ts",
      ])
    )
  })
})
