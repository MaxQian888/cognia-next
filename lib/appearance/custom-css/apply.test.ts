/**
 * @jest-environment jsdom
 */

import { __INTERNALS__, applyUserCss, removeUserCss, sanitizeUserCss } from "./apply"

beforeEach(() => {
  document.head.innerHTML = ""
})

describe("sanitizeUserCss", () => {
  it("strips http(s) @import statements", () => {
    const out = sanitizeUserCss(`@import url("https://evil.example/x.css");\nbody { color: red }`)
    expect(out.css).not.toMatch(/@import/)
    expect(out.css).toMatch(/body \{ color: red \}/)
    expect(out.removedCount).toBe(1)
  })

  it("strips protocol-relative @import statements", () => {
    const out = sanitizeUserCss(`@import "//evil.example/x.css";`)
    expect(out.css).toBe("")
    expect(out.removedCount).toBe(1)
  })

  it("strips remote url(...) references but keeps the function open", () => {
    const out = sanitizeUserCss(`body { background: url("https://x.example/bg.png") }`)
    expect(out.css).toMatch(/background: url\(/)
    expect(out.css).not.toContain("https://")
    expect(out.removedCount).toBe(1)
  })

  it("leaves data: and local urls untouched", () => {
    const css = `body { background: url(data:image/png;base64,AA) } a { background: url('/local.png') }`
    const out = sanitizeUserCss(css)
    expect(out.css).toBe(css)
    expect(out.removedCount).toBe(0)
  })
})

describe("applyUserCss", () => {
  it("creates the style tag on first call and writes sanitized css", () => {
    const before = document.getElementById(__INTERNALS__.STYLE_ELEMENT_ID)
    expect(before).toBeNull()
    const res = applyUserCss(`body { color: lime }`, true)
    const tag = document.getElementById(__INTERNALS__.STYLE_ELEMENT_ID)
    expect(tag).not.toBeNull()
    expect(tag?.textContent).toBe("body { color: lime }")
    expect(res.removedCount).toBe(0)
  })

  it("updates the existing tag instead of duplicating it", () => {
    applyUserCss(`a { color: red }`, true)
    applyUserCss(`a { color: blue }`, true)
    const tags = document.querySelectorAll(`#${__INTERNALS__.STYLE_ELEMENT_ID}`)
    expect(tags.length).toBe(1)
    expect(tags[0].textContent).toBe("a { color: blue }")
  })

  it("avoids overwriting textContent when the css is unchanged", () => {
    applyUserCss(`a { color: red }`, true)
    const tag = document.getElementById(__INTERNALS__.STYLE_ELEMENT_ID) as HTMLStyleElement
    const spy = jest.spyOn(tag, "textContent", "set")
    applyUserCss(`a { color: red }`, true)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it("removes the tag when disabled", () => {
    applyUserCss(`a { color: red }`, true)
    expect(document.getElementById(__INTERNALS__.STYLE_ELEMENT_ID)).not.toBeNull()
    applyUserCss(`a { color: red }`, false)
    expect(document.getElementById(__INTERNALS__.STYLE_ELEMENT_ID)).toBeNull()
  })

  it("removes the tag when the css is whitespace-only", () => {
    applyUserCss(`a {}`, true)
    expect(document.getElementById(__INTERNALS__.STYLE_ELEMENT_ID)).not.toBeNull()
    applyUserCss(`   `, true)
    expect(document.getElementById(__INTERNALS__.STYLE_ELEMENT_ID)).toBeNull()
  })

  it("returns the sanitized css and removed count", () => {
    const res = applyUserCss(`@import url("https://evil/x.css"); a { color: red }`, true)
    expect(res.removedCount).toBe(1)
    expect(res.css).not.toContain("@import")
  })

  it("is a no-op without a document (SSR)", () => {
    const originalDocument = globalThis.document
    // Simulate SSR by removing the JSDOM document. The cast keeps TS happy
    // because `document` on the cast type is optional.
    delete (globalThis as { document?: Document }).document
    const res = applyUserCss(`a { color: red }`, true)
    expect(res.removedCount).toBe(0)
    expect(res.css).toBe(`a { color: red }`)
    globalThis.document = originalDocument
  })
})

describe("removeUserCss", () => {
  it("removes the tag if present", () => {
    applyUserCss(`a {}`, true)
    expect(document.getElementById(__INTERNALS__.STYLE_ELEMENT_ID)).not.toBeNull()
    removeUserCss()
    expect(document.getElementById(__INTERNALS__.STYLE_ELEMENT_ID)).toBeNull()
  })
  it("is a no-op when the tag is missing", () => {
    expect(() => removeUserCss()).not.toThrow()
  })
  it("is a no-op without a document", () => {
    const originalDocument = globalThis.document
    // Simulate SSR by removing the JSDOM document. The cast keeps TS happy
    // because `document` on the cast type is optional.
    delete (globalThis as { document?: Document }).document
    expect(() => removeUserCss()).not.toThrow()
    globalThis.document = originalDocument
  })
})
