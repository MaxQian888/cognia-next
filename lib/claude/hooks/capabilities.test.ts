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
      handlers: { command: "supported", http: "supported", prompt: "unsupported" },
    })
    expect(hookRuntimeCapability("cli").handlers.http).toBe("unsupported")
  })
})
