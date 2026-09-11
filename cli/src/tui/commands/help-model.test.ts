import { localizedCommandDescription } from "./help-model"
import { createCliTranslator } from "../i18n"
/**
 * @jest-environment node
 */
import { groupByCategory, CATEGORY_LABELS } from "./help-model"
import type { CommandDescriptor } from "./types"

const cmd = (name: string, category: CommandDescriptor["category"]): CommandDescriptor => ({
  name,
  description: name,
  category,
  handler: () => ({ kind: "none" }),
})

describe("groupByCategory", () => {
  it("groups commands into the fixed display order, omitting empty categories", () => {
    const groups = groupByCategory([
      cmd("exit", "system"),
      cmd("goal", "cognia"),
      cmd("clear", "session"),
      cmd("workflow", "cognia"),
    ])
    expect(groups.map((g) => g.category)).toEqual(["session", "cognia", "system"])
    const cognia = groups.find((g) => g.category === "cognia")!
    expect(cognia.label).toBe(CATEGORY_LABELS.cognia)
    expect(cognia.commands.map((c) => c.name)).toEqual(["goal", "workflow"])
  })

  it("returns no groups for an empty catalog", () => {
    expect(groupByCategory([])).toEqual([])
  })

  it("falls back to a system bucket for an unknown category", () => {
    const groups = groupByCategory([{ ...cmd("x", "system"), category: "weird" as never }])
    expect(groups).toHaveLength(1)
    expect(groups[0].commands[0].name).toBe("x")
  })
})

it("localizes built-in descriptions and preserves contributed command copy", () => {
  const t = createCliTranslator("zh-CN", "cliUiCommands")
  expect(localizedCommandDescription({ name: "help", description: "fallback" }, t)).toContain(
    "查看命令列表"
  )
  expect(localizedCommandDescription({ name: "my-plugin", description: "Plugin help" }, t)).toBe(
    "Plugin help"
  )
})
