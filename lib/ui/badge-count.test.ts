import { BADGE_COUNT_CAP, formatBadgeCount } from "./badge-count"

test("spells whole counts and caps them at 99+", () => {
  expect(formatBadgeCount(0)).toBe("0")
  expect(formatBadgeCount(7)).toBe("7")
  expect(formatBadgeCount(BADGE_COUNT_CAP)).toBe("99")
  expect(formatBadgeCount(100)).toBe("99+")
  expect(formatBadgeCount(2.7)).toBe("2")
  expect(formatBadgeCount(-3)).toBe("0")
})
