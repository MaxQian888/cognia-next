import {
  DEFAULT_MOBILE_HOME_LAYOUT,
  LEGACY_MOBILE_QUICK_ACTION_IDS,
  MOBILE_HOME_SECTION_IDS,
  MOBILE_QUICK_ACTION_CATALOG,
} from "./mobile-home"
import enMessages from "@/i18n/messages/en.json"
import zhCnMessages from "@/i18n/messages/zh-CN.json"

/**
 * Both label sets on the mobile home are looked up DYNAMICALLY:
 * `mobile-quick-actions-editor.tsx` renders `tSections(id)` over the section
 * ids and `tActions(item.i18nKey)` over the catalog. `lint:i18n` only follows
 * literal keys, so neither is checked by the gate, and every suite that renders
 * these components stubs `useTranslations` to echo its argument. A missing key
 * would therefore ship as a `MISSING_MESSAGE` on screen with every gate green.
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

  it.each([
    ["en", enMessages],
    ["zh-CN", zhCnMessages],
  ])("defines every dynamic section label in %s", (_locale, messages) => {
    const labels = messages.mobile.home.sections as Record<string, unknown>
    for (const id of MOBILE_HOME_SECTION_IDS) {
      expect(labels[id]).toEqual(expect.any(String))
    }
  })

  // The section labels are interpolated into the dismiss buttons' accessible
  // names, so the surrounding message has to exist in both locales too.
  it.each([
    ["en", enMessages],
    ["zh-CN", zhCnMessages],
  ])("defines the dismiss label with its {section} placeholder in %s", (_locale, messages) => {
    const hide = messages.mobile.home.hideSection as unknown
    expect(hide).toEqual(expect.any(String))
    expect(hide as string).toContain("{section}")
  })
})
