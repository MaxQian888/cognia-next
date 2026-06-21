import {
  buildSkillRows,
  filterSkillRows,
  skillBadge,
  skillRowHint,
  skillSummary,
  type SkillPanelRow,
} from "./skill-panel-model"
import type { Skill } from "@/lib/claude/types"

const skill = (over: Partial<Skill> = {}): Skill =>
  ({
    id: "s1",
    name: "Web Search",
    content: "body",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as Skill

const row = (over: Partial<SkillPanelRow> = {}): SkillPanelRow => ({
  id: "s1",
  name: "Web Search",
  origin: null,
  enabled: false,
  errorCount: 0,
  ...over,
})

describe("buildSkillRows", () => {
  it("distills metadata and marks the enabled set", () => {
    const rows = buildSkillRows(
      [
        skill({ id: "a", name: "Alpha", description: "d", usageCount: 3, category: "development" }),
        skill({ id: "b", name: "Beta", validationErrors: [{ field: "x", message: "m" }] as never }),
      ],
      new Set(["a"])
    )
    expect(rows[0]).toMatchObject({
      id: "a",
      name: "Alpha",
      description: "d",
      usageCount: 3,
      category: "development",
      enabled: true,
      errorCount: 0,
    })
    expect(rows[1]).toMatchObject({ id: "b", enabled: false, errorCount: 1 })
  })
})

describe("skillBadge", () => {
  it("is a filled accent bullet when enabled", () => {
    expect(skillBadge(row({ enabled: true }))).toMatchObject({ glyph: "●", token: "success" })
  })
  it("is a hollow muted bullet when disabled", () => {
    expect(skillBadge(row({ enabled: false }))).toMatchObject({ glyph: "○", token: "muted" })
  })
  it("flags validation issues", () => {
    expect(skillBadge(row({ errorCount: 2 })).warn).toBe(true)
    expect(skillBadge(row({ errorCount: 0 })).warn).toBe(false)
  })
})

describe("skillRowHint", () => {
  it("joins origin, category, usage and issues", () => {
    expect(
      skillRowHint(row({ origin: "claude", category: "development", usageCount: 5, errorCount: 2 }))
    ).toBe("claude · development · used 5× · 2 issues")
  })
  it("drops builtin source and custom category noise", () => {
    expect(skillRowHint(row({ origin: null, source: "builtin", category: "custom" }))).toBe("")
  })
  it("falls back to non-builtin source when no origin", () => {
    expect(skillRowHint(row({ origin: null, source: "marketplace" }))).toBe("marketplace")
  })
  it("singularises one issue", () => {
    expect(skillRowHint(row({ errorCount: 1 }))).toBe("1 issue")
  })
})

describe("filterSkillRows", () => {
  const rows = [row({ id: "a", name: "Web Search" }), row({ id: "b", name: "PDF Export" })]
  it("matches by name", () => {
    expect(filterSkillRows(rows, "pdf").map((r) => r.id)).toEqual(["b"])
  })
  it("keeps order when empty", () => {
    expect(filterSkillRows(rows, "").map((r) => r.id)).toEqual(["a", "b"])
  })
})

describe("skillSummary", () => {
  it("counts total, enabled and issues", () => {
    expect(
      skillSummary([
        row({ enabled: true }),
        row({ enabled: false, errorCount: 1 }),
        row({ enabled: true }),
      ])
    ).toEqual({ total: 3, enabled: 2, issues: 1 })
  })
})
