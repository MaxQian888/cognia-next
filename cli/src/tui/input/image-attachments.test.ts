/** @jest-environment node */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { expandPastes } from "@/lib/paste-collapse"
import { extractFileRefs } from "../../agent/attachments/classify"
import {
  atomicImageEdit,
  collapseImageRefs,
  createImagePaste,
  expandComposerPastes,
  imagePlaceholderAt,
  listImageAttachments,
  pastedImagePaths,
  removeImagePlaceholders,
} from "./image-attachments"

describe("image attachment paste recognition", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cognia-image-paste-"))
    for (const file of ["a.png", "Screen Shot.PNG", "it's.png", 'quoted".png', "note.txt"])
      writeFileSync(path.join(root, file), "fixture")
    mkdirSync(path.join(root, "folder.png"))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("normalizes absolute, relative, quoted and shell escaped paths preserving duplicates", () => {
    expect(pastedImagePaths(`${root}/a.png './Screen Shot.PNG' Screen\\ Shot.PNG`, root)).toEqual([
      path.join(root, "a.png"),
      path.join(root, "Screen Shot.PNG"),
      path.join(root, "Screen Shot.PNG"),
    ])
    expect(pastedImagePaths('"it\'s.png"', root)).toEqual([path.join(root, "it's.png")])
  })

  it("decodes a file URL containing spaces", () => {
    expect(pastedImagePaths(pathToFileURL(path.join(root, "Screen Shot.PNG")).href, root)).toEqual([
      path.join(root, "Screen Shot.PNG"),
    ])
  })

  it.each([
    "",
    "hello a.png",
    "a.png note.txt",
    "folder.png",
    "missing.png",
    "https://example.com/a.png",
    "file://remote-host/a.png",
    "'a.png",
    "a.png\\",
    "''",
    "'quoted\".png'",
  ])("does not swallow prose or unsupported input: %s", (value) => {
    expect(pastedImagePaths(value, root)).toBeNull()
  })
})

describe("compact image labels", () => {
  it("expands image and generic paste placeholders once without rescanning inserted payloads", () => {
    const pastes = {
      "[Image 1]": '@"/tmp/[Image 2].png"',
      "[Image 2]": '@"/tmp/b.png"',
      "[Pasted 10 lines #3]": "literal [Image 1] and [Image 2]",
      "[Pasted 10 lines #log0]": "verbatim $&",
    }
    expect(
      expandComposerPastes(
        "[Image 1] [Image 2] [Pasted 10 lines #3] [Pasted 10 lines #log0]",
        pastes
      )
    ).toBe('@"/tmp/[Image 2].png" @"/tmp/b.png" literal [Image 1] and [Image 2] verbatim $&')
    expect(expandComposerPastes("[Image 9]", pastes)).toBe("[Image 9]")
    expect(expandComposerPastes("plain", {})).toBe("plain")
  })
  it("compacts only explicit image references without requiring files and round trips spelling", () => {
    const source =
      'compare @./missing.png with @"/Screen Shot.PNG", @note.txt @skill:guide.png [Image 1]'
    const result = collapseImageRefs(source)
    expect(result.text).toBe(
      "compare [Image 2] with [Image 3], @note.txt @skill:guide.png [Image 1]"
    )
    expect(expandPastes(result.text, result.pastes)).toBe(source)
    expect(collapseImageRefs("a.png and https://example.com/x.png")).toEqual({
      text: "a.png and https://example.com/x.png",
      pastes: {},
    })
  })

  it("preserves prior mappings and allocates distinct labels for repeated refs", () => {
    const old = { "[Image 1]": "@old.png" }
    const result = collapseImageRefs("@a.png @a.png", old)
    expect(result.text).toBe("[Image 2] [Image 3]")
    expect(result.pastes).toEqual({ ...old, "[Image 2]": "@a.png", "[Image 3]": "@a.png" })
    expect(old).toEqual({ "[Image 1]": "@old.png" })
  })
  it("keeps duplicate attachments separate and avoids mapped and literal label collisions", () => {
    const old = { "[Image 1]": '@"/a.png"', "[Pasted 9 lines #0]": "body" }
    const result = createImagePaste(["/Screen Shot.png", "/Screen Shot.png"], old, "[Image 2]")
    expect(result).toEqual({
      text: "[Image 3] [Image 4]",
      pastes: { "[Image 3]": '@"/Screen Shot.png"', "[Image 4]": '@"/Screen Shot.png"' },
    })
    expect(extractFileRefs(expandPastes(result.text, { ...old, ...result.pastes }))).toEqual([
      "/Screen Shot.png",
      "/Screen Shot.png",
    ])
    expect(old).toEqual({ "[Image 1]": '@"/a.png"', "[Pasted 9 lines #0]": "body" })
  })

  it("finds exact inline logical offsets without consuming adjacent characters", () => {
    const text = "中🙂 [Image 1] then [Image 2]"
    const map = { "[Image 1]": '@"/a.png"', "[Image 2]": '@"/b.png"' }
    expect(imagePlaceholderAt(text, 4, map)).toEqual({
      label: "[Image 1]",
      path: "/a.png",
      start: 4,
      end: 13,
    })
    expect(imagePlaceholderAt(text, 12, map)?.path).toBe("/a.png")
    expect(imagePlaceholderAt(text, 13, map)).toBeUndefined()
    expect(imagePlaceholderAt(text, 19, map)?.path).toBe("/b.png")
    expect(imagePlaceholderAt(text, -1, map)).toBeUndefined()
    expect(imagePlaceholderAt("[Image 1]", 0, {})).toBeUndefined()
    expect(imagePlaceholderAt("[Image 1]", 0, { "[Image 1]": "arbitrary text" })).toBeUndefined()
    expect(imagePlaceholderAt("[Image 1]", 0, { "[Image 1]": "@a.txt" })).toBeUndefined()
  })

  it("rejects unrepresentable paths instead of silently corrupting attachment references", () => {
    expect(() => createImagePaste(['/quoted".png'], {}, "")).toThrow(/cannot be represented/)
    expect(createImagePaste([], {}, "")).toEqual({ text: "", pastes: {} })
  })
})

