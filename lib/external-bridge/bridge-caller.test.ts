import { bridgeCallerForClientId, STDIO_BRIDGE_CALLER } from "./bridge-caller"

describe("bridgeCallerForClientId", () => {
  it("falls back to the stdio caller without a client id", () => {
    expect(bridgeCallerForClientId(undefined)).toBe(STDIO_BRIDGE_CALLER)
    expect(bridgeCallerForClientId("  ")).toBe(STDIO_BRIDGE_CALLER)
    expect(bridgeCallerForClientId(42)).toBe(STDIO_BRIDGE_CALLER)
  })

  it("normalizes a client id into a safe caller key", () => {
    expect(bridgeCallerForClientId("client-7")).toBe("mcp:client-7")
    expect(bridgeCallerForClientId(" a b/c ")).toBe("mcp:a_b_c")
    expect(bridgeCallerForClientId("x".repeat(300))).toBe(`mcp:${"x".repeat(128)}`)
  })
})
