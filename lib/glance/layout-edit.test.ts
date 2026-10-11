import {
  GLANCE_MODULE_IDS,
  type GlanceLayoutEntry,
  type GlanceMobileEntry,
  type GlanceMobileSettings,
  type GlanceModuleId,
  type GlancePanelSettings,
} from "@/types/glance/layout"

import {
  addEntry,
  hideEntry,
  moveVisible,
  pinEntryHome,
  reorderVisible,
  resizeEntry,
  showEntry,
  withEditedEntries,
  withEditedMobileEntries,
  withMobilePreset,
  withPreset,
  withShortcuts,
} from "./layout-edit"
import {
  DEFAULT_GLANCE_MOBILE_SETTINGS,
  mobileLayoutFromPreset,
  normalizeMobileEntries,
} from "./mobile-layout"
import { DEFAULT_GLANCE_PANEL_SETTINGS, layoutFromPreset } from "./presets"

const ids = (entries: readonly GlanceLayoutEntry[]) => entries.map((e) => e.id)
const visibleIds = (entries: readonly GlanceLayoutEntry[]) =>
  entries.filter((e) => !e.hidden).map((e) => e.id)
const hiddenIds = (entries: readonly GlanceLayoutEntry[]) =>
  entries.filter((e) => e.hidden).map((e) => e.id)

/** Every module exactly once, visible entries ahead of hidden ones. */
function expectWellFormed(entries: readonly GlanceLayoutEntry[]) {
  expect([...ids(entries)].sort()).toEqual([...GLANCE_MODULE_IDS].sort())
  const firstHidden = entries.findIndex((e) => e.hidden)
  if (firstHidden >= 0) expect(entries.slice(firstHidden).every((e) => e.hidden)).toBe(true)
}

// balanced: fleet usage quota agenda activity quick | recents pet (hidden)
const balanced = () => layoutFromPreset("balanced")
const ALL: readonly GlanceModuleId[] = GLANCE_MODULE_IDS

describe("reorderVisible", () => {
  it("orders the visible entries as asked and keeps hidden ones after, in order", () => {
    const out = reorderVisible(balanced(), [
      "quick",
      "fleet",
      "usage",
      "quota",
      "agenda",
      "activity",
    ])
    expect(visibleIds(out)).toEqual(["quick", "fleet", "usage", "quota", "agenda", "activity"])
    expect(hiddenIds(out)).toEqual(["recents", "pet"])
    expect(ids(out).slice(-2)).toEqual(["recents", "pet"])
    expectWellFormed(out)
  })

  it("ignores unknown and hidden ids", () => {
    const out = reorderVisible(balanced(), [
      "pet",
      "usage",
      "nope" as GlanceModuleId,
      "recents",
      "fleet",
    ])
    // pet and recents are hidden and stay hidden; usage and fleet lead.
    expect(visibleIds(out).slice(0, 2)).toEqual(["usage", "fleet"])
    expect(hiddenIds(out)).toEqual(["recents", "pet"])
    expectWellFormed(out)
  })

  it("appends visible entries the caller omitted, in their previous relative order", () => {
    const out = reorderVisible(balanced(), ["activity", "usage"])
    expect(visibleIds(out)).toEqual(["activity", "usage", "fleet", "quota", "agenda", "quick"])
    expectWellFormed(out)
  })

  it("uses a repeated id once", () => {
    const out = reorderVisible(balanced(), ["usage", "usage", "fleet"])
    expect(visibleIds(out).slice(0, 2)).toEqual(["usage", "fleet"])
    expectWellFormed(out)
  })

  it("is the identity for the current order and for an empty list", () => {
    const entries = balanced()
    expect(reorderVisible(entries, visibleIds(entries))).toEqual(entries)
    expect(reorderVisible(entries, [])).toEqual(entries)
  })

  it("keeps sizes and never mutates its input", () => {
    const entries = balanced()
    const before = JSON.parse(JSON.stringify(entries))
    const out = reorderVisible(entries, ["quick"])
    expect(entries).toEqual(before)
    expect(out.find((e) => e.id === "agenda")?.size).toBe("compact")
  })
})

