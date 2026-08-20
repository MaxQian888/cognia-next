import { collectFileReferences, primaryFileReference } from "./editor-links"

describe("recovering paths from issue text", () => {
  it("finds a bare workspace-relative path", () => {
    expect(collectFileReferences("crash in lib/foo/bar.ts")).toEqual([{ path: "lib/foo/bar.ts" }])
  })

  it("keeps a 1-based line and column", () => {
    expect(collectFileReferences("see lib/a.ts:42:7")).toEqual([
      { path: "lib/a.ts", line: 42, column: 7 },
    ])
  })

  it("reads a line without a column", () => {
    expect(collectFileReferences("lib/a.ts:42")).toEqual([{ path: "lib/a.ts", line: 42 }])
  })

  it("scans several fields in order", () => {
    expect(collectFileReferences("title lib/a.ts", "body lib/b.rs")).toEqual([
      { path: "lib/a.ts" },
      { path: "lib/b.rs" },
    ])
  })

  it("survives the brackets and backticks people actually type", () => {
    const refs = collectFileReferences("(see `lib/a.ts`) and [lib/b.ts], plus {lib/c.ts}")
    expect(refs.map((r) => r.path)).toEqual(["lib/a.ts", "lib/b.ts", "lib/c.ts"])
  })

  it("drops sentence punctuation glued to the path", () => {
    expect(collectFileReferences("it broke in lib/a.ts.")).toEqual([{ path: "lib/a.ts" }])
  })

  it("normalizes a leading ./ but keeps the written form", () => {
    // The path is handed to the backend as written; only the *test* for
    // linkability is normalized.
    expect(collectFileReferences("./lib/a.ts")).toEqual([{ path: "./lib/a.ts" }])
  })

  it("accepts an absolute path", () => {
    expect(collectFileReferences("/repo/lib/a.ts")).toEqual([{ path: "/repo/lib/a.ts" }])
  })

  it("treats a Windows drive letter as a path, not a line suffix", () => {
    expect(collectFileReferences("C:\\work\\a.ts:12")).toEqual([
      { path: "C:\\work\\a.ts", line: 12 },
    ])
  })
})

describe("what it refuses to link", () => {
  it("ignores version numbers and prose with dots", () => {
    expect(collectFileReferences("regressed in v1.2 after the 3.0 upgrade")).toEqual([])
  })

  it("ignores unknown extensions", () => {
    // A false positive sends the user to a file that does not exist, which is
    // worse than offering nothing.
    expect(collectFileReferences("attached report.docx and notes.xyz")).toEqual([])
  })

  it("ignores URLs — the external link affordance covers those", () => {
    expect(collectFileReferences("https://example.com/a.ts")).toEqual([])
  })

  it("refuses a path that escapes the root", () => {
    expect(collectFileReferences("../../etc/passwd.sh")).toEqual([])
  })

  it("refuses a non-positive line", () => {
    expect(collectFileReferences("lib/a.ts:0")).toEqual([])
  })

  it("returns nothing for empty or absent text", () => {
    expect(collectFileReferences(null, undefined, "")).toEqual([])
  })
})

describe("de-duplication", () => {
  it("collapses a repeated path", () => {
    expect(collectFileReferences("lib/a.ts and again lib/a.ts")).toEqual([{ path: "lib/a.ts" }])
  })

  it("keeps two positions in the same file as two destinations", () => {
    expect(collectFileReferences("lib/a.ts:10 and lib/a.ts:99")).toEqual([
      { path: "lib/a.ts", line: 10 },
      { path: "lib/a.ts", line: 99 },
    ])
  })
})

describe("primaryFileReference", () => {
  it("takes the first, because issues lead with what they are about", () => {
    expect(primaryFileReference("fix lib/a.ts", "see also lib/b.ts")).toEqual({
      path: "lib/a.ts",
    })
  })

  it("is null when nothing is linkable", () => {
    expect(primaryFileReference("the login button is broken")).toBeNull()
  })
})
