import { runtimeToolSupport } from "./runtime-tool-support"

describe("runtimeToolSupport", () => {
  it("always supports the built-in lane", () => {
    expect(runtimeToolSupport({ kind: "builtin" }, () => undefined)).toBe("supported")
  })

  it("supports protocols that carry MCP natively or through a bridge", () => {
    expect(runtimeToolSupport({ kind: "external", agentId: "a" }, () => "acp")).toBe("supported")
    expect(runtimeToolSupport({ kind: "external", agentId: "a" }, () => "codex-app-server")).toBe(
      "supported"
    )
  })

  it("does not guess when the protocol is unknown here", () => {
    expect(
      runtimeToolSupport(
        { kind: "host", configId: "c", revision: "r", lifecycleGeneration: 1 },
        () => undefined
      )
    ).toBe("unknown")
  })
})
