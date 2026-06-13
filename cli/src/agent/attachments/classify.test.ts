/**
 * @jest-environment node
 */
import { extractFileRefs, classifyRef } from "./classify"

describe("extractFileRefs", () => {
  it("extracts @-prefixed file refs, excluding trailing sentence punctuation", () => {
    expect(extractFileRefs("see @a.png and @./docs/spec.pdf.")).toEqual([
      "a.png",
      "./docs/spec.pdf",
    ])
  })

  it("ignores bare @mentions without an extension and @skill:/@agent: tokens", () => {
    expect(extractFileRefs("hi @bob @skill:foo @agent:bar")).toEqual([])
  })

  it("keeps Windows-style paths and comma-trailed refs", () => {
    expect(extractFileRefs("open @C:\\tmp\\a.docx, then @b.md")).toEqual([
      "C:\\tmp\\a.docx",
      "b.md",
    ])
  })
})

describe("classifyRef", () => {
  it.each<[string, ReturnType<typeof classifyRef>]>([
    ["shot.PNG", "image"],
    ["a.jpeg", "image"],
    ["report.pdf", "pdf"],
    ["notes.md", "text"],
    ["main.ts", "text"],
    ["data.csv", "text"],
    ["deck.pptx", "rich"],
    ["sheet.xlsx", "rich"],
    ["page.html", "rich"],
    ["archive.zip", "unknown"],
  ])("classifies %s as %s", (ref, kind) => {
    expect(classifyRef(ref)).toBe(kind)
  })
})
