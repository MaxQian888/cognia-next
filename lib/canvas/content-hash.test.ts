import { hashCanvasContent } from "./content-hash"

describe("hashCanvasContent", () => {
  it("is stable for the same content", () => {
    expect(hashCanvasContent("hello world")).toBe(hashCanvasContent("hello world"))
  })

  it("changes for a one-character edit", () => {
    expect(hashCanvasContent("hello world")).not.toBe(hashCanvasContent("hello worlD"))
  })

  it("distinguishes a transposition", () => {
    // A length-only or sum-only fingerprint would call these equal, and a
    // proposal diffed from one would apply against the other.
    expect(hashCanvasContent("ab")).not.toBe(hashCanvasContent("ba"))
  })

  it("distinguishes content that differs only in whitespace", () => {
    expect(hashCanvasContent("a\nb")).not.toBe(hashCanvasContent("a\n\nb"))
    expect(hashCanvasContent("a b")).not.toBe(hashCanvasContent("a  b"))
  })

  it("handles the empty document", () => {
    expect(hashCanvasContent("")).toBe(hashCanvasContent(""))
    expect(hashCanvasContent("")).not.toBe(hashCanvasContent(" "))
  })

  it("stays in 32-bit space over a long document", () => {
    // A plain `*` instead of `Math.imul` overflows into a float here and stops
    // being FNV, which collapses the output range.
    const long = "x".repeat(200_000)
    const hash = hashCanvasContent(long)
    expect(hash).toMatch(/^[0-9a-z]+\.[0-9a-z]+$/)
    expect(hashCanvasContent(`${long}y`)).not.toBe(hash)
  })

  it("folds in the length", () => {
    expect(hashCanvasContent("abc").split(".")[1]).toBe((3).toString(36))
  })

  it("handles non-ASCII content", () => {
    expect(hashCanvasContent("文档")).not.toBe(hashCanvasContent("文档 "))
    expect(hashCanvasContent("文档")).toBe(hashCanvasContent("文档"))
  })
})
