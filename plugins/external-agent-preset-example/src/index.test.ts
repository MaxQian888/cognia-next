/**
 * Registration test for the external-agent-preset-example reference plugin:
 * its manifest preset flows through the preset overlay, and its declarative
 * contextProviders entry flows through the context-providers bridge.
 */

import type { PluginContext } from "@cognia/plugin-sdk"
import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import { unregisterExternalAgentPresetsByPlugin as unregisterPresetsByPlugin } from "@cognia/plugin-sdk/api/external-agent-preset"
import definition, { manifest as moduleManifest, TYPED_CONTRIBUTIONS } from "./index"
// Read the JSON manifest, NOT the TS module overlay: this plugin is
// deliberately not bundled into the app, so an installed copy only ever sees
// plugin.json. Asserting the TS manifest is what hid the fact that the
// contributions existed nowhere an installed copy could reach.
import manifestJson from "../plugin.json"
import { createEnvBannerProvider } from "./context-provider"

const manifest = moduleManifest
const PLUGIN_ID = "cognia-external-agent-preset-example"

describe("external-agent-preset-example plugin", () => {
  // Plugin-scoped teardown — the pair the plugin manager calls on disable.
  // A registry-wide reset is not on the author surface and would also clear
  // presets and providers this plugin never contributed.
  beforeEach(() => {
    unregisterPresetsByPlugin(PLUGIN_ID)
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

  it("leaves registration to the manager: activating registers nothing itself", async () => {
    // The manager registers `externalAgentPresets[]` on enable; the plugin's
    // own code must not reach into the overlay. The teardown helper the
    // manager uses on disable finds nothing this plugin put there by hand.
    await definition.activate({} as PluginContext)
    expect(unregisterPresetsByPlugin(PLUGIN_ID)).toBe(0)
  })

  it("passes the installer's manifest validation", () => {
    expect(validatePluginManifest(manifest).errors).toEqual([])
    expect(manifest).toEqual(manifestJson)
  })

  it("installs from the built bundle and stays opt-in", () => {
    expect(manifest.main).toBe("dist/index.js")
    for (const runtime of Object.values(manifest.runtimeCompatibility ?? {})) {
      if (runtime?.availability === "supported") expect(runtime.entrypoint).toBe("dist/index.js")
    }
    expect(manifest.activationEvents).toBeUndefined()
  })

  it("declares a resolvable context-provider factory", async () => {
    const contribution = manifest.contextProviders?.[0]
    expect(contribution).toMatchObject({
      id: "env-banner",
      entry: "dist/context-provider.js",
      export: "createEnvBannerProvider",
    })
    expect(typeof createEnvBannerProvider).toBe("function")
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

describe("plugin.json is the shipped source of truth", () => {
  it("matches the typed preset definition", () => {
    expect(manifest.externalAgentPresets?.[0]).toEqual(TYPED_CONTRIBUTIONS.preset)
  })
})
