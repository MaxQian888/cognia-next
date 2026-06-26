import { orderedCommandsForEmptyQuery, slashGroupLabel } from "./composer-popover-groups"
import type { SlashCommand } from "@/lib/slash-commands/builtin"

const cmd = (name: string, category?: string): SlashCommand =>
  ({ name, description: name, scope: "builtin", category }) as unknown as SlashCommand

const commands = [
  cmd("clear", "chat"),
  cmd("model", "chat"),
  cmd("doctor", "diagnostics"),
  cmd("prompt", "template"),
  cmd("loose"), // no category → "other"
]

describe("orderedCommandsForEmptyQuery", () => {
  it("puts pinned first (pin order), then recent (newest first)", () => {
    const out = orderedCommandsForEmptyQuery(commands, ["model"], ["doctor", "clear"])
    expect(out.slice(0, 3)).toEqual([
      { command: commands[2], group: "pinned" }, // doctor
      { command: commands[0], group: "pinned" }, // clear
      { command: commands[1], group: "recent" }, // model
    ])
  })

  it("does not repeat a pinned/recent command in its category group", () => {
    const out = orderedCommandsForEmptyQuery(commands, ["model"], ["clear"])
    const names = out.map((g) => g.command.name)
    expect(names.filter((n) => n === "clear")).toHaveLength(1)
    expect(names.filter((n) => n === "model")).toHaveLength(1)
  })

  it("groups the rest by category in the preferred order, 'other' last", () => {
    const out = orderedCommandsForEmptyQuery(commands, [], [])
    expect(out.map((g) => g.group)).toEqual([
      "cat:chat",
      "cat:chat",
      "cat:template",
      "cat:diagnostics",
      "cat:other",
    ])
  })

  it("skips recent/pinned names that no longer resolve", () => {
    const out = orderedCommandsForEmptyQuery(commands, ["gone"], ["missing"])
    expect(out.every((g) => g.command.name !== "gone" && g.command.name !== "missing")).toBe(true)
  })

  it("sorts unknown categories alphabetically after known ones, before 'other'", () => {
    const list = [cmd("a", "zeta"), cmd("b", "alpha"), cmd("c", "system"), cmd("d")]
    const out = orderedCommandsForEmptyQuery(list, [], [])
    expect(out.map((g) => g.group)).toEqual(["cat:system", "cat:alpha", "cat:zeta", "cat:other"])
  })
})

describe("slashGroupLabel", () => {
  const t = (key: string) => key
  const safeLookup = (_t: (key: string) => string, key: string, fallback: string): string =>
    key.startsWith("categories.unknown") ? fallback : key

  it("returns translator keys for pinned/recent", () => {
    expect(slashGroupLabel("pinned", t, safeLookup)).toBe("pinnedSection")
    expect(slashGroupLabel("recent", t, safeLookup)).toBe("recentSection")
  })

  it("looks up a category by name", () => {
    expect(slashGroupLabel("cat:chat", t, safeLookup)).toBe("categories.chat")
  })

  it("falls back to a capitalized raw category when untranslated", () => {
    expect(slashGroupLabel("cat:unknownx", t, safeLookup)).toBe("Unknownx")
  })
})
