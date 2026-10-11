import {
  DEFAULT_GLANCE_MODULE_OPTIONS,
  GLANCE_MAX_HEIGHT_DEFAULT,
  GLANCE_MAX_HEIGHT_MAX,
  GLANCE_MAX_HEIGHT_MIN,
  GLANCE_MAX_PLUGIN_ENTRIES,
  GLANCE_MODULE_IDS,
  GLANCE_PRESET_IDS,
  type GlanceLayoutEntry,
  type GlanceModuleId,
} from "@/types/glance/layout"

import {
  clampMaxHeight,
  DEFAULT_GLANCE_PANEL_SETTINGS,
  GLANCE_PRESET_LABEL_KEYS,
  GLANCE_PRESETS,
  layoutFromPreset,
  normalizeEntries,
  normalizeGlanceModuleOptions,
  normalizeGlancePanelSettings,
  visibleModuleIds,
  visiblePluginEntryIds,
} from "./presets"
import { GLANCE_MODULES, supportsSize } from "./registry"

describe("layoutFromPreset", () => {
  it.each(GLANCE_PRESET_IDS.map((id) => [id]))(
    "%s contains every module exactly once",
    (preset) => {
      const entries = layoutFromPreset(preset)
      expect(entries.map((e) => e.id).sort()).toEqual([...GLANCE_MODULE_IDS].sort())
    }
  )

  it.each(GLANCE_PRESET_IDS.map((id) => [id]))(
    "%s lists visible entries first, in preset order",
    (preset) => {
      const entries = layoutFromPreset(preset)
      const visible = GLANCE_PRESETS[preset]
      expect(entries.slice(0, visible.length)).toEqual(
        visible.map(([id, size]) => ({ id, size, hidden: false }))
      )
      const rest = entries.slice(visible.length)
      expect(rest.every((e) => e.hidden)).toBe(true)
      expect(entries.filter((e) => !e.hidden)).toHaveLength(visible.length)
    }
  )

  it.each(GLANCE_PRESET_IDS.map((id) => [id]))(
    "%s uses only sizes each module supports",
    (preset) => {
      for (const entry of layoutFromPreset(preset)) {
        expect(supportsSize(entry.id as GlanceModuleId, entry.size)).toBe(true)
      }
    }
  )

  it("hides unlisted modules at their smallest size", () => {
    const hidden = layoutFromPreset("minimal").filter((e) => e.hidden)
    expect(hidden.length).toBeGreaterThan(0)
    for (const entry of hidden)
      expect(entry.size).toBe(GLANCE_MODULES[entry.id as GlanceModuleId].sizes[0])
  })

  it("returns a fresh array on every call", () => {
    expect(layoutFromPreset("balanced")).not.toBe(layoutFromPreset("balanced"))
  })

  it("has a label key for every preset", () => {
    for (const id of GLANCE_PRESET_IDS)
      expect(GLANCE_PRESET_LABEL_KEYS[id].startsWith("presets.")).toBe(true)
  })
})