describe("atomic image editing", () => {
  const pastes = { "[Image 1]": "@/a.png" }
  const buffer = (cursorCol: number) => ({
    lines: ["first", "x[Image 1] y"],
    cursorRow: 1,
    cursorCol,
  })
  it("snaps interior cursors from vertical navigation to the nearest edge before typing", () => {
    expect(atomicImageEdit(buffer(3), { op: "insert", text: "中" }, pastes)).toEqual({
      lines: ["first", "x中[Image 1] y"],
      cursorRow: 1,
      cursorCol: 2,
    })
    expect(atomicImageEdit(buffer(8), { op: "insert", text: "!" }, pastes)).toEqual({
      lines: ["first", "x[Image 1]! y"],
      cursorRow: 1,
      cursorCol: 11,
    })
    expect(atomicImageEdit(buffer(8), { op: "newline" }, pastes)).toEqual({
      lines: ["first", "x[Image 1]", " y"],
      cursorRow: 2,
      cursorCol: 0,
    })
    expect(atomicImageEdit(buffer(3), { op: "newline" }, pastes)?.lines).toEqual([
      "first",
      "x",
      "[Image 1] y",
    ])
  })
  it("line kills remove an entire label when the cursor lies inside it", () => {
    expect(atomicImageEdit(buffer(5), { op: "kill-to-start" }, pastes)).toEqual({
      lines: ["first", " y"],
      cursorRow: 1,
      cursorCol: 0,
    })
    expect(atomicImageEdit(buffer(5), { op: "kill-to-end" }, pastes)).toEqual({
      lines: ["first", "x"],
      cursorRow: 1,
      cursorCol: 1,
    })
  })
  it.each([2, 5, 10])("backspace removes the full label at column %s", (col) => {
    expect(atomicImageEdit(buffer(col), { op: "backspace" }, pastes)).toEqual({
      lines: ["first", "x y"],
      cursorRow: 1,
      cursorCol: 1,
    })
  })
  it("jumps across labels left and right including an interior cursor", () => {
    expect(atomicImageEdit(buffer(10), { op: "move", dir: "left" }, pastes)?.cursorCol).toBe(1)
    expect(atomicImageEdit(buffer(5), { op: "move", dir: "left" }, pastes)?.cursorCol).toBe(1)
    expect(atomicImageEdit(buffer(1), { op: "move", dir: "right" }, pastes)?.cursorCol).toBe(10)
    expect(atomicImageEdit(buffer(5), { op: "move", dir: "word-right" }, pastes)?.cursorCol).toBe(
      10
    )
    expect(atomicImageEdit(buffer(10), { op: "move", dir: "word-left" }, pastes)?.cursorCol).toBe(1)
  })
  it("word deletion includes a whole label when deleting through trailing whitespace", () => {
    expect(atomicImageEdit(buffer(11), { op: "delete-word" }, pastes)).toEqual({
      lines: ["first", "xy"],
      cursorRow: 1,
      cursorCol: 1,
    })
    expect(atomicImageEdit(buffer(5), { op: "delete-word" }, pastes)?.lines[1]).toBe("x y")
  })
  it("leaves ordinary editing and unmapped label text to the buffer implementation", () => {
    expect(atomicImageEdit(buffer(1), { op: "backspace" }, pastes)).toBeUndefined()
    expect(atomicImageEdit(buffer(10), { op: "move", dir: "right" }, pastes)).toBeUndefined()
    expect(atomicImageEdit(buffer(5), { op: "move", dir: "up" }, pastes)).toBeUndefined()
    expect(atomicImageEdit(buffer(1), { op: "insert", text: "hello" }, pastes)).toBeUndefined()
    expect(atomicImageEdit(buffer(5), { op: "backspace" }, {})).toBeUndefined()
    expect(atomicImageEdit(buffer(0), { op: "delete-word" }, pastes)).toBeUndefined()
  })
})

