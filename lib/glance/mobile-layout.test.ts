import {
  DEFAULT_GLANCE_MODULE_OPTIONS,
  GLANCE_MODULE_IDS,
  GLANCE_PRESET_IDS,
  type GlanceLayoutEntry,
  type GlanceMobileEntry,
  type GlanceModuleId,
} from "@/types/glance/layout"
import { DEFAULT_MOBILE_HOME_LAYOUT, MOBILE_QUICK_ACTION_CATALOG } from "@/types/shell/mobile-home"

import {
  DEFAULT_GLANCE_MOBILE_SETTINGS,
  DEFAULT_GLANCE_MOBILE_SHORTCUTS,
  desktopEntriesFromMobile,
  GLANCE_MOBILE_PRESETS,
  homeEntries,
  migrateMobileHomeLayout,
  mobileEntriesFromDesktop,
  mobileLayoutFromPreset,
  normalizeGlanceMobileSettings,
  normalizeMobileEntries,
  normalizeShortcuts,
} from "./mobile-layout"
import { layoutFromPreset } from "./presets"
import { GLANCE_MODULES, supportsSize } from "./registry"

const ids = (entries: readonly GlanceLayoutEntry[]) => entries.map((e) => e.id)
const pinned = (entries: readonly GlanceMobileEntry[]) =>
  entries.filter((e) => e.home).map((e) => e.id)
const entry = (id: string, home: boolean): GlanceMobileEntry =>
  ({ id, size: "standard", hidden: false, home }) as GlanceMobileEntry

describe("mobileLayoutFromPreset", () => {
  it.each(GLANCE_PRESET_IDS.map((id) => [id]))("%s covers every module once", (preset) => {
    expect([...ids(mobileLayoutFromPreset(preset))].sort()).toEqual([...GLANCE_MODULE_IDS].sort())
  })

  it.each(GLANCE_PRESET_IDS.map((id) => [id]))(
    "%s lists its visible entries first, in preset order, with their pins",
    (preset) => {
      const entries = mobileLayoutFromPreset(preset)
      const visible = GLANCE_MOBILE_PRESETS[preset]
      expect(entries.slice(0, visible.length)).toEqual(
        visible.map(([id, size, home]) => ({ id, size, hidden: false, home }))
      )
      const rest = entries.slice(visible.length)
      expect(rest.every((e) => e.hidden && !e.home)).toBe(true)
      for (const e of rest) expect(e.size).toBe(GLANCE_MODULES[e.id as GlanceModuleId].sizes[0])
    }
  )

  it.each(GLANCE_PRESET_IDS.map((id) => [id]))(
    "%s pins only visible entries and uses supported sizes",
    (preset) => {
      for (const e of mobileLayoutFromPreset(preset)) {
        if (e.home) expect(e.hidden).toBe(false)
        expect(supportsSize(e.id as GlanceModuleId, e.size)).toBe(true)
      }
    }
  )

  it("balanced reproduces the pre-ADR-0225 home screen", () => {
    expect(pinned(mobileLayoutFromPreset("balanced"))).toEqual([
      "fleet",
      "quick",
      "usage",
      "activity",
      "recents",
    ])
  })

  it("returns a fresh list each call", () => {
    expect(mobileLayoutFromPreset("minimal")).not.toBe(mobileLayoutFromPreset("minimal"))
  })
})

describe("defaults", () => {
  it("starts from the balanced preset with the old default shortcuts", () => {
    expect(DEFAULT_GLANCE_MOBILE_SETTINGS).toEqual({
      version: 1,
      preset: "balanced",
      entries: mobileLayoutFromPreset("balanced"),
      scope: "all",
      options: DEFAULT_GLANCE_MODULE_OPTIONS,
      shortcuts: DEFAULT_MOBILE_HOME_LAYOUT.quickActions,
    })
    expect(DEFAULT_GLANCE_MOBILE_SHORTCUTS).toEqual(["newChat", "search", "workflows", "discover"])
  })
})

