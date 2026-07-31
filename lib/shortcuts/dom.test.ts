/** @jest-environment jsdom */

import { isEditableTarget, isInsideEditorSurface } from "./dom"

function el(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  return node
}

describe("isEditableTarget", () => {
  it("returns false for a null target", () => {
    expect(isEditableTarget(null)).toBe(false)
  })

  it("returns false for a non-HTMLElement EventTarget", () => {
    expect(isEditableTarget(window)).toBe(false)
  })

  it("returns false for an ordinary non-editable element", () => {
    expect(isEditableTarget(el("div"))).toBe(false)
    expect(isEditableTarget(el("button"))).toBe(false)
  })

  it("treats form controls as editable", () => {
    expect(isEditableTarget(el("input"))).toBe(true)
    expect(isEditableTarget(el("textarea"))).toBe(true)
    expect(isEditableTarget(el("select"))).toBe(true)
  })

  it("treats contenteditable via attribute as editable (jsdom-safe path)", () => {
    // jsdom does not derive the `isContentEditable` getter from the attribute,
    // so the attribute fallback is what actually fires here — mirrors the
    // terminal-toggle guard we are consolidating.
    expect(isEditableTarget(el("div", { contenteditable: "true" }))).toBe(true)
    expect(isEditableTarget(el("div", { contenteditable: "" }))).toBe(true)
  })

  it('does not treat contenteditable="false" as editable', () => {
    expect(isEditableTarget(el("div", { contenteditable: "false" }))).toBe(false)
  })

  it("honours the isContentEditable getter when the environment sets it", () => {
    const node = el("div")
    Object.defineProperty(node, "isContentEditable", { value: true, configurable: true })
    expect(isEditableTarget(node)).toBe(true)
  })
})

describe("isInsideEditorSurface", () => {
  it("returns false for a null / non-HTMLElement target", () => {
    expect(isInsideEditorSurface(null, [".monaco-editor"])).toBe(false)
    expect(isInsideEditorSurface(window, [".monaco-editor"])).toBe(false)
  })

  it("returns true for a node inside a matching editor container", () => {
    const editor = el("div", { class: "monaco-editor" })
    const inner = el("span")
    editor.appendChild(inner)
    document.body.appendChild(editor)
    expect(isInsideEditorSurface(inner, [".monaco-editor"])).toBe(true)
    document.body.removeChild(editor)
  })

  it("matches any of several selectors", () => {
    const editor = el("div", { class: "cm-editor" })
    const inner = el("span")
    editor.appendChild(inner)
    document.body.appendChild(editor)
    expect(isInsideEditorSurface(inner, [".monaco-editor", ".cm-editor"])).toBe(true)
    document.body.removeChild(editor)
  })

  it("returns false for a node outside every selector", () => {
    const inner = el("span")
    document.body.appendChild(inner)
    expect(isInsideEditorSurface(inner, [".monaco-editor", ".cm-editor"])).toBe(false)
    document.body.removeChild(inner)
  })
})