describe("listImageAttachments", () => {
  const pastes = {
    "[Image 1]": '@"/a.png"',
    "[Image 2]": '@"/b.png"',
    "[Pasted 3 lines #0]": "body [Image 9]",
  }
  it("lists live labels in reading order with resolved paths and rows", () => {
    expect(listImageAttachments(["first [Image 1]", "second [Image 2] last"], pastes)).toEqual([
      { label: "[Image 1]", path: "/a.png", row: 0 },
      { label: "[Image 2]", path: "/b.png", row: 1 },
    ])
  })
  it("ignores labels without a mapping, non-image mappings, and duplicates", () => {
    const lines = ["[Image 1] [Image 3] [Image 1] [Pasted 3 lines #0]"]
    expect(listImageAttachments(lines, pastes)).toEqual([
      { label: "[Image 1]", path: "/a.png", row: 0 },
    ])
    expect(listImageAttachments(lines, {})).toEqual([])
    expect(listImageAttachments(["[Image 1]"], { "[Image 1]": "@note.txt" })).toEqual([])
  })
})

describe("removeImagePlaceholders", () => {
  const pastes = {
    "[Image 1]": '@"/a.png"',
    "[Image 2]": '@"/b.png"',
    "[Image 3]": '@"/c.png"',
  }
  const buf = (lines: string[], cursorRow = 0, cursorCol = 0) => ({
    lines,
    cursorRow,
    cursorCol,
  })

  it("removes one label mid-line and joins the surrounding words", () => {
    expect(removeImagePlaceholders(buf(["a [Image 1] b"], 0, 13), ["[Image 1]"], pastes)).toEqual({
      lines: ["a b"],
      cursorRow: 0,
      cursorCol: 3,
    })
  })
  it("eats the leading space when the label ends the line", () => {
    expect(removeImagePlaceholders(buf(["x [Image 1]"]), ["[Image 1]"], pastes)?.lines).toEqual([
      "x",
    ])
  })
  it("removes several labels across lines, keeping unrelated text", () => {
    const result = removeImagePlaceholders(
      buf(["[Image 1] keep [Image 2]", "tail [Image 3]"], 1, 6),
      ["[Image 1]", "[Image 2]", "[Image 3]"],
      pastes
    )
    expect(result?.lines).toEqual(["keep", "tail"])
    expect(result?.cursorRow).toBe(1)
    expect(result?.cursorCol).toBe(4)
  })
  it("collapses lines that held only labels and keeps the buffer non-empty", () => {
    const result = removeImagePlaceholders(
      buf(["intro", "[Image 1]", "outro"], 1, 4),
      ["[Image 1]"],
      pastes
    )
    expect(result?.lines).toEqual(["intro", "outro"])
    expect(result?.cursorRow).toBe(1)
    expect(result?.cursorCol).toBe(0)
    const single = removeImagePlaceholders(buf(["[Image 1]"]), ["[Image 1]"], pastes)
    expect(single?.lines).toEqual([""])
  })
  it("moves the cursor to the label start when it sat inside the removed span", () => {
    expect(
      removeImagePlaceholders(buf(["a [Image 1] b"], 0, 7), ["[Image 1]"], pastes)?.cursorCol
    ).toBe(2)
  })
  it("shifts a cursor that sat after the removed label", () => {
    expect(removeImagePlaceholders(buf(["[Image 1] tail"], 0, 14), ["[Image 1]"], pastes)).toEqual({
      lines: ["tail"],
      cursorRow: 0,
      cursorCol: 4,
    })
  })
  it("returns undefined for unmapped, non-image or absent labels — buffer untouched", () => {
    const b = buf(["a [Image 1] b"], 0, 5)
    expect(removeImagePlaceholders(b, ["[Image 9]"], pastes)).toBeUndefined()
    expect(removeImagePlaceholders(b, ["[Image 1]"], {})).toBeUndefined()
    expect(removeImagePlaceholders(b, ["[Image 1]"], { "[Image 1]": "@note.txt" })).toBeUndefined()
    expect(removeImagePlaceholders(b, [], pastes)).toBeUndefined()
    expect(b.lines).toEqual(["a [Image 1] b"])
  })
  it("keeps the paste map intact so undo still resolves the label", () => {
    removeImagePlaceholders(buf(["[Image 1]"]), ["[Image 1]"], pastes)
    expect(pastes["[Image 1]"]).toBe('@"/a.png"')
  })
})
