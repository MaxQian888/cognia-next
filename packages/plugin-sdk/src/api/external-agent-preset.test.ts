import * as sdk from "./external-agent-preset"
import type {
  ExternalAgentPresetConfig,
  ExternalAgentPresetId,
  PluginExternalAgentPresetDef,
} from "./external-agent-preset"

describe("plugin-sdk api/external-agent-preset", () => {
  it("exposes the authoring helper and dynamic external-agent preset registry", () => {
    expect(typeof sdk.defineExternalAgentPreset).toBe("function")
    expect(typeof sdk.registerExternalAgentPreset).toBe("function")
    expect(typeof sdk.unregisterExternalAgentPreset).toBe("function")
    expect(typeof sdk.unregisterExternalAgentPresetsByPlugin).toBe("function")
    expect(typeof sdk.getDynamicExternalAgentPresetEntry).toBe("function")
    expect(typeof sdk.listDynamicExternalAgentPresetEntries).toBe("function")
    expect(typeof sdk.listExternalAgentPresetIds).toBe("function")
    expect(typeof sdk.getExternalAgentPresetConfig).toBe("function")
    expect(typeof sdk.createAgentFromPreset).toBe("function")
    expect(typeof sdk.isFromPreset).toBe("function")
  })

  it("defineExternalAgentPreset is a typesafe identity function", () => {
    const def = sdk.defineExternalAgentPreset({
      id: "plugin-demo-agent",
      name: "Plugin Demo Agent",
      description: "Demo external agent provided by a plugin.",
      protocol: "custom",
      transport: "stdio",
      process: { command: "demo-agent", args: ["serve"] },
      defaultPermissionMode: "default",
      tags: ["plugin", "demo"],
    })

    expect(def.id).toBe("plugin-demo-agent")
    expect(def.protocol).toBe("custom")
  })

  it("aliases dynamic preset registry helpers with external-agent names", () => {
    const id = "plugin-sdk-test-preset"
    const config: ExternalAgentPresetConfig = {
      name: "SDK Test Preset",
      description: "Preset registered by the SDK test.",
      protocol: "custom",
      transport: "stdio",
      process: { command: "sdk-test", args: [] },
      defaultPermissionMode: "default",
      tags: ["test"],
    }

    try {
      expect(
        sdk.registerExternalAgentPreset(id, config, { pluginId: "plugin-sdk-test" })
      ).toBeUndefined()
      expect(sdk.listExternalAgentPresetIds()).toContain(id)
      expect(sdk.getExternalAgentPresetConfig(id)?.name).toBe("SDK Test Preset")
      expect(sdk.getDynamicExternalAgentPresetEntry(id)?.pluginId).toBe("plugin-sdk-test")
    } finally {
      sdk.unregisterExternalAgentPreset(id)
    }
  })

  it("re-exports external agent preset contribution types", () => {
    const assertTypes = <
      _T extends PluginExternalAgentPresetDef | ExternalAgentPresetConfig | ExternalAgentPresetId,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
