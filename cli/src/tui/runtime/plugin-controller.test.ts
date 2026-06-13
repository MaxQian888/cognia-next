/**
 * @jest-environment node
 */
import {
  buildPluginDocument,
  buildConsentSummary,
  parseInstallArg,
  toPluginInfo,
  pluginList,
  pluginSetEnabled,
  pluginShow,
  pluginTools,
  pluginReload,
  pluginInstall,
  pluginUninstall,
  pluginSourcesList,
  pluginSourcesAdd,
  pluginSourcesRemove,
  pluginMarketplace,
} from "./plugin-controller"
import type { PluginInfo, PluginToolInfo } from "../../plugin/discover-plugins"
import type { PluginManifest } from "@/types/plugin"
import type { TuiAction } from "../state/types"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const plugin = (id: string, supported = true, tools: PluginToolInfo[] = []): PluginInfo => ({
  id,
  name: id,
  version: "1.0.0",
  description: `the ${id}`,
  type: supported ? "frontend" : "python",
  dir: `/p/${id}`,
  supported,
  tools,
  mcpServerPresets: [],
})

const base = { roots: ["/w"], home: "/home" }

describe("pluginList", () => {
  it("opens a select overlay with type/supported/enabled hints", async () => {
    const { dispatch, actions } = recorder()
    await pluginList({
      ...base,
      dispatch,
      list: async () => [plugin("a", true), plugin("b", false)],
      getDisabled: () => new Set(["a"]),
    })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        onSelectCommand: "plugin show",
        items: [
          { id: "a", hint: "frontend · off" },
          { id: "b", hint: "python · unsupported · on" },
        ],
      },
    })
  })

  it("notices when none are installed", async () => {
    const { dispatch, actions } = recorder()
    await pluginList({ ...base, dispatch, list: async () => [] })
    expect((actions[0] as { message: string }).message).toContain("No plugins")
  })
})

describe("buildPluginDocument", () => {
  it("renders header, runnability, and a tool summary with the schema hint", () => {
    const doc = buildPluginDocument(
      plugin("web-tools", true, [
        { name: "web_fetch", description: "Fetch a URL", parametersSchema: { type: "object" } },
      ]),
      true
    )
    expect(doc).toContain("# web-tools")
    expect(doc).toContain("`web-tools`")
    expect(doc).toContain("runnable in CLI")
    expect(doc).toContain("**Tools (1):** web_fetch")
    expect(doc).toContain("/plugin tools web-tools")
  })

  it("notes when a plugin declares no tools", () => {
    const doc = buildPluginDocument(plugin("x"), false)
    expect(doc).toContain("declares no agent tools")
  })
})

