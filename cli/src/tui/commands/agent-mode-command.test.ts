import { agentModeCommand } from "./agent-mode-command"
import type { CommandContext } from "./types"

function ctx(args: string): CommandContext {
  return { state: {} as never, config: {} as never, version: "0", args }
}

describe("agentModeCommand", () => {
  it("bare invocation routes to the runtime picker", () => {
    expect(agentModeCommand.handler?.(ctx(""))).toEqual({
      kind: "runtime",
      runtime: { feature: "agentMode", action: "list" },
    })
  })

  it("an explicit id returns an agentMode effect", () => {
    expect(agentModeCommand.handler?.(ctx("plan"))).toEqual({ kind: "agentMode", modeId: "plan" })
    expect(agentModeCommand.handler?.(ctx("  reviewer  "))).toEqual({
      kind: "agentMode",
      modeId: "reviewer",
    })
  })

  it("clear words map to the no-op general mode", () => {
    for (const w of ["none", "off", "clear", "default", "NONE"]) {
      expect(agentModeCommand.handler?.(ctx(w))).toEqual({ kind: "agentMode", modeId: "general" })
    }
  })

  it("is registered as a config command with an agentmode alias", () => {
    expect(agentModeCommand.name).toBe("agent-mode")
    expect(agentModeCommand.aliases).toContain("agentmode")
    expect(agentModeCommand.category).toBe("config")
  })
})
