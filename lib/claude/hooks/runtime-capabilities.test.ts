import {
  CODEX_HOOK_EVENTS,
  HOOK_CAPABILITY_CONTRACT_VERSION,
  knownHookRuntimeCapabilities,
  resolveHookRuntimeCapabilities,
} from "./runtime-capabilities"

describe("hook runtime capabilities", () => {
  it("publishes a versioned Claude contract with all native handler kinds", () => {
    const capabilities = knownHookRuntimeCapabilities("claude")

    expect(capabilities.contractVersion).toBe(HOOK_CAPABILITY_CONTRACT_VERSION)
    expect(capabilities.events).toHaveLength(31)
    // `plugin` runs an installed plugin's own hook handler through the
    // renderer round-trip. Sidecar-only, which is why the codex/opencode
    // manifests below do not carry it.
    expect(capabilities.handlerTypes).toEqual([
      "command",
      "http",
      "mcp_tool",
      "prompt",
      "agent",
      "plugin",
    ])
    expect(capabilities.executionOwner).toBe("sdk")
  })

  it("publishes the eleven events proven by the current Codex runtime", () => {
    const capabilities = knownHookRuntimeCapabilities("codex")

    expect(capabilities.events).toEqual(CODEX_HOOK_EVENTS)
    expect(capabilities.events).toHaveLength(11)
    expect(capabilities.handlerTypes).toEqual(["command"])
  })

  it("intersects a runtime probe with the safe provider manifest", () => {
    const capabilities = resolveHookRuntimeCapabilities("codex", {
      runtimeVersion: "0.145.0",
      events: ["SessionStart", "SessionEnd", "Setup"],
      handlerTypes: ["command", "http"],
    })

    expect(capabilities.events).toEqual(["SessionStart", "SessionEnd"])
    expect(capabilities.handlerTypes).toEqual(["command"])
    expect(capabilities.probed).toBe(true)
    expect(capabilities.degraded).toBe(true)
    expect(capabilities.runtimeVersion).toBe("0.145.0")
  })

  it("degrades an unknown runtime to no executable capabilities", () => {
    expect(knownHookRuntimeCapabilities("unknown")).toMatchObject({
      events: [],
      handlerTypes: [],
      degraded: true,
      executionOwner: "none",
    })
  })
})
