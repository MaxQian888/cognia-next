import { csvCell, csvRow, renderCsvSections } from "./csv"

describe("csvCell", () => {
  it("passes plain values through unquoted", () => {
    expect(csvCell("plain")).toBe("plain")
    expect(csvCell(42)).toBe("42")
    expect(csvCell(true)).toBe("true")
  })

  it("renders nullish cells as empty", () => {
    expect(csvCell(null)).toBe("")
    expect(csvCell(undefined)).toBe("")
  })

  it("quotes and doubles per RFC 4180", () => {
    expect(csvCell("a,b")).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"')
    expect(csvCell("cr\rhere")).toBe('"cr\rhere"')
  })

  it("JSON-encodes structured cells (Bitable fields are objects)", () => {
    expect(csvCell({ text: "x" })).toBe('"{""text"":""x""}"')
    expect(csvCell([1, 2])).toBe('"[1,2]"')
  })
})

describe("csvRow", () => {
  it("joins escaped cells", () => {
    expect(csvRow(["a", "b,c", null])).toBe('a,"b,c",')
  })

  it("renders an empty row as an empty line", () => {
    expect(csvRow([])).toBe("")
  })
})

describe("renderCsvSections", () => {
  it("returns an empty body for no sections", () => {
    expect(renderCsvSections([])).toBe("")
  })

  it("renders a lone untitled section as bare CSV", () => {
    expect(
      renderCsvSections([
        {
          title: "",
          rows: [
            ["a", "b"],
            ["1", "2"],
          ],
        },
      ])
    ).toBe("a,b\n1,2")
  })

  it("headings a lone titled section so the worksheet name survives", () => {
    expect(renderCsvSections([{ title: "Q3", rows: [["a"]] }])).toBe("## Q3\na")
  })

  it("separates multiple sections with headings and a blank line", () => {
    const out = renderCsvSections([
      { title: "One", rows: [["a"]] },
      { title: "Two", rows: [["b"]] },
    ])
    expect(out).toBe("## One\na\n\n## Two\nb")
  })

  it("keeps a per-section truncation note attached to its section", () => {
    const out = renderCsvSections([
      { title: "Big", rows: [["a"]], note: "[capped]" },
      { title: "Small", rows: [["b"]] },
    ])
    expect(out).toBe("## Big\na\n[capped]\n\n## Small\nb")
  })

  it("tolerates ragged rows", () => {
    expect(renderCsvSections([{ title: "", rows: [["a", "b"], ["c"]] }])).toBe("a,b\nc")
  })
})
