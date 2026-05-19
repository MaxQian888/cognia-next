/**
 * @jest-environment jsdom
 */
import { addPluginCatalogEntry, __resetPluginCatalogForTesting } from "@/lib/workflow/nodes/catalog"
import type { PluginTool, PluginToolContext } from "@/types/plugin"
import { buildNodeKindTools } from "./node-kind-tools"

const EMPTY_CTX: PluginToolContext = { config: {} }

function findTool(tools: PluginTool[], name: string): PluginTool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  return t
}

beforeEach(() => {
  __resetPluginCatalogForTesting()
})

describe("wf_list_node_kinds", () => {
  it("lists built-in kinds with category and label", async () => {
    const tool = findTool(buildNodeKindTools(), "wf_list_node_kinds")
    const result = (await tool.execute({}, EMPTY_CTX)) as {
      ok: true
      total: number
      kinds: Array<{ kind: string; category: string; label: string }>
    }
    expect(result.ok).toBe(true)
    expect(result.total).toBeGreaterThan(0)
    const cron = result.kinds.find((k) => k.kind === "trigger.cron")
    expect(cron).toMatchObject({ category: "trigger", label: expect.any(String) })
  })

  it("filters by category", async () => {
    const tool = findTool(buildNodeKindTools(), "wf_list_node_kinds")
    const result = (await tool.execute({ category: "trigger" }, EMPTY_CTX)) as {
      ok: true
      kinds: Array<{ category: string }>
    }
    expect(result.kinds.length).toBeGreaterThan(0)
    expect(result.kinds.every((k) => k.category === "trigger")).toBe(true)
  })

  it("includes plugin-contributed entries", async () => {
    addPluginCatalogEntry({
      kind: "my-plugin.custom" as never,
      category: "plugin",
      label: "Custom",
      description: "plugin-contributed",
      iconName: "Box",
      keywords: [],
      pluginId: "my-plugin",
    })
    const tool = findTool(buildNodeKindTools(), "wf_list_node_kinds")
    const result = (await tool.execute({ category: "plugin" }, EMPTY_CTX)) as {
      ok: true
      kinds: Array<{ kind: string; pluginId?: string }>
    }
    expect(
      result.kinds.some((k) => k.kind === "my-plugin.custom" && k.pluginId === "my-plugin")
    ).toBe(true)
  })

  it("excludes desktopOnly when includeDesktopOnly=false", async () => {
    const tool = findTool(buildNodeKindTools(), "wf_list_node_kinds")
    const result = (await tool.execute({ includeDesktopOnly: false }, EMPTY_CTX)) as {
      ok: true
      kinds: Array<{ kind: string; desktopOnly?: boolean }>
    }
    expect(result.kinds.some((k) => k.kind === "trigger.webhook")).toBe(false)
  })
})

describe("wf_describe_node_kind", () => {
  it("returns full entry for a known built-in kind", async () => {
    const tool = findTool(buildNodeKindTools(), "wf_describe_node_kind")
    const result = (await tool.execute({ kind: "trigger.cron" }, EMPTY_CTX)) as {
      ok: true
      entry: { kind: string; category: string; iconName: string; keywords: string[] }
    }
    expect(result.ok).toBe(true)
    expect(result.entry.kind).toBe("trigger.cron")
    expect(result.entry.category).toBe("trigger")
    expect(result.entry.keywords).toContain("cron")
  })

  it("returns full entry for plugin-contributed kinds", async () => {
    addPluginCatalogEntry({
      kind: "my-plugin.custom" as never,
      category: "plugin",
      label: "Custom",
      description: "plugin-contributed",
      iconName: "Box",
      keywords: ["plugin"],
      pluginId: "my-plugin",
      paramsSchema: { type: "object", properties: { foo: { type: "string" } } },
    })
    const tool = findTool(buildNodeKindTools(), "wf_describe_node_kind")
    const result = (await tool.execute({ kind: "my-plugin.custom" }, EMPTY_CTX)) as {
      ok: true
      entry: { paramsSchema: Record<string, unknown>; pluginId: string }
    }
    expect(result.entry.pluginId).toBe("my-plugin")
    expect(result.entry.paramsSchema).toBeDefined()
  })

  it("returns ok:false with code 'unknown-kind' for missing kinds", async () => {
    const tool = findTool(buildNodeKindTools(), "wf_describe_node_kind")
    const result = (await tool.execute({ kind: "does.not.exist" }, EMPTY_CTX)) as {
      ok: false
      error: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe("unknown-kind")
  })

  it("returns ok:false with code 'missing-kind' when no kind argument is given", async () => {
    const tool = findTool(buildNodeKindTools(), "wf_describe_node_kind")
    const result = (await tool.execute({}, EMPTY_CTX)) as {
      ok: false
      error: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe("missing-kind")
  })
})