describe("pluginShow", () => {
  it("opens a markdown document with manifest details", async () => {
    const { dispatch, actions } = recorder()
    await pluginShow("b", { ...base, dispatch, list: async () => [plugin("b", false)] })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", format: "markdown", title: "Plugin · b" },
    })
    expect((actions[0] as { overlay: { body: string } }).overlay.body).toContain(
      "not runnable in CLI"
    )
  })
  it("notices a missing plugin", async () => {
    const { dispatch, actions } = recorder()
    await pluginShow("ghost", { ...base, dispatch, list: async () => [] })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("pluginTools", () => {
  it("opens a tool document with each declared tool's schema", async () => {
    const { dispatch, actions } = recorder()
    await pluginTools("web", {
      ...base,
      dispatch,
      list: async () => [
        plugin("web", true, [
          { name: "web_fetch", description: "Fetch a URL", parametersSchema: { type: "object" } },
        ]),
      ],
    })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", format: "markdown", title: "Tools · web (1)" },
    })
    expect((actions[0] as { overlay: { body: string } }).overlay.body).toContain("### web_fetch")
  })
  it("notices when a plugin declares no tools", async () => {
    const { dispatch, actions } = recorder()
    await pluginTools("x", { ...base, dispatch, list: async () => [plugin("x", true, [])] })
    expect((actions[0] as { message: string }).message).toContain("no agent tools")
  })
  it("notices a missing plugin", async () => {
    const { dispatch, actions } = recorder()
    await pluginTools("ghost", { ...base, dispatch, list: async () => [] })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("pluginSetEnabled", () => {
  it("persists not-disabled and flips the live manager on", async () => {
    const { dispatch, actions } = recorder()
    let captured: { id: string; disabled: boolean } | null = null
    const live: { id: string; enabled: boolean }[] = []
    await pluginSetEnabled("a", true, {
      ...base,
      dispatch,
      setEnabled: (id, disabled) => {
        captured = { id, disabled }
      },
      setLive: async (id, enabled) => void live.push({ id, enabled }),
    })
    expect(captured).toEqual({ id: "a", disabled: false })
    expect(live).toEqual([{ id: "a", enabled: true }])
    expect((actions[0] as { message: string }).message).toContain("enabled")
  })

  it("surfaces a live-manager failure as a notice", async () => {
    const { dispatch, actions } = recorder()
    await pluginSetEnabled("a", false, {
      ...base,
      dispatch,
      setEnabled: () => {},
      setLive: async () => {
        throw new Error("deactivate boom")
      },
    })
    expect((actions[0] as { message: string }).message).toMatch(/disable failed.*boom/)
  })
})

describe("toPluginInfo", () => {
  it("maps a store row's manifest into PluginInfo (tools + supported)", () => {
    const info = toPluginInfo({
      manifest: {
        id: "x",
        name: "X",
        version: "2.0.0",
        description: "desc",
        type: "frontend",
        tools: [
          { name: "t", description: "d", category: "c", parametersSchema: { type: "object" } },
        ],
      } as unknown as PluginManifest,
      path: "/d/x",
    })
    expect(info).toMatchObject({ id: "x", dir: "/d/x", supported: true })
    expect(info.tools[0]).toMatchObject({ name: "t", category: "c" })
  })

  it("marks a non-frontend plugin unsupported and tolerates missing tools", () => {
    const info = toPluginInfo({
      manifest: {
        id: "p",
        name: "P",
        version: "1.0.0",
        type: "python",
      } as unknown as PluginManifest,
      path: "builtin://p",
    })
    expect(info.supported).toBe(false)
    expect(info.tools).toEqual([])
  })
})

describe("parseInstallArg", () => {
  it("extracts the ref and the --confirmed flag", () => {
    expect(parseInstallArg("owner/repo")).toEqual({ ref: "owner/repo", confirmed: false })
    expect(parseInstallArg("owner/repo --confirmed")).toEqual({
      ref: "owner/repo",
      confirmed: true,
    })
    expect(parseInstallArg("owner/repo@v1/sub --confirmed")).toEqual({
      ref: "owner/repo@v1/sub",
      confirmed: true,
    })
  })
})

describe("buildConsentSummary", () => {
  it("surfaces permissions, network egress, and a conflict note", () => {
    const body = buildConsentSummary(
      {
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        type: "frontend",
        permissions: ["network:fetch", "clipboard:read"],
        optionalPermissions: ["filesystem:read"],
        networkAccess: { allowedDomains: ["api.example.com"], reasoning: "weather data" },
      } as unknown as PluginManifest,
      { ref: "owner/repo", alreadyInstalled: true }
    )
    expect(body).toContain("network:fetch")
    expect(body).toContain("clipboard:read")
    expect(body).toContain("filesystem:read")
    expect(body).toContain("api.example.com")
    expect(body).toContain("weather data")
    expect(body).toContain("already installed")
    expect(body).toContain("Enter")
  })

  it("warns when the plugin type is unsupported and shows 'none' for no perms", () => {
    const body = buildConsentSummary(
      { id: "p", name: "P", version: "1.0.0", type: "python" } as unknown as PluginManifest,
      { ref: "o/r", alreadyInstalled: false }
    )
    expect(body).toContain("unsupported in CLI")
    expect(body).toContain("_none_")
  })
})

describe("pluginReload", () => {
  it("reloads via the injected seam and notices success", async () => {
    const { dispatch, actions } = recorder()
    const reloaded: string[] = []
    await pluginReload("demo", { ...base, dispatch, reload: async (id) => void reloaded.push(id) })
    expect(reloaded).toEqual(["demo"])
    expect((actions[0] as { message: string }).message).toContain("reloaded")
  })

  it("notices usage when id is empty", async () => {
    const { dispatch, actions } = recorder()
    await pluginReload("", { ...base, dispatch })
    expect((actions[0] as { message: string }).message).toContain("Usage")
  })

  it("surfaces a reload failure", async () => {
    const { dispatch, actions } = recorder()
    await pluginReload("demo", {
      ...base,
      dispatch,
      reload: async () => {
        throw new Error("teardown boom")
      },
    })
    expect((actions[0] as { message: string }).message).toMatch(/Reload failed.*boom/)
  })
})

describe("pluginInstall", () => {
  it("phase 1: opens a consent confirm with a --confirmed onConfirmCommand", async () => {
    const { dispatch, actions } = recorder()
    await pluginInstall("owner/repo", {
      ...base,
      dispatch,
      preview: async () => ({
        manifest: {
          id: "demo",
          name: "Demo",
          version: "1.0.0",
          type: "frontend",
        } as PluginManifest,
      }),
      isInstalled: () => false,
    })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "confirm", onConfirmCommand: "plugin install owner/repo --confirmed" },
    })
  })

  it("phase 2: --confirmed runs the install and notices the id", async () => {
    const { dispatch, actions } = recorder()
    const installed: string[] = []
    await pluginInstall("owner/repo --confirmed", {
      ...base,
      dispatch,
      install: async (ref) => {
        installed.push(ref)
        return { id: "demo" }
      },
    })
    expect(installed).toEqual(["owner/repo"])
    expect((actions[0] as { message: string }).message).toContain('Installed "demo"')
  })

  it("notices usage when no ref is given", async () => {
    const { dispatch, actions } = recorder()
    await pluginInstall("", { ...base, dispatch })
    expect((actions[0] as { message: string }).message).toContain("Usage")
  })

  it("surfaces a preview failure in phase 1", async () => {
    const { dispatch, actions } = recorder()
    await pluginInstall("owner/repo", {
      ...base,
      dispatch,
      preview: async () => {
        throw new Error("no plugin.json")
      },
    })
    expect((actions[0] as { message: string }).message).toMatch(
      /Could not read plugin.*no plugin\.json/
    )
  })

  it("surfaces an install failure in phase 2", async () => {
    const { dispatch, actions } = recorder()
    await pluginInstall("owner/repo --confirmed", {
      ...base,
      dispatch,
      install: async () => {
        throw new Error("network down")
      },
    })
    expect((actions[0] as { message: string }).message).toMatch(/Install failed.*network down/)
  })
})

describe("pluginUninstall", () => {
  it("uninstalls via the injected seam and notices", async () => {
    const { dispatch, actions } = recorder()
    const removed: string[] = []
    await pluginUninstall("demo", {
      ...base,
      dispatch,
      uninstall: async (id) => void removed.push(id),
    })
    expect(removed).toEqual(["demo"])
    expect((actions[0] as { message: string }).message).toContain('Uninstalled "demo"')
  })

  it("notices usage when id is empty", async () => {
    const { dispatch, actions } = recorder()
    await pluginUninstall("", { ...base, dispatch })
    expect((actions[0] as { message: string }).message).toContain("Usage")
  })

  it("surfaces an uninstall failure", async () => {
    const { dispatch, actions } = recorder()
    await pluginUninstall("demo", {
      ...base,
      dispatch,
      uninstall: async () => {
        throw new Error("locked")
      },
    })
    expect((actions[0] as { message: string }).message).toMatch(/Uninstall failed.*locked/)
  })
})

describe("plugin sources", () => {
  it("lists configured sources", () => {
    const { dispatch, actions } = recorder()
    pluginSourcesList({ ...base, dispatch, getSources: () => ["owner/repo"] })
    expect((actions[0] as { message: string }).message).toContain("owner/repo")
  })

  it("notices when no sources are configured", () => {
    const { dispatch, actions } = recorder()
    pluginSourcesList({ ...base, dispatch, getSources: () => [] })
    expect((actions[0] as { message: string }).message).toContain("No marketplace sources")
  })

  it("adds a source", () => {
    const { dispatch, actions } = recorder()
    const added: string[] = []
    pluginSourcesAdd("owner/repo", { ...base, dispatch, addSource: (r) => added.push(r) })
    expect(added).toEqual(["owner/repo"])
    expect((actions[0] as { message: string }).message).toContain("Added")
  })

  it("notices usage when add has no ref", () => {
    const { dispatch, actions } = recorder()
    pluginSourcesAdd("", { ...base, dispatch })
    expect((actions[0] as { message: string }).message).toContain("Usage")
  })

  it("removes a source", () => {
    const { dispatch, actions } = recorder()
    const removed: string[] = []
    pluginSourcesRemove("owner/repo", { ...base, dispatch, removeSource: (r) => removed.push(r) })
    expect(removed).toEqual(["owner/repo"])
    expect((actions[0] as { message: string }).message).toContain("Removed")
  })

  it("notices usage when remove has no ref", () => {
    const { dispatch, actions } = recorder()
    pluginSourcesRemove("", { ...base, dispatch })
    expect((actions[0] as { message: string }).message).toContain("Usage")
  })
})

describe("pluginMarketplace", () => {
  it("opens a select overlay of catalog entries (Enter installs)", async () => {
    const { dispatch, actions } = recorder()
    await pluginMarketplace({
      ...base,
      dispatch,
      getSources: () => ["owner/repo"],
      browse: async () => ({
        entries: [{ name: "Demo", installRef: "owner/repo/plugins/demo", description: "a demo" }],
        errors: [],
      }),
    })
    expect(actions[actions.length - 1]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        onSelectCommand: "plugin install",
        items: [{ id: "owner/repo/plugins/demo", label: "Demo", hint: "a demo" }],
      },
    })
  })

  it("notices when no sources are configured", async () => {
    const { dispatch, actions } = recorder()
    await pluginMarketplace({ ...base, dispatch, getSources: () => [] })
    expect((actions[0] as { message: string }).message).toContain("No marketplace sources")
  })

  it("reports per-source errors and empty results", async () => {
    const { dispatch, actions } = recorder()
    await pluginMarketplace({
      ...base,
      dispatch,
      getSources: () => ["bad/repo"],
      browse: async () => ({ entries: [], errors: [{ repoRef: "bad/repo", message: "404" }] }),
    })
    const msgs = actions.map((a) => (a as { message?: string }).message ?? "")
    expect(msgs.some((m) => m.includes("Some sources failed"))).toBe(true)
    expect(msgs.some((m) => m.includes("No plugins found"))).toBe(true)
  })

  it("surfaces a browse failure", async () => {
    const { dispatch, actions } = recorder()
    await pluginMarketplace({
      ...base,
      dispatch,
      getSources: () => ["owner/repo"],
      browse: async () => {
        throw new Error("rate limited")
      },
    })
    expect((actions[0] as { message: string }).message).toMatch(
      /Marketplace fetch failed.*rate limited/
    )
  })
})
