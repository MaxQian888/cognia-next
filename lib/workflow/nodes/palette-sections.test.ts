import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { PALETTE_SECTIONS, paletteSection } from "./palette-sections"
import { WORKFLOW_NODE_KINDS, workflowNodeCategory } from "@/types/workflow/visual"

describe("palette sections", () => {
  it("leaves the small categories flat", () => {
    for (const kind of WORKFLOW_NODE_KINDS) {
      const category = workflowNodeCategory(kind)
      // `action` is the only oversized bucket. Everything else already reads
      // as one list, so a section there would be noise.
      if (category !== "action") expect(paletteSection(kind)).toBeNull()
    }
  })

  it("sections every action-category kind", () => {
    const unsectioned = WORKFLOW_NODE_KINDS.filter(
      (kind) => workflowNodeCategory(kind) === "action" && paletteSection(kind) === null
    )
    expect(unsectioned).toEqual([])
  })

  /**
   * The point of the whole change: nothing may quietly pile back up into one
   * list. `other` is the escape hatch for a genuinely uncategorisable kind,
   * and this pins how many are allowed to use it.
   */
  it("keeps the catch-all section small", () => {
    const other = WORKFLOW_NODE_KINDS.filter((kind) => paletteSection(kind) === "other")
    expect(other).toEqual([])
  })

  it("puts the multi-agent primitives together", () => {
    expect(paletteSection("action.agent.turn")).toBe("agents")
    expect(paletteSection("action.team.run")).toBe("agents")
    expect(paletteSection("pattern.judge-panel")).toBe("agents")
    expect(paletteSection("action.plan.create")).toBe("plans")
  })

  it("declares every section it can return", () => {
    const returned = new Set(
      WORKFLOW_NODE_KINDS.map((kind) => paletteSection(kind)).filter(
        (s): s is NonNullable<typeof s> => s !== null
      )
    )
    for (const section of returned) expect(PALETTE_SECTIONS).toContain(section)
  })

  /**
   * The sidebar reads these through a template key, and `lint:i18n` cannot see
   * a dynamic key. Without this, adding a section ships an untranslated
   * heading that no gate notices.
   */
  it.each(["en", "zh-CN"])("has a %s label for every section", (locale) => {
    const messages = JSON.parse(
      readFileSync(
        resolve(
          __dirname,
          "..",
          "..",
          "..",
          "i18n",
          "messages",
          locale,
          "workflows",
          "sidebar.json"
        ),
        "utf8"
      )
    ) as { section?: Record<string, string> }
    for (const section of PALETTE_SECTIONS) {
      expect(messages.section?.[section]).toBeTruthy()
    }
  })
})
