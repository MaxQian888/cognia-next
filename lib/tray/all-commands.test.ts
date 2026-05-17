import { buildAllCommandsSubmenu } from "./all-commands"
import { registerSlashCommand, __resetSlashCommandsForTesting } from "@/lib/slash-commands/registry"
import { registerTrayItem, __resetTrayRegistryForTesting } from "./registry"

afterEach(() => {
  __resetSlashCommandsForTesting()
  __resetTrayRegistryForTesting()
})

describe("buildAllCommandsSubmenu", () => {
  it("groups slash commands by canonical category", () => {
    registerSlashCommand({
      id: "clear",
      name: "clear",
      category: "chat",
      handler: () => ({}),
    })
    registerSlashCommand({
      id: "status",
      name: "status",
      category: "diagnostics",
      handler: () => ({}),
    })
    const root = buildAllCommandsSubmenu()
    const labels = root.items.map((it) => (it.kind === "submenu" ? it.label : null))
    expect(labels).toContain("tray.categories.chat")
    expect(labels).toContain("tray.categories.diagnostics")
  })

  it("drops empty category buckets", () => {
    registerSlashCommand({
      id: "clear",
      name: "clear",
      category: "chat",
      handler: () => ({}),
    })
    const root = buildAllCommandsSubmenu()
    // Only one non-empty bucket → exactly one child submenu.
    expect(root.items).toHaveLength(1)
  })

  it("classifies plugin slash commands under plugins by default", () => {
    registerSlashCommand({
      id: "screenshot.capture",
      name: "screenshot",
      source: "plugin",
      pluginId: "shot",
      handler: () => ({}),
    })
    const root = buildAllCommandsSubmenu()
    const plugins = root.items.find(
      (it) => it.kind === "submenu" && it.label === "tray.categories.plugins"
    )
    expect(plugins).toBeDefined()
  })

  it("includes plugin tray-item registry entries", () => {
    registerTrayItem({
      id: "shot:capture",
      pluginId: "shot",
      label: "Capture Area",
      category: "plugins",
    })
    const root = buildAllCommandsSubmenu()
    const plugins = root.items.find(
      (it) => it.kind === "submenu" && it.label === "tray.categories.plugins"
    )
    expect(plugins).toBeDefined()
    if (plugins && plugins.kind === "submenu") {
      const labels = plugins.items.map((i) => (i.kind === "action" ? i.label : null))
      expect(labels).toContain("Capture Area")
    }
  })

  it("sorts items alphabetically within each bucket", () => {
    for (const name of ["zeta", "alpha", "mid"]) {
      registerSlashCommand({
        id: name,
        name,
        category: "chat",
        handler: () => ({}),
      })
    }
    const root = buildAllCommandsSubmenu()
    const chat = root.items.find(
      (it) => it.kind === "submenu" && it.label === "tray.categories.chat"
    )
    if (chat && chat.kind === "submenu") {
      const labels = chat.items.map((i) => (i.kind === "action" ? i.label : ""))
      expect(labels).toEqual(["/alpha", "/mid", "/zeta"])
    }
  })

  it("buckets unknown categories under 'other'", () => {
    registerSlashCommand({
      id: "weird",
      name: "weird",
      category: "made-up",
      handler: () => ({}),
    })
    const root = buildAllCommandsSubmenu()
    const other = root.items.find(
      (it) => it.kind === "submenu" && it.label === "tray.categories.other"
    )
    expect(other).toBeDefined()
  })
})
