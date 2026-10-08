import { gitHunksToDiffRows } from "./diff-presentation"
import { parseUnifiedPatch, patchFilePath } from "./unified-patch"

const MULTI = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@ export function a() {",
  " keep",
  "-old",
  "+new",
  " tail",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+one",
  "+two",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
].join("\n")

describe("parseUnifiedPatch", () => {
  it("splits a multi-file patch and classifies each file", () => {
    const files = parseUnifiedPatch(MULTI)
    expect(files.map((f) => [patchFilePath(f), f.change, f.added, f.removed])).toEqual([
      ["src/a.ts", "modified", 1, 1],
      ["src/new.ts", "added", 2, 0],
      ["gone.ts", "deleted", 0, 1],
    ])
    expect(files[1].oldPath).toBeNull()
    expect(files[2].newPath).toBeNull()
  })

  it("builds git-shaped hunks with line terminators and self-contained patches", () => {
    const [file] = parseUnifiedPatch(MULTI)
    const [hunk] = file.hunks
    expect(hunk).toMatchObject({
      header: "@@ -1,3 +1,3 @@ export function a() {",
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
    })
    expect(hunk.lines).toEqual([
      { kind: "context", content: "keep\n" },
      { kind: "del", content: "old\n" },
      { kind: "add", content: "new\n" },
      { kind: "context", content: "tail\n" },
    ])
    expect(hunk.patch.startsWith("diff --git a/src/a.ts b/src/a.ts\n")).toBe(true)
    expect(hunk.patch).toContain("@@ -1,3 +1,3 @@")
  })

  it("recomputes wrong hunk counts from the lines present", () => {
    const [file] = parseUnifiedPatch(
      ["--- a/x", "+++ b/x", "@@ -1,9 +1,1 @@", " a", "-b", "+c", "+d"].join("\n")
    )
    expect(file.hunks[0]).toMatchObject({ oldLines: 2, newLines: 3 })
  })

  it("reads a trimmed blank line inside a hunk as context", () => {
    const [file] = parseUnifiedPatch(
      ["--- a/x", "+++ b/x", "@@ -1,3 +1,3 @@", " a", "", "-b", "+c"].join("\n")
    )
    expect(file.hunks[0].lines.map((l) => l.kind)).toEqual(["context", "context", "del", "add"])
  })

  it("drops the terminator before a no-newline marker", () => {
    const [file] = parseUnifiedPatch(
      ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n")
    )
    expect(file.hunks[0].lines[0]).toEqual({ kind: "del", content: "a" })
    expect(file.hunks[0].lines[1]).toEqual({ kind: "add", content: "b\n" })
  })

  it("follows git renames and binary markers", () => {
    const files = parseUnifiedPatch(
      [
        "diff --git a/old.ts b/new.ts",
        "similarity index 90%",
        "rename from old.ts",
        "rename to new.ts",
        "diff --git a/img.png b/img.png",
        "Binary files a/img.png and b/img.png differ",
      ].join("\n")
    )
    expect(files[0]).toMatchObject({ oldPath: "old.ts", newPath: "new.ts", change: "renamed" })
    expect(files[1]).toMatchObject({ binary: true, hunks: [] })
  })

  it("strips timestamps and quotes from header paths", () => {
    const [file] = parseUnifiedPatch(
      [
        '--- "a/with space.ts"\t2024-01-01',
        "+++ b/with space.ts\t2024-01-02",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n")
    )
    expect(file.oldPath).toBe("with space.ts")
    expect(file.newPath).toBe("with space.ts")
    expect(file.change).toBe("modified")
  })

  it("keeps a bare run of diff lines as one unnumbered hunk", () => {
    const [file] = parseUnifiedPatch([" ctx", "-a", "+b"].join("\n"))
    expect(patchFilePath(file)).toBeNull()
    expect(file.hunks).toHaveLength(1)
    expect(file.hunks[0].header).toBe("")
    const rows = gitHunksToDiffRows(file.hunks)
    expect(rows.every((r) => r.kind === "line")).toBe(true)
    expect(rows[1]).toEqual({ kind: "line", index: 1, line: { type: "removed", content: "a" } })
  })

  it("ignores prose and accepts CRLF text", () => {
    const files = parseUnifiedPatch(
      ["Here is the fix:", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b", "Thanks"].join("\r\n")
    )
    expect(files).toHaveLength(1)
    expect(files[0].hunks[0].lines).toHaveLength(2)
  })

  it("returns nothing for text without a diff", () => {
    expect(parseUnifiedPatch("just words\nmore words")).toEqual([])
    expect(parseUnifiedPatch("")).toEqual([])
  })
})
