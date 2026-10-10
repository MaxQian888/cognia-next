/** @jest-environment jsdom */
import {
  isEditableTarget,
  resolveFilesKey,
  type FilesKeyInput,
  type FilesKeyState,
} from "./keyboard"

const key = (k: string, extra: Partial<FilesKeyInput> = {}): FilesKeyInput => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  editable: false,
  ...extra,
})

const state = (extra: Partial<FilesKeyState> = {}): FilesKeyState => ({
  order: ["a", "b", "c"],
  selected: new Set(),
  current: null,
  previewOpen: false,
  ...extra,
})

describe("resolveFilesKey", () => {
  it("selects all with ⌘A or Ctrl+A", () => {
    expect(resolveFilesKey(key("a", { metaKey: true }), state())).toEqual({ type: "select-all" })
    expect(resolveFilesKey(key("A", { ctrlKey: true }), state())).toEqual({ type: "select-all" })
    expect(resolveFilesKey(key("a", { metaKey: true }), state({ order: [] }))).toEqual({
      type: "none",
    })
  })

  it("deletes the selection in view order, or the focused item", () => {
    expect(resolveFilesKey(key("Delete"), state({ selected: new Set(["c", "a"]) }))).toEqual({
      type: "delete",
      keys: ["a", "c"],
    })
    expect(resolveFilesKey(key("Backspace"), state({ current: "b" }))).toEqual({
      type: "delete",
      keys: ["b"],
    })
    expect(resolveFilesKey(key("Delete"), state())).toEqual({ type: "none" })
  })

  it("renames only a single target", () => {
    expect(resolveFilesKey(key("F2"), state({ current: "b" }))).toEqual({
      type: "rename",
      key: "b",
    })
    expect(resolveFilesKey(key("F2"), state({ selected: new Set(["a", "b"]) }))).toEqual({
      type: "none",
    })
  })

  it("moves between items and clamps at the ends", () => {
    expect(resolveFilesKey(key("ArrowDown"), state())).toEqual({
      type: "move",
      key: "a",
      extend: false,
    })
    expect(resolveFilesKey(key("ArrowUp"), state())).toEqual({
      type: "move",
      key: "c",
      extend: false,
    })
    expect(resolveFilesKey(key("ArrowDown", { shiftKey: true }), state({ current: "b" }))).toEqual({
      type: "move",
      key: "c",
      extend: true,
    })
    expect(resolveFilesKey(key("ArrowDown"), state({ current: "c" }))).toEqual({
      type: "move",
      key: "c",
      extend: false,
    })
    expect(resolveFilesKey(key("ArrowUp"), state({ order: [] }))).toEqual({ type: "none" })
  })

  it("Esc clears the selection first, then closes the preview", () => {
    expect(
      resolveFilesKey(key("Escape"), state({ selected: new Set(["a"]), previewOpen: true }))
    ).toEqual({
      type: "clear-selection",
    })
    expect(resolveFilesKey(key("Escape"), state({ previewOpen: true }))).toEqual({
      type: "close-preview",
    })
    expect(resolveFilesKey(key("Escape"), state())).toEqual({ type: "none" })
  })

  it("never acts on typing, Alt chords or other modified keys", () => {
    expect(resolveFilesKey(key("Delete", { editable: true }), state({ current: "a" }))).toEqual({
      type: "none",
    })
    expect(resolveFilesKey(key("ArrowDown", { altKey: true }), state())).toEqual({ type: "none" })
    expect(resolveFilesKey(key("Delete", { metaKey: true }), state({ current: "a" }))).toEqual({
      type: "none",
    })
    expect(resolveFilesKey(key("x"), state({ current: "a" }))).toEqual({ type: "none" })
  })
})

describe("isEditableTarget", () => {
  it("recognises text fields, menus and dialogs", () => {
    document.body.innerHTML = `
      <input id="i" /><div role="menu"><button id="m"></button></div><div id="row" tabindex="0"></div>`
    expect(isEditableTarget(document.getElementById("i"))).toBe(true)
    expect(isEditableTarget(document.getElementById("m"))).toBe(true)
    expect(isEditableTarget(document.getElementById("row"))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