describe("normalizeEntries", () => {
  const allHidden = (entries: GlanceLayoutEntry[]) => entries.every((e) => e.hidden)

  it.each([[undefined], [null], ["x"], [42], [{}]])(
    "falls back to balanced for non-array %j",
    (raw) => {
      expect(normalizeEntries(raw)).toEqual(layoutFromPreset("balanced"))
    }
  )

  it("keeps a valid list as is", () => {
    const raw = layoutFromPreset("agent-ops")
    expect(normalizeEntries(raw)).toEqual(raw)
  })

  it("drops unknown ids and malformed items", () => {
    const out = normalizeEntries([
      { id: "ghost", size: "standard", hidden: false },
      null,
      "fleet",
      { size: "standard" },
      { id: 7 },
      { id: "usage", size: "standard", hidden: false },
    ])
    expect(out[0]).toEqual({ id: "usage", size: "standard", hidden: false })
    expect(out.map((e) => e.id)).not.toContain("ghost")
    expect(out).toHaveLength(GLANCE_MODULE_IDS.length)
  })

  it("does not accept prototype keys as module ids", () => {
    const out = normalizeEntries([{ id: "__proto__" }, { id: "toString" }])
    expect(out.map((e) => e.id).sort()).toEqual([...GLANCE_MODULE_IDS].sort())
    expect(allHidden(out)).toBe(true)
  })

  it("dedupes keeping the first occurrence", () => {
    const out = normalizeEntries([
      { id: "usage", size: "compact", hidden: false },
      { id: "fleet", size: "standard", hidden: false },
      { id: "usage", size: "expanded", hidden: true },
    ])
    expect(out.filter((e) => e.id === "usage")).toEqual([
      { id: "usage", size: "compact", hidden: false },
    ])
    expect(out.slice(0, 2).map((e) => e.id)).toEqual(["usage", "fleet"])
  })

  it("appends missing ids hidden at their smallest size, in catalogue order", () => {
    const out = normalizeEntries([{ id: "pet", size: "standard", hidden: false }])
    expect(out[0].id).toBe("pet")
    const appended = out.slice(1)
    expect(appended.map((e) => e.id)).toEqual(GLANCE_MODULE_IDS.filter((id) => id !== "pet"))
    expect(allHidden(appended)).toBe(true)
    for (const e of appended) expect(e.size).toBe(GLANCE_MODULES[e.id as GlanceModuleId].sizes[0])
  })

  it("returns every module hidden for an empty array", () => {
    const out = normalizeEntries([])
    expect(out.map((e) => e.id)).toEqual([...GLANCE_MODULE_IDS])
    expect(allHidden(out)).toBe(true)
  })

  it("degrades an unsupported size to the nearest supported one", () => {
    const [agenda] = normalizeEntries([{ id: "agenda", size: "expanded", hidden: false }])
    expect(agenda.size).toBe("standard")
  })

  it("falls back to the smallest size for a missing or unknown size", () => {
    const out = normalizeEntries([
      { id: "fleet", hidden: false },
      { id: "usage", size: "huge", hidden: false },
      { id: "quota", size: 3, hidden: false },
    ])
    expect(out.slice(0, 3).map((e) => e.size)).toEqual(["compact", "compact", "compact"])
  })

  it("treats hidden as strictly true", () => {
    const out = normalizeEntries([
      { id: "fleet", size: "standard", hidden: "true" },
      { id: "usage", size: "standard", hidden: 1 },
      { id: "quota", size: "standard" },
      { id: "agenda", size: "standard", hidden: true },
    ])
    expect(out.slice(0, 4).map((e) => e.hidden)).toEqual([false, false, false, true])
  })
})

describe("clampMaxHeight", () => {
  it("passes in-range values through, rounded", () => {
    expect(clampMaxHeight(500)).toBe(500)
    expect(clampMaxHeight(500.6)).toBe(501)
  })

  it("clamps to the bounds", () => {
    expect(clampMaxHeight(10)).toBe(GLANCE_MAX_HEIGHT_MIN)
    expect(clampMaxHeight(99_999)).toBe(GLANCE_MAX_HEIGHT_MAX)
    expect(clampMaxHeight(GLANCE_MAX_HEIGHT_MIN)).toBe(GLANCE_MAX_HEIGHT_MIN)
    expect(clampMaxHeight(GLANCE_MAX_HEIGHT_MAX)).toBe(GLANCE_MAX_HEIGHT_MAX)
  })

  it.each([[NaN], [Infinity], [-Infinity], ["600"], [null], [undefined], [{}]])(
    "defaults for non-finite or non-number %j",
    (value) => {
      expect(clampMaxHeight(value)).toBe(GLANCE_MAX_HEIGHT_DEFAULT)
    }
  )
})

