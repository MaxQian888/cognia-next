import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import { GLANCE_MODULES } from "@/lib/glance/registry"
import {
  GLANCE_MODULE_IDS,
  type GlanceLayoutEntry,
  type GlanceMobileSettings,
  type GlanceModuleId,
} from "@/types/glance/layout"

import { DEFAULT_GLANCE_MOBILE_SETTINGS } from "../mobile-layout"

import { glanceConfigForDemand, glanceDemandOf } from "./demand"
import type { GlanceRemoteDemand } from "./types"

const shown = (id: GlanceModuleId, hidden = false): GlanceLayoutEntry => ({
  id,
  size: "standard",
  hidden,
})

const SETTINGS: GlanceMobileSettings = {
  ...DEFAULT_GLANCE_MOBILE_SETTINGS,
  options: { usage: { scope: "all-tools", showSpend: true }, activity: { range: "1y" } },
}

describe("glanceDemandOf", () => {
  it("keeps only host-sourced modules, in order", () => {
    const demand = glanceDemandOf(
      SETTINGS,
      [shown("recents"), shown("usage"), shown("quick"), shown("fleet"), shown("pet")],
      null
    )
    expect(demand.modules).toEqual(["usage", "fleet", "pet"])
  })

  it("dedupes repeated entries and ignores hidden ones", () => {
    const demand = glanceDemandOf(
      SETTINGS,
      [shown("quota"), shown("agenda", true), shown("quota"), shown("activity")],
      null
    )
    expect(demand.modules).toEqual(["quota", "activity"])
  })

  it("has no modules when nothing host-sourced is needed", () => {
    expect(glanceDemandOf(SETTINGS, [shown("recents"), shown("quick")], null).modules).toEqual([])
    expect(glanceDemandOf(SETTINGS, [], "p1").modules).toEqual([])
  })

  it("copies the usage and activity options", () => {
    const demand = glanceDemandOf(SETTINGS, [shown("usage")], null)
    expect(demand.usage).toEqual({ scope: "all-tools", showSpend: true })
    expect(demand.activity).toEqual({ range: "1y" })
    // Copies, not references into the settings.
    expect(demand.usage).not.toBe(SETTINGS.options.usage)
    expect(demand.activity).not.toBe(SETTINGS.options.activity)
  })

  it("scopes to the workspace only when the layout asks and a workspace is given", () => {
    const scoped: GlanceMobileSettings = { ...SETTINGS, scope: "workspace" }
    expect(glanceDemandOf(scoped, [shown("usage")], "p1")).toMatchObject({
      scope: "workspace",
      workspaceId: "p1",
    })
    expect(glanceDemandOf(scoped, [shown("usage")], null)).toMatchObject({
      scope: "all",
      workspaceId: null,
    })
    expect(glanceDemandOf(SETTINGS, [shown("usage")], "p1")).toMatchObject({
      scope: "all",
      workspaceId: null,
    })
  })
})

describe("glanceConfigForDemand", () => {
  const demand: GlanceRemoteDemand = {
    modules: ["usage", "pet"],
    scope: "workspace",
    workspaceId: "p1",
    usage: { scope: "all-tools", showSpend: true },
    activity: { range: "1m" },
  }

  it("shows exactly the demanded modules, one entry per module at its smallest size", () => {
    const config = glanceConfigForDemand(demand)
    expect(config.entries.map((e) => e.id)).toEqual([...GLANCE_MODULE_IDS])
    for (const e of config.entries) {
      expect(e.hidden).toBe(!["usage", "pet"].includes(e.id))
      expect(e.size).toBe(GLANCE_MODULES[e.id].sizes[0])
    }
  })

  it("copies the scope and options, and keeps the panel's defaults otherwise", () => {
    const config = glanceConfigForDemand(demand)
    expect(config).toMatchObject({
      version: 1,
      preset: "custom",
      scope: "workspace",
      options: { usage: { scope: "all-tools", showSpend: true }, activity: { range: "1m" } },
      width: DEFAULT_GLANCE_PANEL_SETTINGS.width,
      maxHeight: DEFAULT_GLANCE_PANEL_SETTINGS.maxHeight,
      showDelegate: DEFAULT_GLANCE_PANEL_SETTINGS.showDelegate,
      autofocusDelegate: DEFAULT_GLANCE_PANEL_SETTINGS.autofocusDelegate,
    })
    expect(config.options.usage).not.toBe(demand.usage)
    expect(config.options.activity).not.toBe(demand.activity)
  })

  it("hides everything for an empty demand", () => {
    const config = glanceConfigForDemand({ ...demand, modules: [], scope: "all" })
    expect(config.entries.every((e) => e.hidden)).toBe(true)
    expect(config.scope).toBe("all")
  })

  it("round-trips a phone's needed modules", () => {
    const needed = [shown("fleet"), shown("recents"), shown("quota")]
    const config = glanceConfigForDemand(glanceDemandOf(SETTINGS, needed, null))
    expect(config.entries.filter((e) => !e.hidden).map((e) => e.id)).toEqual(["fleet", "quota"])
  })
})
