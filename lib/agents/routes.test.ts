import {
  agentBuilderHref,
  agentHref,
  agentTaskBoardHref,
  isAgentCreateMode,
  isAgentDetailMode,
  newAgentHref,
} from "./routes"

describe("agents console routes", () => {
  it("keeps the overview mode out of an agent's URL", () => {
    expect(agentHref("char_1")).toBe("/agents?id=char_1")
    expect(agentHref("char_1", "overview")).toBe("/agents?id=char_1")
    expect(agentHref("char_1", "edit")).toBe("/agents?id=char_1&mode=edit")
  })

  it("lands task links on the agent's full-width task board", () => {
    expect(agentTaskBoardHref("char_1")).toBe("/agents?id=char_1&mode=tasks")
  })

  it("encodes ids that carry separators", () => {
    expect(agentHref("cognia-pack:p:k:l")).toBe("/agents?id=cognia-pack%3Ap%3Ak%3Al")
    expect(agentBuilderHref("s 1")).toBe("/agents?builder=s+1")
  })

  it("names the create paths", () => {
    expect(newAgentHref()).toBe("/agents?new=1")
    expect(newAgentHref("ai")).toBe("/agents?new=ai")
  })

  it("recognises only known detail and create modes", () => {
    expect(isAgentDetailMode("edit")).toBe(true)
    expect(isAgentDetailMode("tasks")).toBe(true)
    expect(isAgentDetailMode("work")).toBe(false)
    expect(isAgentDetailMode(null)).toBe(false)
    expect(isAgentCreateMode("blank")).toBe(true)
    expect(isAgentCreateMode("template")).toBe(false)
  })
})