describe("normalizeGlancePanelSettings", () => {
  it.each([[undefined], [null], ["x"], [1], [[]]])("returns defaults for non-object %j", (raw) => {
    expect(normalizeGlancePanelSettings(raw)).toEqual(DEFAULT_GLANCE_PANEL_SETTINGS)
  })

  it("returns defaults equal to the documented values", () => {
    expect(DEFAULT_GLANCE_PANEL_SETTINGS).toMatchObject({
      version: 1,
      preset: "balanced",
      width: "standard",
      maxHeight: GLANCE_MAX_HEIGHT_DEFAULT,
      scope: "all",
      showDelegate: true,
      autofocusDelegate: false,
      options: DEFAULT_GLANCE_MODULE_OPTIONS,
    })
    expect(DEFAULT_GLANCE_PANEL_SETTINGS.entries).toEqual(layoutFromPreset("balanced"))
  })

  it("fills an empty object with defaults", () => {
    expect(normalizeGlancePanelSettings({})).toEqual(DEFAULT_GLANCE_PANEL_SETTINGS)
  })

  it("accepts every built-in preset and custom", () => {
    for (const preset of [...GLANCE_PRESET_IDS, "custom"]) {
      expect(normalizeGlancePanelSettings({ preset }).preset).toBe(preset)
    }
  })

  it.each([["nope"], [3], [null], ["Custom"]])(
    "falls back to the default preset for %j",
    (preset) => {
      expect(normalizeGlancePanelSettings({ preset }).preset).toBe("balanced")
    }
  )

  it("normalizes width", () => {
    for (const width of ["narrow", "standard", "wide"]) {
      expect(normalizeGlancePanelSettings({ width }).width).toBe(width)
    }
    expect(normalizeGlancePanelSettings({ width: "huge" }).width).toBe("standard")
    expect(normalizeGlancePanelSettings({ width: 380 }).width).toBe("standard")
  })

  it("normalizes scope", () => {
    expect(normalizeGlancePanelSettings({ scope: "workspace" }).scope).toBe("workspace")
    expect(normalizeGlancePanelSettings({ scope: "all" }).scope).toBe("all")
    expect(normalizeGlancePanelSettings({ scope: "other" }).scope).toBe("all")
  })

  it("clamps maxHeight", () => {
    expect(normalizeGlancePanelSettings({ maxHeight: 5 }).maxHeight).toBe(GLANCE_MAX_HEIGHT_MIN)
    expect(normalizeGlancePanelSettings({ maxHeight: "x" }).maxHeight).toBe(
      GLANCE_MAX_HEIGHT_DEFAULT
    )
  })

  it("repairs stored entries, and uses balanced when none are stored", () => {
    const out = normalizeGlancePanelSettings({
      entries: [{ id: "pet", size: "standard", hidden: false }],
    })
    expect(out.entries[0].id).toBe("pet")
    expect(out.entries).toHaveLength(GLANCE_MODULE_IDS.length)
    expect(normalizeGlancePanelSettings({ preset: "custom" }).entries).toEqual(
      layoutFromPreset("balanced")
    )
    // Present but not an array also falls back to balanced via normalizeEntries.
    expect(normalizeGlancePanelSettings({ entries: "x" }).entries).toEqual(
      layoutFromPreset("balanced")
    )
  })

  it("keeps an explicitly empty entry list with every module hidden", () => {
    const out = normalizeGlancePanelSettings({ entries: [] })
    expect(out.entries.every((e) => e.hidden)).toBe(true)
  })

  describe("showDelegate", () => {
    it("is shown by default, including for layouts stored before the switch existed", () => {
      expect(DEFAULT_GLANCE_PANEL_SETTINGS.showDelegate).toBe(true)
      expect(normalizeGlancePanelSettings({}).showDelegate).toBe(true)
      expect(normalizeGlancePanelSettings({ preset: "minimal" }).showDelegate).toBe(true)
    })

    it("stays true unless explicitly false", () => {
      expect(normalizeGlancePanelSettings({ showDelegate: true }).showDelegate).toBe(true)
      expect(normalizeGlancePanelSettings({ showDelegate: false }).showDelegate).toBe(false)
      for (const showDelegate of ["false", 0, null, "no"]) {
        expect(normalizeGlancePanelSettings({ showDelegate }).showDelegate).toBe(true)
      }
    })
  })

  it("always stamps version 1", () => {
    expect(normalizeGlancePanelSettings({ version: 9 }).version).toBe(1)
  })

  describe("options", () => {
    it("takes usage.scope only for all-tools or cognia", () => {
      const scope = (value: unknown) =>
        normalizeGlancePanelSettings({ options: { usage: { scope: value } } }).options.usage.scope
      expect(scope("all-tools")).toBe("all-tools")
      expect(scope("cognia")).toBe("cognia")
      expect(scope("all")).toBe("cognia")
      expect(scope(true)).toBe("cognia")
      expect(scope(undefined)).toBe("cognia")
    })

    it("takes showSpend only when strictly true", () => {
      const spend = (value: unknown) =>
        normalizeGlancePanelSettings({ options: { usage: { showSpend: value } } }).options.usage
          .showSpend
      expect(spend(true)).toBe(true)
      expect(spend(false)).toBe(false)
      expect(spend("true")).toBe(false)
      expect(spend(1)).toBe(false)
    })

    it("validates activity.range", () => {
      const range = (value: unknown) =>
        normalizeGlancePanelSettings({ options: { activity: { range: value } } }).options.activity
          .range
      expect(range("1m")).toBe("1m")
      expect(range("3m")).toBe("3m")
      expect(range("1y")).toBe("1y")
      expect(range("2y")).toBe(DEFAULT_GLANCE_MODULE_OPTIONS.activity.range)
      expect(range(3)).toBe(DEFAULT_GLANCE_MODULE_OPTIONS.activity.range)
    })

    it.each([[null], ["x"], [[]], [{ usage: 1, activity: "x" }]])(
      "defaults for malformed options %j",
      (options) => {
        expect(normalizeGlancePanelSettings({ options }).options).toEqual(
          DEFAULT_GLANCE_MODULE_OPTIONS
        )
      }
    )
  })

  it("accepts autofocusDelegate only when strictly true", () => {
    expect(normalizeGlancePanelSettings({ autofocusDelegate: true }).autofocusDelegate).toBe(true)
    expect(normalizeGlancePanelSettings({ autofocusDelegate: false }).autofocusDelegate).toBe(false)
    expect(normalizeGlancePanelSettings({ autofocusDelegate: "yes" }).autofocusDelegate).toBe(false)
    expect(normalizeGlancePanelSettings({ autofocusDelegate: 1 }).autofocusDelegate).toBe(false)
  })

  it("is idempotent", () => {
    const once = normalizeGlancePanelSettings({
      preset: "custom",
      entries: [{ id: "recents", size: "expanded", hidden: false }],
      width: "wide",
      maxHeight: 700.4,
      scope: "workspace",
      autofocusDelegate: true,
      options: { usage: { scope: "all-tools", showSpend: true }, activity: { range: "1y" } },
    })
    expect(normalizeGlancePanelSettings(once)).toEqual(once)
  })
})

