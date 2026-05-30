import {
  buildBuiltinCatalogEntries,
  buildMcpCatalogEntries,
  buildNativeCatalogEntries,
  buildPluginCatalogEntries,
  namespacedPluginTool,
  searchToolCatalog,
  type ToolCatalogEntry,
} from "./tool-catalog"
import { BUILTIN_SERVER_NAME } from "@/lib/settings/builtin-tools"
import type { McpServer } from "@/lib/claude/types"

describe("buildBuiltinCatalogEntries", () => {
  const entries = buildBuiltinCatalogEntries()

  it("emits one entry per builtin tool, all tagged source=builtin", () => {
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((e) => e.source === "builtin")).toBe(true)
  })

  it("namespaces ids under the builtin server and carries an i18n descriptionKey", () => {
    for (const e of entries) {
      expect(e.id.startsWith(`mcp__${BUILTIN_SERVER_NAME}__`)).toBe(true)
      expect(e.descriptionKey).toBeTruthy()
      expect(e.description).toBe("") // builtins resolve text via i18n key
      expect(e.ownerName).toBe(BUILTIN_SERVER_NAME)
      expect(e.enabled).toBe(true)
    }
  })

  it("propagates the alwaysLoad flag from the builtin metadata", () => {
    // At least one builtin tool is read-only safe → alwaysLoad true.
    expect(entries.some((e) => e.alwaysLoad === true)).toBe(true)
  })
})

describe("buildMcpCatalogEntries", () => {
  const servers: McpServer[] = [
    {
      id: "srv_1",
      name: "Playwright",
      transport: "stdio",
      config: {},
      enabled: true,
      appsEnabled: {},
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: "srv_2",
      name: "Remote",
      transport: "http",
      config: {},
      enabled: false,
      appsEnabled: {},
      createdAt: 0,
      updatedAt: 0,
      pluginId: "p1",
    },
  ]

  it("maps each server to a single mcp entry preserving id/name/enabled", () => {
    const out = buildMcpCatalogEntries(servers)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      id: "srv_1",
      name: "Playwright",
      source: "mcp",
      ownerId: "srv_1",
      enabled: true,
    })
    expect(out[0].description).toContain("stdio")
    expect(out[1].enabled).toBe(false)
    expect(out[1].description).toContain("plugin-provided")
  })
})

describe("buildPluginCatalogEntries", () => {
  // Minimal Plugin-shaped fixtures; cast through unknown to the param type so
  // the test doesn't have to construct every required Plugin field.
  const plugins = {
    a: {
      status: "enabled",
      manifest: { id: "plugin-a" },
      tools: [{ name: "do_thing", definition: { description: "Does a thing" } }],
    },
    b: {
      status: "disabled",
      manifest: { id: "plugin-b" },
      tools: [{ name: "other", definition: { description: "" } }],
    },
    c: {
      status: "enabled",
      manifest: { id: "plugin-c" },
      tools: undefined,
    },
  } as unknown as Parameters<typeof buildPluginCatalogEntries>[0]

  const out = buildPluginCatalogEntries(plugins)

  it("emits one entry per tool of every plugin that has tools (any status)", () => {
    // plugin-c has no tools → skipped; a + b each contribute one.
    expect(out).toHaveLength(2)
  })

  it("namespaces under the plugin-tools server and reflects enabled status", () => {
    const a = out.find((e) => e.name === "do_thing")!
    expect(a.id).toBe(namespacedPluginTool("do_thing"))
    expect(a.source).toBe("plugin")
    expect(a.ownerId).toBe("plugin-a")
    expect(a.enabled).toBe(true)
    expect(a.description).toBe("Does a thing")

    const b = out.find((e) => e.name === "other")!
    expect(b.enabled).toBe(false)
  })
})

describe("buildNativeCatalogEntries", () => {
  const registryEntries = [
    {
      id: "computer",
      entry: { id: "computer", name: "computer", type: "computer_20251124" },
      pluginId: "cu",
    },
    {
      id: "bash",
      entry: {
        id: "bash",
        name: "bash",
        type: "bash_20250124",
        permissionPolicy: "preauth",
      },
      pluginId: "cu",
    },
  ] as unknown as Parameters<typeof buildNativeCatalogEntries>[0]

  const out = buildNativeCatalogEntries(registryEntries)

  it("maps registry entries to native-anthropic catalog entries", () => {
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      id: "computer",
      name: "computer",
      source: "native-anthropic",
      ownerId: "cu",
      enabled: true,
    })
    expect(out[0].description).toContain("computer-use")
  })

  it("treats non-preauth policies as requiring approval, preauth as not", () => {
    expect(out[0].requiresApproval).toBe(true) // default always-ask
    expect(out[1].requiresApproval).toBe(false) // preauth
  })
})

describe("searchToolCatalog", () => {
  const entries: ToolCatalogEntry[] = [
    {
      id: "1",
      name: "git_status",
      source: "builtin",
      description: "",
      enabled: true,
      riskLevel: "low",
    },
    {
      id: "2",
      name: "run_shell",
      source: "builtin",
      description: "",
      enabled: true,
      riskLevel: "high",
    },
    {
      id: "3",
      name: "Playwright",
      source: "mcp",
      description: "MCP server (stdio)",
      ownerName: "Playwright",
      enabled: false,
    },
    {
      id: "4",
      name: "do_thing",
      source: "plugin",
      description: "Does a thing",
      ownerName: "plugin-a",
      enabled: true,
    },
  ]

  it("returns everything when query empty and no filters", () => {
    expect(searchToolCatalog(entries, "")).toHaveLength(4)
  })

  it("matches query against name, description, and owner name (case-insensitive)", () => {
    expect(searchToolCatalog(entries, "GIT").map((e) => e.id)).toEqual(["1"])
    expect(searchToolCatalog(entries, "does a thing").map((e) => e.id)).toEqual(["4"])
    expect(searchToolCatalog(entries, "playwright").map((e) => e.id)).toEqual(["3"])
  })

  it("filters by source", () => {
    const out = searchToolCatalog(entries, "", { sources: ["builtin"] })
    expect(out.map((e) => e.id)).toEqual(["1", "2"])
  })

  it("filters by risk level (entries without a risk level are excluded)", () => {
    const out = searchToolCatalog(entries, "", { riskLevels: ["high"] })
    expect(out.map((e) => e.id)).toEqual(["2"])
  })

  it("filters by enabled/disabled status", () => {
    expect(searchToolCatalog(entries, "", { status: "disabled" }).map((e) => e.id)).toEqual(["3"])
    expect(searchToolCatalog(entries, "", { status: "enabled" }).map((e) => e.id)).toEqual([
      "1",
      "2",
      "4",
    ])
  })

  it("composes filters with AND + text query", () => {
    const out = searchToolCatalog(entries, "run", { sources: ["builtin"], status: "enabled" })
    expect(out.map((e) => e.id)).toEqual(["2"])
  })
})
