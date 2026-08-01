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

  describe("the quoted form", () => {
    it("accepts a path containing spaces, which the bare form cannot express", () => {
      expect(extractFileRefs('read @"Screen Shot 2026-01-01 at 10.14.32.png"')).toEqual([
        "Screen Shot 2026-01-01 at 10.14.32.png",
      ])
    })

    it("needs no extension heuristic, since the quotes delimit it", () => {
      expect(extractFileRefs('open @"/repo/Makefile"')).toEqual(["/repo/Makefile"])
    })

    it("mixes with bare refs in one prompt, in source order", () => {
      expect(extractFileRefs('@a.png then @"my notes.md" then @b.txt')).toEqual([
        "a.png",
        "my notes.md",
        "b.txt",
      ])
    })

    it("still drops @skill:/@agent: tokens when they are quoted", () => {
      expect(extractFileRefs('@"skill:foo" @"agent:bar"')).toEqual([])
    })

    it("trims incidental padding rather than resolving a path with edge spaces", () => {
      expect(extractFileRefs('@"  spaced.md  "')).toEqual(["spaced.md"])
    })

    it("ignores an empty, whitespace-only or unterminated quote", () => {
      expect(extractFileRefs('@"" and @"   " and @"unterminated.md')).toEqual([])
    })

    it("does not match a quoted ref spanning a newline", () => {
      expect(extractFileRefs('@"a\nb.md"')).toEqual([])
    })

    it("does not let a bare ref swallow a following quote", () => {
      // Without `"` excluded from the bare character class, `@a.png"x.md"`
      // would match one bogus ref spanning the quote.
      expect(extractFileRefs('@a.png"b.md"')).toEqual(["a.png"])
    })
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
