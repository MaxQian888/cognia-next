import { composerPopupRowAtClick } from "./composer-popup-click"

describe("composerPopupRowAtClick", () => {
  describe("slash palette layout (border, optional above-more, items)", () => {
    // popupTop=0 → border row 0, first item at row 1 (no above-more).
    const base = {
      popupTop: 0,
      headerRows: 0,
      hasAboveMore: false,
      hiddenAbove: 0,
      visibleCount: 3,
    }

    it("maps the first item row to index 0", () => {
      expect(composerPopupRowAtClick({ ...base, clickRow: 1 })).toBe(0)
    })

    it("maps subsequent item rows in order", () => {
      expect(composerPopupRowAtClick({ ...base, clickRow: 2 })).toBe(1)
      expect(composerPopupRowAtClick({ ...base, clickRow: 3 })).toBe(2)
    })

    it("returns null for the border row", () => {
      expect(composerPopupRowAtClick({ ...base, clickRow: 0 })).toBeNull()
    })

    it("returns null below the last item", () => {
      expect(composerPopupRowAtClick({ ...base, clickRow: 4 })).toBeNull()
    })

    it("shifts items down by one when an '↑ more' row is shown", () => {
      const scrolled = { ...base, hasAboveMore: true, hiddenAbove: 2 }
      // border(0) · ↑more(1) · items start at row 2 → window offset 0 = index 2.
      expect(composerPopupRowAtClick({ ...scrolled, clickRow: 1 })).toBeNull()
      expect(composerPopupRowAtClick({ ...scrolled, clickRow: 2 })).toBe(2)
      expect(composerPopupRowAtClick({ ...scrolled, clickRow: 3 })).toBe(3)
    })
  })

  describe("mention palette layout (border, fixed indicator slot, items)", () => {
    // border(0) · fixed slot(1) · items start at row 2.
    const base = {
      popupTop: 0,
      headerRows: 1,
      hasAboveMore: false,
      hiddenAbove: 0,
      visibleCount: 2,
    }

    it("maps the first item row to index 0", () => {
      expect(composerPopupRowAtClick({ ...base, clickRow: 2 })).toBe(0)
      expect(composerPopupRowAtClick({ ...base, clickRow: 3 })).toBe(1)
    })

    it("returns null on the fixed header slot", () => {
      expect(composerPopupRowAtClick({ ...base, clickRow: 1 })).toBeNull()
    })

    it("adds hiddenAbove to recover the absolute candidate index", () => {
      expect(composerPopupRowAtClick({ ...base, hiddenAbove: 5, clickRow: 2 })).toBe(5)
    })
  })

  it("honours a non-zero popup top", () => {
    expect(
      composerPopupRowAtClick({
        clickRow: 11,
        popupTop: 10,
        headerRows: 0,
        hasAboveMore: false,
        hiddenAbove: 0,
        visibleCount: 4,
      })
    ).toBe(0)
  })
})
