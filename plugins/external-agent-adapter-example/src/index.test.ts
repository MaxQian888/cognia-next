/**
 * Registration test for the external-agent-adapter-example reference plugin:
 * its manifest adapter flows through the external-agent-adapters bridge into
 * the protocolAdapterRegistry, its matching preset flows through the preset
 * overlay, and the contributed adapter is createable + behaves (echo).
 */

import type { PluginManifest } from "@/types/plugin"
import definition, { TYPED_CONTRIBUTIONS } from "./index"
// Read the JSON manifest, NOT the TS module overlay: this plugin is in
// `INTENTIONALLY_UNBUNDLED`, so an installed copy only ever sees plugin.json.
// Asserting the TS manifest is what hid the fact that the contributions
// existed nowhere an installed copy could reach.
import manifestJson from "../plugin.json"
const manifest = manifestJson as unknown as PluginManifest
import { createDemoEchoAdapter, DEMO_ADAPTER_ID } from "./demo-adapter"
import {
  registerExternalAgentAdaptersForPlugin,
  unregisterExternalAgentAdaptersForPlugin,
} from "@/lib/plugin/bridge/external-agent-adapters-bridge"
import {
  protocolAdapterRegistry,
  __resetPluginProtocolAdaptersForTesting,
} from "@/lib/ai/agent/external/protocol-adapter"
import {
  registerPreset,
  unregisterPresetsByPlugin,
  getPresetConfig,
  createAgentFromPreset,
  __resetDynamicPresetsForTesting,
} from "@/lib/ai/agent/external/presets"
import { getExternalAgentExecutionBlock } from "@/lib/ai/agent/external/config-normalizer"
import type {
  ExternalAgentConfig,
  ExternalAgentMessage,
  ExternalAgentMessageDeltaEvent,
} from "@/types/agent/external-agent"

const PLUGIN_ID = "cognia-external-agent-adapter-example"
const PROTOCOL = `${PLUGIN_ID}:${DEMO_ADAPTER_ID}`

describe("external-agent-adapter-example plugin", () => {
  beforeEach(() => {
    __resetPluginProtocolAdaptersForTesting()
    __resetDynamicPresetsForTesting()
  })
  afterEach(() => {
    __resetPluginProtocolAdaptersForTesting()
    __resetDynamicPresetsForTesting()
  })

  it("declares one adapter + one matching preset in its manifest", () => {
    expect(definition.manifest.id).toBe(PLUGIN_ID)
    expect(manifest.externalAgentAdapters).toHaveLength(1)
    expect(manifest.externalAgentPresets).toHaveLength(1)
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining(["external-agent-adapter", "external-agent-preset"])
    )
  })

  it("the preset references the namespaced adapter protocol", () => {
    expect(manifest.externalAgentPresets?.[0].protocol).toBe(PROTOCOL)
  })

  it("registers its adapter through the bridge, then cleans up on disable", async () => {
    const importer = async () => ({ createDemoEchoAdapter })
    const result = await registerExternalAgentAdaptersForPlugin(manifest, "/plugins/example", {
      importer,
    })
    expect(result).toEqual({ registered: 1, errors: [] })
    expect(protocolAdapterRegistry.has(PROTOCOL)).toBe(true)

    unregisterExternalAgentAdaptersForPlugin(PLUGIN_ID)
    expect(protocolAdapterRegistry.has(PROTOCOL)).toBe(false)
  })

  it("registers + resolves its preset through the overlay", () => {
    const def = manifest.externalAgentPresets![0]
    const { id, ...config } = def
    registerPreset(id, config, { pluginId: PLUGIN_ID })
    expect(getPresetConfig("demo-echo-agent")?.protocol).toBe(PROTOCOL)
    expect(unregisterPresetsByPlugin(PLUGIN_ID)).toBe(1)
    expect(getPresetConfig("demo-echo-agent")).toBeNull()
  })

  it("the contributed agent is executable while enabled and blocks once disabled", async () => {
    const importer = async () => ({ createDemoEchoAdapter })
    await registerExternalAgentAdaptersForPlugin(manifest, "/plugins/example", { importer })
    const def = manifest.externalAgentPresets![0]
    const { id, ...config } = def
    registerPreset(id, config, { pluginId: PLUGIN_ID })

    const cfg = createAgentFromPreset("demo-echo-agent")!
    expect(cfg.protocol).toBe(PROTOCOL)
    // Non-stdio transport → runtimeIsTauri is irrelevant; executable while the
    // adapter is registered (ADR-0051 "executable while enabled").
    expect(getExternalAgentExecutionBlock(cfg, false)).toBeNull()

    unregisterExternalAgentAdaptersForPlugin(PLUGIN_ID)
    expect(getExternalAgentExecutionBlock(cfg, false)?.code).toBe("protocol_unsupported")
  })

  it("the contributed adapter is createable and echoes a prompt", async () => {
    const importer = async () => ({ createDemoEchoAdapter })
    await registerExternalAgentAdaptersForPlugin(manifest, "/plugins/example", { importer })

    const adapter = protocolAdapterRegistry.create(PROTOCOL)
    expect(adapter).toBeDefined()
    await adapter!.connect({ id: "a1" } as ExternalAgentConfig)
    expect(adapter!.isConnected()).toBe(true)

    const session = await adapter!.createSession()
    const message: ExternalAgentMessage = {
      id: "m1",
      role: "user",
      content: [{ type: "text", text: "ping" }],
      timestamp: new Date(),
    }
    const events = []
    for await (const event of adapter!.prompt(session.id, message)) {
      events.push(event)
    }
    const delta = events.find(
      (e): e is ExternalAgentMessageDeltaEvent => e.type === "message_delta"
    )
    expect(delta?.delta.text).toBe("echo: ping")
    expect(events.some((e) => e.type === "done")).toBe(true)
  })
})

describe("plugin.json is the shipped source of truth", () => {
  // plugin.json is what an installed copy reads. These assertions keep it
  // honest against the SDK types via the typed mirrors in index.ts.
  it("matches the typed adapter definition", () => {
    expect(manifest.externalAgentAdapters?.[0]).toEqual(TYPED_CONTRIBUTIONS.adapter)
  })

  it("matches the typed preset definition", () => {
    expect(manifest.externalAgentPresets?.[0]).toEqual(TYPED_CONTRIBUTIONS.preset)
  })
})
