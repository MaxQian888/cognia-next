import type { PlatformAdapter, AdapterMeta } from "./adapter"
import { buildA2UICapabilityMatrix } from "./capability"

describe("PlatformAdapter", () => {
  it("a minimal adapter compiles against the interface", () => {
    class Stub implements PlatformAdapter {
      readonly id = "stub-1"
      readonly meta: AdapterMeta = {
        type: "telegram",
        displayName: "Stub",
        version: "0.0.0",
        capabilities: ["send.text"],
        transportModes: ["longpoll"],
        configSchema: { type: "object", properties: {} },
      }
      async start() {}
      async stop() {}
      health() {
        return { state: "running" as const }
      }
      async send() {
        return { ok: true, platformMessageId: "1" }
      }
      a2uiCapability() {
        // Minimal adapter declares no native A2UI projection — every
        // component degrades to `plainTextMirror`.
        return buildA2UICapabilityMatrix({})
      }
    }
    const a: PlatformAdapter = new Stub()
    expect(a.meta.type).toBe("telegram")
    // Smoke-check the new contract: every component kind reports back.
    expect(a.a2uiCapability().Text).toBe("fallback")
  })
})
