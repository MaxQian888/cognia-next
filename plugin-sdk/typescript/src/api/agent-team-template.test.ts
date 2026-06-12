import * as sdk from "./agent-team-template"

describe("plugin-sdk: api/agent-team-template", () => {
  it("re-exports the helper + registry functions plugin authors call", () => {
    expect(typeof sdk.defineAgentTeamTemplate).toBe("function")
    expect(typeof sdk.registerAgentTeamTemplate).toBe("function")
    expect(typeof sdk.unregisterAgentTeamTemplateById).toBe("function")
    expect(typeof sdk.unregisterAgentTeamTemplatesByPlugin).toBe("function")
    expect(typeof sdk.getAgentTeamTemplate).toBe("function")
    expect(typeof sdk.getAgentTeamTemplateEntry).toBe("function")
    expect(typeof sdk.listAgentTeamTemplateIds).toBe("function")
    expect(typeof sdk.listAgentTeamTemplateEntries).toBe("function")
    expect(typeof sdk.validateTemplateRequires).toBe("function")
  })

  it("defineAgentTeamTemplate is a typesafe identity function", () => {
    const def = sdk.defineAgentTeamTemplate({
      id: "pr-review",
      name: "PR Review",
      description: "Multi-reviewer PR walkthrough",
      category: "review",
      teammates: [
        { name: "Security", description: "Reviews security" },
        { name: "Performance", description: "Reviews perf" },
      ],
    })
    expect(def.id).toBe("pr-review")
    expect(def.teammates).toHaveLength(2)
  })
})