describe("moveVisible", () => {
  it("moves an entry one place down and up", () => {
    const down = moveVisible(balanced(), "fleet", 1)
    expect(visibleIds(down)).toEqual(["usage", "fleet", "quota", "agenda", "activity", "quick"])
    const up = moveVisible(balanced(), "quota", -1)
    expect(visibleIds(up)).toEqual(["fleet", "quota", "usage", "agenda", "activity", "quick"])
    expectWellFormed(down)
    expectWellFormed(up)
  })

  it("moves by more than one place", () => {
    const out = moveVisible(balanced(), "fleet", 3)
    expect(visibleIds(out)).toEqual(["usage", "quota", "agenda", "fleet", "activity", "quick"])
  })

  it("clamps at both ends", () => {
    const entries = balanced()
    expect(moveVisible(entries, "fleet", -1)).toEqual(entries)
    expect(moveVisible(entries, "quick", 1)).toEqual(entries)
    expect(visibleIds(moveVisible(entries, "fleet", 99))).toEqual([
      "usage",
      "quota",
      "agenda",
      "activity",
      "quick",
      "fleet",
    ])
    expect(visibleIds(moveVisible(entries, "quick", -99))[0]).toBe("quick")
  })

  it("leaves the order alone for a zero move", () => {
    const entries = balanced()
    expect(moveVisible(entries, "usage", 0)).toEqual(entries)
  })

  it("returns a visible-first copy for an unknown or hidden id", () => {
    const shuffled: GlanceLayoutEntry[] = [
      { id: "pet", size: "compact", hidden: true },
      { id: "fleet", size: "standard", hidden: false },
      { id: "usage", size: "standard", hidden: false },
    ]
    const unknown = moveVisible(shuffled, "nope" as GlanceModuleId, 1)
    expect(ids(unknown)).toEqual(["fleet", "usage", "pet"])
    // A hidden entry is not part of the movable stack.
    expect(ids(moveVisible(shuffled, "pet", -1))).toEqual(["fleet", "usage", "pet"])
    expect(shuffled[0].id).toBe("pet")
  })
})

describe("resizeEntry", () => {
  it("changes one entry's size and nothing else", () => {
    const out = resizeEntry(balanced(), "agenda", "standard")
    expect(out.find((e) => e.id === "agenda")?.size).toBe("standard")
    expect(out.filter((e) => e.id !== "agenda")).toEqual(
      balanced().filter((e) => e.id !== "agenda")
    )
    expectWellFormed(out)
  })

  it("degrades a size the module lacks: agenda has no expanded", () => {
    const out = resizeEntry(balanced(), "agenda", "expanded")
    expect(out.find((e) => e.id === "agenda")?.size).toBe("standard")
  })

  it("keeps a hidden entry hidden", () => {
    const out = resizeEntry(balanced(), "pet", "standard")
    expect(out.find((e) => e.id === "pet")).toEqual({ id: "pet", size: "standard", hidden: true })
    expectWellFormed(out)
  })

  it("is a no-op for an unknown id", () => {
    expect(resizeEntry(balanced(), "nope" as GlanceModuleId, "expanded")).toEqual(balanced())
  })
})

describe("hideEntry", () => {
  it("moves the entry to the head of the hidden group", () => {
    const out = hideEntry(balanced(), "usage")
    expect(visibleIds(out)).toEqual(["fleet", "quota", "agenda", "activity", "quick"])
    expect(hiddenIds(out)).toEqual(["usage", "recents", "pet"])
    expect(out.find((e) => e.id === "usage")?.hidden).toBe(true)
    expectWellFormed(out)
  })

  it("keeps the size so showing it again undoes the hide", () => {
    const hidden = hideEntry(balanced(), "agenda")
    expect(hidden.find((e) => e.id === "agenda")?.size).toBe("compact")
  })

  it("is a no-op for an already hidden entry", () => {
    const entries = balanced()
    expect(hideEntry(entries, "pet")).toEqual(entries)
  })

  it("is a no-op for an unknown id", () => {
    expect(hideEntry(balanced(), "nope" as GlanceModuleId)).toEqual(balanced())
  })

  it("can hide everything, keeping each module once", () => {
    let entries = balanced()
    for (const id of ALL) entries = hideEntry(entries, id)
    expect(visibleIds(entries)).toEqual([])
    expectWellFormed(entries)
  })
})

