import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN, wrapUntrusted } from "./untrusted"

describe("wrapUntrusted", () => {
  it("fences content between untrusted tags on their own lines", () => {
    expect(wrapUntrusted("hello")).toBe("<untrusted_content>\nhello\n</untrusted_content>")
  })

  it("fences empty content (an empty untrusted block is still meaningful)", () => {
    expect(wrapUntrusted("")).toBe(`${UNTRUSTED_OPEN}\n\n${UNTRUSTED_CLOSE}`)
  })

  it("does not escape or strip angle brackets in the body", () => {
    const body = "see <b>bold</b> and </untrusted_content> literal"
    const wrapped = wrapUntrusted(body)
    expect(wrapped.startsWith(`${UNTRUSTED_OPEN}\n`)).toBe(true)
    expect(wrapped.endsWith(`\n${UNTRUSTED_CLOSE}`)).toBe(true)
    expect(wrapped).toContain(body)
  })

  it("preserves multi-line content verbatim", () => {
    const body = "line1\nline2"
    expect(wrapUntrusted(body)).toBe(`${UNTRUSTED_OPEN}\n${body}\n${UNTRUSTED_CLOSE}`)
  })

  it("exposes the fence tags as constants", () => {
    expect(UNTRUSTED_OPEN).toBe("<untrusted_content>")
    expect(UNTRUSTED_CLOSE).toBe("</untrusted_content>")
  })
})