describe("normalizeMobileEntries", () => {
  it.each([[undefined], [null], ["x"], [{}], [42]])(
    "falls back to balanced for non-array %j",
    (raw) => {
      expect(normalizeMobileEntries(raw)).toEqual(mobileLayoutFromPreset("balanced"))
    }
  )

  it("drops unknown ids, malformed items and duplicates (first wins)", () => {
    const out = normalizeMobileEntries([
      { id: "usage", size: "expanded", hidden: false, home: true },
      { id: "nope", size: "standard", hidden: false, home: true },
      null,
      "fleet",
      { id: 7 },
      { id: "usage", size: "compact", hidden: true, home: false },
      { id: "fleet", size: "compact", hidden: false, home: false },
    ])
    expect(out[0]).toEqual({ id: "usage", size: "expanded", hidden: false, home: true })
    expect(out[1]).toEqual({ id: "fleet", size: "compact", hidden: false, home: false })
    expect(out.filter((e) => e.id === "usage")).toHaveLength(1)
    expect([...ids(out)].sort()).toEqual([...GLANCE_MODULE_IDS].sort())
  })

  it("degrades an unsupported size and defaults a missing or unknown one", () => {
    const out = normalizeMobileEntries([
      { id: "agenda", size: "expanded", hidden: false },
      { id: "quick", size: "huge", hidden: false },
      { id: "recents", hidden: false },
    ])
    expect(out[0].size).toBe("standard")
    expect(out[1].size).toBe(GLANCE_MODULES.quick.sizes[0])
    expect(out[2].size).toBe(GLANCE_MODULES.recents.sizes[0])
  })

  it("appends missing modules hidden and unpinned at their smallest size", () => {
    const out = normalizeMobileEntries([
      { id: "fleet", size: "standard", hidden: false, home: true },
    ])
    expect(out[0]).toEqual({ id: "fleet", size: "standard", hidden: false, home: true })
    const rest = out.slice(1)
    expect(ids(rest)).toEqual(GLANCE_MODULE_IDS.filter((id) => id !== "fleet"))
    for (const e of rest) {
      expect(e).toEqual({
        id: e.id,
        size: GLANCE_MODULES[e.id as GlanceModuleId].sizes[0],
        hidden: true,
        home: false,
      })
    }
  })

  it("treats hidden and home as set only when exactly true", () => {
    const out = normalizeMobileEntries([
      { id: "fleet", size: "standard", hidden: "yes", home: "yes" },
      { id: "usage", size: "standard", hidden: 1, home: 1 },
      { id: "quota", size: "standard", hidden: true, home: true },
    ])
    expect(out[0]).toMatchObject({ hidden: false, home: false })
    expect(out[1]).toMatchObject({ hidden: false, home: false })
    expect(out[2]).toMatchObject({ hidden: true, home: true })
  })

  it("keeps an empty list as all hidden", () => {
    const out = normalizeMobileEntries([])
    expect(out).toHaveLength(GLANCE_MODULE_IDS.length)
    expect(out.every((e) => e.hidden && !e.home)).toBe(true)
  })
})

describe("normalizeShortcuts", () => {
  it.each([[undefined], [null], ["newChat"], [{ 0: "newChat" }]])(
    "uses the default for non-array %j",
    (raw) => {
      expect(normalizeShortcuts(raw)).toEqual([...DEFAULT_GLANCE_MOBILE_SHORTCUTS])
    }
  )

  it("returns a copy of the default, not the shared constant", () => {
    const out = normalizeShortcuts(undefined)
    out.push("me")
    expect(DEFAULT_GLANCE_MOBILE_SHORTCUTS).not.toContain("me")
  })

  it("maps the legacy agentTeams id to squads", () => {
    expect(normalizeShortcuts(["agentTeams", "inbox"])).toEqual(["squads", "inbox"])
  })

  it("drops unknown and non-string ids", () => {
    expect(normalizeShortcuts(["inbox", "gone", 3, null, "me"])).toEqual(["inbox", "me"])
  })

  it("dedupes, keeping the first place, including a legacy id colliding with its new name", () => {
    expect(normalizeShortcuts(["me", "squads", "me", "agentTeams", "inbox"])).toEqual([
      "me",
      "squads",
      "inbox",
    ])
  })

  it("honours an explicitly empty list", () => {
    expect(normalizeShortcuts([])).toEqual([])
  })

  it("accepts every catalogue id", () => {
    const all = MOBILE_QUICK_ACTION_CATALOG.map((a) => a.id)
    expect(normalizeShortcuts(all)).toEqual(all)
  })
})

