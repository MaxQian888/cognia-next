import {
  buildDocumentStructure,
  buildTextDocumentStructure,
  documentContentHash,
} from "./document-structure"
import { parseMarkdown } from "./parsers/markdown-parser"

describe("canonical document structure", () => {
  it("keeps original frontmatter, fences, Unicode, hierarchy, and source ranges", () => {
    const text =
      "---\ntitle: Manual\n---\n# Start\n正文😀\n```md\n# not a chapter\n```\n## Details\nExact answer.\n# End\nDone."
    const structure = buildTextDocumentStructure(text)
    expect(structure.contentHash).toBe(documentContentHash(text))
    expect(structure.textLength).toBe(text.length)
    expect(structure.nodes.map((node) => node.title)).toEqual(["", "Start", "Details", "End"])
    const start = structure.nodes[1]
    const details = structure.nodes[2]
    expect(start.lineStart).toBe(4)
    expect(details.parentId).toBe(start.id)
    expect(text.slice(details.charStart, details.charEnd)).toBe("## Details\nExact answer.\n")
    expect(text.slice(start.charStart, start.charEnd)).toContain("# not a chapter")
  })

  it("keeps ids stable across body changes and disambiguates repeated headings", () => {
    const first = buildTextDocumentStructure("# Topic\nFirst\n## Repeat\nA\n## Repeat\nB")
    const second = buildTextDocumentStructure(
      "# Topic\nChanged and longer\n## Repeat\nC\n## Repeat\nD"
    )
    expect(first.nodes.map((node) => node.id)).toEqual(second.nodes.map((node) => node.id))
    expect(first.nodes[2].id).not.toBe(first.nodes[3].id)
    expect(first.contentHash).not.toBe(second.contentHash)
  })

  it("maps bookmarks and nested chapters to PDF page ranges", () => {
    const content = "Page one\n\nPage two\n\nPage three"
    const pdf = {
      text: content,
      metadata: {},
      pageCount: 3,
      pages: ["Page one", "Page two", "Page three"].map((text, index) => ({
        text,
        pageNumber: index + 1,
        width: 1,
        height: 1,
      })),
      outline: [
        {
          title: "Chapter",
          pageNumber: 1,
          children: [{ title: "Subchapter", pageNumber: 2, children: [] }],
        },
        { title: "Conclusion", pageNumber: 3, children: [] },
      ],
    }
    const result = buildDocumentStructure({ content, pdf })
    expect(result.pages).toHaveLength(3)
    expect(result.nodes[2]).toMatchObject({
      parentId: result.nodes[1].id,
      pageStart: 2,
      pageEnd: 2,
    })
    expect(result.nodes[1]).toMatchObject({ pageStart: 1, pageEnd: 2 })
    expect(content.slice(result.nodes[2].charStart, result.nodes[2].charEnd)).toBe("Page two\n\n")
  })

  it("handles empty documents and a final trailing newline", () => {
    expect(buildTextDocumentStructure("").nodes[0]).toMatchObject({
      charStart: 0,
      charEnd: 0,
      lineStart: 1,
      lineEnd: 1,
    })
    const content = "# Chapter\n"
    expect(
      buildDocumentStructure({ content, markdown: parseMarkdown(content) }).nodes[1].charEnd
    ).toBe(content.length)
  })
})

it("gives bookmarks sharing a page a readable original page range", () => {
  const content = "First topic. Second topic."
  const structure = buildDocumentStructure({
    content,
    pdf: {
      text: content,
      pageCount: 1,
      metadata: {},
      pages: [{ pageNumber: 1, text: content, width: 1, height: 1 }],
      outline: [
        { title: "First", pageNumber: 1, children: [] },
        { title: "Second", pageNumber: 1, children: [] },
      ],
    },
  })
  expect(content.slice(structure.nodes[1].charStart, structure.nodes[1].charEnd)).toBe(content)
  expect(content.slice(structure.nodes[2].charStart, structure.nodes[2].charEnd)).toBe(content)
})
