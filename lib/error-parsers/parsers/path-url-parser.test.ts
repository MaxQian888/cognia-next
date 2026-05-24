/**
 * @jest-environment node
 */

import { pathUrlParser } from "./path-url-parser"

describe("pathUrlParser", () => {
  it("parses URLs", () => {
    const result = pathUrlParser.parse("Check https://example.com for details")
    expect(result).not.toBeNull()
    expect(result!.nodes).toHaveLength(3)
    expect(result!.nodes[0].kind).toBe("text")
    expect(result!.nodes[1].kind).toBe("url")
    expect(result!.nodes[1].href).toBe("https://example.com")
    expect(result!.nodes[2].kind).toBe("text")
  })

  it("parses http URLs", () => {
    const result = pathUrlParser.parse("See http://localhost:3000")
    expect(result).not.toBeNull()
    expect(result!.nodes.some((n) => n.kind === "url" && n.href === "http://localhost:3000")).toBe(
      true
    )
  })

  it("parses Unix file paths", () => {
    const result = pathUrlParser.parse("at src/foo.ts:42:9")
    expect(result).not.toBeNull()
    expect(result!.nodes.some((n) => n.kind === "path")).toBe(true)
  })

  it("parses Windows file paths", () => {
    const result = pathUrlParser.parse("at C:\\project\\src\\foo.ts:42:9")
    expect(result).not.toBeNull()
  })

  it("returns null when no URLs or paths found", () => {
    const result = pathUrlParser.parse("just some plain text without links")
    expect(result).toBeNull()
  })

  it("handles mixed URLs and paths in same text", () => {
    const result = pathUrlParser.parse("See https://example.com and src/foo.ts:42")
    expect(result).not.toBeNull()
    const kinds = result!.nodes.map((n) => n.kind)
    expect(kinds).toContain("url")
    expect(kinds).toContain("path")
  })
})