describe("migrateMobileHomeLayout", () => {
  it("reads no legacy state as the balanced preset", () => {
    expect(migrateMobileHomeLayout({})).toEqual(DEFAULT_GLANCE_MOBILE_SETTINGS)
    expect(migrateMobileHomeLayout({ mobileHomeLayout: null, welcomeStats: null })).toEqual(
      DEFAULT_GLANCE_MOBILE_SETTINGS
    )
  })

  it("reads the old default home as balanced", () => {
    const out = migrateMobileHomeLayout({
      mobileHomeLayout: DEFAULT_MOBILE_HOME_LAYOUT,
      welcomeStats: { enabled: true },
    })
    expect(out.preset).toBe("balanced")
    expect(out.entries).toEqual(mobileLayoutFromPreset("balanced"))
  })

  it.each([
    ["activeRuns", "fleet"],
    ["quickActions", "quick"],
    ["recents", "recents"],
  ] as const)("a hidden %s section unpins %s and makes the layout custom", (section, module) => {
    const out = migrateMobileHomeLayout({
      mobileHomeLayout: { hiddenSections: [section] },
    })
    const target = out.entries.find((e) => e.id === module)!
    expect(target.home).toBe(false)
    // The module stays visible in the drawer.
    expect(target.hidden).toBe(false)
    expect(out.preset).toBe("custom")
    const others = pinned(mobileLayoutFromPreset("balanced")).filter((id) => id !== module)
    for (const id of others) expect(out.entries.find((e) => e.id === id)!.home).toBe(true)
  })

  it("an off dashboard unpins both usage and activity", () => {
    const out = migrateMobileHomeLayout({ welcomeStats: { enabled: false } })
    expect(out.entries.find((e) => e.id === "usage")).toMatchObject({ home: false, hidden: false })
    expect(out.entries.find((e) => e.id === "activity")).toMatchObject({
      home: false,
      hidden: false,
    })
    expect(pinned(out.entries)).toEqual(["fleet", "quick", "recents"])
    expect(out.preset).toBe("custom")
  })

  it("keeps the order, sizes and visibility of the balanced preset", () => {
    const out = migrateMobileHomeLayout({
      mobileHomeLayout: { hiddenSections: ["activeRuns", "quickActions", "recents"] },
      welcomeStats: { enabled: false },
    })
    const base = mobileLayoutFromPreset("balanced")
    expect(out.entries.map(({ id, size, hidden }) => ({ id, size, hidden }))).toEqual(
      base.map(({ id, size, hidden }) => ({ id, size, hidden }))
    )
    expect(pinned(out.entries)).toEqual([])
  })

  it("ignores a malformed hiddenSections value", () => {
    const out = migrateMobileHomeLayout({
      mobileHomeLayout: { hiddenSections: "recents" as unknown as [] },
    })
    expect(out.preset).toBe("balanced")
  })

  it("carries the shortcuts, normalized", () => {
    const out = migrateMobileHomeLayout({
      mobileHomeLayout: { quickActions: ["agentTeams", "bogus", "inbox", "inbox"] },
    })
    expect(out.shortcuts).toEqual(["squads", "inbox"])
    expect(out.preset).toBe("balanced")
  })

  it("honours an emptied shortcut grid", () => {
    expect(migrateMobileHomeLayout({ mobileHomeLayout: { quickActions: [] } }).shortcuts).toEqual(
      []
    )
  })

  it("keeps the default options and scope", () => {
    const out = migrateMobileHomeLayout({ welcomeStats: { enabled: false } })
    expect(out.scope).toBe("all")
    expect(out.options).toEqual(DEFAULT_GLANCE_MODULE_OPTIONS)
    expect(out.version).toBe(1)
  })
})

