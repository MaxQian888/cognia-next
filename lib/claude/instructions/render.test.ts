import { renderInstructions } from "./render"
import { resolveInstructionsConfig, type InstructionFile } from "./types"

function file(label: string, content: string): InstructionFile {
  return { absPath: `/proj/${label}`, label, source: "project", content }
}

describe("renderInstructions", () => {
  it("renders labelled blocks joined by separators with a preamble", () => {
    const r = renderInstructions(
      [file("CLAUDE.md", "root rules"), file("sub/AGENT.md", "sub rules")],
      resolveInstructionsConfig()
    )
    expect(r.section).toContain("project instruction files")
    expect(r.section).toContain("## CLAUDE.md\n\nroot rules")
    expect(r.section).toContain("## sub/AGENT.md\n\nsub rules")
    expect(r.section).toContain("\n\n---\n\n")
    expect(r.warnings).toHaveLength(0)
  })

  it("returns an empty section when nothing meaningful remains", () => {
    const r = renderInstructions([file("CLAUDE.md", "   ")], resolveInstructionsConfig())
    expect(r.section).toBe("")
  })

  it("caps the file count and warns about dropped files", () => {
    const files = [file("a.md", "a"), file("b.md", "b"), file("c.md", "c")]
    const r = renderInstructions(files, resolveInstructionsConfig({ maxFiles: 2 }))
    expect(r.files).toHaveLength(2)
    expect(r.section).not.toContain("## c.md")
    expect(r.warnings[0]).toMatch(/capped at 2/)
    expect(r.warnings[0]).toMatch(/c\.md/)
  })

  it("truncates oversized files and warns", () => {
    const big = "x".repeat(100)
    const r = renderInstructions(
      [file("big.md", big)],
      resolveInstructionsConfig({ maxFileBytes: 10 })
    )
    expect(r.section).toContain("…[truncated]")
    expect(r.warnings[0]).toMatch(/truncated to 10/)
  })
})
