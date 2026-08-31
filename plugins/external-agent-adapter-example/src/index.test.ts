import type {
  ExternalAgentConfig,
  ExternalAgentMessage,
  ExternalAgentMessageDeltaEvent,
  PluginManifest,
} from "@cognia/plugin-sdk"
import definition, { TYPED_CONTRIBUTIONS } from "./index"
import manifestJson from "../plugin.json"
import { createDemoEchoAdapter, DEMO_ADAPTER_ID } from "./demo-adapter"

const manifest = manifestJson as unknown as PluginManifest
const PLUGIN_ID = "cognia-external-agent-adapter-example"
const PROTOCOL = `${PLUGIN_ID}:${DEMO_ADAPTER_ID}`

describe("external-agent-adapter-example plugin", () => {
  it("declares one adapter and one matching preset in the shipped manifest", () => {
    expect(definition.manifest.id).toBe(PLUGIN_ID)
    expect(manifest.externalAgentAdapters).toHaveLength(1)
    expect(manifest.externalAgentPresets).toHaveLength(1)
    expect(manifest.externalAgentPresets?.[0].protocol).toBe(PROTOCOL)
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining(["external-agent-adapter", "external-agent-preset"])
    )
  })

  it("creates a portable adapter that connects, tracks sessions, and echoes", async () => {
    const adapter = createDemoEchoAdapter()
    await adapter.connect({ id: "a1" } as ExternalAgentConfig)
    expect(adapter.isConnected()).toBe(true)

    const session = await adapter.createSession()
    expect(adapter.getSession(session.id)).toBe(session)

    const message: ExternalAgentMessage = {
      id: "m1",
      role: "user",
      content: [{ type: "text", text: "ping" }],
      timestamp: new Date(),
    }
    const events = []
    for await (const event of adapter.prompt(session.id, message)) events.push(event)
    const delta = events.find(
      (event): event is ExternalAgentMessageDeltaEvent => event.type === "message_delta"
    )
    expect(delta?.delta.text).toBe("echo: ping")
    expect(events.some((event) => event.type === "done")).toBe(true)

    await adapter.disconnect()
    expect(adapter.isConnected()).toBe(false)
    expect(adapter.getSessions()).toEqual([])
  })
})

describe("plugin.json is the shipped source of truth", () => {
  it("matches the typed adapter definition", () => {
    expect(manifest.externalAgentAdapters?.[0]).toEqual(TYPED_CONTRIBUTIONS.adapter)
  })

  it("matches the typed preset definition", () => {
    expect(manifest.externalAgentPresets?.[0]).toEqual(TYPED_CONTRIBUTIONS.preset)
  })
})