describe("normalizeGlanceMobileSettings", () => {
  it.each([[undefined], [null], ["x"], [[]]])(
    "reads the legacy home when nothing valid is stored (%j)",
    (raw) => {
      const legacy = { mobileHomeLayout: { hiddenSections: ["recents" as const] } }
      expect(normalizeGlanceMobileSettings(raw, legacy)).toEqual(migrateMobileHomeLayout(legacy))
    }
  )

  it("defaults to balanced with neither stored nor legacy state", () => {
    expect(normalizeGlanceMobileSettings(undefined)).toEqual(DEFAULT_GLANCE_MOBILE_SETTINGS)
  })

  it("prefers a stored layout over the legacy state", () => {
    const out = normalizeGlanceMobileSettings(
      { preset: "minimal", entries: mobileLayoutFromPreset("minimal"), shortcuts: ["me"] },
      { mobileHomeLayout: { quickActions: ["inbox"], hiddenSections: ["activeRuns"] } }
    )
    expect(out.preset).toBe("minimal")
    expect(out.entries).toEqual(mobileLayoutFromPreset("minimal"))
    expect(out.shortcuts).toEqual(["me"])
  })

  it.each([["custom"], ["agent-ops"], ["usage-first"]])("keeps the preset %s", (preset) => {
    expect(normalizeGlanceMobileSettings({ preset }).preset).toBe(preset)
  })

  it.each([["wild"], [3], [null]])("falls back to balanced for preset %j", (preset) => {
    expect(normalizeGlanceMobileSettings({ preset }).preset).toBe("balanced")
  })

  it("uses the balanced entries when none are stored, and repairs stored ones", () => {
    expect(normalizeGlanceMobileSettings({}).entries).toEqual(mobileLayoutFromPreset("balanced"))
    const out = normalizeGlanceMobileSettings({
      entries: [{ id: "pet", size: "standard", hidden: false, home: true }],
    })
    expect(out.entries[0]).toEqual({ id: "pet", size: "standard", hidden: false, home: true })
    expect(out.entries).toHaveLength(GLANCE_MODULE_IDS.length)
  })

  it("accepts only the workspace scope besides all", () => {
    expect(normalizeGlanceMobileSettings({ scope: "workspace" }).scope).toBe("workspace")
    expect(normalizeGlanceMobileSettings({ scope: "project" }).scope).toBe("all")
  })

  it("normalizes options", () => {
    const out = normalizeGlanceMobileSettings({
      options: { usage: { scope: "all-tools", showSpend: "yes" }, activity: { range: "5y" } },
    })
    expect(out.options).toEqual({
      usage: { scope: "all-tools", showSpend: false },
      activity: { range: DEFAULT_GLANCE_MODULE_OPTIONS.activity.range },
    })
  })

  it("defaults shortcuts when missing and honours an empty list", () => {
    expect(normalizeGlanceMobileSettings({}).shortcuts).toEqual([
      ...DEFAULT_GLANCE_MOBILE_SHORTCUTS,
    ])
    expect(normalizeGlanceMobileSettings({ shortcuts: [] }).shortcuts).toEqual([])
  })

  it("always writes version 1", () => {
    expect(normalizeGlanceMobileSettings({ version: 9 }).version).toBe(1)
  })
})

describe("homeEntries", () => {
  it("keeps visible pinned entries in layout order", () => {
    const entries: GlanceMobileEntry[] = [
      entry("usage", true),
      entry("fleet", false),
      { ...entry("pet", true), hidden: true },
      entry("recents", true),
    ]
    expect(ids(homeEntries(entries))).toEqual(["usage", "recents"])
  })

  it("is empty for a layout with no pins", () => {
    expect(
      homeEntries(mobileLayoutFromPreset("balanced").map((e) => ({ ...e, home: false })))
    ).toEqual([])
  })
})

