import * as sdk from "./agent-tool"

describe("plugin-sdk: api/agent-tool", () => {
  it("re-exports defineAgentTool", () => {
    expect(typeof sdk.defineAgentTool).toBe("function")
  })

  it("defineAgentTool is a typesafe identity function", () => {
    const tool = sdk.defineAgentTool({
      name: "web_fetch",
      execute: async () => "ok",
    })
    expect(tool.name).toBe("web_fetch")
  })
})
