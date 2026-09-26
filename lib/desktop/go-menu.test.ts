import { readFileSync } from "fs"
import { join } from "path"

import { SIDEBAR_NAV_ICONS } from "@/lib/shell/sidebar-nav"
import { SIDEBAR_NAV_META } from "@/types/shell/sidebar"

import {
  GO_MENU_IDS,
  GO_MENU_LAYOUT,
  GO_MENU_SECTIONS,
  getGoMenuItem,
  isGoMenuId,
  resolveGoMenuSections,
} from "./go-menu"

const EXTRA_IDS = ["go-dms", "go-canvas", "go-settings"]

function readGuildRail(locale: "en" | "zh-CN"): Record<string, unknown> {
  const file = join(__dirname, "..", "..", "i18n", "messages", locale, "desktop.json")
  return (JSON.parse(readFileSync(file, "utf8")) as { guildRail: Record<string, unknown> })
    .guildRail
}

describe("GO_MENU_LAYOUT", () => {
  it("places every catalog destination and every extra exactly once, and nothing else", () => {
    const placed = GO_MENU_LAYOUT.flat()
    expect(new Set(placed).size).toBe(placed.length)
    expect([...placed].sort()).toEqual(
      [...SIDEBAR_NAV_META.map((meta) => meta.id), "dms", "canvas", "settings"].sort()
    )
  })

  it("resolves without dropping or adding a section", () => {
    expect(GO_MENU_SECTIONS.map((section) => section.map((item) => item.id))).toEqual(
      GO_MENU_LAYOUT.map((section) => section.map((key) => `go-${key}`))
    )
  })
})

describe("GO_MENU_SECTIONS", () => {
  it("gives catalog destinations the rail's label key and icon", () => {
    for (const meta of SIDEBAR_NAV_META) {
      const item = getGoMenuItem(`go-${meta.id}`)
      expect(item).toEqual({
        id: `go-${meta.id}`,
        labelKey: meta.i18nKey,
        Icon: SIDEBAR_NAV_ICONS[meta.id],
      })
    }
  })

  it("labels the extras with the rail's DM guild, Canvas mode and Settings button strings", () => {
    expect(getGoMenuItem("go-dms")?.labelKey).toBe("directMessages")
    expect(getGoMenuItem("go-canvas")?.labelKey).toBe("canvas")
    expect(getGoMenuItem("go-settings")?.labelKey).toBe("settings")
    for (const id of EXTRA_IDS) expect(getGoMenuItem(id)?.Icon).toBeDefined()
  })

  it("has a label for every item in both locales", () => {
    const en = readGuildRail("en")
    const zh = readGuildRail("zh-CN")
    for (const section of GO_MENU_SECTIONS) {
      for (const item of section) {
        expect(typeof en[item.labelKey]).toBe("string")
        expect(typeof zh[item.labelKey]).toBe("string")
      }
    }
  })
})

describe("GO_MENU_IDS / isGoMenuId", () => {
  it("is the table flattened, one id per catalog entry plus the extras", () => {
    expect(GO_MENU_IDS).toEqual(GO_MENU_SECTIONS.flat().map((item) => item.id))
    expect([...GO_MENU_IDS].sort()).toEqual(
      [...SIDEBAR_NAV_META.map((meta) => `go-${meta.id}`), ...EXTRA_IDS].sort()
    )
  })

  it("accepts exactly the table's ids", () => {
    for (const id of GO_MENU_IDS) expect(isGoMenuId(id)).toBe(true)
    expect(isGoMenuId("go-agent-teams")).toBe(false)
    expect(isGoMenuId("go-")).toBe(false)
    expect(isGoMenuId("new-chat")).toBe(false)
    expect(getGoMenuItem("go-agent-teams")).toBeUndefined()
  })
})

describe("resolveGoMenuSections", () => {
  it("drops unknown and repeated ids and empty sections", () => {
    const sections = resolveGoMenuSections([
      ["no-such-destination"],
      ["dms", "dms", ...SIDEBAR_NAV_META.map((meta) => meta.id)],
      ["settings"],
    ])
    expect(sections.map((section) => section.map((item) => item.id))).toEqual([
      ["go-dms", ...SIDEBAR_NAV_META.map((meta) => `go-${meta.id}`)],
      ["go-settings"],
    ])
  })

  it("keeps a catalog destination the layout forgot reachable, just before the last section", () => {
    const [first, ...rest] = SIDEBAR_NAV_META.map((meta) => meta.id)
    const sections = resolveGoMenuSections([rest, ["settings"]])
    expect(sections.map((section) => section.map((item) => item.id))).toEqual([
      rest.map((id) => `go-${id}`),
      [`go-${first}`],
      ["go-settings"],
    ])
  })

  it("puts forgotten destinations in their own section when the layout is empty", () => {
    const sections = resolveGoMenuSections([])
    expect(sections).toHaveLength(1)
    expect(sections[0].map((item) => item.id)).toEqual(
      SIDEBAR_NAV_META.map((meta) => `go-${meta.id}`)
    )
  })
})
