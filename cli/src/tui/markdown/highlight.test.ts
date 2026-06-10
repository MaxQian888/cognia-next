/**
 * @jest-environment node
 */
import { highlightCode, stripAnsi } from "./highlight"

describe("highlightCode", () => {
  it("returns '' for empty code", () => {
    expect(highlightCode("")).toBe("")
  })

  it("preserves the code text after stripping color escapes", () => {
    const out = highlightCode("const x = 1", "js")
    expect(stripAnsi(out)).toBe("const x = 1")
  })

  it("falls back to plain text for an unsupported language", () => {
    const out = highlightCode("plain words", "not-a-real-lang")
    expect(stripAnsi(out)).toBe("plain words")
  })

  it("auto-detects when no language is given without throwing", () => {
    expect(() => highlightCode("def f(): pass")).not.toThrow()
  })
})

describe("highlightCode error fallback", () => {
  it("returns the original code when the highlighter throws", () => {
    jest.isolateModules(() => {
      jest.doMock("cli-highlight", () => ({
        supportsLanguage: () => true,
        highlight: () => {
          throw new Error("boom")
        },
      }))
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs a sync re-require under the mock
      const { highlightCode: hc } = require("./highlight") as typeof import("./highlight")
      expect(hc("const x = 1", "js")).toBe("const x = 1")
    })
    jest.dontMock("cli-highlight")
  })
})

describe("stripAnsi", () => {
  it("removes color escape sequences", () => {
    expect(stripAnsi("[31mred[39m")).toBe("red")
  })
})
