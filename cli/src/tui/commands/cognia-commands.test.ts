/**
 * @jest-environment node
 */
import { COGNIA_COMMANDS } from "./cognia-commands"
import type { CommandContext } from "./types"

const ctx = (args: string): CommandContext => ({ args }) as CommandContext

function cmd(name: string) {
  const c = COGNIA_COMMANDS.find((d) => d.name === name)
  if (!c) throw new Error(`missing ${name}`)
  return c
}

describe("COGNIA_COMMANDS", () => {
  it("registers the five runtime commands in the cognia category", () => {
    expect(COGNIA_COMMANDS.map((c) => c.name).sort()).toEqual([
      "agents",
      "goal",
      "memory",
      "team",
      "workflow",
    ])
    for (const c of COGNIA_COMMANDS) expect(c.category).toBe("cognia")
  })

  it("maps /goal root to a goal-start runtime request carrying the objective", () => {
    expect(cmd("goal").handler!(ctx("ship the release"))).toEqual({
      kind: "runtime",
      runtime: { feature: "goal", action: "start", arg: "ship the release" },
    })
  })

  it("omits arg when none is supplied", () => {
    expect(cmd("workflow").handler!(ctx("  "))).toEqual({
      kind: "runtime",
      runtime: { feature: "workflow", action: "list" },
    })
  })

  it("routes goal subcommands to their actions", () => {
    const goal = cmd("goal")
    const status = goal.subcommands!.find((s) => s.name === "status")!
    expect(status.handler(ctx(""))).toMatchObject({
      kind: "runtime",
      runtime: { feature: "goal", action: "status" },
    })
  })

  it("routes a workflow run subcommand with its id", () => {
    const run = cmd("workflow").subcommands!.find((s) => s.name === "run")!
    expect(run.handler(ctx("w1"))).toEqual({
      kind: "runtime",
      runtime: { feature: "workflow", action: "run", arg: "w1" },
    })
  })

  it("exposes aliases for workflow + memory", () => {
    expect(cmd("workflow").aliases).toContain("wf")
    expect(cmd("memory").aliases).toContain("mem")
  })
})
