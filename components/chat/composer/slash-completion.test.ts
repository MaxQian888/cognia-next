import type { SlashCommand } from "@/lib/slash-commands/builtin"
import type { ComposerTrigger } from "../composer-trigger"
import { commandArgumentOptions, hasSlashCompletion } from "./slash-completion"

const cmd = (partial: Partial<SlashCommand> & { name: string }): SlashCommand => ({
  description: "",
  scope: "builtin",
  ...partial,
})

const COMMANDS: SlashCommand[] = [
  cmd({ name: "clear" }),
  cmd({ name: "model", argumentOptions: ["opus", "sonnet"] }),
  cmd({
    name: "pet",
    params: [{ name: "action", label: "Action", type: "enum", options: ["feed", "sleep"] }],
  }),
]

const slash = (partial: Partial<ComposerTrigger>): ComposerTrigger => ({
  kind: "slash",
  tokenStart: 0,
  tokenEnd: 6,
  query: "clear",
  ...partial,
})

describe("commandArgumentOptions", () => {
  it("prefers explicit argumentOptions, then the first enum param", () => {
    expect(commandArgumentOptions(COMMANDS[1])).toEqual(["opus", "sonnet"])
    expect(commandArgumentOptions(COMMANDS[2])).toEqual(["feed", "sleep"])
    expect(commandArgumentOptions(COMMANDS[0])).toEqual([])
    expect(commandArgumentOptions(undefined)).toEqual([])
  })
})

describe("hasSlashCompletion", () => {
  it("is false without a trigger", () => {
    expect(hasSlashCompletion(null, COMMANDS)).toBe(false)
  })

  it("is true for every non-slash trigger — their panel is the only affordance", () => {
    expect(hasSlashCompletion({ kind: "file", tokenStart: 0, tokenEnd: 3, query: "a" }, [])).toBe(
      true
    )
    expect(hasSlashCompletion({ kind: "bash", tokenStart: 0, tokenEnd: 3, query: "ls" }, [])).toBe(
      true
    )
  })

  it("is true while the command word is still being completed", () => {
    expect(hasSlashCompletion(slash({ query: "cle" }), COMMANDS)).toBe(true)
  })

  it("is false once the caret is past the first argument", () => {
    // The panel used to reopen here anchored on the command, so Enter picked a
    // row and overwrote it instead of sending.
    expect(hasSlashCompletion(slash({ caretPastArgument: true }), COMMANDS)).toBe(false)
  })

  it("is true inside an argument the command declares options for", () => {
    expect(
      hasSlashCompletion(
        slash({ query: "model", argumentQuery: "op", argumentStart: 7, argumentEnd: 9 }),
        COMMANDS
      )
    ).toBe(true)
  })

  it("is false inside a free-form argument", () => {
    expect(
      hasSlashCompletion(
        slash({ query: "clear", argumentQuery: "src/a", argumentStart: 7, argumentEnd: 12 }),
        COMMANDS
      )
    ).toBe(false)
  })

  it("is false for an argument of a command that does not exist", () => {
    expect(
      hasSlashCompletion(
        slash({ query: "nope", argumentQuery: "x", argumentStart: 6, argumentEnd: 7 }),
        COMMANDS
      )
    ).toBe(false)
  })
})
