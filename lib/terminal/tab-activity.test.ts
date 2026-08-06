import { shouldMarkActivity, shouldShowActivityBadge } from "./tab-activity"

describe("tab-activity", () => {
  describe("shouldShowActivityBadge", () => {
    it("returns false when session is the active tab", () => {
      expect(shouldShowActivityBadge("s1", "s1", true)).toBe(false)
    })

    it("returns false when session has no activity", () => {
      expect(shouldShowActivityBadge("s1", "s2", false)).toBe(false)
    })

    it("returns true when session is NOT active and has activity", () => {
      expect(shouldShowActivityBadge("s1", "s2", true)).toBe(true)
    })

    it("returns true when activeSessionId is null and session has activity", () => {
      expect(shouldShowActivityBadge("s1", null, true)).toBe(true)
    })

    it("returns false when activeSessionId is null and no activity", () => {
      expect(shouldShowActivityBadge("s1", null, false)).toBe(false)
    })
  })

  describe("shouldMarkActivity", () => {
    it("returns true when session is not the active tab", () => {
      expect(shouldMarkActivity("s1", "s2")).toBe(true)
    })

    it("returns false when session IS the active tab", () => {
      expect(shouldMarkActivity("s1", "s1")).toBe(false)
    })

    it("returns true when there is no active tab", () => {
      expect(shouldMarkActivity("s1", null)).toBe(true)
    })
  })
})
