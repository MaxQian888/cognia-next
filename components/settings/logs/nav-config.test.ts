/**
 * `resolveLogsPanel` is the boundary where a `?logsPanel=` value from anywhere
 * becomes an id the section indexes panels by, so an unknown value must land on
 * a real panel rather than rendering nothing.
 *
 * The message assertions matter because the nav renders `label` and
 * `description` for every item: a panel added to `LOGS_NAV_GROUPS` without its
 * two strings shows a raw key in the rail.
 */

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

import {
  DEFAULT_LOGS_PANEL,
  LOGS_NAV_GROUPS,
  LOGS_NAV_ITEMS,
  LOGS_PANEL_PARAM,
  resolveLogsPanel,
} from "./nav-config"

const bundles = { en: enMessages, "zh-CN": zhMessages } as const

describe("LOGS_NAV_GROUPS", () => {
  it("exposes every item exactly once across the groups", () => {
    const ids = LOGS_NAV_ITEMS.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(["overview", "levels", "filters", "transports", "telemetry", "retention"])
  })

  it("gives every item an icon", () => {
    for (const item of LOGS_NAV_ITEMS) {
      expect(item.icon).toBeDefined()
    }
  })

  it("starts on a panel that exists", () => {
    expect(LOGS_NAV_ITEMS.map((item) => item.id)).toContain(DEFAULT_LOGS_PANEL)
  })

  it("names the deep-link parameter", () => {
    expect(LOGS_PANEL_PARAM).toBe("logsPanel")
  })
})

describe("resolveLogsPanel", () => {
  it.each(LOGS_NAV_ITEMS.map((item) => item.id))("accepts the known id %s", (id) => {
    expect(resolveLogsPanel(id)).toBe(id)
  })

  it.each([null, undefined, "", "nonsense", "Overview", "__proto__"])(
    "falls back to the default for %p",
    (raw) => {
      expect(resolveLogsPanel(raw)).toBe(DEFAULT_LOGS_PANEL)
    }
  )
})

describe("nav messages", () => {
  it.each(Object.entries(bundles))(
    "has a label and description for every item in %s",
    (_locale, bundle) => {
      const nav = (bundle as typeof enMessages).logging.settings.nav as unknown as {
        groups: Record<string, string>
        items: Record<string, { label: string; description: string }>
      }
      for (const item of LOGS_NAV_ITEMS) {
        expect(typeof nav.items[item.id]?.label).toBe("string")
        expect(typeof nav.items[item.id]?.description).toBe("string")
      }
      for (const group of LOGS_NAV_GROUPS) {
        expect(typeof nav.groups[group.id]).toBe("string")
      }
    }
  )
})