describe("showEntry", () => {
  it("appends the entry at the end of the visible stack", () => {
    const out = showEntry(balanced(), "pet", ALL)
    expect(visibleIds(out)).toEqual([
      "fleet",
      "usage",
      "quota",
      "agenda",
      "activity",
      "quick",
      "pet",
    ])
    expect(hiddenIds(out)).toEqual(["recents"])
    expectWellFormed(out)
  })

  it("keeps the remaining hidden entries in order", () => {
    const out = showEntry(balanced(), "recents", ALL)
    expect(hiddenIds(out)).toEqual(["pet"])
  })

  it("refuses an id the platform does not offer", () => {
    const entries = balanced()
    const mobile = ALL.filter((id) => id !== "pet")
    expect(showEntry(entries, "pet", mobile)).toEqual(entries)
  })

  it("refuses an already visible entry", () => {
    const entries = balanced()
    expect(showEntry(entries, "fleet", ALL)).toEqual(entries)
  })

  it("refuses an unknown id", () => {
    const entries = balanced()
    expect(showEntry(entries, "nope" as GlanceModuleId, ALL)).toEqual(entries)
  })

  it("hide then show puts the entry last, visible again", () => {
    const out = showEntry(hideEntry(balanced(), "usage"), "usage", ALL)
    expect(visibleIds(out).at(-1)).toBe("usage")
    expectWellFormed(out)
  })
})

describe("withEditedEntries", () => {
  const settings: GlancePanelSettings = {
    ...DEFAULT_GLANCE_PANEL_SETTINGS,
    preset: "minimal",
    width: "wide",
    maxHeight: 500,
    scope: "workspace",
    showDelegate: false,
    autofocusDelegate: true,
  }

  it("makes the layout custom with the new entries", () => {
    const entries = hideEntry(balanced(), "usage")
    const out = withEditedEntries(settings, entries)
    expect(out.preset).toBe("custom")
    expect(out.entries).toEqual(entries)
  })

  it("normalizes the entries: missing modules come back hidden, sizes degrade", () => {
    const out = withEditedEntries(settings, [
      { id: "agenda", size: "expanded", hidden: false },
      { id: "fleet", size: "compact", hidden: false },
    ])
    expect(out.entries.slice(0, 2)).toEqual([
      { id: "agenda", size: "standard", hidden: false },
      { id: "fleet", size: "compact", hidden: false },
    ])
    expectWellFormed(out.entries)
    expect(out.entries.slice(2).every((e) => e.hidden)).toBe(true)
  })

  it("keeps every other setting and does not mutate the input", () => {
    const before = JSON.parse(JSON.stringify(settings))
    const out = withEditedEntries(settings, balanced())
    expect(out).toMatchObject({
      version: 1,
      width: "wide",
      maxHeight: 500,
      scope: "workspace",
      showDelegate: false,
      autofocusDelegate: true,
      options: settings.options,
    })
    expect(settings).toEqual(before)
  })
})

describe("withPreset", () => {
  const custom: GlancePanelSettings = {
    ...DEFAULT_GLANCE_PANEL_SETTINGS,
    preset: "custom",
    entries: hideEntry(balanced(), "fleet"),
    width: "narrow",
    maxHeight: 320,
    showDelegate: false,
    options: { usage: { scope: "all-tools", showSpend: true }, activity: { range: "1y" } },
  }

  it.each(["balanced", "usage-first", "agent-ops", "minimal"] as const)(
    "applies %s: its id and its entries",
    (preset) => {
      const out = withPreset(custom, preset)
      expect(out.preset).toBe(preset)
      expect(out.entries).toEqual(layoutFromPreset(preset))
      expectWellFormed(out.entries)
    }
  )

  it("keeps width, max height and options (and the rest)", () => {
    const out = withPreset(custom, "minimal")
    expect(out).toMatchObject({
      width: "narrow",
      maxHeight: 320,
      showDelegate: false,
      options: custom.options,
    })
  })

  it("does not mutate the input", () => {
    const before = JSON.parse(JSON.stringify(custom))
    withPreset(custom, "usage-first")
    expect(custom).toEqual(before)
  })
})

/* ── Mobile entries (ADR-0225 §9, §10) ───────────────────────────────── */

// balanced (mobile): fleet quick usage activity recents quota agenda | pet (hidden)
// home pins:         fleet quick usage activity recents
const mobile = () => mobileLayoutFromPreset("balanced")
const pins = (entries: readonly GlanceMobileEntry[]) =>
  Object.fromEntries(entries.map((e) => [e.id, e.home]))

