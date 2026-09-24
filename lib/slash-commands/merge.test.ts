import type { SlashCommand } from "./builtin"
import { mergeSlashCommands } from "./merge"

const cmd = (name: string, over: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  description: `${name} description`,
  scope: "builtin",
  category: "chat",
  ...over,
})

describe("mergeSlashCommands", () => {
  it("keeps every command when sources do not collide", () => {
    const merged = mergeSlashCommands(
      [cmd("a"), cmd("b")],
      [cmd("c", { scope: "plugin", category: "plugins" })]
    )
    expect(merged.map((c) => c.name)).toEqual(["a", "b", "c"])
  })

  it("drops hiddenFromPicker commands before merging", () => {
    const merged = mergeSlashCommands(
      [cmd("a"), cmd("hidden", { hiddenFromPicker: true })],
      [cmd("b")]
    )
    expect(merged.map((c) => c.name)).toEqual(["a", "b"])
  })

  it("dedupes a name declared by two sources — the real `record-skill` case", () => {
    const builtin = cmd("record-skill", { description: "builtin copy", scope: "builtin" })
    const plugin = cmd("record-skill", {
      description: "plugin copy",
      scope: "plugin",
      category: "plugins",
    })
    const merged = mergeSlashCommands([builtin], [plugin])
    expect(merged).toHaveLength(1)
    // Last-wins matches submit-time `commandMap` precedence: the row shown is
    // the command that would actually run.
    expect(merged[0].scope).toBe("plugin")
    expect(merged[0].description).toBe("plugin copy")
  })

  it("a hidden command cannot shadow a visible one from an earlier source", () => {
    const merged = mergeSlashCommands(
      [cmd("record-skill")],
      [cmd("record-skill", { scope: "plugin", hiddenFromPicker: true })]
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].scope).toBe("builtin")
  })

  it("keeps the first source's position for a deduped name (stable ordering)", () => {
    const merged = mergeSlashCommands(
      [cmd("a"), cmd("record-skill"), cmd("z")],
      [cmd("record-skill", { scope: "plugin" })]
    )
    expect(merged.map((c) => c.name)).toEqual(["a", "record-skill", "z"])
  })
})
