import {
  listItemTitle,
  planDocHeadingId,
  projectStepTitles,
  rebuildPlanText,
  splitPlanDocument,
} from "./plan-doc"

const DOC = [
  "# Migrate auth to OAuth2",
  "",
  "## Context",
  "",
  "Plaintext tokens everywhere.",
  "",
  "## Approach",
  "",
  "Keep `Session` stable.",
  "",
  "### Steps",
  "",
  "1. Audit call sites",
  "2. Add PKCE flow",
  "3. Swap the reducer",
  "",
  "### Files",
  "",
  "- `lib/auth/session.ts`",
  "- `lib/auth/reducer.ts`",
  "",
  "## Risks",
  "",
  "> Rotation can strand sessions.",
].join("\n")

describe("splitPlanDocument", () => {
  it("splits before/steps/after around the steps list", () => {
    const s = splitPlanDocument(DOC)
    expect(s.steps).toEqual(["1. Audit call sites", "2. Add PKCE flow", "3. Swap the reducer"])
    expect(s.ordered).toBe(true)
    expect(s.before).toContain("### Steps")
    expect(s.before).toContain("Keep `Session` stable.")
    expect(s.before).not.toContain("Audit call sites")
    expect(s.after).toContain("### Files")
    expect(s.after).toContain("`lib/auth/session.ts`")
    expect(s.after).not.toContain("Swap the reducer")
  })

  it("collects h1–h3 headings for the TOC", () => {
    const { headings } = splitPlanDocument(DOC)
    expect(headings.map((h) => h.text)).toEqual([
      "Migrate auth to OAuth2",
      "Context",
      "Approach",
      "Steps",
      "Files",
      "Risks",
    ])
    expect(headings[0].level).toBe(1)
    expect(headings[3].level).toBe(3)
  })

  it("returns steps:null when no steps heading exists", () => {
    const s = splitPlanDocument("## Notes\n\n- a\n- b\n")
    expect(s.steps).toBeNull()
    expect(s.before).toContain("- a")
  })

  it("returns steps:null when the heading has no list", () => {
    const s = splitPlanDocument("## Steps\n\nNo list here.\n\n## Next\n\n- x\n")
    expect(s.steps).toBeNull()
  })

  it("keeps intro prose between heading and list in `before`", () => {
    const s = splitPlanDocument("## Steps\n\nDo these in order:\n\n1. a\n2. b\n")
    expect(s.steps).toEqual(["1. a", "2. b"])
    expect(s.before).toContain("Do these in order:")
  })

  it("ignores a steps heading inside a fenced code block", () => {
    const s = splitPlanDocument(
      "## Plan\n\n```md\n## Steps\n\n1. fake\n```\n\n## Tasks\n\n1. real\n"
    )
    expect(s.steps).toEqual(["1. real"])
  })

  it("recognises bullet lists and 步骤 headings", () => {
    const s = splitPlanDocument("## 步骤\n\n- 第一步\n- 第二步\n")
    expect(s.steps).toEqual(["- 第一步", "- 第二步"])
    expect(s.ordered).toBe(false)
  })

  it("tolerates blank lines inside the list", () => {
    const s = splitPlanDocument("## Steps\n\n1. a\n\n2. b\n")
    expect(s.steps).toEqual(["1. a", "2. b"])
  })

  it("ends the steps list at a prose line; the rest stays in `after`", () => {
    const s = splitPlanDocument("## Steps\n\n1. a\nnote between\n2. b\n")
    expect(s.steps).toEqual(["1. a"])
    expect(s.after).toContain("note between")
    expect(s.after).toContain("2. b")
  })
})

describe("rebuildPlanText", () => {
  it("rewrites the steps list in place and preserves the rest", () => {
    const out = rebuildPlanText(DOC, ["Audit harder", "Add PKCE flow", "Ship it"])
    expect(out).toContain("1. Audit harder")
    expect(out).toContain("3. Ship it")
    expect(out).toContain("## Context")
    expect(out).toContain("> Rotation can strand sessions.")
    expect(out).toContain("`lib/auth/session.ts`")
    // The rewritten list replaces the old one entirely.
    expect(out).not.toContain("Swap the reducer")
  })

  it("appends a Steps section when the source had none", () => {
    const out = rebuildPlanText("## Notes\n\nSome text.\n", ["do a", "do b"])
    expect(out).toContain("## Steps")
    expect(out).toContain("1. do a")
    expect(out).toContain("2. do b")
    expect(out).toContain("Some text.")
  })

  it("keeps bullet style when the source list was unordered", () => {
    const out = rebuildPlanText("## Steps\n\n- a\n- b\n", ["x", "y"])
    expect(out).toContain("- x")
    expect(out).toContain("- y")
    expect(out).not.toContain("1. x")
  })
})

describe("listItemTitle", () => {
  it("strips ordered and bullet markers plus bold emphasis", () => {
    expect(listItemTitle("1. Audit call sites")).toBe("Audit call sites")
    expect(listItemTitle("12) swap")).toBe("swap")
    expect(listItemTitle("- `lib/a.ts`")).toBe("`lib/a.ts`")
    expect(listItemTitle("**Bold step**")).toBe("**Bold step**")
    expect(listItemTitle("1. **Bold step**")).toBe("Bold step")
    expect(listItemTitle("plain text")).toBe("plain text")
  })
})

describe("projectStepTitles", () => {
  it("projects every list item in document order", () => {
    const doc = "## Steps\n\n1. a\n2. b\n\n## Files\n\n- lib/x.ts\n"
    expect(projectStepTitles(doc)).toEqual(["a", "b", "lib/x.ts"])
  })

  it("skips list items inside fenced code and never falls back to prose", () => {
    const doc = "# Title\n\n```\n- not a step\n```\n\nno lists here\n"
    expect(projectStepTitles(doc)).toEqual([])
  })
})

describe("planDocHeadingId", () => {
  it("produces stable anchor ids", () => {
    expect(planDocHeadingId(0)).toBe("pd-h-0")
    expect(planDocHeadingId(3)).toBe("pd-h-3")
  })
})
