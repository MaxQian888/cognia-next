import {
  DEFAULT_MOBILE_HOME_LAYOUT,
  LEGACY_MOBILE_QUICK_ACTION_IDS,
  MOBILE_QUICK_ACTION_CATALOG,
} from "./mobile-home"
import enMessages from "@/i18n/messages/en.json"
import zhCnMessages from "@/i18n/messages/zh-CN.json"

/**
 * The shortcut labels are looked up DYNAMICALLY: the quick module and the
 * shortcut editor render `tActions(item.i18nKey)` over the catalog.
 * `lint:i18n` only follows literal keys, so the gate does not check them, and
 * every suite that renders those components stubs `useTranslations` to echo
 * its argument. A missing key would therefore ship as a `MISSING_MESSAGE` on
 * screen with every gate green.
 *
 * This is the catalogue-coverage guard that closes that hole, modelled on
 * `types/shell/sidebar.test.ts`, which does the same job for the desktop rail.
 */
describe("mobile home catalog", () => {
  it("has unique quick-action ids", () => {
    const ids = MOBILE_QUICK_ACTION_CATALOG.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("gives every route-kind action a route, and no other kind one", () => {
    for (const item of MOBILE_QUICK_ACTION_CATALOG) {
      if (item.kind === "route") expect(item.route?.startsWith("/")).toBe(true)
      else expect(item.route).toBeUndefined()
    }
  })

  it("defaults to actions that exist in the catalog", () => {
    const ids = new Set(MOBILE_QUICK_ACTION_CATALOG.map((m) => m.id))
    for (const id of DEFAULT_MOBILE_HOME_LAYOUT.quickActions) expect(ids.has(id)).toBe(true)
  })

  // A renamed id is mapped on read rather than dropped, so the target of every
  // mapping has to still be in the catalog or the tile silently disappears from
  // saved grids instead of moving.
  it("maps every legacy id onto a live catalog id", () => {
    const ids = new Set(MOBILE_QUICK_ACTION_CATALOG.map((m) => m.id))
    for (const [from, to] of Object.entries(LEGACY_MOBILE_QUICK_ACTION_IDS)) {
      expect(ids.has(to)).toBe(true)
      expect(ids.has(from)).toBe(false)
    }
  })

  it.each([
    ["en", enMessages],
    ["zh-CN", zhCnMessages],
  ])("defines every dynamic quick-action label in %s", (_locale, messages) => {
    const labels = messages.mobile.home.actions as Record<string, unknown>
    for (const item of MOBILE_QUICK_ACTION_CATALOG) {
      expect(labels[item.i18nKey]).toEqual(expect.any(String))
    }
  })
})
