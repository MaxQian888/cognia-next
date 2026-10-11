import { buildPluginsSlice } from "./build-plugins"
import type { GlancePluginModuleEntry } from "./plugin-data"
import type { GlancePluginDataRecord } from "./plugin-registry"

function entry(
  pluginId: string,
  id: string,
  def: Partial<GlancePluginModuleEntry["def"]> = {}
): GlancePluginModuleEntry {
  return {
    entryId: `plugin:${pluginId}:${id}`,
    pluginId,
    def: {
      id,
      title: id.toUpperCase(),
      sizes: ["compact", "standard"],
      platforms: ["desktop", "mobile"],
      ...def,
    },
  }
}

const CI = entry("ci", "status", { icon: "git-branch", sizes: ["compact", "expanded"] })
const DESK = entry("ci", "desk", { platforms: ["desktop"] })
const PHONE = entry("tasks", "today", { platforms: ["mobile"] })

const DATA: Record<string, GlancePluginDataRecord> = {
  "plugin:ci:status": { data: { summary: "green" }, updatedAt: 50 },
  "plugin:ci:desk": { data: { summary: "desk" }, updatedAt: 70 },
  "plugin:tasks:today": { data: { summary: "3 due" }, updatedAt: 90 },
}

function build(over: Partial<Parameters<typeof buildPluginsSlice>[0]> = {}) {
  return buildPluginsSlice({
    catalog: [CI, DESK, PHONE],
    dataOf: (id) => DATA[id] ?? null,
    visible: [],
    platform: "desktop",
    resolveTitle: (e) => `T:${e.def.title}`,
    now: 1000,
    ...over,
  })
}

describe("buildPluginsSlice", () => {
  it("offers the modules of this platform, titles resolved", () => {
    expect(build().catalog).toEqual([
      {
        id: "plugin:ci:status",
        pluginId: "ci",
        title: "T:STATUS",
        icon: "git-branch",
        sizes: ["compact", "expanded"],
        platforms: ["desktop", "mobile"],
      },
      {
        id: "plugin:ci:desk",
        pluginId: "ci",
        title: "T:DESK",
        icon: null,
        sizes: ["compact", "standard"],
        platforms: ["desktop"],
      },
    ])
    expect(build({ platform: "mobile" }).catalog.map((c) => c.id)).toEqual([
      "plugin:ci:status",
      "plugin:tasks:today",
    ])
  })

  it("carries data for visible, offered entries only", () => {
    const slice = build({ visible: ["plugin:ci:status", "plugin:tasks:today", "plugin:gone:x"] })
    expect(slice.modules).toEqual({
      "plugin:ci:status": { updatedAt: 50, data: { summary: "green" } },
    })
    expect(slice.updatedAt).toBe(50)
  })

  it("leaves out a visible module that has published nothing", () => {
    const slice = build({ visible: ["plugin:ci:status"], dataOf: () => null })
    expect(slice.modules).toEqual({})
    expect(slice.updatedAt).toBe(1000)
  })

  it("falls back to the literal title and caps a long one", () => {
    expect(build({ resolveTitle: () => "   " }).catalog[0].title).toBe("STATUS")
    expect(build({ resolveTitle: () => "x".repeat(300) }).catalog[0].title).toHaveLength(48)
  })
})
