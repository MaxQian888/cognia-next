import * as sdk from "./subagent"

describe("plugin-sdk: api/subagent", () => {
  it("re-exports the helper + registry functions plugin authors call", () => {
    expect(typeof sdk.defineSubagent).toBe("function")
    expect(typeof sdk.registerSubagent).toBe("function")
    expect(typeof sdk.unregisterSubagentById).toBe("function")
    expect(typeof sdk.unregisterSubagentsByPlugin).toBe("function")
    expect(typeof sdk.getSubagent).toBe("function")
    expect(typeof sdk.getSubagentEntry).toBe("function")
    expect(typeof sdk.listSubagentIds).toBe("function")
    expect(typeof sdk.listSubagentEntries).toBe("function")
  })

  it("defineSubagent is a typesafe identity function", () => {
    const def = sdk.defineSubagent({
      id: "code-reviewer",
      name: "Code Reviewer",
      description: "Reviews code changes",
      prompt: "You are a code reviewer.",
    })
    expect(def.id).toBe("code-reviewer")
  })
})
