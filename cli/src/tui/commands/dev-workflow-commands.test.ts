import { DEV_WORKFLOW_COMMANDS } from "./dev-workflow-commands"
import { commitCommand } from "./commit-command"
import { prCommand } from "./pr-command"
import { stackCommand } from "./stack-command"
import type { CommandContext } from "./types"

const ctx = (args: string): CommandContext => ({
  state: {} as CommandContext["state"],
  config: {} as CommandContext["config"],
  version: "0",
  args,
})

describe("DEV_WORKFLOW_COMMANDS", () => {
  it("registers review, commit, pr, stack, and fix", () => {
    expect(DEV_WORKFLOW_COMMANDS.map((c) => c.name).sort()).toEqual([
      "commit",
      "fix",
      "pr",
      "review",
      "stack",
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

describe("stackCommand", () => {
  it("routes the root to the list action", () => {
    // Listing is what someone means by a bare `/stack`; there is no verb that
    // mutates anything without being named.
    expect(stackCommand.handler!(ctx(""))).toMatchObject({
      kind: "runtime",
      runtime: { feature: "stack", action: "list" },
    })
  })

  it("exposes on / off / check / restack / push", () => {
    expect((stackCommand.subcommands ?? []).map((s) => s.name).sort()).toEqual([
      "check",
      "off",
      "on",
      "push",
      "restack",
    ])
  })

  it("routes every verb to its own action under the stack feature", () => {
    for (const sub of stackCommand.subcommands ?? []) {
      expect(sub.handler(ctx(""))).toMatchObject({
        runtime: { feature: "stack", action: sub.name },
      })
    }
  })
})
