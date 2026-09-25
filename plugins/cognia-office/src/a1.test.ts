import * as XLSX from "xlsx"
import { decodeCell, decodeColumn, decodeRange, encodeCell, encodeColumn, encodeRange } from "./a1"

describe("A1 helpers", () => {
  it("matches SheetJS for columns, cells, and ranges", () => {
    for (const index of [0, 1, 25, 26, 51, 52, 701, 702, 16_383]) {
      expect(encodeColumn(index)).toBe(XLSX.utils.encode_col(index))
      expect(decodeColumn(encodeColumn(index))).toBe(index)
    }
    for (const ref of ["A1", "B4", "Z10", "AA100", "XFD1048576"]) {
      expect(decodeCell(ref)).toEqual(XLSX.utils.decode_cell(ref))
      expect(encodeCell(decodeCell(ref))).toBe(ref)
    }
    for (const ref of ["A1:C3", "B2", "AA1:AB20"]) {
      expect(decodeRange(ref)).toEqual(XLSX.utils.decode_range(ref))
      expect(encodeRange(decodeRange(ref))).toBe(XLSX.utils.encode_range(decodeRange(ref)))
    }
    expect(encodeRange({ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } })).toBe("A1")
  })

  it("ignores absolute markers like SheetJS", () => {
    expect(decodeCell("$B$4")).toEqual({ r: 3, c: 1 })
    expect(decodeColumn("$C")).toBe(2)
  })

  it("throws on malformed input instead of decoding to negative coordinates", () => {
    for (const ref of ["", "a1", "A", "1", "A0B", "A1:B2:C3", "A-1"])
      expect(() => decodeRange(ref)).toThrow()
    expect(() => decodeColumn("a")).toThrow()
    expect(() => encodeColumn(-1)).toThrow()
    expect(() => encodeCell({ r: -1, c: 0 })).toThrow()
    // "A0" parses, but its row index is -1 and cannot be re-encoded.
    expect(decodeCell("A0")).toEqual({ r: -1, c: 0 })
    expect(() => encodeCell(decodeCell("A0"))).toThrow()
  })
})
