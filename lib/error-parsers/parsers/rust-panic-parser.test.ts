/**
 * @jest-environment node
 */

import { rustPanicParser } from "./rust-panic-parser"

describe("rustPanicParser", () => {
  it("parses the modern `panicked at <loc>:` layout", () => {
    const text = `thread 'main' panicked at src/main.rs:10:5:
called \`Option::unwrap()\` on a \`None\` value
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace`

    const result = rustPanicParser.parse(text)
    expect(result).not.toBeNull()
    expect(result!.parsed).toBe(true)
    expect(result!.nodes[0]).toMatchObject({
      kind: "text",
      content: "called `Option::unwrap()` on a `None` value",
    })
    expect(result!.nodes[1]).toMatchObject({
      kind: "path",
      href: "src/main.rs",
      line: 10,
      column: 5,
    })
  })

  it("parses the legacy `panicked at '<msg>', <loc>` layout", () => {
    const text = `thread 'main' panicked at 'index out of bounds', src/lib.rs:7:13`
    const result = rustPanicParser.parse(text)
    expect(result).not.toBeNull()
    expect(result!.nodes[0]).toMatchObject({ kind: "text", content: "index out of bounds" })
    expect(result!.nodes[1]).toMatchObject({
      kind: "path",
      href: "src/lib.rs",
      line: 7,
      column: 13,
    })
  })

  it("returns null when there is no panic", () => {
    expect(rustPanicParser.parse("error: build failed")).toBeNull()
  })
})
