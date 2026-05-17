import * as sdk from "./skill"

describe("plugin-sdk: api/skill", () => {
  it("re-exports the helper + registry functions plugin authors call", () => {
    expect(typeof sdk.defineSkill).toBe("function")
    expect(typeof sdk.registerSkill).toBe("function")
    expect(typeof sdk.unregisterSkillById).toBe("function")
    expect(typeof sdk.unregisterSkillsByPlugin).toBe("function")
    expect(typeof sdk.getSkill).toBe("function")
    expect(typeof sdk.getSkillEntry).toBe("function")
    expect(typeof sdk.listSkillIds).toBe("function")
    expect(typeof sdk.listSkillEntries).toBe("function")
  })

  it("defineSkill is a typesafe identity function", () => {
    const def = sdk.defineSkill({
      id: "code-review",
      name: "Code Review",
      description: "Reviews code changes",
      source: { kind: "inline", markdown: "# review" },
    })
    expect(def.id).toBe("code-review")
    expect(def.source.kind).toBe("inline")
  })
})