describe("mobileEntriesFromDesktop", () => {
  it("copies the desktop's order, sizes and visibility", () => {
    const desktop = layoutFromPreset("usage-first")
    const out = mobileEntriesFromDesktop(desktop, mobileLayoutFromPreset("balanced"))
    expect(out.map(({ id, size, hidden }) => ({ id, size, hidden }))).toEqual(desktop)
  })

  it("keeps the phone's pins for modules visible on both", () => {
    const current = mobileLayoutFromPreset("balanced")
    const out = mobileEntriesFromDesktop(layoutFromPreset("balanced"), current)
    // balanced desktop shows fleet usage quota agenda activity quick.
    expect(pinned(out)).toEqual(["fleet", "usage", "activity", "quick"])
  })

  it("starts a newly shown module unpinned", () => {
    const current = mobileLayoutFromPreset("minimal")
    // pet is hidden on the phone and visible on the desktop copy.
    const out = mobileEntriesFromDesktop([{ id: "pet", size: "standard", hidden: false }], current)
    expect(out[0]).toEqual({ id: "pet", size: "standard", hidden: false, home: false })
  })

  it("never pins a module the desktop hides", () => {
    const current = mobileLayoutFromPreset("balanced")
    const desktop = layoutFromPreset("balanced").map((e) =>
      e.id === "fleet" ? { ...e, hidden: true } : e
    )
    const out = mobileEntriesFromDesktop(desktop, current)
    expect(out.find((e) => e.id === "fleet")).toMatchObject({ hidden: true, home: false })
  })

  it("repairs a partial desktop list", () => {
    const out = mobileEntriesFromDesktop(
      [{ id: "usage", size: "expanded", hidden: false }],
      mobileLayoutFromPreset("balanced")
    )
    expect(out[0]).toEqual({ id: "usage", size: "expanded", hidden: false, home: true })
    expect(out).toHaveLength(GLANCE_MODULE_IDS.length)
    expect(out.slice(1).every((e) => e.hidden && !e.home)).toBe(true)
  })
})

describe("desktopEntriesFromMobile", () => {
  it("drops the pins and keeps order, sizes and visibility", () => {
    const mobile = mobileLayoutFromPreset("agent-ops")
    const out = desktopEntriesFromMobile(mobile)
    expect(out).toEqual(mobile.map(({ id, size, hidden }) => ({ id, size, hidden })))
    for (const e of out) expect(e).not.toHaveProperty("home")
  })

  it("round-trips with mobileEntriesFromDesktop", () => {
    const mobile = mobileLayoutFromPreset("balanced")
    expect(mobileEntriesFromDesktop(desktopEntriesFromMobile(mobile), mobile)).toEqual(mobile)
  })
})

describe("plugin entries on a phone layout (ADR-0225 §6)", () => {
  it("keeps plugin entries with their home pin", () => {
    const entries = normalizeMobileEntries([
      { id: "plugin:com.ci:status", size: "compact", hidden: false, home: true },
      { id: "plugin:com.ci:status", size: "standard", hidden: false, home: false },
    ])
    expect(entries.filter((e) => e.id === "plugin:com.ci:status")).toEqual([
      { id: "plugin:com.ci:status", size: "compact", hidden: false, home: true },
    ])
  })

  it("carries plugin entries across a desktop copy, keeping the phone's pins", () => {
    const current = normalizeMobileEntries([
      { id: "plugin:com.ci:status", size: "compact", hidden: false, home: true },
    ])
    const copied = mobileEntriesFromDesktop(
      [{ id: "plugin:com.ci:status", size: "expanded", hidden: false }],
      current
    )
    expect(copied.find((e) => e.id === "plugin:com.ci:status")).toEqual({
      id: "plugin:com.ci:status",
      size: "expanded",
      hidden: false,
      home: true,
    })
  })
})