describe("generic edits keep the home pin", () => {
  it("reorderVisible", () => {
    const before = mobile()
    const out = reorderVisible(before, ["recents", "fleet"])
    expect(visibleIds(out).slice(0, 2)).toEqual(["recents", "fleet"])
    expect(pins(out)).toEqual(pins(before))
    for (const e of out) expect(typeof e.home).toBe("boolean")
  })

  it("moveVisible", () => {
    const before = mobile()
    const out = moveVisible(before, "usage", -2)
    expect(visibleIds(out).slice(0, 3)).toEqual(["usage", "fleet", "quick"])
    expect(pins(out)).toEqual(pins(before))
  })

  it("resizeEntry", () => {
    const out = resizeEntry(mobile(), "fleet", "expanded")
    expect(out.find((e) => e.id === "fleet")).toEqual({
      id: "fleet",
      size: "expanded",
      hidden: false,
      home: true,
    })
  })

  it("hideEntry keeps the pin on the hidden entry", () => {
    const out = hideEntry(mobile(), "usage")
    expect(out.find((e) => e.id === "usage")).toMatchObject({ hidden: true, home: true })
    expectWellFormed(out)
  })

  it("showEntry keeps the pin of the shown entry", () => {
    const out = showEntry(mobile(), "pet", ALL)
    expect(out.find((e) => e.id === "pet")).toEqual({
      id: "pet",
      size: "compact",
      hidden: false,
      home: false,
    })
    expect(pins(out)).toEqual(pins(mobile()))
  })
})

describe("pinEntryHome", () => {
  it("pins a visible entry in place", () => {
    const out = pinEntryHome(mobile(), "quota", true, ALL)
    expect(out.find((e) => e.id === "quota")).toMatchObject({ hidden: false, home: true })
    expect(ids(out)).toEqual(ids(mobile()))
  })

  it("pinning a hidden entry shows it at the end of the visible stack", () => {
    const out = pinEntryHome(mobile(), "pet", true, ALL)
    expect(out.find((e) => e.id === "pet")).toMatchObject({ hidden: false, home: true })
    expect(visibleIds(out).at(-1)).toBe("pet")
    expectWellFormed(out)
  })

  it("unpinning keeps the entry's visibility", () => {
    const out = pinEntryHome(mobile(), "usage", false, ALL)
    expect(out.find((e) => e.id === "usage")).toMatchObject({ hidden: false, home: false })
    expect(ids(out)).toEqual(ids(mobile()))

    const hiddenPinned = hideEntry(mobile(), "fleet")
    const unpinned = pinEntryHome(hiddenPinned, "fleet", false, ALL)
    expect(unpinned.find((e) => e.id === "fleet")).toMatchObject({ hidden: true, home: false })
  })

  it("does not pin a module the platform lacks", () => {
    const before = mobile()
    const available = ALL.filter((id) => id !== "pet")
    const out = pinEntryHome(before, "pet", true, available)
    expect(out).toEqual(before)
  })

  it("still unpins a module the platform lacks", () => {
    const before = mobile()
    const available = ALL.filter((id) => id !== "fleet")
    const out = pinEntryHome(before, "fleet", false, available)
    expect(out.find((e) => e.id === "fleet")?.home).toBe(false)
  })

  it("is a no-op for an id not in the list", () => {
    const before = mobile().filter((e) => e.id !== "quota")
    expect(pinEntryHome(before, "quota", true, ALL)).toEqual(before)
  })

  it("re-sorts a list with a hidden entry ahead of visible ones", () => {
    const messy: GlanceMobileEntry[] = [
      { id: "pet", size: "compact", hidden: true, home: false },
      { id: "fleet", size: "compact", hidden: false, home: false },
    ]
    expect(ids(pinEntryHome(messy, "fleet", true, ALL))).toEqual(["fleet", "pet"])
  })

  it("does not mutate the input", () => {
    const before = mobile()
    const copy = JSON.parse(JSON.stringify(before))
    pinEntryHome(before, "pet", true, ALL)
    expect(before).toEqual(copy)
  })
})

