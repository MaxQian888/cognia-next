import { instructionUnits, numberLines, segmentRules } from "./segment"

describe("segmentRules", () => {
  it("splits bullets, numbered items, paragraphs, headings, code and frontmatter with their lines", () => {
    const text = [
      "---",
      "name: demo",
      "description: Demo skill",
      "---",
      "# Rules",
      "",
      "- Run `pnpm test` before committing",
      "  so CI stays green.",
      "- Never edit generated files.",
      "",
      "## Style",
      "1. Prefer small functions.",
      "",
      "A paragraph that",
      "spans two lines.",
      "",
      "```bash",
      "pnpm lint",
      "```",
    ].join("\n")
    const units = segmentRules(text)
    expect(units.map((unit) => [unit.kind, unit.startLine, unit.endLine])).toEqual([
      ["frontmatter", 1, 4],
      ["heading", 5, 5],
      ["bullet", 7, 8],
      ["bullet", 9, 9],
      ["heading", 11, 11],
      ["numbered", 12, 12],
      ["paragraph", 14, 15],
      ["code", 17, 19],
    ])
    expect(units[2]!.text).toBe("Run `pnpm test` before committing so CI stays green.")
    expect(units[5]!.headings).toEqual(["Rules", "Style"])
    expect(units[2]!.headings).toEqual(["Rules"])
  })

  it("pops headings of the same or deeper level", () => {
    const units = segmentRules("# A\n## B\n- x\n# C\n- y")
    expect(units.find((unit) => unit.text === "x")!.headings).toEqual(["A", "B"])
    expect(units.find((unit) => unit.text === "y")!.headings).toEqual(["C"])
  })

  it("keeps an unclosed fence to the end as one code unit", () => {
    const units = segmentRules("- a\n```\nnever closed\nstill code")
    expect(units[1]).toMatchObject({ kind: "code", startLine: 2, endLine: 4 })
  })

  it("filters instruction units and numbers lines for the model", () => {
    const units = segmentRules("# H\n- a\n```\nb\n```")
    expect(instructionUnits(units).map((unit) => unit.text)).toEqual(["a"])
    expect(numberLines("x\ny")).toBe("1| x\n2| y")
    expect(numberLines(Array.from({ length: 10 }, () => "z").join("\n")).split("\n")[0]).toBe(
      " 1| z"
    )
  })
})
