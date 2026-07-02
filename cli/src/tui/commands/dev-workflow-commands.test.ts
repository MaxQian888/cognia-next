import { DEV_WORKFLOW_COMMANDS } from "./dev-workflow-commands"
import { commitCommand } from "./commit-command"
import { prCommand } from "./pr-command"
import type { CommandContext } from "./types"

const ctx = (args: string): CommandContext => ({
  state: {} as CommandContext["state"],
  config: {} as CommandContext["config"],
  version: "0",
  args,
})

describe("DEV_WORKFLOW_COMMANDS", () => {
  it("registers review, commit, pr, and fix", () => {
    expect(DEV_WORKFLOW_COMMANDS.map((c) => c.name).sort()).toEqual([
      "commit",
      "fix",
      "pr",
      "review",
    ])
  })
})

describe("commitCommand", () => {
  it("routes the root to the commit run action", () => {
    expect(commitCommand.handler!(ctx(""))).toMatchObject({
      kind: "runtime",
      runtime: { feature: "commit", action: "run" },
    })
  })
  it("exposes internal apply / stage-all / cancel subcommands", () => {
    const names = (commitCommand.subcommands ?? []).map((s) => s.name).sort()
    expect(names).toEqual(["apply", "cancel", "stage-all"])
    const apply = commitCommand.subcommands!.find((s) => s.name === "apply")!
    expect(apply.handler(ctx(""))).toMatchObject({
      runtime: { feature: "commit", action: "apply" },
    })
  })
})

describe("prCommand", () => {
  it("routes the root to the pr run action", () => {
    expect(prCommand.handler!(ctx(""))).toMatchObject({ runtime: { feature: "pr", action: "run" } })
  })
  it("exposes internal apply / cancel subcommands", () => {
    expect((prCommand.subcommands ?? []).map((s) => s.name).sort()).toEqual(["apply", "cancel"])
  })
})
