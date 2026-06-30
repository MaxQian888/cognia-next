import { shouldShowSticky, stickyCommandFor } from "./sticky-scroll"

describe("stickyCommandFor", () => {
  it("pins the nearest command at or above the viewport top", () => {
    expect(stickyCommandFor([2, 10, 25, 40], 30)).toBe(25)
  })
  it("pins the command when the viewport sits exactly on its start line", () => {
    expect(stickyCommandFor([2, 10, 25], 10)).toBe(10)
  })
  it("returns null when the viewport is above the first command", () => {
    expect(stickyCommandFor([10, 25], 5)).toBeNull()
    expect(stickyCommandFor([], 5)).toBeNull()
  })
  it("ignores input order", () => {
    expect(stickyCommandFor([40, 2, 25, 10], 26)).toBe(25)
  })
  it("returns null for a non-finite viewport", () => {
    expect(stickyCommandFor([2, 10], Number.NaN)).toBeNull()
  })
})

describe("shouldShowSticky", () => {
  it("shows when the pinned header scrolled above the viewport top", () => {
    expect(shouldShowSticky(10, 25)).toBe(true)
  })
  it("hides when the prompt row is still the top visible row", () => {
    expect(shouldShowSticky(25, 25)).toBe(false)
  })
  it("hides when nothing is pinned", () => {
    expect(shouldShowSticky(null, 25)).toBe(false)
  })
})
