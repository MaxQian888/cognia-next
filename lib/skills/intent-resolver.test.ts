import { inferBuiltInSkillIntents } from "./intent-resolver"

describe("inferBuiltInSkillIntents", () => {
  it.each([
    ["Plot this as a doughnut chart", ["chart"]],
    ["画一个系统架构图", ["diagram"]],
    // `diagram-design` now owns the Mermaid route and a much wider grammar
    // list, so naming the tool or one of those grammars has to reach it. These
    // all used to resolve to no intent at all, which meant the contract was
    // written and never delivered.
    ["用 mermaid 画一下这个流程", ["diagram"]],
    ["draw this as a mermaid graph", ["diagram"]],
    ["give me a mind map of the modules", ["diagram"]],
    ["帮我出一张思维导图", ["diagram"]],
    ["a gantt for the rollout", ["diagram"]],
    ["从这张截图里识别文字", ["extract-text-from-image"]],
    ["请上网核实当前版本", ["research-web"]],
  ])("recognizes a narrow contextual request: %s", (prompt, expected) => {
    expect(inferBuiltInSkillIntents(prompt)).toEqual(expected)
  })

  it("does not treat a generic graph mention as quantitative chart intent", () => {
    expect(inferBuiltInSkillIntents("Explain the dependency graph conceptually")).toEqual([])
  })
})
