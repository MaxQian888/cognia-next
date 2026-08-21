import { HOOK_EVENTS } from "./event-catalog"
import { HOOK_RUNTIME_CAPABILITIES, hookRuntimeCapability } from "./capabilities"

describe("HOOK_RUNTIME_CAPABILITIES", () => {
  it("pins every runtime to the shared 31-event identity", () => {
    for (const descriptor of Object.values(HOOK_RUNTIME_CAPABILITIES)) {
      expect(descriptor.events).toEqual(HOOK_EVENTS)
      expect(descriptor.events).toHaveLength(31)
    }
  })

  it("declares execution and outbound security instead of silently inferring it", () => {
    expect(hookRuntimeCapability("claude-agent-sdk")).toMatchObject({
      version: "0.3.220",
      ownership: "sdk-native",
      piiGate: "required",
      handlers: { command: "supported", http: "supported" },
    })
    expect(hookRuntimeCapability("cli").handlers.http).toBe("unsupported")
  })

  it("reports the model-backed handlers as supported only on the sidecar rail", () => {
    // `sidecar/dispatch/hook-native-executor.mjs` runs prompt/agent/mcp_tool as
    // nested `query()` calls; the Rust host deserializes them to `Unsupported`
    // and the CLI's own runner spawns commands only. This table is the ONLY
    // source the settings panel reads to decide which handler types a user may
    // pick, so an over-conservative entry hides working functionality and an
    // over-generous one offers a handler that will never run.
    for (const type of ["prompt", "agent", "mcp_tool"] as const) {
      expect(hookRuntimeCapability("claude-agent-sdk").handlers[type]).toBe("supported")
      expect(hookRuntimeCapability("rust-host").handlers[type]).toBe("unsupported")
      expect(hookRuntimeCapability("cli").handlers[type]).toBe("unsupported")
    }
  })

  it("keeps the CLI fallback runner honest about command-only execution", () => {
    // The CLI now injects its config so a real turn runs on the sidecar rail;
    // this descriptor is only the fallback for when there is nothing to inject.
    const cli = hookRuntimeCapability("cli")
    expect(cli.handlers.command).toBe("supported")
    expect(cli.handlers.http).toBe("unsupported")
    expect(cli.handlers.webhook).toBe("unsupported")
  })
})
