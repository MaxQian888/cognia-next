import {
  commentAnchorLabel,
  formatContextSelectionsForLLM,
  wholeArtifactSelection,
  wholeFileSelection,
} from "./format-selection-context"
import type { ArtifactSelectionRef } from "@/types/artifact/artifact"
import type { ContextCommentAnchor } from "@/types/context-comment"

const sel = (over: Partial<ArtifactSelectionRef> = {}): ArtifactSelectionRef => ({
  kind: "artifact",
  artifactId: "a1",
  title: "Snippet",
  snapshot: "const x = 1",
  comment: "rename x to count",
  range: { startLine: 2, endLine: 2 },
  ...over,
})

describe("formatContextSelectionsForLLM", () => {
  it("returns an empty string for no selections", () => {
    expect(formatContextSelectionsForLLM([])).toBe("")
  })

  it("includes the title, single-line range, snapshot, and comment", () => {
    const out = formatContextSelectionsForLLM([sel()])
    expect(out).toContain('artifact "Snippet"')
    expect(out).toContain("lines 2")
    expect(out).toContain("const x = 1")
    expect(out).toContain("Comment: rename x to count")
  })

  it("renders a multi-line range as start-end", () => {
    const out = formatContextSelectionsForLLM([sel({ range: { startLine: 3, endLine: 7 } })])
    expect(out).toContain("lines 3-7")
  })

  it("omits the comment line when the comment is blank", () => {
    const out = formatContextSelectionsForLLM([sel({ comment: "   " })])
    expect(out).not.toContain("Comment:")
  })

  it("joins multiple selections", () => {
    const out = formatContextSelectionsForLLM([sel({ title: "First" }), sel({ title: "Second" })])
    expect(out).toContain("First")
    expect(out).toContain("Second")
    expect(out.startsWith("Referenced context:")).toBe(true)
  })
})

// Each kind gets its own heading so the assistant can tell material it may be
// asked to revise from material it may only cite.
describe("formatContextSelectionsForLLM — non-artifact kinds", () => {
  it("labels a whole file by its path, with no line range", () => {
    const out = formatContextSelectionsForLLM([
      wholeFileSelection({ relPath: "src/router.ts", content: "export function route() {}" }),
    ])
    expect(out).toContain('File "src/router.ts":')
    expect(out).not.toContain("lines")
    expect(out).toContain("export function route() {}")
  })

  it("labels a file hunk with its range", () => {
    const out = formatContextSelectionsForLLM([
      {
        kind: "file",
        relPath: "src/router.ts",
        title: "router.ts",
        snapshot: "…",
        comment: "",
        range: { startLine: 10, endLine: 14 },
      },
    ])
    expect(out).toContain('Selection from file "src/router.ts" (lines 10-14):')
  })

  it("labels a comment, with its anchor when it has one", () => {
    const base = {
      kind: "comment" as const,
      title: "pipeline.ts",
      snapshot: "this should be idempotent",
      comment: "",
    }
    expect(formatContextSelectionsForLLM([base])).toContain('Comment on "pipeline.ts":')
    expect(formatContextSelectionsForLLM([{ ...base, anchorLabel: "lines 12-18" }])).toContain(
      'Comment on "pipeline.ts" (lines 12-18):'
    )
  })

  it("labels a web page with its URL", () => {
    const out = formatContextSelectionsForLLM([
      {
        kind: "web",
        url: "https://example.com/docs",
        title: "Docs",
        snapshot: "the relevant paragraph",
        comment: "",
      },
    ])
    expect(out).toContain('From the page "Docs" (https://example.com/docs):')
  })

  it("labels an external selection with its app, title and truncation", () => {
    const out = formatContextSelectionsForLLM([
      {
        kind: "external",
        candidateId: "candidate-1",
        sourceApp: "TextEdit",
        sourceTitle: "Draft",
        origin: "accessibility",
        truncated: true,
        title: "Draft",
        snapshot: "selected text",
        comment: "",
      },
    ])
    expect(out).toContain(
      'Selection from app "TextEdit", window "Draft" (truncated to 20,000 characters):'
    )
    expect(out).toContain("selected text")
  })

  it("keeps every kind in one block, in staging order", () => {
    const out = formatContextSelectionsForLLM([
      sel({ title: "Art" }),
      wholeFileSelection({ relPath: "a/b.ts", content: "x" }),
    ])
    expect(out.startsWith("Referenced context:")).toBe(true)
    expect(out.indexOf('artifact "Art"')).toBeLessThan(out.indexOf('File "a/b.ts"'))
  })
})

describe("wholeArtifactSelection", () => {
  it("spans the whole document with a 1-based inclusive range", () => {
    expect(wholeArtifactSelection({ id: "a1", title: "Doc", content: "one\ntwo\nthree" })).toEqual({
      kind: "artifact",
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
    expect(formatContextSelectionsForLLM([selection])).toContain("lines 1")
  })

  it("counts the trailing blank line a final newline creates", () => {
    expect(wholeArtifactSelection({ id: "a3", title: "T", content: "a\nb\n" }).range.endLine).toBe(
      3
    )
  })

  it("stages no comment, so the formatter omits the comment line", () => {
    const out = formatContextSelectionsForLLM([
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

// Prompt scaffolding, so English by design and deliberately not localised —
// it names the anchor inside the `Comment on "…" (…)` heading above.
describe("commentAnchorLabel", () => {
  const anchor = (over: Partial<ContextCommentAnchor> = {}): ContextCommentAnchor =>
    ({ kind: "text-range", ...over }) as ContextCommentAnchor

  it("names a multi-line range", () => {
    expect(anchor({ lineRange: { startLine: 12, endLine: 18 } } as never)).toBeDefined()
    expect(commentAnchorLabel(anchor({ lineRange: { startLine: 12, endLine: 18 } } as never))).toBe(
      "lines 12-18"
    )
  })

  it("collapses a single-line range to the singular form", () => {
    expect(commentAnchorLabel(anchor({ lineRange: { startLine: 7, endLine: 7 } } as never))).toBe(
      "line 7"
    )
  })

  it("falls back to the quoted text when there is no line range", () => {
    expect(commentAnchorLabel(anchor({ quotedText: "const x = 1" } as never))).toBe(
      'on "const x = 1"'
    )
  })

  it("yields nothing for a text range with neither lines nor quoted text", () => {
    expect(commentAnchorLabel(anchor())).toBeUndefined()
  })

  it("names workflow nodes and edges", () => {
    expect(
      commentAnchorLabel({ kind: "workflow-node", nodeId: "n1" } as ContextCommentAnchor)
    ).toBe("node n1")
    expect(
      commentAnchorLabel({ kind: "workflow-edge", edgeId: "e1" } as ContextCommentAnchor)
    ).toBe("edge e1")
  })

  it("yields nothing for a whole-resource anchor", () => {
    expect(
      commentAnchorLabel({ kind: "resource", revision: "r1" } as ContextCommentAnchor)
    ).toBeUndefined()
  })

  it("feeds the comment heading the formatter builds", () => {
    const out = formatContextSelectionsForLLM([
      {
        kind: "comment",
        title: "Spec",
        snapshot: "needs a retry",
        comment: "",
        anchorLabel: commentAnchorLabel(
          anchor({ lineRange: { startLine: 3, endLine: 9 } } as never)
        ),
      },
    ])
    expect(out).toContain('Comment on "Spec" (lines 3-9):')
  })
})
