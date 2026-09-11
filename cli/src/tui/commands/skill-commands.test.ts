/** @jest-environment node */
import { getCommand, registerCommand } from "./registry"
import { dispatchCommand } from "./dispatch"
import { SKILL_COMMANDS } from "./skill-commands"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { CommandContext } from "./types"

const context = {
  state: {},
  config: DEFAULT_RESOLVED_CONFIG,
  version: "1",
  args: "",
} as CommandContext

beforeEach(() => {
  if (!getCommand("skill")) registerCommand(SKILL_COMMANDS[0])
})

it.each(["show", "files", "enable", "disable", "toggle", "delete"])(
  "collects a positional skill id for %s without executing an incomplete action",
  (name) => {
    const sub = SKILL_COMMANDS[0].subcommands?.find((item) => item.name === name)
    expect(sub?.args).toEqual([
      { name: "id", label: "Skill ID", type: "string", required: true, style: "positional" },
    ])
    expect(dispatchCommand(`/skill ${name}`, context)).toMatchObject({
      kind: "openForm",
      form: { commandName: "skill", subcommand: name, specs: sub?.args },
    })
    expect(dispatchCommand(`/skill ${name} sample`, context)).toEqual({
      kind: "runtime",
      runtime: { feature: "skill", action: name, arg: "sample" },
    })
  }
)
