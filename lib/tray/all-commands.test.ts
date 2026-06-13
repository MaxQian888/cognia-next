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

  it("picks up tray-surface quick actions and excludes _qa: (tray-excluded) ones", async () => {
    const { registerQuickAction, __resetQuickActionsForTesting } =
      await import("@/lib/plugin/registries/quick-action-registry")
    const { __resetCommandRegistryForTesting } = await import("@/lib/plugin/commands/registry")
    try {
      registerQuickAction("plug-a", { id: "sync", title: "Sync now", run: () => {} })
      registerQuickAction("plug-a", {
        id: "palette-only",
        title: "Palette only",
        run: () => {},
        surfaces: ["palette"],
      })

      const root = buildAllCommandsSubmenu()
      const plugins = root.items.find(
        (it) => it.kind === "submenu" && it.label === "tray.categories.plugins"
      )
      expect(plugins).toBeDefined()
      if (plugins && plugins.kind === "submenu") {
        const labels = plugins.items.map((i) => (i.kind === "action" ? i.label : null))
        expect(labels).toContain("Sync now")
        expect(labels).not.toContain("Palette only")
      }
    } finally {
      __resetQuickActionsForTesting()
      __resetCommandRegistryForTesting()
    }
  })

  it("evaluates a command's when-clause against the context-key store", async () => {
    const { registerCommand, __resetCommandRegistryForTesting } =
      await import("@/lib/plugin/commands/registry")
    const { setContextKey, __resetContextKeysForTesting } =
      await import("@/lib/plugin/context-keys/context-key-store")
    try {
      registerCommand({
        id: "demo.always",
        title: "Always Visible",
        pluginId: null,
        handler: () => {},
      })
      registerCommand({
        id: "demo.gated",
        title: "Gated Command",
        pluginId: null,
        when: "chat.active",
        handler: () => {},
      })

      const labelsOf = () => {
        const root = buildAllCommandsSubmenu()
        return root.items.flatMap((it) =>
          it.kind === "submenu" ? it.items.map((i) => (i.kind === "action" ? i.label : null)) : []
        )
      }

      // Clause unmet → gated command hidden, ungated still present.
      __resetContextKeysForTesting()
      expect(labelsOf()).toContain("Always Visible")
      expect(labelsOf()).not.toContain("Gated Command")

      // Clause met → gated command appears.
      setContextKey("chat.active", true)
      expect(labelsOf()).toContain("Gated Command")
    } finally {
      __resetCommandRegistryForTesting()
      const { __resetContextKeysForTesting } =
        await import("@/lib/plugin/context-keys/context-key-store")
      __resetContextKeysForTesting()
    }
  })
})
