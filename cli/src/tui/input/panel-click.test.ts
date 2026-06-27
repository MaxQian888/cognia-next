import { rowAtClick } from "./panel-click"

describe("rowAtClick", () => {
  // Panel at row 10: border(10) header(11) items(12..14) for visibleCount=3.
  const base = { panelTop: 10, headerRows: 1, hasAboveMore: false, visibleCount: 3 }

  it("maps a click on the first item to offset 0", () => {
    expect(rowAtClick({ ...base, clickRow: 12 })).toBe(0)
  })

  it("maps a click on the last visible item", () => {
    expect(rowAtClick({ ...base, clickRow: 14 })).toBe(2)
  })

  it("returns null for the border/header rows", () => {
    expect(rowAtClick({ ...base, clickRow: 10 })).toBeNull()
    expect(rowAtClick({ ...base, clickRow: 11 })).toBeNull()
  })

  it("returns null for a click below the last item (footer/border)", () => {
    expect(rowAtClick({ ...base, clickRow: 15 })).toBeNull()
  })

  it("shifts the item band down by one when the '↑ N more' indicator is shown", () => {
    expect(rowAtClick({ ...base, hasAboveMore: true, clickRow: 12 })).toBeNull()
    expect(rowAtClick({ ...base, hasAboveMore: true, clickRow: 13 })).toBe(0)
  })

  it("honours a custom borderRows (e.g. borderless panel)", () => {
    expect(rowAtClick({ ...base, borderRows: 0, clickRow: 11 })).toBe(0)
  })

  it("handles multi-row headers", () => {
    expect(rowAtClick({ ...base, headerRows: 2, clickRow: 13 })).toBe(0)
  })
})
