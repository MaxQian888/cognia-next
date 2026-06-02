import { parseCsv } from "./parse-tabular"

describe("parseCsv", () => {
  it("parses a header + rows", () => {
    const out = parseCsv("q,a\nhi,yo\nfoo,bar")
    expect(out.columns).toEqual(["q", "a"])
    expect(out.rows).toEqual([
      { q: "hi", a: "yo" },
      { q: "foo", a: "bar" },
    ])
  })

  it("handles quoted commas and embedded newlines + escaped quotes", () => {
    const csv = 'q,a\n"hi, there","line1\nline2"\n"she said ""hi""",bar'
    const out = parseCsv(csv)
    expect(out.rows[0]).toEqual({ q: "hi, there", a: "line1\nline2" })
    expect(out.rows[1]).toEqual({ q: 'she said "hi"', a: "bar" })
  })

  it("handles CRLF line endings", () => {
    const out = parseCsv("a,b\r\n1,2\r\n3,4")
    expect(out.rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ])
  })

  it("pads missing trailing cells with empty string", () => {
    const out = parseCsv("a,b,c\n1,2")
    expect(out.rows[0]).toEqual({ a: "1", b: "2", c: "" })
  })

  it("returns empty on blank input", () => {
    expect(parseCsv("")).toEqual({ columns: [], rows: [] })
    expect(parseCsv("   ")).toEqual({ columns: [], rows: [] })
  })

  it("ignores trailing blank line", () => {
    const out = parseCsv("a\n1\n")
    expect(out.rows).toEqual([{ a: "1" }])
  })
})
