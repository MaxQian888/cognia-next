import {
  diffSegments,
  mixColor,
  parsePatchBody,
  preparePatchLines,
  type PatchViewOptions,
} from "./patch-view"
import { expandPalette } from "../theme/palette"
import type { TerminalLine } from "../render/terminal-block"

const t = (key: string, params?: Record<string, string | number>) =>
  params
    ? `${key}(${Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")})`
    : key

const opts = (over: Partial<PatchViewOptions> = {}): PatchViewOptions => ({
  width: 80,
  layout: "unified",
  translate: t,
  ...over,
})

const MODIFIED = `diff --git a/file.ts b/file.ts
index 1111111..2222222 100644
--- a/file.ts
+++ b/file.ts
@@ -1,4 +1,5 @@ function main() {
 const a = 1
-const b = 2
+const b = 3
 const c = 4
 const d = 5
+const e = 6
`

const NEW_FILE = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+first
+second
`

const plains = (lines: TerminalLine[]) => lines.map((line) => line.plain)

describe("parsePatchBody", () => {
  it("parses sections, hunks and running line numbers", () => {
    const parsed = parsePatchBody(MODIFIED)
    expect(parsed.sections).toHaveLength(1)
    const section = parsed.sections[0]
    expect(section.status).toBe("modified")
    expect(section.hunks).toHaveLength(1)
    const hunk = section.hunks[0]
    expect(hunk.header).toBe("@@ -1,4 +1,5 @@")
    expect(hunk.context).toBe("function main() {")
    expect(hunk.rows.map((row) => row.kind)).toEqual([
      "context",
      "del",
      "add",
      "context",
      "context",
      "add",
    ])
    expect(hunk.rows[1]).toMatchObject({ oldNo: 2, text: "const b = 2" })
    expect(hunk.rows[2]).toMatchObject({ newNo: 2, text: "const b = 3" })
    expect(hunk.rows[5]).toMatchObject({ newNo: 5, text: "const e = 6" })
  })

  it("marks paired del/add rows with word-diff segments", () => {
    const parsed = parsePatchBody(MODIFIED)
    const [del, add] = [parsed.sections[0].hunks[0].rows[1], parsed.sections[0].hunks[0].rows[2]]
    expect(del.segments?.filter((s) => s.hot).map((s) => s.text)).toEqual(["2"])
    expect(add.segments?.filter((s) => s.hot).map((s) => s.text)).toEqual(["3"])
    // Unpaired trailing addition carries no intra-line emphasis.
    expect(parsed.sections[0].hunks[0].rows[5].segments).toBeUndefined()
  })

  it("detects new, deleted, renamed, mode-only and binary files", () => {
    expect(parsePatchBody(NEW_FILE).sections[0].status).toBe("added")
    const deleted = parsePatchBody(
      `diff --git a/old.ts b/old.ts\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n`
    )
    expect(deleted.sections[0].status).toBe("deleted")
    const renamed = parsePatchBody(
      `diff --git a/old.ts b/new.ts\nsimilarity index 88%\nrename from old.ts\nrename to new.ts\nindex 1111111..2222222 100644\n`
    )
    expect(renamed.sections[0]).toMatchObject({ status: "renamed", renameFrom: "old.ts" })
    const mode = parsePatchBody(`diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n`)
    expect(mode.sections[0]).toMatchObject({
      status: "mode",
      modeChange: { from: "100644", to: "100755" },
    })
    const binary = parsePatchBody(
      `diff --git a/logo.png b/logo.png\nindex 1111111..2222222 100644\nBinary files a/logo.png and b/logo.png differ\n`
    )
    expect(binary.sections[0].status).toBe("binary")
  })

  it("folds GIT binary patch payloads instead of dropping them", () => {
    const parsed = parsePatchBody(
      `diff --git a/blob.bin b/blob.bin\nindex 1111111..2222222 100644\nGIT binary patch\nliteral 5\nKcmZP\n\nliteral 3\nabc\n\n`
    )
    expect(parsed.sections[0].status).toBe("binary")
    expect(parsed.sections[0].binaryPayloadLines).toBeGreaterThan(0)
    expect(parsed.sections[0].orphans).toEqual([])
  })

  it("keeps text before the first section and stray lines as orphans", () => {
    const parsed = parsePatchBody(`note before anything\n+staged\n${MODIFIED}trailing junk\n`)
    expect(parsed.preamble).toEqual(["note before anything", "+staged"])
    expect(parsed.sections[0].orphans).toEqual([{ line: "trailing junk", afterHunks: 1 }])
  })

  it("records orphans between hunks at their real position", () => {
    const parsed = parsePatchBody(
      `diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b\nnoise between\n@@ -5 +5 @@\n-c\n+d\n`
    )
    const section = parsed.sections[0]
    expect(section.hunks).toHaveLength(2)
    expect(section.orphans).toEqual([{ line: "noise between", afterHunks: 1 }])
  })

  it("keeps \\ No newline at end of file as a meta row inside the hunk", () => {
    const parsed = parsePatchBody(
      `diff --git a/f b/f\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n`
    )
    const kinds = parsed.sections[0].hunks[0].rows.map((row) => row.kind)
    expect(kinds).toEqual(["del", "meta", "add", "meta"])
    expect(parsed.sections[0].hunks[0].rows[1].text).toContain("No newline")
  })

  it("honours stated hunk counts when content looks like a header", () => {
    const parsed = parsePatchBody(
      `diff --git a/f b/f\n@@ -1,1 +1,2 @@\n ctx\n+diff --git is content\n`
    )
    const hunk = parsed.sections[0].hunks[0]
    expect(hunk.rows.map((r) => r.kind)).toEqual(["context", "add"])
    expect(hunk.rows[1].text).toBe("diff --git is content")
  })

  it("closes a hunk when its stated counts are exhausted", () => {
    const parsed = parsePatchBody(`diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b\n+extra beyond counts\n`)
    const section = parsed.sections[0]
    expect(section.hunks[0].rows).toHaveLength(2)
    expect(section.orphans).toEqual([{ line: "+extra beyond counts", afterHunks: 1 }])
  })

  it("handles combined (diff --cc) hunks with a two-column prefix", () => {
    const parsed = parsePatchBody(
      `diff --cc file.ts\nindex aaa,bbb..ccc\n--- a/file.ts\n+++ b/file.ts\n@@@ -1,2 -1,2 +1,3 @@@\n  ctx\n- del\n+ add\n+ more\n`
    )
    const hunk = parsed.sections[0].hunks[0]
    expect(hunk.header).toContain("@@@")
    expect(hunk.rows.map((r) => r.kind)).toEqual(["context", "del", "add", "add"])
    expect(hunk.rows[3].text).toBe("more")
  })

  it("splits multiple diff --git blocks in one body", () => {
    const parsed = parsePatchBody(
      `diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/g b/g\n@@ -1 +1 @@\n-c\n+d\n`
    )
    expect(parsed.sections).toHaveLength(2)
  })
})

describe("diffSegments", () => {
  it("returns a single cold segment for identical lines", () => {
    expect(diffSegments("same", "same")).toEqual({
      old: [{ text: "same" }],
      next: [{ text: "same" }],
    })
  })

  it("marks only the changed tokens hot", () => {
    const { old, next } = diffSegments("const count = oldName + 1", "const count = newName + 1")
    expect(old.filter((s) => s.hot).map((s) => s.text)).toEqual(["oldName"])
    expect(next.filter((s) => s.hot).map((s) => s.text)).toEqual(["newName"])
  })

  it("handles insertions and deletions inside the line", () => {
    const { old, next } = diffSegments("a(b, c)", "a(b, c, d)")
    expect(
      old
        .filter((s) => s.hot)
        .map((s) => s.text)
        .join("")
    ).toBe("")
    expect(
      next
        .filter((s) => s.hot)
        .map((s) => s.text)
        .join("")
    ).toBe(", d")
  })

  it("falls back to edge matching on very long lines", () => {
    const mid = " token".repeat(200)
    const { old, next } = diffSegments(`start${mid} oldEnd`, `start${mid} newEnd`)
    expect(
      old
        .filter((s) => s.hot)
        .map((s) => s.text)
        .join("")
    ).toContain("oldEnd")
    expect(
      next
        .filter((s) => s.hot)
        .map((s) => s.text)
        .join("")
    ).toContain("newEnd")
  })
})

describe("mixColor", () => {
  it("mixes hex colours toward black and white", () => {
    expect(mixColor("#ff0000", "black", 0.5)).toBe("#800000")
    expect(mixColor("#000000", "white", 0.5)).toBe("#808080")
  })
  it("accepts rgb() and rejects ANSI names", () => {
    expect(mixColor("rgb(255, 0, 0)", "black", 0.5)).toBe("#800000")
    expect(mixColor("green", "black", 0.5)).toBeUndefined()
    expect(mixColor(undefined, "black", 0.5)).toBeUndefined()
  })
})

describe("preparePatchLines · unified", () => {
  it("renders dual number gutters, signs and hunk separator bars", () => {
    const { lines, hunkRows } = preparePatchLines([{ body: MODIFIED }], opts())
    const plain = plains(lines)
    expect(hunkRows).toHaveLength(1)
    expect(plain[hunkRows[0]]).toContain("@@ -1,4 +1,5 @@")
    expect(plain[hunkRows[0]]).toContain("function main()")
    expect(plain[hunkRows[0] + 1]).toBe(" 1  1   const a = 1")
    expect(plain[hunkRows[0] + 2]).toBe(" 2    - const b = 2")
    expect(plain[hunkRows[0] + 3]).toBe("    2 + const b = 3")
  })

  it("emphasises changed tokens with bold+underline on the ANSI palette", () => {
    const { lines } = preparePatchLines([{ body: MODIFIED }], opts())
    const delRow = lines.find((line) => line.plain.includes("const b = 2"))!
    const hot = delRow.spans.filter((s) => s.text === "2")
    expect(hot[0]).toMatchObject({ bold: true, underline: true })
  })

  it("paints tinted backgrounds when the palette carries hex colours", () => {
    const palette = expandPalette({
      accent: "#d77757",
      secondary: "#b18cf2",
      info: "#6cb6ff",
      success: "#4eba65",
      warning: "#e0af68",
      danger: "#ff6b80",
      muted: "#8b8b8b",
      text: "#e6e6e6",
    })
    const { lines } = preparePatchLines([{ body: MODIFIED }], opts({ palette }))
    const addRow = lines.find((line) => line.plain.includes("const b = 3"))!
    expect(addRow.spans.every((s) => s.background?.startsWith("#"))).toBe(true)
    // The row tint stays faint — GitHub's ≈20% mix, not the raw role colour.
    expect(addRow.spans[0].background).toBe("#102514")
    const hot = addRow.spans.find((s) => s.text === "3")
    expect(hot?.bold).toBe(true)
    expect(hot?.background).not.toBe(addRow.spans[0].background)
  })

  it("renders a labelled section header only for file status or scope", () => {
    const plain = plains(preparePatchLines([{ body: MODIFIED }], opts()).lines)
    expect(plain[0]).toContain("@@")
    // A lone labelled section shows only its status — the label is noise.
    const labelled = plains(
      preparePatchLines([{ body: NEW_FILE, label: "unstaged" }], opts()).lines
    )
    expect(labelled[0]).not.toContain("unstaged")
    expect(labelled[0]).toContain("statusNew")
    const twoSections = plains(
      preparePatchLines(
        [
          { body: MODIFIED, label: "staged" },
          { body: NEW_FILE, label: "unstaged" },
        ],
        opts()
      ).lines
    )
    expect(twoSections[0]).toContain("staged")
    expect(twoSections.some((p) => p.includes("unstaged"))).toBe(true)
  })

  it("surfaces rename, mode and binary chips on the section header", () => {
    const header = (body: string) => plains(preparePatchLines([{ body }], opts()).lines)[0]
    expect(header(`diff --git a/o b/n\nrename from o\nrename to n\n`)).toContain(
      "statusRenamedFrom(from=o)"
    )
    expect(header(`diff --git a/s b/s\nold mode 100644\nnew mode 100755\n`)).toContain(
      "modeChange(from=100644,to=100755)"
    )
    expect(header(`diff --git a/b b/b\nBinary files a/b and b/b differ\n`)).toContain("binary")
  })

  it("wraps long code lines with a hanging indent aligned under the code", () => {
    const longLine = "x".repeat(120)
    const { lines } = preparePatchLines(
      [{ body: `diff --git a/f b/f\n@@ -1 +1,2 @@\n ctx\n+${longLine}\n` }],
      opts({ width: 40 })
    )
    const first = lines.findIndex((line) => line.plain.includes("xxx"))
    const continuations = lines.slice(first + 1).filter((line) => line.plain.includes("x"))
    expect(continuations.length).toBeGreaterThan(0)
    expect(continuations.every((line) => line.plain.length <= 40)).toBe(true)
    // Continuation rows start under the code column, not under the numbers.
    expect(continuations.every((line) => line.plain.startsWith("        "))).toBe(true)
  })

  it("keeps preamble and non-patch bodies visible", () => {
    const { lines } = preparePatchLines([{ body: "+staged\nsome note" }], opts())
    expect(plains(lines)).toEqual(["+staged", "some note"])
  })

  it("renders the no-newline marker as a meta row", () => {
    const { lines } = preparePatchLines(
      [{ body: `diff --git a/f b/f\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n` }],
      opts()
    )
    expect(plains(lines).some((p) => p.includes("\\ No newline at end of file"))).toBe(true)
  })
})

describe("preparePatchLines · split", () => {
  const splitOpts = () => opts({ layout: "split", width: 80 })

  it("pairs del and add rows across a │ separator", () => {
    const { lines } = preparePatchLines([{ body: MODIFIED }], splitOpts())
    const plain = plains(lines)
    const paired = plain.find((p) => p.includes("const b"))
    expect(paired).toContain(" │ ")
    expect(paired).toMatch(/2\s+- const b = 2\s+│\s+2 \+ const b = 3/)
  })

  it("shows context on both sides and blanks the missing side", () => {
    const { lines } = preparePatchLines(
      [{ body: `diff --git a/f b/f\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra\n` }],
      splitOpts()
    )
    const plain = plains(lines)
    const contextRow = plain.find((p) => p.includes("keep"))
    expect(contextRow).toMatch(/1\s+  keep\s+│\s+1\s+  keep/)
    const extraRow = plain.find((p) => p.includes("extra"))
    expect(extraRow).toMatch(/│\s+3 \+ extra/)
    expect(extraRow!.split("│")[0].trim()).toBe("")
  })

  it("truncates over-wide cells with an ellipsis instead of wrapping", () => {
    const { lines } = preparePatchLines(
      [{ body: `diff --git a/f b/f\n@@ -1 +1,2 @@\n ctx\n+${"y".repeat(200)}\n` }],
      opts({ layout: "split", width: 40 })
    )
    const row = plains(lines).find((p) => p.includes("y"))
    expect(row).toContain("…")
    expect(row!.length).toBeLessThanOrEqual(40)
  })

  it("keeps hunk rows full width in split mode", () => {
    const { lines, hunkRows } = preparePatchLines([{ body: MODIFIED }], splitOpts())
    expect(plains(lines)[hunkRows[0]]).toContain("@@ -1,4 +1,5 @@")
    expect(plains(lines)[hunkRows[0]]).not.toContain("│")
  })
})