describe("withEditedMobileEntries", () => {
  const settings: GlanceMobileSettings = {
    ...DEFAULT_GLANCE_MOBILE_SETTINGS,
    scope: "workspace",
    shortcuts: ["me"],
  }

  it("makes the layout custom with normalized entries, keeping the rest", () => {
    const edited: GlanceMobileEntry[] = [
      { id: "agenda", size: "expanded", hidden: false, home: true },
      { id: "agenda", size: "compact", hidden: true, home: false },
    ]
    const out = withEditedMobileEntries(settings, edited)
    expect(out.preset).toBe("custom")
    expect(out.entries).toEqual(normalizeMobileEntries(edited))
    expect(out.entries[0]).toEqual({ id: "agenda", size: "standard", hidden: false, home: true })
    expect(out).toMatchObject({ scope: "workspace", shortcuts: ["me"], options: settings.options })
  })
})

describe("withMobilePreset", () => {
  const settings: GlanceMobileSettings = {
    ...DEFAULT_GLANCE_MOBILE_SETTINGS,
    preset: "custom",
    entries: mobileLayoutFromPreset("minimal").map((e) => ({ ...e, home: false })),
    scope: "workspace",
    options: { usage: { scope: "all-tools", showSpend: true }, activity: { range: "1y" } },
    shortcuts: ["inbox", "me"],
  }

  it.each(["balanced", "usage-first", "agent-ops", "minimal"] as const)(
    "applies %s and keeps shortcuts, scope and options",
    (preset) => {
      const out = withMobilePreset(settings, preset)
      expect(out.preset).toBe(preset)
      expect(out.entries).toEqual(mobileLayoutFromPreset(preset))
      expect(out).toMatchObject({
        scope: "workspace",
        options: settings.options,
        shortcuts: ["inbox", "me"],
      })
    }
  )
})

describe("withShortcuts", () => {
  const settings: GlanceMobileSettings = { ...DEFAULT_GLANCE_MOBILE_SETTINGS, preset: "minimal" }

  it("normalizes the list and keeps the preset and entries", () => {
    const out = withShortcuts(settings, ["agentTeams", "bogus", "me", "me"])
    expect(out.shortcuts).toEqual(["squads", "me"])
    expect(out.preset).toBe("minimal")
    expect(out.entries).toBe(settings.entries)
  })

  it("keeps an emptied list", () => {
    expect(withShortcuts(settings, []).shortcuts).toEqual([])
  })
})

describe("plugin entries (ADR-0225 §6)", () => {
  const PLUGIN = "plugin:com.ci:status" as const
  const base = layoutFromPreset("minimal")

  it("adds a plugin module the layout never placed, shown at the end of the stack", () => {
    const out = addEntry(base, { id: PLUGIN, size: "compact", hidden: false }, [PLUGIN])
    const shown = out.filter((e) => !e.hidden).map((e) => e.id)
    expect(shown.at(-1)).toBe(PLUGIN)
    expect(out.find((e) => e.id === PLUGIN)).toEqual({ id: PLUGIN, size: "compact", hidden: false })
  })

  it("shows a placed but hidden plugin entry instead of adding a second one", () => {
    const placed = [...base, { id: PLUGIN, size: "expanded" as const, hidden: true }]
    const out = addEntry(placed, { id: PLUGIN, size: "compact", hidden: false }, [PLUGIN])
    expect(out.filter((e) => e.id === PLUGIN)).toEqual([
      { id: PLUGIN, size: "expanded", hidden: false },
    ])
  })

  it("adds nothing that is not available", () => {
    const out = addEntry(base, { id: PLUGIN, size: "compact", hidden: false }, [])
    expect(out.some((e) => e.id === PLUGIN)).toBe(false)
  })

  it("resizes a plugin entry within the sizes its module declares", () => {
    const placed = [...base, { id: PLUGIN, size: "compact" as const, hidden: false }]
    expect(
      resizeEntry(placed, PLUGIN, "expanded", ["compact", "standard"]).find((e) => e.id === PLUGIN)
        ?.size
    ).toBe("standard")
    // Without the catalogue the size is kept for the renderer to degrade.
    expect(resizeEntry(placed, PLUGIN, "expanded").find((e) => e.id === PLUGIN)?.size).toBe(
      "expanded"
    )
  })

  it("keeps plugin entries through an edit and drops them on a preset", () => {
    const placed = [...base, { id: PLUGIN, size: "compact" as const, hidden: false }]
    const settings = withEditedEntries(DEFAULT_GLANCE_PANEL_SETTINGS, placed)
    expect(settings.entries.some((e) => e.id === PLUGIN)).toBe(true)
    expect(withPreset(settings, "balanced").entries.some((e) => e.id === PLUGIN)).toBe(false)
  })
})
