import { AGENT_STATS_COMMANDS } from "./agent-stats-commands"
import type { CommandContext } from "./types"

const ctx = (args = ""): CommandContext =>
  ({ args, state: {}, config: {}, version: "" }) as unknown as CommandContext

describe("AGENT_STATS_COMMANDS", () => {
  const cmd = AGENT_STATS_COMMANDS[0]

  it("registers /agent-stats with insight aliases", () => {
    expect(cmd.name).toBe("agent-stats")
    expect(cmd.aliases).toEqual(expect.arrayContaining(["insights"]))
    expect(cmd.category).toBe("cognia")
  })

  it("emits a runtime agentStats/open effect", () => {
    expect(cmd.handler?.(ctx())).toEqual({
      kind: "runtime",
      runtime: { feature: "agentStats", action: "open" },
    })
  })
})
