import { agentNodeSummary } from "./agent-node-summary"

describe("agentNodeSummary", () => {
  it("ignores kinds that carry no agent configuration", () => {
    expect(agentNodeSummary("flow.branch", { model: "x" })).toBeNull()
    expect(agentNodeSummary("action.agent.turn", undefined)).toBeNull()
  })

  it("returns null rather than an empty chip row for an unconfigured node", () => {
    expect(agentNodeSummary("action.agent.turn", { prompt: "hi" })).toBeNull()
  })

  it("shortens a provider-qualified model id", () => {
    expect(agentNodeSummary("ai.prompt", { model: "anthropic/claude-opus-5" })?.model).toBe(
      "claude-opus-5"
    )
    expect(agentNodeSummary("ai.prompt", { model: "openai:gpt-5" })?.model).toBe("gpt-5")
  })

  it("does not show an expression as if it were a model name", () => {
    expect(agentNodeSummary("ai.prompt", { model: "{{ $json.model }}" })).toBeNull()
  })

  it("counts both the array and the comma-separated shapes of a list param", () => {
    expect(agentNodeSummary("action.agent.turn", { allowedTools: ["a", "b"] })?.tools).toBe(2)
    expect(agentNodeSummary("action.skill.invoke", { skillIds: "a, b, c" })?.skills).toBe(3)
  })

  it("counts members and steps held as raw JSON, and survives invalid JSON", () => {
    expect(
      agentNodeSummary("action.team.create", { membersJson: '[{"id":"a"},{"id":"b"}]' })?.members
    ).toBe(2)
    expect(agentNodeSummary("action.plan.create", { stepsJson: "[" })).toBeNull()
  })
})