describe("visibleModuleIds", () => {
  it("returns visible ids in render order", () => {
    const entries: GlanceLayoutEntry[] = [
      { id: "usage", size: "standard", hidden: false },
      { id: "fleet", size: "standard", hidden: true },
      { id: "pet", size: "compact", hidden: false },
    ]
    expect(visibleModuleIds(entries)).toEqual(["usage", "pet"])
  })

  it("matches the preset's visible list and handles empty input", () => {
    expect(visibleModuleIds(layoutFromPreset("minimal"))).toEqual(
      GLANCE_PRESETS.minimal.map(([id]) => id)
    )
    expect(visibleModuleIds([])).toEqual([])
  })
})

describe("normalizeGlanceModuleOptions", () => {
  it.each([[undefined], [null], ["x"], [[]], [{}]])("defaults everything for %j", (raw) => {
    expect(normalizeGlanceModuleOptions(raw)).toEqual(DEFAULT_GLANCE_MODULE_OPTIONS)
  })

  it("keeps valid options", () => {
    const options = {
      usage: { scope: "all-tools", showSpend: true },
      activity: { range: "1y" },
    }
    expect(normalizeGlanceModuleOptions(options)).toEqual(options)
  })

  it.each(["1m", "3m", "1y"])("accepts the activity range %s", (range) => {
    expect(normalizeGlanceModuleOptions({ activity: { range } }).activity.range).toBe(range)
  })

  it("repairs each field on its own", () => {
    expect(
      normalizeGlanceModuleOptions({
        usage: { scope: "everyone", showSpend: "true" },
        activity: { range: "forever" },
      })
    ).toEqual(DEFAULT_GLANCE_MODULE_OPTIONS)
    expect(
      normalizeGlanceModuleOptions({ usage: { showSpend: true }, activity: { range: 3 } })
    ).toEqual({
      usage: { scope: "cognia", showSpend: true },
      activity: { range: DEFAULT_GLANCE_MODULE_OPTIONS.activity.range },
    })
  })

  it("ignores non-object sub-records", () => {
    expect(normalizeGlanceModuleOptions({ usage: ["all-tools"], activity: "1y" })).toEqual(
      DEFAULT_GLANCE_MODULE_OPTIONS
    )
  })

  it("returns fresh objects, never the shared defaults", () => {
    const out = normalizeGlanceModuleOptions(undefined)
    expect(out).not.toBe(DEFAULT_GLANCE_MODULE_OPTIONS)
    expect(out.usage).not.toBe(DEFAULT_GLANCE_MODULE_OPTIONS.usage)
    expect(out.activity).not.toBe(DEFAULT_GLANCE_MODULE_OPTIONS.activity)
  })

  it("is what the panel settings normalize their options with", () => {
    const raw = { usage: { scope: "all-tools", showSpend: 1 }, activity: { range: "1m" } }
    expect(normalizeGlancePanelSettings({ options: raw }).options).toEqual(
      normalizeGlanceModuleOptions(raw)
    )
  })
})

