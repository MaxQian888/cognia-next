import { formatArtifactSelectionsForLLM, wholeArtifactSelection } from "./format-selection-context"
import type { ArtifactSelectionRef } from "@/types/artifact/artifact"

const sel = (over: Partial<ArtifactSelectionRef> = {}): ArtifactSelectionRef => ({
  artifactId: "a1",
  title: "Snippet",
  snapshot: "const x = 1",
  comment: "rename x to count",
  range: { startLine: 2, endLine: 2 },
  ...over,
})

describe("formatArtifactSelectionsForLLM", () => {
  it("returns an empty string for no selections", () => {
    expect(formatArtifactSelectionsForLLM([])).toBe("")
  })

  it("includes the title, single-line range, snapshot, and comment", () => {
    const out = formatArtifactSelectionsForLLM([sel()])
    expect(out).toContain('artifact "Snippet"')
    expect(out).toContain("lines 2")
    expect(out).toContain("const x = 1")
    expect(out).toContain("Comment: rename x to count")
  })

  it("renders a multi-line range as start-end", () => {
    const out = formatArtifactSelectionsForLLM([sel({ range: { startLine: 3, endLine: 7 } })])
    expect(out).toContain("lines 3-7")
  })

  it("omits the comment line when the comment is blank", () => {
    const out = formatArtifactSelectionsForLLM([sel({ comment: "   " })])
    expect(out).not.toContain("Comment:")
  })

  it("joins multiple selections", () => {
    const out = formatArtifactSelectionsForLLM([sel({ title: "First" }), sel({ title: "Second" })])
    expect(out).toContain("First")
    expect(out).toContain("Second")
    expect(out.startsWith("Referenced artifact selections:")).toBe(true)
  })
})

describe("wholeArtifactSelection", () => {
  it("spans the whole document with a 1-based inclusive range", () => {
    expect(wholeArtifactSelection({ id: "a1", title: "Doc", content: "one\ntwo\nthree" })).toEqual({
      artifactId: "a1",
      title: "Doc",
      snapshot: "one\ntwo\nthree",
      comment: "",
      range: { startLine: 1, endLine: 3 },
    })
  })

  it("gives a single-line artifact the range 1-1, which formats as one number", () => {
    const selection = wholeArtifactSelection({ id: "a2", title: "One", content: "only line" })
    expect(selection.range).toEqual({ startLine: 1, endLine: 1 })
    expect(formatArtifactSelectionsForLLM([selection])).toContain("lines 1")
  })

  it("counts the trailing blank line a final newline creates", () => {
    expect(wholeArtifactSelection({ id: "a3", title: "T", content: "a\nb\n" }).range.endLine).toBe(
      3
    )
  })

  it("stages no comment, so the formatter omits the comment line", () => {
    const out = formatArtifactSelectionsForLLM([
      wholeArtifactSelection({ id: "a4", title: "T", content: "x" }),
    ])
    expect(out).not.toContain("Comment:")
  })

  it("treats an empty artifact as a single empty line rather than a zero-length range", () => {
    expect(wholeArtifactSelection({ id: "a5", title: "Empty", content: "" }).range).toEqual({
      startLine: 1,
      endLine: 1,
    })
  })
})
