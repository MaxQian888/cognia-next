import type { PlatformAdapter, AdapterMeta } from "./adapter"

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
    }
    const a: PlatformAdapter = new Stub()
    expect(a.meta.type).toBe("telegram")
  })
})
