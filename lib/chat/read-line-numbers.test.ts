import { stripReadLineNumbers } from "./read-line-numbers"

/** The sidecar's `formatCatN` shape: number right-aligned to 6, then a tab. */
const catN = (lines: string[], start = 1) =>
  lines.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join("\n")

describe("stripReadLineNumbers", () => {
  it("lifts cat -n prefixes off a listing and keeps the first number", () => {
    expect(stripReadLineNumbers(catN(["const a = 1", "", "export { a }"]))).toEqual({
      code: "const a = 1\n\nexport { a }",
      startLine: 1,
      trailer: "",
    })
  })

  it("keeps an offset read's own numbering for the gutter", () => {
    const result = stripReadLineNumbers(catN(["foo()", "bar()"], 120), 120)
    expect(result?.startLine).toBe(120)
    expect(result?.code).toBe("foo()\nbar()")
  })

  it("rejects a listing that does not start at the stated offset", () => {
    expect(stripReadLineNumbers(catN(["foo()"], 3), 120)).toBeNull()
  })

  it("understands Claude Code's arrow separator", () => {
    expect(stripReadLineNumbers("     1→import x\n     2→x()")?.code).toBe("import x\nx()")
  })

  it("unwraps a fenced listing and keeps text after the fence as the trailer", () => {
    const text = ["```", "     1→a", "     2→b", "```", "", "note"].join("\n")
    expect(stripReadLineNumbers(text)).toEqual({ code: "a\nb", startLine: 1, trailer: "note" })
  })

  it("separates the tool's paging hint from the code", () => {
    const text = `${catN(["a", "b"])}\n\n(showing lines 1-2 of 9; continue with offset=3)`
    expect(stripReadLineNumbers(text)).toEqual({
      code: "a\nb",
      startLine: 1,
      trailer: "(showing lines 1-2 of 9; continue with offset=3)",
    })
  })

  it("treats a bare number inside the run as a blank line whose tab was trimmed", () => {
    expect(stripReadLineNumbers("     1\ta\n     2\n     3\tc")?.code).toBe("a\n\nc")
  })

  it("normalises CRLF and ignores a trailing newline", () => {
    expect(stripReadLineNumbers("     1\ta\r\n     2\tb\r\n")?.code).toBe("a\nb")
  })

  it("leaves plain file content alone", () => {
    expect(stripReadLineNumbers("const a = 1\nconst b = 2")).toBeNull()
    expect(stripReadLineNumbers("")).toBeNull()
  })

  it("does not take a file that is just a number for a listing", () => {
    expect(stripReadLineNumbers("42")).toBeNull()
  })

  it("leaves numbers alone when they do not run consecutively", () => {
    // A TSV whose first column holds ids: 1, 5, 9 is data, not line numbers.
    expect(stripReadLineNumbers("1\talpha\n5\tbeta\n9\tgamma")).toBeNull()
  })

  it("leaves the text alone when the run is followed by more content without a gap", () => {
    expect(stripReadLineNumbers("     1\ta\n     2\tb\nplain line")).toBeNull()
  })
})
