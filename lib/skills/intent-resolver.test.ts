import { inferBuiltInSkillIntents } from "./intent-resolver"

describe("inferBuiltInSkillIntents", () => {
  it.each([
    ["Plot this as a doughnut chart", ["chart"]],
    ["画一个系统架构图", ["diagram"]],
    ["从这张截图里识别文字", ["extract-text-from-image"]],
    ["请上网核实当前版本", ["research-web"]],
  ])("recognizes a narrow contextual request: %s", (prompt, expected) => {
    expect(inferBuiltInSkillIntents(prompt)).toEqual(expected)
  })

  it("does not treat a generic graph mention as quantitative chart intent", () => {
    expect(inferBuiltInSkillIntents("Explain the dependency graph conceptually")).toEqual([])
  })
})
