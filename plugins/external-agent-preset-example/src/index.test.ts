/**
 * Registration test for the external-agent-preset-example reference plugin:
 * its manifest preset flows through the preset overlay, and its declarative
 * contextProviders entry flows through the context-providers bridge.
 */

import definition, { manifest } from "./index"
import { createEnvBannerProvider } from "./context-provider"
import {
  registerPreset,
  unregisterPresetsByPlugin,
  getPresetConfig,
  __resetDynamicPresetsForTesting,
} from "@/lib/ai/agent/external/presets"
import { registerContextProvidersForPlugin } from "@/lib/plugin/bridge/context-providers-bridge"
import {
  getContextProvider,
  __resetContextProvidersForTesting,
} from "@/lib/plugin/registries/context-provider-registry"

const PLUGIN_ID = "cognia-external-agent-preset-example"

describe("external-agent-preset-example plugin", () => {
  beforeEach(() => {
    __resetDynamicPresetsForTesting()
    __resetContextProvidersForTesting()
  })

  it("declares one external-agent preset + one context provider in its manifest", () => {
    expect(definition.manifest.id).toBe(PLUGIN_ID)
    expect(manifest.externalAgentPresets).toHaveLength(1)
    expect(manifest.contextProviders).toHaveLength(1)
    expect(manifest.capabilities).toContain("external-agent-preset")
    expect(manifest.capabilities).toContain("context-provider")
  })

  it("uses a unique preset id that never shadows a builtin", () => {
    const id = manifest.externalAgentPresets?.[0].id
    expect(id).toBe("example-acp-cli")
    expect(["codex", "claude-code", "gemini-cli", "cursor-cli"]).not.toContain(id)
  })

  it("registers + resolves its preset through the overlay, then cleans up", () => {
    const def = manifest.externalAgentPresets![0]
    const { id, ...config } = def
    registerPreset(id, config, { pluginId: PLUGIN_ID })

    expect(getPresetConfig("example-acp-cli")?.name).toBe("Example ACP CLI")

    expect(unregisterPresetsByPlugin(PLUGIN_ID)).toBe(1)
    expect(getPresetConfig("example-acp-cli")).toBeNull()
  })

  it("registers its context provider through the bridge", async () => {
    const importer = async () => ({ createEnvBannerProvider })
    const result = await registerContextProvidersForPlugin(manifest, "/plugins/example", {
      importer,
    })
    expect(result.registered).toBe(1)
    expect(getContextProvider(`${PLUGIN_ID}:env-banner`)).toBeDefined()
  })

  it("the context provider contributes a banner for a non-empty prompt", () => {
    const provider = createEnvBannerProvider({
      providerId: `${PLUGIN_ID}:env-banner`,
      pluginId: PLUGIN_ID,
    })
    expect(provider.provide({ prompt: "do work" })).toMatch(/external CLI/)
    expect(provider.provide({ prompt: "   " })).toBeNull()
  })
})
