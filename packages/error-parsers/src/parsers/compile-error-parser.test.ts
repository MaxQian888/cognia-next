/**
 * @jest-environment node
 */

import { compileErrorParser } from "./compile-error-parser"

describe("compileErrorParser", () => {
  it("parses a tsc paren diagnostic into a clickable path + code/message text", () => {
    const text = "src/app.ts(12,7): error TS2345: Argument of type 'string' is not assignable."
    const result = compileErrorParser.parse(text)
    expect(result).not.toBeNull()
    expect(result!.parsed).toBe(true)
    expect(result!.nodes[0]).toMatchObject({
      kind: "path",
      href: "src/app.ts",
      line: 12,
      column: 7,
    })
    expect(result!.nodes[1]).toMatchObject({ kind: "text" })
    expect(result!.nodes[1].content).toContain("TS2345")
    expect(result!.nodes[1].content).toContain("not assignable")
  })

  it("coalesces surrounding non-matching lines and handles multiple diagnostics", () => {
    const text = [
      "Compiling project…",
      "src/a.ts(1,1): error TS1005: ';' expected.",
      "src/b.ts(2,3): error TS2304: Cannot find name 'foo'.",
      "Found 2 errors.",
    ].join("\n")
    const result = compileErrorParser.parse(text)!
    // text("Compiling…") path(a) text(TS1005) path(b) text(TS2304) text("Found 2 errors.")
    expect(result.nodes.filter((n) => n.kind === "path")).toHaveLength(2)
    expect(result.nodes[0]).toMatchObject({ kind: "text", content: "Compiling project…" })
  })

  it("returns null when there is no tsc diagnostic", () => {
    expect(compileErrorParser.parse("error: something generic")).toBeNull()
  })
})
