/**
 * @jest-environment node
 */
import { resolveBunTextUtils, stringWidth, truncateToWidth } from "./width"

describe("resolveBunTextUtils", () => {
  it("selects only callable Bun capabilities", () => {
    const nativeWidth = jest.fn(() => 7)
    const resolved = resolveBunTextUtils({
      stringWidth: nativeWidth,
      sliceAnsi: "not-callable" as never,
    })

    expect(resolved?.stringWidth?.("content")).toBe(7)
    expect(nativeWidth).toHaveBeenCalledWith("content")
    expect(resolved?.sliceAnsi).toBeUndefined()
    expect(resolveBunTextUtils(undefined)).toBeUndefined()
  })
})

describe("stringWidth", () => {
  it("counts ASCII as one column each", () => {
    expect(stringWidth("hello")).toBe(5)
    expect(stringWidth("")).toBe(0)
  })

  it("counts CJK ideographs as two columns each", () => {
    expect(stringWidth("你好")).toBe(4)
    expect(stringWidth("模型")).toBe(4)
  })

  it("mixes ASCII and CJK correctly", () => {
    // "模型: ok" → 2+2 + ": ok" (4) = 8.
    expect(stringWidth("模型: ok")).toBe(8)
  })

  it("counts Hangul and Kana as wide", () => {
    expect(stringWidth("한")).toBe(2)
    expect(stringWidth("あ")).toBe(2)
  })

  it("counts fullwidth forms as wide", () => {
    expect(stringWidth("Ａ")).toBe(2) // fullwidth Latin A
  })

  it("ignores zero-width combining marks", () => {
    // 'e' + combining acute accent renders as one column.
    expect(stringWidth("é")).toBe(1)
    expect(stringWidth("a‍b")).toBe(2) // ZWJ contributes nothing
  })

  it("counts astral-plane ideographs and emoji as wide", () => {
    expect(stringWidth("\u{20000}")).toBe(2) // CJK Ext B
    expect(stringWidth("🚀")).toBe(2)
    expect(stringWidth("👩‍💻")).toBe(2)
    expect(stringWidth("☝️")).toBe(2) // variation-selector emoji presentation
    expect(stringWidth("1️⃣")).toBe(2) // keycap sequence
  })

  it("ignores ANSI and OSC control sequences", () => {
    expect(stringWidth("\x1b[31m中\x1b[0m")).toBe(2)
    expect(stringWidth("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe(4)
  })
})

describe("truncateToWidth", () => {
  it("returns the text unchanged when it fits", () => {
    expect(truncateToWidth("hello", 10)).toBe("hello")
    expect(truncateToWidth("hello", 5)).toBe("hello")
  })

  it("cuts to width with an ellipsis", () => {
    expect(truncateToWidth("hello world", 6)).toBe("hello…")
  })

  it("is display-width aware (CJK counts as two columns)", () => {
    expect(truncateToWidth("模型名称", 3)).toBe("模…")
  })

  it("collapses to a bare ellipsis when max <= 1", () => {
    expect(truncateToWidth("hello", 1)).toBe("…")
    expect(truncateToWidth("hello", 0)).toBe("…")
  })
})
