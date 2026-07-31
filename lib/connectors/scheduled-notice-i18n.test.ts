/**
 * @jest-environment node
 */
import { formatScheduledSlot, resolveScheduledNoticeI18n } from "./scheduled-notice-i18n"

describe("resolveScheduledNoticeI18n", () => {
  it("resolves every locale tag the app can persist", () => {
    for (const locale of ["zh-CN", "zh", "zh-Hans"]) {
      expect(resolveScheduledNoticeI18n(locale).lateDelivery("x")).toContain("延迟送达")
    }
    for (const locale of ["en", "en-US"]) {
      expect(resolveScheduledNoticeI18n(locale).lateDelivery("x")).toContain("Delayed")
    }
  })

  // An unknown/missing locale must still produce text — an empty notice reads as
  // if the delivery were on time, which is the exact confusion this prevents.
  it("falls back to English rather than producing empty text", () => {
    for (const locale of [undefined, null, "", "fr-FR", "klingon"]) {
      expect(resolveScheduledNoticeI18n(locale).lateDelivery("x")).toContain("Delayed")
    }
  })

  it("names the slot the run was scheduled for", () => {
    expect(resolveScheduledNoticeI18n("en").lateDelivery("7/30/26, 9:00 AM")).toContain(
      "7/30/26, 9:00 AM"
    )
    expect(resolveScheduledNoticeI18n("zh-CN").lateDelivery("2026/7/30 09:00")).toContain(
      "2026/7/30 09:00"
    )
  })
})

describe("formatScheduledSlot", () => {
  it("formats the slot for the given locale", () => {
    const slot = new Date("2026-07-30T09:00:00.000Z")
    expect(formatScheduledSlot(slot, "en-US")).toMatch(/7\/30\/26/)
    // Same instant, different locale rendering.
    expect(formatScheduledSlot(slot, "zh-CN")).not.toBe(formatScheduledSlot(slot, "en-US"))
  })

  // A bad locale tag in settings must not cost the delivery.
  it("falls back to an ISO string on an invalid locale tag", () => {
    const slot = new Date("2026-07-30T09:00:00.000Z")
    expect(formatScheduledSlot(slot, "not a locale")).toBe("2026-07-30T09:00:00.000Z")
  })

  it("treats a missing locale as English rather than throwing", () => {
    const slot = new Date("2026-07-30T09:00:00.000Z")
    expect(() => formatScheduledSlot(slot, undefined)).not.toThrow()
    expect(formatScheduledSlot(slot, undefined)).toMatch(/7\/30\/26/)
  })
})
