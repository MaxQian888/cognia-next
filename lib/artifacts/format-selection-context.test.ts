import { formatArtifactSelectionsForLLM } from "./format-selection-context"
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
