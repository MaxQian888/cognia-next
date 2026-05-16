import * as sdk from "./native-anthropic-tool"

describe("plugin-sdk: api/native-anthropic-tool", () => {
  it("re-exports the helper + registry functions used by plugin authors", () => {
    expect(typeof sdk.defineNativeAnthropicTool).toBe("function")
    expect(typeof sdk.registerNativeAnthropicTool).toBe("function")
    expect(typeof sdk.unregisterNativeAnthropicToolById).toBe("function")
    expect(typeof sdk.unregisterNativeAnthropicToolsByPlugin).toBe("function")
    expect(typeof sdk.getNativeAnthropicTool).toBe("function")
    expect(typeof sdk.getNativeAnthropicToolEntry).toBe("function")
    expect(typeof sdk.listNativeAnthropicToolIds).toBe("function")
    expect(typeof sdk.listNativeAnthropicToolEntries).toBe("function")
    expect(typeof sdk.computeAnthropicBetaHeaders).toBe("function")
  })

  it("defineNativeAnthropicTool is a typesafe identity function", () => {
    const def = sdk.defineNativeAnthropicTool({
      id: "test",
      name: "test",
      type: "computer_20251124",
      executeIpc: { invoke: "plugin_test" },
    })
    expect(def.id).toBe("test")
    expect(def.executeIpc.invoke).toBe("plugin_test")
  })

  it("computeAnthropicBetaHeaders returns the computer-use beta header for computer_20251124 tools", () => {
    const header = sdk.computeAnthropicBetaHeaders([
      sdk.defineNativeAnthropicTool({
        id: "x",
        name: "x",
        type: "computer_20251124",
        executeIpc: { invoke: "x" },
      }),
    ])
    expect(header).toContain("computer-use-2025-11-24")
  })
})