describe("plugin entries in a stored layout (ADR-0225 §6)", () => {
  it("keeps well-formed plugin entries in place, whether or not their plugin runs", () => {
    const entries = normalizeEntries([
      { id: "fleet", size: "compact", hidden: false },
      { id: "plugin:com.ci:status", size: "expanded", hidden: false },
      { id: "plugin:com.ci:status", size: "compact", hidden: true },
      { id: "plugin:bad id:x", size: "compact", hidden: false },
      { id: "plugin:com.todo:today", size: "huge", hidden: true },
    ])
    expect(entries.slice(0, 3)).toEqual([
      { id: "fleet", size: "compact", hidden: false },
      { id: "plugin:com.ci:status", size: "expanded", hidden: false },
      { id: "plugin:com.todo:today", size: "standard", hidden: true },
    ])
  })

  it("keeps at most the layout's limit of plugin entries", () => {
    const many = Array.from({ length: GLANCE_MAX_PLUGIN_ENTRIES + 5 }, (_, i) => ({
      id: `plugin:p:m${i}`,
      size: "standard",
      hidden: false,
    }))
    const entries = normalizeEntries(many)
    expect(entries.filter((e) => e.id.startsWith("plugin:"))).toHaveLength(
      GLANCE_MAX_PLUGIN_ENTRIES
    )
  })

  it("lists the visible plugin entries", () => {
    expect(
      visiblePluginEntryIds([
        { id: "fleet", size: "compact", hidden: false },
        { id: "plugin:a:b", size: "compact", hidden: false },
        { id: "plugin:a:c", size: "compact", hidden: true },
      ])
    ).toEqual(["plugin:a:b"])
  })
})
