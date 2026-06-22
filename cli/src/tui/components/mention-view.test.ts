import { buildMentionView, MENTION_GLYPH, mentionRowMeta } from "./mention-view"
import type { MentionCandidate } from "../mention/types"

const skill = (id: string, over: Partial<MentionCandidate> = {}): MentionCandidate => ({
  kind: "skill",
  id,
  label: id,
  insert: `@skill:${id}`,
  ...over,
})

describe("buildMentionView", () => {
  it("returns an empty view for no candidates", () => {
    const view = buildMentionView([], 0, 8)
    expect(view.rows).toEqual([])
    expect(view.preview).toBeNull()
    expect(view).toMatchObject({ above: 0, below: 0 })
  })

  it("returns an empty view when rows budget is zero", () => {
    expect(buildMentionView([skill("a")], 0, 0).rows).toEqual([])
  })

  it("shows every row when the list fits", () => {
    const view = buildMentionView([skill("a"), skill("b"), skill("c")], 1, 8)
    expect(view.rows.map((r) => r.cand.id)).toEqual(["a", "b", "c"])
    expect(view.above).toBe(0)
    expect(view.below).toBe(0)
    expect(view.rows[1].selected).toBe(true)
    expect(view.preview?.id).toBe("b")
  })

  it("keeps a constant visible row count while navigating a long list", () => {
    const many = Array.from({ length: 20 }, (_, i) => skill(`s${i}`))
    const a = buildMentionView(many, 3, 5)
    const b = buildMentionView(many, 15, 5)
    // The window slides but the row count never changes — so the popup height is
    // stable across ↑/↓ and the composer below never shifts.
    expect(a.rows.length).toBe(5)
    expect(b.rows.length).toBe(5)
    expect(b.rows.some((r) => r.selected && r.cand.id === "s15")).toBe(true)
  })

  it("reports hidden counts above and below the window", () => {
    const many = Array.from({ length: 20 }, (_, i) => skill(`s${i}`))
    const view = buildMentionView(many, 10, 5)
    expect(view.above).toBeGreaterThan(0)
    expect(view.below).toBeGreaterThan(0)
    expect(view.above + view.rows.length + view.below).toBe(20)
  })

  it("clamps an out-of-range index to the last candidate", () => {
    const view = buildMentionView([skill("a"), skill("b")], 99, 8)
    expect(view.preview?.id).toBe("b")
    expect(view.rows.find((r) => r.selected)?.cand.id).toBe("b")
  })
})

describe("mentionRowMeta", () => {
  it("joins origin, non-custom category, and usage for a skill", () => {
    expect(
      mentionRowMeta(skill("x", { origin: "claude", category: "research", usageCount: 3 }))
    ).toBe("claude · research · used 3×")
  })

  it("drops the custom category and a zero usage count", () => {
    expect(
      mentionRowMeta(skill("x", { origin: "project", category: "custom", usageCount: 0 }))
    ).toBe("project")
  })

  it("is empty for non-skill candidates", () => {
    expect(mentionRowMeta({ kind: "file", id: "f", label: "f", insert: "f" })).toBe("")
  })
})

describe("MENTION_GLYPH", () => {
  it("has a glyph per kind", () => {
    expect(MENTION_GLYPH.file).toBeTruthy()
    expect(MENTION_GLYPH.skill).toBeTruthy()
    expect(MENTION_GLYPH.agent).toBeTruthy()
  })
})
