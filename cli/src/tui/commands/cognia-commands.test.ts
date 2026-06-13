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
  it("registers the runtime commands", () => {
    expect(COGNIA_COMMANDS.map((c) => c.name).sort()).toEqual([
      "agents",
      "goal",
      "limits",
      "loop",
      "memory",
      "plan",
      "remember",
      "status",
      "tasks",
      "team",
      "workflow",
    ])
  })

  it("keeps the cognia cluster in the cognia category (status/limits are system cmds)", () => {
    for (const c of COGNIA_COMMANDS) {
      const expected = c.name === "status" || c.name === "limits" ? "system" : "cognia"
      expect(c.category).toBe(expected)
    }
  })

  it("maps /limits to a limits-show runtime request", () => {
    expect(cmd("limits").handler!(ctx(""))).toEqual({
      kind: "runtime",
      runtime: { feature: "limits", action: "show" },
    })
  })

  it("maps /goal root to a streaming goalRun effect carrying the objective", () => {
    expect(cmd("goal").handler!(ctx("ship the release"))).toEqual({
      kind: "goalRun",
      objective: "ship the release",
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

  it("opens the last plan in a document when /plan is run with one in memory", () => {
    const withPlan = {
      args: "",
      state: { lastPlan: { raw: "# My approach\nbody", seq: 4 } },
    } as unknown as CommandContext
    expect(cmd("plan").handler!(withPlan)).toEqual({
      kind: "openOverlay",
      overlay: {
        kind: "document",
        title: "My approach",
        body: "# My approach\nbody",
        format: "markdown",
      },
    })
  })

  it("notices when /plan is run with no plan captured yet", () => {
    const noPlan = { args: "", state: {} } as unknown as CommandContext
    const effect = cmd("plan").handler!(noPlan)
    expect(effect.kind).toBe("notice")
    expect((effect as { message: string }).message).toContain("No plan yet")
  })

  it("routes /plan list and /plan show to the plan runtime feature", () => {
    const list = cmd("plan").subcommands!.find((s) => s.name === "list")!
    expect(list.handler(ctx(""))).toEqual({
      kind: "runtime",
      runtime: { feature: "plan", action: "list" },
    })
    const show = cmd("plan").subcommands!.find((s) => s.name === "show")!
    expect(show.handler(ctx("s-plan-1"))).toEqual({
      kind: "runtime",
      runtime: { feature: "plan", action: "show", arg: "s-plan-1" },
    })
  })

  it("routes /plan diff and /plan delete to the plan runtime feature", () => {
    const diff = cmd("plan").subcommands!.find((s) => s.name === "diff")!
    expect(diff.handler(ctx(""))).toEqual({
      kind: "runtime",
      runtime: { feature: "plan", action: "diff" },
    })
    const del = cmd("plan").subcommands!.find((s) => s.name === "delete")!
    expect(del.handler(ctx("s-plan-1"))).toEqual({
      kind: "runtime",
      runtime: { feature: "plan", action: "delete", arg: "s-plan-1" },
    })
  })

  it("/plan refine returns a planRefine effect when a plan is in memory", () => {
    const refine = cmd("plan").subcommands!.find((s) => s.name === "refine")!
    const withPlan = {
      args: "",
      state: { lastPlan: { raw: "# Approach\nbody", seq: 1 } },
    } as unknown as CommandContext
    expect(refine.handler(withPlan)).toEqual({ kind: "planRefine" })
  })

  it("/plan refine notices when there is no plan to refine", () => {
    const refine = cmd("plan").subcommands!.find((s) => s.name === "refine")!
    const effect = refine.handler({ args: "", state: {} } as unknown as CommandContext)
    expect(effect.kind).toBe("notice")
    expect((effect as { message: string }).message).toContain("No plan to refine")
  })
})
