import {
  INITIAL_SCROLL,
  atBottom,
  clampTop,
  effectiveTop,
  hiddenRows,
  maxScroll,
  scrollByLines,
  scrollPage,
  scrollToBottom,
  scrollToRow,
  scrollToTop,
} from "./scroll-view-state"

describe("scroll-view-state", () => {
  describe("maxScroll", () => {
    it("is zero when content fits the viewport", () => {
      expect(maxScroll(10, 20)).toBe(0)
      expect(maxScroll(20, 20)).toBe(0)
    })
    it("is the overflow when content is taller", () => {
      expect(maxScroll(50, 20)).toBe(30)
    })
    it("floors fractional measured heights", () => {
      expect(maxScroll(50.9, 20.2)).toBe(30)
    })
  })

  describe("clampTop", () => {
    it("clamps into [0, maxScroll]", () => {
      expect(clampTop(-5, 50, 20)).toBe(0)
      expect(clampTop(100, 50, 20)).toBe(30)
      expect(clampTop(10, 50, 20)).toBe(10)
    })
    it("treats a non-finite offset as the top", () => {
      expect(clampTop(Number.NaN, 50, 20)).toBe(0)
    })
  })

  describe("effectiveTop", () => {
    it("pins to the bottom while sticking", () => {
      expect(effectiveTop({ top: 5, stick: true }, 50, 20)).toBe(30)
    })
    it("uses the clamped raw offset when not sticking", () => {
      expect(effectiveTop({ top: 5, stick: false }, 50, 20)).toBe(5)
      expect(effectiveTop({ top: 999, stick: false }, 50, 20)).toBe(30)
    })
  })

  describe("atBottom", () => {
    it("is true while sticking", () => {
      expect(atBottom(INITIAL_SCROLL, 50, 20)).toBe(true)
    })
    it("is true when the offset reaches maxScroll", () => {
      expect(atBottom({ top: 30, stick: false }, 50, 20)).toBe(true)
    })
    it("is false when scrolled up", () => {
      expect(atBottom({ top: 10, stick: false }, 50, 20)).toBe(false)
    })
  })

  describe("scrollByLines", () => {
    it("moves up off the bottom and stops sticking", () => {
      const next = scrollByLines(INITIAL_SCROLL, -5, 50, 20)
      expect(next).toEqual({ top: 25, stick: false })
    })
    it("re-engages stick once it reaches the bottom again", () => {
      const up = scrollByLines(INITIAL_SCROLL, -5, 50, 20)
      const back = scrollByLines(up, 10, 50, 20)
      expect(back).toEqual({ top: 30, stick: true })
    })
    it("never scrolls above the top", () => {
      const next = scrollByLines({ top: 2, stick: false }, -10, 50, 20)
      expect(next.top).toBe(0)
      expect(next.stick).toBe(false)
    })
  })

  describe("scrollPage", () => {
    it("pages by a viewport minus one row of overlap", () => {
      // viewport 20 → step 19; from bottom (top 30) up one page → 11.
      expect(scrollPage(INITIAL_SCROLL, "up", 50, 20)).toEqual({ top: 11, stick: false })
    })
    it("pages down and can re-stick", () => {
      const up = scrollPage(INITIAL_SCROLL, "up", 50, 20)
      expect(scrollPage(up, "down", 50, 20)).toEqual({ top: 30, stick: true })
    })
    it("uses a minimum step of one row for a tiny viewport", () => {
      expect(scrollPage(INITIAL_SCROLL, "up", 5, 1)).toEqual({ top: 3, stick: false })
    })
  })

  describe("jumps", () => {
    it("scrollToTop goes to the top and stops following", () => {
      expect(scrollToTop()).toEqual({ top: 0, stick: false })
    })
    it("scrollToBottom re-pins to the bottom", () => {
      expect(scrollToBottom()).toEqual({ top: 0, stick: true })
    })
  })

  describe("scrollToRow", () => {
    it("places the target ~1/3 down the viewport and stops sticking", () => {
      // viewport 30 → lead 10; target row 25 → top 15.
      expect(scrollToRow(25, 100, 30)).toEqual({ top: 15, stick: false })
    })
    it("clamps a near-top target to the top", () => {
      // lead 10 exceeds the row, so the clamped offset floors at 0.
      expect(scrollToRow(3, 100, 30)).toEqual({ top: 0, stick: false })
    })
    it("clamps a near-bottom target to maxScroll", () => {
      // maxScroll(100,30)=70; row 99 - lead 10 = 89 → clamped 70.
      expect(scrollToRow(99, 100, 30)).toEqual({ top: 70, stick: false })
    })
    it("degrades to the top when sizes are not measured yet", () => {
      expect(scrollToRow(40, 0, 0)).toEqual({ top: 0, stick: false })
    })
    it("treats a non-finite / negative target as the first row", () => {
      expect(scrollToRow(Number.NaN, 100, 30)).toEqual({ top: 0, stick: false })
      expect(scrollToRow(-5, 100, 30)).toEqual({ top: 0, stick: false })
    })
  })

  describe("hiddenRows", () => {
    it("reports rows above and below the viewport", () => {
      expect(hiddenRows({ top: 10, stick: false }, 50, 20)).toEqual({ above: 10, below: 20 })
    })
    it("reports nothing below while pinned to the bottom", () => {
      expect(hiddenRows(INITIAL_SCROLL, 50, 20)).toEqual({ above: 30, below: 0 })
    })
  })
})
