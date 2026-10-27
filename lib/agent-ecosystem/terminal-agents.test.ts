import { findTerminalAgent, TERMINAL_AGENTS, terminalAgentProfileId } from "./terminal-agents"

describe("native terminal agents", () => {
  it("uses fixed executable argv without a shell or pre-submitted prompt", () => {
    expect(TERMINAL_AGENTS.map((agent) => [agent.id, agent.command, agent.args])).toEqual([
      ["freebuff", "freebuff", []],
      ["zcode", "zcode", []],
    ])
    for (const agent of TERMINAL_AGENTS) {
      expect(agent.docsUrl).toMatch(/^https:\/\//)
      expect(agent).not.toHaveProperty("protocol")
    }
  })

  it("resolves exact identities and keeps their durable profile markers distinct", () => {
    expect(findTerminalAgent("freebuff")).toBe(TERMINAL_AGENTS[0])
    expect(findTerminalAgent("unknown")).toBeUndefined()
    const markers = TERMINAL_AGENTS.map((agent) => terminalAgentProfileId(agent.id))
    expect(new Set(markers).size).toBe(TERMINAL_AGENTS.length)
    expect(markers).toEqual(["cognia-agent-terminal-freebuff", "cognia-agent-terminal-zcode"])
  })
})
