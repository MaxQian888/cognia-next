/**
 * @jest-environment node
 */
import {
  buildPluginDocument,
  buildConsentSummary,
  buildPermissionsBlock,
  buildPublisherLines,
  buildPreviewDocument,
  buildCapabilitiesBlock,
  buildMetadataFooter,
  readmeExcerpt,
  parseInstallArg,
  toPluginInfo,
  pluginList,
  pluginSetEnabled,
  pluginShow,
  pluginTools,
  pluginReload,
  pluginInstall,
  pluginPreview,
  pluginUpdate,
  pluginUninstall,
  pluginSourcesList,
  pluginSourcesAdd,
  pluginSourcesRemove,
  pluginTrustList,
  pluginTrustAdd,
  pluginTrustRemove,
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

  it("phase 2: --confirmed runs the install, records provenance, notices the id", async () => {
    const { dispatch, actions } = recorder()
    const installed: string[] = []
    const origins: Array<{ id: string; entry: unknown }> = []
    await pluginInstall("owner/repo --confirmed", {
      ...base,
      dispatch,
      install: async (ref) => {
        installed.push(ref)
        return { id: "demo", version: "1.2.0", fingerprint: "fp" }
      },
      recordOrigin: (id, entry) => origins.push({ id, entry }),
    })
    expect(installed).toEqual(["owner/repo"])
    expect(origins).toEqual([
      { id: "demo", entry: { repoRef: "owner/repo", version: "1.2.0", fingerprint: "fp" } },
    ])
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
  it("opens the interactive marketplace overlay with the catalog entries", async () => {
    const { dispatch, actions } = recorder()
    await pluginMarketplace({
      ...base,
      dispatch,
      getSources: () => ["owner/repo"],
      browse: async () => ({
        entries: [
          {
            name: "Demo",
            installRef: "owner/repo/plugins/demo",
            description: "a demo",
            author: "amy",
            rating: 4.2,
            downloads: 99,
            signed: true,
          },
        ],
        errors: [],
      }),
    })
    expect(actions[actions.length - 1]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "marketplace",
        entries: [
          {
            name: "Demo",
            installRef: "owner/repo/plugins/demo",
            rating: 4.2,
            downloads: 99,
            signed: true,
          },
        ],
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

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest =>
  ({
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    type: "frontend",
    ...over,
  }) as unknown as PluginManifest

describe("buildPermissionsBlock", () => {
  it("lists declared, optional, and network grants", () => {
    const block = buildPermissionsBlock(
      manifest({
        permissions: ["network:fetch"],
        optionalPermissions: ["filesystem:read"],
        networkAccess: { allowedDomains: ["api.x.com"], reasoning: "weather" },
      } as Partial<PluginManifest>)
    ).join("\n")
    expect(block).toContain("network:fetch")
    expect(block).toContain("filesystem:read")
    expect(block).toContain("api.x.com")
    expect(block).toContain("weather")
  })

  it("shows _none_ when there are no permissions", () => {
    expect(buildPermissionsBlock(manifest()).join("\n")).toContain("_none_")
  })

  it("flags dangerous permissions with a marker, description, and summary", () => {
    const block = buildPermissionsBlock(
      manifest({ permissions: ["shell:execute"] } as Partial<PluginManifest>)
    ).join("\n")
    expect(block).toContain("dangerous permission")
    expect(block).toContain("⚠️ `shell:execute`")
  })
})

describe("buildPublisherLines", () => {
  it("is empty when owner is unknown", () => {
    expect(buildPublisherLines(undefined, false)).toEqual([])
  })
  it("marks a trusted publisher", () => {
    expect(buildPublisherLines("vercel", true).join("\n")).toContain("trusted ✓")
  })
  it("warns + hints for an untrusted publisher", () => {
    const out = buildPublisherLines("acme", false).join("\n")
    expect(out).toContain("untrusted")
    expect(out).toContain("/plugin trust add acme")
  })
})

describe("buildConsentSummary publisher line", () => {
  it("surfaces an untrusted publisher when owner is provided", () => {
    const body = buildConsentSummary(manifest(), {
      ref: "acme/demo",
      alreadyInstalled: false,
      owner: "acme",
      trusted: false,
    })
    expect(body).toContain("untrusted")
    expect(body).toContain("/plugin trust add acme")
  })
})

describe("readmeExcerpt", () => {
  it("returns '' for missing readme", () => {
    expect(readmeExcerpt(undefined)).toBe("")
  })
  it("truncates long readmes and notes truncation", () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")
    const out = readmeExcerpt(long, 5)
    expect(out).toContain("line 0")
    expect(out).not.toContain("line 59")
    expect(out).toContain("README truncated")
  })
  it("keeps a short readme intact", () => {
    expect(readmeExcerpt("# Hi\nshort", 40)).toBe("# Hi\nshort")
  })
})

describe("buildCapabilitiesBlock", () => {
  it("summarizes capabilities, tools, signature presence and dependencies", () => {
    const block = buildCapabilitiesBlock(
      manifest({
        capabilities: ["tools", "themes"],
        tools: [{ name: "x" }],
        author: { name: "amy", publicKey: "AAAA" },
        dependencies: { "other-plugin": "^1.0.0" },
      } as unknown as Partial<PluginManifest>)
    ).join("\n")
    expect(block).toContain("2 capabilities")
    expect(block).toContain("1 tool")
    expect(block).toContain("publisher key present")
    expect(block).toContain("other-plugin")
  })

  it("is empty when the manifest declares nothing notable", () => {
    expect(buildCapabilitiesBlock(manifest())).toEqual([])
  })
})

describe("buildMetadataFooter", () => {
  it("renders author, license, homepage and keywords", () => {
    const footer = buildMetadataFooter(
      manifest({
        author: { name: "amy" },
        license: "MIT",
        homepage: "https://x.dev",
        keywords: ["ai", "tools"],
      } as unknown as Partial<PluginManifest>)
    ).join("\n")
    expect(footer).toContain("by amy")
    expect(footer).toContain("MIT")
    expect(footer).toContain("https://x.dev")
    expect(footer).toContain("`ai`")
  })
})

describe("buildPreviewDocument", () => {
  it("includes description, full README, permissions, capabilities, and trust", () => {
    const body = buildPreviewDocument(
      manifest({
        description: "a demo plugin",
        permissions: ["network:fetch"],
        capabilities: ["tools"],
      } as unknown as Partial<PluginManifest>),
      { ref: "acme/demo", owner: "acme", trusted: false, readme: "## Usage\nrun it" }
    )
    expect(body).toContain("a demo plugin")
    expect(body).toContain("## Usage")
    expect(body).toContain("run it")
    expect(body).toContain("network:fetch")
    expect(body).toContain("Capabilities")
    expect(body).toContain("untrusted")
    expect(body).toContain("Enter")
  })
})

describe("pluginPreview", () => {
  it("opens a confirm overlay that installs with --confirmed on Enter", async () => {
    const { dispatch, actions } = recorder()
    await pluginPreview("acme/demo", {
      ...base,
      dispatch,
      preview: async () => ({ manifest: manifest(), readme: "hello" }),
      isTrusted: () => false,
    })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "confirm", onConfirmCommand: "plugin install acme/demo --confirmed" },
    })
  })

  it("notices usage when no ref is given", async () => {
    const { dispatch, actions } = recorder()
    await pluginPreview("  ", { ...base, dispatch })
    expect((actions[0] as { message: string }).message).toContain("Usage")
  })

  it("surfaces a preview failure", async () => {
    const { dispatch, actions } = recorder()
    await pluginPreview("acme/demo", {
      ...base,
      dispatch,
      preview: async () => {
        throw new Error("404")
      },
    })
    expect((actions[0] as { message: string }).message).toMatch(/Could not read plugin.*404/)
  })
})

describe("pluginUpdate (single)", () => {
  const origin = { repoRef: "acme/demo", version: "1.0.0", fingerprint: "old", installedAt: 1 }

  it("re-fetches, reloads, records, and notices the version bump", async () => {
    const { dispatch, actions } = recorder()
    const reloaded: string[] = []
    const recorded: Array<{ id: string; entry: unknown }> = []
    await pluginUpdate("demo", {
      ...base,
      dispatch,
      getOrigin: () => origin,
      refetch: async () => ({ id: "demo", version: "2.0.0", fingerprint: "new" }),
      reload: async (id) => void reloaded.push(id),
      recordOrigin: (id, entry) => recorded.push({ id, entry }),
    })
    expect(reloaded).toEqual(["demo"])
    expect(recorded[0].entry).toEqual({
      repoRef: "acme/demo",
      version: "2.0.0",
      fingerprint: "new",
    })
    expect((actions[0] as { message: string }).message).toContain("v1.0.0 → v2.0.0")
  })

  it("reports up-to-date when the fingerprint is unchanged", async () => {
    const { dispatch, actions } = recorder()
    await pluginUpdate("demo", {
      ...base,
      dispatch,
      getOrigin: () => origin,
      refetch: async () => ({ id: "demo", version: "1.0.0", fingerprint: "old" }),
      reload: async () => {},
      recordOrigin: () => {},
    })
    expect((actions[0] as { message: string }).message).toContain("already up to date")
  })

  it("notices when the plugin has no recorded origin", async () => {
    const { dispatch, actions } = recorder()
    await pluginUpdate("demo", { ...base, dispatch, getOrigin: () => undefined })
    expect((actions[0] as { message: string }).message).toContain("nothing to update")
  })

  it("surfaces a refetch failure", async () => {
    const { dispatch, actions } = recorder()
    await pluginUpdate("demo", {
      ...base,
      dispatch,
      getOrigin: () => origin,
      refetch: async () => {
        throw new Error("network down")
      },
      reload: async () => {},
    })
    expect((actions[0] as { message: string }).message).toMatch(/Update failed.*network down/)
  })
})

describe("pluginUpdate (check-all)", () => {
  it("lists plugins with a newer upstream version", async () => {
    const { dispatch, actions } = recorder()
    await pluginUpdate("", {
      ...base,
      dispatch,
      getOrigins: () => ({
        demo: { repoRef: "acme/demo", version: "1.0.0", fingerprint: "", installedAt: 1 },
      }),
      preview: async () => ({ manifest: manifest({ version: "2.0.0" }) }),
    })
    expect((actions[0] as { message: string }).message).toMatch(
      /Updates available.*demo.*1\.0\.0.*2\.0\.0/
    )
  })

  it("reports all up to date when versions match", async () => {
    const { dispatch, actions } = recorder()
    await pluginUpdate("", {
      ...base,
      dispatch,
      getOrigins: () => ({
        demo: { repoRef: "acme/demo", version: "1.0.0", fingerprint: "", installedAt: 1 },
      }),
      preview: async () => ({ manifest: manifest({ version: "1.0.0" }) }),
    })
    expect((actions[0] as { message: string }).message).toContain("up to date")
  })

  it("ignores a source that fails to resolve", async () => {
    const { dispatch, actions } = recorder()
    await pluginUpdate("", {
      ...base,
      dispatch,
      getOrigins: () => ({
        demo: { repoRef: "acme/demo", version: "1.0.0", fingerprint: "", installedAt: 1 },
      }),
      preview: async () => {
        throw new Error("404")
      },
    })
    expect((actions[0] as { message: string }).message).toContain("up to date")
  })

  it("notices when nothing is GitHub-installed", async () => {
    const { dispatch, actions } = recorder()
    await pluginUpdate("", { ...base, dispatch, getOrigins: () => ({}) })
    expect((actions[0] as { message: string }).message).toContain("No marketplace")
  })
})

describe("pluginUninstall drops provenance", () => {
  it("calls removeOrigin after a successful uninstall", async () => {
    const { dispatch } = recorder()
    const removed: string[] = []
    await pluginUninstall("demo", {
      ...base,
      dispatch,
      uninstall: async () => {},
      removeOrigin: (id) => removed.push(id),
    })
    expect(removed).toEqual(["demo"])
  })
})

describe("plugin trust", () => {
  it("lists trusted publishers", () => {
    const { dispatch, actions } = recorder()
    pluginTrustList({ ...base, dispatch, getTrusted: () => ["vercel"] })
    expect((actions[0] as { message: string }).message).toContain("vercel")
  })

  it("notices when none are trusted", () => {
    const { dispatch, actions } = recorder()
    pluginTrustList({ ...base, dispatch, getTrusted: () => [] })
    expect((actions[0] as { message: string }).message).toContain("No trusted publishers")
  })

  it("adds a trusted owner", () => {
    const { dispatch, actions } = recorder()
    const added: string[] = []
    pluginTrustAdd("Acme", { ...base, dispatch, addTrusted: (o) => added.push(o) })
    expect(added).toEqual(["Acme"])
    expect((actions[0] as { message: string }).message).toContain("acme")
  })

  it("notices usage when add has no owner", () => {
    const { dispatch, actions } = recorder()
    pluginTrustAdd("", { ...base, dispatch })
    expect((actions[0] as { message: string }).message).toContain("Usage")
  })

  it("removes a trusted owner", () => {
    const { dispatch, actions } = recorder()
    const removed: string[] = []
    pluginTrustRemove("acme", { ...base, dispatch, removeTrusted: (o) => removed.push(o) })
    expect(removed).toEqual(["acme"])
    expect((actions[0] as { message: string }).message).toContain("Revoked")
  })

  it("notices usage when remove has no owner", () => {
    const { dispatch, actions } = recorder()
    pluginTrustRemove("", { ...base, dispatch })
    expect((actions[0] as { message: string }).message).toContain("Usage")
  })
})
