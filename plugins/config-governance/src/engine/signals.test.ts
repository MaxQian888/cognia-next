import { segmentRules } from "./segment"
import { OVERSIZED_SKILL_LINES, scanSignals } from "./signals"

function scan(text: string, isSkill = false) {
  return scanSignals(segmentRules(text), text.split("\n"), { isSkill })
}

describe("scanSignals", () => {
  it("names the exact line a line signal matched on", () => {
    const hits = scan(
      "# Rules\n- Keep it short\n  and you MUST answer in English.\n- Think step by step."
    )
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signal: "pressure-language",
          startLine: 3,
          endLine: 3,
          evidence: "MUST",
        }),
        expect.objectContaining({
          signal: "thinking-scaffold",
          startLine: 4,
          evidence: "Think step by step",
        }),
      ])
    )
  })

  it("never reads code or headings as instructions", () => {
    expect(scan("# IMPORTANT\n```\nMUST\n```")).toEqual([])
  })

  it("finds fossils, history and date conditionals", () => {
    const signals = scan(
      "- Use claude-3-opus for reviews.\n- See PR #1234 for why.\n- Before 2024-05-01 use the old API.\n- Only use tools when necessary."
    ).map((hit) => hit.signal)
    expect(signals).toEqual(
      expect.arrayContaining([
        "retired-model-name",
        "history-narrative",
        "date-conditional",
        "tool-discouragement",
      ])
    )
  })

  it("reports a run of three prohibitions as one cluster", () => {
    const hits = scan("- Do not use var.\n- Never use any.\n- Don't log secrets.\n- Prefer const.")
    const cluster = hits.find((hit) => hit.signal === "prohibition-cluster")
    expect(cluster).toMatchObject({ startLine: 1, endLine: 3 })
    expect(
      scan("- Do not use var.\n- Prefer const.\n- Never use any.").some(
        (hit) => hit.signal === "prohibition-cluster"
      )
    ).toBe(false)
  })

  it("flags an identity line only when it stands alone", () => {
    expect(scan("You are a helpful assistant.").map((hit) => hit.signal)).toContain("identity-stub")
    expect(
      scan("You are a helpful assistant.\n\n- Answer about our billing API.").map(
        (hit) => hit.signal
      )
    ).not.toContain("identity-stub")
  })

  it("adds the Skill-only checks", () => {
    const quotes = Array.from({ length: 6 }, (_, i) => `"query number ${i}"`).join(", ")
    const frontmatter = `---\ndescription: Use for ${quotes}\n---\nbody`
    expect(scan(frontmatter, true).map((hit) => hit.signal)).toContain("trigger-enumeration")
    expect(scan(frontmatter, false).map((hit) => hit.signal)).not.toContain("trigger-enumeration")
    const long = Array.from({ length: OVERSIZED_SKILL_LINES + 1 }, () => "line").join("\n")
    expect(scan(long, true).map((hit) => hit.signal)).toContain("oversized-skill")
  })
})
